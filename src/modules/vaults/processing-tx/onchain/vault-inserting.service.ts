import { Buffer } from 'node:buffer';

import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { FixedTransaction, PrivateKey, Address } from '@emurgo/cardano-serialization-lib-nodejs';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TransactionsService } from '../offchain-tx/transactions.service';

import { BlockchainScannerService } from './blockchain-scanner.service';
import { BlockchainService } from './blockchain.service';
import { SubmitTransactionDto } from './dto/transaction.dto';
import { BlockchainWebhookDto } from './dto/webhook.dto';
import { ValidityIntervalException } from './exceptions/validity-interval.exception';
import { OnchainTransactionStatus } from './types/transaction-status.enum';
import { Redeemer } from './types/type';
import { getUtxosExtract } from './utils/lib';

import { Vault } from '@/database/vault.entity';
import { ContributionInput } from '@/modules/distribution/distribution.types';
import { TransactionStatus } from '@/types/transaction.types';

// Acquire and Contribution

export interface NftAsset {
  policyId: string;
  assetName: string;
  quantity: number;
}

export interface BuildTransactionOutput {
  address?: string;
  lovelace?: number;
  assets?: NftAsset[];
}

export interface BuildTransactionParams {
  changeAddress: string;
  txId: string;
  outputs: BuildTransactionOutput[];
}

export interface SubmitTransactionParams {
  transaction: string; // CBOR encoded transaction
  vaultId: string;
  signatures?: string[]; // Optional array of signatures
}

export interface TransactionBuildResponse {
  hash: string;
  complete: string; // CBOR encoded complete transaction
  stripped: string; // CBOR encoded stripped transaction
  witnessSet: string; // CBOR encoded witness set
}

export interface TransactionSubmitResponse {
  txHash: string;
}

