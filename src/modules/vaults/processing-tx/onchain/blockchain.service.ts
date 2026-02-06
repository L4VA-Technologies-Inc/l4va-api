import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

import { FeeTooSmallException } from './exceptions/fee-too-small.exception';
import { TxSizeExceededException } from './exceptions/tx-size-exceeded.exception';
import { UTxOInsufficientException } from './exceptions/utxo-insufficient.exception';
import { MissingUtxoException } from './exceptions/utxo-missing.exception';
import { UtxoSpentException } from './exceptions/utxo-spent.exception';
import { ValidityIntervalException } from './exceptions/validity-interval.exception';
import { ValueNotConservedException } from './exceptions/value-not-conserved.exception';
import { VaultValidationException } from './exceptions/vault-validation.exception';
import {
  ApplyParamsPayload,
  ApplyParamsResponse,
  TransactionBuildResponse,
  TransactionSubmitResponse,
  UploadBlueprintPayload,
  WayUpTransactionBuildResponse,
} from './types/transaction-status.enum';

import { WayUpTransactionInput } from '@/modules/wayup/wayup.types';

@Injectable()
export class BlockchainService {
  private readonly logger = new Logger(BlockchainService.name);
  private readonly anvilApi: string;
  private readonly unparametizedDispatchHash: string;
  private readonly blueprintTitle: string;
  private readonly networkId: number;
  private readonly blockfrost: BlockFrostAPI;
  private readonly anvilHeaders: {
    [key: string]: string;
  };

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService
  ) {
    this.anvilApi = this.configService.get<string>('ANVIL_API_URL') + '/services';
    this.unparametizedDispatchHash = this.configService.get<string>('DISPATCH_SCRIPT_HASH');
    this.blueprintTitle = this.configService.get<string>('BLUEPRINT_TITLE');
    this.networkId = Number(this.configService.get<string>('NETWORK_ID')) || 0;
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_API_KEY'),
    });
    this.anvilHeaders = {
      'x-api-key': this.configService.get<string>('ANVIL_API_KEY'),
      'Content-Type': 'application/json',
    };
  }

  getNetworkId(): number {
    return this.networkId;
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
          throw new UTxOInsufficientException(requiredLovelace);
        }

        // Handle general balance insufficient errors
        if (
          buildResponse.message?.includes('UTxO Balance Insufficient') ||
          buildResponse.message?.includes('Balance Insufficient') ||
          buildResponse.message?.includes('Insufficient input')
        ) {
          this.logger.warn(`UTxO Balance Insufficient error: ${JSON.stringify(buildResponse)}`);
          throw new UTxOInsufficientException();
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

        if (
          buildResponse.message?.includes('Maximum transaction size of') &&
          buildResponse.message?.includes('exceeded')
        ) {
          this.logger.warn(`Transaction size exceeded: ${buildResponse.message}`);
          throw TxSizeExceededException.fromErrorMessage(buildResponse.message);
        }

        throw new Error('Failed to build complete transaction' + JSON.stringify(buildResponse));
      }

      return buildResponse;
    } catch (error) {
      if (
        error instanceof UTxOInsufficientException ||
        error instanceof MissingUtxoException ||
        error instanceof VaultValidationException ||
        error instanceof FeeTooSmallException ||
        error instanceof TxSizeExceededException
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
      const requestPayload = {
        transaction: signedTx.transaction,
        signatures: signedTx.signatures || [],
      };

      const response = await firstValueFrom(
        this.httpService.post<{ txHash: string }>(`${this.anvilApi}/transactions/submit`, requestPayload, {
          headers: this.anvilHeaders,
        })
      );

      if (!response.data.txHash) {
        throw new Error('No transaction hash returned from blockchain');
      }

      this.logger.log(`Transaction submitted successfully: ${response.data.txHash}`);
      return { txHash: response.data.txHash };
    } catch (error) {
      if (error.response?.status === 422) {
        // Log full request and response for debugging 422 errors
        this.logger.error('=== 422 ERROR DETAILS ===');
        this.logger.error(
          'Request Payload:',
          JSON.stringify(
            {
              transaction: signedTx.transaction.substring(0, 200) + '...',
              signatures: signedTx.signatures || [],
              transactionLength: signedTx.transaction.length,
            },
            null,
            2
          )
        );
        this.logger.error('Full Error Response:', JSON.stringify(error.response.data, null, 2));
        this.logger.error('Response Status:', error.response.status);
        this.logger.error('Response Headers:', JSON.stringify(error.response.headers, null, 2));
        this.logger.error('========================');
      }

      if (error.response?.status === 422 && error.response?.data?.message) {
        const errorMessage = error.response.data.message;

        // Check for FeeTooSmallUTxO error
        if (errorMessage.includes('FeeTooSmallUTxO')) {
          throw FeeTooSmallException.fromErrorMessage(errorMessage);
        }

        // Check for BadInputsUTxO error (UTXO already spent)
        if (errorMessage.includes('BadInputsUTxO')) {
          const utxoMatch = errorMessage.match(
            /TxIn \(TxId \{unTxId = SafeHash "([a-f0-9]+)"\}\) \(TxIx \{unTxIx = (\d+)\}\)/
          );
          if (utxoMatch) {
            const [, txHash, outputIndex] = utxoMatch;
            throw new UtxoSpentException(txHash, parseInt(outputIndex));
          }
          throw new UtxoSpentException('unknown', 0, 'One or more transaction inputs have already been spent');
        }

        // Check for ValueNotConservedUTxO error
        if (errorMessage.includes('ValueNotConservedUTxO')) {
          const suppliedMatch = errorMessage.match(/mismatchSupplied = MaryValue \(Coin (\d+)\)/);
          const expectedMatch = errorMessage.match(/mismatchExpected = MaryValue \(Coin (\d+)\)/);

          const supplied = suppliedMatch ? `${parseInt(suppliedMatch[1]) / 1_000_000} ADA` : 'unknown';
          const expected = expectedMatch ? `${parseInt(expectedMatch[1]) / 1_000_000} ADA` : 'unknown';

          throw new ValueNotConservedException(supplied, expected);
        }

        // Existing validity interval check
        if (errorMessage.includes('OutsideValidityIntervalUTxO')) {
          const parsedError = this.parseValidityIntervalError(errorMessage);
          throw new ValidityIntervalException(
            parsedError.invalidBefore,
            parsedError.invalidHereafter,
            parsedError.currentSlot
          );
        }
      }

      // Log the full error for debugging
      this.logger.error('Full submission error:', error);
      this.logger.error('Error submitting transaction', error.message);
      throw new Error(`Failed to submit transaction: ${error.message}`);
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

  /**
   * Builds a WayUp marketplace transaction
   * @param input Transaction input containing utxos, changeAddress, and create/unlist/update/createOffer/buy arrays
   * @returns Transaction build response
   */
  async buildWayUpTransaction(input: WayUpTransactionInput): Promise<WayUpTransactionBuildResponse> {
    try {
      this.logger.log('Building WayUp transaction with input:', input);
      const response = await fetch(`https://prod.api.ada-anvil.app/marketplace/api/build-tx`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.configService.get<string>('ANVIL_API_KEY'),
        },
        body: JSON.stringify(input),
      });

      const buildResponse = await response.json();

      if (!buildResponse.transactions || buildResponse.transactions.length === 0) {
        throw new Error('Failed to build complete WayUp transaction: ' + JSON.stringify(buildResponse));
      }

      this.logger.log('WayUp transaction built successfully');
      return buildResponse;
    } catch (error) {
      this.logger.error('Error building WayUp transaction', error);
      throw new Error(`Failed to build WayUp transaction: ${error.message}`);
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
}
