import { Buffer } from 'node:buffer';

import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { FixedTransaction, Address } from '@emurgo/cardano-serialization-lib-nodejs';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BlockchainService } from '../../processing-tx/onchain/blockchain.service';
import { getUtxosExtract } from '../../processing-tx/onchain/utils/lib';

import { SystemSettingsService } from '@/modules/globals/system-settings/system-settings.service';

export interface BuildGovernanceFeeTransactionParams {
  userAddress: string;
  proposalType: string;
  vaultId: string;
}

export interface GovernanceFeeTransactionResponse {
  presignedTx: string;
  feeAmount: number;
}

/**
 * Service for handling governance fee payment transactions
 * Users pay fees in ADA to the admin address when creating proposals or voting
 */
@Injectable()
export class GovernanceFeeService {
  private readonly logger = new Logger(GovernanceFeeService.name);
  private readonly adminAddress: string;
  private readonly isMainnet: boolean;
  private blockfrost: BlockFrostAPI;

  constructor(
    private readonly configService: ConfigService,
    private readonly systemSettingsService: SystemSettingsService,
    @Inject(BlockchainService)
    private readonly blockchainService: BlockchainService
  ) {
    this.adminAddress = this.configService.get<string>('ADMIN_ADDRESS');
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_API_KEY'),
    });
  }

  /**
   * Get the fee amount for a specific proposal type
   */
  getProposalFee(proposalType: string): number {
    return this.systemSettingsService.getGovernanceFeeForProposalType(proposalType);
  }

  /**
   * Get the voting fee amount
   */
  getVotingFee(): number {
    return this.systemSettingsService.governanceFeeVoting;
  }

  /**
   * Build a governance fee payment transaction for proposal creation
   * This creates a simple ADA payment from user to admin address
   */
  async buildProposalFeeTransaction(
    params: BuildGovernanceFeeTransactionParams
  ): Promise<GovernanceFeeTransactionResponse> {
    try {
      const feeAmount = this.getProposalFee(params.proposalType);

      // If fee is 0, return empty response - no transaction needed
      if (feeAmount <= 0) {
        return {
          presignedTx: '',
          feeAmount: 0,
        };
      }

      // Get user's UTXOs
      const { utxos, totalAdaCollected } = await getUtxosExtract(
        Address.from_bech32(params.userAddress),
        this.blockfrost,
        {
          validateUtxos: false,
          maxUtxos: 200,
        }
      );

      if (totalAdaCollected < feeAmount + 2_000_000) {
        throw new Error(
          `Insufficient ADA in wallet - required: ${(feeAmount + 2_000_000) / 1_000_000} ADA, available: ${totalAdaCollected / 1_000_000} ADA`
        );
      }

      const proposalTypeLabel = this.getProposalTypeLabel(params.proposalType);
      const input = {
        changeAddress: params.userAddress,
        message: `Governance fee for creating ${proposalTypeLabel} proposal`,
        utxos: utxos,
        outputs: [
          {
            address: this.adminAddress,
            lovelace: feeAmount,
          },
        ],

        validityInterval: {
          start: true,
          end: true,
        },
        network: this.isMainnet ? ('mainnet' as const) : ('preprod' as const),
      };

      // Build the transaction using BlockchainService
      const buildResponse = await this.blockchainService.buildTransaction(input);

      // Sign the transaction with admin key
      const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));

      return {
        presignedTx: txToSubmitOnChain.to_hex(),
        feeAmount,
      };
    } catch (error) {
      this.logger.error(`Failed to build governance fee transaction: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Build a governance fee payment transaction for voting
   */
  async buildVotingFeeTransaction(params: {
    userAddress: string;
    proposalId: string;
  }): Promise<GovernanceFeeTransactionResponse> {
    try {
      const feeAmount = this.getVotingFee();

      // If fee is 0, return empty response - no transaction needed
      if (feeAmount <= 0) {
        return {
          presignedTx: '',
          feeAmount: 0,
        };
      }

      // Get user's UTXOs
      const { utxos, totalAdaCollected } = await getUtxosExtract(
        Address.from_bech32(params.userAddress),
        this.blockfrost,
        {
          validateUtxos: false,
          maxUtxos: 200,
        }
      );

      if (totalAdaCollected < feeAmount + 2_000_000) {
        throw new Error(
          `Insufficient ADA in wallet - required: ${(feeAmount + 2_000_000) / 1_000_000} ADA, available: ${totalAdaCollected / 1_000_000} ADA`
        );
      }

      const input = {
        changeAddress: params.userAddress,
        message: `Governance fee for voting on proposal`,
        utxos: utxos,
        outputs: [
          {
            address: this.adminAddress,
            lovelace: feeAmount,
          },
        ],
        validityInterval: {
          start: true,
          end: true,
        },
        network: this.isMainnet ? ('mainnet' as const) : ('preprod' as const),
      };

      // Build the transaction using BlockchainService
      const buildResponse = await this.blockchainService.buildTransaction(input);

      // Sign the transaction with admin key
      const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));

      return {
        presignedTx: txToSubmitOnChain.to_hex(),
        feeAmount,
      };
    } catch (error) {
      this.logger.error(`Failed to build voting fee transaction: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Get a user-friendly label for a proposal type
   */
  private getProposalTypeLabel(proposalType: string): string {
    const labels: Record<string, string> = {
      staking: 'Staking',
      distribution: 'Distribution',
      termination: 'Termination',
      burning: 'Burning',
      marketplace_action: 'Marketplace Action',
      expansion: 'Expansion',
    };
    return labels[proposalType] || proposalType;
  }
}
