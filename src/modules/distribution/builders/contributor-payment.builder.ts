import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  PayAdaContributionInput,
  ScriptInteraction,
  TransactionOutput,
  AddressesUtxo,
  AssetOutput,
} from '../distribution.types';
import { selectDispatchUtxos, validateBalanceEquation, calculateMinimumLovelace } from '../utils/distribution.utils';

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

  constructor(
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
    private readonly blockfrost: BlockFrostAPI
  ) {}

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
    const DISPATCH_ADDRESS = getAddressFromHash(PARAMETERIZED_DISPATCH_HASH);
    const SC_ADDRESS = getAddressFromHash(vault.script_hash);

    const scriptInteractions: ScriptInteraction[] = [];
    const outputs: TransactionOutput[] = [];
    const mintAssets: { vaultTokenQuantity: number; receiptBurn: number }[] = [];

    let totalPaymentAmount = 0;
    let currentOutputIndex = 0;

    // Process each claim in the batch
    for (const claim of claims) {
      const { transaction: originalTx, metadata } = claim;
      const adaAmount = Number(metadata.adaAmount);
      totalPaymentAmount += adaAmount;

      // Get original contribution assets
      const contributedAssets = await this.assetRepository.find({
        where: { transaction: { id: originalTx.id } },
      });

      const contributionAssets = this.formatContributionAssets(contributedAssets);

      // Get contribution output details and validate
      const contribOutput = await this.getAndValidateContributionOutput(originalTx.tx_hash, claim.id);

      const userAddress = claim.user.address;
      const datumTag = generate_tag_from_txhash_index(originalTx.tx_hash, 0);
      const vaultTokenQuantity = Number(claim.amount);

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
      outputs.push({
        address: userAddress,
        assets: [
          {
            assetName: { name: vault.asset_vault_name, format: 'hex' },
            policyId: vault.script_hash,
            quantity: vaultTokenQuantity,
          },
        ],
        lovelace: adaAmount,
        datum: {
          type: 'inline',
          value: {
            datum_tag: datumTag,
            ada_paid: adaAmount,
          },
          shape: {
            validatorHash: config.unparametizedDispatchHash,
            purpose: 'spend',
          },
        },
      });

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

    // Select dispatch UTXOs and validate balance
    const minRequired = calculateMinimumLovelace(totalPaymentAmount);
    const { selectedUtxos, totalAmount } = selectDispatchUtxos(dispatchUtxos, minRequired);

    if (selectedUtxos.length === 0 || totalAmount < minRequired) {
      throw new Error(
        `Insufficient ADA at dispatch address. Need ${minRequired} lovelace, but only ${totalAmount} available`
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

    // Add mint script interaction
    scriptInteractions.push({
      purpose: 'mint',
      hash: vault.script_hash,
      redeemer: {
        type: 'json',
        value: 'MintVaultToken',
      },
    });

    // Output: Return remaining ADA to dispatch address
    outputs.push({
      address: DISPATCH_ADDRESS,
      lovelace: actualRemainingDispatchLovelace,
    });

    // Calculate total mint quantities
    const totalVaultTokenQuantity = mintAssets.reduce((sum, m) => sum + m.vaultTokenQuantity, 0);
    const totalReceiptBurn = mintAssets.reduce((sum, m) => sum + m.receiptBurn, 0);

    return {
      changeAddress: config.adminAddress,
      message: `Batch payment for ${claims.length} contributors`,
      utxos: adminUtxos,
      preloadedScripts: [vault.dispatch_preloaded_script.preloadedScript],
      scriptInteractions,
      mint: [
        {
          version: 'cip25',
          assetName: { name: vault.asset_vault_name, format: 'hex' },
          policyId: vault.script_hash,
          type: 'plutus',
          quantity: totalVaultTokenQuantity,
          metadata: {},
        },
        {
          version: 'cip25',
          assetName: { name: 'receipt', format: 'utf8' },
          policyId: vault.script_hash,
          type: 'plutus',
          quantity: totalReceiptBurn,
          metadata: {},
        },
      ],
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
      network: 'preprod',
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
  private async getAndValidateContributionOutput(txHash: string, claimId: string): Promise<any> {
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
}
