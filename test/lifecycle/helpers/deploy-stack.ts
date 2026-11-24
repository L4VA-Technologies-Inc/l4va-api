import { type Address } from 'viem';

import { ACCOUNTS, deploy, loadArtifact, read, send } from './chain';

export interface DeployedStack {
  factory: Address;
  batchDeployer: Address;
  feeConfig: Address;
  adapterRegistry: Address;
}

/** Same wiring as vault-contract-solidity/script/Deploy.s.sol, without the example vault. */
export async function deployStack(): Promise<DeployedStack> {
  const admin = ACCOUNTS.admin.address;
  const feeConfig = await deploy('ProtocolFeeConfig', [admin, admin]);
  const factory = await deploy('VaultFactory', [admin, feeConfig]);
  const batchDeployer = await deploy('BatchVaultDeployer');

  const batch = loadArtifact('BatchVaultDeployer');
  const factoryArtifact = loadArtifact('VaultFactory');
  const archetype = await read<`0x${string}`>(batchDeployer, batch.abi, 'BATCH');
  await send('admin', factory, factoryArtifact.abi, 'setVaultDeployer', [archetype, batchDeployer]);

  const adapterRegistry = await read<Address>(factory, factoryArtifact.abi, 'adapterRegistry');

  return { factory, batchDeployer, feeConfig, adapterRegistry };
}
