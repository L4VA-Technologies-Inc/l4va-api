import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { type Address, type Hex, isAddressEqual, isHash } from 'viem';

import { EvmAdminSigner, TxRevertedError } from './evm-admin-signer.service';
import { EvmContractReader } from './evm-contract-reader.service';
import {
  findInboundTransfers,
  type InboundTransfer,
  isMint,
  RescueKind,
  transactionTouchedVault,
} from './evm-rescue.utils';
import { VAULT_ABI } from './vault.abi';

import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { EvmReconciliationStatus, TransactionStatus, TransactionType } from '@/types/transaction.types';
import { ChainType } from '@/types/vault.types';

export interface RescueCandidate {
  logIndex: number;
  kind: 'erc20' | 'erc721' | 'erc1155';
  asset: Address;
  tokenId: string;
  amount: string;
  /** Always the sender of the original transfer: the backend never sends a stray anywhere else. */
  recipient: Address;
  sourceId: Hex;
  rescuable: boolean;
  /** Why it cannot be rescued; null when it can. */
  reason: string | null;
  untracked: string;
}

export interface RescuePreview {
  vaultId: string;
  vaultAddress: Address;
  txHash: Hex;
  /** False for vaults created before the post-V10 deployer: they have no rescue functions. */
  supported: boolean;
  candidates: RescueCandidate[];
}

const KIND_NAME: Record<RescueKind, RescueCandidate['kind'] | 'native'> = {
  [RescueKind.Native]: 'native',
  [RescueKind.ERC20]: 'erc20',
  [RescueKind.ERC721]: 'erc721',
  [RescueKind.ERC1155]: 'erc1155',
};

/**
 * Returns assets someone sent straight to a vault (outside the ledger) to the address that sent them.
 *
 * Input is the hash of the transaction that sent them. Each transfer log into the vault becomes one
 * candidate with a one-time `sourceId`; the vault refuses a second payout under the same id. Only
 * vaults created from the post-V10 deployer have rescue; older vaults are reported as unsupported.
 * Native ETH is not handled: `receive()` refuses plain sends, so stray ETH has no transfer to repay.
 */
@Injectable()
export class EvmRescueService {
  private readonly logger = new Logger(EvmRescueService.name);
  /** Vault code never changes, so support is cached per address for the process lifetime. */
  private readonly supportCache = new Map<string, boolean>();

  constructor(
    @InjectRepository(Vault) private readonly vaultsRepository: Repository<Vault>,
    @InjectRepository(Transaction) private readonly transactionsRepository: Repository<Transaction>,
    private readonly contractReader: EvmContractReader,
    private readonly adminSigner: EvmAdminSigner
  ) {}

  /** True when the vault has the rescue functions (created from the post-V10 deployer). */
  async supportsRescue(vaultAddress: Address): Promise<boolean> {
    const key = vaultAddress.toLowerCase();
    const cached = this.supportCache.get(key);
    if (cached !== undefined) return cached;
    let supported: boolean;
    try {
      await this.contractReader.publicClient.readContract({
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: 'isSourceRescued',
        args: [`0x${'0'.repeat(63)}1`],
      });
      supported = true;
    } catch {
      supported = false; // unknown selector reverts: older vault code
    }
    this.supportCache.set(key, supported);
    return supported;
  }

  async preview(vaultId: string, txHash: string): Promise<RescuePreview> {
    const vault = await this.requireEvmVault(vaultId);
    const vaultAddress = vault.contract_address as Address;
    const hash = this.requireHash(txHash);

    const supported = await this.supportsRescue(vaultAddress);
    if (!supported) return { vaultId, vaultAddress, txHash: hash, supported, candidates: [] };

    const client = this.contractReader.publicClient;
    const [receipt, tx, vaultToken] = await Promise.all([
      client.getTransactionReceipt({ hash }),
      client.getTransaction({ hash }),
      client.readContract({ address: vaultAddress, abi: VAULT_ABI, functionName: 'vaultToken' }) as Promise<Address>,
    ]);
    if (receipt.status !== 'success') throw new BadRequestException(`Transaction ${hash} did not succeed`);

    const transfers = findInboundTransfers(hash, receipt.logs, vaultAddress);
    const throughVault = transactionTouchedVault(tx.to, receipt.logs, vaultAddress);

    const candidates: RescueCandidate[] = [];
    for (const t of transfers) {
      candidates.push(await this.assess(vaultAddress, vaultToken, t, throughVault));
    }
    return { vaultId, vaultAddress, txHash: hash, supported, candidates };
  }

