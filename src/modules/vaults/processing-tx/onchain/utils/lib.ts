import { Buffer } from 'node:buffer';

import { BlockFrostAPI, BlockfrostServerError } from '@blockfrost/blockfrost-js';
import {
  Address,
  TransactionInput,
  TransactionOutput,
  TransactionHash,
  TransactionUnspentOutput,
  TransactionUnspentOutputs,
  AssetName,
  Assets,
  BigNum,
  MultiAsset,
  ScriptHash,
  Value,
  PlutusData,
  ConstrPlutusData,
  BigInt,
  hash_plutus_data,
  PlutusList,
} from '@emurgo/cardano-serialization-lib-nodejs';

interface Amount {
  unit: string;
  quantity: string | number;
}

interface TargetAsset {
  /** Token unit (policyId + assetName hex) */
  token: string;
  /** Amount of tokens needed */
  amount: number;
}

interface AssetCollection {
  /** Token unit */
  token: string;
  /** Amount collected so far */
  collected: number;
  /** Amount required */
  required: number;
  /** UTXOs containing this token */
  utxos: string[];
}

interface GetUtxosOptions {
  /** Minimum ADA amount required for a UTXO to be considered (in lovelace) */
  minAda?: number;
  /** Filter UTXOs based on ADA amount for specific selection (in lovelace) */
  filterByAda?: number;
  /** Single token unit to collect (backward compatibility) */
  targetToken?: string;
  /** Amount of single token needed (backward compatibility) */
  targetTokenAmount?: number;
  /** Array of assets to collect */
  targetAssets?: TargetAsset[];
  /** Whether to validate UTXO existence on-chain (default: true) */
  validateUtxos?: boolean;
}

interface GetUtxosResult {
  /** All valid UTXOs as hex strings (filtered by minAda) */
  utxos: string[];
  /** UTXOs filtered by higher ADA threshold (filterByAda) */
  filteredUtxos?: string[];
  /** UTXOs containing target tokens (only if targetToken/targetAssets specified) */
  requiredInputs?: string[];
  /** Detailed breakdown of asset collection */
  assetBreakdown?: AssetCollection[];
}

const assetsToValue = (assets: Amount[]): Value => {
  const multiAsset = MultiAsset.new();
  const lovelace = assets.find(asset => asset.unit === 'lovelace');
  const policies = assets.filter(asset => asset.unit !== 'lovelace').map(asset => asset.unit.slice(0, 56));

  if (!policies.length && lovelace) {
    return Value.new(BigNum.from_str(String(Number(lovelace.quantity) < 1000000 ? 1000000 : lovelace.quantity)));
  }
  policies.forEach(policy => {
    const policyAssets = assets.filter(asset => asset.unit.slice(0, 56) === policy);
    const assetsValue = Assets.new();
    policyAssets.forEach(asset => {
      if (Number(asset.quantity) > 0)
        assetsValue.insert(
          AssetName.new(Buffer.from(asset.unit.slice(56), 'hex')),
          BigNum.from_str(String(asset.quantity))
        );
    });
    if (assetsValue.len() > 0) multiAsset.insert(ScriptHash.from_bytes(Buffer.from(policy, 'hex')), assetsValue);
  });

  const multiAssetsValue = Value.new(BigNum.from_str(lovelace ? String(lovelace.quantity) : '0'));
  multiAssetsValue.set_multiasset(multiAsset);
  return multiAssetsValue;
};

export const getUtxos = async (
  address: Address,
  min = 0,
  blockfrost: BlockFrostAPI
): Promise<TransactionUnspentOutputs> => {
  const utxos = await blockfrost.addressesUtxosAll(address.to_bech32());
  const parsedUtxos = TransactionUnspentOutputs.new();
  utxos.forEach(utxo => {
    const { tx_hash, output_index, amount } = utxo;
    if (Number(amount[0].quantity) > min) {
      parsedUtxos.add(
        TransactionUnspentOutput.new(
          TransactionInput.new(TransactionHash.from_hex(tx_hash), output_index),
          TransactionOutput.new(address, assetsToValue(amount))
        )
      );
    }
  });
  return parsedUtxos;
};

