import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  PayAdaContributionInput,
  ScriptInteraction,
  TransactionOutput,
  AddressesUtxo,
  AssetOutput,
} from '../distribution.types';
import { selectDispatchUtxos, validateBalanceEquation } from '../utils/distribution.utils';

import { Asset } from '@/database/asset.entity';
import { Claim } from '@/database/claim.entity';
import { Vault } from '@/database/vault.entity';
import { generate_tag_from_txhash_index, getAddressFromHash } from '@/modules/vaults/processing-tx/onchain/utils/lib';

/**
 * Builds payment transactions for contributor claims
 * Handles the logic of paying ADA + vault tokens to contributors
 */
@Injectable()
export class ContributorPaymentBuilder {
  private readonly logger = new Logger(ContributorPaymentBuilder.name);
  private readonly isMainnet: boolean;
  private readonly networkId: number;
  /** Minimum ADA payment threshold: any positive amount  Smart contract accepts even small amounts like 4,000 lovelace (0.004 ADA) */
  private readonly MIN_ADA_PAYMENT = 4000;

  constructor(
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
    private readonly blockfrost: BlockFrostAPI,
    private readonly configService: ConfigService
  ) {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
    this.networkId = Number(this.configService.get<string>('NETWORK_ID')) || 0;
  }

  /**
   * Build batched payment transaction input for multiple contributor claims
   */
  async buildPaymentInput(
    vault: Vault,
    claims: Claim[],
    adminUtxos: string[],
    dispatchUtxos: AddressesUtxo[],
    config: {
      adminAddress: string;
      adminHash: string;
      unparametizedDispatchHash: string;
    }
  ): Promise<PayAdaContributionInput> {
    const PARAMETERIZED_DISPATCH_HASH = vault.dispatch_parametized_hash;
    const DISPATCH_ADDRESS = getAddressFromHash(PARAMETERIZED_DISPATCH_HASH, this.networkId);
    const SC_ADDRESS = getAddressFromHash(vault.script_hash, this.networkId);

    const scriptInteractions: ScriptInteraction[] = [];
    const outputs: TransactionOutput[] = [];
    const mintAssets: { vaultTokenQuantity: number; receiptBurn: number }[] = [];

    const hasDispatchFunding = dispatchUtxos.length > 0;
    let totalPaymentAmount = 0;
    let currentOutputIndex = 0;

    // Process each claim in the batch
    for (const claim of claims) {
      const { transaction: originalTx, lovelace_amount } = claim;

      // Only count lovelace amounts above minimum threshold in total payment
      if (hasDispatchFunding && Number(lovelace_amount) >= this.MIN_ADA_PAYMENT) {
        totalPaymentAmount += Number(lovelace_amount);
      }

      // Get original contribution assets
      const contributedAssets = await this.assetRepository.find({
        where: { transaction: { id: originalTx.id } },
      });

      const contributionAssets = this.formatContributionAssets(contributedAssets);

      // Get contribution output details and validate
      const contribOutput = await this.getAndValidateContributionOutput(originalTx.tx_hash, claim.id);

      const userAddress = claim.user.address;
      const datumTag = generate_tag_from_txhash_index(originalTx.tx_hash, 0);

      // Calculate vault token quantity based on multipliers and actual UTXO assets
      // This matches the smart contract's loop_throught_assets calculation
      const vaultTokenQuantity = this.calculateVaultTokenQuantity(
        contribOutput.amount,
        vault.acquire_multiplier,
        vault.script_hash
      );

      // Add script interaction for spending the contribution UTXO
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
            __variant: 'CollectVaultToken',
            __data: {
              vault_token_output_index: currentOutputIndex,
              change_output_index: currentOutputIndex + 1,
            },
          },
        },
      });

      // Output 1: Payment to user with vault tokens
      const userOutput: TransactionOutput = {
        address: userAddress,
      };

      // Add ADA payment and datum only if dispatch funding exists AND amount meets minimum threshold
      // If lovelace_amount is below MIN_ADA_PAYMENT, treat it as if there's no dispatch funding
      const hasActualPayment = hasDispatchFunding && Number(lovelace_amount) >= this.MIN_ADA_PAYMENT;

      if (hasActualPayment) {
        userOutput.lovelace = Number(lovelace_amount);
        userOutput.datum = {
          type: 'inline',
          value: {
            datum_tag: datumTag,
            ada_paid: Number(lovelace_amount),
          },
          shape: {
            validatorHash: config.unparametizedDispatchHash,
            purpose: 'spend',
          },
        };
      } else {
        // When no dispatch funding, use OutputPayoutDatum with None for ada_paid
        userOutput.datum = {
          type: 'inline',
          value: {
            datum_tag: datumTag,
            ada_paid: null, // This represents None in Aiken
          },
          shape: {
            validatorHash: config.unparametizedDispatchHash,
            purpose: 'spend',
          },
        };
      }

      // Only add vault tokens if quantity > 0
      if (vaultTokenQuantity > 0) {
        userOutput.assets = [
          {
            assetName: { name: vault.asset_vault_name, format: 'hex' },
            policyId: vault.script_hash,
            quantity: vaultTokenQuantity,
          },
        ];
      }

      outputs.push(userOutput);

      // Output 2: Return to SC address with original contributed assets
      outputs.push({
        address: SC_ADDRESS,
        lovelace: Number(contribOutput.amount.find((u: any) => u.unit === 'lovelace')?.quantity),
        assets: contributionAssets,
        datum: {
          type: 'inline',
          value: {
            policy_id: vault.script_hash,
            asset_name: vault.asset_vault_name,
            owner: userAddress,
            datum_tag: datumTag,
          },
          shape: {
            validatorHash: vault.script_hash,
            purpose: 'spend',
          },
        },
      });

      mintAssets.push({
        vaultTokenQuantity,
        receiptBurn: -1,
      });

      currentOutputIndex += 2;
    }

    // Handle dispatch UTXOs only if they exist AND we have actual payments to make
    if (hasDispatchFunding && totalPaymentAmount > 0) {
      const { selectedUtxos, totalAmount } = selectDispatchUtxos(dispatchUtxos, totalPaymentAmount);

      if (selectedUtxos.length === 0 || totalAmount < totalPaymentAmount) {
        throw new Error(
          `Insufficient ADA at dispatch address. Need ${totalPaymentAmount} lovelace, but only ${totalAmount} available`
        );
      }

      const actualRemainingDispatchLovelace = totalAmount - totalPaymentAmount;

      if (!validateBalanceEquation(totalAmount, actualRemainingDispatchLovelace, totalPaymentAmount)) {
        throw new Error(
          `Balance equation invalid: ${totalAmount} < ${actualRemainingDispatchLovelace} + ${totalPaymentAmount}`
        );
      }

      // Add dispatch script interactions
      for (const utxo of selectedUtxos) {
        scriptInteractions.push({
          purpose: 'spend',
          hash: PARAMETERIZED_DISPATCH_HASH,
          outputRef: {
            txHash: utxo.tx_hash,
            index: utxo.output_index,
          },
          redeemer: {
            type: 'json',
            value: null,
          },
        });
      }

      scriptInteractions.push({
        purpose: 'withdraw',
        hash: PARAMETERIZED_DISPATCH_HASH,
        redeemer: {
          type: 'json',
          value: null,
        },
      });

      // Output: Return remaining ADA to dispatch address
      outputs.push({
        address: DISPATCH_ADDRESS,
        lovelace: actualRemainingDispatchLovelace,
      });
    } else {
      this.logger.log(
        `No dispatch funding (0% acquirers/LP). Transaction will only mint vault tokens and return contributed assets to contributors.`
      );
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

    // Calculate total mint quantities
    const totalVaultTokenQuantity = mintAssets.reduce((sum, m) => sum + m.vaultTokenQuantity, 0);
    const totalReceiptBurn = mintAssets.reduce((sum, m) => sum + m.receiptBurn, 0);

    // Build mint array - only include vault tokens if quantity > 0
    const mintArray: any[] = [];

    if (totalVaultTokenQuantity > 0) {
      mintArray.push({
        version: 'cip25',
        assetName: { name: vault.asset_vault_name, format: 'hex' },
        policyId: vault.script_hash,
        type: 'plutus',
        quantity: totalVaultTokenQuantity,
      });
    }

    // Always include receipt burn
    mintArray.push({
      version: 'cip25',
      assetName: { name: 'receipt', format: 'utf8' },
      policyId: vault.script_hash,
      type: 'plutus',
      quantity: totalReceiptBurn,
    });

    return {
      changeAddress: config.adminAddress,
      message: `Batch payment for ${claims.length} contributors`,
      utxos: adminUtxos,
      preloadedScripts: hasDispatchFunding ? [vault.dispatch_preloaded_script.preloadedScript] : [],
      scriptInteractions,
      mint: mintArray,
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
      network: this.isMainnet ? 'mainnet' : 'preprod',
    };
  }

  /**
   * Format contributed assets for transaction output
   */
  private formatContributionAssets(assets: Asset[]): AssetOutput[] {
    const contributionAssets: AssetOutput[] = [];

    if (assets.length > 0) {
      for (const asset of assets) {
        contributionAssets.push({
          assetName: {
            name: asset.asset_id,
            format: 'hex',
          },
          policyId: asset.policy_id,
          quantity: Number(asset.quantity),
        });
      }
    }

    return contributionAssets;
  }

  /**
   * Get and validate contribution output from blockchain
   */
  private async getAndValidateContributionOutput(
    txHash: string,
    claimId: string
  ): Promise<{
    address: string;
    amount: {
      unit: string;
      quantity: string;
    }[];
    output_index: number;
    data_hash: string;
    inline_datum: string;
    collateral: boolean;
    reference_script_hash: string;
    consumed_by_tx?: string;
  }> {
    const contribTxUtxos = await this.blockfrost.txsUtxos(txHash);
    const contribOutput = contribTxUtxos.outputs[0];

    if (!contribOutput) {
      throw new Error(`No contribution output found for claim ${claimId}`);
    }

    if (contribOutput.consumed_by_tx) {
      throw new Error(`Contribution UTXO ${txHash}#0 already consumed by ${contribOutput.consumed_by_tx}`);
    }

    return contribOutput;
  }

  /**
   * Calculate vault token quantity based on UTXO assets and acquire multipliers
   * This matches the smart contract's loop_throught_assets calculation
   *
   * @param utxoAmounts - The amounts from the contribution UTXO
   * @param acquireMultiplier - The vault's acquire_multiplier array
   * @param vaultPolicyId - The vault's policy ID (to exclude receipt token)
   * @returns The calculated vault token quantity
   */
  private calculateVaultTokenQuantity(
    utxoAmounts: Array<{ unit: string; quantity: string }>,
    acquireMultiplier: Array<[string, string | null, number]> | undefined,
    vaultPolicyId: string
  ): number {
    if (!acquireMultiplier || acquireMultiplier.length === 0) {
      return 0;
    }

    let totalVtAmount = 0;
    const receiptUnit = vaultPolicyId + '72656365697074'; // "receipt" in hex

    for (const amount of utxoAmounts) {
      // Skip lovelace and receipt token
      if (amount.unit === 'lovelace' || amount.unit === receiptUnit) {
        continue;
      }

      // Parse unit into policyId and assetName
      const policyId = amount.unit.substring(0, 56);
      const assetName = amount.unit.substring(56);
      const quantity = Number(amount.quantity);

      // Find matching multiplier
      const multiplier = this.findMultiplier(acquireMultiplier, policyId, assetName);

      if (multiplier > 0) {
        totalVtAmount += multiplier * quantity;
      }
    }

    return totalVtAmount;
  }

  /**
   * Find the multiplier for a given asset from the acquire_multiplier array
   * Matches the smart contract's multiplier_given_asset logic
   */
  private findMultiplier(
    multipliers: Array<[string, string | null, number]>,
    policyId: string,
    assetName: string
  ): number {
    for (const [mPolicyId, mAssetName, mult] of multipliers) {
      if (mPolicyId === policyId) {
        // If assetName is null/undefined, match any asset from this policy
        if (mAssetName === null || mAssetName === undefined || mAssetName === '') {
          return mult;
        }
        // Otherwise, must match exact asset name
        if (mAssetName === assetName) {
          return mult;
        }
      }
    }
    return 0;
  }
}
