import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config/dist/config.service';

import { ExtractInput, ScriptInteraction, TransactionOutput, MintAsset } from '../distribution.types';

import { Claim } from '@/database/claim.entity';
import { Vault } from '@/database/vault.entity';
import { generate_tag_from_txhash_index } from '@/modules/vaults/processing-tx/onchain/utils/lib';

/**
 * Builds extraction transactions for acquire-only vault claims.
 *
 * Differences from AcquirerExtractionBuilder:
 *  - ADA goes directly to the vault's treasury wallet address (bypasses dispatch contract)
 *  - No stake registration deposit is included
 */
@Injectable()
export class AcquireOnlyExtractionBuilder {
  private readonly isMainnet: boolean;

  constructor(private readonly configService: ConfigService) {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
  }

  /**
   * Build extraction transaction input for a batch of acquire-only claims.
   */
  async buildAcquireOnlyExtractionInput(
    vault: Pick<Vault, 'script_hash' | 'asset_vault_name' | 'last_update_tx_hash' | 'ada_pair_multiplier'>,
    claims: Claim[],
    adminUtxos: string[],
    config: {
      adminAddress: string;
      adminHash: string;
      unparametizedDispatchHash: string;
      treasuryAddress: string;
      /** LP % as a whole number (e.g. 20 = 20%). 0 means no LP. */
      lpPercent: number;
    }
  ): Promise<ExtractInput> {
    const scriptInteractions: ScriptInteraction[] = [];
    const mintAssets: MintAsset[] = [];
    const outputs: TransactionOutput[] = [];

    let totalMintQuantity = 0;
    let totalTreasuryLovelace = 0;

    for (const claim of claims) {
      const { user, transaction: originalTx } = claim;

      if (!originalTx?.tx_hash) {
        throw new Error(`Original transaction not found for claim ${claim.id}`);
      }

      const datumTag = generate_tag_from_txhash_index(originalTx.tx_hash, 0);
      const isExpansionClaim = originalTx.is_expansion === true;
      // For acquire expansion: no LP share, all VT goes to user
      const adaPairMultiplier = isExpansionClaim ? 0 : Number(vault.ada_pair_multiplier);
      const claimMultiplier = Number(claim.multiplier);
      const originalAmount = Number(originalTx.amount);

      const claimMintQuantity = claimMultiplier * (originalAmount * 1_000_000);
      const vaultMintQuantity = adaPairMultiplier * originalAmount * 1_000_000;

      totalMintQuantity += (adaPairMultiplier + claimMultiplier) * (originalAmount * 1_000_000);
      totalTreasuryLovelace += originalAmount * 1_000_000;

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
            ada_paid: null,
          },
          shape: {
            validatorHash: config.unparametizedDispatchHash,
            purpose: 'spend',
          },
        },
      });

      // Vault token output for LP/admin share (if any)
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

    // Mint script interaction
    scriptInteractions.push({
      purpose: 'mint',
      hash: vault.script_hash,
      redeemer: {
        type: 'json',
        value: 'MintVaultToken',
      },
    });

    // ADA goes to admin (LP portion) and treasury (remainder)
    const lpAdaLovelace =
      config.lpPercent > 0 ? Math.floor(totalTreasuryLovelace * (config.lpPercent / 200)) : 0;
    const netTreasuryLovelace = totalTreasuryLovelace - lpAdaLovelace;

    if (lpAdaLovelace > 0) {
      outputs.push({
        address: config.adminAddress,
        lovelace: lpAdaLovelace,
      });
    }

    outputs.push({
      address: config.treasuryAddress,
      lovelace: netTreasuryLovelace,
    });

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
      message: `Acquire-only: claim vault tokens (${claims.length})`,
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
      // No deposits: acquire-only vaults do not register a stake credential
      network: this.isMainnet ? 'mainnet' : 'preprod',
    };
  }
}
