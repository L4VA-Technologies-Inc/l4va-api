import {Injectable, Logger, NotFoundException} from '@nestjs/common';
import { AnvilApiService } from './anvil-api.service';
import { TransactionsService } from '../transactions/transactions.service';
import { BlockchainWebhookDto } from './dto/webhook.dto';
import { OnchainTransactionStatus } from './types/transaction-status.enum';
import { TransactionStatus } from '../../types/transaction.types';
import {VaultsService} from '../vaults/vaults.service';
import {BlockchainScannerService} from './blockchain-scanner.service';
import {InjectRepository} from '@nestjs/typeorm';
import {Vault} from '../../database/vault.entity';
import {Repository} from 'typeorm';

export interface NftAsset {
  policyId: string;
  assetName: string;
  quantity: number;
}

export interface BuildTransactionOutput {
  address: string;
  lovelace?: number;
  assets?: NftAsset[];
}

export interface BuildTransactionParams {
  changeAddress: string;
  txId: string;
  outputs: BuildTransactionOutput[];
}

export interface SubmitTransactionParams {
  transaction: string; // CBOR encoded transaction
  vaultId: string;
  signatures?: string[]; // Optional array of signatures
}

export interface TransactionBuildResponse {
  hash: string;
  complete: string; // CBOR encoded complete transaction
  stripped: string; // CBOR encoded stripped transaction
  witnessSet: string; // CBOR encoded witness set
}

export interface TransactionSubmitResponse {
  txHash: string;
}

@Injectable()
export class BlockchainTransactionService {

  private readonly logger = new Logger(BlockchainTransactionService.name);
  constructor(
    @InjectRepository(Vault)
    private readonly vaultsRepository: Repository<Vault>,
    private readonly anvilApiService: AnvilApiService,
    private readonly transactionsService: TransactionsService,
    private readonly blockchainScanner: BlockchainScannerService
  ) {}

  async buildTransaction(params: BuildTransactionParams): Promise<TransactionBuildResponse> {
    try {
      // Validate that the transaction exists and get its current state
      await this.transactionsService.validateTransactionExists(params.txId);

      const result = await this.anvilApiService.buildTransaction(params);

      // Update the outchain transaction with the onchain transaction hash
      await this.transactionsService.updateTransactionHash(params.txId, result.hash);

      return result;
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }

  async submitTransaction(params: SubmitTransactionParams): Promise<any> {

    const vault = await this.vaultsRepository.findOne({
      where: {
        id: params.vaultId
      }
    });
    if(!vault){
      throw new Error('Vault is not defined!');
    }
    const txDetail = await this.blockchainScanner.getTransactionDetails(vault.publication_hash);

    const { output_amount } = txDetail;
    this.logger.log(JSON.stringify(output_amount[1].unit));

    const vaultPolicyPlusName = output_amount[1].unit;
    const policyId = vaultPolicyPlusName.slice(0,56);
    const assetName = vault.asset_vault_name


   // return this.anvilApiService.submitTransaction(params);
  }

  async handleBlockchainEvent(event: BlockchainWebhookDto): Promise<void> {
    // Only handle transaction events
    if (event.type !== 'transaction') {
      return;
    }

    // Process each transaction in the payload
    for (const txEvent of event.payload) {
      const { tx, inputs, outputs } = txEvent;

      // Determine transaction status based on blockchain data
      let status: OnchainTransactionStatus;
      if (!tx.block || !tx.block_height) {
        status = OnchainTransactionStatus.PENDING;
      } else if (tx.valid_contract === false) {
        status = OnchainTransactionStatus.FAILED;
      } else if (tx.valid_contract === true) {
        status = OnchainTransactionStatus.CONFIRMED;
      } else {
        status = OnchainTransactionStatus.PENDING;
      }

      // Map onchain status to internal transaction status
      const statusMap: Record<OnchainTransactionStatus, TransactionStatus> = {
        [OnchainTransactionStatus.PENDING]: TransactionStatus.pending,
        [OnchainTransactionStatus.CONFIRMED]: TransactionStatus.confirmed,
        [OnchainTransactionStatus.FAILED]: TransactionStatus.failed,
        [OnchainTransactionStatus.NOT_FOUND]: TransactionStatus.stuck
      };

      // Update transaction status
      const internalStatus = statusMap[status];
      await this.transactionsService.updateTransactionStatus(tx.hash, internalStatus);

      // For confirmed transactions, analyze the transfer
      if (status === OnchainTransactionStatus.CONFIRMED) {
        const transferDetails = {
          txHash: tx.hash,
          blockHeight: tx.block_height,
          timestamp: tx.block_time,
          fee: tx.fees,
          sender: inputs[0]?.address, // Usually the first input is the sender
          transfers: []
        };

        // Analyze each output
        for (const output of outputs) {
          const { address, amount } = output;

          // Skip change outputs (outputs back to sender)
          if (address === transferDetails.sender) {
            continue;
          }

          // Process each asset in the output
          for (const asset of amount) {
            if (asset.unit === 'lovelace') {
              // ADA transfer
              transferDetails.transfers.push({
                type: 'ADA',
                recipient: address,
                amount: (parseInt(asset.quantity) / 1_000_000).toString(), // Convert lovelace to ADA
                unit: 'ADA'
              });
            } else if (asset.quantity === '1') {
              // NFT transfer
              transferDetails.transfers.push({
                type: 'NFT',
                recipient: address,
                policyId: asset.unit.slice(0, 56),
                assetName: asset.unit.slice(56),
                unit: asset.unit
              });
            } else {
              // Other token transfer
              transferDetails.transfers.push({
                type: 'TOKEN',
                recipient: address,
                amount: asset.quantity,
                unit: asset.unit
              });
            }
          }
        }

        // Log transfer details
        console.log('Transaction details:', JSON.stringify(transferDetails, null, 2));
      }
    }
  }
}
