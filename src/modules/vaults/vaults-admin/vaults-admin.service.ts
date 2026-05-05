import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Asset } from '@/database/asset.entity';
import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { ClaimsService } from '@/modules/vaults/claims/claims.service';
import { PaginatedResponseDto } from '@/modules/vaults/dto/paginated-response.dto';
import { VaultManagingService } from '@/modules/vaults/processing-tx/onchain/vault-managing.service';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';
import { SmartContractVaultStatus, VaultFailureReason, VaultStatus } from '@/types/vault.types';

@Injectable()
export class VaultsAdminService {
  private readonly logger = new Logger(VaultsAdminService.name);

  constructor(
    @InjectRepository(Vault)
    private readonly vaultsRepository: Repository<Vault>,
    @InjectRepository(Asset)
    private readonly assetsRepository: Repository<Asset>,
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    private readonly vaultContractService: VaultManagingService,
    private readonly claimsService: ClaimsService
  ) {}

  async getVaultToCancelByAdmin(
    search?: string,
    page: number = 1,
    limit: number = 10
  ): Promise<PaginatedResponseDto<Vault>> {
    const safePage = page > 0 ? page : 1;
    const safeLimit = limit > 0 ? limit : 10;

    const queryBuilder = this.vaultsRepository
      .createQueryBuilder('vault')
      .leftJoinAndSelect('vault.owner', 'owner')
      .where('vault.deleted = false');

    if (search?.trim()) {
      queryBuilder.andWhere('(vault.id::text ILIKE :search OR vault.name ILIKE :search)', {
        search: `%${search.trim()}%`,
      });
    }

    const candidates = await queryBuilder.getMany();

    const checks = await Promise.all(candidates.map(vault => this.canCancelVaultByAdmin(vault)));
    const filtered = candidates.filter((_, idx) => checks[idx]);
    const total = filtered.length;
    const offset = (safePage - 1) * safeLimit;
    const items = filtered.slice(offset, offset + safeLimit);

    return {
      items,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    };
  }

  async cancelVaultByAdmin(vaultId: string): Promise<{ success: boolean }> {
    const vault = await this.getVaultToCancelByIdByAdmin(vaultId);

    const [contribCount, acquireCount] = await Promise.all([
      this.transactionRepository.count({
        where: { vault_id: vault.id, type: TransactionType.contribute, status: TransactionStatus.confirmed },
      }),
      this.transactionRepository.count({
        where: { vault_id: vault.id, type: TransactionType.acquire, status: TransactionStatus.confirmed },
      }),
    ]);

    const hasRefundableFlows = contribCount > 0 || acquireCount > 0;

    if (hasRefundableFlows) {
      const response = await this.vaultContractService.updateVaultMetadataTx({
        vault,
        vaultStatus: SmartContractVaultStatus.CANCELLED,
      });

      await this.claimsService.createCancellationClaims(vault, 'manual_admin_cancel');

      vault.vault_status = VaultStatus.failed;
      vault.vault_sc_status = SmartContractVaultStatus.CANCELLED;
      vault.last_update_tx_hash = response.txHash;
      vault.failure_reason = VaultFailureReason.MANUAL_CANCELLATION;
      vault.failure_details = { message: 'Cancelled by admin' };
      vault.deactivated_at = new Date();
      await this.vaultsRepository.save(vault);

      return { success: true };
    }

    await this.transactionRepository
      .createQueryBuilder()
      .update(Transaction)
      .set({ status: TransactionStatus.failed })
      .where('vault_id = :vaultId', { vaultId: vault.id })
      .andWhere('type = :type', { type: TransactionType.createVault })
      .andWhere('status IN (:...statuses)', { statuses: [TransactionStatus.created, TransactionStatus.pending] })
      .execute();

    vault.deleted = true;
    vault.deactivated_at = new Date();
    await this.vaultsRepository.save(vault);

    return { success: true };
  }

  private async canCancelVaultByAdmin(vault: Vault): Promise<boolean> {
    const cancellableStatuses: VaultStatus[] = [VaultStatus.contribution, VaultStatus.acquire];
    if (!cancellableStatuses.includes(vault.vault_status)) {
      return false;
    }

    const oneDayMs = 86_400_000;
    const phaseStart =
      vault.vault_status === VaultStatus.acquire ? vault.acquire_phase_start : vault.contribution_phase_start;
    if (!phaseStart) {
      return false;
    }

    const ageMs = Date.now() - new Date(phaseStart).getTime();
    if (ageMs > oneDayMs) {
      return false;
    }

    const ownerId = vault.owner?.id;
    if (!ownerId) {
      return false;
    }

    const hasForeignAssets = await this.assetsRepository
      .createQueryBuilder('asset')
      .where('asset.vault_id = :vaultId', { vaultId: vault.id })
      .andWhere('asset.deleted = false')
      .andWhere('(asset.added_by IS NULL OR asset.added_by != :ownerId)', { ownerId })
      .getExists();

    return !hasForeignAssets;
  }

  private async getVaultToCancelByIdByAdmin(vaultId: string): Promise<Vault> {
    const vault = await this.vaultsRepository.findOne({
      where: { id: vaultId, deleted: false },
      relations: ['owner'],
    });

    if (!vault) {
      throw new NotFoundException('Vault not found');
    }

    const canCancel = await this.canCancelVaultByAdmin(vault);
    if (!canCancel) {
      throw new BadRequestException('Vault cannot be cancelled by admin');
    }

    return vault;
  }
}
