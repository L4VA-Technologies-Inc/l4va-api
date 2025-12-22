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
    vault: Vault,
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
            ada_paid: undefined,
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
      message: `Extract ADA for ${claims.length} claims`,
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
}
