import { Buffer } from 'node:buffer';

import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import {
  EnterpriseAddress,
  ScriptHash,
  Credential,
  FixedTransaction,
  PrivateKey,
  Transaction as CardanoTransaction,
} from '@emurgo/cardano-serialization-lib-nodejs';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, Not, IsNull, MoreThan } from 'typeorm';

import { GovernanceService } from '../vaults/phase-management/governance/governance.service';
import { AssetsService } from '../vaults/processing-tx/assets/assets.service';
import { ApplyParamsResponse, BlockchainService } from '../vaults/processing-tx/onchain/blockchain.service';
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
  mint?: object[];
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
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
    private readonly configService: ConfigService,
    private readonly blockchainService: BlockchainService,
    private readonly assetService: AssetsService,
    private readonly governanceService: GovernanceService
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
        this.logger.log(`Extraction transactions queued for vault ${vault.id}`);
        await new Promise(resolve => setTimeout(resolve, 30000));
      } catch (error) {
        this.logger.error(`Error processing vault ${vault.id}:`, error);
      }
    }
  }

  private async processAcquirerExtractions(vaultId: string): Promise<void> {
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

    // If no acquirer claims, check for contributor claims
    if (claims.length === 0) {
      const contributorClaims = await this.claimRepository.count({
        where: {
          vault: { id: vaultId },
          type: ClaimType.CONTRIBUTOR,
          status: ClaimStatus.PENDING,
        },
      });

      // If no pending claims at all, mark vault as processed
      if (contributorClaims === 0) {
        this.logger.log(`No pending claims found for vault ${vaultId}. Marking as processed.`);
        await this.vaultRepository.update(
          { id: vaultId },
          {
            distribution_in_progress: false,
            distribution_processed: true,
          }
        );
        return;
      }

      // If there are contributor claims but no acquirer claims, proceed to payment phase
      this.logger.log(
        `No acquirer claims for vault ${vaultId}, but ${contributorClaims} contributor claims pending. Proceeding to payment phase.`
      );

      // Get vault details for stake registration check
      const vaultWithStake = await this.vaultRepository.findOne({
        where: { id: vaultId },
        select: ['id', 'script_hash', 'asset_vault_name', 'stake_registered'],
      });

      if (vaultWithStake) {
        // Check if stake is already registered
        if (vaultWithStake.stake_registered) {
          this.logger.log(`Stake credential already registered for vault ${vaultId}. Proceeding to payments.`);
          await this.processContributorPayments(vaultId);
        } else {
          const dispatchResult = await this.blockchainService.applyDispatchParameters({
            vault_policy: this.SC_POLICY_ID,
            vault_id: vaultWithStake.asset_vault_name,
            contribution_script_hash: vaultWithStake.script_hash,
          });

          const stakeResult = await this.blockchainService.registerScriptStake(dispatchResult.parameterizedHash);

          if (stakeResult.success) {
            await this.vaultRepository.update({ id: vaultId }, { stake_registered: true });

            if (!stakeResult.alreadyRegistered) {
              await new Promise(resolve => setTimeout(resolve, 50000));
            }

            this.logger.log(`Stake credential registered for vault ${vaultId}. Proceeding to payments.`);
            await this.processContributorPayments(vaultId);
          } else {
            this.logger.error(`Failed to register stake credential for vault ${vaultId}`);
          }
        }
      }
      return;
    }

    // Process acquirer claims as usual
    const batchSize = 6;
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
      await this.processClaimsIndividually(vault, claims, vaultId, dispatchResult.parameterizedHash);
    }
  }

  private async processBatchExtraction(
    vault: Vault,
    claims: Claim[],
    extractionTx: Transaction,
    dispatchParametizedHash: string
  ): Promise<void> {
    const DISPATCH_ADDRESS = this.getDispatchAddress(dispatchParametizedHash);
    const SC_ADDRESS = EnterpriseAddress.new(0, Credential.from_scripthash(ScriptHash.from_hex(vault.script_hash)))
      .to_address()
      .to_bech32();

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
        address: SC_ADDRESS,
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

    const actualTxSize = this.getTransactionSize(buildResponse.complete);
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

    // Update all claims in the batch to claimed status
    await this.claimRepository.update({ id: In(claims.map(c => c.id)) }, { status: ClaimStatus.CLAIMED });

    // Distribute assets for all claims in the batch
    for (const claim of claims) {
      await this.assetService.distributeAssetByTransactionId(claim.transaction.id);
    }

    // Update extraction transaction with hash
    await this.transactionRepository.update(
      { id: extractionTx.id },
      { tx_hash: response.txHash, status: TransactionStatus.confirmed }
    );

    this.logger.log(`Batch extraction transaction ${response.txHash} submitted for ${claims.length} claims`);
  }

  private async processClaimsIndividually(
    vault: Vault,
    claims: Claim[],
    vaultId: string,
    dispatchParametizedHash: string
  ): Promise<void> {
    const DISPATCH_ADDRESS = this.getDispatchAddress(dispatchParametizedHash);
    const SC_ADDRESS = EnterpriseAddress.new(0, Credential.from_scripthash(ScriptHash.from_hex(vault.script_hash)))
      .to_address()
      .to_bech32();

    for (const claim of claims) {
      try {
        if (claims.indexOf(claim) > 0) {
          await new Promise(resolve => setTimeout(resolve, 180000)); // 2 minutes between transactions
        }
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

        this.logger.debug(`Processing individual extraction for claim ${claim.id}, transaction ${extractionTx.id}`);

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
        const totalMintQuantity = (adaPairMultiplier + claimMultiplier) * (originalAmount * 1_000_000);
        const dispatchLovelace = Number(originalTx.amount) * 1_000_000;

        const input: ExtractInput = {
          changeAddress: this.adminAddress,
          message: `Extract ADA for claim ${claim.id} (individual)`,
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
              address: SC_ADDRESS,
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

        this.logger.debug(input);

        const buildResponse = await this.blockchainService.buildTransaction(input);
        const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
        txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

        const response = await this.blockchainService.submitTransaction({
          transaction: txToSubmitOnChain.to_hex(),
          signatures: [],
        });

        // Update claim status
        await this.claimRepository.update({ id: claim.id }, { status: ClaimStatus.CLAIMED });

        // Distribute assets
        await this.assetService.distributeAssetByTransactionId(claim.transaction.id);

        // Update extraction transaction with hash
        await this.transactionRepository.update(
          { id: extractionTx.id },
          { tx_hash: response.txHash, status: TransactionStatus.confirmed }
        );

        this.logger.log(`Individual extraction transaction ${response.txHash} submitted for claim ${claim.id}`);

        // Add delay between individual transactions
        await new Promise(resolve => setTimeout(resolve, 90000));
      } catch (error) {
        this.logger.error(`Failed to process individual extraction for claim ${claim.id}:`, error);

        // Mark claim as failed if individual processing also fails
        await this.claimRepository.update(
          { id: claim.id },
          {
            status: ClaimStatus.FAILED,
            metadata: {
              ...claim.metadata,
              failureReason: error.message,
              failedAt: new Date().toISOString(),
            } as any,
          }
        );

        // Continue with next claim
        continue;
      }
    }
  }
  private async checkExtractionsAndTriggerPayments(): Promise<void> {
    const confirmedExtractions = await this.transactionRepository
      .createQueryBuilder('tx')
      .leftJoinAndSelect('tx.vault', 'vault')
      .where('tx.type = :type', { type: TransactionType.extractDispatch })
      .andWhere('tx.status = :status', { status: TransactionStatus.confirmed })
      .andWhere('vault.distribution_in_progress = true') // ONLY from vaults currently being processed
      .andWhere('vault.distribution_processed = false')
      .andWhere('vault.created_at > :date', { date: new Date('2025-10-22').toISOString() }) // Same filter as processLockedVaultsForDistribution
      .getMany();

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
    for (const [vaultId] of Object.entries(vaultGroups)) {
      try {
        // Check if all extractions for this vault are complete
        const pendingExtractions = await this.transactionRepository.count({
          where: {
            vault_id: vaultId,
            type: TransactionType.extractDispatch,
            status: Not(In([TransactionStatus.confirmed, TransactionStatus.failed])),
          },
        });

        // Also check if there are any remaining claims that need processing
        const remainingClaims = await this.claimRepository.count({
          where: {
            vault: { id: vaultId },
            type: ClaimType.ACQUIRER,
            status: ClaimStatus.PENDING,
          },
        });

        if (pendingExtractions === 0 && remainingClaims === 0) {
          this.logger.log(`All extractions complete for vault ${vaultId}`);

          // Get vault details
          const vault = await this.vaultRepository.findOne({
            where: { id: vaultId },
            select: ['id', 'script_hash', 'asset_vault_name', 'stake_registered', 'dispatch_parametized_hash'],
          });

          if (vault) {
            // Check if stake is already registered based on database flag
            if (vault.stake_registered) {
              this.logger.log(`Stake credential already marked as registered for vault ${vaultId}`);
              await this.processContributorPayments(vaultId);
            } else {
              const stakeResult = await this.blockchainService.registerScriptStake(vault.dispatch_parametized_hash);

              if (stakeResult.success) {
                // Update the flag in database
                await this.vaultRepository.update({ id: vaultId }, { stake_registered: true });

                // Only wait if we just registered (not if it was already registered)
                if (!stakeResult.alreadyRegistered) {
                  await new Promise(resolve => setTimeout(resolve, 90000)); // 90 seconds
                }

                this.logger.debug(
                  `Stake credential ${stakeResult.alreadyRegistered ? 'was already' : 'has been'} registered for vault ${vaultId}`
                );
                await this.processContributorPayments(vaultId);
              } else {
                this.logger.error(`Failed to register stake credential for vault ${vaultId}`);
              }
            }
          }
        } else {
          this.logger.debug(
            `Vault ${vaultId} still has ${pendingExtractions} pending extractions and ${remainingClaims} remaining claims`
          );
        }
      } catch (error) {
        this.logger.error(`Error processing extractions for vault ${vaultId}:`, error);
      }
    }
  }

  private async processContributorPayments(vaultId: string): Promise<void> {
    const claims = await this.claimRepository.find({
      where: {
        vault: { id: vaultId },
        type: ClaimType.CONTRIBUTOR,
        status: ClaimStatus.PENDING,
      },
      relations: ['transaction', 'user'],
    });

    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      select: [
        'id',
        'script_hash',
        'asset_vault_name',
        'ada_pair_multiplier',
        'last_update_tx_hash',
        'dispatch_parametized_hash',
        'dispatch_preloaded_script',
      ],
    });

    if (!vault) {
      throw new Error(`Vault ${vaultId} not found`);
    }

    if (claims.length === 0) {
      this.logger.log(`No contributor claims for payment in vault ${vaultId}. Marking vault as processed.`);
      await this.vaultRepository.update(
        { id: vaultId },
        {
          distribution_in_progress: false,
          distribution_processed: true,
        }
      );

      await new Promise(resolve => setTimeout(resolve, 20000));
      this.governanceService.createAutomaticSnapshot(vaultId, `${vault.script_hash}${vault.asset_vault_name}`);
      return;
    }

    for (const claim of claims) {
      try {
        if (claims.indexOf(claim) > 0) {
          await new Promise(resolve => setTimeout(resolve, 180000)); // 2 minutes between transactions
        }

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

          // Mark claim as failed
          await this.claimRepository.update(
            { id: claim.id },
            {
              status: ClaimStatus.FAILED,
              metadata: {
                ...claim.metadata,
                failureReason: 'UTXO_ALREADY_SPENT',
                consumedByTx: contribOutput.consumed_by_tx,
                failedAt: new Date().toISOString(),
              } as any,
            }
          );

          // Mark transaction as failed
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

        const userAddress = claim.user?.address || (await this.getUserAddress(claim.user_id));
        const datumTag = generate_tag_from_txhash_index(originalTx.tx_hash, 0);

        const SC_ADDRESS = EnterpriseAddress.new(0, Credential.from_scripthash(ScriptHash.from_hex(vault.script_hash)))
          .to_address()
          .to_bech32();

        const input: PayAdaContributionInput = {
          changeAddress: this.adminAddress,
          message: `Pay ADA to contributor for claim ${claim.id}`,
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

          await this.claimRepository.update({ id: claim.id }, { status: ClaimStatus.CLAIMED });

          this.logger.log(`Payment transaction ${response.txHash} submitted for claim ${claim.id}`);
          await new Promise(resolve => setTimeout(resolve, 100000));
        } catch (error) {
          const trimmedInput = { ...input };
          delete trimmedInput.preloadedScripts;
          this.logger.warn(JSON.stringify(trimmedInput));
          this.logger.error(`Failed to submit payment transaction:`, error);
          await this.transactionRepository.update({ id: transaction.id }, { status: TransactionStatus.failed }); // Mark transaction as failed
          await this.claimRepository.update({ id: claim.id }, { status: ClaimStatus.FAILED });
          await new Promise(resolve => setTimeout(resolve, 100000));
        }

        this.logger.log(`Payment transaction created for claim ${claim.id}`);
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
      // Mark vault as processed after all payments are queued
      await this.vaultRepository.update(
        { id: vaultId },
        {
          distribution_in_progress: false,
          distribution_processed: true,
        }
      );
      await new Promise(resolve => setTimeout(resolve, 20000));
      this.governanceService.createAutomaticSnapshot(vaultId, `${vault.script_hash}${vault.asset_vault_name}`);
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

  private getTransactionSize(txHex: string): number {
    const tx = CardanoTransaction.from_bytes(Buffer.from(txHex, 'hex'));
    return tx.to_bytes().length;
  }
}
