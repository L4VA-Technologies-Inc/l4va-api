import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TransactionsService } from '../../processing-tx/offchain-tx/transactions.service';
import { ContributionAsset } from '../contribution/dto/contribute.req';

import { AcquireReq } from './dto/acquire.req';

import { Proposal } from '@/database/proposal.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { SystemSettingsService } from '@/modules/globals/system-settings';
import { ProposalStatus, ProposalType } from '@/types/proposal.types';
import { TransactionType } from '@/types/transaction.types';
import { VaultStatus } from '@/types/vault.types';

@Injectable()
export class AcquireService {
  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Proposal)
    private readonly proposalRepository: Repository<Proposal>,
    private readonly transactionsService: TransactionsService,
    private readonly systemSettingsService: SystemSettingsService
  ) {}

  async acquire(
    vaultId: string,
    acquireReq: AcquireReq,
    userId: string
  ): Promise<{
    success: boolean;
    message: string;
    vaultId: string;
    txId: string;
    assets: ContributionAsset[];
  }> {
    // Check acquire kill switch
    if (!this.systemSettingsService.acquireEnabled) {
      throw new BadRequestException(
        'Acquiring vault tokens is temporarily unavailable. Please try again later or contact support if this persists.'
      );
    }

    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      relations: ['acquirer_whitelist', 'owner'],
    });

    const user = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!vault) {
      throw new NotFoundException('Vault not found');
    }

    if (vault.vault_status !== VaultStatus.acquire && vault.vault_status !== VaultStatus.acquire_expansion) {
      throw new BadRequestException('Vault is not in acquire phase');
    }

    // Validate assets
    if (!acquireReq.assets || !Array.isArray(acquireReq.assets) || acquireReq.assets.length === 0) {
      throw new BadRequestException('At least one asset is required');
    }

    // Validate acquire amount limit for ADA
    const adaAsset = acquireReq.assets.find(asset => asset.assetName === 'lovelace' && asset.policyId === 'lovelace');
    if (adaAsset) {
      const acquireAmountAda = adaAsset.quantity; // Already in ADA
      // Use vault-specific limit if set, otherwise use protocol default
      const maxAcquireAmountAda = vault.max_acquire_amount_ada ?? this.systemSettingsService.maxAcquireAmountAda;

      if (acquireAmountAda > maxAcquireAmountAda) {
        throw new BadRequestException(
          `Acquire amount exceeds maximum limit of ${maxAcquireAmountAda.toLocaleString()} ADA per transaction`
        );
      }
    }

    // Validate acquire expansion ADA limit if in acquire_expansion phase
    let expansionProposalId: string | undefined;
    if (vault.vault_status === VaultStatus.acquire_expansion && adaAsset) {
      const acquireExpansionProposal: Pick<Proposal, 'id' | 'metadata' | 'executionDate'> =
        await this.proposalRepository.findOne({
          where: {
            vaultId,
            proposalType: ProposalType.ACQUIRE_EXPANSION,
            status: ProposalStatus.EXECUTED,
          },
          order: { executionDate: 'DESC' },
          select: ['id', 'metadata', 'executionDate'],
        });

      if (acquireExpansionProposal) {
        expansionProposalId = acquireExpansionProposal.id;

        if (acquireExpansionProposal.metadata?.acquireExpansion) {
          const expansionConfig = acquireExpansionProposal.metadata.acquireExpansion;

          // Check if there's a max ADA limit configured
          if (!expansionConfig.noMax && expansionConfig.maxAda) {
            const currentAdaRaised = expansionConfig.currentAdaRaised || 0;
            const requestedLovelace = adaAsset.quantity * 1_000_000; // Convert ADA to lovelace
            const remainingLovelace = expansionConfig.maxAda - currentAdaRaised;

            if (requestedLovelace > remainingLovelace) {
              const remainingAda = remainingLovelace / 1_000_000;
              const requestedAda = adaAsset.quantity;
              throw new BadRequestException(
                `Acquire expansion has reached or will exceed its maximum ADA limit. ` +
                  `Remaining: ${remainingAda.toLocaleString()} ADA, Requested: ${requestedAda.toLocaleString()} ADA`
              );
            }
          }
        }
      }
    }

    // Allow vault owner to bypass whitelist check
    if (vault.owner.id !== userId) {
      // Check whitelist only for non-owners
      if (vault.acquirer_whitelist?.length > 0) {
        const isWhitelisted = vault.acquirer_whitelist.some(entry => entry.wallet_address === user.address);
        if (!isWhitelisted) {
          throw new BadRequestException('User is not in investor whitelist');
        }
      }
    }

    // Validate assets against vault settings if needed
    if (vault.value_method === 'fixed') {
      // Add any specific validation for fixed valuation type here
    }

    // Create a transaction record for the acquire
    const transaction = await this.transactionsService.createTransaction({
      vault_id: vaultId,
      type: TransactionType.acquire,
      amount: acquireReq.assets.reduce((sum, asset) => sum + (asset.quantity || 0), 0),
      assets: [],
      userId,
      fee: this.systemSettingsService.protocolAcquiresFee,
      is_expansion: vault.vault_status === VaultStatus.acquire_expansion,
      expansion_proposal_id: expansionProposalId,
      metadata: {
        assets: acquireReq.assets,
      },
    });

    return {
      success: true,
      message: 'Acquire request accepted, transaction created',
      vaultId,
      txId: transaction.id,
      assets: acquireReq.assets,
    };
  }
}
