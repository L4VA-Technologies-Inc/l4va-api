import { Buffer } from 'node:buffer';

import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import {
  EnterpriseAddress,
  ScriptHash,
  Credential,
  FixedTransaction,
  PrivateKey,
} from '@emurgo/cardano-serialization-lib-nodejs';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, Not, IsNull, MoreThan } from 'typeorm';

import { AssetsService } from '../vaults/processing-tx/assets/assets.service';
import { BlockchainService } from '../vaults/processing-tx/onchain/blockchain.service';
import { generate_tag_from_txhash_index } from '../vaults/processing-tx/onchain/utils/lib';

import { Asset } from '@/database/asset.entity';
import { Claim } from '@/database/claim.entity';
import { Transaction } from '@/database/transaction.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { ClaimStatus, ClaimType } from '@/types/claim.types';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';
import { VaultStatus, SmartContractVaultStatus } from '@/types/vault.types';

interface ExtractInput {
  changeAddress: string;
  message: string;
  mint?: Array<object>;
  scriptInteractions: object[];
  outputs: {
    address: string;
    assets?: object[];
    lovelace?: number;
    datum?: { type: 'inline'; value: any; shape?: object };
  }[];
  requiredSigners: string[];
  referenceInputs: { txHash: string; index: number }[];
  validityInterval: {
    start: boolean;
    end: boolean;
  };
  network: string;
}

interface PayAdaContributionInput {
  changeAddress: string;
  message: string;
  scriptInteractions: object[];
  mint?: Array<object>;
  outputs: {
    address: string;
    assets?: object[];
    lovelace?: number;
    datum?: { type: 'inline'; value: any; shape?: object };
  }[];
  requiredSigners: string[];
  referenceInputs: { txHash: string; index: number }[];
  validityInterval: {
    start: boolean;
    end: boolean;
  };
  network: string;
  preloadedScripts?: any;
}

@Injectable()
export class AutomatedDistributionService {
  private readonly logger = new Logger(AutomatedDistributionService.name);
  private readonly adminHash: string;
  private readonly SC_POLICY_ID: string;
  private readonly adminSKey: string;
  private readonly adminAddress: string;
  private readonly unparametizedDispatchHash: string;
  private readonly blockfrost: BlockFrostAPI;

