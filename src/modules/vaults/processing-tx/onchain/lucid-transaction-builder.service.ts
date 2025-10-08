// lucid-transaction-builder.service.ts
import { Address } from '@emurgo/cardano-serialization-lib-nodejs';
import { Blockfrost, Constr, Data, fromHex, Lucid, LucidEvolution } from '@lucid-evolution/lucid';
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

    this.lucid.selectWallet.fromPrivateKey(this.adminSKey);
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
      // Get user's UTXOs
      const userUtxos = await this.lucid.utxosAt(params.changeAddress);
      if (userUtxos.length === 0) {
        throw new Error('No UTXOs found for the user address');
      }

      // Find a UTxO containing a reference script
      const allUTxOs = await this.lucid.utxosByOutRef([{ txHash: vault.publication_hash, outputIndex: 0 }]);
      const refScriptUTxO = allUTxOs.filter(utxo => utxo.scriptRef)[0];

      // For redeemer: { output_index: 0, contribution: "Lovelace" }
      // const mintingRedeemer: RedeemerBuilder = {
      //   kind: 'self',
      //   makeRedeemer: (inputIndex: bigint) => {
      //     // Create redeemer based on the input index
      //     return Data.to(
      //       new Constr(0, [
      //         inputIndex, // Use the actual input index from transaction
      //         'Lovelace',
      //       ])
      //     );
      //   },
      // };

      // const mintingRedeemer2 = Data.to(
      //   new Constr(0, [
      //     0n, // output_index as BigInt
      //     'Lovelace', // contribution as string
      //   ])
      // );
      const addressObj = Address.from_bech32(params.changeAddress);
      const addressBytes = addressObj.to_bytes();
      const addressHex = Buffer.from(addressBytes).toString('hex');

      /*
      Example of hex for address  
      "addresses": {
        "11678afada248a5fd87b0949a623200ff989ed43c58d3aea0cf58c55": {
          "hex": "7011678afada248a5fd87b0949a623200ff989ed43c58d3aea0cf58c55",
          "bech32": "addr_test1wqgk0zh6mgjg5h7c0vy5nf3ryq8lnz0dg0zc6wh2pn6cc4g68t4x7"
        }
      }
      */

      // For datum: { policy_id, asset_name, owner }
      const contributionDatum = Data.to(
        new Constr(0, [
          POLICY_ID, // policy_id as hex string
          VAULT_ID, // asset_name as hex string
          addressHex,
        ])
      );

      // Build the transaction
      const tx = await this.lucid
        .newTx()
        // Mint receipt token
        .mintAssets({
          [POLICY_ID + fromHex('72656365697074')]: 1n,
        })
        .pay.ToContract(
          vault.contract_address,
          {
            kind: 'inline',
            value: contributionDatum,
          },
          {
            lovelace: BigInt(quantity),
            [POLICY_ID + fromHex('72656365697074')]: 1n, // receipt
          }
        )
        // Attach minting policy
        .attach.MintingPolicy({
          type: 'PlutusV3',
          script: await this.getContributionScript(POLICY_ID),
        })
        // Add reference input
        .readFrom([refScriptUTxO])
        // Add required signers
        .addSigner(params.changeAddress)
        .addSigner(this.adminAddress)
        // Set validity interval
        .validFrom(Date.now() - 60000)
        .validTo(Date.now() + 3600000)
        .complete();

      const adminSignedTx = await tx.partialSign.withWallet();

      this.logger.debug(adminSignedTx);

      throw new Error(`Test: ${adminSignedTx}`);

      return {
        presignedTx: adminSignedTx, // Should return hex
      };
    } catch (error) {
      this.logger.error(`Failed to build ADA contribution transaction: ${error.message}`, error);
      throw error;
    }
  }

  // Check this, idk if itworks
  private async getContributionScript(policyId: string): Promise<string> {
    // Load your compiled Plutus script
    const scriptCbor = this.configService.get<string>(`CONTRIBUTION_SCRIPT_${policyId}`);

    if (!scriptCbor) {
      throw new Error(`Contribution script not found for policy ID: ${policyId}`);
    }

    return scriptCbor;
  }
}
