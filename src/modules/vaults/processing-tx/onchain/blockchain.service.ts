import { FixedTransaction, PrivateKey } from '@emurgo/cardano-serialization-lib-nodejs';
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

export interface ApplyParamsPayload {
  params: Record<string, any[]>;
  blueprint: {
    title: string;
    version: string;
  };
}

export interface ApplyParamsResponse {
  preloadedScript: {
    blueprint: {
      preamble: any;
      validators: Array<{
        title: string;
        hash: string;
      }>;
    };
  };
}

export interface UploadBlueprintPayload {
  blueprint: {
    preamble: any;
    validators: any[];
  };
  refs?: Record<string, { txHash: string; index: number }>;
}

@Injectable()
export class BlockchainService {
  private readonly logger = new Logger(BlockchainService.name);
  private readonly anvilApi: string;
  private readonly unparametizedDispatchHash: string;
  private readonly blueprintTitle: string;
  private readonly adminSKey: string;
  private readonly adminAddress: string;
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
      console.error('Full submission error:', error);
      this.logger.error('Error submitting transaction', error.message);
      throw new Error(`Failed to submit transacti ${error.message}`);
    }
  }

  /**
   * Register Stake on Dispatch Script to be able Contributors claim ADA
   *
   * Should Register after Extraction Action
   *
   * @param parameterizedDispatchHash
   * @returns
   */
  async registerScriptStake(parameterizedDispatchHash: string): Promise<boolean> {
    try {
      const input = {
        changeAddress: this.adminAddress,
        deposits: [
          {
            hash: parameterizedDispatchHash,
            type: 'script',
            deposit: 'stake',
          },
        ],
      };

      const buildResponse = await fetch(`${this.anvilApi}/transactions/build`, {
        method: 'POST',
        headers: this.anvilHeaders,
        body: JSON.stringify(input),
      });

      if (!buildResponse.ok) {
        const errorText = await buildResponse.text();
        throw new Error(`Build failed: ${buildResponse.status} - ${errorText}`);
      }

      const transaction = await buildResponse.json();
      const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(transaction.complete, 'hex'));
      txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

      const submitResponse = await fetch(`${this.anvilApi}/transactions/submit`, {
        method: 'POST',
        headers: this.anvilHeaders,
        body: JSON.stringify({
          signatures: [],
          transaction: txToSubmitOnChain.to_hex(),
        }),
      });

      if (!submitResponse.ok) {
        const errorText = await submitResponse.text();
        throw new Error(`Submit failed: ${submitResponse.status} - ${errorText}`);
      }

      return true;
    } catch (error) {
      this.logger.error('Error on registerScriptStake', error);
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
}
