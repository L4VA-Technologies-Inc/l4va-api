import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { type Address, type Hex } from 'viem';

import { EvmAdminSigner, TxRevertedError } from './evm-admin-signer.service';
import { EvmContractReader } from './evm-contract-reader.service';
import { VAULT_ABI } from './vault.abi';

import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { EvmReconciliationStatus, TransactionStatus, TransactionType } from '@/types/transaction.types';
import { ChainType } from '@/types/vault.types';

export interface WithdrawFeesResult {
  txHash: Hex;
  asset: Address;
  amount: bigint;
}

@Injectable()
export class EvmFeeWithdrawService {
  private readonly logger = new Logger(EvmFeeWithdrawService.name);

  constructor(
    @InjectRepository(Vault) private readonly vaultsRepository: Repository<Vault>,
    @InjectRepository(Transaction) private readonly transactionsRepository: Repository<Transaction>,
    private readonly contractReader: EvmContractReader,
    private readonly adminSigner: EvmAdminSigner
  ) {}

  /**
   * Sweep accrued native fees to the protocol feeRecipient.
   * Reads `accruedFeeNative()` first; no-ops if zero. `withdrawFees` takes
   * `address asset` — pass address(0) for native.
   */
  async withdrawNativeFees(vaultId: string): Promise<WithdrawFeesResult | null> {
    return this.withdrawFees(vaultId, '0x0000000000000000000000000000000000000000');
  }

  async withdrawErc20Fees(vaultId: string, token: Address): Promise<WithdrawFeesResult | null> {
    return this.withdrawFees(vaultId, token);
  }

  private async withdrawFees(vaultId: string, asset: Address): Promise<WithdrawFeesResult | null> {
    const vault = await this.vaultsRepository.findOne({ where: { id: vaultId } });
    if (!vault) throw new NotFoundException(`Vault ${vaultId} not found`);
    if (vault.chain_type !== ChainType.robinhood) {
      throw new BadRequestException(`Vault ${vaultId} is not an EVM vault`);
    }
    if (!vault.contract_address) {
      throw new BadRequestException(`Vault ${vaultId} has no contract address`);
    }

    const vaultAddress = vault.contract_address as Address;
    const isNative = asset === '0x0000000000000000000000000000000000000000';

    // Read accrued amount to gate on > 0 before broadcasting.
    let accrued: bigint;
    try {
      accrued = isNative
        ? await this.contractReader.publicClient.readContract({
            address: vaultAddress,
            abi: VAULT_ABI,
            functionName: 'accruedFeeNative',
          })
        : await this.contractReader.publicClient.readContract({
            address: vaultAddress,
            abi: VAULT_ABI,
            functionName: 'accruedFeeErc20',
            args: [asset],
          });
    } catch {
      // Contract predates V4 fee tracking — silently skip rather than spam logs.
      return null;
    }

    // if (accrued === 0n) {
    //   this.logger.debug(`withdrawFees no-op for vault ${vaultId}: accrued ${isNative ? 'native' : asset} = 0`);
    //   return null;
    // }

    const adminTx = this.transactionsRepository.create({
      type: TransactionType.evmWithdrawFees,
      status: TransactionStatus.pending,
      vault_id: vaultId,
      chain_id: vault.chain_id,
      from_address: this.adminSigner.address,
      to_address: vaultAddress,
      reconciliation_status: EvmReconciliationStatus.pending,
      reconciliation_attempts: 0,
      expected_events: [{ name: 'ProtocolFeeWithdrawn', count: 1 }],
    });
    await this.transactionsRepository.save(adminTx);

    let result: Awaited<ReturnType<EvmAdminSigner['sendAndConfirm']>>;
    try {
      result = await this.adminSigner.sendAndConfirm(
        { address: vaultAddress, abi: VAULT_ABI, functionName: 'withdrawFees', args: [asset] },
        ['ProtocolFeeWithdrawn'],
        async hash => {
          await this.transactionsRepository.update(
            { id: adminTx.id },
            { tx_hash: hash, status: TransactionStatus.submitted }
          );
        }
      );
    } catch (err) {
      if (err instanceof TxRevertedError) {
        await this.transactionsRepository.update(
          { id: adminTx.id },
          {
            status: TransactionStatus.failed,
            tx_hash: err.hash,
            reconciliation_status: EvmReconciliationStatus.failed,
            reconciliation_last_error: `withdrawFees reverted: ${err.message.slice(0, 500)}`,
          }
        );
        throw err;
      }
      await this.transactionsRepository.update(
        { id: adminTx.id },
        { reconciliation_last_error: `broadcast/receipt: ${(err as Error).message.slice(0, 500)}` }
      );
      throw err;
    }

    await this.transactionsRepository.update(
      { id: adminTx.id },
      {
        status: TransactionStatus.confirmed,
        reconciliation_status: EvmReconciliationStatus.success,
        reconciled_at: new Date(),
        reconciliation_last_error: null,
      }
    );

    this.logger.log(`withdrawFees confirmed for vault ${vaultId} asset=${asset} accrued=${accrued} tx=${result.hash}`);
    return { txHash: result.hash, asset, amount: accrued };
  }
}
