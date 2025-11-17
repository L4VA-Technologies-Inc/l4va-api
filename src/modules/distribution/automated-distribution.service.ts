import { Buffer } from 'node:buffer';

import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import {
  EnterpriseAddress,
  ScriptHash,
  Credential,
  FixedTransaction,
  PrivateKey,
  Address,
} from '@emurgo/cardano-serialization-lib-nodejs';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, Not, IsNull, MoreThan } from 'typeorm';

import { Asset } from '@/database/asset.entity';
import { Claim } from '@/database/claim.entity';
import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { AssetsService } from '@/modules/vaults/assets/assets.service';
import { ClaimsService } from '@/modules/vaults/claims/claims.service';
import { GovernanceService } from '@/modules/vaults/phase-management/governance/governance.service';
import { ApplyParamsResponse, BlockchainService } from '@/modules/vaults/processing-tx/onchain/blockchain.service';
import { generate_tag_from_txhash_index, getUtxosExtract } from '@/modules/vaults/processing-tx/onchain/utils/lib';
import { VyfiService } from '@/modules/vyfi/vyfi.service';
import { ClaimStatus, ClaimType } from '@/types/claim.types';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';
import { VaultStatus, SmartContractVaultStatus } from '@/types/vault.types';

interface ExtractInput {
  changeAddress: string;
  message: string;
  utxos: string[];
  mint: object[];
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
  utxos: string[];
  scriptInteractions: object[];
  mint: object[];
  outputs: {
    address: string;
    assets?: object[];
    lovelace?: number;
    datum?: { type: 'inline'; value: any; shape?: object };
  }[];
  requiredSigners: string[];
  referenceInputs: { txHash: string; index: number }[];
  deposits?: {
    hash: string;
    type: string;
    deposit: string;
  }[];
  validityInterval: {
    start: boolean;
    end: boolean;
  };
  network: string;
  preloadedScripts?: any;
}

interface AddressesUtxo {
  address: string;
  tx_hash: string;
  tx_index: number;
  output_index: number;
  amount: {
    unit: string;
    quantity: string;
  }[];
  block: string;
  data_hash: string;
  inline_datum: string;
  reference_script_hash: string;
}

@Injectable()
export class AutomatedDistributionService {
  private readonly logger = new Logger(AutomatedDistributionService.name);
  private readonly adminHash: string;
  private readonly SC_POLICY_ID: string;
  private readonly adminSKey: string;
  private readonly MAX_TX_SIZE = 15900;
  private readonly adminAddress: string;
  private readonly unparametizedDispatchHash: string;
  private isRunning = false;
  private readonly blockfrost: BlockFrostAPI;

  constructor(
    @InjectRepository(Claim)
    private readonly claimRepository: Repository<Claim>,
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
    private readonly configService: ConfigService,
    private readonly blockchainService: BlockchainService,
    private readonly assetService: AssetsService,
    private readonly claimsService: ClaimsService,
    private readonly governanceService: GovernanceService,
    private readonly vyfiService: VyfiService
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

  @Cron('0 */15 * * * *')
  async processVaultDistributions(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Distribution process already running, skipping this execution');
      return;
    }

    this.isRunning = true;

    try {
      // 1. Reset stuck vaults first (older than 30 minutes) Haven`t tested this
      // await this.resetStuckVaults();

      // 1. Find vaults ready for extraction
      await this.processLockedVaultsForDistribution();

      // 2. Process extractions for acquirer claims and register stake
      await this.checkExtractionsAndTriggerPayments();
    } catch (error) {
      this.logger.error('Error in vault distribution process:', error);
    } finally {
      this.isRunning = false;
    }
  }

  //Haven`t tested this
  // private async resetStuckVaults(): Promise<void> {
  //   const thirtyMinutesAgo = new Date();
  //   thirtyMinutesAgo.setMinutes(thirtyMinutesAgo.getMinutes() - 30);

  //   const stuckVaults = await this.vaultRepository.find({
  //     where: {
  //       distribution_in_progress: true,
  //       distribution_processed: false,
  //       updated_at: LessThan(thirtyMinutesAgo.toISOString()), // Stuck for more than 30 minutes
  //     },
  //     select: ['id', 'updated_at'],
  //   });

  //   if (stuckVaults.length > 0) {
  //     this.logger.warn(`Found ${stuckVaults.length} stuck vaults, resetting them`);

  //     await this.vaultRepository.update(
  //       { id: In(stuckVaults.map(v => v.id)) },
  //       {
  //         distribution_in_progress: false,
  //         // Don't reset distribution_processed - if it was being processed, it might have partially completed
  //       }
  //     );

  //     for (const vault of stuckVaults) {
  //       this.logger.log(`Reset stuck vault ${vault.id} (stuck since ${vault.updated_at})`);
  //     }
  //   }
  // }

  private async processLockedVaultsForDistribution(): Promise<void> {
    const readyVaults = await this.vaultRepository.find({
      where: {
        vault_status: VaultStatus.locked,
        vault_sc_status: SmartContractVaultStatus.SUCCESSFUL,
        last_update_tx_hash: Not(IsNull()),
        distribution_processed: false,
        // distribution_in_progress: false,
        created_at: MoreThan(new Date('2025-10-22').toISOString()),
      },
      select: ['id'],
    });

    for (const vault of readyVaults) {
      try {
        this.logger.log(`Processing vault ${vault.id} for distribution`);

        await this.vaultRepository.update({ id: vault.id }, { distribution_in_progress: true }); // Mark as processing to prevent duplicate processing

        await this.processAcquirerExtractions(vault.id); // Queue extraction transactions for acquirer claims
      } catch (error) {
        this.logger.error(`Error processing vault ${vault.id}:`, error);
      }
    }
  }

