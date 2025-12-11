import { Buffer } from 'node:buffer';

import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { FixedTransaction, PrivateKey, Address } from '@emurgo/cardano-serialization-lib-nodejs';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TransactionsService } from '../offchain-tx/transactions.service';

import { BlockchainService } from './blockchain.service';
import { SubmitTransactionDto } from './dto/transaction.dto';
import { ValidityIntervalException } from './exceptions/validity-interval.exception';
import { BuildTransactionParams, TransactionSubmitResponse } from './types/transaction-status.enum';
import { Redeemer } from './types/type';
import { getUtxosExtract } from './utils/lib';

import { Vault } from '@/database/vault.entity';
import { ContributionInput } from '@/modules/distribution/distribution.types';
import { TransactionStatus } from '@/types/transaction.types';

// Acquire and Contribution

@Injectable()
export class VaultContributionService {
  private readonly logger = new Logger(VaultContributionService.name);
  private readonly FLAT_FEE: number;
  private readonly feeAddress: string;
  private readonly adminAddress: string;
  private readonly adminHash: string;
  private readonly adminSKey: string;
  private readonly isMainnet: boolean;

  private blockfrost: BlockFrostAPI;
  constructor(
    @InjectRepository(Vault)
    private readonly vaultsRepository: Repository<Vault>,
    private readonly transactionsService: TransactionsService,
    private readonly configService: ConfigService,
    @Inject(BlockchainService)
    private readonly blockchainService: BlockchainService
  ) {
    this.adminAddress = this.configService.get<string>('ADMIN_ADDRESS');
    this.adminHash = this.configService.get<string>('ADMIN_KEY_HASH');
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');
    this.feeAddress = this.configService.get<string>('FEE_ADDRESS');
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
    this.FLAT_FEE = Number(this.configService.get<string>('PROTOCOL_FLAT_FEE'));
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_API_KEY'),
    });
  }

  async buildContributionTransaction(params: BuildTransactionParams): Promise<{
    presignedTx: string;
  }> {
    try {
      // Validate that the transaction exists and get its current state
      const transaction = await this.transactionsService.validateTransactionExists(params.txId);

      const vault = await this.vaultsRepository.findOne({
        where: {
          id: transaction.vault_id,
        },
      });

      if (!vault.publication_hash) {
        throw new Error('Vault publication hash not found - vault may not be properly published');
      }

      if (!vault.script_hash) {
        throw new Error('Vault script hash is missing - vault may not be properly configured');
      }

      const VAULT_ID = vault.asset_vault_name;
      const CONTRIBUTION_SCRIPT_HASH = vault.script_hash;
      const LAST_UPDATE_TX_HASH = vault.publication_hash;
      const LAST_UPDATE_TX_INDEX = 0;
      const isAda = params.outputs[0].assets[0].assetName === 'lovelace';

      let quantity = 0;
      let assetsList = [];
      let requiredInputs: string[] = [];
      let allUtxos: string[] = [];

      // Determine what tokens the user is contributing
      if (isAda) {
        quantity = params.outputs[0].assets[0].quantity * 1000000;

        // For ADA contributions, we just need UTXOs with sufficient ADA + minimum for fees
        const { utxos, totalAdaCollected } = await getUtxosExtract(
          Address.from_bech32(params.changeAddress),
          this.blockfrost,
          {
            validateUtxos: false,
            maxUtxos: 200,
          }
        );

        if (totalAdaCollected < quantity + 2_000_000) {
          throw new Error(
            `Insufficient ADA in UTXOs to cover contribution amount and fees - required: ${quantity + 2_000_000}, available: ${totalAdaCollected}`
          );
        }
        // For ADA, any UTXO with sufficient balance works
        allUtxos = utxos;
      } else {
        // For NFT/Token contributions, collect all assets in one call
        const targetAssets = params.outputs[0].assets.map(asset => ({
          token: `${asset.policyId}${asset.assetName}`,
          amount: asset.quantity,
        }));

        const { filteredUtxos, requiredInputs: tokenUtxos } = await getUtxosExtract(
          Address.from_bech32(params.changeAddress),
          this.blockfrost,
          {
            targetAssets,
            validateUtxos: false,
            minAda: 1000000,
            filterByAda: 4_000_000,
          }
        );

        // Set required inputs and all available UTXOs
        requiredInputs = tokenUtxos;
        allUtxos = filteredUtxos;

        // Format assets for the transaction output
        assetsList = params.outputs[0].assets.map(asset => ({
          assetName: { name: asset.assetName, format: 'hex' },
          policyId: asset.policyId,
          quantity: asset.quantity,
        }));
      }

      const input: ContributionInput = {
        changeAddress: params.changeAddress,
        message: 'Asset(s) contributed to vault',
        utxos: allUtxos, // All available UTXOs for selection
        mint: [
          {
            version: 'cip25',
            assetName: { name: 'receipt', format: 'utf8' },
            policyId: CONTRIBUTION_SCRIPT_HASH,
            type: 'plutus',
            quantity: 1, // Mint 1 receipt token
            metadata: {},
          },
        ],
        scriptInteractions: [
          {
            purpose: 'mint',
            hash: CONTRIBUTION_SCRIPT_HASH,
            redeemer: {
              type: 'json',
              value: {
                output_index: 0,
                contribution: isAda ? 'Lovelace' : 'Asset',
              } satisfies Redeemer,
            },
          },
        ],
        outputs: [
          {
            address: vault.contract_address,
            lovelace: isAda ? (quantity > 0 ? quantity : 10000000) : undefined,
            assets: isAda
              ? [
                  {
                    assetName: { name: 'receipt', format: 'utf8' },
                    policyId: CONTRIBUTION_SCRIPT_HASH,
                    quantity: 1,
                  },
                ]
              : [
                  {
                    assetName: { name: 'receipt', format: 'utf8' },
                    policyId: CONTRIBUTION_SCRIPT_HASH,
                    quantity: 1,
                  },
                  ...assetsList,
                ],
            datum: {
              type: 'inline',
              value: {
                policy_id: CONTRIBUTION_SCRIPT_HASH,
                asset_name: VAULT_ID,
                owner: params.changeAddress,
              },
              shape: {
                validatorHash: CONTRIBUTION_SCRIPT_HASH,
                purpose: 'spend',
              },
            },
          },
          // Flat Fee
          {
            address: this.adminAddress,
            lovelace: this.FLAT_FEE,
          },
          // Protocol Fee
          // ...(transaction.fee > 0
          //   ? [
          //       {
          //         address: this.feeAddress, // Fee address
          //         lovelace: transaction.fee,
          //       },
          //     ]
          //   : []),
        ],
        requiredSigners: [this.adminHash],
        requiredInputs, // Add the required inputs here
        referenceInputs: [
          {
            txHash: LAST_UPDATE_TX_HASH,
            index: LAST_UPDATE_TX_INDEX,
          },
        ],
        validityInterval: {
          start: true,
          end: true,
        },
        network: this.isMainnet ? 'mainnet' : 'preprod',
      };

      // Build the transaction using BlockchainService
      const buildResponse = await this.blockchainService.buildTransaction(input);

      // Sign the transaction
      const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
      txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

      return {
        presignedTx: txToSubmitOnChain.to_hex(),
      };
    } catch (error) {
      await this.transactionsService.updateTransactionStatusById(params.txId, TransactionStatus.failed);
      throw error;
    }
  }

  /**
   * Submit a signed transaction to the blockchain
   * @param signedTx Object containing the transaction and signatures
   * @returns Transaction hash
   */
  async submitContributionTransaction(signedTx: SubmitTransactionDto): Promise<TransactionSubmitResponse> {
    if (!signedTx.txId) {
      throw new Error('Contribution transaction ID is required');
    }

    if (!signedTx.transaction) {
      throw new Error('Contribution transaction data is required');
    }

    try {
      // Submit the transaction using BlockchainService
      const result = await this.blockchainService.submitTransaction({
        transaction: signedTx.transaction,
        signatures: signedTx.signatures || [],
      });

      if (!result.txHash) {
        throw new Error('No transaction hash returned from blockchain submission');
      }

      await this.transactionsService.createAssets(signedTx.txId);
      await this.transactionsService.updateTransactionHash(signedTx.txId, result.txHash);
      return { txHash: result.txHash };
    } catch (error) {
      this.logger.error('Error submitting transaction', error);
      await this.transactionsService.updateTransactionStatusById(signedTx.txId, TransactionStatus.failed);
      if (error instanceof ValidityIntervalException) {
        throw error;
      }
      throw new Error(`Failed to submit contribution transaction: ${error.message}`);
    }
  }
}