@Injectable()
export class VaultInsertingService {
  private readonly logger = new Logger(VaultInsertingService.name);
  private readonly FLAT_FEE: number;
  private readonly feeAddress: string;
  private readonly adminAddress: string;
  private readonly adminHash: string;
  private readonly adminSKey: string;
  private blockfrost: BlockFrostAPI;
  constructor(
    @InjectRepository(Vault)
    private readonly vaultsRepository: Repository<Vault>,
    private readonly transactionsService: TransactionsService,
    private readonly blockchainScanner: BlockchainScannerService,
    private readonly configService: ConfigService,
    @Inject(BlockchainService)
    private readonly blockchainService: BlockchainService
  ) {
    this.adminAddress = this.configService.get<string>('ADMIN_ADDRESS');
    this.adminHash = this.configService.get<string>('ADMIN_KEY_HASH');
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');
    this.feeAddress = this.configService.get<string>('FEE_ADDRESS');
    this.FLAT_FEE = this.configService.get<number>('PROTOCOL_FLAT_FEE');
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_TESTNET_API_KEY'),
    });
  }

  async buildTransaction(params: BuildTransactionParams): Promise<{
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
        const { utxos } = await getUtxosExtract(Address.from_bech32(params.changeAddress), this.blockfrost, {
          minAda: 6000000,
        });

        if (utxos.length === 0) {
          throw new Error(`No UTXOs found with at least 6 ADA.`);
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

        if (!tokenUtxos || tokenUtxos.length === 0) {
          throw new Error('No UTXOs found containing required tokens');
        }

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
          //         lovelace: transaction.fee * 1000000,
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
        network: 'preprod',
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

      if (error instanceof NotFoundException) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }

  /**
   * Submit a signed transaction to the blockchain
   * @param signedTx Object containing the transaction and signatures
   * @returns Transaction hash
   */
  async submitTransaction(signedTx: SubmitTransactionDto): Promise<TransactionSubmitResponse> {
    if (!signedTx.txId) {
      throw new Error('Transaction ID is required');
    }

    if (!signedTx.transaction) {
      throw new Error('Transaction data is required');
    }

    try {
      this.logger.log(`Submitting transaction ${signedTx.txId} to blockchain`);

      // Submit the transaction using BlockchainService
      const result = await this.blockchainService.submitTransaction({
        transaction: signedTx.transaction,
        signatures: signedTx.signatures || [],
      });

      try {
        // Update the transaction hash in our database
        await this.transactionsService.createAssets(signedTx.txId);
        await this.transactionsService.updateTransactionHash(signedTx.txId, result.txHash);
        this.logger.log(`Successfully updated transaction ${signedTx.txId} with hash ${result.txHash}`);

        // Update monitoring for the vault if it exists
        if (signedTx.vaultId) {
          const vault = await this.vaultsRepository.findOne({
            where: { id: signedTx.vaultId },
            select: ['contract_address', 'name'],
          });

          if (!vault) {
            this.logger.warn(`Vault ${signedTx.vaultId} not found when updating monitoring address`);
          } else if (vault.contract_address) {
            await this.blockchainScanner.checkMonitoringAddress(vault.contract_address, vault.name);
          }
        }

        return { txHash: result.txHash };
      } catch (updateError) {
        await this.transactionsService.updateTransactionStatusById(signedTx.txId, TransactionStatus.failed);
        this.logger.error(
          `Failed to update transaction ${signedTx.txId} with hash ${result.txHash}`,
          updateError.stack
        );
        throw new Error(`Transaction submitted but failed to update local record: ${updateError.message}`);
      }
    } catch (error) {
      this.logger.error('Error submitting transaction', error);
      await this.transactionsService.updateTransactionStatusById(signedTx.txId, TransactionStatus.failed);
      if (error instanceof ValidityIntervalException) {
        throw error;
      }
      throw new Error(`Failed to submit transaction: ${error.message}`);
    }
  }

  async handleScannerEvent(event: any): Promise<void> {
    // Determine transaction status based on blockchain data
    const tx = event.data.tx;
    let status: OnchainTransactionStatus;
    if (!tx.block || !tx.block_height) {
      status = OnchainTransactionStatus.PENDING;
    } else if (tx.valid_contract === false) {
      status = OnchainTransactionStatus.FAILED;
    } else if (tx.valid_contract === true) {
      status = OnchainTransactionStatus.CONFIRMED;
    } else {
      status = OnchainTransactionStatus.PENDING;
    }

    // Map onchain status to internal transaction status
    const statusMap: Record<OnchainTransactionStatus, TransactionStatus> = {
      [OnchainTransactionStatus.PENDING]: TransactionStatus.pending,
      [OnchainTransactionStatus.CONFIRMED]: TransactionStatus.confirmed,
      [OnchainTransactionStatus.FAILED]: TransactionStatus.failed,
      [OnchainTransactionStatus.NOT_FOUND]: TransactionStatus.stuck,
    };

    const internalStatus = statusMap[status];
    const txIndex = typeof tx.index !== 'undefined' ? tx.index : 0;
    await this.transactionsService.updateTransactionStatus(tx.hash, txIndex, internalStatus);
  }

  async handleBlockchainEvent(event: BlockchainWebhookDto): Promise<void> {
    // Only handle transaction events
    if (event.type !== 'transaction') {
      return;
    }

    // Process each transaction in the payload
    for (const txEvent of event.payload) {
      const { tx, inputs, outputs } = txEvent;

      // Determine transaction status based on blockchain data
      let status: OnchainTransactionStatus;
      if (!tx.block || !tx.block_height) {
        status = OnchainTransactionStatus.PENDING;
      } else if (tx.valid_contract === false) {
        status = OnchainTransactionStatus.FAILED;
      } else if (tx.valid_contract === true) {
        status = OnchainTransactionStatus.CONFIRMED;
      } else {
        status = OnchainTransactionStatus.PENDING;
      }

      // Map onchain status to internal transaction status
      const statusMap: Record<OnchainTransactionStatus, TransactionStatus> = {
        [OnchainTransactionStatus.PENDING]: TransactionStatus.pending,
        [OnchainTransactionStatus.CONFIRMED]: TransactionStatus.confirmed,
        [OnchainTransactionStatus.FAILED]: TransactionStatus.failed,
        [OnchainTransactionStatus.NOT_FOUND]: TransactionStatus.stuck,
      };

      // Update transaction status
      const internalStatus = statusMap[status];
      await this.transactionsService.updateTransactionStatus(tx.hash, tx.index, internalStatus);

      // For confirmed transactions, analyze the transfer
      if (status === OnchainTransactionStatus.CONFIRMED) {
        const transferDetails = {
          txHash: tx.hash,
          blockHeight: tx.block_height,
          timestamp: tx.block_time,
          fee: tx.fees,
          sender: inputs[0]?.address, // Usually the first input is the sender
          transfers: [],
        };

        // Analyze each output
        for (const output of outputs) {
          const { address, amount } = output;

          // Skip change outputs (outputs back to sender)
          if (address === transferDetails.sender) {
            continue;
          }

          // Process each asset in the output
          for (const asset of amount) {
            if (asset.unit === 'lovelace') {
              // ADA transfer
              transferDetails.transfers.push({
                type: 'ADA',
                recipient: address,
                amount: (parseInt(asset.quantity) / 1_000_000).toString(), // Convert lovelace to ADA
                unit: 'ADA',
              });
            } else if (asset.quantity === '1') {
              // NFT transfer
              transferDetails.transfers.push({
                type: 'NFT',
                recipient: address,
                policyId: asset.unit.slice(0, 56),
                assetName: asset.unit.slice(56),
                unit: asset.unit,
              });
            } else {
              // Other token transfer
              transferDetails.transfers.push({
                type: 'TOKEN',
                recipient: address,
                amount: asset.quantity,
                unit: asset.unit,
              });
            }
          }
        }

        // Log transfer details
        // console.log('Transaction details:', JSON.stringify(transferDetails, null, 2));
      }
    }
  }
}
