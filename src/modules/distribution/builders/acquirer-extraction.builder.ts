import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config/dist/config.service';

import { ExtractInput, ScriptInteraction, TransactionOutput, MintAsset } from '../distribution.types';

import { Claim } from '@/database/claim.entity';
import { Vault } from '@/database/vault.entity';
import { generate_tag_from_txhash_index, getAddressFromHash } from '@/modules/vaults/processing-tx/onchain/utils/lib';

/**
 * Builds extraction transactions for acquirer claims
 * Handles the logic of extracting ADA from contribution UTXOs to dispatch address
 */
@Injectable()
export class AcquirerExtractionBuilder {
  private readonly isMainnet: boolean;
  private readonly networkId: number;

  constructor(private readonly configService: ConfigService) {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
    this.networkId = Number(this.configService.get<string>('NETWORK_ID')) || 0;
  }

  /**
   * Build extraction transaction input for a batch of acquirer claims
   */
  async buildExtractionInput(
    vault: Pick<
      Vault,
      | 'script_hash'
      | 'dispatch_parametized_hash'
      | 'asset_vault_name'
      | 'last_update_tx_hash'
      | 'stake_registered'
      | 'ada_pair_multiplier'
    >,
    claims: Claim[],
    adminUtxos: string[],
    config: {
      adminAddress: string;
      adminHash: string;
      unparametizedDispatchHash: string;
    }
  ): Promise<ExtractInput> {
    const DISPATCH_ADDRESS = getAddressFromHash(vault.dispatch_parametized_hash, this.networkId);

    const scriptInteractions: ScriptInteraction[] = [];
    const mintAssets: MintAsset[] = [];
    const outputs: TransactionOutput[] = [];

    let totalMintQuantity = 0;
    let totalDispatchLovelace = 0;

    // Build outputs and interactions for each claim
    for (const claim of claims) {
      const { user, transaction: originalTx } = claim;

      if (!originalTx?.tx_hash) {
        throw new Error(`Original transaction not found for claim ${claim.id}`);
      }

      const datumTag = generate_tag_from_txhash_index(originalTx.tx_hash, 0);
      const adaPairMultiplier = Number(vault.ada_pair_multiplier);
      const claimMultiplier = Number(claim.multiplier);
      const originalAmount = Number(originalTx.amount);

      const claimMintQuantity = claimMultiplier * (originalAmount * 1_000_000);
      const vaultMintQuantity = adaPairMultiplier * originalAmount * 1_000_000;

      totalMintQuantity += (adaPairMultiplier + claimMultiplier) * (originalAmount * 1_000_000);
      totalDispatchLovelace += Number(originalTx.amount) * 1_000_000;

      // Add script interaction for this claim's contribution UTXO
      scriptInteractions.push({
        purpose: 'spend',
        hash: vault.script_hash,
        outputRef: {
          txHash: originalTx.tx_hash,
          index: 0,
        },
        redeemer: {
          type: 'json',
          value: {
            __variant: 'ExtractAda',
            __data: {
              vault_token_output_index: outputs?.length,
            },
          },
        },
      });

      // User output with vault tokens
      outputs.push({
        address: user.address,
        assets: [
          {
            assetName: { name: vault.asset_vault_name, format: 'hex' },
            policyId: vault.script_hash,
            quantity: claimMintQuantity,
          },
        ],
        datum: {
          type: 'inline',
          value: {
            datum_tag: datumTag,
            ada_paid: null, // Represents None in Aiken smart contract
          },
          shape: {
            validatorHash: config.unparametizedDispatchHash,
            purpose: 'spend',
          },
        },
      });

      // Vault output with vault tokens
      if (vaultMintQuantity > 0) {
        outputs.push({
          address: config.adminAddress,
          assets: [
            {
              assetName: { name: vault.asset_vault_name, format: 'hex' },
              policyId: vault.script_hash,
              quantity: vaultMintQuantity,
            },
          ],
        });
      }
    }

    // Add mint script interaction
    scriptInteractions.push({
      purpose: 'mint',
      hash: vault.script_hash,
      redeemer: {
        type: 'json',
        value: 'MintVaultToken',
      },
    });

    // Add dispatch output with total lovelace
    outputs.push({
      address: DISPATCH_ADDRESS,
      lovelace: totalDispatchLovelace,
    });

    // Build mint array
    mintAssets.push(
      {
        version: 'cip25',
        assetName: { name: vault.asset_vault_name, format: 'hex' },
        policyId: vault.script_hash,
        type: 'plutus',
        quantity: totalMintQuantity,
        metadata: {},
      },
      {
        version: 'cip25',
        assetName: { name: 'receipt', format: 'utf8' },
        policyId: vault.script_hash,
        type: 'plutus',
        quantity: -claims.length,
        metadata: {},
      }
    );

    return {
      changeAddress: config.adminAddress,
      message: `Claim vault tokens (${claims.length})`,
      utxos: adminUtxos,
      scriptInteractions,
      mint: mintAssets,
      outputs,
      requiredSigners: [config.adminHash],
      referenceInputs: [
        {
          txHash: vault.last_update_tx_hash,
          index: 0,
        },
      ],
      validityInterval: {
        start: true,
        end: true,
      },
      ...(!vault.stake_registered
        ? {
            deposits: [
              {
                hash: vault.dispatch_parametized_hash,
                type: 'script',
                deposit: 'stake',
              },
            ],
          }
        : {}),
      network: this.isMainnet ? 'mainnet' : 'preprod',
    };
  }

