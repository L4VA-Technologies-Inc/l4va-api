import {Injectable, Logger, NotFoundException} from '@nestjs/common';
import { AnvilApiService } from './anvil-api.service';
import { TransactionsService } from '../transactions/transactions.service';
import { BlockchainWebhookDto } from './dto/webhook.dto';
import { OnchainTransactionStatus } from './types/transaction-status.enum';
import { TransactionStatus } from '../../types/transaction.types';
import {BlockchainScannerService} from './blockchain-scanner.service';
import {InjectRepository} from '@nestjs/typeorm';
import {Vault} from '../../database/vault.entity';
import {Repository} from 'typeorm';
import {
  EnterpriseAddress,
  ScriptHash,
  Credential,
  FixedTransaction,
  PrivateKey
} from '@emurgo/cardano-serialization-lib-nodejs';
import {applyContributeParams, toPreloadedScript} from './utils/apply_params';
import {Datum} from './types/type';
import {ConfigService} from '@nestjs/config';
import {BlockFrostAPI} from '@blockfrost/blockfrost-js';
import {Buffer} from 'node:buffer';
import * as blueprint from './utils/blueprint.json';
import {SubmitTransactionDto} from './dto/transaction.dto';


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
  private readonly adminHash: string;
  private readonly anvilApi: string;
  private readonly anvilApiKey: string;
  private readonly adminSKey: string;
  private blockfrost: any;
  constructor(
    @InjectRepository(Vault)
    private readonly vaultsRepository: Repository<Vault>,
    private readonly anvilApiService: AnvilApiService,
    private readonly transactionsService: TransactionsService,
    private readonly blockchainScanner: BlockchainScannerService,
    private readonly configService: ConfigService
  ) {
    this.anvilApiKey = this.configService.get<string>('ANVIL_API_KEY');
    this.anvilApi = this.configService.get<string>('ANVIL_API_URL') + '/services';
    this.adminHash = this.configService.get<string>('ADMIN_KEY_HASH');
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_TESTNET_API_KEY')
    });
  }

  async buildTransaction(params: BuildTransactionParams): Promise<any> {
    try {
      // Validate that the transaction exists and get its current state
      const transaction = await this.transactionsService.validateTransactionExists(params.txId);

      const vault = await this.vaultsRepository.findOne({
        where: {
          id: transaction.vault_id,
        }
      });

      const txDetail = await this.blockchainScanner.getTransactionDetails(vault.publication_hash);

      const { output_amount } = txDetail;
      this.logger.log(JSON.stringify(output_amount[1].unit));

      const vaultPolicyPlusName = output_amount[1].unit;
      const VAULT_POLICY_ID = vaultPolicyPlusName.slice(0,56);
      const VAULT_ID = vaultPolicyPlusName.slice(56,vaultPolicyPlusName.length);

      const parameterizedScript = applyContributeParams({
        vault_policy_id: VAULT_POLICY_ID,
        vault_id: VAULT_ID,
      });
      const POLICY_ID = parameterizedScript.validator.hash;
      const SC_ADDRESS = EnterpriseAddress.new(
        0,
        Credential.from_scripthash(ScriptHash.from_hex(POLICY_ID))
      )
        .to_address()
        .to_bech32();

      const unparameterizedScript = blueprint.validators.find(
        (v) => v.title === 'contribute.contribute'
      );
      if (!unparameterizedScript) {
        throw new Error('Contribute validator not found');
      }

      const LAST_UPDATE_TX_HASH = vault.publication_hash; // todo need to understand where exactly we need to get it
      const LAST_UPDATE_TX_INDEX = 0;

      const input: {
        changeAddress: string;
        message: string;
        mint: Array<object>;
        scriptInteractions: object[];
        outputs: {
          address: string;
          assets: object[];
          lovelace: number;
          datum: { type: 'inline'; value: Datum; shape: object };
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
        changeAddress: params.changeAddress,
        message: 'Contribution NFT',
        mint: [
          {
            version: 'cip25',
            assetName: { name: VAULT_ID, format: 'hex' },
            policyId: POLICY_ID,
            type: 'plutus',
            quantity: 1000,
            metadata: {
            },
          },
        ],
        scriptInteractions: [
          {
            purpose: 'mint',
            hash: POLICY_ID,
            redeemer: {
              type: 'json',
              value: {
                quantity: 1000,
                output_index: 0,
                contribution: 'Lovelace',
              },
            },
          },
        ],
        outputs: [
          {
            address: SC_ADDRESS,
            lovelace: 10000000,
            assets: [
              {
                assetName: { name: VAULT_ID, format: 'hex' },
                policyId: POLICY_ID,
                quantity: 1000,
              },
              ...params.outputs[0].assets.map(asset => ({
                assetName: { name: asset.assetName, format: 'hex' },
                policyId: asset.policyId,
                quantity: asset.quantity,
              })),
            ],
            datum: {
              type: 'inline',
              value: {
                policy_id: POLICY_ID,
                asset_name: VAULT_ID,
                quantity: 1000,
                owner: params.changeAddress,
              },
              shape: {
                validatorHash: POLICY_ID,
                purpose: 'spend',
              },
            },
          },
        ],
        preloadedScripts: [
          toPreloadedScript(blueprint, {
            validators: [parameterizedScript.validator, unparameterizedScript],
          }),
        ],
        requiredSigners: [this.adminHash],
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
        network: 'preprod',
      };

      const headers = {
        'x-api-key': this.anvilApiKey,
        'Content-Type': 'application/json',
      };

      const contractDeployed = await fetch(`${this.anvilApi}/transactions/build`, {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
      });

      const buildResponse = await contractDeployed.json();
      console.log('build response', JSON.stringify(buildResponse));

      if (!buildResponse.complete) {
        throw new Error('Failed to build complete transaction');
      }


      const txToSubmitOnChain = FixedTransaction.from_bytes(
        Buffer.from(buildResponse.complete, 'hex'),
      );
      txToSubmitOnChain.sign_and_add_vkey_signature(
        PrivateKey.from_bech32(this.adminSKey),
      );

      return {
        presignedTx: txToSubmitOnChain.to_hex(),
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }

  async submitTransaction(signedTx: SubmitTransactionDto): Promise<any> {

    try{
      const headers = {
        'x-api-key': this.anvilApiKey,
        'Content-Type': 'application/json',
      };

      const urlSubmit = `${this.anvilApi}/transactions/submit`;

      const submitted = await fetch(urlSubmit, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          signatures: signedTx.signatures,
          transaction: signedTx.transaction,
        }),
      });

      const output = await submitted.json();
      console.log('output', output);

      await this.transactionsService.updateTransactionHash(signedTx.txId, output.txHash);
      return output;
    }catch(error){
      this.logger.log('TX Error sending', error);
      throw new Error('Failed to build complete transaction'+  JSON.stringify(error));
    }
  }

   // return this.anvilApiService.submitTransaction(params);

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