  private async processAcquirerExtractions(vaultId: string): Promise<void> {
    const vault = await this.vaultRepository
      .createQueryBuilder('vault')
      .select([
        'vault.id',
        'vault.script_hash',
        'vault.asset_vault_name',
        'vault.ada_pair_multiplier',
        'vault.last_update_tx_hash',
        'vault.dispatch_parametized_hash',
        'vault.dispatch_preloaded_script',
      ])
      .leftJoinAndSelect('vault.claims', 'claim', 'claim.type = :type AND claim.status = :status', {
        type: ClaimType.ACQUIRER,
        status: ClaimStatus.PENDING,
      })
      .leftJoinAndSelect('claim.transaction', 'transaction')
      .leftJoinAndSelect('claim.user', 'user')
      .where('vault.id = :vaultId', { vaultId })
      .getOne();

    if (!vault) {
      throw new Error(`Vault ${vaultId} not found`);
    }

    const claims = vault.claims || [];

    this.logger.log(`Found ${claims.length} acquirer claims to extract for vault ${vaultId}`);

    // If no acquirer claims, skip processing
    if (claims.length === 0) return;

    // Process acquirer claims as usual
    const batchSize = 12;
    for (let i = 0; i < claims.length; i += batchSize) {
      const batchClaims = claims.slice(i, i + batchSize);
      await this.processAcquirerBatch(vault, batchClaims, vaultId);

      if (i + batchSize < claims.length) {
        await new Promise(resolve => setTimeout(resolve, 180000));
      }
    }
  }

  private async processAcquirerBatch(vault: Vault, claims: Claim[], vaultId: string): Promise<void> {
    let dispatchResult: {
      parameterizedHash: string;
      fullResponse: ApplyParamsResponse;
    };

    if (!vault.dispatch_parametized_hash) {
      dispatchResult = await this.blockchainService.applyDispatchParameters({
        vault_policy: this.SC_POLICY_ID,
        vault_id: vault.asset_vault_name,
        contribution_script_hash: vault.script_hash,
      });

      await this.vaultRepository.update(
        { id: vaultId },
        {
          dispatch_parametized_hash: dispatchResult.parameterizedHash,
          dispatch_preloaded_script: dispatchResult.fullResponse,
        }
      );
    } else {
      dispatchResult = {
        parameterizedHash: vault.dispatch_parametized_hash,
        fullResponse: vault.dispatch_preloaded_script,
      };
    }

    // Create a single extraction transaction record for the batch
    const extractionTx = await this.transactionRepository.save({
      vault_id: vaultId,
      user_id: null, // Batch transaction - no single user
      type: TransactionType.extractDispatch,
      status: TransactionStatus.created,
      metadata: {
        batchSize: claims.length,
        claimIds: claims.map(c => c.id),
      },
    });

    this.logger.debug(`Processing batch extraction for ${claims.length} claims, transaction ${extractionTx.id}`);

    try {
      // Try batch processing first
      await this.processBatchExtraction(vault, claims, extractionTx, dispatchResult.parameterizedHash);
    } catch (error) {
      this.logger.warn(`Batch extraction failed for ${claims.length} claims: ${error.message}`);
      this.logger.log(`Falling back to individual claim processing for vault ${vaultId}`);

      // Mark the batch transaction as failed
      await this.transactionRepository.update({ id: extractionTx.id }, { status: TransactionStatus.failed });

      // Process each claim individually
      await this.processAcquireClaimsIndividually(vault, claims, vaultId, dispatchResult.parameterizedHash);
    }
  }

