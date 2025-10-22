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
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, Not } from 'typeorm';

import { BlockchainService } from '../vaults/processing-tx/onchain/blockchain.service';
import { generate_tag_from_txhash_index, getUtxos } from '../vaults/processing-tx/onchain/utils/lib';

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

interface PayAdaContribution {
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
  private readonly vaultScriptAddress: string;
  private readonly adminSKey: string;
  private readonly adminAddress: string;
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
    private readonly configService: ConfigService,
    private readonly blockchainService: BlockchainService
  ) {
    this.adminHash = this.configService.get<string>('ADMIN_KEY_HASH');
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');
    this.vaultScriptAddress = this.configService.get<string>('VAULT_SCRIPT_ADDRESS');
    this.adminAddress = this.configService.get<string>('ADMIN_ADDRESS');
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async processDistributionQueue(): Promise<void> {
    this.logger.log('Processing distribution queue...');

    // 1. Find vaults ready for extraction
    await this.processReadyVaults();

    // 2.1 Process extractions for acquirer claims
    //2.2 Register Script Stake
    await this.processExtractionTransactions();

    // 3. Process payments for contributor claims
    // Firstly let`s test Extraction and registerScriptStake
    // await this.processPaymentTransactions();
  }

  private async processReadyVaults(): Promise<void> {
    const readyVaults = await this.vaultRepository.find({
      where: {
        vault_status: VaultStatus.locked,
        vault_sc_status: SmartContractVaultStatus.SUCCESSFUL,
        distribution_processed: false,
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
        status: ClaimStatus.AVAILABLE,
      },
      relations: ['transaction', 'user'],
    });

    this.logger.log(`Found ${claims.length} acquirer claims to extract for vault ${vaultId}`);

    for (const claim of claims) {
      const { transaction } = claim;
      this.logger.log(`Extracting lovelace for claim ${claim.id}, transaction ${claim.transaction_id}`);

      const vault = await this.vaultRepository.findOne({
        where: { id: transaction.vault_id },
      });

      if (!vault) {
        throw new Error(`Vault ${transaction.vault_id} not found`);
      }

      // Apply parameters to dispatch script
      const dispatchResult = await this.blockchainService.applyDispatchParameters({
        vault_policy: this.vaultScriptAddress,
        vault_id: vault.asset_vault_name,
        contribution_script_hash: vault.script_hash,
      });

      const PARAMETERIZED_DISPATCH_HASH = dispatchResult.parameterizedHash;
      const DISPATCH_ADDRESS = this.getDispatchAddress(PARAMETERIZED_DISPATCH_HASH);

      // Get the original acquire transaction
      const originalTx = claim.transaction;
      if (!originalTx || !originalTx.tx_hash) {
        throw new Error(`Original transaction not found for claim`);
      }

      const input: ExtractInput = {
        changeAddress: this.adminAddress,
        message: `Extract ADA for claims`,
        scriptInteractions: [
          {
            purpose: 'spend',
            hash: vault.script_hash,
            outputRef: {
              txHash: originalTx.tx_hash,
              index: originalTx.tx_index || 0,
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
            quantity: (vault.ada_pair_multiplier + claim.metadata.multiplier) * (originalTx.amount || 0), //For single extraction, here is amount to mint ( vault.ada_pair_multiplier + claim.metadata.multiplier ('multiplier from tx I extract')) * LOVELACE Amount
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
            address: DISPATCH_ADDRESS,
            lovelace: originalTx.amount || 0,
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

        // Update transaction with hash
        await this.transactionRepository.update({ id: transaction.id }, { tx_hash: response.txHash });

        this.logger.log(`Extraction transaction ${response.txHash} submitted for claim ${claim.id}`);
      } catch (error) {
        this.logger.error(`Failed to submit extraction transaction:`, error);

        // Mark transaction as failed
        await this.transactionRepository.update({ id: transaction.id }, { status: TransactionStatus.failed });
      }
    }
  }

  private async processExtractionTransactions(): Promise<void> {
    // Find confirmed extraction transactions
    const confirmedExtractions = await this.transactionRepository.find({
      where: {
        type: TransactionType.extract,
        status: TransactionStatus.pending,
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
            type: TransactionType.extract,
            status: Not(TransactionStatus.confirmed),
          },
        });

        if (pendingExtractions === 0) {
          this.logger.log(`All extractions complete for vault ${vaultId}`);

          // Get vault details
          const vault = await this.vaultRepository.findOne({
            where: { id: vaultId },
          });

          if (vault) {
            const dispatchResult = await this.blockchainService.applyDispatchParameters({
              vault_policy: this.vaultScriptAddress,
              vault_id: vault.asset_vault_name,
              contribution_script_hash: vault.script_hash,
            });

            const stakeRegistered = await this.blockchainService.registerScriptStake(dispatchResult.parameterizedHash);

            if (stakeRegistered) {
              this.logger.log(`Stake credential registered successfully for vault ${vaultId}`);
              await new Promise(resolve => setTimeout(resolve, 50000)); // 50 seconds
              this.logger.log(`Queueing payment transactions for vault ${vaultId}`);
              await this.queuePaymentTransactions(vaultId);
            } else {
              this.logger.error(`Failed to register stake credential for vault ${vaultId}`);
              // Consider adding retry logic or manual intervention notification
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

    this.logger.log(`Found ${claims.length} contributor claims for payment in vault ${vaultId}`);

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

        // Update claim with payment transaction
        await this.claimRepository.update({ id: claim.id }, { transaction_id: transaction.id });

        // Process payment (similar to pay_ada_contribution.ts)
        await this.payAdaContribution(transaction, claim);

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

  private async payAdaContribution(transaction: Transaction, claim: Claim): Promise<void> {
    this.logger.log(`Processing ADA payment for claim ${claim.id}`);

    const vault = await this.vaultRepository.findOne({
      where: { id: transaction.vault_id },
    });

    if (!vault) {
      throw new Error(`Vault ${transaction.vault_id} not found`);
    }

    // Apply parameters to dispatch script
    const dispatchResult = await this.blockchainService.applyDispatchParameters({
      vault_policy: this.vaultScriptAddress,
      vault_id: vault.asset_vault_name,
      contribution_script_hash: vault.script_hash,
    });

    const PARAMETERIZED_DISPATCH_HASH = dispatchResult.parameterizedHash;
    const DISPATCH_ADDRESS = this.getDispatchAddress(PARAMETERIZED_DISPATCH_HASH);

    // Get original contribution transaction
    const originalTx = claim.transaction;
    if (!originalTx || !originalTx.tx_hash) {
      throw new Error(`Original transaction not found for claim ${claim.id}`);
    }

    // Find a suitable UTXO at dispatch address with enough ADA
    const dispatchUtxos = await getUtxos(Address.from_bech32(DISPATCH_ADDRESS), 0, this.blockfrost);
    if (dispatchUtxos.len() === 0) {
      throw new Error('No UTXOs found.');
    }

    const allUtxos = dispatchUtxos;
    const adaAmount = claim.metadata?.adaAmount || 0;
    const minRequired = adaAmount + 2_000_000; // Payment + minimum ADA

    // Find suitable UTXO with enough ADA
    let suitableUtxo: {
      tx_hash: string;
      output_index: number;
      amount: string;
    } | null = null;
    for (let i = 0; i < allUtxos.len(); i++) {
      const utxo = allUtxos.get(i);
      const lovelace = this.getLovelaceAmount(utxo);

      if (lovelace >= minRequired) {
        suitableUtxo = {
          tx_hash: utxo.input().transaction_id().to_hex(),
          output_index: utxo.input().index(),
          amount: utxo.output().amount().coin().to_str(),
        };
        break;
      }
    }

    if (!suitableUtxo) {
      throw new Error(`No suitable UTXO found at dispatch address with enough ADA (need ${minRequired})`);
    }

    const userAddress = claim.user?.address || (await this.getUserAddress(claim.user_id));
    const datumTag = generate_tag_from_txhash_index(originalTx.tx_hash, +originalTx.tx_index || 0);
    const contribTxUtxos = await this.blockfrost.txsUtxos(originalTx.tx_hash);
    const contribOutput = contribTxUtxos.outputs[originalTx.tx_index || 0];
    if (!contribOutput) {
      throw new Error('No contribution output found');
    }
    const assetDetails = this.extractAssetDetailsFromUtxo(contribOutput);

    const input: PayAdaContribution = {
      changeAddress: this.adminAddress,
      message: `Pay ADA to contributor for claim ${claim.id}`,
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
            index: originalTx.tx_index || 0,
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
          quantity: claim.amount,
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
              quantity: claim.amount,
            },
          ],
          lovelace: adaAmount,
          datum: {
            type: 'inline',
            value: {
              datum_tag: datumTag,
              ada_paid: adaAmount,
              policy_id: vault.script_hash,
              asset_name: vault.asset_vault_name,
              owner: userAddress,
            },
            shape: {
              validatorHash: PARAMETERIZED_DISPATCH_HASH,
              purpose: 'spend',
            },
          },
        },
        {
          address: vault.contract_address,
          lovelace: assetDetails.lovelace,
          assets: assetDetails.assets,
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
          lovelace: this.getLovelaceAmount(suitableUtxo) - adaAmount,
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

      await this.transactionRepository.update({ id: transaction.id }, { tx_hash: response.txHash });

      this.logger.log(`Payment transaction ${response.txHash} submitted for claim ${claim.id}`);
    } catch (error) {
      this.logger.error(`Failed to submit payment transaction:`, error);

      // Mark transaction as failed
      await this.transactionRepository.update({ id: transaction.id }, { status: TransactionStatus.failed });
    }
  }

  private async processPaymentTransactions(): Promise<void> {
    // Find confirmed payment transactions
    const confirmedPayments = await this.transactionRepository.find({
      where: {
        type: TransactionType.claim,
        status: TransactionStatus.confirmed,
      },
    });

    if (confirmedPayments.length === 0) {
      return;
    }

    this.logger.log(`Processing ${confirmedPayments.length} confirmed payment transactions`);

    for (const payment of confirmedPayments) {
      try {
        const claimId = payment.metadata?.claimId;
        if (claimId) {
          // Update claim status to distributed
          await this.claimRepository.update({ id: claimId }, { status: ClaimStatus.CLAIMED });

          this.logger.log(`Claim ${claimId} marked as distributed`);
        }

        await this.transactionRepository.update({ id: payment.id }, { status: TransactionStatus.confirmed });
      } catch (error) {
        this.logger.error(`Error processing payment ${payment.id}:`, error);
      }
    }
  }

  // Helper methods

  private getDispatchAddress(scriptHash: string): string {
    return EnterpriseAddress.new(0, Credential.from_scripthash(ScriptHash.from_hex(scriptHash)))
      .to_address()
      .to_bech32();
  }

  private getLovelaceAmount(utxo: any): number {
    return parseInt(utxo.amount.find((a: any) => a.unit === 'lovelace')?.quantity || '0');
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

  private extractAssetDetailsFromUtxo(contribOutput: {
    address: string;
    amount: {
      unit: string;
      quantity: string;
    }[];
    output_index: number;
    data_hash: string | null;
    inline_datum: string | null;
    collateral: boolean;
    reference_script_hash: string | null;
    consumed_by_tx?: string | null;
  }): {
    lovelace: number;
    assets: {
      assetName: {
        name: string;
        format: string;
      };
      policyId: string;
      quantity: number;
    }[];
  } {
    const lovelace = Number(contribOutput.amount.find(u => u.unit === 'lovelace')?.quantity || 0);

    // Extract assets
    const assets = contribOutput.amount
      .filter(asset => asset.unit !== 'lovelace')
      .map(asset => {
        // Split the hex asset into policy ID (56 chars) and asset name (remaining)
        const policyId = asset.unit.slice(0, 56);
        const assetNameHex = asset.unit.slice(56);

        return {
          assetName: {
            name: assetNameHex,
            format: 'hex',
          },
          policyId,
          quantity: Number(asset.quantity),
        };
      });

    return {
      lovelace,
      assets,
    };
  }
}
