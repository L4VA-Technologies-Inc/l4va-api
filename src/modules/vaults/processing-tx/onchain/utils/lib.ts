import { Buffer } from 'node:buffer';

import { BlockFrostAPI, BlockfrostServerError } from '@blockfrost/blockfrost-js';
import {
  Address,
  TransactionInput,
  TransactionOutput,
  TransactionHash,
  TransactionUnspentOutput,
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
  EnterpriseAddress,
  Credential,
  NetworkInfo,
  BaseAddress,
  Bip32PrivateKey,
} from '@emurgo/cardano-serialization-lib-nodejs';
import * as bip39 from 'bip39';

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
  /** Target total ADA amount to collect (in lovelace) */
  targetAdaAmount?: number;
  /** Array of assets to collect */
  targetAssets?: TargetAsset[];
  /** Whether to validate UTXO existence on-chain (default: true) */
  validateUtxos?: boolean;
  /** Maximum number of UTXOs to return */
  maxUtxos?: number;
  /** Whether to exclude UTXOs with inline datums */
  removeInlineDatums?: boolean;
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
  /** Total ADA collected (in lovelace) - only if targetAdaAmount specified */
  totalAdaCollected?: number;
}

export const assetsToValue = (assets: Amount[]): Value => {
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

export const validateUtxoStillExists = async (
  txHash: string,
  outputIndex: number,
  blockfrost: BlockFrostAPI
): Promise<boolean> => {
  try {
    const utxoDetails = await blockfrost.txsUtxos(txHash);
    const output = utxoDetails.outputs[outputIndex];

    return output && !output.consumed_by_tx;
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
 * @param options.maxUtxos - Maximum number of UTXOs to return (default: 15)
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
    targetAdaAmount,
    filterByAda,
    targetAssets = [],
    validateUtxos = true,
    removeInlineDatums = true,
    minAda = 0,
    maxUtxos = 15,
  } = options;

  const hasTargetAssets = targetAssets.length > 0;
  const hasTargetAda = targetAdaAmount !== undefined && targetAdaAmount > 0;

  // Initialize asset collection tracking
  const assetCollections: Map<string, AssetCollection> = new Map();
  targetAssets.forEach(asset => {
    assetCollections.set(asset.token, {
      token: asset.token,
      collected: 0,
      required: asset.amount,
      utxos: [],
    });
  });

  const utxos = await blockfrost.addressesUtxosAll(address.to_bech32());

  const sortedUtxos = utxos.sort((a, b) => {
    const adaA = Number(a.amount.find(amt => amt.unit === 'lovelace')?.quantity || 0);
    const adaB = Number(b.amount.find(amt => amt.unit === 'lovelace')?.quantity || 0);
    return adaB - adaA; // Descending order
  });

  const allValidUtxos: string[] = [];
  const filteredUtxos: string[] = [];
  const requiredTokenUtxos: Set<string> = new Set();
  const additionalUtxos: string[] = [];
  let totalAdaCollected = 0;

  if (filterByAda !== undefined) {
    for (const utxo of sortedUtxos) {
      const adaAmount = Number(utxo.amount[0].quantity);
      if (adaAmount >= filterByAda) {
        const utxoHex = createUtxoHex(utxo.tx_hash, utxo.output_index, address, utxo.amount);
        filteredUtxos.push(utxoHex);
      }
    }
  }

  for (const utxo of sortedUtxos) {
    const { tx_hash, output_index, amount, inline_datum } = utxo;
    const adaAmount = Number(amount[0].quantity);

    // Skip UTXOs below minimum ADA threshold
    if (adaAmount <= minAda) continue;

    if (removeInlineDatums && inline_datum === '49616e76696c2d746167') continue;

    // Validate UTXO existence to prevent double-spending
    if (validateUtxos) {
      const isValid = await validateUtxoStillExists(tx_hash, output_index, blockfrost);
      if (!isValid) continue;
    }

    // Create UTXO hex encoding for transaction building
    const utxoHex = createUtxoHex(tx_hash, output_index, address, amount);
    allValidUtxos.push(utxoHex);

    totalAdaCollected += adaAmount;

    // Track ADA collection if targeting specific amount
    if (hasTargetAda) {
      requiredTokenUtxos.add(utxoHex);

      // Stop collecting once we have enough ADA
      if (totalAdaCollected >= targetAdaAmount) {
        break;
      }
    }

    // If we have target assets, check if this UTXO contains any
    let containsTargetAsset = false;
    if (hasTargetAssets) {
      for (const [tokenUnit, collection] of assetCollections) {
        if (collection.collected >= collection.required) continue;

        const tokenAmount = amount.find(a => a.unit === tokenUnit);
        if (tokenAmount) {
          const quantity = Number(tokenAmount.quantity);

          collection.collected += quantity;
          collection.utxos.push(utxoHex);
          requiredTokenUtxos.add(utxoHex);
          containsTargetAsset = true;
        }
      }
    }

    // If this UTXO doesn't contain target assets, add to additional pool
    if (!containsTargetAsset && hasTargetAssets && !hasTargetAda) {
      additionalUtxos.push(utxoHex);
    }

    // Early exit optimization
    if (!hasTargetAssets && !hasTargetAda && allValidUtxos.length >= maxUtxos) {
      break;
    }
  }

  // Validate that all required assets were collected
  if (hasTargetAssets) {
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

  // Validate that target ADA amount was collected
  if (hasTargetAda && totalAdaCollected < targetAdaAmount) {
    throw new Error(`Insufficient ADA found. Need ${targetAdaAmount} lovelace, found ${totalAdaCollected} lovelace`);
  }

  let selectedUtxos: string[];

  if (!hasTargetAssets && !hasTargetAda) {
    selectedUtxos = allValidUtxos.slice(0, maxUtxos);
  } else {
    const requiredUtxosArray = Array.from(requiredTokenUtxos);
    const remainingSlots = Math.max(0, maxUtxos - requiredUtxosArray.length);

    const additionalSelected = additionalUtxos.slice(0, remainingSlots);
    selectedUtxos = [...requiredUtxosArray, ...additionalSelected];
  }

  const result: GetUtxosResult = {
    utxos: selectedUtxos,
  };

  if (filterByAda !== undefined) {
    if (hasTargetAssets || hasTargetAda) {
      const requiredUtxosArray = Array.from(requiredTokenUtxos);
      result.filteredUtxos = [...new Set([...filteredUtxos, ...requiredUtxosArray])];
    } else {
      result.filteredUtxos = filteredUtxos;
    }
  }

  if (hasTargetAssets) {
    result.requiredInputs = Array.from(requiredTokenUtxos);
    result.assetBreakdown = Array.from(assetCollections.values());
  }

  if (hasTargetAda) {
    result.requiredInputs = Array.from(requiredTokenUtxos);
    result.totalAdaCollected = totalAdaCollected;
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

export function getAddressFromHash(hash: string): string {
  return EnterpriseAddress.new(0, Credential.from_scripthash(ScriptHash.from_hex(hash)))
    .to_address()
    .to_bech32();
}

export function createUtxoHex(txHash: string, outputIndex: number, address: Address, amount: Amount[]): string {
  return TransactionUnspentOutput.new(
    TransactionInput.new(TransactionHash.from_hex(txHash), outputIndex),
    TransactionOutput.new(address, assetsToValue(amount))
  ).to_hex();
}

export async function generateCardanoWallet(isMainnet: boolean): Promise<{
  ticker: string;
  address: string;
  privateKey: string;
  mnemonic: string;
}> {
  const mnemonic = bip39.generateMnemonic();
  const entropy = bip39.mnemonicToEntropy(mnemonic);
  const rootKey = Bip32PrivateKey.from_bip39_entropy(Buffer.from(entropy, 'hex'), Buffer.from(''));

  // Derivation path for external addresses in Cardano (m/1852'/1815'/0'/0/0)
  const accountKey = rootKey
    .derive(1852 | 0x80000000) // purpose
    .derive(1815 | 0x80000000) // coin type
    .derive(0 | 0x80000000) // account
    .derive(0) // external chain
    .derive(0); // first address

  const stakeKey = rootKey
    .derive(1852 | 0x80000000) // purpose
    .derive(1815 | 0x80000000) // coin type
    .derive(0 | 0x80000000) // account
    .derive(2) // staking chain
    .derive(0); // first staking address

  const publicKey = accountKey.to_public();
  const stakePublicKey = stakeKey.to_public();
  const networkInfo = isMainnet ? NetworkInfo.mainnet() : NetworkInfo.testnet_preprod();

  const baseAddress = BaseAddress.new(
    networkInfo.network_id(),
    Credential.from_keyhash(publicKey.to_raw_key().hash()),
    Credential.from_keyhash(stakePublicKey.to_raw_key().hash())
  );

  const address = baseAddress.to_address().to_bech32();
  const privateKey = accountKey.to_bech32();

  const walletData = {
    ticker: 'ADA',
    address: address,
    privateKey: privateKey,
    mnemonic: mnemonic,
  };

  // Save wallet data to your own database
  // Uncomment and replace this with your actual database save operation
  // const wallet = new WalletModel(walletData);
  // await wallet.save();

  return walletData;
}
