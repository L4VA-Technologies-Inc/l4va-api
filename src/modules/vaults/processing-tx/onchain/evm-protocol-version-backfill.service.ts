import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { parseAbi, type Address } from 'viem';

import { EvmContractReader } from './evm-contract-reader.service';
import { findEvmProtocolVersionByFactory } from './evm-protocol-versions';

import { Vault } from '@/database/vault.entity';
import { ChainType } from '@/types/vault.types';

const FACTORY_ABI = parseAbi(['function factory() view returns (address)']);

/**
 * Pins deployed Robinhood vaults that have no protocol version yet, from the factory their contract
 * names on-chain. An unregistered factory is logged and left null, never guessed. Runs in the
 * background on every start and only touches null rows, so it is safe to repeat.
 */
@Injectable()
export class EvmProtocolVersionBackfillService implements OnApplicationBootstrap {
  private readonly logger = new Logger(EvmProtocolVersionBackfillService.name);

  constructor(
    @InjectRepository(Vault) private readonly vaultRepository: Repository<Vault>,
    private readonly contractReader: EvmContractReader
  ) {}

  onApplicationBootstrap(): void {
    void this.backfill().catch(err =>
      this.logger.error(`EVM protocol version backfill failed: ${(err as Error).message}`)
    );
  }

  async backfill(): Promise<{ pinned: number; unknown: number; failed: number }> {
    const vaults = await this.vaultRepository.find({
      where: { chain_type: ChainType.robinhood, contract_address: Not(IsNull()), evm_protocol_version: IsNull() },
      select: ['id', 'contract_address', 'chain_id'],
    });
    const result = { pinned: 0, unknown: 0, failed: 0 };

    for (const vault of vaults) {
      try {
        const factory = await this.contractReader.publicClient.readContract({
          address: vault.contract_address as Address,
          abi: FACTORY_ABI,
          functionName: 'factory',
        });
        const version = findEvmProtocolVersionByFactory(Number(vault.chain_id), factory);
        if (!version) {
          result.unknown++;
          this.logger.error(`Vault ${vault.id}: factory ${factory} is not a registered protocol version`);
          continue;
        }
        await this.vaultRepository.update(
          { id: vault.id, evm_protocol_version: IsNull() },
          { evm_protocol_version: version.version }
        );
        result.pinned++;
      } catch (err) {
        // Wrong network, or an address that is not a vault. Retried on the next start.
        result.failed++;
        this.logger.warn(`Vault ${vault.id}: could not read its factory: ${(err as Error).message}`);
      }
    }

    if (vaults.length > 0) this.logger.log(`EVM protocol version backfill: ${JSON.stringify(result)}`);
    return result;
  }
}