  constructor(
    @InjectRepository(Claim)
    private readonly claimRepository: Repository<Claim>,
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
    private readonly configService: ConfigService,
    private readonly blockchainService: BlockchainService,
    private readonly assetService: AssetsService
  ) {
    this.unparametizedDispatchHash = this.configService.get<string>('DISPATCH_SCRIPT_HASH');
    this.adminHash = this.configService.get<string>('ADMIN_KEY_HASH');
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');
    this.SC_POLICY_ID = this.configService.get<string>('SC_POLICY_ID');
    this.adminAddress = this.configService.get<string>('ADMIN_ADDRESS');
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_TESTNET_API_KEY'),
    });
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async processDistributionQueue(): Promise<void> {
    this.logger.debug('Processing distribution queue...');

    // 1. Find vaults ready for extraction
    await this.processReadyVaults();

    // 2.1 Process extractions for acquirer claims
    //2.2 Register Script Stake
    await this.processExtractionTransactions();
  }

  private async processReadyVaults(): Promise<void> {
    const readyVaults = await this.vaultRepository.find({
      where: {
        vault_status: VaultStatus.locked,
        vault_sc_status: SmartContractVaultStatus.SUCCESSFUL,
        last_update_tx_hash: Not(IsNull()),
        distribution_processed: false,
        created_at: MoreThan(new Date('2025-10-22').toISOString()),
      },
      select: ['id'],
    });

    for (const vault of readyVaults) {
      try {
        this.logger.log(`Processing vault ${vault.id} for distribution`);

        await this.vaultRepository.update({ id: vault.id }, { distribution_in_progress: true }); // Mark as processing to prevent duplicate processing

        await this.extractLovelaceForClaims(vault.id); // Queue extraction transactions for acquirer claims
        this.logger.log(`Extraction transactions queued for vault ${vault.id}`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      } catch (error) {
        this.logger.error(`Error processing vault ${vault.id}:`, error);
      }
    }
  }

  private async extractLovelaceForClaims(vaultId: string): Promise<void> {
    const claims = await this.claimRepository.find({
      where: {
        vault: { id: vaultId },
        type: ClaimType.ACQUIRER,
        status: ClaimStatus.PENDING,
        created_at: MoreThan(new Date('2025-10-22').toISOString()),
      },
      relations: ['transaction', 'user'],
    });

    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      select: ['id', 'script_hash', 'asset_vault_name', 'ada_pair_multiplier', 'last_update_tx_hash'],
    });
    if (!vault) {
      throw new Error(`Vault ${vaultId} not found`);
    }

    this.logger.log(`Found ${claims.length} acquirer claims to extract for vault ${vaultId}`);

    const dispatchResult = await this.blockchainService.applyDispatchParameters({
      vault_policy: this.SC_POLICY_ID,
      vault_id: vault.asset_vault_name,
      contribution_script_hash: vault.script_hash,
    });

    for (const claim of claims) {
      const { user } = claim;

      const extractionTx = await this.transactionRepository.save({
        vault_id: vaultId,
        user_id: claim.user_id,
        type: TransactionType.extractDispatch,
        status: TransactionStatus.created,
      });

      this.logger.debug(`Extracting lovelace for claim ${claim.id}, transaction ${claim.transaction_id}`);

      const PARAMETERIZED_DISPATCH_HASH = dispatchResult.parameterizedHash;
      const DISPATCH_ADDRESS = this.getDispatchAddress(PARAMETERIZED_DISPATCH_HASH);

      this.logger.debug(DISPATCH_ADDRESS);

      // Get the original acquire transaction
      const originalTx = claim.transaction;
      if (!originalTx || !originalTx.tx_hash) {
        throw new Error(`Original transaction not found for claim`);
      }

      const datumTag = generate_tag_from_txhash_index(originalTx.tx_hash, Number(0));
      const adaPairMultiplier = Number(vault.ada_pair_multiplier);
      const claimMultiplier = Number(claim.metadata.multiplier);
      const originalAmount = Number(originalTx.amount);
      const totalMultiplier = adaPairMultiplier + claimMultiplier;
      const mintQuantity = totalMultiplier * (originalAmount * 1_000_000 || 0);

      const SC_ADDRESS = EnterpriseAddress.new(0, Credential.from_scripthash(ScriptHash.from_hex(vault.script_hash)))
        .to_address()
        .to_bech32();

      const input: ExtractInput = {
        changeAddress: this.adminAddress,
        message: `Extract ADA for claims`,
        scriptInteractions: [
          {
            purpose: 'spend',
            hash: vault.script_hash,
            outputRef: {
              txHash: originalTx.tx_hash,
              index: 0,
            },
            redeemer: {
              type: 'json',
              value: {
                __variant: 'ExtractAda',
                __data: {
                  vault_token_output_index: 0,
                },
              },
            },
          },
          {
            purpose: 'mint',
            hash: vault.script_hash,
            redeemer: {
              type: 'json',
              value: 'MintVaultToken',
            },
          },
        ],
        mint: [
          {
            version: 'cip25',
            assetName: { name: vault.asset_vault_name, format: 'hex' },
            policyId: vault.script_hash,
            type: 'plutus',
            quantity: mintQuantity, //For single extraction, here is amount to mint ( vault.ada_pair_multiplier + claim.metadata.multiplier ('multiplier from tx I extract')) * LOVELACE Amount
            metadata: {},
          },
          {
            version: 'cip25',
            assetName: { name: 'receipt', format: 'utf8' },
            policyId: vault.script_hash,
            type: 'plutus',
            quantity: -1,
            metadata: {},
          },
        ],
        outputs: [
          {
            address: user.address,
            assets: [
              {
                assetName: { name: vault.asset_vault_name, format: 'hex' },
                policyId: vault.script_hash,
                quantity: claimMultiplier * (originalAmount * 1_000_000),
              },
            ],
            datum: {
              type: 'inline',
              value: {
                datum_tag: datumTag,
                ada_paid: undefined,
              },
              shape: {
                validatorHash: this.unparametizedDispatchHash,
                purpose: 'spend',
              },
            },
          },
          {
            address: SC_ADDRESS, // VAULT address
            assets: [
              {
                assetName: { name: vault.asset_vault_name, format: 'hex' },
                policyId: vault.script_hash,
                quantity: adaPairMultiplier * originalAmount * 1_000_000,
              },
            ],
          },
          {
            address: DISPATCH_ADDRESS,
            lovelace: Number(originalTx.amount) * 1_000_000,
          },
        ],
        requiredSigners: [this.adminHash],
        referenceInputs: [
          {
            txHash: vault.last_update_tx_hash,
            index: 0,
          },
        ],
        validityInterval: {
          start: true,
          end: true,
        },
        network: 'preprod',
      };

      this.logger.debug(JSON.stringify(input));

      try {
        const buildResponse = await this.blockchainService.buildTransaction(input);

        const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
        txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

        const response = await this.blockchainService.submitTransaction({
          transaction: txToSubmitOnChain.to_hex(),
          signatures: [],
        });

        await this.claimRepository.update({ id: claim.id }, { status: ClaimStatus.CLAIMED });
        await this.assetService.distributeAssetByTransactionId(claim.transaction.id);

        // Update Extraction transaction with hash
        await this.transactionRepository.update(
          { id: extractionTx.id },
          { tx_hash: response.txHash, status: TransactionStatus.confirmed }
        );
        await new Promise(resolve => setTimeout(resolve, 30000));

        this.logger.debug(`Extraction transaction ${response.txHash} submitted for claim ${claim.id}`);
      } catch (error) {
        this.logger.error(`Failed to submit extraction transaction:`, error);

        // Mark transaction as failed
        await this.transactionRepository.update({ id: extractionTx.id }, { status: TransactionStatus.failed });
        await new Promise(resolve => setTimeout(resolve, 30000));
      }
    }
  }

  private async processExtractionTransactions(): Promise<void> {
    // Find confirmed extraction transactions
    const confirmedExtractions = await this.transactionRepository.find({
      where: {
        type: TransactionType.extractDispatch,
        status: TransactionStatus.confirmed,
      },
      relations: ['vault'],
    });

    if (confirmedExtractions.length === 0) {
      return;
    }

    // Group by vault for efficiency
    const vaultGroups = confirmedExtractions.reduce(
      (acc, tx) => {
        if (!acc[tx.vault_id]) acc[tx.vault_id] = [];
        acc[tx.vault_id].push(tx);
        return acc;
      },
      {} as Record<string, Transaction[]>
    );

    // Process each vault's extractions
    for (const [vaultId, transactions] of Object.entries(vaultGroups)) {
      try {
        // Mark transactions as processed
        await this.transactionRepository.update(
          { id: In(transactions.map(tx => tx.id)) },
          { status: TransactionStatus.confirmed }
        );

        // Check if all extractions for this vault are complete
        const pendingExtractions = await this.transactionRepository.count({
          where: {
            vault_id: vaultId,
            type: TransactionType.extractDispatch,
            status: Not(TransactionStatus.confirmed),
          },
        });

        if (pendingExtractions === 0) {
          this.logger.log(`All extractions complete for vault ${vaultId}`);

          // Get vault details
          const vault = await this.vaultRepository.findOne({
            where: { id: vaultId },
            select: ['id', 'script_hash', 'asset_vault_name', 'stake_registered'],
          });

          if (vault) {
            // Check if stake is already registered based on database flag
            if (vault.stake_registered) {
              this.logger.log(`Stake credential already marked as registered for vault ${vaultId}`);
              this.logger.debug(`Queueing payment transactions for vault ${vaultId}`);
              await this.queuePaymentTransactions(vaultId);
            } else {
              const dispatchResult = await this.blockchainService.applyDispatchParameters({
                vault_policy: this.SC_POLICY_ID,
                vault_id: vault.asset_vault_name,
                contribution_script_hash: vault.script_hash,
              });

              const stakeResult = await this.blockchainService.registerScriptStake(dispatchResult.parameterizedHash);

              if (stakeResult.success) {
                // Update the flag in database
                await this.vaultRepository.update({ id: vaultId }, { stake_registered: true });

                // Only wait if we just registered (not if it was already registered)
                if (!stakeResult.alreadyRegistered) {
                  await new Promise(resolve => setTimeout(resolve, 50000)); // 50 seconds
                }

                this.logger.debug(
                  `Stake credential ${stakeResult.alreadyRegistered ? 'was already' : 'has been'} registered for vault ${vaultId}`
                );
                this.logger.debug(`Queueing payment transactions for vault ${vaultId}`);
                await this.queuePaymentTransactions(vaultId);
              } else {
                this.logger.error(`Failed to register stake credential for vault ${vaultId}`);
              }
            }
          }
        }
      } catch (error) {
        this.logger.error(`Error processing extractions for vault ${vaultId}:`, error);
      }
    }
  }

  private async queuePaymentTransactions(vaultId: string): Promise<void> {
    const claims = await this.claimRepository.find({
      where: {
        vault: { id: vaultId },
        type: ClaimType.CONTRIBUTOR,
        status: ClaimStatus.PENDING,
      },
      relations: ['transaction', 'user'],
    });

    if (claims.length === 0) return;

    this.logger.log(`Found ${claims.length} contributor claims for payment in vault ${vaultId}`);

    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      select: ['id', 'script_hash', 'asset_vault_name', 'ada_pair_multiplier', 'last_update_tx_hash'],
    });

    if (!vault) {
      throw new Error(`Vault ${vaultId} not found`);
    }

    // Apply parameters to dispatch script
    const dispatchResult = await this.blockchainService.applyDispatchParameters({
      vault_policy: this.SC_POLICY_ID,
      vault_id: vault.asset_vault_name,
      contribution_script_hash: vault.script_hash,
    });

    for (const claim of claims) {
      try {
        // Get ADA amount from metadata
        const adaAmount = claim.metadata?.adaAmount;
        if (!adaAmount) {
          throw new Error(`Claim ${claim.id} missing ADA amount`);
        }

        // Create payment transaction record
        const transaction = await this.transactionRepository.save({
          vault_id: vaultId,
          user_id: claim.user_id,
          type: TransactionType.claim,
          status: TransactionStatus.pending,
          metadata: {
            claimId: claim.id,
            vtAmount: claim.amount,
            adaAmount,
          },
        });

        const PARAMETERIZED_DISPATCH_HASH = dispatchResult.parameterizedHash;
        const DISPATCH_ADDRESS = this.getDispatchAddress(PARAMETERIZED_DISPATCH_HASH);

        this.logger.debug(DISPATCH_ADDRESS);

        // Get original contribution transaction
        const originalTx = claim.transaction;
        if (!originalTx || !originalTx.tx_hash) {
          throw new Error(`Original transaction not found for claim ${claim.id}`);
        }

        const contributedAssets = await this.assetRepository.find({
          where: { transaction: { id: originalTx.id } },
        });

        // Format assets for the transaction output
        const contributionAssets: {
          assetName: { name: string; format: string };
          policyId: string;
          quantity: number;
        }[] = [];

        // Process each asset
        if (contributedAssets.length > 0) {
          for (const asset of contributedAssets) {
            contributionAssets.push({
              assetName: {
                name: asset.asset_id,
                format: 'hex', // Always use 'hex' format
              },
              policyId: asset.policy_id,
              quantity: Number(asset.quantity),
            });
          }
        }

        const contribTxUtxos = await this.blockfrost.txsUtxos(originalTx.tx_hash);
        this.logger.debug(JSON.stringify(contribTxUtxos));
        const contribOutput = contribTxUtxos.outputs[0];
        if (!contribOutput) {
          throw new Error('No contribution output found');
        }

        // Find a suitable UTXO at dispatch address with enough ADA
        const dispatchUtxos = await this.blockfrost.addressesUtxos(DISPATCH_ADDRESS);

        if (!dispatchUtxos || dispatchUtxos.length === 0) {
          throw new Error('No UTXOs found at dispatch address');
        }

        // Calculate total lovelace available in dispatch address
        const minRequired = adaAmount + 3_000_000; // Payment + minimum ADA
        let suitableUtxo = null;

        for (const utxo of dispatchUtxos) {
          const utxoLovelace = parseInt(utxo.amount.find(a => a.unit === 'lovelace')?.quantity || '0');

          if (utxoLovelace >= minRequired) {
            suitableUtxo = {
              tx_hash: utxo.tx_hash,
              output_index: utxo.output_index,
              amount: utxoLovelace.toString(),
            };
            break;
          }
        }

        if (!suitableUtxo) {
          throw new Error(
            `No dispatch UTXO found with sufficient ADA. Need at least ${minRequired} lovelace in a single UTxO`
          );
        }

        const actualRemainingDispatchLovelace = parseInt(suitableUtxo.amount) - adaAmount;

        // Validate the balance equation
        const balanceValid = parseInt(suitableUtxo.amount) >= actualRemainingDispatchLovelace + adaAmount;
        if (!balanceValid) {
          throw new Error(
            `Balance equation invalid: ${suitableUtxo.amount} < ${actualRemainingDispatchLovelace} + ${adaAmount}`
          );
        }

        const userAddress = claim.user?.address || (await this.getUserAddress(claim.user_id));
        const datumTag = generate_tag_from_txhash_index(originalTx.tx_hash, 0);

        const SC_ADDRESS = EnterpriseAddress.new(0, Credential.from_scripthash(ScriptHash.from_hex(vault.script_hash)))
          .to_address()
          .to_bech32();

        const input: PayAdaContributionInput = {
          changeAddress: this.adminAddress,
          message: `Pay ADA to contributor for claim ${claim.id}`,
          preloadedScripts: [dispatchResult.fullResponse.preloadedScript],
          scriptInteractions: [
            {
              purpose: 'spend',
              hash: PARAMETERIZED_DISPATCH_HASH,
              outputRef: {
                txHash: suitableUtxo.tx_hash,
                index: suitableUtxo.output_index,
              },
              redeemer: {
                type: 'json',
                value: null,
              },
            },
            {
              purpose: 'withdraw',
              hash: PARAMETERIZED_DISPATCH_HASH,
              redeemer: {
                type: 'json',
                value: null,
              },
            },
            {
              purpose: 'mint',
              hash: vault.script_hash,
              redeemer: {
                type: 'json',
                value: 'MintVaultToken',
              },
            },
            {
              purpose: 'spend',
              hash: vault.script_hash,
              outputRef: {
                txHash: originalTx.tx_hash,
                index: 0,
              },
              redeemer: {
                type: 'json',
                value: {
                  __variant: 'CollectVaultToken',
                  __data: {
                    vault_token_output_index: 0,
                    change_output_index: 1,
                  },
                },
              },
            },
          ],
          mint: [
            {
              version: 'cip25',
              assetName: { name: vault.asset_vault_name, format: 'hex' },
              policyId: vault.script_hash,
              type: 'plutus',
              quantity: Number(claim.amount),
              metadata: {},
            },
            {
              version: 'cip25',
              assetName: { name: 'receipt', format: 'utf8' },
              policyId: vault.script_hash,
              type: 'plutus',
              quantity: -1,
              metadata: {},
            },
          ],
          outputs: [
            {
              address: userAddress,
              assets: [
                {
                  assetName: { name: vault.asset_vault_name, format: 'hex' },
                  policyId: vault.script_hash,
                  quantity: Number(claim.amount),
                },
              ],
              lovelace: adaAmount,
              datum: {
                type: 'inline',
                value: {
                  datum_tag: datumTag,
                  ada_paid: adaAmount,
                },
                shape: {
                  validatorHash: this.unparametizedDispatchHash,
                  purpose: 'spend',
                },
              },
            },
            {
              address: SC_ADDRESS,
              lovelace: Number(contribOutput.amount.find((u: any) => u.unit === 'lovelace')?.quantity),
              assets: contributionAssets, // Here should be assets that user contributed to Vault
              datum: {
                type: 'inline',
                value: {
                  policy_id: vault.script_hash,
                  asset_name: vault.asset_vault_name,
                  owner: userAddress,
                  datum_tag: datumTag,
                },
                shape: {
                  validatorHash: vault.script_hash,
                  purpose: 'spend',
                },
              },
            },
            {
              address: DISPATCH_ADDRESS,
              lovelace: actualRemainingDispatchLovelace,
            },
          ],
          requiredSigners: [this.adminHash],
          referenceInputs: [
            {
              txHash: vault.last_update_tx_hash,
              index: 0,
            },
          ],
          validityInterval: {
            start: true,
            end: true,
          },
          network: 'preprod',
        };
        const trimmedInput = { ...input };
        delete trimmedInput.preloadedScripts;
        this.logger.debug(JSON.stringify(trimmedInput));

        try {
          const buildResponse = await this.blockchainService.buildTransaction(input);

          const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
          txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

          const response = await this.blockchainService.submitTransaction({
            transaction: txToSubmitOnChain.to_hex(),
            signatures: [],
          });

          await this.transactionRepository.update(
            { id: transaction.id },
            { tx_hash: response.txHash, status: TransactionStatus.submitted }
          );

          this.logger.log(`Payment transaction ${response.txHash} submitted for claim ${claim.id}`);
          await new Promise(resolve => setTimeout(resolve, 60000));
        } catch (error) {
          this.logger.error(`Failed to submit payment transaction:`, error);
          await this.transactionRepository.update({ id: transaction.id }, { status: TransactionStatus.failed }); // Mark transaction as failed
          await new Promise(resolve => setTimeout(resolve, 60000));
        }

        this.logger.log(`Payment transaction created for claim ${claim.id}`);
      } catch (error) {
        this.logger.error(`Failed to process payment for claim ${claim.id}:`, error);
      }
    }

    // Mark vault as processed after all payments are queued
    await this.vaultRepository.update(
      { id: vaultId },
      {
        distribution_in_progress: false,
        distribution_processed: true,
      }
    );
  }

  // Helper methods

  private getDispatchAddress(scriptHash: string): string {
    return EnterpriseAddress.new(0, Credential.from_scripthash(ScriptHash.from_hex(scriptHash)))
      .to_address()
      .to_bech32();
  }

  private async getUserAddress(userId: string): Promise<string> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
      select: ['address'],
    });

    if (!user?.address) {
      throw new Error(`User ${userId} has no address`);
    }

    return user.address;
  }
}
