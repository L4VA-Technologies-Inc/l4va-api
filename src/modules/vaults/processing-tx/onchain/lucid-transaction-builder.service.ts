// lucid-transaction-builder.service.ts
import { Address } from '@emurgo/cardano-serialization-lib-nodejs';
import {
  applyParamsToScript,
  Blockfrost,
  Constr,
  Data,
  fromHex,
  fromText,
  Lucid,
  LucidEvolution,
  MintingPolicy,
} from '@lucid-evolution/lucid';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TransactionsService } from '../offchain-tx/transactions.service';

import { BuildTransactionParams } from './vault-inserting.service';

import { Vault } from '@/database/vault.entity';
import blueprint from '@/modules/vaults/processing-tx/onchain/utils/blueprint.json';

@Injectable()
export class LucidTransactionBuilderService {
  private readonly logger = new Logger(LucidTransactionBuilderService.name);
  private readonly adminSKey: string;
  private readonly adminAddress: string;
  private lucid: LucidEvolution;

  constructor(
    @InjectRepository(Vault)
    private readonly vaultsRepository: Repository<Vault>,
    private readonly configService: ConfigService,
    private readonly transactionsService: TransactionsService
  ) {
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');
    this.adminAddress = this.configService.get<string>('ADMIN_ADDRESS');

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
      const allUTxOs = await this.lucid.utxosByOutRef([{ txHash: vault.publication_hash, outputIndex: 1 }]); // Vault on 0 index
      const refScriptUTxO = allUTxOs.filter(utxo => utxo.scriptRef)[0];

      if (!refScriptUTxO) {
        throw new Error('No reference script UTxO found for the vault');
      }

      const addressHex = Buffer.from(Address.from_bech32(params.changeAddress).to_bytes()).toString('hex');

      // For datum: { policy_id, asset_name, owner }
      const contributionDatum = Data.to(
        new Constr(0, [
          POLICY_ID, // policy_id as hex string
          VAULT_ID, // asset_name as hex string
          addressHex,
        ])
      );

      const contributionScript = blueprint.validators.find(v => v.title === 'contribute.contribute');
      if (!contributionScript) {
        throw new Error('Conribution script not found in blueprint');
      }

      const scriptWithParams = applyParamsToScript(contributionScript.compiledCode, [
        '2de3551bbd703dd03d57bb4d16027a73b0501977dc830885523bb1e6',
        VAULT_ID,
      ]);

      const mintingPolicy: MintingPolicy = {
        type: 'PlutusV3',
        script: scriptWithParams,
      };

      // For redeemer: { output_index: 0, contribution: "Lovelace" }
      const mintingRedeemer = Data.to(
        new Constr(0, [
          0n, // output_index
          fromText('Lovelace'),
        ])
      );

      const tx = await this.lucid
        .newTx()
        // Mint receipt token
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
            value: contributionDatum,
          },
          {
            lovelace: BigInt(quantity),
            [POLICY_ID + fromText('receipt')]: 1n,
          }
        )
        .attach.MintingPolicy(mintingPolicy)
        .readFrom([refScriptUTxO])
        .addSigner(params.changeAddress)
        .addSigner(this.adminAddress)
        .validFrom(Date.now() - 60000)
        .validTo(Date.now() + 3600000)
        .complete();

      await tx.sign.withWallet().partialSign.withPrivateKey(this.adminSKey);
      // this.logger.debug(adminSignedTx);

      return {
        presignedTx: tx.toHash(), // Should return hex
      };
    } catch (error) {
      this.logger.error(`Failed to build ADA contribution transaction: ${error.message}`, error);
      throw error;
    }
  }
}
