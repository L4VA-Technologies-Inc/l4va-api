import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { toHex, type Address, type Hex } from 'viem';

import { ADAPTER_REGISTRY_ABI } from './adapter-registry.abi';
import { EvmAdminSigner, TxRevertedError } from './evm-admin-signer.service';
import { EvmContractReader } from './evm-contract-reader.service';

export interface AdapterApproveResult {
  txHash: Hex;
  adapter: Address;
  tag: Hex;
}

/**
 * Admin service for AdapterRegistry.sol.
 * Registry calls are infrastructure-level (no vault_id) so no Transaction rows
 * are created — the tx hash is returned directly to the caller.
 */
// Minimal VaultFactory ABI slice — adapterRegistry() view.
const FACTORY_ABI = [
  { type: 'function', stateMutability: 'view', name: 'adapterRegistry', inputs: [], outputs: [{ type: 'address' }] },
] as const;

@Injectable()
export class EvmAdapterRegistryService implements OnModuleInit {
  private readonly logger = new Logger(EvmAdapterRegistryService.name);
  private registryAddress: Address;
  private readonly factoryAddress: Address | null;

  constructor(
    private readonly contractReader: EvmContractReader,
    private readonly adminSigner: EvmAdminSigner,
    configService: ConfigService
  ) {
    const raw = configService.get<string>('EVM_ADAPTER_REGISTRY_ADDRESS');
    this.registryAddress = (raw ?? '') as Address;
    const factory = configService.get<string>('EVM_FACTORY_ADDRESS');
    this.factoryAddress = factory ? (factory as Address) : null;
  }

  /** Resolve registry address from chain if the env var was not set. */
  async onModuleInit(): Promise<void> {
    if (this.registryAddress) return;
    if (!this.factoryAddress) {
      throw new Error('EVM_ADAPTER_REGISTRY_ADDRESS and EVM_FACTORY_ADDRESS are both unset');
    }
    try {
      this.registryAddress = (await this.contractReader.publicClient.readContract({
        address: this.factoryAddress,
        abi: FACTORY_ABI,
        functionName: 'adapterRegistry',
      })) as Address;
      this.logger.log(`AdapterRegistry resolved from factory: ${this.registryAddress}`);
    } catch (err) {
      throw new Error(`Failed to read adapterRegistry from factory ${this.factoryAddress}: ${(err as Error).message}`);
    }
  }

  async isApproved(adapter: Address): Promise<boolean> {
    return this.contractReader.publicClient.readContract({
      address: this.registryAddress,
      abi: ADAPTER_REGISTRY_ABI,
      functionName: 'approved',
      args: [adapter],
    }) as Promise<boolean>;
  }

  /** Approve an adapter. `tag` is a short label encoded as bytes32. */
  async approveAdapter(adapter: Address, tagLabel: string): Promise<AdapterApproveResult> {
    const tag = toHex(tagLabel.slice(0, 31), { size: 32 }) as Hex;

    if (await this.isApproved(adapter)) {
      this.logger.warn(`Adapter ${adapter} is already approved — idempotent no-op`);
    }

    let result: Awaited<ReturnType<EvmAdminSigner['sendAndConfirm']>>;
    try {
      result = await this.adminSigner.sendAndConfirm(
        {
          address: this.registryAddress,
          abi: ADAPTER_REGISTRY_ABI,
          functionName: 'approveAdapter',
          args: [adapter, tag],
        },
        ['AdapterApproved']
      );
    } catch (err) {
      if (err instanceof TxRevertedError) this.logger.error(`approveAdapter reverted: ${err.message}`);
      throw err;
    }

    this.logger.log(`approveAdapter confirmed adapter=${adapter} tag=${tagLabel} tx=${result.hash}`);
    return { txHash: result.hash, adapter, tag };
  }

  async revokeAdapter(adapter: Address): Promise<{ txHash: Hex }> {
    if (!(await this.isApproved(adapter))) {
      throw new BadRequestException(`Adapter ${adapter} is not currently approved`);
    }

    let result: Awaited<ReturnType<EvmAdminSigner['sendAndConfirm']>>;
    try {
      result = await this.adminSigner.sendAndConfirm(
        { address: this.registryAddress, abi: ADAPTER_REGISTRY_ABI, functionName: 'revokeAdapter', args: [adapter] },
        ['AdapterRevoked']
      );
    } catch (err) {
      if (err instanceof TxRevertedError) this.logger.error(`revokeAdapter reverted: ${err.message}`);
      throw err;
    }

    this.logger.log(`revokeAdapter confirmed adapter=${adapter} tx=${result.hash}`);
    return { txHash: result.hash };
  }
}
