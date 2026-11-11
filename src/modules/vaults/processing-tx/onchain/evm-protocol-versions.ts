import type { Address } from 'viem';

/**
 * Every Robinhood vault is pinned to the protocol version that deployed it. Contracts are immutable
 * and bound to their own factory (adapters and the fee converter check `isVault` on it, and each
 * factory creates its own adapter registry), so a vault must keep using its own address set.
 *
 * To release a version: deploy the contracts, add an entry here, then point EVM_FACTORY_ADDRESS at it.
 * Never remove an entry while vaults live on it. Addresses come from
 * vault-contract-solidity/deployments and were checked on-chain on 2026-11-06.
 */
export interface EvmProtocolVersion {
  version: number;
  factory: Address;
  /** Lower bound for log scans. The V9 deployment files hold an L1 block, so the real one is used. */
  deployBlock: bigint;
  adapterRegistry: Address;
  protocolFeeConfig: Address;
  batchDeployer: Address;
  /** Null when the deployment file does not record it (testnet adapters are configured by env). */
  swapAdapter: Address | null;
  /**
   * True when `swapAdapter` implements `MULTI_PATH_EXACT_IN` (mixed v3/v4 routes). The API only
   * builds that route format, so a vault whose adapter lacks it cannot trade on Uniswap and every
   * route check reports it as unsupported rather than failing at execution.
   */
  swapAdapterMultiPath?: boolean;
  lpAdapter: Address | null;
  feeConverter: Address;
  feeController: Address;
}

export const EVM_PROTOCOL_VERSIONS: Record<number, EvmProtocolVersion[]> = {
  4663: [
    {
      version: 8,
      factory: '0x7Eb5c9F3FE05C8e924BC4d1792D8C0Eb07fccC05',
      deployBlock: 94143837n,
      adapterRegistry: '0xd36b53bC8A11C09dB5dc708d7B4E2Ca06769F730',
      protocolFeeConfig: '0xb4838313F3B7827888eaC8c4cA2c1DF7608B82dC',
      batchDeployer: '0x55B3410aC168fEd2dB5C86BEE811255DF6e3700f',
      swapAdapter: '0xbA4fcCF341b91aEE7180A5Db242025141686EF76',
      lpAdapter: '0xdb4eF23bd896A247a1ac5bC70164855a273F21cb',
      feeConverter: '0x5C0cAd7eD8207a6F7318d84978DE8DD5c275e8b7',
      feeController: '0xd1b1A08FFa9dd57064990C700807c505a89a2fDD',
    },
    {
      version: 9,
      factory: '0xf933f971Dd670648162b393f02f718E49C788ebb',
      deployBlock: 104978002n,
      adapterRegistry: '0x0CfbD0767198aA1C2dc7297580E3DDc46F4f3350',
      protocolFeeConfig: '0x650f8E5b16b63EDEB3574cf9e4E8f82DF624C39A',
      batchDeployer: '0xe4A0e9aa60D3212f8e5Fef08bC8B4F6a42D27003',
      swapAdapter: '0x443FD443f2b5caab405170C984E9D7529a8bD0D0',
      lpAdapter: '0x757bdb2b9f65A16a2FC41C4dA5aebd58FE652212',
      feeConverter: '0x61749c3d45d43EB5Fa057c570cDa459D2bd748AC',
      feeController: '0x42DE0Fc4dA5e6Fc9Bb217538060200039F436604',
    },
    {
      version: 10,
      factory: '0xceC9F4A79e3FF744aF845b6379561c570dc54CCf',
      deployBlock: 107526764n,
      adapterRegistry: '0x1BB699ae8A027c242dA401f59B89B2bD6c9d3629',
      protocolFeeConfig: '0x4Be358fdb7e3BF2D2ca70e012c89257d0F3Eb734',
      // Current deployer: Vault code with untracked-asset rescue (vault-contract-solidity b6dd5d4), set on the
      // V10 factory 2026-11-11 (tx 0x447d…36c6). Vaults created earlier came from 0x229401A1…40D1 and have no
      // rescue; EvmRescueService detects that per vault. Same factory, registry, adapters and fee path.
      batchDeployer: '0xA86E8A208B117D9d96b43265E85BF5f0aF08052a',
      // MULTI_PATH_EXACT_IN adapter, deployed and approved in this registry 2026-11-09
      // (tx 0x4e56…5a5c / 0xd981…c82). The previous adapter 0x80d16567…79DB stays approved.
      swapAdapter: '0x558C2F0060f5888daD42c79C87b99008ef45C7bB',
      swapAdapterMultiPath: true,
      lpAdapter: '0x5B9b4279E31949DD367f4733db791A69aA1335E4',
      feeConverter: '0x29041c5BC568D0cD8b039267bD9B3427FFDbfD37',
      feeController: '0xBD7f80a08391200263449c61f411c05Ae5a7a562',
    },
  ],
  46630: [
    {
      version: 8,
      factory: '0x042822e201F16b25D5c377F5fA9c22C9FCA50235',
      deployBlock: 119398566n,
      adapterRegistry: '0x68BFc801c81f8f994BFFf5b97860cC8d3920f867',
      protocolFeeConfig: '0x9Ad809E9cB18b8dc5eAa74274dA0dF67A2086D94',
      batchDeployer: '0x1c5A282C38E46F078A754E9A9738038ab83Dc418',
      swapAdapter: null,
      lpAdapter: null,
      feeConverter: '0x9e211F3Bd2186faA026B55B0BC4C0265cA7b20C3',
      feeController: '0xab71564973779dEEBC3D0d7503E77414482532b8',
    },
    {
      version: 9,
      factory: '0x8BdB53276A383Bf448E50DaE451Fd183bce5cE9B',
      deployBlock: 147622177n,
      adapterRegistry: '0x90185b17a288218105A107f28F2192C2DA67878e',
      protocolFeeConfig: '0x39e82Ec710D1174De788354C8ED2456Bd850f1Ab',
      batchDeployer: '0x9E6859EEb5f440b53785eA0B89de7b9e3758a957',
      swapAdapter: null,
      lpAdapter: null,
      feeConverter: '0x8085c6d3cd0417c5773589599AE9a3A41aB97e95',
      feeController: '0xEFa8fEdFE950ff10bED3b8e05c7eBC929d246b1C',
    },
    {
      version: 10,
      factory: '0x6272107267D0d65031c0754cE7c61a10CC744771',
      deployBlock: 149540495n,
      adapterRegistry: '0xaEC325F84e36A696263d8c1aC10D94a3d8E13f61',
      protocolFeeConfig: '0x16C8b77e356502399D70B0F4DdedEc28c0f07b49',
      batchDeployer: '0x883d6D1d75d64869103384E85E06396BEDbFC1Ed',
      swapAdapter: '0xa84A8bC0493D2b6563c95Def3c27CfA29FEdd239',
      lpAdapter: '0xAc2F594ED483e75497D69c18b3D717C38Aae291E',
      feeConverter: '0x8e7A854357437e8c7A312073f8260E74E7d730d8',
      feeController: '0x646E9EffDdcAEB11248aaCE9Cec528b3eca68AdB',
    },
  ],
};

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The version whose factory is `factory` on `chainId`, or null when it is not registered. */
export function findEvmProtocolVersionByFactory(
  chainId: number,
  factory: string | null | undefined
): EvmProtocolVersion | null {
  if (!factory) return null;
  return (EVM_PROTOCOL_VERSIONS[chainId] ?? []).find(v => same(v.factory, factory)) ?? null;
}