  /**
   * Rescues one transfer from `txHash` (by log index, plus token id for an ERC-1155 batch) back to
   * its sender. Re-checks everything the preview checked, then lets the vault enforce it again.
   */
  async rescue(
    vaultId: string,
    txHash: string,
    logIndex: number,
    tokenId?: string
  ): Promise<{ txHash: Hex; candidate: RescueCandidate }> {
    const preview = await this.preview(vaultId, txHash);
    if (!preview.supported) {
      throw new BadRequestException(
        `Vault ${vaultId} was created before rescue existed; its code cannot return stray assets`
      );
    }
    const matches = preview.candidates.filter(
      c => c.logIndex === logIndex && (tokenId === undefined || c.tokenId === tokenId)
    );
    if (matches.length === 0) throw new NotFoundException(`No transfer into the vault at log ${logIndex}`);
    if (matches.length > 1) throw new BadRequestException('Several token ids at this log index; pass tokenId');
    const c = matches[0];
    if (!c.rescuable) throw new BadRequestException(`Not rescuable: ${c.reason}`);

    const vault = await this.requireEvmVault(vaultId);
    const vaultAddress = preview.vaultAddress;
    const authority = (await this.contractReader.publicClient.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'authority',
    })) as Address;
    if (!isAddressEqual(authority, this.adminSigner.address)) {
      throw new BadRequestException(`Vault authority ${authority} is not this backend's admin signer`);
    }

    const { functionName, args } = this.callFor(c);
    const record = this.transactionsRepository.create({
      type: TransactionType.evmRescueUntracked,
      status: TransactionStatus.pending,
      vault_id: vaultId,
      chain_id: vault.chain_id,
      from_address: this.adminSigner.address,
      to_address: vaultAddress,
      reconciliation_status: EvmReconciliationStatus.pending,
      reconciliation_attempts: 0,
      expected_events: [{ name: 'UntrackedRescued', count: 1 }],
      metadata: {
        rescue: {
          sourceTxHash: preview.txHash,
          logIndex: c.logIndex,
          sourceId: c.sourceId,
          kind: c.kind,
          asset: c.asset,
          tokenId: c.tokenId,
          amount: c.amount,
          recipient: c.recipient,
        },
      },
    });
    await this.transactionsRepository.save(record);

    try {
      const result = await this.adminSigner.sendAndConfirm(
        { address: vaultAddress, abi: VAULT_ABI, functionName: functionName as any, args: args as any },
        ['UntrackedRescued'],
        async hash => {
          await this.transactionsRepository.update(
            { id: record.id },
            { tx_hash: hash, status: TransactionStatus.submitted }
          );
        }
      );
      await this.transactionsRepository.update(
        { id: record.id },
        {
          status: TransactionStatus.confirmed,
          reconciliation_status: EvmReconciliationStatus.success,
          reconciled_at: new Date(),
          reconciliation_last_error: null,
        }
      );
      this.logger.log(
        `rescue ${c.kind} ${c.asset}#${c.tokenId} x${c.amount} -> ${c.recipient} vault=${vaultId} source=${c.sourceId} tx=${result.hash}`
      );
      return { txHash: result.hash, candidate: c };
    } catch (err) {
      const message = (err as Error).message?.slice(0, 500);
      await this.transactionsRepository.update(
        { id: record.id },
        err instanceof TxRevertedError
          ? {
              status: TransactionStatus.failed,
              tx_hash: err.hash,
              reconciliation_status: EvmReconciliationStatus.failed,
              reconciliation_last_error: `rescue reverted: ${message}`,
            }
          : { reconciliation_last_error: `broadcast/receipt: ${message}` }
      );
      throw err;
    }
  }

  private async assess(
    vault: Address,
    vaultToken: Address,
    t: InboundTransfer,
    throughVault: boolean
  ): Promise<RescueCandidate> {
    const client = this.contractReader.publicClient;
    const [untracked, used] = await Promise.all([
      client
        .readContract({
          address: vault,
          abi: VAULT_ABI,
          functionName: 'untrackedBalance',
          args: [t.kind, t.asset, t.tokenId],
        })
        .catch(() => 0n) as Promise<bigint>,
      client.readContract({
        address: vault,
        abi: VAULT_ABI,
        functionName: 'isSourceRescued',
        args: [t.sourceId],
      }) as Promise<boolean>,
    ]);

    let reason: string | null = null;
    if (throughVault) reason = 'transaction went through the vault (ledger operation, not a stray)';
    else if (isMint(t)) reason = 'minted straight to the vault: no sender to return it to';
    else if (isAddressEqual(t.asset, vaultToken)) reason = "the vault's own token is never rescuable";
    else if (used) reason = 'already rescued';
    else if (t.amount === 0n) reason = 'zero amount';
    else if (untracked < t.amount) reason = `vault holds only ${untracked} untracked, transfer was ${t.amount}`;

    return {
      logIndex: t.logIndex,
      kind: KIND_NAME[t.kind] as RescueCandidate['kind'],
      asset: t.asset,
      tokenId: t.tokenId.toString(),
      amount: t.amount.toString(),
      recipient: t.from,
      sourceId: t.sourceId,
      rescuable: reason === null,
      reason,
      untracked: untracked.toString(),
    };
  }

  private callFor(c: RescueCandidate): { functionName: string; args: unknown[] } {
    const tokenId = BigInt(c.tokenId);
    const amount = BigInt(c.amount);
    switch (c.kind) {
      case 'erc20':
        return { functionName: 'rescueUntrackedERC20', args: [c.asset, c.recipient, amount, c.sourceId] };
      case 'erc721':
        return { functionName: 'rescueUntrackedERC721', args: [c.asset, tokenId, c.recipient, c.sourceId] };
      case 'erc1155':
        return {
          functionName: 'rescueUntrackedERC1155',
          args: [c.asset, tokenId, amount, c.recipient, c.sourceId],
        };
    }
  }

  private requireHash(txHash: string): Hex {
    if (!isHash(txHash)) throw new BadRequestException('txHash must be a 32-byte hex transaction hash');
    return txHash as Hex;
  }

  private async requireEvmVault(vaultId: string): Promise<Vault> {
    const vault = await this.vaultsRepository.findOne({ where: { id: vaultId } });
    if (!vault) throw new NotFoundException(`Vault ${vaultId} not found`);
    if (vault.chain_type !== ChainType.robinhood) {
      throw new BadRequestException(`Vault ${vaultId} is not an EVM vault`);
    }
    if (!vault.contract_address) throw new BadRequestException(`Vault ${vaultId} has no contract address`);
    return vault;
  }
}
