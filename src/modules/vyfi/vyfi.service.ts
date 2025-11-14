import { Buffer } from 'buffer';

import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import {
  Address,
  Credential,
  EnterpriseAddress,
  FixedTransaction,
  PrivateKey,
  ScriptHash,
} from '@emurgo/cardano-serialization-lib-nodejs';
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { firstValueFrom } from 'rxjs';
import { Repository } from 'typeorm';

import { BlockchainService } from '../vaults/processing-tx/onchain/blockchain.service';
import { getUtxosExtract } from '../vaults/processing-tx/onchain/utils/lib';

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

  async getPoolInfo(poolId: string): Promise<any> {
    try {
      const response = await firstValueFrom(this.httpService.get(`${this.vyfiApiUrl}/pool/${poolId}`));
      return response.data;
    } catch (error) {
      throw new Error(`Failed to get VyFi pool info: ${error.message}`);
    }
  }

  /**
   * Create VyFi Liquidity Pool with Dispatch Withdrawal
   *
   * This is the enhanced version that combines:
   * 1. Withdrawal of ADA from vault dispatch script
   * 2. Collection of vault tokens from admin address
   * 3. Creation of VyFi liquidity pool in single transaction
   *
   * Transaction Flow:
   * - Inputs: Admin UTXOs (vault tokens + fees) + Dispatch UTXOs (ADA)
   * - Outputs: VyFi pool (tokens + ADA) + Admin change
   *
   *
   * @param vaultId - ID of the vault to process
   * @returns Transaction hash of submitted LP creation
   * @throws NotFoundException if claim not found
   * @throws Error if pool already exists or insufficient funds
   *
   */
  async createLiquidityPool(vaultId: string): Promise<{
    txHash: string;
  }> {
    const claim = await this.claimRepository.findOne({
      where: { vault: { id: vaultId }, type: ClaimType.LP, status: ClaimStatus.AVAILABLE },
      relations: ['vault'],
    });

    if (!claim) {
      throw new NotFoundException('Liquidity pool claim not found');
    }

    // First check if pool exists
    const poolCheck = await this.checkPool({
      networkId: 0,
      tokenAUnit: `${claim.vault.script_hash}${claim.vault.asset_vault_name}`,
      tokenBUnit: 'lovelace',
    });

    if (poolCheck.exists) {
      throw new Error('Pool already exists');
    }

    if (!claim.vault?.dispatch_parametized_hash) {
      throw new Error('Vault does not have dispatch script configured');
    }

    const DISPATCH_ADDRESS = this.getDispatchAddress(claim.vault.dispatch_parametized_hash);
    // Get dispatch UTXOs to withdraw ADA from
    const dispatchUtxos = await this.blockfrost.addressesUtxos(DISPATCH_ADDRESS);
    if (!dispatchUtxos || dispatchUtxos.length === 0) {
      throw new Error('No UTXOs found at dispatch address');
    }

    // Calculate total available ADA from dispatch script
    let totalDispatchAda = 0;
    const validDispatchUtxos: any[] = [];

    for (const utxo of dispatchUtxos) {
      const adaAmount = parseInt(utxo.amount.find(a => a.unit === 'lovelace')?.quantity || '0');
      if (adaAmount > 0) {
        totalDispatchAda += adaAmount;
        validDispatchUtxos.push(utxo);
      }
    }

    // Calculate required ADA for LP creation
    const requiredLpAda = Number(claim.metadata?.adaAmount || 0);

    if (totalDispatchAda < requiredLpAda) {
      throw new Error(
        `Insufficient ADA in dispatch script. Need ${requiredLpAda} lovelace, but only ${totalDispatchAda} available`
      );
    }

    // Generate metadata
    const metadataText = this.formatMetadataText(
      {
        policyId: claim.vault.script_hash,
        assetName: claim.vault.asset_vault_name,
      },
      claim.vault.vault_token_ticker
    );

    // Get admin UTXOs (for transaction fees and vault tokens)
    const { utxos: adminUtxos, requiredInputs } = await getUtxosExtract(
      Address.from_bech32(this.adminAddress),
      this.blockfrost,
      {
        targetTokenAmount: +claim.amount,
        targetToken: `${claim.vault.script_hash}${claim.vault.asset_vault_name}`,
      }
    );

    if (adminUtxos.length === 0) {
      throw new Error('No admin UTXOs found.');
    }

    // Build combined transaction
    const input = {
      changeAddress: this.adminAddress,
      message: metadataText,
      utxos: adminUtxos,
      preloadedScripts: [claim.vault.dispatch_preloaded_script.preloadedScript],
      scriptInteractions: [
        // Withdraw from all dispatch UTXOs
        ...validDispatchUtxos.map(utxo => ({
          purpose: 'spend',
          hash: claim.vault.dispatch_parametized_hash,
          outputRef: {
            txHash: utxo.tx_hash,
            index: utxo.output_index,
          },
          redeemer: {
            type: 'json',
            value: null,
          },
        })),
        // Withdraw rewards from dispatch script
        {
          purpose: 'withdraw',
          hash: claim.vault.dispatch_parametized_hash,
          redeemer: {
            type: 'json',
            value: null,
          },
        },
      ],
      outputs: [
        // Send tokens + ADA to VyFi pool FROM ADMIN
        {
          address: VYFI_CONSTANTS.POOL_ADDRESS,
          assets: [
            {
              assetName: { name: claim.vault.asset_vault_name, format: 'hex' },
              policyId: claim.vault.script_hash,
              quantity: +claim.amount,
            },
          ],
          lovelace: VYFI_CONSTANTS.TOTAL_REQUIRED_ADA + requiredLpAda, // Use exact required amount
        },
        // If there's leftover ADA after LP creation, keep it in admin
        ...(totalDispatchAda > requiredLpAda
          ? [
              {
                address: this.adminAddress,
                lovelace: totalDispatchAda - requiredLpAda,
              },
            ]
          : []),
      ],
      metadata: {
        [674]: metadataText,
      },
      requiredSigners: [this.adminHash],
      requiredInputs, // For vault tokens from admin
      referenceInputs: [
        {
          txHash: claim.vault.last_update_tx_hash,
          index: 0,
        },
      ],
      validityInterval: {
        start: true,
        end: true,
      },
      network: 'preprod',
    };

    const buildResponse = await this.blockchainService.buildTransaction(input);
    const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
    txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

    // Submit the transaction
    const submitResponse = await this.blockchainService.submitTransaction({
      transaction: txToSubmitOnChain.to_hex(),
      signatures: [],
    });

    await this.claimRepository.update({ id: claim.id }, { status: ClaimStatus.CLAIMED });

    return {
      txHash: submitResponse.txHash,
    };
  }

  private formatMetadataText(tokenA: { policyId?: string; assetName: string }, ticker: string): string {
    const tokenAUnit = tokenA.policyId ? `${tokenA.policyId}.${tokenA.assetName}` : 'lovelace';
    return `L4VA: LP Factory Create Pool Order Request -- /${tokenAUnit} --- ADA/${ticker}`;
  }

  private getDispatchAddress(scriptHash: string): string {
    return EnterpriseAddress.new(0, Credential.from_scripthash(ScriptHash.from_hex(scriptHash)))
      .to_address()
      .to_bech32();
  }

  // Original TX with only creating LP
  // async createLiquidityPool(claimId: string): Promise<{
  //   txHash: string;
  // }> {
  //   const claim = await this.claimRepository.findOne({
  //     where: { id: claimId, type: ClaimType.LP, status: ClaimStatus.AVAILABLE },
  //     relations: ['vault'],
  //   });

  //   if (!claim) {
  //     throw new NotFoundException('Liquidity pool claim not found');
  //   }

  //   // First check if pool exists
  //   const poolCheck = await this.checkPool({
  //     networkId: 0,
  //     tokenAUnit: `${claim.vault.script_hash}${claim.vault.asset_vault_name}`,
  //     tokenBUnit: 'lovelace',
  //   });

  //   if (poolCheck.exists) {
  //     throw new Error('Pool already exists');
  //   }

  //   // Generate metadata
  //   const metadataText = this.formatMetadataText(
  //     {
  //       policyId: claim.vault.script_hash,
  //       assetName: claim.vault.asset_vault_name,
  //     },
  //     claim.vault.vault_token_ticker
  //   );

  //   // Get UTxOs
  //   const { utxos: adminUtxos, requiredInputs } = await getUtxosExtract(
  //     Address.from_bech32(this.adminAddress),
  //     this.blockfrost,
  //     {
  //       targetTokenAmount: +claim.amount,
  //       targetToken: `${claim.vault.script_hash}${claim.vault.asset_vault_name}`,
  //     }
  //   );

  //   if (adminUtxos.length === 0) {
  //     throw new Error('No UTXOs found.');
  //   }

  //   // Construct transaction input with proper ADA amounts
  //   const input = {
  //     changeAddress: this.adminAddress,
  //     message: metadataText,
  //     utxos: adminUtxos,
  //     outputs: [
  //       {
  //         address: VYFI_CONSTANTS.POOL_ADDRESS,
  //         assets: [
  //           {
  //             assetName: { name: claim.vault.asset_vault_name, format: 'hex' },
  //             policyId: claim.vault.script_hash,
  //             quantity: +claim.amount,
  //           },
  //         ],
  //         lovelace: VYFI_CONSTANTS.TOTAL_REQUIRED_ADA + Number(claim.metadata?.adaAmount || 0),
  //       },
  //     ],
  //     metadata: {
  //       [674]: metadataText,
  //     },
  //     requiredSigners: [this.adminHash],
  //     requiredInputs,
  //   };

  //   const buildResponse = await this.blockchainService.buildTransaction(input);
  //   const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
  //   txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

  //   // Submit the transaction
  //   const submitResponse = await this.blockchainService.submitTransaction({
  //     transaction: txToSubmitOnChain.to_hex(),
  //     signatures: [],
  //   });

  //   return {
  //     txHash: submitResponse.txHash,
  //   };
  // }
}
