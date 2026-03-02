import { Buffer } from 'node:buffer';

import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { FixedTransaction, PrivateKey, Address } from '@emurgo/cardano-serialization-lib-nodejs';
import { BadRequestException, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TransactionsService } from '../offchain-tx/transactions.service';

import { BlockchainService } from './blockchain.service';
import { SubmitTransactionDto } from './dto/transaction.dto';
import { InsufficientAssetsException } from './exceptions/insufficient-assets.exception';
import { UTxOInsufficientException } from './exceptions/utxo-insufficient.exception';
import { UtxoSpentException } from './exceptions/utxo-spent.exception';
import { ValidityIntervalException } from './exceptions/validity-interval.exception';
import { ValueNotConservedException } from './exceptions/value-not-conserved.exception';
import { BuildTransactionParams, TransactionSubmitResponse } from './types/transaction-status.enum';
import { Redeemer } from './types/type';
import { getUtxosExtract } from './utils/lib';

import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { ContributionInput } from '@/modules/distribution/distribution.types';
import { TransactionStatus } from '@/types/transaction.types';

// Acquire and Contribution

@Injectable()
export class VaultContributionService {
  private readonly logger = new Logger(VaultContributionService.name);
  private readonly adminAddress: string;
  private readonly adminHash: string;
  private readonly adminSKey: string;
  private readonly isMainnet: boolean;

  private blockfrost: BlockFrostAPI;
  constructor(
    @InjectRepository(Vault)
    private readonly vaultsRepository: Repository<Vault>,
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    private readonly transactionsService: TransactionsService,
    private readonly configService: ConfigService,
    @Inject(BlockchainService)
    private readonly blockchainService: BlockchainService
  ) {
    this.adminAddress = this.configService.get<string>('ADMIN_ADDRESS');
    this.adminHash = this.configService.get<string>('ADMIN_KEY_HASH');
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
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

      // Security check: Verify the changeAddress matches the transaction creator's address
      const transactionWithUser = await this.transactionRepository.findOne({
        where: { id: params.txId },
        relations: ['user'],
        select: {
          id: true,
          user: {
            id: true,
            address: true,
          },
        },
      });

      if (!transactionWithUser?.user?.address) {
        throw new BadRequestException('Transaction user address not found');
      }

      if (transactionWithUser.user.address !== params.changeAddress) {
        this.logger.warn(
          `Address mismatch for transaction ${params.txId}: ` +
            `User address: ${transactionWithUser.user.address}, ` +
            `Change address: ${params.changeAddress}`
        );
        throw new UnauthorizedException(
          'Change address does not match the transaction creator address. ' +
            'Please ensure you are using the correct wallet.'
        );
      }

      const vault = await this.vaultsRepository.findOne({
        where: {
          id: transaction.vault_id,
        },
      });

      if (!vault.last_update_tx_hash) {
        throw new BadRequestException(
          'Vault last update transaction hash not found - vault may not be properly published'
        );
      }

      if (!vault.script_hash) {
        throw new BadRequestException('Vault script hash is missing - vault may not be properly configured');
      }

      const VAULT_ID = vault.asset_vault_name;
      const CONTRIBUTION_SCRIPT_HASH = vault.script_hash;
      const LAST_UPDATE_TX_HASH = vault.last_update_tx_hash;
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
          throw new BadRequestException(
            `Insufficient ADA in UTXOs to cover contribution amount and fees - required: ${(quantity + 2_000_000) / 1_000_000} ADA, available: ${totalAdaCollected / 1_000_000} ADA`
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
        message: `${isAda ? `${quantity / 1000000} ADA acquired` : `${params.outputs[0].assets.length} Asset(s) contributed`} to vault`,
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
          // Protocol Fee
          ...(transaction.fee > 0
            ? [
                {
                  address: this.adminAddress,
                  lovelace: transaction.fee,
                },
              ]
            : []),
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

      // Handle UTxO Insufficient error - not enough ADA to build transaction
      if (error instanceof UTxOInsufficientException) {
        throw new UTxOInsufficientException(error['requiredLovelace']);
      }

      // Handle insufficient assets error with user-friendly message
      if (error.message && error.message.includes('Insufficient assets found')) {
        // Extract the "Missing: ..." part from the error message
        const missingPart = error.message.replace('Insufficient assets found. ', '');
        throw new InsufficientAssetsException(
          missingPart,
          'You do not have the required assets in your wallet to complete this transaction. ' +
            'Please ensure all selected assets are still in your wallet and try again.'
        );
      }

      throw error;
    }
  }

  /**
   * Submit a signed transaction to the blockchain
   * @param signedTx - Object containing the transaction and signatures
   * @returns Transaction hash
   */
  async submitContributionTransaction(signedTx: SubmitTransactionDto): Promise<TransactionSubmitResponse> {
    if (!signedTx.txId) {
      throw new BadRequestException('Contribution transaction ID is required');
    }

    if (!signedTx.transaction) {
      throw new BadRequestException('Contribution transaction data is required');
    }

    try {
      // Submit the transaction using BlockchainService
      const result = await this.blockchainService.submitTransaction({
        transaction: signedTx.transaction,
        signatures: signedTx.signatures || [],
      });

      if (!result.txHash) {
        throw new BadRequestException('No transaction hash returned from blockchain submission');
      }

      await this.transactionsService.createAssets(signedTx.txId);
      await this.transactionsService.updateTransactionHash(signedTx.txId, result.txHash);
      return { txHash: result.txHash };
    } catch (error) {
      this.logger.error('Error submitting transaction', error);
      await this.transactionsService.updateTransactionStatusById(signedTx.txId, TransactionStatus.failed);

      // Re-throw HTTP exceptions as-is (they contain proper status codes and messages)
      if (error instanceof ValidityIntervalException) {
        throw error;
      }

      if (error instanceof UtxoSpentException) {
        // Re-throw the exception with a user-friendly message
        throw new UtxoSpentException(
          error.txHash,
          error.outputIndex,
          'One or more of your wallet UTXOs were already spent in another transaction. ' +
            'Please refresh your wallet and try again.'
        );
      }

      if (error instanceof ValueNotConservedException) {
        // Re-throw the exception with a user-friendly message
        throw new ValueNotConservedException(
          error.supplied,
          error.expected,
          'Transaction value mismatch detected. This is likely a bug in the transaction builder. ' +
            'Please contact support with this transaction ID: ' +
            signedTx.txId
        );
      }

      throw new BadRequestException(`Failed to submit contribution transaction: ${error.message}`);
    }
  }
}
