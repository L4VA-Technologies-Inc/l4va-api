import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

import { UTxOInsufficientException } from './exceptions/utxo-insufficient.exception';
import { MissingUtxoException } from './exceptions/utxo-missing.exception';
import { ValidityIntervalException } from './exceptions/validity-interval.exception';
import { VaultValidationException } from './exceptions/vault-validation.exception';

export enum OnchainTransactionStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  FAILED = 'failed',
  NOT_FOUND = 'not_found',
}

export interface TransactionBuildResponse {
  complete: string;
  partial: string;
}

export interface TransactionSubmitResponse {
  txHash: string;
}

@Injectable()
export class BlockchainService {
  private readonly logger = new Logger(BlockchainService.name);
  private readonly anvilApi: string;
  private readonly anvilApiKey: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService
  ) {
    this.anvilApi = this.configService.get<string>('ANVIL_API_URL') + '/services';
    this.anvilApiKey = this.configService.get<string>('ANVIL_API_KEY');
  }

  /**
   * Builds a transaction using Anvil API
   * @param txData Transaction data to be built
   * @returns Object containing complete and partial transaction CBOR
   */
  async buildTransaction(txData: any): Promise<TransactionBuildResponse> {
    try {
      const headers = {
        'x-api-key': this.anvilApiKey,
        'Content-Type': 'application/json',
      };

      // Build the transaction
      const contractDeployed = await fetch(`${this.anvilApi}/transactions/build`, {
        method: 'POST',
        headers,
        body: JSON.stringify(txData),
      });

      const buildResponse = await contractDeployed.json();

      if (!buildResponse.complete) {
        // Check for vault script evaluation errors first
        if (
          buildResponse.message?.includes('Failed to evaluate tx') &&
          buildResponse.message?.includes('Some scripts of the transactions terminated with error') &&
          (buildResponse.code === 3010 || buildResponse.code === 3012)
        ) {
          this.logger.warn(`Vault validation error during transaction building`);
          throw new VaultValidationException('Validation error on vault during transaction building');
        }

        if (
          buildResponse.message?.includes('UTxO Balance Insufficient') ||
          buildResponse.message?.includes('Balance Insufficient')
        ) {
          this.logger.warn(`UTxO Balance Insufficient error: ${JSON.stringify(buildResponse)}`);
          throw new UTxOInsufficientException(buildResponse.message);
        }

        if (
          buildResponse.message?.includes('Unknown transaction input') ||
          buildResponse.message?.includes('missing from UTxO set')
        ) {
          // Try to extract the specific UTxO reference
          const match = buildResponse.message.match(
            /Unknown transaction input \(missing from UTxO set\): ([a-f0-9]+)#(\d+)/
          );
          if (match) {
            const [_, txHash, indexStr] = match;
            this.logger.warn(`Missing UTxO reference: ${txHash}#${indexStr}`);
            throw new MissingUtxoException(txHash, parseInt(indexStr));
          } else {
            this.logger.warn(`Missing UTxO reference (unspecified): ${buildResponse.message}`);
            throw new MissingUtxoException();
          }
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
            headers: {
              'x-api-key': this.anvilApiKey,
              'Content-Type': 'application/json',
            },
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

        if (errorMessage.includes('UTxO Balance Insufficient')) {
          this.logger.warn(`UTxO Balance Insufficient during submission: ${errorMessage}`);
          throw new UTxOInsufficientException(errorMessage);
        }

        if (errorMessage.includes('Unknown transaction input') || errorMessage.includes('missing from UTxO set')) {
          const match = errorMessage.match(/Unknown transaction input \(missing from UTxO set\): ([a-f0-9]+)#(\d+)/);
          if (match) {
            const [_, txHash, indexStr] = match;
            this.logger.warn(`Missing UTxO reference during submission: ${txHash}#${indexStr}`);
            throw new MissingUtxoException(txHash, parseInt(indexStr));
          } else {
            this.logger.warn(`Missing UTxO reference during submission: ${errorMessage}`);
            throw new MissingUtxoException();
          }
        }

        this.logger.error(`Transaction submission failed with validation error: ${errorMessage}`);
        throw new Error(`Transaction validation failed: ${errorMessage}`);
      }

      // Log the full error for debugging
      console.error('Full submission error:', error);
      this.logger.error('Error submitting transaction', error.message);
      throw new Error(`Failed to submit transaction: ${error.message}`);
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
