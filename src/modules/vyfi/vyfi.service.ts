import { Buffer } from 'buffer';

import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Address, FixedTransaction, PrivateKey } from '@emurgo/cardano-serialization-lib-nodejs';
import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

import { BlockchainService } from '../vaults/processing-tx/onchain/blockchain.service';
import { getUtxos } from '../vaults/processing-tx/onchain/utils/lib';

import { CreatePoolDto } from './dto/create-pool.dto';

const poolOwner = {
  skey: 'ed25519e_sk1eqleq0gr7awjymmkcehm4pza8ffq385fyxkntqe74u384fgfs4w7vncmhdlc2u2l78g4r82ctfw6s36dnuguadxh3lggluy9pwansegfprll7',
  base_address_preprod:
    'addr_test1qpjavykfl5n4t47xklzyuccevgple0e4c7mke2m6cd0z0fwy0pq8p292lgrquq7hx75c4wpvz0h8cjp69mp7men3nw8s46zete', // Vault address with VT and Ada
};

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
  private readonly vyfiApiUrl = 'https://api.vyfi.io';
  private readonly poolOwner: {
    skey: string;
    base_address_preprod: string;
  };
  private readonly blockfrost: BlockFrostAPI;

  constructor(
    private readonly httpService: HttpService,
    private readonly blockchainService: BlockchainService,
    private readonly configService: ConfigService
  ) {
    this.poolOwner = poolOwner;
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_TESTNET_API_KEY'),
    });
  }

  async checkPool(params: { networkId: number; tokenAUnit: string; tokenBUnit: string }) {
    const { networkId, tokenAUnit, tokenBUnit } = params;
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

  private formatMetadataText(
    tokenA: { policyId?: string; assetName: string },
    tokenB: { policyId?: string; assetName: string }
  ): string {
    const shortA = tokenA.policyId ? tokenA.policyId.substring(0, 8) : 'lovelace';
    const shortB = tokenB.policyId ? tokenB.policyId.substring(0, 8) : 'lovelace';
    return `VyFi: LP Factory Create Pool Order Request -- /${VYFI_CONSTANTS.METADATA_LABEL} ${shortA}/${shortB}`;
  }

  async createLiquidityPool(createPoolDto: CreatePoolDto) {
    const { networkId, tokenA, tokenB } = createPoolDto;

    // First check if pool exists
    const poolCheck = await this.checkPool({
      networkId,
      tokenAUnit: tokenA.policyId ? `${tokenA.policyId}${tokenA.assetName}` : 'lovelace',
      tokenBUnit: tokenB.policyId ? `${tokenB.policyId}${tokenB.assetName}` : 'lovelace',
    });

    if (poolCheck.exists) {
      throw new Error('Pool already exists');
    }

    const CUSTOMER_ADDRESS = this.poolOwner.base_address_preprod;

    // Generate metadata
    const metadataText = this.formatMetadataText(tokenA, tokenB);

    // Get UTxOs
    const utxos = await getUtxos(Address.from_bech32(CUSTOMER_ADDRESS), 0, this.blockfrost);
    if (utxos.len() === 0) {
      throw new Error('No UTXOs found.');
    }

    const selectedUtxo = utxos.get(0);
    const REQUIRED_INPUTS = [selectedUtxo.to_hex()];

    // Construct transaction input with proper ADA amounts
    const input = {
      changeAddress: CUSTOMER_ADDRESS,
      message: `VyFi: LP Factory Create Pool Order Request -- /${VYFI_CONSTANTS.METADATA_LABEL}`,
      outputs: [
        {
          address: VYFI_CONSTANTS.POOL_ADDRESS,
          assets: [
            {
              assetName: { name: tokenA.assetName, format: 'hex' },
              policyId: tokenA.policyId,
              quantity: tokenA.amount,
            },
            // {
            //   assetName: { name: tokenB.assetName, format: 'hex' },
            //   policyId: tokenB.policyId,
            //   quantity: tokenB.amount,
            // },
          ],
          lovelace: VYFI_CONSTANTS.TOTAL_REQUIRED_ADA,
        },
      ],
      metadata: {
        [VYFI_CONSTANTS.METADATA_LABEL]: metadataText,
      },
      requiredInputs: REQUIRED_INPUTS,
    };

    console.log(JSON.stringify(input));

    // Sign the transaction
    const buildResponse = await this.blockchainService.buildTransaction(input);

    // Sign the transaction
    const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
    txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.poolOwner.skey));

    // Submit the transaction
    const submitResponse = await this.blockchainService.submitTransaction({
      transaction: txToSubmitOnChain.to_hex(),
      signatures: [], // Signatures are already added to the transaction
    });

    return {
      txHash: submitResponse.txHash,
      poolAddress: VYFI_CONSTANTS.POOL_ADDRESS,
      fees: {
        processingFee: VYFI_CONSTANTS.PROCESSING_FEE,
        minPoolAda: VYFI_CONSTANTS.MIN_POOL_ADA,
        minReturnAda: VYFI_CONSTANTS.MIN_RETURN_ADA,
        totalRequiredAda: VYFI_CONSTANTS.TOTAL_REQUIRED_ADA,
      },
    };
  }

  async getPoolInfo(poolId: string) {
    try {
      const response = await firstValueFrom(this.httpService.get(`${this.vyfiApiUrl}/pool/${poolId}`));
      return response.data;
    } catch (error) {
      throw new Error(`Failed to get VyFi pool info: ${error.message}`);
    }
  }
}