  private async processBatchExtraction(
    vault: Vault,
    claims: Claim[],
    extractionTx: Transaction,
    dispatchParametizedHash: string
  ): Promise<void> {
    const DISPATCH_ADDRESS = this.getDispatchAddress(dispatchParametizedHash);
    const { utxos: adminUtxos } = await getUtxosExtract(Address.from_bech32(this.adminAddress), this.blockfrost, {
      minAda: 4000000,
    });
    if (adminUtxos.length === 0) {
      throw new Error('No UTXOs on admin wallet was found.');
    }
    // Build script interactions for all claims in the batch
    const scriptInteractions: object[] = [];
    const mintAssets: object[] = [];
    const outputs: {
      address: string;
      assets?: object[];
      lovelace?: number;
      datum?: { type: 'inline'; value: any; shape?: object };
    }[] = [];

    let totalMintQuantity = 0;
    let totalDispatchLovelace = 0;

    for (const claim of claims) {
      const { user } = claim;
      const originalTx = claim.transaction;

      if (!originalTx || !originalTx.tx_hash) {
        throw new Error(`Original transaction not found for claim ${claim.id}`);
      }

      const datumTag = generate_tag_from_txhash_index(originalTx.tx_hash, 0);
      const adaPairMultiplier = Number(vault.ada_pair_multiplier);
      const claimMultiplier = Number(claim.metadata.multiplier);
      const originalAmount = Number(originalTx.amount);
      const claimMintQuantity = claimMultiplier * (originalAmount * 1_000_000);
      const vaultMintQuantity = adaPairMultiplier * originalAmount * 1_000_000;

      totalMintQuantity += (adaPairMultiplier + claimMultiplier) * (originalAmount * 1_000_000);
      totalDispatchLovelace += Number(originalTx.amount) * 1_000_000;

      // Add script interaction for this claim's contribution UTXO
      scriptInteractions.push({
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
              vault_token_output_index: outputs.length, // Dynamic index based on current output count
            },
          },
        },
      });

      // Add user output
      outputs.push({
        address: user.address,
        assets: [
          {
            assetName: { name: vault.asset_vault_name, format: 'hex' },
            policyId: vault.script_hash,
            quantity: claimMintQuantity,
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
      });

      // Add vault output for this claim
      outputs.push({
        address: this.adminAddress,
        assets: [
          {
            assetName: { name: vault.asset_vault_name, format: 'hex' },
            policyId: vault.script_hash,
            quantity: vaultMintQuantity,
          },
        ],
      });
    }

    // Add single mint script interaction
    scriptInteractions.push({
      purpose: 'mint',
      hash: vault.script_hash,
      redeemer: {
        type: 'json',
        value: 'MintVaultToken',
      },
    });

    // Add single dispatch output with total lovelace
    outputs.push({
      address: DISPATCH_ADDRESS,
      lovelace: totalDispatchLovelace,
    });

    // Build mint array
    mintAssets.push(
      {
        version: 'cip25',
        assetName: { name: vault.asset_vault_name, format: 'hex' },
        policyId: vault.script_hash,
        type: 'plutus',
        quantity: totalMintQuantity,
        metadata: {},
      },
      {
        version: 'cip25',
        assetName: { name: 'receipt', format: 'utf8' },
        policyId: vault.script_hash,
        type: 'plutus',
        quantity: -claims.length, // Burn one receipt per claim
        metadata: {},
      }
    );

    const input: ExtractInput = {
      changeAddress: this.adminAddress,
      message: `Extract ADA for ${claims.length} claims`,
      utxos: adminUtxos,
      scriptInteractions,
      mint: mintAssets,
      outputs,
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

    const buildResponse = await this.blockchainService.buildTransaction(input);

    const actualTxSize = this.blockchainService.getTransactionSize(buildResponse.complete);
    this.logger.debug(`Transaction size: ${actualTxSize} bytes (${(actualTxSize / 1024).toFixed(2)} KB)`);

    if (actualTxSize > this.MAX_TX_SIZE) {
      throw new Error(`Transaction size ${actualTxSize} bytes exceeds Cardano limit of ${this.MAX_TX_SIZE} bytes`);
    }

    const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
    txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

    const response = await this.blockchainService.submitTransaction({
      transaction: txToSubmitOnChain.to_hex(),
      signatures: [],
    });

    await this.transactionRepository.update(
      { id: extractionTx.id },
      { tx_hash: response.txHash, status: TransactionStatus.submitted }
    );

    this.logger.log(`Batch extraction transaction ${response.txHash} submitted, waiting for confirmation...`);

    const confirmed = await this.blockchainService.waitForTransactionConfirmation(response.txHash);

    if (confirmed) {
      // Update all claims and assets only after confirmation
      await this.claimRepository.update({ id: In(claims.map(c => c.id)) }, { status: ClaimStatus.CLAIMED });

      for (const claim of claims) {
        await this.assetService.markAssetsAsDistributedByTransaction(claim.transaction.id);
      }

      await this.transactionRepository.update({ id: extractionTx.id }, { status: TransactionStatus.confirmed });

      this.logger.log(`Batch extraction transaction ${response.txHash} confirmed and processed`);
    } else {
      // Handle timeout/failure
      await this.transactionRepository.update({ id: extractionTx.id }, { status: TransactionStatus.failed });
      throw new Error(`Transaction ${response.txHash} failed to confirm within timeout period`);
    }
  }

  private async processAcquireClaimsIndividually(
    vault: Vault,
    claims: Claim[],
    vaultId: string,
    dispatchParametizedHash: string
  ): Promise<void> {
    const DISPATCH_ADDRESS = this.getDispatchAddress(dispatchParametizedHash);

    for (const claim of claims) {
      try {
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Create individual transaction record
        const extractionTx = await this.transactionRepository.save({
          vault_id: vaultId,
          user_id: claim.user.id,
          type: TransactionType.extractDispatch,
          status: TransactionStatus.created,
          metadata: {
            claimId: claim.id,
            individualProcessing: true,
          },
        });

        const { user } = claim;
        const originalTx = claim.transaction;

        if (!originalTx || !originalTx.tx_hash) {
          throw new Error(`Original transaction not found for claim ${claim.id}`);
        }

        const { utxos: adminUtxos } = await getUtxosExtract(Address.from_bech32(this.adminAddress), this.blockfrost, {
          minAda: 4000000,
        });
        if (adminUtxos.length === 0) {
          throw new Error('No UTXOs on admin wallet was found.');
        }
        const datumTag = generate_tag_from_txhash_index(originalTx.tx_hash, 0);

        const adaPairMultiplier = Number(vault.ada_pair_multiplier);
        const claimMultiplier = Number(claim.metadata.multiplier);
        const originalAmount = Number(originalTx.amount);
        const claimMintQuantity = claimMultiplier * (originalAmount * 1_000_000);
        const vaultMintQuantity = adaPairMultiplier * originalAmount * 1_000_000;
        const totalMintQuantity = (adaPairMultiplier + claimMultiplier) * (originalAmount * 1_000_000);
        const dispatchLovelace = Number(originalTx.amount) * 1_000_000;

        const input: ExtractInput = {
          changeAddress: this.adminAddress,
          message: `Extract ADA for claim ${claim.id}`,
          utxos: adminUtxos,
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
                    vault_token_output_index: 0, // Single output for individual processing
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
              quantity: totalMintQuantity,
              metadata: {},
            },
            {
              version: 'cip25',
              assetName: { name: 'receipt', format: 'utf8' },
              policyId: vault.script_hash,
              type: 'plutus',
              quantity: -1, // Burn one receipt
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
                  quantity: claimMintQuantity,
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
              address: this.adminAddress,
              assets: [
                {
                  assetName: { name: vault.asset_vault_name, format: 'hex' },
                  policyId: vault.script_hash,
                  quantity: vaultMintQuantity,
                },
              ],
            },
            {
              address: DISPATCH_ADDRESS,
              lovelace: dispatchLovelace,
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

        const buildResponse = await this.blockchainService.buildTransaction(input);
        const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
        txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

        const response = await this.blockchainService.submitTransaction({
          transaction: txToSubmitOnChain.to_hex(),
          signatures: [],
        });

        // Update transaction hash immediately
        await this.transactionRepository.update(
          { id: extractionTx.id },
          { tx_hash: response.txHash, status: TransactionStatus.submitted }
        );

        this.logger.log(`Individual extraction transaction ${response.txHash} submitted, waiting for confirmation...`);
        const confirmed = await this.blockchainService.waitForTransactionConfirmation(response.txHash);

        if (confirmed) {
          await this.claimsService.updateClaimStatus(claim.id, ClaimStatus.CLAIMED);
          await this.assetService.markAssetsAsDistributedByTransaction(claim.transaction.id);

          await this.transactionRepository.update({ id: extractionTx.id }, { status: TransactionStatus.confirmed });

          this.logger.log(`Individual extraction transaction ${response.txHash} confirmed for claim ${claim.id}`);
        } else {
          this.logger.warn(`Individual extraction transaction ${response.txHash} timeout for claim ${claim.id}`);
          await this.transactionRepository.update({ id: extractionTx.id }, { status: TransactionStatus.failed });
        }
      } catch (error) {
        this.logger.error(`Failed to process individual extraction for claim ${claim.id}:`, error);
        continue;
      }
    }
  }

  private async checkExtractionsAndTriggerPayments(): Promise<void> {
    // Single query to get all vaults with their acquirer claim counts
    const vaultsWithClaims = await this.vaultRepository
      .createQueryBuilder('vault')
      .select([
        'vault.id',
        'vault.stake_registered',
        'vault.asset_vault_name',
        'vault.script_hash',
        'vault.dispatch_parametized_hash',
        'vault.dispatch_preloaded_script',
      ])
      .leftJoin(
        'claims',
        'claim',
        'claim.vault_id = vault.id AND claim.type = :type AND claim.status IN (:...statuses)',
        {
          type: ClaimType.ACQUIRER,
          statuses: [ClaimStatus.PENDING, ClaimStatus.FAILED],
        }
      )
      .addSelect('COUNT(claim.id)', 'remainingAcquirerClaims')
      .where('vault.distribution_processed = :processed', { processed: false })
      .andWhere('vault.distribution_in_progress = :inProgress', { inProgress: true })
      .groupBy('vault.id')
      .getRawAndEntities();

    const vaults = vaultsWithClaims.entities;
    const claimCounts = vaultsWithClaims.raw;

    if (vaults.length === 0) {
      return;
    }

    this.logger.log(`Found ${vaults.length} vaults in distribution to check`);

    // Process each vault sequentially
    for (let i = 0; i < vaults.length; i++) {
      const vault = vaults[i];
      const remainingAcquirerClaims = parseInt(claimCounts[i].remainingAcquirerClaims || '0');

      try {
        this.logger.log(`Checking vault ${vault.id} - ${remainingAcquirerClaims} acquirer claims remaining`);

        // 1. Check if there are any remaining acquirer claims
        if (remainingAcquirerClaims > 0) {
          this.logger.log(
            `Vault ${vault.id} still has ${remainingAcquirerClaims} acquirer claims pending. ` +
              `Skipping contributor payments for now.`
          );
          continue; // Move to next vault
        }

        this.logger.log(`All acquirer extractions complete for vault ${vault.id}`);

        // 2. Check if stake credential is registered
        if (!vault.stake_registered) {
          this.logger.log(`Registering stake credential for vault ${vault.id}`);

          try {
            // Apply dispatch parameters if not already done
            let dispatchHash = vault.dispatch_parametized_hash;

            if (!dispatchHash) {
              const dispatchResult = await this.blockchainService.applyDispatchParameters({
                vault_policy: this.SC_POLICY_ID,
                vault_id: vault.asset_vault_name,
                contribution_script_hash: vault.script_hash,
              });

              dispatchHash = dispatchResult.parameterizedHash;

              await this.vaultRepository.update(
                { id: vault.id },
                {
                  dispatch_parametized_hash: dispatchResult.parameterizedHash,
                  dispatch_preloaded_script: dispatchResult.fullResponse,
                }
              );
            }

            // Register stake credential
            const stakeResult = await this.blockchainService.registerScriptStake(dispatchHash);

            if (stakeResult.success) {
              await this.vaultRepository.update({ id: vault.id }, { stake_registered: true });

              this.logger.log(
                `Successfully registered stake credential for vault ${vault.id}. ` +
                  `Proceeding to contributor payments.`
              );

              // Now process contributor payments
              await this.processContributorPayments(vault.id);
            } else {
              this.logger.error(
                `Failed to register stake credential for vault ${vault.id}. ` + `Will retry in next cycle.`
              );
              continue; // Move to next vault
            }
          } catch (error) {
            this.logger.error(`Error during stake registration for vault ${vault.id}:`, error);
            continue; // Move to next vault
          }
        } else {
          await this.processContributorPayments(vault.id);
        }
      } catch (error) {
        this.logger.error(`Error processing vault ${vault.id} for contributor payments:`, error);
        // Continue to next vault even if this one fails
      }
    }

    this.logger.log('Completed checking extractions and triggering payments for all vaults');
  }

  private async finalizeVaultDistribution(
    vaultId: string,
    script_hash: string,
    asset_vault_name: string
  ): Promise<void> {
    try {
      // Create liquidity pool
      const { txHash } = await this.vyfiService.createLiquidityPool(vaultId);

      if (txHash) {
        // Mark vault as fully processed
        await this.vaultRepository.update(
          { id: vaultId },
          {
            distribution_in_progress: false,
            distribution_processed: true,
          }
        );

        await this.governanceService.createAutomaticSnapshot(vaultId, `${script_hash}${asset_vault_name}`);
      }
    } catch (error) {
      this.logger.error(`Failed to finalize vault distribution for ${vaultId}:`, error);
      // Reset the vault state on failure
      await this.vaultRepository.update({ id: vaultId }, { distribution_in_progress: false });
      throw error;
    }
  }

  // New flow for batched payment

  private async processContributorPayments(vaultId: string): Promise<void> {
    this.logger.log(`Starting contributor payment processing for vault ${vaultId}`);

    // Get vault and claims
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
    });

    if (!vault) {
      this.logger.error(`Vault ${vaultId} not found`);
      return;
    }

    const readyClaims = await this.claimRepository.find({
      where: {
        vault: { id: vaultId },
        type: ClaimType.CONTRIBUTOR,
        status: ClaimStatus.PENDING,
      },
      relations: ['user', 'transaction'],
    });

    if (readyClaims.length === 0) {
      this.logger.log(`No ready contributor claims for vault ${vaultId}`);
      await this.finalizeVaultDistribution(vaultId, vault.script_hash, vault.asset_vault_name);
      return;
    }

    this.logger.log(`Found ${readyClaims.length} contributor claims to process`);

    // Get dispatch UTXOs once
    const DISPATCH_ADDRESS = this.getDispatchAddress(vault.dispatch_parametized_hash);
    const dispatchUtxos = await this.blockfrost.addressesUtxos(DISPATCH_ADDRESS);

    if (!dispatchUtxos || dispatchUtxos.length === 0) {
      throw new Error(`No UTXOs found at dispatch address for vault ${vaultId}`);
    }

    // Process claims with dynamic batching
    let processedCount = 0;
    let batchNumber = 0;

    while (processedCount < readyClaims.length) {
      batchNumber++;

      try {
        // Get remaining claims
        const remainingClaims = readyClaims.slice(processedCount);

        // Try to determine optimal batch size by testing transaction builds
        const { optimalBatchSize, actualClaims } = await this.determineOptimalBatchSize(
          vault,
          remainingClaims,
          dispatchUtxos
        );

        this.logger.log(
          `Processing payment batch ${batchNumber} with ${optimalBatchSize} claims ` +
            `(${processedCount + 1}-${processedCount + optimalBatchSize} of ${readyClaims.length})`
        );

        // Process the optimal batch
        await this.processBatchedPayments(vault, actualClaims, dispatchUtxos);

        processedCount += optimalBatchSize;

        // Delay between batches
        if (processedCount < readyClaims.length) {
          this.logger.debug('Waiting 20s before next batch');

          await new Promise(resolve => setTimeout(resolve, 20000));
        }
      } catch (error) {
        this.logger.error(`Failed to process payment batch ${batchNumber}:`, error);

        // Fallback to individual processing for failed batch
        const failedBatch = readyClaims.slice(processedCount, processedCount + 1);
        this.logger.log(`Falling back to individual payment processing`);

        await this.processIndividualPayments(vault, failedBatch);

        processedCount += 1; // Only increment by 1 since we processed individually
      }
    }

    this.logger.log(`Completed processing ${processedCount} contributor payments for vault ${vaultId}`);

    // Check if all claims are processed
    const remainingClaims = await this.claimRepository.count({
      where: {
        vault: { id: vaultId },
        type: ClaimType.CONTRIBUTOR,
        status: In([ClaimStatus.PENDING, ClaimStatus.FAILED]),
      },
    });

    if (remainingClaims === 0) {
      this.logger.log(`All contributor payments complete for vault ${vaultId}, finalizing...`);
      await this.finalizeVaultDistribution(vaultId, vault.script_hash, vault.asset_vault_name);
    }
  }

  /**
   * Determine optimal batch size by testing actual transaction builds
   * This ensures we don't exceed transaction size limits
   */
  private async determineOptimalBatchSize(
    vault: Vault,
    claims: Claim[],
    dispatchUtxos: AddressesUtxo[]
  ): Promise<{
    optimalBatchSize: number;
    actualClaims: Claim[];
  }> {
    const MAX_BATCH_SIZE = 8; // Maximum we want to attempt

    // Start with smallest batch and work up
    let testBatchSize = 2;
    let lastSuccessfulSize = 2;
    let lastSuccessfulClaims = claims.slice(0, 2);

    // Get admin UTXOs once for testing
    const { utxos: adminUtxos } = await getUtxosExtract(Address.from_bech32(this.adminAddress), this.blockfrost, {
      minAda: 4_000_000,
    });

    if (adminUtxos.length === 0) {
      throw new Error('No admin UTXOs found for batch payment');
    }

    // Test increasing batch sizes
    while (testBatchSize <= Math.min(MAX_BATCH_SIZE, claims.length)) {
      const testClaims = claims.slice(0, testBatchSize);

      try {
        this.logger.debug(`Testing batch size ${testBatchSize}...`);

        // Build test transaction
        const input = this.buildBatchedPaymentInput(vault, testClaims, adminUtxos, dispatchUtxos);

        const buildResponse = await this.blockchainService.buildTransaction(input);
        const txSize = this.blockchainService.getTransactionSize(buildResponse.complete);

        this.logger.debug(`Batch size ${testBatchSize}: ${txSize} bytes (${(txSize / 1024).toFixed(2)} KB)`);

        if (txSize > this.MAX_TX_SIZE) {
          this.logger.log(
            `Batch size ${testBatchSize} produces ${txSize} bytes, exceeds target. ` +
              `Using ${lastSuccessfulSize} claims per batch.`
          );
          break;
        }

        // This size works, save it
        lastSuccessfulSize = testBatchSize;
        lastSuccessfulClaims = testClaims;

        // If this is already max batch size, we're done
        if (testBatchSize >= MAX_BATCH_SIZE) {
          this.logger.log(`Reached max batch size of ${MAX_BATCH_SIZE}`);
          break;
        }

        // Try next size
        testBatchSize++;
      } catch (error) {
        this.logger.warn(`Batch size ${testBatchSize} failed to build: ${error.message}`);
        break; // Stop testing, use last successful size
      }
    }

    this.logger.log(
      `Optimal batch size determined: ${lastSuccessfulSize} claims ` + `(tested up to ${testBatchSize - 1})`
    );

    return {
      optimalBatchSize: lastSuccessfulSize,
      actualClaims: lastSuccessfulClaims,
    };
  }

  /**
   * Process a batch of payments in a single transaction
   */
  private async processBatchedPayments(vault: Vault, claims: Claim[], dispatchUtxos: AddressesUtxo[]): Promise<void> {
    const claimIds = claims.map(c => c.id);

    this.logger.log(`Building batched payment transaction for ${claims.length} claims `);

    // Create batch transaction record
    const batchTransaction = await this.transactionRepository.save({
      vault_id: vault.id,
      user_id: null,
      type: TransactionType.claim,
      status: TransactionStatus.created,
      metadata: {
        batchSize: claims.length,
        claimIds,
      },
    });

    try {
      // Get admin UTXOs
      const { utxos: adminUtxos } = await getUtxosExtract(Address.from_bech32(this.adminAddress), this.blockfrost, {
        minAda: 4_000_000,
      });

      if (adminUtxos.length === 0) {
        throw new Error('No admin UTXOs found for batch payment');
      }

      // Build batched transaction
      const input = await this.buildBatchedPaymentInput(vault, claims, adminUtxos, dispatchUtxos);

      // Build transaction
      const buildResponse = await this.blockchainService.buildTransaction(input);
      const txSize = this.blockchainService.getTransactionSize(buildResponse.complete);

      this.logger.log(`Batch payment transaction built: ${txSize} bytes (${(txSize / 1024).toFixed(2)} KB)`);

      if (txSize > this.MAX_TX_SIZE) {
        throw new Error(
          `Transaction size ${txSize} exceeds limit of ${this.MAX_TX_SIZE}, ` +
            `this should not happen after batch size determination`
        );
      }

      await new Promise(resolve => setTimeout(resolve, 1000));

      // Sign and submit
      const txToSubmit = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
      txToSubmit.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

      const response = await this.blockchainService.submitTransaction({
        transaction: txToSubmit.to_hex(),
        signatures: [],
      });

      this.logger.log(`Batch payment transaction submitted: ${response.txHash}`);

      // Update transaction record
      await this.transactionRepository.update(
        { id: batchTransaction.id },
        { tx_hash: response.txHash, status: TransactionStatus.submitted }
      );

      // Wait for confirmation
      await new Promise(resolve => setTimeout(resolve, 20000));

      const confirmed = await this.blockchainService.waitForTransactionConfirmation(response.txHash);

      if (!confirmed) {
        throw new Error(`Batch payment transaction ${response.txHash} failed to confirm`);
      }

      // Update all claims in batch to CLAIMED
      await this.claimRepository.update(
        { id: In(claimIds) },
        {
          status: ClaimStatus.CLAIMED,
        }
      );

      // Update transaction status
      await this.transactionRepository.update({ id: batchTransaction.id }, { status: TransactionStatus.confirmed });

      // Mark assets as distributed
      for (const claim of claims) {
        await this.assetService.markAssetsAsDistributedByTransaction(claim.transaction.id);
      }

      this.logger.log(
        `Successfully processed batch payment for ${claims.length} claims ` + `with tx: ${response.txHash}`
      );
    } catch (error) {
      this.logger.error(`Failed to process batched payments:`, error);

      // Update transaction as failed
      await this.transactionRepository.update(
        { id: batchTransaction.id },
        {
          status: TransactionStatus.failed,
          metadata: {
            error: error.message,
          },
        }
      );

      throw error;
    }
  }

  /**
   * Fallback: process payments individually
   */
  private async processIndividualPayments(vault: Vault, claims: Claim[]): Promise<void> {
    for (const [index, claim] of claims.entries()) {
      try {
        this.logger.log(`Processing individual payment for claim ${claim.id} ` + `(${index + 1}/${claims.length})`);

        // Use your existing single payment logic
        await this.processSinglePayment(vault, claims);

        // Delay between payments
        if (index < claims.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 20000));
        }
      } catch (error) {
        this.logger.error(`Failed to process individual payment for claim ${claim.id}:`, error);

        // Mark claim as failed
        await this.claimRepository.update({ id: claim.id }, { status: ClaimStatus.FAILED });
      }
    }
  }

  /**
   * Build batched payment transaction input for multiple contributor claims
   * Follows the same logic as single payment but processes multiple claims
   */
  private async buildBatchedPaymentInput(
    vault: Vault,
    claims: Claim[],
    adminUtxos: string[],
    dispatchUtxos: AddressesUtxo[]
  ): Promise<PayAdaContributionInput> {
    const scriptInteractions = [];
    const outputs = [];
    const mintAssets = [];

    let totalPaymentAmount = 0;
    const PARAMETERIZED_DISPATCH_HASH = vault.dispatch_parametized_hash;
    const DISPATCH_ADDRESS = this.getDispatchAddress(PARAMETERIZED_DISPATCH_HASH);
    const SC_ADDRESS = EnterpriseAddress.new(0, Credential.from_scripthash(ScriptHash.from_hex(vault.script_hash)))
      .to_address()
      .to_bech32();

    // Track vault token output indices for each claim
    let currentOutputIndex = 0;

    // Process each claim in the batch
    for (const claim of claims) {
      const { transaction: originalTx, metadata } = claim;
      const adaAmount = Number(metadata.adaAmount);
      totalPaymentAmount += adaAmount;

      // Get original contribution transaction details
      const contributedAssets = await this.assetRepository.find({
        where: { transaction: { id: originalTx.id } },
      });

      // Format contributed assets
      const contributionAssets: {
        assetName: { name: string; format: string };
        policyId: string;
        quantity: number;
      }[] = [];

      if (contributedAssets.length > 0) {
        for (const asset of contributedAssets) {
          contributionAssets.push({
            assetName: {
              name: asset.asset_id,
              format: 'hex',
            },
            policyId: asset.policy_id,
            quantity: Number(asset.quantity),
          });
        }
      }

      // Get contribution output details
      const contribTxUtxos = await this.blockfrost.txsUtxos(originalTx.tx_hash);
      const contribOutput = contribTxUtxos.outputs[0];
      if (!contribOutput) {
        throw new Error(`No contribution output found for claim ${claim.id}`);
      }

      // Check if already consumed
      if (contribOutput.consumed_by_tx) {
        throw new Error(
          `Contribution UTXO ${originalTx.tx_hash}#0 already consumed by ${contribOutput.consumed_by_tx}`
        );
      }

      const userAddress = claim.user.address;
      const datumTag = generate_tag_from_txhash_index(originalTx.tx_hash, 0);
      const vaultTokenQuantity = Number(claim.amount);

      // Add script interaction for spending the contribution UTXO
      scriptInteractions.push({
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
              vault_token_output_index: currentOutputIndex, // Index of user output
              change_output_index: currentOutputIndex + 1, // Index of SC address output
            },
          },
        },
      });

      // Output 1: Payment to user with vault tokens
      outputs.push({
        address: userAddress,
        assets: [
          {
            assetName: { name: vault.asset_vault_name, format: 'hex' },
            policyId: vault.script_hash,
            quantity: vaultTokenQuantity,
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
      });

      // Output 2: Return to SC address with original contributed assets
      outputs.push({
        address: SC_ADDRESS,
        lovelace: Number(contribOutput.amount.find((u: any) => u.unit === 'lovelace')?.quantity),
        assets: contributionAssets,
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
      });

      // Add to mint array (we'll sum these up later)
      mintAssets.push({
        vaultTokenQuantity,
        receiptBurn: -1,
      });

      // Update output index counter (2 outputs per claim)
      currentOutputIndex += 2;
    }

    // Calculate required dispatch UTXOs to cover all payments
    const minRequired = totalPaymentAmount + 1_000_000; // Total payment + minimum ADA
    const { selectedUtxos, totalAmount } = this.selectDispatchUtxos(dispatchUtxos, minRequired);

    if (selectedUtxos.length === 0 || totalAmount < minRequired) {
      throw new Error(
        `Insufficient ADA at dispatch address. Need ${minRequired} lovelace, but only ${totalAmount} available`
      );
    }

    const actualRemainingDispatchLovelace = totalAmount - totalPaymentAmount;

    // Validate balance equation
    const balanceValid = totalAmount >= actualRemainingDispatchLovelace + totalPaymentAmount;
    if (!balanceValid) {
      throw new Error(
        `Balance equation invalid: ${totalAmount} < ${actualRemainingDispatchLovelace} + ${totalPaymentAmount}`
      );
    }

    // Add dispatch script interactions for selected UTXOs
    for (const utxo of selectedUtxos) {
      scriptInteractions.push({
        purpose: 'spend',
        hash: PARAMETERIZED_DISPATCH_HASH,
        outputRef: {
          txHash: utxo.tx_hash,
          index: utxo.output_index,
        },
        redeemer: {
          type: 'json',
          value: null,
        },
      });
    }

    scriptInteractions.push({
      purpose: 'withdraw',
      hash: PARAMETERIZED_DISPATCH_HASH,
      redeemer: {
        type: 'json',
        value: null,
      },
    });

    // Add mint script interaction
    scriptInteractions.push({
      purpose: 'mint',
      hash: vault.script_hash,
      redeemer: {
        type: 'json',
        value: 'MintVaultToken',
      },
    });

    // Output 3: Return remaining ADA to dispatch address
    outputs.push({
      address: DISPATCH_ADDRESS,
      lovelace: actualRemainingDispatchLovelace,
    });

    // Calculate total mint quantities
    const totalVaultTokenQuantity = mintAssets.reduce((sum, m) => sum + m.vaultTokenQuantity, 0);
    const totalReceiptBurn = mintAssets.reduce((sum, m) => sum + m.receiptBurn, 0);

    const input: PayAdaContributionInput = {
      changeAddress: this.adminAddress,
      message: `Batch payment for ${claims.length} contributors`,
      utxos: adminUtxos,
      preloadedScripts: [vault.dispatch_preloaded_script.preloadedScript],
      scriptInteractions,
      mint: [
        {
          version: 'cip25',
          assetName: { name: vault.asset_vault_name, format: 'hex' },
          policyId: vault.script_hash,
          type: 'plutus',
          quantity: totalVaultTokenQuantity,
          metadata: {},
        },
        {
          version: 'cip25',
          assetName: { name: 'receipt', format: 'utf8' },
          policyId: vault.script_hash,
          type: 'plutus',
          quantity: totalReceiptBurn, // Burn one receipt per claim
          metadata: {},
        },
      ],
      outputs,
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

    return input;
  }

  private async processSinglePayment(vault: Vault, claims: Claim[]): Promise<void> {
    const vaultId = vault.id;

    if (claims.length === 0) {
      this.logger.log(`No contributor claims for payment in vault ${vaultId}. Marking vault as processed.`);
      await this.finalizeVaultDistribution(vaultId, vault.script_hash, vault.asset_vault_name);
    }

    for (const claim of claims) {
      try {
        await new Promise(resolve => setTimeout(resolve, 20000)); // 20 seconds between transactions

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

        const PARAMETERIZED_DISPATCH_HASH = vault.dispatch_parametized_hash;
        const DISPATCH_ADDRESS = this.getDispatchAddress(PARAMETERIZED_DISPATCH_HASH);

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
        const contribOutput = contribTxUtxos.outputs[0];
        if (!contribOutput) {
          throw new Error('No contribution output found');
        }

        // Check if this output has been consumed
        if (contribOutput.consumed_by_tx) {
          this.logger.warn(
            `Contribution UTXO ${originalTx.tx_hash}#0 already consumed by transaction ${contribOutput.consumed_by_tx}. Marking claim ${claim.id} as failed.`
          );

          await this.claimsService.updateClaimStatus(claim.id, ClaimStatus.FAILED, {
            failureReason: 'UTXO_ALREADY_SPENT',
            consumedByTx: contribOutput.consumed_by_tx,
            failedAt: new Date().toISOString(),
          });

          await this.transactionRepository.update(
            { id: transaction.id },
            {
              status: TransactionStatus.failed,
              metadata: {
                ...transaction.metadata,
                failureReason: 'UTXO_ALREADY_SPENT',
                consumedByTx: contribOutput.consumed_by_tx,
              } as any,
            }
          );

          this.logger.log(`Claim ${claim.id} marked as failed due to spent UTXO`);
          continue; // Skip to next claim
        }

        // Find a suitable UTXO at dispatch address with enough ADA
        const dispatchUtxos = await this.blockfrost.addressesUtxos(DISPATCH_ADDRESS);
        if (!dispatchUtxos || dispatchUtxos.length === 0) {
          throw new Error('No UTXOs found at dispatch address');
        }

        // Calculate total lovelace available in dispatch address
        const minRequired = adaAmount + 1_000_000; // Payment + minimum ADA
        const { selectedUtxos, totalAmount } = this.selectDispatchUtxos(dispatchUtxos, minRequired);

        if (selectedUtxos.length === 0 || totalAmount < minRequired) {
          throw new Error(
            `Insufficient ADA at dispatch address. Need ${minRequired} lovelace, but only ${totalAmount} available across all UTXOs`
          );
        }

        const actualRemainingDispatchLovelace = totalAmount - adaAmount;

        // Validate the balance equation
        const balanceValid = totalAmount >= actualRemainingDispatchLovelace + adaAmount;
        if (!balanceValid) {
          throw new Error(
            `Balance equation invalid: ${totalAmount} < ${actualRemainingDispatchLovelace} + ${adaAmount}`
          );
        }

        const userAddress = claim.user?.address;
        const datumTag = generate_tag_from_txhash_index(originalTx.tx_hash, 0);

        const SC_ADDRESS = EnterpriseAddress.new(0, Credential.from_scripthash(ScriptHash.from_hex(vault.script_hash)))
          .to_address()
          .to_bech32();

        const { utxos: adminUtxos } = await getUtxosExtract(Address.from_bech32(this.adminAddress), this.blockfrost, {
          minAda: 4_000_000,
        });
        if (adminUtxos.length === 0) {
          throw new Error('No UTXOs on admin wallet was found.');
        }

        const input: PayAdaContributionInput = {
          changeAddress: this.adminAddress,
          message: `Pay ADA to contributor for claim ${claim.id}`,
          utxos: adminUtxos,
          preloadedScripts: [vault.dispatch_preloaded_script.preloadedScript],
          scriptInteractions: [
            ...selectedUtxos.map(utxo => ({
              purpose: 'spend',
              hash: PARAMETERIZED_DISPATCH_HASH,
              outputRef: {
                txHash: utxo.tx_hash,
                index: utxo.output_index,
              },
              redeemer: {
                type: 'json',
                value: null,
              },
            })),
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

        try {
          const buildResponse = await this.blockchainService.buildTransaction(input);

          const actualTxSize = this.blockchainService.getTransactionSize(buildResponse.complete);
          this.logger.debug(`Transaction size: ${actualTxSize} bytes (${(actualTxSize / 1024).toFixed(2)} KB)`);

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

          this.logger.log(
            `Payment transaction ${response.txHash} submitted for claim ${claim.id}, waiting for confirmation...`
          );

          // Wait for confirmation
          const confirmed = await this.blockchainService.waitForTransactionConfirmation(response.txHash);

          if (confirmed) {
            await this.transactionRepository.update({ id: transaction.id }, { status: TransactionStatus.confirmed });
            await this.claimsService.updateClaimStatus(claim.id, ClaimStatus.CLAIMED);

            this.logger.log(`Payment transaction ${response.txHash} confirmed for claim ${claim.id}`);
          } else {
            this.logger.warn(`Payment transaction ${response.txHash} timeout for claim ${claim.id}`);
            await this.transactionRepository.update({ id: transaction.id }, { status: TransactionStatus.failed });
            await this.claimRepository.update({ id: claim.id }, { status: ClaimStatus.FAILED });
          }
        } catch (error) {
          const trimmedInput = { ...input };
          delete trimmedInput.preloadedScripts;
          this.logger.warn(JSON.stringify(trimmedInput));
          this.logger.error(`Failed to submit payment transaction:`, error);

          await this.transactionRepository.update({ id: transaction.id }, { status: TransactionStatus.failed });
          await this.claimRepository.update({ id: claim.id }, { status: ClaimStatus.FAILED });
        }

        this.logger.log(`Payment transaction processed for claim ${claim.id}`);
      } catch (error) {
        this.logger.error(`Failed to process payment for claim ${claim.id}:`, error);
      }
    }

    // Mark vault as processed after all payments are queued
    const allFailedClaims = await this.claimRepository.count({
      where: {
        vault: { id: vaultId },
        status: ClaimStatus.FAILED,
      },
    });

    if (allFailedClaims > 0) {
      this.logger.warn(`Vault ${vaultId} has ${allFailedClaims} failed claims total. NOT marking as fully processed.`);

      // Only mark extraction as done, but not fully processed
      await this.vaultRepository.update(
        { id: vaultId },
        {
          distribution_in_progress: false,
          // Don't set distribution_processed to true if there are failed claims
        }
      );
    } else {
      await this.finalizeVaultDistribution(vaultId, vault.script_hash, vault.asset_vault_name);
    }
  }

  // Helper methods
  private selectDispatchUtxos(
    dispatchUtxos: AddressesUtxo[],
    requiredAmount: number
  ): {
    selectedUtxos: AddressesUtxo[];
    totalAmount: number;
  } {
    // Sort UTXOs by amount (largest first for efficiency)
    const sortedUtxos = dispatchUtxos.sort((a, b) => {
      const amountA = parseInt(a.amount.find(u => u.unit === 'lovelace')?.quantity || '0');
      const amountB = parseInt(b.amount.find(u => u.unit === 'lovelace')?.quantity || '0');
      return amountB - amountA;
    });

    const selectedUtxos = [];
    let totalAmount = 0;

    for (const utxo of sortedUtxos) {
      const utxoAmount = parseInt(utxo.amount.find(u => u.unit === 'lovelace')?.quantity || '0');
      selectedUtxos.push(utxo);
      totalAmount += utxoAmount;

      if (totalAmount >= requiredAmount) {
        break;
      }
    }

    return { selectedUtxos, totalAmount };
  }

  private getDispatchAddress(scriptHash: string): string {
    return EnterpriseAddress.new(0, Credential.from_scripthash(ScriptHash.from_hex(scriptHash)))
      .to_address()
      .to_bech32();
  }
}
