import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicClient, getAddress, http, parseAbiItem, type Abi, type Address, type PublicClient } from 'viem';

/** Minimal ERC-20 read ABI (balance / supply / decimals). */
const ERC20_READ_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  { name: 'totalSupply', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const satisfies Abi;

/**
 * Candidate getter names on the vault contract that return the vault-token
 * (VT) ERC-20 address. The V3 VaultFactory emits `VaultCreated(..., address vaultToken)`,
 * and the vault exposes it through one of these view getters. We probe them in
 * order and use the first that returns a non-zero address.
 */
const VAULT_TOKEN_GETTERS = ['vaultToken', 'vt', 'token', 'getVaultToken', 'shareToken'] as const;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Transfer(address,address,uint256) — used to discover every address that ever held the VT. */
const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

export interface EvmVaultBalances {
  /** Resolved VT ERC-20 contract address (lowercased). */
  tokenAddress: string;
  /** VT decimals as reported on-chain. */
  decimals: number;
  /** Total supply in raw units (including excluded addresses). */
  totalSupplyRaw: bigint;
  /** Voting balances keyed by lowercased holder address, LP/system addresses excluded. */
  addressBalances: Record<string, bigint>;
}

/**
 * Builds governance snapshot balances for EVM (Robinhood) vaults purely from the
 * chain API — the EVM analogue of Blockfrost `assetsAddresses` used for Cardano.
 *
 * Flow:
 *   1. Resolve the VT ERC-20 address from the vault contract via RPC.
 *   2. Scan `Transfer` logs (`eth_getLogs`) to collect every candidate holder.
 *   3. Read `balanceOf` for each candidate and keep the non-zero ones.
 *   4. Exclude system addresses (zero, vault, token, admin, treasury).
 */
@Injectable()
export class EvmSnapshotService {
  private readonly logger = new Logger(EvmSnapshotService.name);

  private readonly client?: PublicClient;
  /** Max block span per `eth_getLogs` request — most RPCs cap this. */
  private readonly logScanChunk: bigint;
  private readonly balanceConcurrency: number;
  private readonly excludedAddresses: Set<string>;

  /**
   * Typed wrapper around viem `readContract`. viem's generics don't line up with
   * the non-parameterized `PublicClient`, so we funnel every read through a single
   * `as never` cast here rather than sprinkling casts at each call site.
   */
  private read<T>(params: { address: Address; abi: Abi; functionName: string; args?: unknown[] }): Promise<T> {
    return this.client!.readContract(params as never) as Promise<T>;
  }

  constructor(private readonly configService: ConfigService) {
    const evmRpcUrl = this.configService.get<string>('EVM_RPC_URL');
    if (evmRpcUrl) {
      this.client = createPublicClient({ transport: http(evmRpcUrl) }) as PublicClient;
    }

    this.logScanChunk = BigInt(this.configService.get<string>('EVM_LOG_SCAN_CHUNK') ?? '50000');
    this.balanceConcurrency = Number(this.configService.get<string>('EVM_BALANCE_CONCURRENCY') ?? '20');

    // System addresses that should never carry voting power.
    this.excludedAddresses = new Set(
      [
        this.configService.get<string>('EVM_ADMIN_ADDRESS'),
        this.configService.get<string>('EVM_TREASURY_ADDRESS'),
        ZERO_ADDRESS,
      ]
        .filter(Boolean)
        .map(a => a!.toLowerCase())
    );
  }

  /**
   * Enumerate the VT holders of an EVM vault.
   * @param vaultContractAddress The deployed vault contract address (`vault.contract_address`).
   * @param creationTxHash The vault-creation tx hash (`vault.publication_hash`). Used to start the
   *   Transfer-log scan at the vault's deployment block instead of block 0 — the token cannot have
   *   moved before it existed, so scanning earlier history is wasted work (chains have tens of
   *   millions of blocks). Falls back to block 0 if the hash is missing or its receipt can't be read.
   */
  async getVaultTokenBalances(vaultContractAddress: string, creationTxHash?: string): Promise<EvmVaultBalances> {
    if (!this.client) {
      throw new BadRequestException('EVM_RPC_URL is not configured — cannot build EVM snapshot');
    }
    if (!vaultContractAddress) {
      throw new BadRequestException('Vault has no contract address — cannot build EVM snapshot');
    }

    const vaultAddress = getAddress(vaultContractAddress);
    const tokenAddress = await this.resolveVaultTokenAddress(vaultAddress);

    // Exclude the vault and the token contract itself from voting power.
    const excluded = new Set(this.excludedAddresses);
    excluded.add(vaultAddress.toLowerCase());
    excluded.add(tokenAddress.toLowerCase());

    const [decimals, totalSupplyRaw, fromBlock] = await Promise.all([
      this.read<number>({ address: tokenAddress, abi: ERC20_READ_ABI, functionName: 'decimals' })
        .then(d => Number(d))
        .catch(() => 18),
      this.read<bigint>({ address: tokenAddress, abi: ERC20_READ_ABI, functionName: 'totalSupply' }).catch(() =>
        BigInt(0)
      ),
      this.resolveDeploymentBlock(creationTxHash),
    ]);

    const candidateHolders = await this.collectHolderCandidates(tokenAddress, fromBlock);
    const addressBalances = await this.readBalances(tokenAddress, candidateHolders, excluded);

    this.logger.log(
      `EVM snapshot for vault ${vaultAddress}: token=${tokenAddress}, ` +
        `${candidateHolders.size} candidates → ${Object.keys(addressBalances).length} holders ` +
        `(decimals=${decimals}, totalSupply=${totalSupplyRaw})`
    );

    return {
      tokenAddress: tokenAddress.toLowerCase(),
      decimals,
      totalSupplyRaw,
      addressBalances,
    };
  }

  /** Probe the vault contract getters until one returns a valid VT address. */
  private async resolveVaultTokenAddress(vaultAddress: Address): Promise<Address> {
    for (const getter of VAULT_TOKEN_GETTERS) {
      try {
        const result = await this.read<Address>({
          address: vaultAddress,
          abi: [
            { name: getter, type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
          ] as const satisfies Abi,
          functionName: getter,
        });

        if (result && result.toLowerCase() !== ZERO_ADDRESS) {
          return getAddress(result);
        }
      } catch {
        // Getter not present on this contract — try the next candidate.
      }
    }

    throw new BadRequestException(
      `Could not resolve vault-token address from vault contract ${vaultAddress} ` +
        `(tried: ${VAULT_TOKEN_GETTERS.join(', ')})`
    );
  }

  /**
   * Resolve the block a vault was deployed at from its creation tx receipt, so the
   * Transfer-log scan can skip the (potentially tens of millions of) blocks that
   * predate the token. Returns block 0 when no usable hash/receipt is available.
   */
  private async resolveDeploymentBlock(creationTxHash?: string): Promise<bigint> {
    if (!creationTxHash) return BigInt(0);
    try {
      const receipt = await this.client!.getTransactionReceipt({ hash: creationTxHash as `0x${string}` });
      return receipt.blockNumber;
    } catch (error) {
      this.logger.warn(
        `Could not resolve deployment block from tx ${creationTxHash}, scanning from 0: ${(error as Error).message}`
      );
      return BigInt(0);
    }
  }

  /**
   * Collect every address that ever received the VT by scanning Transfer logs in
   * bounded block chunks (most RPCs cap the range per call). Recipients (`to`) are
   * a superset of every possible current holder — a positive balance requires at
   * least one inbound transfer — so scanning `to` alone is sufficient.
   */
  private async collectHolderCandidates(tokenAddress: Address, fromBlock: bigint): Promise<Set<string>> {
    const holders = new Set<string>();
    const latestBlock = await this.client!.getBlockNumber();

    for (let from = fromBlock; from <= latestBlock; from += this.logScanChunk) {
      const chunkEnd = from + this.logScanChunk - BigInt(1);
      const toBlock = chunkEnd > latestBlock ? latestBlock : chunkEnd;

      try {
        const logs = await this.client!.getLogs({
          address: tokenAddress,
          event: TRANSFER_EVENT,
          fromBlock: from,
          toBlock,
        });

        for (const log of logs) {
          const recipient = log.args?.to;
          if (recipient) holders.add(recipient.toLowerCase());
        }
      } catch (error) {
        this.logger.warn(
          `Transfer log scan failed for ${tokenAddress} blocks ${from}-${toBlock}: ${(error as Error).message}`
        );
      }
    }

    return holders;
  }

  /** Read `balanceOf` for each candidate (bounded concurrency) and keep non-zero, non-excluded holders. */
  private async readBalances(
    tokenAddress: Address,
    candidates: Set<string>,
    excluded: Set<string>
  ): Promise<Record<string, bigint>> {
    const addresses = [...candidates].filter(a => !excluded.has(a));
    const balances: Record<string, bigint> = {};

    for (let i = 0; i < addresses.length; i += this.balanceConcurrency) {
      const batch = addresses.slice(i, i + this.balanceConcurrency);
      const results = await Promise.all(
        batch.map(async address => {
          try {
            const balance = await this.read<bigint>({
              address: tokenAddress,
              abi: ERC20_READ_ABI,
              functionName: 'balanceOf',
              args: [getAddress(address)],
            });
            return { address, balance };
          } catch {
            return { address, balance: BigInt(0) };
          }
        })
      );

      for (const { address, balance } of results) {
        if (balance > BigInt(0)) {
          balances[address] = balance;
        }
      }
    }

    return balances;
  }
}
