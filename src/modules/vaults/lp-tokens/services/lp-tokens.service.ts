import {
  Injectable,
  Logger,
  Inject,
  forwardRef,
  BadRequestException,
  NotFoundException,
  InternalServerErrorException
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Transaction } from '../../../../database/transaction.entity';
import { Vault } from '../../../../database/vault.entity';
import { LpTokenOperationResult, ExtractLpTokensParams } from '../types/lp-token.types';
import { TransactionType, TransactionStatus } from '../../../../types/transaction.types';
import { TransactionsService } from '../../processing-tx/offchain-tx/transactions.service';
import { BlockchainService } from '../../processing-tx/onchain/blockchain.service';
import { ConfigService } from '@nestjs/config';
import {FixedTransaction, PlutusData, PrivateKey} from '@emurgo/cardano-serialization-lib-nodejs';
import {Buffer} from "node:buffer";
import {Datum, Redeemer1} from "../../processing-tx/onchain/types/type";
import {applyContributeParams, toPreloadedScript} from "../../processing-tx/onchain/utils/apply_params";
import {BlockchainScannerService} from "../../processing-tx/onchain/blockchain-scanner.service";
import {BlockFrostAPI} from "@blockfrost/blockfrost-js";
import {generate_tag_from_txhash_index} from "../../processing-tx/onchain/utils/lib";
import blueprint from "../../processing-tx/onchain/utils/blueprint.json";

@Injectable()
export class LpTokensService {
  private readonly adminSKey: string;
  private readonly scPolicyId: string;
  private readonly adminKeyHash: string;
  private blockfrost: any;

