import { Buffer } from 'buffer';

import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Address, FixedTransaction, PrivateKey } from '@emurgo/cardano-serialization-lib-nodejs';
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { firstValueFrom } from 'rxjs';
import { Repository } from 'typeorm';

import { BlockchainService } from '../vaults/processing-tx/onchain/blockchain.service';
import { getUtxos } from '../vaults/processing-tx/onchain/utils/lib';

import { Claim } from '@/database/claim.entity';
import { ClaimStatus, ClaimType } from '@/types/claim.types';

// Constants for VyFi pool creation
const VYFI_CONSTANTS = {
  PROCESSING_FEE: 1900000, // 1.9 ADA in lovelace
  MIN_POOL_ADA: 2000000, // 2 ADA in lovelace
  MIN_RETURN_ADA: 2000000, // 2 ADA in lovelace
  TOTAL_REQUIRED_ADA: 5900000, // 5.9 ADA in lovelace
  POOL_ADDRESS:
    'addr_test1qpjavykfl5n4t47xklzyuccevgple0e4c7mke2m6cd0z0fwy0pq8p292lgrquq7hx75c4wpvz0h8cjp69mp7men3nw8s46zete', // VyFi pool address preprod
  METADATA_LABEL: '53554741',
};

@Injectable()
export class VyfiService {
  private readonly logger = new Logger(VyfiService.name);
  private readonly vyfiApiUrl = 'https://api.vyfi.io';
  private readonly adminSKey: string;
  private readonly adminAddress: string;
  private readonly adminHash: string;
  private readonly blockfrost: BlockFrostAPI;

  constructor(
    @InjectRepository(Claim)
    private claimRepository: Repository<Claim>,
    private readonly httpService: HttpService,
    private readonly blockchainService: BlockchainService,
    private readonly configService: ConfigService
  ) {
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');
    this.adminAddress = this.configService.get<string>('ADMIN_ADDRESS');
    this.adminHash = this.configService.get<string>('ADMIN_KEY_HASH');
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_TESTNET_API_KEY'),
    });
  }

  async checkPool({
    networkId,
    tokenAUnit,
    tokenBUnit,
  }: {
    networkId: number;
    tokenAUnit: string;
    tokenBUnit: string;
  }): Promise<
    | {
        exists: boolean;
        data: any;
        error?: undefined;
      }
    | {
        exists: boolean;
        error: string;
        data?: undefined;
      }
  > {
    const url = `${this.vyfiApiUrl}/lp`;
    const queryParams = new URLSearchParams({
      networkId: networkId.toString(),
      tokenAUnit,
      tokenBUnit,
      v2: 'true',
    });

    try {
      const response = await firstValueFrom(this.httpService.get(`${url}?${queryParams.toString()}`));
      return {
        exists: true,
        data: response.data,
      };
    } catch (error) {
      if (error.response?.status === 500 || error.response?.status === 404) {
        return {
          exists: false,
          error: 'Pool does not exist',
        };
      }
      throw new Error(`Failed to check VyFi pool: ${error.message}`);
    }
  }

  private formatMetadataText(tokenA: { policyId?: string; assetName: string }): string {
    const shortA = tokenA.policyId ? tokenA.policyId.substring(0, 8) : 'lovelace';
    return `VyFi: LP Factory Create Pool Order Request -- /${VYFI_CONSTANTS.METADATA_LABEL} ${shortA}/lovelace`;
  }

  async createLiquidityPool(claimId: string): Promise<{
    txHash: string;
  }> {
    const claim = await this.claimRepository.findOne({
      where: { id: claimId, type: ClaimType.LP, status: ClaimStatus.AVAILABLE },
      relations: ['vault'],
    });

    if (!claim) {
      throw new NotFoundException('Liquidity pool claim not found');
    }

    // First check if pool exists
    const poolCheck = await this.checkPool({
      networkId: 0,
      tokenAUnit: `${claim.vault.policy_id}${claim.vault.asset_vault_name}`,
      tokenBUnit: 'lovelace',
    });

    if (poolCheck.exists) {
      throw new Error('Pool already exists');
    }

    // Generate metadata
    const metadataText = this.formatMetadataText({
      policyId: claim.vault.policy_id,
      assetName: claim.vault.asset_vault_name,
    });

    // Get UTxOs
    const utxos = await getUtxos(Address.from_bech32(this.adminAddress), 0, this.blockfrost);
    if (utxos.len() === 0) {
      throw new Error('No UTXOs found.');
    }

    const selectedUtxo = utxos.get(0);
    const REQUIRED_INPUTS = [selectedUtxo.to_hex()];

    // Construct transaction input with proper ADA amounts
    const input = {
      changeAddress: this.adminAddress,
      message: `VyFi: LP Factory Create Pool Order Request -- /${VYFI_CONSTANTS.METADATA_LABEL}`,
      outputs: [
        {
          address: VYFI_CONSTANTS.POOL_ADDRESS,
          assets: [
            {
              assetName: { name: claim.vault.asset_vault_name, format: 'hex' },
              policyId: claim.vault.policy_id,
              quantity: claim.amount,
            },
          ],
          lovelace: VYFI_CONSTANTS.TOTAL_REQUIRED_ADA + Number(claim.metadata?.adaAmount || 0),
        },
      ],
      metadata: {
        [VYFI_CONSTANTS.METADATA_LABEL]: metadataText,
      },
      requiredSigners: [this.adminHash],
      requiredInputs: REQUIRED_INPUTS,
    };

    const buildResponse = await this.blockchainService.buildTransaction(input);
    const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
    txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

    // Submit the transaction
    const submitResponse = await this.blockchainService.submitTransaction({
      transaction: txToSubmitOnChain.to_hex(),
      signatures: [],
    });

    return {
      txHash: submitResponse.txHash,
    };
  }

  async getPoolInfo(poolId: string): Promise<any> {
    try {
      const response = await firstValueFrom(this.httpService.get(`${this.vyfiApiUrl}/pool/${poolId}`));
      return response.data;
    } catch (error) {
      throw new Error(`Failed to get VyFi pool info: ${error.message}`);
    }
  }
}
