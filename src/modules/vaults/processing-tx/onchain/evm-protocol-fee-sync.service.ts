import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { keccak256, toBytes, type Address } from 'viem';

import { EvmAdminSigner } from './evm-admin-signer.service';
import { EvmContractReader } from './evm-contract-reader.service';
import { PROTOCOL_FEE_CONFIG_ABI, ProtocolFeeType } from './protocol-fee-config.abi';

import {
  SYSTEM_SETTINGS_LOADED_EVENT,
  SystemSettingsService,
} from '@/modules/globals/system-settings/system-settings.service';

const FACTORY_FEE_CONFIG_ABI = [
  {
    type: 'function',
    stateMutability: 'view',
    name: 'protocolFeeConfig',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const;

const ROLE_ABI = [
  {
    type: 'function',
    stateMutability: 'view',
    name: 'hasRole',
    inputs: [
      { name: 'role', type: 'bytes32' },
      { name: 'account', type: 'address' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

const FEE_MANAGER_ROLE = keccak256(toBytes('FEE_MANAGER_ROLE'));

/**
 * Keeps the on-chain acquire fee (`ProtocolFeeConfig` FeeType.Contribution)
 * equal to the `evm_acquire_fee_bps` system setting, so it is edited from the
 * admin like every other fee.
 *
 * Targets the fee config of the current factory (EVM_FACTORY_ADDRESS). Vaults
 * read the rate at close time, so one write covers every vault that factory
 * deployed. Where the admin key is not FEE_MANAGER (e.g. a Timelock holds the
 * role on mainnet) this only logs — it never blocks boot or a settings reload.
 */
@Injectable()
export class EvmProtocolFeeSyncService implements OnApplicationBootstrap {
  private readonly logger = new Logger(EvmProtocolFeeSyncService.name);
  private readonly factoryAddress: Address | null;
  private syncing = false;

  constructor(
    configService: ConfigService,
    private readonly systemSettingsService: SystemSettingsService,
    private readonly contractReader: EvmContractReader,
    private readonly adminSigner: EvmAdminSigner
  ) {
    this.factoryAddress = (configService.get<string>('EVM_FACTORY_ADDRESS') as Address) || null;
  }

  onApplicationBootstrap(): void {
    void this.sync();
  }

  @OnEvent(SYSTEM_SETTINGS_LOADED_EVENT)
  handleSettingsLoaded(): void {
    void this.sync();
  }

  async sync(): Promise<void> {
    const desired = this.systemSettingsService.evmAcquireFeeBps;
    if (desired === null || !this.factoryAddress || this.syncing) return;

    this.syncing = true;
    try {
      const client = this.contractReader.publicClient;
      const feeConfig = (await client.readContract({
        address: this.factoryAddress,
        abi: FACTORY_FEE_CONFIG_ABI,
        functionName: 'protocolFeeConfig',
      })) as Address;
      const current = Number(
        await client.readContract({
          address: feeConfig,
          abi: PROTOCOL_FEE_CONFIG_ABI,
          functionName: 'feeBps',
          args: [ProtocolFeeType.Contribution],
        })
      );
      if (current === desired) return;

      const isManager = (await client.readContract({
        address: feeConfig,
        abi: ROLE_ABI,
        functionName: 'hasRole',
        args: [FEE_MANAGER_ROLE, this.adminSigner.address],
      })) as boolean;
      if (!isManager) {
        this.logger.warn(
          `evm_acquire_fee_bps=${desired} but on-chain is ${current}, and ${this.adminSigner.address} is not FEE_MANAGER on ${feeConfig}. Set it via the role holder.`
        );
        return;
      }

      const { hash } = await this.adminSigner.sendAndConfirm({
        address: feeConfig,
        abi: PROTOCOL_FEE_CONFIG_ABI,
        functionName: 'setFeeBps',
        args: [ProtocolFeeType.Contribution, desired],
      });
      this.logger.log(`Acquire fee set on chain: ${current} -> ${desired} bps (${feeConfig}, tx ${hash})`);
    } catch (err) {
      this.logger.error(`Failed to sync evm_acquire_fee_bps on chain: ${(err as Error).message}`);
    } finally {
      this.syncing = false;
    }
  }
}
