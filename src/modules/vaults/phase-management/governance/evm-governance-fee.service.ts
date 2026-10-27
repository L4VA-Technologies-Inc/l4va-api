import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { getAddress, type Address, type Hex } from 'viem';

import { EvmContractReader } from '../../processing-tx/onchain/evm-contract-reader.service';

import { Transaction } from '@/database/transaction.entity';
import { SystemSettingsService } from '@/modules/globals/system-settings/system-settings.service';

/**
 * Payment parameters handed to the client. Unlike the Cardano flow there is no
 * transaction to pre-build: the user sends a plain native transfer from their
 * own wallet, so all we owe them is where to send it and how much.
 *
 * `value` and `feeAmount` are decimal strings (wei) — they must not pass
 * through `number`.
 */
export interface EvmGovernanceFeePayment {
  to: Address;
  value: string;
  chainId: number;
  feeAmount: string;
}

export interface VerifyFeePaymentParams {
  txHash: string;
  /** The wallet that must have sent the payment (the proposal creator / voter). */
  expectedFrom: string;
  /** Minimum wei that must have been transferred. */
  expectedValue: bigint;
  /**
   * Recipient quoted at the time the fee was issued. Falls back to the
   * currently configured recipient. Passing the quoted value means a later
   * change of treasury address cannot invalidate an in-flight payment.
   */
  expectedTo?: string;
}

/**
 * The payment could not be seen on chain *yet* — an unmined transaction or an
 * RPC hiccup. Distinct from a BadRequestException because the caller must NOT
 * treat this as a definitive rejection: the user may well have paid, so the
 * UNPAID proposal has to survive for a retry rather than being deleted.
 */
export class FeePaymentNotVisibleError extends Error {
  constructor(
    public readonly txHash: string,
    message: string
  ) {
    super(message);
    this.name = 'FeePaymentNotVisibleError';
  }
}

export interface VerifiedFeePayment {
  txHash: Hex;
  value: bigint;
  from: Address;
  to: Address;
  blockNumber: bigint;
}

/**
 * EVM (Robinhood) sibling of GovernanceFeeService.
 *
 * The Cardano service builds and submits the fee transaction itself, which is
 * what makes it trustworthy. Here the user broadcasts the transfer from their
 * own wallet and reports the hash back, so this service has to do the
 * verification the Cardano flow gets for free: confirm the transaction is
 * mined and successful, went to the right recipient, came from the caller,
 * carried at least the quoted amount, and has not already been spent on
 * another proposal or vote.
 */
