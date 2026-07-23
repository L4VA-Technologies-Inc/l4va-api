import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createWalletClient,
  decodeEventLog,
  http,
  type Abi,
  type Account,
  type Address,
  type Hex,
  type Log,
  type TransactionReceipt,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { EvmContractReader } from './evm-contract-reader.service';

export interface AdminTxOptions<TAbi extends Abi, TFunctionName extends string> {
  address: Address;
  abi: TAbi;
  functionName: TFunctionName;
  args: unknown[];
  value?: bigint;
  /** Optional receipt-poll timeout (ms). Defaults to 120s. */
  timeoutMs?: number;
}

export interface AdminTxResult {
  hash: Hex;
  receipt: TransactionReceipt;
  /**
   * Decoded logs matching the caller-provided event names, in emission order.
   * Each entry includes the emitting contract `address` — CALLERS MUST validate
   * both `address === expectedVaultAddress` AND every `args.*` value against
   * the payload they broadcast before writing to the database. This service
   * deliberately does not enforce those checks; it decodes generically so
   * multiple operation services can reuse the pipeline without leaking
   * their per-flow invariants down here.
   */
  decodedEvents: Array<{ address: Address; eventName: string; args: Record<string, unknown> }>;
}

/**
 * Admin-signed on-chain tx pipeline. Every EVM state change signed by the
 * backend goes through this: closeCycle, cancelCurrentCycle, claimAllocations,
 * refundContributions.
 *
 * Enforces the pattern from the plan:
 *   simulate → broadcast → wait for receipt → require success →
 *     decode expected events → return {hash, receipt, decodedEvents}.
 *
 * DB mutations happen in the caller inside a single transaction using the
 * returned decoded events. The webhook path may later re-process the same
 * events; caller must use unique keys so both paths converge idempotently.
 */
@Injectable()
export class EvmAdminSigner {
  private readonly logger = new Logger(EvmAdminSigner.name);

  private readonly account: Account;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly walletClient: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly publicClient: any;
  readonly address: Address;
  readonly chainId: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly contractReader: EvmContractReader
  ) {
    const privateKey = this.configService.get<string>('EVM_ADMIN_PRIVATE_KEY');
    if (!privateKey) {
      throw new Error(
        'EVM_ADMIN_PRIVATE_KEY is not configured. Required for closeCycle / cancelCurrentCycle / claim / refund flows.'
      );
    }
    const explicitAddress = this.configService.get<string>('EVM_ADMIN_ADDRESS');
    const rpcUrl = this.configService.get<string>('EVM_RPC_URL');
    if (!rpcUrl) throw new Error('EVM_RPC_URL is not configured.');

    this.account = privateKeyToAccount(privateKey as Hex);
    this.address = (explicitAddress as Address) ?? this.account.address;

    if (explicitAddress && explicitAddress.toLowerCase() !== this.account.address.toLowerCase()) {
      throw new Error(
        `EVM_ADMIN_ADDRESS (${explicitAddress}) does not match derived address (${this.account.address}) for the configured private key.`
      );
    }

    this.chainId = this.contractReader.chainId;
    this.publicClient = this.contractReader.publicClient;
    this.walletClient = createWalletClient({
      account: this.account,
      transport: http(rpcUrl),
    });
  }

  /**
   * simulate → broadcast → wait receipt → require success → decode events.
   *
   * @param expectedEventNames Event names (from `opts.abi`) whose logs the caller
   *   wants back, decoded. Non-matching logs are ignored. If a required event is
   *   missing from a successful receipt, caller can detect via `decodedEvents.length`.
   */
  async sendAndConfirm<TAbi extends Abi, TFunctionName extends string>(
    opts: AdminTxOptions<TAbi, TFunctionName>,
    expectedEventNames: string[] = []
  ): Promise<AdminTxResult> {
    const { address, abi, functionName, args, value, timeoutMs = 120_000 } = opts;

    // 1. Simulate — catches revert before we pay gas.
    try {
      await this.publicClient.simulateContract({
        account: this.account,
        address,
        abi,
        functionName,
        args,
        value,
      });
    } catch (err) {
      const message = (err as Error).message || String(err);
      this.logger.error(`simulateContract(${functionName}) reverted: ${message}`);
      throw err;
    }

    // 2. Broadcast.
    const hash = (await this.walletClient.writeContract({
      account: this.account,
      chain: null,
      address,
      abi,
      functionName,
      args,
      value,
    })) as Hex;

    this.logger.log(`Broadcast ${functionName} tx=${hash}`);

    // 3. Wait for receipt.
    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash,
      timeout: timeoutMs,
    });

    // 4. Require success.
    if (receipt.status !== 'success') {
      throw new Error(`Transaction ${hash} reverted on-chain (status=${receipt.status})`);
    }

    // 5. Decode expected events.
    const decodedEvents = expectedEventNames.length > 0 ? this.decodeEvents(abi, receipt.logs, expectedEventNames) : [];

    return { hash, receipt, decodedEvents };
  }

  private decodeEvents(
    abi: Abi,
    logs: readonly Log[],
    expectedEventNames: string[]
  ): Array<{ address: Address; eventName: string; args: Record<string, unknown> }> {
    const set = new Set(expectedEventNames);
    const out: Array<{ address: Address; eventName: string; args: Record<string, unknown> }> = [];
    for (const log of logs) {
      // viem's Log type has `topics` at runtime but the union in
      // TransactionReceipt.logs narrows it away in some versions — access via cast.
      const raw = log as unknown as { address: Address; data: Hex; topics: [Hex, ...Hex[]] | [] };
      try {
        const decoded = decodeEventLog({
          abi,
          data: raw.data,
          topics: raw.topics,
        });
        if (set.has(decoded.eventName)) {
          out.push({
            address: raw.address,
            eventName: decoded.eventName,
            args: decoded.args as unknown as Record<string, unknown>,
          });
        }
      } catch {
        // log came from another contract or a different ABI — ignore.
      }
    }
    return out;
  }
}
