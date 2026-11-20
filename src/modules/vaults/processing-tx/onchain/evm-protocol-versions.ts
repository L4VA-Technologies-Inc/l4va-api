import type { Address } from 'viem';

/**
 * Every Robinhood vault is pinned to the protocol version that deployed it. Contracts are immutable
 * and bound to their own factory (adapters and the fee converter check `isVault` on it, and each
 * factory creates its own adapter registry), so a vault must keep using its own address set.
 *
 * To release a version: deploy the contracts, add an entry here, then point EVM_FACTORY_ADDRESS at it.
 * Never remove an entry while vaults live on it.
 *
 * NUMBERING. `version` is a DEPLOYMENT id, unique per chain, not the contract code version.
 * Stage and production share chain 4663 but are separate deployments (own factory, registry,
 * adapters, keys), so each gets its own id: a new contract version takes the next free id for
 * stage and the one after it for production. Every vault stores its id (`evm_protocol_version`),
 * so an id must never be reused or renumbered.
 *   4663:  8–11 stage (V8–V11 code) · 12 production (V12 code) · 13 stage (V13) · 14 production (V13)
 *   46630: testnet, one id per deployment
 * `stack` says which environment an entry belongs to and `codeVersion` which contract code it runs.
 * Code checks such as `isV13Version` compare ids (`>= 13`), which holds because ids only grow.
 * The vault-contract-solidity deploy scripts print the id to use (`API_VERSION`). Addresses come from
 * vault-contract-solidity/deployments and were checked on-chain on 2026-11-06.
 */
export type EvmStack = 'production' | 'stage' | 'testnet';

export interface EvmProtocolVersion {
  /** Deployment id, unique per chain (see NUMBERING above). Stored on every vault. */
  version: number;
  /** Which environment's deployment this is. Stage and production must never share an id. */
  stack: EvmStack;
  /** Contract code version the vaults of this deployment run (V13 code on both 13 and 14). */
  codeVersion: number;
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
  /**
   * V1 `LiquidityExitAdapter` approved (tag "swap") in this version's registry. It returns withdrawn
   * v4 LP proceeds of V1 LP adapters into the vault's custody through `Vault.swap`. A V2 LP adapter
   * (`UniswapV4LiquidityAdapterV2`) names its own `LiquidityExitAdapterV2` on-chain and does not use
   * this field; `EvmLpExitService` tells the two apart per position. Unset until deployed.
   */
  lpExitAdapter?: Address | null;
  feeConverter: Address;
  feeController: Address;
  /**
   * V11+: the factory's guardian, who can freeze this version's vaults (`Vault.frozen()`) and is the
   * only one able to replace a vault's authority (`setAuthority`). A Safe on mainnet. Absent on
   * V8–V10, whose vaults have no freeze and hand authority over with propose/accept.
   */
  guardian?: Address;
}