  /**
   * Extract owner address from contribution UTXO's inline datum
   * The AssetDatum structure is: { policy_id, asset_name, owner, datum_tag }
   */
  // private async getOwnerAddressFromDatum(txHash: string, claimId: string): Promise<string> {
  //   try {
  //     const utxos = await this.blockfrost.txsUtxos(txHash);
  //     const output = utxos.outputs[0];

  //     if (!output) {
  //       throw new Error(`No output found for transaction ${txHash}`);
  //     }

  //     if (!output.inline_datum) {
  //       throw new Error(`No inline datum found for ${txHash}#0`);
  //     }

  //     // Decode CBOR datum
  //     const datumBytes = Buffer.from(output.inline_datum, 'hex');
  //     const plutusData = PlutusData.from_bytes(datumBytes);

  //     // AssetDatum is a ConstrPlutusData with fields: [policy_id, asset_name, owner, datum_tag]
  //     const constr = plutusData.as_constr_plutus_data();
  //     if (!constr) {
  //       throw new Error(`Invalid datum structure for ${txHash}#0`);
  //     }

  //     const fields = constr.data();
  //     if (fields.len() < 3) {
  //       throw new Error(`Datum has insufficient fields for ${txHash}#0`);
  //     }

  //     // Owner is the 3rd field (index 2) - it's an Address encoded as PlutusData
  //     const ownerField = fields.get(2);
  //     const ownerConstr = ownerField.as_constr_plutus_data();

  //     if (!ownerConstr) {
  //       throw new Error(`Owner field is not a constructor for ${txHash}#0`);
  //     }

  //     // Cardano Address in Plutus is: Constr 0 [Credential, Option<StakingCredential>]
  //     // We need to reconstruct the bech32 address from the credentials
  //     const ownerAddress = this.plutusDataToAddress(ownerConstr);

  //     this.logger.log(`Extracted owner address from datum for claim ${claimId}: ${ownerAddress}`);

  //     return ownerAddress;
  //   } catch (error) {
  //     this.logger.error(`Failed to extract owner address from datum for claim ${claimId}: ${error.message}`);
  //     throw new Error(`Could not decode owner address from contribution UTXO ${txHash}#0: ${error.message}`);
  //   }
  // }

  /**
   * Convert Plutus Address data to bech32 address string
   */
  // private plutusDataToAddress(addressData: any): string {
  //   try {
  //     const fields = addressData.data();
  //     const paymentCredField = fields.get(0);
  //     const stakeCredField = fields.get(1);

  //     // Extract payment credential hash
  //     const paymentCred = paymentCredField.as_constr_plutus_data();
  //     const paymentFields = paymentCred.data();
  //     const paymentHashData = paymentFields.get(0);
  //     const paymentHash = Buffer.from(paymentHashData.as_bytes()).toString('hex');

  //     // Extract stake credential if present
  //     let stakeHash: string | null = null;
  //     const stakeCred = stakeCredField.as_constr_plutus_data();
  //     // Some variant
  //     if (stakeCred && stakeCred.alternative().to_str() === '0') {
  //       const stakeFields = stakeCred.data();
  //       const innerStake = stakeFields.get(0).as_constr_plutus_data();
  //       const innerFields = innerStake.data();
  //       const stakeHashData = innerFields.get(0);
  //       stakeHash = Buffer.from(stakeHashData.as_bytes()).toString('hex');
  //     }

  //     // Reconstruct address bytes: [header_byte, payment_hash(28), stake_hash(28)]
  //     const networkId = this.networkId;
  //     const headerByte = stakeHash ? (networkId === 1 ? 0x01 : 0x00) : networkId === 1 ? 0x61 : 0x60;

  //     let addressBytes: string;
  //     if (stakeHash) {
  //       addressBytes = Buffer.from([headerByte]).toString('hex') + paymentHash + stakeHash;
  //     } else {
  //       addressBytes = Buffer.from([headerByte]).toString('hex') + paymentHash;
  //     }

  //     const address = Address.from_bytes(Buffer.from(addressBytes, 'hex'));
  //     return address.to_bech32();
  //   } catch (error) {
  //     throw new Error(`Failed to convert Plutus address data: ${error.message}`);
  //   }
  // }
}
