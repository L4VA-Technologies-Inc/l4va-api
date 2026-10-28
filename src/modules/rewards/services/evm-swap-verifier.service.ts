import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  createPublicClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  isHash,
  keccak256,
  toBytes,
  type Hex,
  type PublicClient,
} from 'viem';

import { Market } from '@/database/market.entity';
import { Vault } from '@/database/vault.entity';
import { ChainType } from '@/types/vault.types';

const TRANSFER_TOPIC = keccak256(toBytes('Transfer(address,address,uint256)'));

type ReceiptLog = { address: string; topics: readonly Hex[]; data: Hex };

export type VerifiedEvmSwap =
  | {
      ok: true;
      vault: Pick<Vault, 'id' | 'name'>;
      vaultToken: string;
      side: 'buy' | 'sell';
      vtAmount: string;
      router: string;
      blockNumber: string;
    }
  | { ok: false; reason: string };

/**
 * Verifies a Robinhood swap from chain data alone, so the widget-swap reward
 * cannot be claimed for a transaction the caller did not make: the tx must have
 * succeeded, been sent by the caller, not be a plain token transfer, and move a
 * vault token to or from the caller.
 */
@Injectable()
export class EvmSwapVerifier {
  private readonly logger = new Logger(EvmSwapVerifier.name);
  private client: PublicClient | null = null;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(Market)
    private readonly marketRepository: Repository<Market>
  ) {}

  async verify(txHash: string, callerAddress: string): Promise<VerifiedEvmSwap> {
    if (!isHash(txHash)) return { ok: false, reason: 'invalid transaction hash' };
    if (!callerAddress || !isAddress(callerAddress)) return { ok: false, reason: 'caller has no EVM address' };
    const caller = getAddress(callerAddress);

    let receipt: Awaited<ReturnType<PublicClient['getTransactionReceipt']>>;
    try {
      receipt = await this.getClient().getTransactionReceipt({ hash: txHash as Hex });
    } catch (err) {
      this.logger.warn(`widget-swap receipt lookup failed for ${txHash}: ${(err as Error).message}`);
      return { ok: false, reason: 'transaction not found on Robinhood Chain' };
    }
    if (receipt.status !== 'success') return { ok: false, reason: 'transaction reverted' };
    if (getAddress(receipt.from) !== caller) return { ok: false, reason: 'transaction was not sent by the caller' };
    if (!receipt.to) return { ok: false, reason: 'contract creation is not a swap' };

    // Vault-token Transfer logs where the caller is the sender (sell) or recipient (buy).
    const callerTopic = caller.toLowerCase().slice(2).padStart(64, '0');
    const vtMoves = (receipt.logs as unknown as ReceiptLog[]).filter(
      log =>
        log.topics[0] === TRANSFER_TOPIC &&
        log.topics.length === 3 &&
        (log.topics[1]?.toLowerCase().endsWith(callerTopic) || log.topics[2]?.toLowerCase().endsWith(callerTopic))
    );
    if (vtMoves.length === 0) return { ok: false, reason: 'no token moved to or from the caller' };

    const tokenAddresses = [...new Set(vtMoves.map(log => log.address.toLowerCase()))];
    const market = await this.marketRepository
      .createQueryBuilder('market')
      .innerJoinAndSelect('market.vault', 'vault')
      .where('LOWER(market.contract_address) IN (:...tokens)', { tokens: tokenAddresses })
      .andWhere('vault.chain_type = :chain', { chain: ChainType.robinhood })
      .getOne();
    if (!market?.vault) return { ok: false, reason: 'no vault tokens involved' };

    const vaultToken = market.contract_address.toLowerCase();
    // A transfer sent straight to the token contract is a plain transfer, not a swap.
    if (receipt.to.toLowerCase() === vaultToken) return { ok: false, reason: 'plain token transfer is not a swap' };

    const move = vtMoves.find(log => log.address.toLowerCase() === vaultToken)!;
    const side = move.topics[2]?.toLowerCase().endsWith(callerTopic) ? 'buy' : 'sell';

    return {
      ok: true,
      vault: { id: market.vault.id, name: market.vault.name },
      vaultToken,
      side,
      vtAmount: BigInt(move.data).toString(),
      router: receipt.to.toLowerCase(),
      blockNumber: receipt.blockNumber.toString(),
    };
  }

  private getClient(): PublicClient {
    if (!this.client) {
      const rpcUrl = this.configService.get<string>('EVM_RPC_URL');
      const chain = defineChain({
        id: Number(this.configService.get<number>('EVM_CHAIN_ID', 46630)),
        name: 'Robinhood',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } },
      });
      this.client = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
    }
    return this.client;
  }
}