export const EVM_PROTOCOL_VERSIONS: Record<number, EvmProtocolVersion[]> = {
  4663: [
    {
      version: 8,
      stack: 'stage',
      codeVersion: 8,
      factory: '0x7Eb5c9F3FE05C8e924BC4d1792D8C0Eb07fccC05',
      deployBlock: 94143837n,
      adapterRegistry: '0xd36b53bC8A11C09dB5dc708d7B4E2Ca06769F730',
      protocolFeeConfig: '0xb4838313F3B7827888eaC8c4cA2c1DF7608B82dC',
      batchDeployer: '0x55B3410aC168fEd2dB5C86BEE811255DF6e3700f',
      swapAdapter: '0xbA4fcCF341b91aEE7180A5Db242025141686EF76',
      lpAdapter: '0xdb4eF23bd896A247a1ac5bC70164855a273F21cb',
      // LiquidityExitAdapter, deployed 2026-11-16 (tx 0x7b6c…409f), approved in the V8/V9/V10 registries.
      lpExitAdapter: '0xa70A0A82C52e5a9ff519736fbbba553F81429E9e',
      feeConverter: '0x5C0cAd7eD8207a6F7318d84978DE8DD5c275e8b7',
      feeController: '0xd1b1A08FFa9dd57064990C700807c505a89a2fDD',
    },
    {
      version: 9,
      stack: 'stage',
      codeVersion: 9,
      factory: '0xf933f971Dd670648162b393f02f718E49C788ebb',
      deployBlock: 104978002n,
      adapterRegistry: '0x0CfbD0767198aA1C2dc7297580E3DDc46F4f3350',
      protocolFeeConfig: '0x650f8E5b16b63EDEB3574cf9e4E8f82DF624C39A',
      batchDeployer: '0xe4A0e9aa60D3212f8e5Fef08bC8B4F6a42D27003',
      swapAdapter: '0x443FD443f2b5caab405170C984E9D7529a8bD0D0',
      lpAdapter: '0x757bdb2b9f65A16a2FC41C4dA5aebd58FE652212',
      // LiquidityExitAdapter, deployed 2026-11-16 (tx 0x7b6c…409f), approved in the V8/V9/V10 registries.
      lpExitAdapter: '0xa70A0A82C52e5a9ff519736fbbba553F81429E9e',
      feeConverter: '0x61749c3d45d43EB5Fa057c570cDa459D2bd748AC',
      feeController: '0x42DE0Fc4dA5e6Fc9Bb217538060200039F436604',
    },
    {
      version: 10,
      stack: 'stage',
      codeVersion: 10,
      factory: '0xceC9F4A79e3FF744aF845b6379561c570dc54CCf',
      deployBlock: 107526764n,
      adapterRegistry: '0x1BB699ae8A027c242dA401f59B89B2bD6c9d3629',
      protocolFeeConfig: '0x4Be358fdb7e3BF2D2ca70e012c89257d0F3Eb734',
      // Current deployer (2026-11-11, tx 0xc26c…e48e): Vault code with untracked-asset rescue AND
      // closeAcquireWindow. Earlier deployers on this factory: 0xA86E8A20…052a (2026-11-11, rescue only)
      // and 0x229401A1…40D1 (original V10, neither). Vaults keep the code they were created with;
      // EvmRescueService and EvmCycleCloseService probe each vault. Same factory, registry, adapters, fees.
      batchDeployer: '0x75C065F5DEC6570adaDc14D4937B5539ECC99a17',
      // MULTI_PATH_EXACT_IN adapter, deployed and approved in this registry 2026-11-09
      // (tx 0x4e56…5a5c / 0xd981…c82). The previous adapter 0x80d16567…79DB stays approved.
      swapAdapter: '0x558C2F0060f5888daD42c79C87b99008ef45C7bB',
      swapAdapterMultiPath: true,
      lpAdapter: '0x5B9b4279E31949DD367f4733db791A69aA1335E4',
      // LiquidityExitAdapter, deployed 2026-11-16 (tx 0x7b6c…409f), approved in the V8/V9/V10 registries.
      lpExitAdapter: '0xa70A0A82C52e5a9ff519736fbbba553F81429E9e',
      feeConverter: '0x29041c5BC568D0cD8b039267bD9B3427FFDbfD37',
      feeController: '0xBD7f80a08391200263449c61f411c05Ae5a7a562',
    },
    {
      // STAGE stack with guardian/pauser emergency roles (vault-contract-solidity feat/vault-guardian),
      // deployed 2026-11-17 with script/deploy-stage-v11.sh (deployments/robinhood-mainnet-stage-v11.json).
      // Production keeps creating vaults on V10 until its EVM_FACTORY_ADDRESS is switched.
      version: 11,
      stack: 'stage',
      codeVersion: 11,
      factory: '0xfB79Bf6a61950a04C64F1AD6Ef3b1809A21c2598',
      deployBlock: 116436007n,
      adapterRegistry: '0x7720D6FAA6cA32B0ef22f1B11B278F406A70eC03',
      protocolFeeConfig: '0xeCF10601FE4e74ECe0FDE988E61bA89cE49B7aEf',
      // Current deployer (2026-11-17, tx 0x95a9…9ea6): Vault code with burnHeldVaultToken. The
      // original V11 deployer 0x8FFA0198…7159 has no burn. Same factory, registry, adapters, fees;
      // EvmLpExitService reads each vault's code to pick burn or release.
      batchDeployer: '0xD350d4a6D50fdF2EEB94B88ba8F1df7581B01dd8',
      // Built from the current UniversalRouterSwapAdapter, which accepts MULTI_PATH_EXACT_IN.
      swapAdapter: '0xdE9ec3139C904E8DDbEA934a8520aFe5A654eA96',
      swapAdapterMultiPath: true,
      lpAdapter: '0xc100Cc02999E485560e7F2ccDEe79555fb584157',
      // Shared LiquidityExitAdapter; must be approved (tag "swap") in this registry before use.
      lpExitAdapter: '0xa70A0A82C52e5a9ff519736fbbba553F81429E9e',
      feeConverter: '0x3eA8128222520701c826edF24Cc5E71300F4a191',
      feeController: '0x215A4d4B30A1F927e42aE4132b72B78F9Ae9Eb15',
      // Safe 1.5.0, 2-of-3; also the pauser.
      guardian: '0xcC3679a762F41C6f9727a6659bab519c3FbbF7c1',
    },
    {
      // PRODUCTION stack, fully separate from stage (vault-contract-solidity
      // deployments/robinhood-mainnet-v12.json, script/deploy-mainnet-v12.sh, 2026-11-18).
      // Vault code: guardian freeze + closeAcquireWindow + burnHeldVaultToken.
      version: 12,
      stack: 'production',
      codeVersion: 12,
      factory: '0x2d100A23459df7AdEa1Cd369374B48Bda2cC1567',
      deployBlock: 117391239n,
      adapterRegistry: '0x6Ba8C1628EF52665c5B275DB319a4F8Beb624f49',
      protocolFeeConfig: '0x671F533142149d4e94fD1F850751D7AccfC268E7',
      batchDeployer: '0x57d612979A18C33CBd9F62cfeefA21032222635C',
      swapAdapter: '0x6269edF9d6FEB037B75036d9b28F7D26D84b08C7',
      swapAdapterMultiPath: true,
      lpAdapter: '0x7A6DC9DF3230c7A00E02fc1801C8864e129E8E84',
      // Production's own LiquidityExitAdapter (owner = prod admin), approved only in this registry.
      lpExitAdapter: '0x4BD76625C80216A222b6C6c802Ad6db6D2d7A343',
      feeConverter: '0x76301E2295928128DC22d57F3f162a9bd9b2bc43',
      feeController: '0x1ccc58E15809d2819848D68A4f660087FE1B1C5e',
      // L4VA Safe; also the pauser.
      guardian: '0x4733002467440E5881b84D19aC31e5c546Be9945',
    },
    {
      // V13 STAGE (vault-contract-solidity feat/v13, script/deploy-stage-v13.sh, 2026-11-19): own
      // stack, stage keys. Registry + ProtocolFeeConfig roles are on the stage Safe, not the
      // backend key (audit F-08/F-09). Guarded swap adapter (pool allowlist + daily cap, owner =
      // Safe); the stack's unguarded swap adapter and V1 LP adapter are revoked. Delays 24 h.
      version: 13,
      stack: 'stage',
      codeVersion: 13,
      factory: '0x6d54065a3aC9C0964a92101F7C07453C952eDcD6',
      deployBlock: 118439792n,
      adapterRegistry: '0x898902514c2f6F72106Dbec5E633453e2E9f6c84',
      protocolFeeConfig: '0xc918dFC5e642A95Bc1a6066867dCEEe0d8fB6314',
      batchDeployer: '0x91977Fe65faAFAf8b7Ccbfa41468899bA17821bD',
      swapAdapter: '0xA5eCf4BAE51882337e929F0309BD09c50F96E77E',
      swapAdapterMultiPath: true,
      lpAdapter: '0xB791F82Dc709ee65A0a319E197457dF1F887322c',
      lpExitAdapter: '0xB292b476049584a00880d20E444ffe374953D411',
      feeConverter: '0xc32a0b4eF83a67148D100DcE93425afdc5a72383',
      feeController: '0xaeb6B894Af6722020052cCaD25DBd81E77d69443',
      guardian: '0xcC3679a762F41C6f9727a6659bab519c3FbbF7c1',
    },
  ],
  46630: [
    {
      version: 8,
      stack: 'testnet',
      codeVersion: 8,
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
      stack: 'testnet',
      codeVersion: 9,
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
      stack: 'testnet',
      codeVersion: 10,
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
    {
      // Guardian/pauser emergency roles (vault-contract-solidity feat/vault-guardian), deployed
      // 2026-11-17 with script/deploy-testnet-v11.sh. Test tokens, LP protocol, mock adapter and the
      // V2 LP adapter are reused from V10; the LP adapter is not bound to a factory but must be
      // approved in this registry. Testnet has no Safe: guardian and pauser are the admin EOA.
      version: 11,
      stack: 'testnet',
      codeVersion: 11,
      factory: '0x9795635535b11e09b561a67b87A175e516dfc680',
      deployBlock: 154424047n,
      adapterRegistry: '0x6552F8a786465b8d2Aef745D2002dA677dc17C2c',
      protocolFeeConfig: '0x6baF082C43B90d1c3d51C03923B2AaD6e7f87ECc',
      // Current deployer (2026-11-17, tx 0xb7f0…225a): Vault code with burnHeldVaultToken. The
      // original V11 deployer 0xA07F335A…F6bf has no burn.
      batchDeployer: '0xDe3E20f4B45f04f96B2eA03673d9736fe1E64f50',
      swapAdapter: '0xB2AE05133a096b57393DC36e83efe18Cd2f3cBd6',
      lpAdapter: '0xAc2F594ED483e75497D69c18b3D717C38Aae291E',
      feeConverter: '0xBdD98E3578056aAC2f9afFb27b1EED7Dfb03baec',
      feeController: '0x978f6EFdDB9516A11fd0F994ACCD20664033e85c',
      guardian: '0x87F86a948f5369240E57a3C8BbED5E8E57F8da7e',
    },
    {
      // V13 (vault-contract-solidity feat/v13, script/deploy-testnet-v13.sh, 2026-11-19): vault
      // economics fixed at creation, contract-computed allocations, 1 h review windows on roots and
      // distributions (testnet setting), verifier = the Dave test wallet. Fixed-rate testnet swap
      // adapter; Uniswap v4 LP adapter V2 with its own exit adapter (0x1451…89f2).
      version: 13,
      stack: 'testnet',
      codeVersion: 13,
      factory: '0x1a5BC0EFbF5a031e821e472b23148A4F067c47b1',
      deployBlock: 155352797n,
      adapterRegistry: '0xBA94A5378543D3Cf3854722090B9075cD9862C4f',
      protocolFeeConfig: '0x6347e3C741dB95a6CdaB4FE445f58C464b108727',
      batchDeployer: '0xAa2d2CC95B9aE3f439E0E8424227EbA4e9032A4e',
      swapAdapter: '0x4bB3777d7c2968dF3EAE1ec148fb10Fa910C7De4',
      lpAdapter: '0xfa64379745F6aACE931AA08103a155F48E5b7dAA',
      feeConverter: '0x3c2726d1c42aF641171b4454492F42985EcAaAF7',
      feeController: '0x606E8b94f1cEF179661f28D7c220ce03A724fCe9',
      guardian: '0x87F86a948f5369240E57a3C8BbED5E8E57F8da7e',
    },
    {
      // V13 with the audit fixes (2026-11-19, script/deploy-testnet-v13.sh): FixedPrice removed,
      // FromSale on the Cardano math with a delayed, cancellable rate. Replaces id 13 for new
      // vaults (13 stays for vaults created on it). No testnet Safe: registry/fee roles stay on
      // the admin key here. Fixed-rate testnet swap adapter; delays 1 h; verifier = Dave.
      version: 14,
      stack: 'testnet',
      codeVersion: 13,
      factory: '0x26A696583E461382723ABe5Ec47a999882d0Ce53',
      deployBlock: 155562270n,
      adapterRegistry: '0x9e47184b2C83fB4B285301B990330D0c91c1297b',
      protocolFeeConfig: '0xd01ca9faC35F7E05Ea3a442d37797624B486292D',
      batchDeployer: '0x199C2A70762Bd5513313deEdEbAaD1A9dC3C3eE4',
      swapAdapter: '0x2f48C9b2C0b9ED5158fd70985DA9e4588A884796',
      lpAdapter: '0x7315114E4F7611b038198B38b0E21dd7e5260033',
      lpExitAdapter: '0x9d22025DF262F6cd123BaeaD420D4654fA2D68Be',
      feeConverter: '0xc2c5B0264D8B9f67c56174366465331E56932646',
      feeController: '0x5edf35Bc35149bDBa1D073CC42f844b25E5A9d97',
      guardian: '0x87F86a948f5369240E57a3C8BbED5E8E57F8da7e',
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

/** The LP exit adapter of a vault's version, else `fallback` (env `EVM_LP_EXIT_ADAPTER_ADDRESS`). */
export function resolveVaultLpExitAdapter(vault: VaultVersionRef, fallback: Address | null): Address | null {
  return versionOf(vault)?.lpExitAdapter ?? fallback;
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
