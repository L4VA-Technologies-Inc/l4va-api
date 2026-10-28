import { readFileSync } from 'fs';
import { join } from 'path';

import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  http,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const RPC_URL = 'http://127.0.0.1:8546';

export const anvilChain = defineChain({
  id: 31337,
  name: 'Anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

// anvil's public default dev accounts (mnemonic "test test ... junk")
export const ACCOUNTS = {
  admin: privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'),
  mintingSigner: privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'),
  creator: privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'),
  alice: privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6'),
  bob: privateKeyToAccount('0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a'),
};
export type AccountName = keyof typeof ACCOUNTS;

export const publicClient = createPublicClient({ chain: anvilChain, transport: http(RPC_URL) });
export const testClient = createTestClient({ chain: anvilChain, mode: 'anvil', transport: http(RPC_URL) });

export function walletFor(name: AccountName) {
  return createWalletClient({ account: ACCOUNTS[name], chain: anvilChain, transport: http(RPC_URL) });
}

export function loadArtifact(name: string): { abi: Abi; bytecode: Hex } {
  const artifact = JSON.parse(readFileSync(join(__dirname, '..', 'artifacts', `${name}.json`), 'utf8'));
  return { abi: artifact.abi, bytecode: artifact.bytecode };
}

export async function deploy(name: string, args: unknown[] = [], from: AccountName = 'admin'): Promise<Address> {
  const { abi, bytecode } = loadArtifact(name);
  const hash = await walletFor(from).deployContract({ abi, bytecode, args } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error(`Deploying ${name} produced no address`);
  return receipt.contractAddress;
}

export async function send(
  from: AccountName,
  address: Address,
  abi: Abi,
  functionName: string,
  args: unknown[] = [],
  value?: bigint
): Promise<Hex> {
  const hash = await walletFor(from).writeContract({ address, abi, functionName, args, value } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${functionName} reverted (tx ${hash})`);
  return hash;
}

export async function read<T>(address: Address, abi: Abi, functionName: string, args: unknown[] = []): Promise<T> {
  return (await publicClient.readContract({ address, abi, functionName, args } as never)) as T;
}

export async function chainNow(): Promise<number> {
  const block = await publicClient.getBlock();
  return Number(block.timestamp);
}

/** Move chain time forward and mine a block so the new timestamp is observable. */
export async function increaseChainTime(seconds: number): Promise<void> {
  await testClient.increaseTime({ seconds });
  await testClient.mine({ blocks: 1 });
}
