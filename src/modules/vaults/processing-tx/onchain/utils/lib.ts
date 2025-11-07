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

interface GetUtxosOptions {
  /** Minimum ADA amount required for a UTXO to be considered (in lovelace) */
  minAda?: number;
  /** Token unit (policyId + assetName) to collect for required inputs */
  targetToken?: string;
  /** Amount of tokens needed to collect */
  targetTokenAmount?: number;
}

interface GetUtxosResult {
  /** All valid UTXOs as hex strings */
  utxos: string[];
  /** UTXOs containing the target token (only if targetToken is specified) */
  requiredInputs?: string[];
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
 * @param options.targetToken - Token unit to collect (policyId + assetName hex)
 * @param options.targetTokenAmount - Amount of target tokens to collect
 *
 * @returns Promise resolving to UTXOs and optional required inputs
 *
 * @example
 * ```typescript
 * // Get all UTXOs with minimum 2 ADA
 * const { utxos } = await getUtxosExtract(address, blockfrost, { minAda: 2000000 });
 *
 * // Collect specific tokens for transaction
 * const { utxos, requiredInputs } = await getUtxosExtract(address, blockfrost, {
 *   targetToken: '395e9c784ac5360a742b272648456cb41c9b03257a71e3325dfdd5404d4fe154...',
 *   targetTokenAmount: 700000000,
 *   minAda: 1000000
 * });
 * ```
 */
export const getUtxosExtract = async (
  address: Address,
  blockfrost: BlockFrostAPI,
  options: GetUtxosOptions = {}
): Promise<GetUtxosResult> => {
  const { targetToken, minAda = 0, targetTokenAmount = 0 } = options;

  const utxos = await blockfrost.addressesUtxosAll(address.to_bech32());
  const parsedUtxos: string[] = [];
  const requiredInputs: string[] = [];

  let tokensCollected = 0;

  for (const utxo of utxos) {
    const { tx_hash, output_index, amount } = utxo;
    const adaAmount = Number(amount[0].quantity);

    // Skip UTXOs below minimum ADA threshold
    if (adaAmount <= minAda) continue;

    // Validate UTXO existence to prevent double-spending
    const isValid = await validateUtxoStillExists(tx_hash, output_index, blockfrost);
    if (!isValid) continue;

    // Create UTXO hex encoding for transaction building
    const utxoHex = TransactionUnspentOutput.new(
      TransactionInput.new(TransactionHash.from_hex(tx_hash), output_index),
      TransactionOutput.new(address, assetsToValue(amount))
    ).to_hex();

    parsedUtxos.push(utxoHex);

    // Skip token collection if not needed or already collected enough
    if (!targetToken || tokensCollected >= targetTokenAmount) continue;

    // Check if this UTXO contains the target token
    const tokenAmount = amount.find(a => a.unit === targetToken);
    if (tokenAmount) {
      const quantity = Number(tokenAmount.quantity);
      requiredInputs.push(utxoHex);
      tokensCollected += quantity;

      // Early exit optimization - stop when we have enough tokens
      if (tokensCollected >= targetTokenAmount) break;
    }
  }

  return targetToken ? { utxos: parsedUtxos, requiredInputs } : { utxos: parsedUtxos };
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