  constructor(
    @Inject(forwardRef(() => TransactionsService))
    private readonly transactionsService: TransactionsService,
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    private readonly blockchainService: BlockchainService,
    private readonly configService: ConfigService,
    private readonly blockchainScanner: BlockchainScannerService
  ) {
    this.adminKeyHash = this.configService.get<string>('ADMIN_KEY_HASH');
    if (!this.adminKeyHash) {
      throw new Error('ADMIN_KEY_HASH environment variable is not set');
    }
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');
    this.scPolicyId = this.configService.get<string>('SC_POLICY_ID');
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_TESTNET_API_KEY')
    });
  }
  private readonly logger = new Logger(LpTokensService.name);

  /**
   * Extracts LP tokens from a vault to a specified wallet
   * @param vaultId The ID of the vault to extract tokens from
   * @param walletAddress The wallet address to send the tokens to
   * @param amount The amount of LP tokens to extract
   * @returns Operation result with success status and transaction hash if successful
   */
  /**
   * Extracts LP tokens from a vault to a specified wallet
   * @param params Parameters for the extraction operation
   * @returns Operation result with success status and transaction hash if successful
   */
  /**
   * Extracts LP tokens from a vault to a specified wallet
   * @param extractDto - DTO containing extraction parameters
   * @returns Operation result with transaction details
   */
  async extractLpTokens(extractDto: ExtractLpTokensParams): Promise<LpTokenOperationResult> {
    const { vaultId, walletAddress, amount, txHash, txIndex } = extractDto;

    if (!this.isValidAddress(walletAddress)) {
      throw new BadRequestException('Invalid wallet address');
    }

    // Create internal transaction with type extractLp, status pending and vault id
    const transaction = await this.transactionsService.createTransaction({
      vault_id: vaultId,
      type: TransactionType.extractLp,
      assets: [], // No assets for LP extraction, just the transaction
      amount: amount
    });

    this.logger.log(`Created extract LP transaction ${transaction.id} for vault ${vaultId}`);

    try {
      this.logger.log(`Extracting ${amount} LP tokens from vault ${vaultId} to ${walletAddress}`);

      // 1. Get vault details
      const vault = await this.vaultRepository.findOne({ where: { id: vaultId } });
      if (!vault) {
        throw new NotFoundException(`Vault with ID ${vaultId} not found`);
      }

      // 2. Get the last update transaction details
      const lastUpdateTx = await this.transactionsService.getLastVaultUpdate(vaultId);
      if (!lastUpdateTx) {
        throw new NotFoundException('No update transaction found for this vault');
      }
      const LAST_UPDATE_TX_INDEX = 0; // The index off the output in the transaction

      const TX_HASH_INDEX_WITH_LPS_TO_COLLECT =
        "904bebf8c7f5d9ee343147cf8bbee24ec1beafe1e73c7d0a1c74b83c4f7a0b35#2";
      const LAST_UPDATE_TX_HASH =
        "b255d78aaf821388e00cbc03e09add05810e346b2b1f2a5db236752aec116a50";


      // Get transaction details and extract policy information
      this.logger.log(`Getting transaction details for publication hash: ${vault.publication_hash}`);

      // Validate output amoun

      const txDetail = await this.blockchainScanner.getTransactionDetails(vault.publication_hash);

      const { output_amount } = txDetail;
      this.logger.log(JSON.stringify(output_amount[1].unit));

      const vaultPolicyPlusName = output_amount[1].unit;
      const VAULT_POLICY_ID = vaultPolicyPlusName.slice(0,56);
      const VAULT_ID = vaultPolicyPlusName.slice(56,vaultPolicyPlusName.length);

      this.logger.log(`Extracted - Policy ID: ${VAULT_POLICY_ID}, Vault ID: ${VAULT_ID}`);

      let parameterizedScript;
      try {
        this.logger.log('Applying parameters to contribute script...');
        parameterizedScript = applyContributeParams({
          vault_policy_id: VAULT_POLICY_ID,
          vault_id: VAULT_ID,
        });

        if (!parameterizedScript?.validator?.hash) {
          throw new Error('Failed to parameterize script: Invalid response from applyContributeParams');
        }

        this.logger.log(`Successfully parameterized script. Hash: ${parameterizedScript.validator.hash}`);
      } catch (error) {
        this.logger.error('Error in applyContributeParams:', error);
        throw new Error(`Failed to apply parameters to script: ${error.message}`);
      }

      const lpsUnit = parameterizedScript.validator.hash + VAULT_ID;

      const POLICY_ID = parameterizedScript.validator.hash;
      const [tx_hash, index] = TX_HASH_INDEX_WITH_LPS_TO_COLLECT.split("#");
      const txUtxos = await this.blockfrost.txsUtxos(tx_hash);
      const output = txUtxos.outputs[index];
      if (!output) {
        throw new Error("No output found");
      }
      const amountOfLpsToClaim = output.amount.find(
        (a: { unit: string; quantity: string }) => a.unit === lpsUnit
      );
      const datumTag = generate_tag_from_txhash_index(tx_hash, Number(index));
      if (!amountOfLpsToClaim) {
        console.log(JSON.stringify(output));
        throw new Error("No lps to claim.");
      }


      const unparameterizedScript = blueprint.validators.find(
        (v) => v.title === "contribute.contribute"
      );
      if (!unparameterizedScript) {
        throw new Error("Contribute validator not found");
      }

      // 3. Prepare transaction input for LP token extraction
      const txInput: {
        changeAddress: string;
        message: string;
        mint?: Array<object>;
        scriptInteractions: object[];
        outputs: {
          address: string;
          assets?: object[];
          lovelace?: number;
          datum?: { type: "inline"; value: string | Datum; shape?: object };
        }[];
        requiredSigners: string[];
        preloadedScripts: {
          type: string;
          blueprint: any;
        }[];
        referenceInputs: { txHash: string; index: number }[];
        validityInterval: {
          start: boolean;
          end: boolean;
        };
        network: string;
      } = {
        changeAddress: walletAddress,
        message: "Admin extract asset",
        scriptInteractions: [
          {
            purpose: "spend",
            hash: POLICY_ID,
            outputRef: {
              txHash: tx_hash,
              index: index,
            },
            redeemer: {
              type: "json",
              value: {
                __variant: "ExtractAsset",
                __data: {
                  lp_output_index: 0,
                },
              } satisfies Redeemer1,
            },
          },
        ],
        outputs: [
          {
            address: walletAddress,
            assets: [
              {
                assetName: { name: VAULT_ID, format: "hex" },
                policyId: parameterizedScript.validator.hash,
                quantity: 1000,
              },
            ],
            datum: {
              type: "inline",
              value: PlutusData.new_bytes(Buffer.from(datumTag, "hex")).to_hex(),
            },
          },
        ],
        preloadedScripts: [
          toPreloadedScript(blueprint, {
            validators: [parameterizedScript.validator, unparameterizedScript],
          }),
        ],
        requiredSigners: [this.adminKeyHash],
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
        network: "preprod",
      };

      const inputWithNoPreloaded = { ...txInput };
      //@ts-ignore
      delete inputWithNoPreloaded.preloadedScripts;
      console.log(JSON.stringify(inputWithNoPreloaded));

      // 4. Build the transaction
      const buildResponse = await this.blockchainService.buildTransaction(txInput);

      // 5. Sign the transaction with admin key
      const txToSubmitOnChain = FixedTransaction.from_bytes(
        Buffer.from(buildResponse.complete, 'hex'),
      );

      // Sign with both admin and customer keys if needed
      txToSubmitOnChain.sign_and_add_vkey_signature(
        PrivateKey.from_bech32(this.adminSKey),
      );
      // If customer signature is needed:
      // txToSubmitOnChain.sign_and_add_vkey_signature(
      //   PrivateKey.from_bech32(customerSKey),
      // );

      // 6. Submit the signed transaction
      const submitResponse = await this.blockchainService.submitTransaction({
        transaction: txToSubmitOnChain.to_hex(),
        signatures: [] // Signatures are already added to the transaction
      });

      // 7. Update the transaction with the hash
      await this.transactionsService.updateTransactionHash(
        transaction.id,
        submitResponse.txHash
      );

      const result: LpTokenOperationResult = {
        success: true,
        transactionId: submitResponse.txHash,
        message: 'LP tokens extracted successfully',
        transaction: await this.transactionsService.getTransaction(submitResponse.txHash)
      };
      return result;
    } catch (error) {
      this.logger.error(
        `Failed to extract LP tokens: ${error.message}`,
        error.stack,
      );
      throw new InternalServerErrorException('Failed to process LP token extraction');
    }
  }

  /**
   * Burns LP tokens from a specified wallet
   * @param walletAddress The wallet address that holds the LP tokens
   * @param amount The amount of LP tokens to burn
   * @returns Operation result with success status and transaction hash if successful
   * @param params Parameters for the burning operation
   * @returns Operation result with success status and transaction hash if successful
   */
  /**
   * Burns LP tokens from a specified wallet
   * @param burnDto - DTO containing burn parameters
   * @returns Operation result with transaction details
   */
  async burnLpTokens(burnDto: any): Promise<LpTokenOperationResult> {
    const { walletAddress, amount } = burnDto;

    if (!this.isValidAddress(walletAddress)) {
      throw new BadRequestException('Invalid wallet address');
    }

    try {
      this.logger.log(
        `Burning ${amount} LP tokens from wallet ${walletAddress}`,
      );

      // TODO: Implement actual LP token burning logic
      // This is a placeholder implementation
      const transactionHash = this.generateMockTransactionHash();

      const result: LpTokenOperationResult = {
        success: true,
        transactionId: transactionHash,
        message: 'LP tokens burned successfully'
      };
      return result;
    } catch (error) {
      this.logger.error(
        `Failed to burn LP tokens: ${error.message}`,
        error.stack,
      );
      throw new InternalServerErrorException('Failed to process LP token burn');
    }
  }

  /**
   * Drops LP tokens to a specified wallet
   * @param walletAddress The wallet address to receive the LP tokens
   * @param amount The amount of LP tokens to drop
   * @returns Operation result with success status and transaction hash if successful
   */
  /**
   * Drops LP tokens to a specified wallet
   * @param params Parameters for the drop operation
   * @returns Operation result with success status and transaction hash if successful
   */
  /**
   * Drops LP tokens to a specified wallet
   * @param dropDto - DTO containing drop parameters
   * @returns Operation result with transaction details
   */
  async distributeLpTokens(dropDto: any): Promise<LpTokenOperationResult> {
    const { walletAddress, amount } = dropDto;

    if (!this.isValidAddress(walletAddress)) {
      throw new BadRequestException('Invalid wallet address');
    }

    try {
      this.logger.log(
        `Dropping ${amount} LP tokens to wallet ${walletAddress}`,
      );

      // TODO: Implement actual LP token dropping logic
      // This is a placeholder implementation
      const transactionHash = this.generateMockTransactionHash();

      const result: LpTokenOperationResult = {
        success: true,
        transactionId: transactionHash,
        message: 'LP tokens distributed successfully'
      };
      return result;
    } catch (error) {
      this.logger.error(
        `Failed to drop LP tokens: ${error.message}`,
        error.stack,
      );
      throw new InternalServerErrorException('Failed to process LP token drop');
    }
  }

  /**
   * Validates a Cardano wallet address
   * @param address - The wallet address to validate
   * @returns boolean indicating if the address is valid
   */
  private isValidAddress(address: string): boolean {
    // Basic validation for Cardano addresses
    // Supports both mainnet (addr1) and testnet (addr_test1) addresses
    return typeof address === 'string' &&
           (address.startsWith('addr1') ||
            address.startsWith('addr_test1') ||
            address.startsWith('stake1') ||
            address.startsWith('stake_test1'));
  }

  /**
   * Generates a mock transaction hash for testing
   * @returns A mock transaction hash string
   */
  private generateMockTransactionHash(): string {
    return '0x' + Math.random().toString(16).substr(2, 64);
  }
}
