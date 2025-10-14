// lucid-transaction-builder.service.ts
import { Address } from '@emurgo/cardano-serialization-lib-nodejs';
import {
  Blockfrost,
  Constr,
  Data,
  DatumJson,
  datumJsonToCbor,
  fromText,
  Lucid,
  LucidEvolution,
} from '@lucid-evolution/lucid';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TransactionsService } from '../offchain-tx/transactions.service';

import { BuildTransactionParams } from './vault-inserting.service';

import { Vault } from '@/database/vault.entity';

@Injectable()
export class LucidTransactionBuilderService {
  private readonly logger = new Logger(LucidTransactionBuilderService.name);
  private readonly adminSKey: string;
  private readonly adminAddress: string;
  private readonly scPolicyId: string;
  private lucid: LucidEvolution;

  constructor(
    @InjectRepository(Vault)
    private readonly vaultsRepository: Repository<Vault>,
    private readonly configService: ConfigService,
    private readonly transactionsService: TransactionsService
  ) {
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');
    this.adminAddress = this.configService.get<string>('ADMIN_ADDRESS');
    this.scPolicyId = this.configService.get<string>('SC_POLICY_ID');

    this.initializeLucid();
  }

  private async initializeLucid(): Promise<void> {
    this.lucid = await Lucid(
      new Blockfrost(
        'https://cardano-preprod.blockfrost.io/api/v0',
        this.configService.get<string>('BLOCKFROST_TESTNET_API_KEY')
      ),
      'Preprod'
    );
  }

  async buildAdaContribution(params: BuildTransactionParams): Promise<{ presignedTx: string }> {
    const transaction = await this.transactionsService.validateTransactionExists(params.txId);

    const vault = await this.vaultsRepository.findOne({
      where: {
        id: transaction.vault_id,
      },
    });

    if (!vault.publication_hash) {
      throw new Error('Vault publication hash not found - vault may not be properly published');
    }

    if (!vault.script_hash) {
      throw new Error('Vault script hash is missing - vault may not be properly configured');
    }

    const VAULT_ID = vault.asset_vault_name;
    const POLICY_ID = vault.script_hash;
    const quantity = params.outputs[0].assets[0].quantity * 1000000; // Convert to lovelace

    try {
      this.lucid.selectWallet.fromAddress(params.changeAddress, []);

      // Get user's UTXOs
      const userUtxos = await this.lucid.utxosAt(params.changeAddress);
      if (userUtxos.length === 0) {
        throw new Error('No UTXOs found for the user address');
      }

      // Find a UTxO containing a reference script
      const allUTxOs = await this.lucid.utxosByOutRef([
        { txHash: 'a12df9dc28f8682aa953204ce65c30c8e3a2e345808f50d628484f7b350b514b', outputIndex: 0 },
      ]);
      const refScriptUTxO = allUTxOs.filter(utxo => utxo.scriptRef)[0];

      if (!refScriptUTxO) {
        throw new Error('No reference script UTxO found for the vault');
      }

      const vaultUtxos = await this.lucid.utxosByOutRef([
        { txHash: vault.publication_hash, outputIndex: 0 }, // Vault UTxO is usually at index 0
      ]);
      const vaultUTxO = vaultUtxos[0];

      if (!vaultUTxO) {
        throw new Error('Vault UTxO not found');
      }

      const addressHex = Buffer.from(Address.from_bech32(params.changeAddress).to_bytes()).toString('hex');

      /* For datum: 
      {
        value: {
          policy_id: CONTRIBUTION_SCRIPT_HASH,
          asset_name: VAULT_ID,
          owner: params.changeAddress,
          },
        shape: {
            validatorHash: CONTRIBUTION_SCRIPT_HASH,
            purpose: 'spend',
          },
        type: 'inline',
       },
      */
      const anvilDatum: DatumJson = {
        constructor: '0', // Constructor index 0 for AssetDatum
        fields: [
          { bytes: POLICY_ID }, // policy_id: PolicyId
          { bytes: VAULT_ID }, // asset_name: AssetName
          { bytes: addressHex }, // owner: Address as hex bytes
          { constructor: '1', fields: [] }, // datum_tag: Option<ByteArray>::None
        ],
      };

      const contributionDatum = Data.to(new Constr(0, [POLICY_ID, VAULT_ID, addressHex]));

      const contributionDatum2 = datumJsonToCbor(anvilDatum);

      // For redeemer: { output_index: 0, contribution: "Lovelace" }
      const mintingRedeemer = Data.to(
        new Constr(0, [
          0n, // output_index
          new Constr(0, []),
        ])
      );

      this.logger.debug('=== DEBUGGING DATUM CONVERSION ===');
      this.logger.debug(`Lucid datum (CBOR)1: ${contributionDatum}`);
      this.logger.debug(`Lucid datum (CBOR)2: ${contributionDatum2}`);

      const unsignedTx = await this.lucid
        .newTx()
        .mintAssets(
          {
            [POLICY_ID + fromText('receipt')]: 1n,
          },
          mintingRedeemer
        )
        .pay.ToContract(
          vault.contract_address,
          {
            kind: 'inline',
            value: contributionDatum2,
          },
          {
            lovelace: BigInt(quantity),
            [POLICY_ID + fromText('receipt')]: 1n,
          }
        )
        .readFrom([refScriptUTxO])
        .readFrom([vaultUTxO])
        .addSigner(params.changeAddress)
        .addSigner(this.adminAddress)
        .validFrom(Date.now() - 60000)
        .validTo(Date.now() + 3600000)
        .complete();

      const cboredTx = unsignedTx.toCBOR();

      this.lucid.selectWallet.fromPrivateKey(this.adminSKey);
      const adminWitnessSet = await this.lucid.fromTx(cboredTx).partialSign.withWallet(); // Try to use withPrivateKey() instead of withWallet()

      const txWithAdminSignature = await this.lucid.fromTx(cboredTx).assemble([adminWitnessSet]).complete(); // Attach admin witness to the transaction

      return {
        presignedTx: txWithAdminSignature.toCBOR(),
      };
    } catch (error) {
      this.logger.error(`Failed to build ADA contribution transaction: ${error.message}`, error);
      throw error;
    } finally {
      this.lucid.selectWallet.fromPrivateKey(this.adminSKey);
    }
  }
}