@Injectable()
export class EvmGovernanceFeeService {
  private readonly logger = new Logger(EvmGovernanceFeeService.name);
  private readonly configuredRecipient: Address | null;
  readonly chainId: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly systemSettingsService: SystemSettingsService,
    private readonly contractReader: EvmContractReader,
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>
  ) {
    // Dedicated override first, protocol treasury otherwise. Both are optional
    // at boot: an instance with no EVM fees configured must still start.
    const raw =
      this.configService.get<string>('EVM_GOVERNANCE_FEE_ADDRESS') ||
      this.configService.get<string>('EVM_TREASURY_ADDRESS');
    this.configuredRecipient = raw ? (getAddress(raw) as Address) : null;
    this.chainId = this.contractReader.chainId;

    if (!this.configuredRecipient) {
      this.logger.warn(
        'Neither EVM_GOVERNANCE_FEE_ADDRESS nor EVM_TREASURY_ADDRESS is configured — EVM governance fees cannot be collected.'
      );
    }
  }

  /** Fee for a proposal type, in wei. */
  getProposalFeeWei(proposalType: string): bigint {
    return BigInt(this.systemSettingsService.getGovernanceFeeForProposalTypeEvm(proposalType));
  }

  /** Fee per vote, in wei. */
  getVotingFeeWei(): bigint {
    return BigInt(this.systemSettingsService.governanceFeeVotingEvm);
  }

  get feeRecipient(): Address {
    if (!this.configuredRecipient) {
      throw new BadRequestException(
        'EVM governance fee recipient is not configured. Set EVM_GOVERNANCE_FEE_ADDRESS or EVM_TREASURY_ADDRESS.'
      );
    }
    return this.configuredRecipient;
  }

  /** Payment params for creating a proposal. Returns null when the fee is 0. */
  buildProposalFeePayment(proposalType: string): EvmGovernanceFeePayment | null {
    const feeAmount = this.getProposalFeeWei(proposalType);
    if (feeAmount <= 0n) return null;
    return {
      to: this.feeRecipient,
      value: feeAmount.toString(),
      chainId: this.chainId,
      feeAmount: feeAmount.toString(),
    };
  }

  /** Payment params for casting a vote. Returns null when the fee is 0. */
  buildVotingFeePayment(): EvmGovernanceFeePayment | null {
    const feeAmount = this.getVotingFeeWei();
    if (feeAmount <= 0n) return null;
    return {
      to: this.feeRecipient,
      value: feeAmount.toString(),
      chainId: this.chainId,
      feeAmount: feeAmount.toString(),
    };
  }

  /**
   * Verify a user-submitted fee payment. Throws BadRequestException on any
   * failed check so the caller can surface the reason to the user directly.
   */
  async verifyFeePayment(params: VerifyFeePaymentParams): Promise<VerifiedFeePayment> {
    const { txHash, expectedFrom, expectedValue } = params;

    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      throw new BadRequestException(`Invalid transaction hash: ${txHash}`);
    }
    const hash = txHash.toLowerCase() as Hex;

    // Replay guard. A hash is proof of exactly one payment, so it may back
    // exactly one proposal or vote. Checked before the RPC round-trip.
    await this.assertHashUnused(hash);

    const expectedTo = params.expectedTo ? getAddress(params.expectedTo) : this.feeRecipient;

    // The client waits for the receipt before calling us, so a miss here is
    // almost always our RPC lagging behind the wallet's by a block. Retry
    // briefly rather than sending the user away with a payment already made.
    const receipt = await this.fetchReceiptWithRetry(hash);
    if (receipt.status !== 'success') {
      throw new BadRequestException(`Fee transaction ${hash} reverted on chain`);
    }

    // The receipt carries from/to but not value, so read the transaction too.
    const tx = await this.contractReader.publicClient.getTransaction({ hash });
    if (!tx) {
      throw new FeePaymentNotVisibleError(hash, `Fee transaction ${hash} could not be read`);
    }

    const actualTo = tx.to ? getAddress(tx.to) : null;
    if (!actualTo || actualTo !== expectedTo) {
      throw new BadRequestException(
        `Fee transaction ${hash} was sent to ${actualTo ?? 'a contract creation'}, expected ${expectedTo}`
      );
    }

    const actualFrom = getAddress(tx.from);
    if (actualFrom !== getAddress(expectedFrom)) {
      throw new BadRequestException(
        `Fee transaction ${hash} was sent from ${actualFrom}, expected ${getAddress(expectedFrom)}`
      );
    }

    const value = BigInt(tx.value ?? 0n);
    if (value < expectedValue) {
      throw new BadRequestException(
        `Fee transaction ${hash} paid ${value} wei, expected at least ${expectedValue} wei`
      );
    }

    const chainId = typeof tx.chainId === 'number' ? tx.chainId : this.chainId;
    if (chainId !== this.chainId) {
      throw new BadRequestException(`Fee transaction ${hash} is on chain ${chainId}, expected ${this.chainId}`);
    }

    this.logger.log(`Verified EVM governance fee ${hash}: ${value} wei from ${actualFrom} to ${actualTo}`);

    return {
      txHash: hash,
      value,
      from: actualFrom,
      to: actualTo,
      blockNumber: BigInt(receipt.blockNumber ?? 0n),
    };
  }

  private static readonly RECEIPT_RETRY_ATTEMPTS = 4;
  private static readonly RECEIPT_RETRY_DELAY_MS = 1_500;

  /**
   * Fetch the receipt, retrying a few times before giving up. Throws
   * FeePaymentNotVisibleError — never a plain rejection — because a missing
   * receipt does not prove the user failed to pay.
   */
  private async fetchReceiptWithRetry(
    hash: Hex
  ): Promise<NonNullable<Awaited<ReturnType<EvmContractReader['getTransactionReceipt']>>>> {
    let lastError: string = 'not yet mined';

    for (let attempt = 0; attempt < EvmGovernanceFeeService.RECEIPT_RETRY_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise(resolve => setTimeout(resolve, EvmGovernanceFeeService.RECEIPT_RETRY_DELAY_MS));
      }
      try {
        const receipt = await this.contractReader.getTransactionReceipt(hash);
        if (receipt) return receipt;
      } catch (error) {
        lastError = (error as Error).message;
      }
    }

    throw new FeePaymentNotVisibleError(hash, `Fee transaction ${hash} is not visible on chain yet: ${lastError}`);
  }

  /**
   * Reject a hash that already backs a recorded transaction. Compared
   * lower-cased because hashes reach us from wallets in mixed case.
   */
  private async assertHashUnused(hash: Hex): Promise<void> {
    const existing = await this.transactionRepository
      .createQueryBuilder('tx')
      .where('LOWER(tx.tx_hash) = :hash', { hash })
      .getExists();

    if (existing) {
      throw new BadRequestException(`Fee transaction ${hash} has already been used for another payment`);
    }
  }
}
