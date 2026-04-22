import { Blockfrost, Lucid } from '@lucid-evolution/lucid';
import { Injectable, Logger, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ClaimTxResult {
  success: boolean;
  txHash?: string;
  claimedAmount?: number;
  error?: string;
}

/**
 * Service to build Cardano transactions for L4VA rewards claims using Lucid.
 * Sends L4VA tokens from the treasury wallet to claiming users.
 */
@Injectable()
export class RewardsClaimTxBuilderService {
  private readonly logger = new Logger(RewardsClaimTxBuilderService.name);
  private readonly l4vaPolicyId: string;
  private readonly l4vaAssetName: string;
  private readonly l4vaDecimals: number;
  private readonly treasuryKey: string;
  private readonly treasuryAddress: string;
  private readonly isMainnet: boolean;
  private readonly networkId: number;

  constructor(private readonly configService: ConfigService) {
    this.l4vaPolicyId = this.configService.get<string>('L4VA_POLICY_ID');
    this.l4vaAssetName = this.configService.get<string>('L4VA_ASSET_NAME');
    this.l4vaDecimals = this.configService.get<number>('L4VA_DECIMALS') || 1;
    this.treasuryKey = this.configService.get<string>('L4VA_TREASURY_KEY');
    this.treasuryAddress = this.configService.get<string>('L4VA_TREASURY_ADDRESS');
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
    this.networkId = Number(this.configService.get<string>('NETWORK_ID')) || 0;

    // Validate configuration
    if (!this.l4vaPolicyId || !this.l4vaAssetName) {
      this.logger.error('L4VA token configuration missing. Set L4VA_POLICY_ID and L4VA_ASSET_NAME');
    }

    if (!this.treasuryKey || !this.treasuryAddress) {
      this.logger.error('L4VA treasury configuration missing. Set L4VA_TREASURY_KEY and L4VA_TREASURY_ADDRESS');
    }
  }

  /**
   * Build and submit a claim transaction that sends L4VA tokens from treasury to user.
   * Transaction is signed server-side with treasury key and submitted immediately.
   *
   * @param walletAddress - User's wallet address (bech32)
   * @param claimAmount - Amount of L4VA tokens to claim (in base units)
   * @returns Transaction hash and claim details
   */
  async buildClaimTransaction(walletAddress: string, claimAmount: number): Promise<ClaimTxResult> {
    try {
      if (!this.treasuryKey || !this.treasuryAddress) {
        throw new BadRequestException('L4VA treasury not configured');
      }

      if (!walletAddress || claimAmount <= 0) {
        throw new BadRequestException('Invalid wallet address or claim amount');
      }

      this.logger.log(
        `Building claim transaction: ${claimAmount / 10 ** this.l4vaDecimals} L4VA to ${walletAddress.slice(0, 20)}...`
      );

      // Initialize Lucid
      const network = this.networkId === 1 ? 'Mainnet' : 'Preprod';
      const lucid = await Lucid(
        new Blockfrost(
          `https://cardano-${network.toLowerCase()}.blockfrost.io/api/v0`,
          this.configService.get<string>('BLOCKFROST_API_KEY')
        ),
        network
      );

      // Get treasury UTXOs and select wallet
      const treasuryUtxos = await lucid.utxosAt(this.treasuryAddress);
      lucid.selectWallet.fromAddress(this.treasuryAddress, treasuryUtxos);

      if (!treasuryUtxos || treasuryUtxos.length === 0) {
        throw new InternalServerErrorException('No UTXOs available in treasury wallet');
      }

      this.logger.debug(`Found ${treasuryUtxos.length} UTXOs in treasury`);

      // Build the L4VA asset unit
      const l4vaUnit = this.l4vaPolicyId + this.l4vaAssetName;

      // Calculate total L4VA in treasury
      const totalL4vaInTreasury = treasuryUtxos.reduce((sum, utxo) => {
        const l4vaAmount = utxo.assets[l4vaUnit] || 0n;
        return sum + Number(l4vaAmount);
      }, 0);

      this.logger.debug(`Total L4VA in treasury: ${totalL4vaInTreasury / 10 ** this.l4vaDecimals}`);

      if (totalL4vaInTreasury < claimAmount) {
        throw new BadRequestException(
          `Insufficient L4VA in treasury. Required: ${claimAmount / 10 ** this.l4vaDecimals}, Available: ${totalL4vaInTreasury / 10 ** this.l4vaDecimals}`
        );
      }

      // Build transaction
      const tx = await lucid
        .newTx()
        .pay.ToAddress(walletAddress, {
          [l4vaUnit]: BigInt(claimAmount),
        })
        .complete({ changeAddress: this.treasuryAddress });

      // Sign with treasury private key
      const signedTx = await tx.sign.withPrivateKey(this.treasuryKey).complete();

      // Submit to blockchain
      const txHash = await signedTx.submit();

      this.logger.log(
        `✅ Claim transaction submitted: ${txHash} - ${claimAmount / 10 ** this.l4vaDecimals} L4VA to ${walletAddress.slice(0, 20)}...`
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