/** A vault's address set by its stored version, or null when unknown. */
export function getEvmProtocolVersion(chainId: number, version: number | null | undefined): EvmProtocolVersion | null {
  if (version == null) return null;
  return (EVM_PROTOCOL_VERSIONS[chainId] ?? []).find(v => v.version === version) ?? null;
}

type VaultVersionRef = { chain_id?: number | string | null; evm_protocol_version?: number | null };

const versionOf = (vault: VaultVersionRef): EvmProtocolVersion | null =>
  getEvmProtocolVersion(Number(vault.chain_id), vault.evm_protocol_version);

/**
 * The swap adapter a vault must trade through: its version's, because its contract only accepts
 * adapters approved in its own registry. `fallback` (env) covers vaults with no version yet and
 * versions that record no adapter (testnet).
 */
export function resolveVaultSwapAdapter(vault: VaultVersionRef, fallback: Address | null): Address | null {
  return versionOf(vault)?.swapAdapter ?? fallback;
}

/**
 * Whether the vault's swap adapter accepts `MULTI_PATH_EXACT_IN`. A versioned adapter answers from
 * {@link EvmProtocolVersion.swapAdapterMultiPath}; the env fallback adapter from `fallbackMultiPath`.
 */
export function vaultSwapAdapterIsMultiPath(vault: VaultVersionRef, fallbackMultiPath: boolean): boolean {
  const version = versionOf(vault);
  if (version?.swapAdapter) return version.swapAdapterMultiPath === true;
  return fallbackMultiPath;
}

/** The LP adapter of a vault's version. Same fallback rule as the swap adapter. */
export function resolveVaultLpAdapter(vault: VaultVersionRef, fallback: Address | null): Address | null {
  return versionOf(vault)?.lpAdapter ?? fallback;
}

/** Lower bound for a vault's log scans: its factory's deploy block, else `fallback`. */
export function resolveVaultDeployBlock(vault: VaultVersionRef, fallback: bigint): bigint {
  return versionOf(vault)?.deployBlock ?? fallback;
}

/** Earliest deploy block on a chain, for scans covering every version; null if none is registered. */
export function earliestEvmDeployBlock(chainId: number): bigint | null {
  const blocks = (EVM_PROTOCOL_VERSIONS[chainId] ?? []).map(v => v.deployBlock);
  return blocks.length ? blocks.reduce((min, b) => (b < min ? b : min)) : null;
}

/** The version a fee converter belongs to, or null when it is not registered. */
export function findEvmProtocolVersionByFeeConverter(chainId: number, feeConverter: string): EvmProtocolVersion | null {
  return (EVM_PROTOCOL_VERSIONS[chainId] ?? []).find(v => same(v.feeConverter, feeConverter)) ?? null;
}
