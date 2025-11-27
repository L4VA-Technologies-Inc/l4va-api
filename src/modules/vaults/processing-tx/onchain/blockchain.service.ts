import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import {
  FixedTransaction,
  PrivateKey,
  Transaction as CardanoTransaction,
} from '@emurgo/cardano-serialization-lib-nodejs';
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

import { UTxOInsufficientException } from './exceptions/utxo-insufficient.exception';
import { MissingUtxoException } from './exceptions/utxo-missing.exception';
import { ValidityIntervalException } from './exceptions/validity-interval.exception';
import { VaultValidationException } from './exceptions/vault-validation.exception';
import {
  ApplyParamsPayload,
  ApplyParamsResponse,
  TransactionBuildResponse,
  TransactionSubmitResponse,
  UploadBlueprintPayload,
} from './types/transaction-status.enum';

@Injectable()
export class BlockchainService {
  private readonly logger = new Logger(BlockchainService.name);
  private readonly anvilApi: string;
  private readonly unparametizedDispatchHash: string;
  private readonly blueprintTitle: string;
  private readonly adminSKey: string;
  private readonly adminAddress: string;
  private readonly blockfrost: BlockFrostAPI;
  private readonly anvilHeaders: {
    [key: string]: string;
  };

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService
  ) {
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');
    this.adminAddress = this.configService.get<string>('ADMIN_ADDRESS');
    this.anvilApi = this.configService.get<string>('ANVIL_API_URL') + '/services';
    this.unparametizedDispatchHash = this.configService.get<string>('DISPATCH_SCRIPT_HASH');
    this.blueprintTitle = this.configService.get<string>('BLUEPRINT_TITLE');
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_TESTNET_API_KEY'),
    });
    this.anvilHeaders = {
      'x-api-key': this.configService.get<string>('ANVIL_API_KEY'),
      'Content-Type': 'application/json',
    };
  }

  /**
   * Builds a transaction using Anvil API
   * @param txData Transaction data to be built
   * @returns Object containing complete and partial transaction CBOR
   */
  async buildTransaction(txData: any): Promise<TransactionBuildResponse> {
    try {
      const contractDeployed = await fetch(`${this.anvilApi}/transactions/build`, {
        method: 'POST',
        headers: this.anvilHeaders,
        body: JSON.stringify(txData),
      });

      const buildResponse = await contractDeployed.json();

      if (!buildResponse.complete) {
        // Handle "No utxo with at least X lovelace" error
        if (buildResponse.message?.includes('No utxo with at least') && buildResponse.message?.includes('lovelace')) {
          const match = buildResponse.message.match(/No utxo with at least (\d+) lovelace/);
          const requiredLovelace = match ? parseInt(match[1]) : undefined;

          this.logger.warn(
            `Specific UTxO requirement during transaction build '${txData?.message ? txData.message : ''}' not met: ${requiredLovelace} lovelace`
          );
          throw new UTxOInsufficientException(buildResponse.message, requiredLovelace);
        }

        // Handle general balance insufficient errors
        if (
          buildResponse.message?.includes('UTxO Balance Insufficient') ||
          buildResponse.message?.includes('Balance Insufficient') ||
          buildResponse.message?.includes('Insufficient input')
        ) {
          this.logger.warn(`UTxO Balance Insufficient error: ${JSON.stringify(buildResponse)}`);
          throw new UTxOInsufficientException(buildResponse.message);
        }

        if (
          buildResponse.message?.includes('Unknown transaction input') ||
          buildResponse.message?.includes('missing from UTxO set')
        ) {
          // Try to extract the specific UTxO reference
          const match = buildResponse.message.match(/([a-f0-9]{64})#(\d+)/);

          if (match) {
            const txHash = match[1];
            const outputIndex = parseInt(match[2]);

            this.logger.warn(`Missing UTxO reference: ${txHash}#${outputIndex}`);
            throw new MissingUtxoException(txHash, outputIndex);
          } else {
            this.logger.warn(`Missing UTxO reference: ${buildResponse.message}`);
            throw new MissingUtxoException();
          }
        }

        if (
          buildResponse.message?.includes('Failed to evaluate tx') &&
          (buildResponse.message?.includes('Some scripts of the transactions terminated with error') ||
            buildResponse.message?.includes('Some of the scripts failed to evaluate to a positive outcome'))
        ) {
          this.logger.warn(`Vault validation error during transaction building`);
          throw new VaultValidationException();
        }

        throw new Error('Failed to build complete transaction' + JSON.stringify(buildResponse));
      }

      return buildResponse;
    } catch (error) {
      if (
        error instanceof UTxOInsufficientException ||
        error instanceof MissingUtxoException ||
        error instanceof VaultValidationException
      ) {
        throw error;
      }

      this.logger.error('Error building transaction', error);
      throw new Error(`Failed to build transaction: ${error.message}`);
    }
  }

  /**
   * Submits a signed transaction to the blockchain
   * @param signedTx Signed transaction data
   * @returns Transaction hash
   */
  async submitTransaction(signedTx: {
    transaction: string;
    signatures?: string[];
  }): Promise<TransactionSubmitResponse> {
    try {
      const response = await firstValueFrom(
        this.httpService.post<{ txHash: string }>(
          `${this.anvilApi}/transactions/submit`,
          {
            transaction: signedTx.transaction,
            signatures: signedTx.signatures || [],
          },
          {
            headers: this.anvilHeaders,
          }
        )
      );

      if (!response.data.txHash) {
        throw new Error('No transaction hash returned from blockchain');
      }

      this.logger.log(`Transaction submitted successfully: ${response.data.txHash}`);
      return { txHash: response.data.txHash };
    } catch (error) {
      if (error.response?.status === 422 && error.response?.data?.message) {
        const errorMessage = error.response.data.message;

        if (errorMessage.includes('OutsideValidityIntervalUTxO') || errorMessage.includes('ValidityInterval')) {
          const validityInfo = this.parseValidityIntervalError(errorMessage);
          this.logger.warn(`Validity interval error during submission: ${JSON.stringify(validityInfo)}`);

          throw new ValidityIntervalException(
            validityInfo.invalidBefore,
            validityInfo.invalidHereafter,
            validityInfo.currentSlot,
            `Transaction validity window expired or not yet valid during submission. Please retry the transaction.`
          );
        }

        this.logger.error(`Transaction submission failed with validation error: ${errorMessage}`);
        throw new Error(`Transaction validation failed: ${errorMessage}`);
      }

      // Log the full error for debugging
      this.logger.error('Full submission error:', error);
      this.logger.error('Error submitting transaction', error.message);
      throw new Error(`Failed to submit transaction ${error.message}`);
    }
  }

  /**
   * Register Stake on Dispatch Script to be able Contributors claim ADA
   * Handles cases where stake is already registered and waits for confirmation
   * Includes retry logic for validity interval errors
   *
   * @param parameterizedDispatchHash
   * @returns {Promise<{success: boolean, alreadyRegistered: boolean, txHash?: string}>}
   */
  async registerScriptStake(
    parameterizedDispatchHash: string,
    maxRetries: number = 3
  ): Promise<{ success: boolean; alreadyRegistered: boolean; txHash?: string }> {
    let retryCount = 0;

    while (retryCount <= maxRetries) {
      try {
        // First check if stake is already registered
        const isAlreadyRegistered = await this.checkStakeRegistration(parameterizedDispatchHash);

        if (isAlreadyRegistered) {
          this.logger.log(`Stake credential ${parameterizedDispatchHash} already registered`);
          return { success: true, alreadyRegistered: true };
        }

        const stakeRegisterInput = {
          changeAddress: this.adminAddress,
          deposits: [
            {
              hash: parameterizedDispatchHash,
              type: 'script',
              deposit: 'stake',
            },
          ],
        };

        let buildResult: TransactionBuildResponse;

        try {
          buildResult = await this.buildTransaction(stakeRegisterInput);
        } catch (error) {
          // Check if error is because stake is already registered during build
          if (error.message && error.message.includes('StakeKeyRegisteredDELEG')) {
            this.logger.log(
              `Stake credential ${parameterizedDispatchHash} already registered according to build error`
            );
            return { success: true, alreadyRegistered: true };
          }
          throw error;
        }

        // Sign the transaction
        const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResult.complete, 'hex'));
        txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

        // Submit transaction using existing method
        let submitResult: TransactionSubmitResponse;

        try {
          submitResult = await this.submitTransaction({
            transaction: txToSubmitOnChain.to_hex(),
            signatures: [],
          });
        } catch (error) {
          // Check if error is because stake is already registered during submit
          if (error.message && error.message.includes('StakeKeyRegisteredDELEG')) {
            this.logger.log(
              `Stake credential ${parameterizedDispatchHash} already registered according to submit error`
            );
            return { success: true, alreadyRegistered: true };
          }

          // Handle validity interval errors with retry
          if (error instanceof ValidityIntervalException) {
            retryCount++;
            if (retryCount <= maxRetries) {
              this.logger.warn(
                `ValidityIntervalException on stake registration attempt ${retryCount}/${maxRetries}. ` +
                  `Current slot: ${error.currentSlot}, Valid range: ${error.invalidBefore}-${error.invalidHereafter}. ` +
                  `Retrying in 3 seconds...`
              );

              // Wait before retry to let the validity window advance
              await new Promise(resolve => setTimeout(resolve, 3000));
              continue;
            } else {
              this.logger.error(
                `ValidityIntervalException: Maximum retries (${maxRetries}) exceeded for stake registration. ` +
                  `Current slot: ${error.currentSlot}, Valid range: ${error.invalidBefore}-${error.invalidHereafter}`
              );
              throw error;
            }
          }

          throw error;
        }

        this.logger.log(`Stake registration transaction submitted: ${submitResult.txHash}`);

        // Wait for transaction confirmation using existing method
        const confirmed = await this.waitForTransactionConfirmation(submitResult.txHash, 300000);

        if (confirmed) {
          this.logger.log(`Stake credential ${parameterizedDispatchHash} registered and confirmed successfully`);
          return {
            success: true,
            alreadyRegistered: false,
            txHash: submitResult.txHash,
          };
        } else {
          this.logger.warn(`Stake registration transaction ${submitResult.txHash} submitted but confirmation timeout`);
          // Still return success as transaction was submitted, just didn't get confirmation within timeout
          return {
            success: true,
            alreadyRegistered: false,
            txHash: submitResult.txHash,
          };
        }
      } catch (error) {
        // If it's not a ValidityIntervalException, or we've exceeded retries, break the loop
        if (!(error instanceof ValidityIntervalException) || retryCount > maxRetries) {
          this.logger.error('Error on registerScriptStake', error);
          return { success: false, alreadyRegistered: false };
        }
        // ValidityIntervalException will be handled by the continue statement above
      }
    }

    // This should never be reached, but just in case
    this.logger.error(`Unexpected end of retry loop for stake registration`);
    return { success: false, alreadyRegistered: false };
  }

  /**
   * Check if a stake credential is already registered
   * @param scriptHash The script hash to check
   * @returns true if registered, false otherwise
   */
  private async checkStakeRegistration(scriptHash: string): Promise<boolean> {
    try {
      const stakeAddress = `stake_test1${scriptHash}`;

      try {
        const accountInfo = await this.blockfrost.accounts(stakeAddress);
        // If we get account info without error, the stake address is registered
        return accountInfo.active === true;
      } catch (blockfrostError: any) {
        if (blockfrostError.status_code === 404) {
          // 404 means stake address is not registered
          return false;
        }
        // Other errors might indicate network issues, so we'll assume not registered
        return false;
      }
    } catch (error) {
      this.logger.warn(`Error in checkStakeRegistration for ${scriptHash}:`, error);
      return false;
    }
  }

  /**
   * Apply parameters to a blueprint script
   * @param payload Parameters to apply to the script
   * @returns Applied parameters result
   */
  async applyBlueprintParameters(payload: ApplyParamsPayload): Promise<ApplyParamsResponse> {
    try {
      const response = await fetch(`${this.anvilApi}/blueprints/apply-params`, {
        method: 'POST',
        headers: this.anvilHeaders,
        body: JSON.stringify(payload),
      });

      const result = await response.json();

      if (!result.preloadedScript) {
        this.logger.error(`Failed to apply parameters: ${response.statusText}`);
        throw new Error('Failed to apply parameters to blueprint');
      }

      this.logger.log('Blueprint parameters applied successfully');
      return result;
    } catch (error) {
      this.logger.error('Error applying blueprint parameters', error);
      throw new Error(`Failed to apply blueprint parameters: ${error.message}`);
    }
  }

  /**
   * Upload a blueprint to the service
   * @param payload Blueprint data to upload
   * @returns Upload response
   */
  async uploadBlueprint(payload: UploadBlueprintPayload): Promise<any> {
    try {
      const response = await fetch(`${this.anvilApi}/blueprints`, {
        method: 'POST',
        headers: this.anvilHeaders,
        body: JSON.stringify(payload),
      });

      const result = await response.json();
      this.logger.log('Blueprint uploaded successfully');
      return result;
    } catch (error) {
      this.logger.error('Error uploading blueprint', error);
      throw new Error(`Failed to upload blueprint: ${error.message}`);
    }
  }

  private parseValidityIntervalError(errorMessage: string): {
    invalidBefore?: number;
    invalidHereafter?: number;
    currentSlot?: number;
  } {
    // Parse: OutsideValidityIntervalUTxO (ValidityInterval {invalidBefore = SJust (SlotNo 103557269), invalidHereafter = SJust (SlotNo 103564469)}) (SlotNo 103557260)
    const validityMatch = errorMessage.match(
      /OutsideValidityIntervalUTxO.*?invalidBefore = SJust \(SlotNo (\d+)\).*?invalidHereafter = SJust \(SlotNo (\d+)\).*?\(SlotNo (\d+)\)/
    );

    if (validityMatch) {
      return {
        invalidBefore: parseInt(validityMatch[1]),
        invalidHereafter: parseInt(validityMatch[2]),
        currentSlot: parseInt(validityMatch[3]),
      };
    }

    // Alternative parsing for different error formats
    const slotMatch = errorMessage.match(/SlotNo (\d+)/g);
    if (slotMatch && slotMatch.length >= 3) {
      const slots = slotMatch.map(s => parseInt(s.match(/\d+/)[0]));
      return {
        invalidBefore: slots[0],
        invalidHereafter: slots[1],
        currentSlot: slots[2],
      };
    }

    return {};
  }

  /**
   * Apply parameters to the dispatch script
   * @param vault_policy - PolicyId of the vault
   * @param vault_id - ByteArray vault identifier
   * @param contribution_script_hash - ByteArray contribution script hash
   * @param unparametizedDispatchHash - Unparameterized dispatch script hash
   * @returns The parameterized script hash and full response
   */
  async applyDispatchParameters(params: {
    vault_policy: string;
    vault_id: string;
    contribution_script_hash: string;
  }): Promise<{
    parameterizedHash: string;
    fullResponse: ApplyParamsResponse;
  }> {
    try {
      const applyParamsResult = await this.applyBlueprintParameters({
        params: {
          [this.unparametizedDispatchHash]: [params.vault_policy, params.vault_id, params.contribution_script_hash],
        },
        blueprint: {
          title: this.blueprintTitle,
          version: '0.1.1',
        },
      });

      // Find the parameterized dispatch script hash
      const parameterizedScript = applyParamsResult.preloadedScript.blueprint.validators.find(
        (v: any) => v.title === 'dispatch.dispatch.spend' && v.hash !== this.unparametizedDispatchHash
      );

      if (!parameterizedScript) {
        throw new Error('Failed to find parameterized dispatch script hash');
      }

      return {
        parameterizedHash: parameterizedScript.hash,
        fullResponse: applyParamsResult,
      };
    } catch (error) {
      this.logger.error('Error applying dispatch parameters', error);
      throw new Error(`Failed to apply dispatch parameters: ${error.message}`);
    }
  }

  /**
   * Waits for a transaction to be confirmed on the blockchain
   * @param txHash Transaction hash to monitor
   * @param maxWaitTime Maximum time to wait in milliseconds (default: 10 minutes)
   * @param checkInterval Interval between checks in milliseconds (default: 20 seconds)
   * @returns Promise<boolean> - true if confirmed, false if timeout
   */
  async waitForTransactionConfirmation(
    txHash: string,
    maxWaitTime: number = 600000, // 10 minutes default
    checkInterval: number = 20000 // 20 seconds default
  ): Promise<boolean> {
    const startTime = Date.now();
    this.logger.log(`Starting confirmation watch for transaction ${txHash}`);

    while (Date.now() - startTime < maxWaitTime) {
      try {
        const txDetails = await this.blockfrost.txs(txHash);
        if (txDetails && txDetails.block_height) {
          await new Promise(resolve => setTimeout(resolve, 40000));
          return true;
        }

        // Wait before next check
        await new Promise(resolve => setTimeout(resolve, checkInterval));
      } catch (error) {
        await new Promise(resolve => setTimeout(resolve, checkInterval));
      }
    }

    this.logger.warn(`Transaction ${txHash} confirmation timeout after ${maxWaitTime / 1000} seconds`);
    return false;
  }

  getTransactionSize(txHex: string): number {
    const tx = CardanoTransaction.from_bytes(Buffer.from(txHex, 'hex'));
    return tx.to_bytes().length;
  }
}
