import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { parseAbiItem, type Address } from 'viem';

import { EvmContractReader } from '../../processing-tx/onchain/evm-contract-reader.service';
import { VAULT_ABI } from '../../processing-tx/onchain/vault.abi';

import { Snapshot } from '@/database/snapshot.entity';
import { Vault } from '@/database/vault.entity';
import { ChainType, VaultStatus } from '@/types/vault.types';

const ERC20_TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

/** Block range per getLogs request — stays safely within most RPC limits. */
const LOG_CHUNK_BLOCKS = 10_000n;

@Injectable()
export class EvmSnapshotService {
  private readonly logger = new Logger(EvmSnapshotService.name);

  constructor(
    @InjectRepository(Vault) private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(Snapshot) private readonly snapshotRepository: Repository<Snapshot>,
    private readonly contractReader: EvmContractReader
  ) {}

  /**
   * Scan all ERC-20 Transfer events on the vault's VaultToken contract,
   * build a current holder→balance map, and persist it as a Snapshot.
   *
   * The address map mirrors the Cardano snapshot format so all downstream
   * voting-power logic works without changes.
   *
   * Called by createDailySnapshots for EVM vaults and by createProposal
   * when no recent snapshot exists.
   */
  async createSnapshot(vaultId: string): Promise<Snapshot> {
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      select: ['id', 'contract_address', 'chain_type'],
    });

    if (!vault || vault.chain_type !== ChainType.robinhood) {
      throw new Error(`Vault ${vaultId} is not an EVM vault`);
    }
    if (!vault.contract_address) {
      throw new Error(`Vault ${vaultId} has no contract address`);
    }

    const vtAddress = await this.getVaultTokenAddress(vault.contract_address as Address);
    const balances = await this.buildHolderBalances(vtAddress);

    // Serialize bigint → string to match the Snapshot.addressBalances schema.
    const addressBalancesForSnapshot: Record<string, string> = {};
    for (const [address, balance] of balances.entries()) {
      addressBalancesForSnapshot[address] = String(balance);
    }

    const snapshot = this.snapshotRepository.create({
      vaultId,
      // Use the VaultToken ERC-20 address as assetId (mirrors Cardano policy+name pattern).
      assetId: vtAddress.toLowerCase(),
      addressBalances: addressBalancesForSnapshot,
    });

    await this.snapshotRepository.save(snapshot);

    this.logger.log(`EVM snapshot created for vault ${vaultId} — ` + `vtToken=${vtAddress} holders=${balances.size}`);
    return snapshot;
  }

  /** Return all EVM vaults currently in locked/expansion status. */
  async findEligibleVaults(): Promise<Pick<Vault, 'id' | 'contract_address'>[]> {
    return this.vaultRepository.find({
      where: [
        { chain_type: ChainType.robinhood, vault_status: VaultStatus.locked },
        { chain_type: ChainType.robinhood, vault_status: VaultStatus.expansion },
        { chain_type: ChainType.robinhood, vault_status: VaultStatus.acquire_expansion },
      ],
      select: ['id', 'contract_address'],
    });
  }

  // ---------------------------------------------------------------------------

  private async getVaultTokenAddress(vaultAddress: Address): Promise<Address> {
    return this.contractReader.publicClient.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'vaultToken',
    }) as Promise<Address>;
  }

  /**
   * Reconstruct current ERC-20 balances by replaying all Transfer events.
   * Chunks getLogs by block range to stay within RPC limits.
   */
  private async buildHolderBalances(vtAddress: Address): Promise<Map<string, bigint>> {
    const balances = new Map<string, bigint>();

    const latestBlock: bigint = await this.contractReader.publicClient.getBlockNumber();
    let fromBlock = 0n;

    while (fromBlock <= latestBlock) {
      const toBlock = fromBlock + LOG_CHUNK_BLOCKS - 1n < latestBlock ? fromBlock + LOG_CHUNK_BLOCKS - 1n : latestBlock;

      const logs = await this.contractReader.publicClient.getLogs({
        address: vtAddress,
        event: ERC20_TRANSFER_EVENT,
        fromBlock,
        toBlock,
      });

      for (const log of logs) {
        const { from, to, value } = log.args as { from: Address; to: Address; value: bigint };

        // Burn (to = 0x0): subtract from sender.
        const toNorm = to.toLowerCase();
        const fromNorm = from.toLowerCase();
        const ZERO = '0x0000000000000000000000000000000000000000';

        if (fromNorm !== ZERO) {
          balances.set(fromNorm, (balances.get(fromNorm) ?? 0n) - value);
        }
        if (toNorm !== ZERO) {
          balances.set(toNorm, (balances.get(toNorm) ?? 0n) + value);
        }
      }

      fromBlock = toBlock + 1n;
    }

    // Remove zero/negative balances (shouldn't happen in a correct ERC-20, but be defensive).
    for (const [addr, bal] of balances.entries()) {
      if (bal <= 0n) balances.delete(addr);
    }

    return balances;
  }
}
