import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';

const TRADING_API_BASE = 'https://trade-api.gateway.uniswap.org/v1';
const NATIVE_ETH = '0x0000000000000000000000000000000000000000';
const DEFAULT_PROTOCOLS = ['V2', 'V3', 'V4', 'UNISWAPX_V3'] as const;

export interface UniswapQuoteBody {
  tokenIn: string;
  tokenOut: string;
  amount: string;
  swapper: string;
  type?: 'EXACT_INPUT' | 'EXACT_OUTPUT';
  slippageTolerance?: number;
  protocols?: string[];
  permitAmount?: 'FULL' | 'EXACT';
  /** Override server fee; normally taken from env. */
  skipIntegratorFee?: boolean;
}

@Injectable()
export class UniswapTradingService {
  private readonly logger = new Logger(UniswapTradingService.name);
  private readonly apiKey?: string;
  /** Trading API target — Uniswap on Robinhood mainnet is 4663. */
  private readonly chainId: number;
  private readonly feeBips?: number;
  private readonly feeRecipient?: string;

  constructor(
    private readonly httpService: HttpService,
    configService: ConfigService
  ) {
    this.apiKey = configService.get<string>('UNISWAP_API_KEY') || undefined;
    this.chainId = Number(configService.get<string>('UNISWAP_CHAIN_ID') || '4663');
    const bipsRaw = configService.get<string>('UNISWAP_INTEGRATOR_FEE_BIPS');
    const recipient = configService.get<string>('UNISWAP_FEE_RECIPIENT');
    if (bipsRaw && recipient && /^0x[a-fA-F0-9]{40}$/.test(recipient)) {
      const bips = Number(bipsRaw);
      if (bips > 0 && bips <= 500) {
        this.feeBips = bips;
        this.feeRecipient = recipient;
      }
    }
  }

  getConfig() {
    return {
      chainId: this.chainId,
      nativeToken: NATIVE_ETH,
      /** WETH on Robinhood mainnet — useful as ERC-20 quote pair. */
      weth: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
      usdg: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
      integratorFeeBips: this.feeBips ?? null,
      hasFeeRecipient: Boolean(this.feeRecipient),
      apiConfigured: Boolean(this.apiKey),
    };
  }

  async quote(body: UniswapQuoteBody) {
    this.assertApiKey();
    this.validateAddresses(body.tokenIn, body.tokenOut, body.swapper);
    if (!body.amount || !/^\d+$/.test(body.amount)) {
      throw new BadRequestException('amount must be a positive integer string (wei / raw units)');
    }

    const payload: Record<string, unknown> = {
      type: body.type || 'EXACT_INPUT',
      amount: body.amount,
      tokenIn: body.tokenIn,
      tokenOut: body.tokenOut,
      tokenInChainId: this.chainId,
      tokenOutChainId: this.chainId,
      swapper: body.swapper,
      slippageTolerance: body.slippageTolerance ?? 0.5,
      protocols: body.protocols?.length ? body.protocols : [...DEFAULT_PROTOCOLS],
      permitAmount: body.permitAmount || 'EXACT',
    };

    if (!body.skipIntegratorFee && this.feeBips && this.feeRecipient) {
      payload.integratorFees = [{ bips: this.feeBips, recipient: this.feeRecipient }];
    }

    const headers = this.tradingHeaders({
      erc20eth: body.tokenIn.toLowerCase() === NATIVE_ETH.toLowerCase(),
    });

    return this.post('/quote', payload, headers);
  }

  async checkApproval(body: {
    walletAddress: string;
    token: string;
    amount: string;
    tokenOut?: string;
  }) {
    this.assertApiKey();
    this.validateAddresses(body.token, body.walletAddress);
    if (!body.amount || !/^\d+$/.test(body.amount)) {
      throw new BadRequestException('amount must be a positive integer string');
    }

    return this.post(
      '/check_approval',
      {
        walletAddress: body.walletAddress,
        token: body.token,
        amount: body.amount,
        chainId: this.chainId,
        ...(body.tokenOut
          ? { tokenOut: body.tokenOut, tokenOutChainId: this.chainId }
          : {}),
      },
      this.tradingHeaders()
    );
  }

  async swap(body: {
    quote: unknown;
    signature?: string;
    permitData?: unknown;
    refreshGasPrice?: boolean;
    simulateTransaction?: boolean;
  }) {
    this.assertApiKey();
    if (!body.quote) throw new BadRequestException('quote is required');

    const payload: Record<string, unknown> = {
      quote: body.quote,
      refreshGasPrice: body.refreshGasPrice ?? true,
      simulateTransaction: body.simulateTransaction ?? false,
    };

    if (body.permitData != null) {
      if (!body.signature) {
        throw new BadRequestException('signature is required when permitData is provided');
      }
      payload.permitData = body.permitData;
      payload.signature = body.signature;
    }

    return this.post('/swap', payload, this.tradingHeaders());
  }

  async order(body: { quote: unknown; signature: string; routing: string }) {
    this.assertApiKey();
    if (!body.quote || !body.signature || !body.routing) {
      throw new BadRequestException('quote, signature, and routing are required');
    }

    return this.post(
      '/order',
      {
        quote: body.quote,
        signature: body.signature,
        routing: body.routing,
      },
      this.tradingHeaders({ erc20eth: true })
    );
  }

  // ---------------------------------------------------------------------------

  private tradingHeaders(opts?: { erc20eth?: boolean }): Record<string, string> {
    const headers: Record<string, string> = {
      'x-api-key': this.apiKey as string,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      // Robinhood Chain defaults to UR 2.1.1; set explicitly for fractional fee support.
      'x-universal-router-version': '2.1.1',
    };
    if (opts?.erc20eth) {
      headers['x-erc20eth-enabled'] = 'true';
    }
    return headers;
  }

  private assertApiKey() {
    if (!this.apiKey) {
      throw new ServiceUnavailableException('UNISWAP_API_KEY is not configured');
    }
  }

  private validateAddresses(...addrs: string[]) {
    for (const a of addrs) {
      if (!a || !/^0x[a-fA-F0-9]{40}$/.test(a)) {
        throw new BadRequestException(`Invalid address: ${a}`);
      }
    }
  }

  private async post(path: string, body: unknown, headers: Record<string, string>) {
    try {
      const response = await firstValueFrom(
        this.httpService.post(`${TRADING_API_BASE}${path}`, body, {
          headers,
          timeout: 20_000,
          validateStatus: () => true,
        })
      );

      const status = response.status;
      const data = response.data;

      if (status === 401) {
        throw new UnauthorizedException(data?.detail || data?.message || 'Invalid Uniswap API key');
      }
      if (status >= 400) {
        const detail =
          data?.detail || data?.message || data?.error || `Uniswap Trading API error (${status})`;
        this.logger.warn(`Uniswap ${path} failed: ${status} ${JSON.stringify(data)?.slice(0, 400)}`);
        throw new BadRequestException(typeof detail === 'string' ? detail : JSON.stringify(detail));
      }

      return data;
    } catch (err) {
      if (
        err instanceof BadRequestException ||
        err instanceof UnauthorizedException ||
        err instanceof ServiceUnavailableException
      ) {
        throw err;
      }
      const axiosErr = err as AxiosError;
      this.logger.error(`Uniswap ${path} network error: ${axiosErr.message}`);
      throw new ServiceUnavailableException('Uniswap Trading API unreachable');
    }
  }
}