export const validateUtxoStillExists = async (
  txHash: string,
  outputIndex: number,
  blockfrost: BlockFrostAPI
): Promise<boolean> => {
  try {
    const utxoDetails = await blockfrost.txsUtxos(txHash);
    const output = utxoDetails.outputs[outputIndex];

    return output && !output.consumed_by_tx;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (error) {
    return false;
  }
};

/**
 * This function fetches all UTXOs from an address, validates their existence on-chain,
 * and optionally collects specific UTXOs that contain required tokens for transaction building.
 *
 * @param address - The Cardano address to extract UTXOs from
 * @param blockfrost - BlockFrost API instance for blockchain queries
 * @param options - Configuration options
 * @param options.minAda - Minimum ADA amount (lovelace) for UTXO inclusion (default: 0)
 * @param options.targetToken - Single token unit to collect (policyId + assetName hex) - legacy support
 * @param options.targetTokenAmount - Amount of single target token to collect - legacy support
 * @param options.targetAssets - Array of assets to collect with their required amounts
 *
 * @returns Promise resolving to UTXOs and optional required inputs with asset breakdown
 *
 * @example
 * ```typescript
 * // Get all UTXOs with minimum 2 ADA
 * const { utxos } = await getUtxosExtract(address, blockfrost, { minAda: 2000000 });
 *
 * // Collect single token (backward compatibility)
 * const { utxos, requiredInputs } = await getUtxosExtract(address, blockfrost, {
 *   targetToken: '395e9c784ac5360a742b272648456cb41c9b03257a71e3325dfdd5404d4fe154...',
 *   targetTokenAmount: 700000000,
 *   minAda: 1000000
 * });
 *
 * // Collect multiple assets efficiently
 * const { utxos, requiredInputs, assetBreakdown } = await getUtxosExtract(address, blockfrost, {
 *   targetAssets: [
 *     { token: '395e9c784ac5360a742b272648456cb41c9b03257a71e3325dfdd5404d4fe154...', amount: 1 },
 *     { token: 'b0d07d45fe9514f80213f4020e5a61241458be626841cde717cb38a7...', amount: 3 },
 *     { token: 'c43a7db9747b5c6a5acb3e1e6da1e35b9d8b5f4a3b2c1d0e9f8g7h6i...', amount: 2 }
 *   ],
 *   minAda: 1000000
 * });
 * ```
 */
export const getUtxosExtract = async (
  address: Address,
  blockfrost: BlockFrostAPI,
  options: GetUtxosOptions = {}
): Promise<GetUtxosResult> => {
  const {
    targetToken,
    minAda = 0,
    filterByAda,
    targetTokenAmount = 0,
    targetAssets = [],
    validateUtxos = true,
  } = options;

  // Handle backward compatibility - convert single token to array format
  let assetsToCollect: TargetAsset[] = [];
  if (targetToken && targetTokenAmount > 0) {
    assetsToCollect = [{ token: targetToken, amount: targetTokenAmount }];
  } else if (targetAssets.length > 0) {
    assetsToCollect = [...targetAssets];
  }

  // Initialize asset collection tracking
  const assetCollections: Map<string, AssetCollection> = new Map();
  assetsToCollect.forEach(asset => {
    assetCollections.set(asset.token, {
      token: asset.token,
      collected: 0,
      required: asset.amount,
      utxos: [],
    });
  });

  const utxos = await blockfrost.addressesUtxosAll(address.to_bech32());
  const parsedUtxos: string[] = [];
  const filteredUtxos: string[] = [];
  const allRequiredInputs: Set<string> = new Set();

  if (filterByAda !== undefined) {
    for (const utxo of utxos) {
      const adaAmount = Number(utxo.amount[0].quantity);
      if (adaAmount >= filterByAda) {
        const utxoHex = TransactionUnspentOutput.new(
          TransactionInput.new(TransactionHash.from_hex(utxo.tx_hash), utxo.output_index),
          TransactionOutput.new(address, assetsToValue(utxo.amount))
        ).to_hex();
        filteredUtxos.push(utxoHex);
      }
    }
  }

  for (const utxo of utxos) {
    const { tx_hash, output_index, amount } = utxo;
    const adaAmount = Number(amount[0].quantity);

    // Skip UTXOs below minimum ADA threshold
    if (adaAmount <= minAda) continue;

    // Validate UTXO existence to prevent double-spending
    if (validateUtxos) {
      const isValid = await validateUtxoStillExists(tx_hash, output_index, blockfrost);
      if (!isValid) continue;
    }

    // Create UTXO hex encoding for transaction building
    const utxoHex = TransactionUnspentOutput.new(
      TransactionInput.new(TransactionHash.from_hex(tx_hash), output_index),
      TransactionOutput.new(address, assetsToValue(amount))
    ).to_hex();

    parsedUtxos.push(utxoHex);

    // Check if this UTXO contains any target assets
    if (assetCollections.size > 0) {
      for (const [tokenUnit, collection] of assetCollections) {
        // Skip if we already collected enough of this asset
        if (collection.collected >= collection.required) continue;

        // Check if this UTXO contains the target token
        const tokenAmount = amount.find(a => a.unit === tokenUnit);
        if (tokenAmount) {
          const quantity = Number(tokenAmount.quantity);

          // Update collection tracking
          collection.collected += quantity;
          collection.utxos.push(utxoHex);
          allRequiredInputs.add(utxoHex);
        }
      }

      // Early exit optimization - stop if all assets are collected
      const allAssetsCollected = Array.from(assetCollections.values()).every(
        collection => collection.collected >= collection.required
      );

      if (allAssetsCollected) {
        break;
      }
    }
  }

  // Validate that all required assets were collected
  if (assetCollections.size > 0) {
    const missingAssets = Array.from(assetCollections.values()).filter(
      collection => collection.collected < collection.required
    );

    if (missingAssets.length > 0) {
      const missingDetails = missingAssets
        .map(asset => `${asset.token}: need ${asset.required}, found ${asset.collected}`)
        .join('; ');

      throw new Error(`Insufficient assets found. Missing: ${missingDetails}`);
    }
  }

  // Prepare result
  const result: GetUtxosResult = {
    utxos: parsedUtxos,
  };

  // Add filtered UTXOs if filterByAda was specified
  if (filterByAda !== undefined) {
    result.filteredUtxos = filteredUtxos;
  }

  if (assetCollections.size > 0) {
    result.requiredInputs = Array.from(allRequiredInputs);
    result.assetBreakdown = Array.from(assetCollections.values());
  }

  return result;
};

export function generate_tag_from_txhash_index(txHash: string, txOutputIdx: number): string {
  const plutusList = PlutusList.new();
  plutusList.add(PlutusData.new_bytes(Buffer.from(txHash, 'hex')));
  plutusList.add(PlutusData.new_integer(BigInt.from_str(String(txOutputIdx))));

  const plutusData = PlutusData.new_constr_plutus_data(ConstrPlutusData.new(BigNum.zero(), plutusList));
  const hash = hash_plutus_data(plutusData);

  return hash.to_hex();
}

export async function getVaultUtxo(
  policyId: string,
  assetName: string,
  blockfrost: BlockFrostAPI
): Promise<{
  txHash: string;
  index: number;
}> {
  try {
    const unit = policyId + assetName;
    const assets = await blockfrost.assetsTransactions(unit, {
      count: 1,
      order: 'desc',
    });

    if (assets.length > 1) {
      throw new Error('Must be one.');
    }
    const utxo = await blockfrost.txsUtxos(assets[0].tx_hash);

    const index = utxo.outputs.findIndex(output => output.amount.find(amount => amount.unit === unit));

    if (index === -1) {
      throw new Error('Vault not found in transaction, your vault might be burned.');
    }

    return { txHash: utxo.hash, index: index };
  } catch (e: unknown) {
    if ((e as BlockfrostServerError).status_code === 404) {
      throw new Error('Vault not found on chain.');
    }
    throw e;
  }
}
