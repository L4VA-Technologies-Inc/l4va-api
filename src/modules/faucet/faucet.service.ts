import { BadRequestException, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { createPublicClient, getAddress, http, isAddress, parseAbi, parseUnits, type Address } from 'viem';

import { FaucetClaimRes, FaucetStatusRes, FaucetTokenRes } from './dto/faucet.res';

import { REDIS_CLIENT } from '@/modules/redis/redis.module';
import { EvmAdminSigner } from '@/modules/vaults/processing-tx/onchain/evm-admin-signer.service';

/** The testnet basket tokens (tTSLA, tAAPL, ...) expose a permissionless mint(address,uint256). */
const TEST_TOKEN_ABI = parseAbi([
  'function mint(address to, uint256 amount)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);

type FaucetToken = { address: Address; symbol: string; decimals: number };

/**
 * Testnet faucet: mints a fixed amount of each of our Robinhood test tokens to the caller's wallet,
 * from the EVM admin wallet (the backend pays gas). One claim per wallet per cooldown window.
 *
 * Always on for testnet deployments, never on mainnet.
 */
@Injectable()
export class FaucetService implements OnModuleInit {
  private readonly logger = new Logger(FaucetService.name);
  private readonly enabled: boolean;
  private readonly tokenAddresses: Address[];
  private readonly amount: number;
  private readonly cooldownMs: number;
  private tokens: FaucetToken[] = [];
  /** Admin-wallet txs must not interleave (nonces), so claims are processed one at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly configService: ConfigService,
    private readonly signer: EvmAdminSigner,
    @Inject(REDIS_CLIENT) private readonly redis: Redis
  ) {
    this.enabled = this.configService.get<string>('CARDANO_NETWORK') !== 'mainnet';

    const rawTokens =
      this.configService.get<string>('FAUCET_TOKENS') || this.configService.get<string>('INDEX_BASKET_ALLOWED_ASSETS');
    this.tokenAddresses = (rawTokens ?? '')
      .split(',')
      .map(value => value.trim())
      .filter(value => isAddress(value))
      .map(value => getAddress(value));

    this.amount = Number(this.configService.get<string>('FAUCET_TOKEN_AMOUNT') ?? 1000) || 1000;
    this.cooldownMs = (Number(this.configService.get<string>('FAUCET_COOLDOWN_HOURS') ?? 24) || 24) * 60 * 60 * 1000;
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled || this.tokenAddresses.length === 0) return;

    // Same as EvmAdminSigner: viem's strict generics do not resolve here, so the client is untyped.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = createPublicClient({ transport: http(this.configService.get<string>('EVM_RPC_URL')) });
    const results = await Promise.allSettled(
      this.tokenAddresses.map(async address => {
        const [symbol, decimals] = await Promise.all([
          client.readContract({ address, abi: TEST_TOKEN_ABI, functionName: 'symbol' }),
          client.readContract({ address, abi: TEST_TOKEN_ABI, functionName: 'decimals' }),
        ]);
        return { address, symbol: String(symbol), decimals: Number(decimals) };
      })
    );

    this.tokens = results.flatMap((result, index) => {
      if (result.status === 'fulfilled') return [result.value];
      this.logger.warn(`Faucet: skipping token ${this.tokenAddresses[index]}: ${(result.reason as Error)?.message}`);
      return [];
    });
    this.logger.log(`Faucet enabled with ${this.tokens.length} token(s): ${this.tokens.map(t => t.symbol).join(', ')}`);
  }

  private cooldownKey(address: Address): string {
    return `faucet:claim:${address.toLowerCase()}`;
  }

  private tokenList(): FaucetTokenRes[] {
    return this.tokens.map(token => ({ address: token.address, symbol: token.symbol, amount: this.amount }));
  }

  private async getNextClaimAt(address: Address): Promise<number | null> {
    const ttlMs = await this.redis.pttl(this.cooldownKey(address));
    return ttlMs > 0 ? Date.now() + ttlMs : null;
  }

  private resolveWallet(walletAddress: string | undefined): Address {
    if (!walletAddress || !isAddress(walletAddress)) {
      throw new BadRequestException('Connect a Robinhood Chain (EVM) wallet to use the faucet.');
    }
    return getAddress(walletAddress);
  }

  async getStatus(walletAddress: string | undefined): Promise<FaucetStatusRes> {
    const isEvmWallet = !!walletAddress && isAddress(walletAddress);
    return {
      enabled: this.enabled && this.tokens.length > 0,
      tokens: this.tokenList(),
      cooldownHours: this.cooldownMs / (60 * 60 * 1000),
      nextClaimAt: isEvmWallet ? await this.getNextClaimAt(getAddress(walletAddress)) : null,
    };
  }

  async claim(walletAddress: string | undefined): Promise<FaucetClaimRes> {
    if (!this.enabled || this.tokens.length === 0) {
      throw new BadRequestException('The faucet is not available on this environment.');
    }
    const recipient = this.resolveWallet(walletAddress);

    // Reserve the cooldown slot first so concurrent requests from the same wallet cannot double-claim.
    const reserved = await this.redis.set(this.cooldownKey(recipient), String(Date.now()), 'PX', this.cooldownMs, 'NX');
    if (!reserved) {
      const nextClaimAt = await this.getNextClaimAt(recipient);
      const when = nextClaimAt ? new Date(nextClaimAt).toISOString() : 'later';
      throw new BadRequestException(`You already claimed test tokens. Next claim available at ${when}.`);
    }

    const run = this.queue.then(() => this.mintAll(recipient));
    this.queue = run.catch(() => undefined);

    try {
      const transactions = await run;
      return { address: recipient, transactions, nextClaimAt: Date.now() + this.cooldownMs };
    } catch (error) {
      // Nothing was sent: release the slot so the user can retry.
      await this.redis.del(this.cooldownKey(recipient));
      throw error;
    }
  }

  private async mintAll(recipient: Address): Promise<FaucetClaimRes['transactions']> {
    const transactions: FaucetClaimRes['transactions'] = [];

    for (const token of this.tokens) {
      try {
        const { hash } = await this.signer.sendAndConfirm({
          address: token.address,
          abi: TEST_TOKEN_ABI,
          functionName: 'mint',
          args: [recipient, parseUnits(String(this.amount), token.decimals)],
        });
        transactions.push({ token: token.address, symbol: token.symbol, txHash: hash });
      } catch (error) {
        this.logger.error(`Faucet mint of ${token.symbol} to ${recipient} failed: ${(error as Error).message}`);
      }
    }

    if (transactions.length === 0) {
      throw new BadRequestException('The faucet could not send test tokens right now. Please try again later.');
    }
    this.logger.log(`Faucet: minted ${transactions.length}/${this.tokens.length} test tokens to ${recipient}`);
    return transactions;
  }
}
