import { Blockfrost, getAddressDetails, Lucid, type LucidEvolution } from '@lucid-evolution/lucid';
import { Injectable, Logger, BadRequestException, InternalServerErrorException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ClaimTxResult {
  success: boolean;
  txHash?: string;
  claimedAmount?: number;
  error?: string;
}

export interface PrepareClaimTxResult {
  success: boolean;
  /** Unsigned transaction CBOR hex — send to client for user signing via CIP-30 */
  txCbor?: string;
  error?: string;
}

export interface SubmitClaimTxResult {
  success: boolean;
  txHash?: string;
  error?: string;
}

/**
 * Service to build Cardano transactions for L4VA rewards claims using Lucid.
 * Sends L4VA tokens from the treasury wallet to claiming users.
 */
@Injectable()
export class RewardsClaimTxBuilderService implements OnModuleInit {
  private readonly logger = new Logger(RewardsClaimTxBuilderService.name);
  private readonly l4vaPolicyId: string;
  private readonly l4vaAssetName: string;
  private readonly l4vaDecimals: number;
  private readonly treasuryKey: string;
  private readonly treasuryAddress: string;
  private readonly networkId: number;

  /** Singleton Lucid instance — initialized once on module startup. */
  private lucid: LucidEvolution | null = null;

  /**
   * Serializes concurrent tx builds because selectWallet.fromAddress() mutates
   * the shared Lucid instance. Ensures one request completes selectWallet→complete
   * before the next begins.
   */
  private buildLock: Promise<void> = Promise.resolve();

  /** Cached treasury UTxOs with timestamp for TTL-based invalidation. */
  private utxoCache: { utxos: Awaited<ReturnType<LucidEvolution['utxosAt']>>; fetchedAt: number } | null = null;
  private readonly UTXO_CACHE_TTL_MS = 20_000; // 20 seconds

  constructor(private readonly configService: ConfigService) {
    this.l4vaPolicyId = this.configService.get<string>('L4VA_POLICY_ID');
    this.l4vaAssetName = this.configService.get<string>('L4VA_ASSET_NAME');
    this.l4vaDecimals = this.configService.get<number>('L4VA_DECIMALS') || 1;
    this.treasuryKey = this.configService.get<string>('L4VA_TREASURY_KEY');
    this.treasuryAddress = this.configService.get<string>('L4VA_TREASURY_ADDRESS');
    this.networkId = Number(this.configService.get<string>('NETWORK_ID')) || 0;

    // Validate configuration
    if (!this.l4vaPolicyId || !this.l4vaAssetName) {
      this.logger.error('L4VA token configuration missing. Set L4VA_POLICY_ID and L4VA_ASSET_NAME');
    }

    if (!this.treasuryKey || !this.treasuryAddress) {
      this.logger.error('L4VA treasury configuration missing. Set L4VA_TREASURY_KEY and L4VA_TREASURY_ADDRESS');
    }
  }

  async onModuleInit(): Promise<void> {
    try {
      this.lucid = await this.createLucidInstance();
      this.logger.log('Lucid instance initialized');
    } catch (error: any) {
      this.logger.error(`Failed to initialize Lucid on startup: ${error?.message}`, error?.stack);
    }
  }

  private async createLucidInstance(): Promise<LucidEvolution> {
    const network = this.networkId === 1 ? 'Mainnet' : 'Preprod';
    return Lucid(
      new Blockfrost(
        `https://cardano-${network.toLowerCase()}.blockfrost.io/api/v0`,
        this.configService.get<string>('BLOCKFROST_API_KEY')
      ),
      network
    );
  }

  private async getLucid(): Promise<LucidEvolution> {
    if (!this.lucid) {
      this.lucid = await this.createLucidInstance();
    }
    return this.lucid;
  }

  /**
   * Returns cached treasury UTxOs, refreshing from Blockfrost only when the cache is stale.
   * Pass force=true after submitting a transaction to immediately invalidate.
   */
  /**
   * Returns cached treasury UTxOs, refreshing from Blockfrost only when the cache is stale.
   * Pass force=true after submitting a transaction to immediately invalidate.
   */
  private async getTreasuryUtxos(force = false): Promise<Awaited<ReturnType<LucidEvolution['utxosAt']>>> {
    const now = Date.now();
    if (!force && this.utxoCache && now - this.utxoCache.fetchedAt < this.UTXO_CACHE_TTL_MS) {
      return this.utxoCache.utxos;
    }
    const lucid = await this.getLucid();
    const utxos = await lucid.utxosAt(this.treasuryAddress);
    this.utxoCache = { utxos, fetchedAt: Date.now() };
    this.logger.log(`Treasury UTxOs refreshed from Blockfrost (${utxos.length} UTxOs)`);
    return utxos;
  }

  /**
   * Acquires a simple promise-based lock so that the selectWallet.fromAddress +
   * tx.complete() sequence cannot be interleaved by concurrent requests.
   */
  private async withBuildLock<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const nextLock = new Promise<void>(resolve => {
      release = resolve;
    });
    const acquired = this.buildLock;
    this.buildLock = acquired.then(() => nextLock);
    await acquired;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Phase 1: Build an UNSIGNED claim transaction.
   * Sends L4VA tokens from treasury to user with requiredSigners so the
   * user wallet must co-sign — proving explicit intent and preventing
   * server-side double-spend.
   *
   * Returns unsigned txCbor to send to the client for CIP-30 signing.
   * Does NOT submit to the blockchain.
   *
   * @param walletAddress - User's wallet address (bech32) — also used as the recipient
   * @param claimAmount   - Amount of L4VA tokens to claim (in base units)
   */
  async prepareClaimTx(walletAddress: string, claimAmount: number): Promise<PrepareClaimTxResult> {
    try {
      if (!this.treasuryKey || !this.treasuryAddress) {
        throw new BadRequestException('L4VA treasury not configured');
      }

      if (!walletAddress || claimAmount <= 0) {
        throw new BadRequestException('Invalid wallet address or claim amount');
      }

      const humanReadable = claimAmount / 10 ** this.l4vaDecimals;
      this.logger.log(
        `Preparing unsigned claim tx: ${humanReadable.toFixed(this.l4vaDecimals)} L4VA to ${walletAddress.slice(0, 20)}...`
      );

      const lucid = await this.getLucid();
      const treasuryUtxos = await this.getTreasuryUtxos();

      if (!treasuryUtxos || treasuryUtxos.length === 0) {
        throw new InternalServerErrorException('No UTXOs available in treasury wallet');
      }

      const l4vaUnit = this.l4vaPolicyId + this.l4vaAssetName;

      const totalL4vaInTreasury = treasuryUtxos.reduce((sum, utxo) => {
        return sum + Number(utxo.assets[l4vaUnit] || 0n);
      }, 0);

      if (totalL4vaInTreasury < claimAmount) {
        const requiredHuman = (claimAmount / 10 ** this.l4vaDecimals).toFixed(this.l4vaDecimals);
        const availableHuman = (totalL4vaInTreasury / 10 ** this.l4vaDecimals).toFixed(this.l4vaDecimals);
        throw new BadRequestException(
          `Insufficient L4VA in treasury. Required: ${requiredHuman} L4VA, Available: ${availableHuman} L4VA`
        );
      }

      // Extract payment key hash from user's bech32 address
      const addressDetails = getAddressDetails(walletAddress);
      const userKeyHash = addressDetails.paymentCredential?.hash;

      if (!userKeyHash) {
        throw new BadRequestException('Cannot extract payment key hash from wallet address');
      }

      const TX_VALIDITY_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

      // Build unsigned tx — serialized via buildLock since selectWallet mutates the Lucid instance
      const txCbor = await this.withBuildLock(async () => {
        lucid.selectWallet.fromAddress(this.treasuryAddress, treasuryUtxos);
        const tx = await lucid
          .newTx()
          .pay.ToAddress(walletAddress, { [l4vaUnit]: BigInt(claimAmount) })
          .addSignerKey(userKeyHash)
          .validTo(Date.now() + TX_VALIDITY_WINDOW_MS)
          .complete({ changeAddress: this.treasuryAddress });
        return tx.toCBOR();
      });

      this.logger.log(`Unsigned claim tx built for ${walletAddress.slice(0, 20)}...`);

      return { success: true, txCbor };
    } catch (error: any) {
      this.logger.error(`Failed to prepare claim transaction: ${error?.message || error}`, error?.stack);
      return { success: false, error: error?.message || String(error) };
    }
  }

  /**
   * Phase 2: Assemble treasury + user witness, then submit to blockchain.
   * Only called AFTER the user has signed txCbor via CIP-30 signTx().
   *
   * @param txCbor       - The same unsigned tx CBOR from prepareClaimTx
   * @param userWitness  - Hex-encoded witness set from CIP-30 signTx()
   */
  async submitClaimTx(txCbor: string, userWitness: string): Promise<SubmitClaimTxResult> {
    try {
      if (!this.treasuryKey) {
        throw new BadRequestException('L4VA treasury not configured');
      }

      if (!txCbor || !userWitness) {
        throw new BadRequestException('txCbor and userWitness are required');
      }

      const lucid = await this.getLucid();

      // Assemble: treasury key sign + user witness
      const signedTx = await lucid
        .fromTx(txCbor)
        .assemble([userWitness])
        .sign.withPrivateKey(this.treasuryKey)
        .complete();

      const txHash = await signedTx.submit();

      // Invalidate UTxO cache — the treasury UTxO set just changed on-chain
      this.utxoCache = null;

      this.logger.log(`Claim transaction submitted: ${txHash}`);

      return { success: true, txHash };
    } catch (error: any) {
      this.logger.error(`Failed to submit claim transaction: ${error?.message || error}`, error?.stack);
      return { success: false, error: error?.message || String(error) };
    }
  }

  /**
   * @deprecated Use prepareClaimTx + submitClaimTx instead.
   * Build and submit a claim transaction server-side (no user witness).
   */
  async buildClaimTransaction(walletAddress: string, claimAmount: number): Promise<ClaimTxResult> {
    try {
      if (!this.treasuryKey || !this.treasuryAddress) {
        throw new BadRequestException('L4VA treasury not configured');
      }

      if (!walletAddress || claimAmount <= 0) {
        throw new BadRequestException('Invalid wallet address or claim amount');
      }

      // claimAmount is already in base units
      const humanReadable = claimAmount / 10 ** this.l4vaDecimals;
      this.logger.log(
        `Building claim transaction: ${humanReadable.toFixed(this.l4vaDecimals)} L4VA to ${walletAddress.slice(0, 20)}...`
      );

      const lucid = await this.getLucid();

      // Get treasury UTXOs
      const treasuryUtxos = await this.getTreasuryUtxos();

      if (!treasuryUtxos || treasuryUtxos.length === 0) {
        throw new InternalServerErrorException('No UTXOs available in treasury wallet');
      }

      // Build the L4VA asset unit
      const l4vaUnit = this.l4vaPolicyId + this.l4vaAssetName;

      // Calculate total L4VA in treasury
      const totalL4vaInTreasury = treasuryUtxos.reduce((sum, utxo) => {
        const l4vaAmount = utxo.assets[l4vaUnit] || 0n;
        return sum + Number(l4vaAmount);
      }, 0);

      const treasuryHumanReadable = totalL4vaInTreasury / 10 ** this.l4vaDecimals;
      this.logger.debug(`Total L4VA in treasury: ${treasuryHumanReadable.toFixed(this.l4vaDecimals)} L4VA`);

      if (totalL4vaInTreasury < claimAmount) {
        const requiredHuman = (claimAmount / 10 ** this.l4vaDecimals).toFixed(this.l4vaDecimals);
        const availableHuman = (totalL4vaInTreasury / 10 ** this.l4vaDecimals).toFixed(this.l4vaDecimals);
        throw new BadRequestException(
          `Insufficient L4VA in treasury. Required: ${requiredHuman} L4VA, Available: ${availableHuman} L4VA`
        );
      }

      // Build and sign tx — serialized via buildLock since selectWallet mutates the Lucid instance
      const { tx, txHash } = await this.withBuildLock(async () => {
        lucid.selectWallet.fromAddress(this.treasuryAddress, treasuryUtxos);
        const builtTx = await lucid
          .newTx()
          .pay.ToAddress(walletAddress, {
            [l4vaUnit]: BigInt(claimAmount),
          })
          .complete({ changeAddress: this.treasuryAddress });
        const signedTx = await builtTx.sign.withPrivateKey(this.treasuryKey).complete();
        const hash = await signedTx.submit();
        return { tx: builtTx, txHash: hash };
      });
      void tx; // suppress unused warning

      // Invalidate UTxO cache — the treasury UTxO set just changed on-chain
      this.utxoCache = null;

      const claimedHuman = (claimAmount / 10 ** this.l4vaDecimals).toFixed(this.l4vaDecimals);
      this.logger.log(
        `Claim transaction submitted: ${txHash} - ${claimedHuman} L4VA to ${walletAddress.slice(0, 20)}...`
      );

      return {
        success: true,
        txHash,
        claimedAmount: claimAmount,
      };
    } catch (error: any) {
      this.logger.error(`Failed to build claim transaction: ${error?.message || error}`, error?.stack);
      return {
        success: false,
        error: error?.message || String(error),
      };
    }
  }

  /**
   * Get treasury balance information.
   */
  async getTreasuryBalance(): Promise<{
    address: string;
    lovelace: number;
    l4vaBalance: number;
    utxoCount: number;
  }> {
    try {
      const network = this.networkId === 1 ? 'Mainnet' : 'Preprod';
      const lucid = await Lucid(
        new Blockfrost(
          `https://cardano-${network.toLowerCase()}.blockfrost.io/api/v0`,
          this.configService.get<string>('BLOCKFROST_API_KEY')
        ),
        network
      );

      const utxos = await lucid.utxosAt(this.treasuryAddress);
      const l4vaUnit = this.l4vaPolicyId + this.l4vaAssetName;

      const lovelace = utxos.reduce((sum, utxo) => sum + Number(utxo.assets.lovelace || 0n), 0);
      const l4vaBalance = utxos.reduce((sum, utxo) => {
        const l4vaAmount = utxo.assets[l4vaUnit] || 0n;
        return sum + Number(l4vaAmount);
      }, 0);

      return {
        address: this.treasuryAddress,
        lovelace,
        l4vaBalance,
        utxoCount: utxos.length,
      };
    } catch (error: any) {
      this.logger.error(`Failed to get treasury balance: ${error?.message || error}`, error?.stack);
      throw error;
    }
  }
}
