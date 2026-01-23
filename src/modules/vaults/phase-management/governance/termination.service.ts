import { Buffer } from 'buffer';

import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Address, FixedTransaction, PrivateKey } from '@emurgo/cardano-serialization-lib-nodejs';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { TransactionsService } from '../../processing-tx/offchain-tx/transactions.service';
import { BlockchainService } from '../../processing-tx/onchain/blockchain.service';
import { SubmitTransactionDto } from '../../processing-tx/onchain/dto/transaction.dto';
import { getUtxosExtract } from '../../processing-tx/onchain/utils/lib';
import { VaultManagingService } from '../../processing-tx/onchain/vault-managing.service';
import { TreasuryWalletService } from '../../treasure/treasure-wallet.service';
import { TreasuryExtractionService } from '../../treasure/treasury-extraction.service';

import { Asset } from '@/database/asset.entity';
import { Claim } from '@/database/claim.entity';
import { Proposal } from '@/database/proposal.entity';
import { Snapshot } from '@/database/snapshot.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { VyfiService } from '@/modules/vyfi/vyfi.service';
import { AssetOriginType, AssetStatus, AssetType } from '@/types/asset.types';
import type { TerminationClaimMetadata } from '@/types/claim-metadata.types';
import { ClaimStatus, ClaimType } from '@/types/claim.types';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';
import { VaultStatus } from '@/types/vault.types';

/**
 * Termination flow status tracking
 */
export enum TerminationStatus {
  INITIATED = 'initiated', // Termination proposal passed
  NFT_BURNING = 'nft_burning', // Burning NFTs in progress
  NFT_BURNED = 'nft_burned', // All NFTs sent to burn wallet
  LP_REMOVAL_PENDING = 'lp_removal_pending', // LP tokens sent to VyFi
  LP_REMOVAL_AWAITING = 'lp_removal_awaiting', // Waiting for VyFi to return VT + ADA
  LP_RETURN_RECEIVED = 'lp_return_received', // VT + ADA received at admin wallet
  VT_BURNED = 'vt_burned', // Returned VT burned
  ADA_IN_TREASURY = 'ada_in_treasury', // ADA transferred to treasury
  CLAIMS_CREATED = 'claims_created', // Termination claims created for VT holders
  CLAIMS_PROCESSING = 'claims_processing', // Users are claiming VT -> ADA
  CLAIMS_COMPLETE = 'claims_complete', // All claims processed
  VAULT_BURNED = 'vault_burned', // Vault NFT burned, termination complete
  TREASURY_CLEANED = 'treasury_cleaned', // Treasury wallet swept and KMS keys deleted
}

export interface TerminationMetadata {
  status: TerminationStatus;
  proposalId: string;
  nftBurnTxHash?: string;
  ftExtractionTxHash?: string; // FTs extracted to treasury for distribution
  lpRemovalTxHash?: string;
  lpReturnTxHash?: string;
  vtBurnTxHash?: string;
  adaTransferTxHash?: string;
  vaultBurnTxHash?: string;
  treasurySweepTxHash?: string;
  sweptLovelace?: string;
  totalAdaForDistribution?: string; // In lovelace
  ftsForDistribution?: Array<{ policyId: string; assetId: string; quantity: string; name?: string }>; // FTs to distribute to VT holders
  expectedVtReturn?: string;
  expectedAdaReturn?: string;
  claimsCreatedAt?: string;
  lastCheckedAt?: string;
  error?: string;
}

@Injectable()
export class TerminationService {
  private readonly logger = new Logger(TerminationService.name);
  private readonly isMainnet: boolean;
  private readonly blockfrost: BlockFrostAPI;
  private readonly adminAddress: string;
  private readonly adminSKey: string;
  private readonly adminHash: string;
  private readonly poolAddress: string;
  private readonly networkId: number;

  private readonly BURN_WALLET_TESTNET =
    'addr_test1qzdv6pn0ltar7q3hhgrgts2yqvphxtptr4m3t4xf5lfyx7hc3v9amrnu0cp6zt3vkry03838n2mv9e69g8e70aqktgcsnvkule';
  private readonly BURN_WALLET_MAINNET =
    'addr1qxnk9w6e3azattu87ythnnjt2vmtlskzcld0ptwa924j0znz7v4zyqfqapmueh24l2r8v848mya68nndvjy783m656kq0cxjsn';

  // Minimum ADA for distribution (2 ADA per user minimum to cover tx costs)
  private readonly MIN_ADA_PER_CLAIM = 2_000_000;
  // Minimum total ADA to justify treasury distribution (10 ADA)
  private readonly MIN_TOTAL_ADA_FOR_DISTRIBUTION = 10_000_000;

  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(Proposal)
    private readonly proposalRepository: Repository<Proposal>,
    @InjectRepository(Claim)
    private readonly claimRepository: Repository<Claim>,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
    @InjectRepository(Snapshot)
    private readonly snapshotRepository: Repository<Snapshot>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly configService: ConfigService,
    private readonly blockchainService: BlockchainService,
    private readonly eventEmitter: EventEmitter2,
    private readonly vyfiService: VyfiService,
    private readonly treasuryWalletService: TreasuryWalletService,
    private readonly vaultManagingService: VaultManagingService,
    private readonly treasuryExtractionService: TreasuryExtractionService,
    private readonly transactionsService: TransactionsService
  ) {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
    this.adminAddress = this.configService.get<string>('ADMIN_ADDRESS');
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');
    this.adminHash = this.configService.get<string>('ADMIN_KEY_HASH');
    this.poolAddress = this.configService.get<string>('POOL_ADDRESS');
    this.networkId = Number(this.configService.get<string>('NETWORK_ID')) || 0;

    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_API_KEY'),
    });
  }

  /**
   * Get burn wallet address based on network
   */
  private get burnWallet(): string {
    return this.isMainnet ? this.BURN_WALLET_MAINNET : this.BURN_WALLET_TESTNET;
  }

  /**
   * Monitor termination progress every 10 minutes
   * Checks for pending LP returns and advances termination state
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async monitorTerminations(): Promise<void> {
    try {
      // Find vaults in terminating status
      const terminatingVaults = await this.vaultRepository.find({
        where: { vault_status: VaultStatus.terminating }, // Will add to enum
        relations: ['treasury_wallet'],
      });

      if (terminatingVaults.length === 0) {
        return;
      }

      this.logger.log(`Monitoring ${terminatingVaults.length} terminating vault(s)`);

      for (const vault of terminatingVaults) {
        try {
          await this.processTerminationStep(vault);
        } catch (error) {
          this.logger.error(`Error processing termination for vault ${vault.id}: ${error.message}`, error.stack);
        }
      }
    } catch (error) {
      this.logger.error(`Error in termination monitor: ${error.message}`, error.stack);
    }
  }

  /**
   * Initialize termination for a vault (called when TERMINATION proposal passes)
   */
  async initiateTermination(vaultId: string, proposalId: string): Promise<void> {
    this.logger.log(`Initiating termination for vault ${vaultId} from proposal ${proposalId}`);

    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      relations: ['treasury_wallet'],
    });

    if (!vault) {
      throw new NotFoundException(`Vault ${vaultId} not found`);
    }

    // Initialize termination metadata
    const terminationMetadata: TerminationMetadata = {
      status: TerminationStatus.INITIATED,
      proposalId,
    };

    // Update vault status to terminating
    await this.vaultRepository.update(
      { id: vaultId },
      {
        vault_status: VaultStatus.terminating,
        termination_metadata: terminationMetadata,
      }
    );

    // Refresh vault object with updated termination_metadata
    vault.vault_status = VaultStatus.terminating;
    vault.termination_metadata = terminationMetadata;

    this.eventEmitter.emit('vault.termination_started', {
      vaultId,
      proposalId,
    });

    // Start the termination process
    await this.processTerminationStep(vault);
  }

  /**
   * Process the next step in the termination flow based on current status
   */
  private async processTerminationStep(vault: Vault): Promise<void> {
    const termination = vault.termination_metadata as TerminationMetadata | undefined;

    if (!termination) {
      this.logger.warn(`Vault ${vault.id} has no termination metadata`);
      return;
    }

    this.logger.debug(`Processing termination step for vault ${vault.id}, status: ${termination.status}`);

    switch (termination.status) {
      case TerminationStatus.INITIATED:
        await this.stepBurnNFTs(vault);
        break;

      case TerminationStatus.NFT_BURNED:
        await this.stepRemoveLiquidity(vault);
        break;

      case TerminationStatus.LP_REMOVAL_AWAITING:
        await this.stepCheckLPReturn(vault);
        break;

      case TerminationStatus.LP_RETURN_RECEIVED:
        await this.stepBurnReturnedVT(vault);
        break;

      case TerminationStatus.VT_BURNED:
        await this.stepTransferAdaToTreasury(vault);
        break;

      case TerminationStatus.ADA_IN_TREASURY:
        await this.stepCreateClaims(vault);
        break;

      case TerminationStatus.CLAIMS_CREATED:
      case TerminationStatus.CLAIMS_PROCESSING:
        await this.stepCheckClaimsComplete(vault);
        break;

      case TerminationStatus.CLAIMS_COMPLETE:
        await this.stepBurnVault(vault);
        break;

      case TerminationStatus.VAULT_BURNED:
        this.logger.log(`Vault ${vault.id} termination complete`);
        break;

      default:
        this.logger.warn(`Unknown termination status: ${termination.status}`);
    }
  }

  /**
   * Step 1: Process locked assets in the vault (except fee assets)
   * - NFTs: Extract to burn wallet (destroyed)
   * - FTs: Extract to treasury wallet for distribution to VT holders
   */
  private async stepBurnNFTs(vault: Vault): Promise<void> {
    this.logger.log(`[Step 1] Processing locked assets for vault ${vault.id}`);

    // Get all locked assets except fee assets
    const assetsToProcess = await this.assetRepository.find({
      where: {
        vault: { id: vault.id },
        status: AssetStatus.LOCKED,
      },
    });

    // Filter out fee assets
    const nonFeeAssets = assetsToProcess.filter(asset => asset.origin_type !== AssetOriginType.FEE);

    // Separate NFTs (to burn) from FTs (to distribute)
    const nftsToburn = nonFeeAssets.filter(asset => asset.type === AssetType.NFT);
    const ftsToDistribute = nonFeeAssets.filter(asset => asset.type === AssetType.FT);

    if (nonFeeAssets.length === 0) {
      this.logger.log(`No assets to process for vault ${vault.id}, skipping to LP removal`);
      await this.updateTerminationStatus(vault.id, TerminationStatus.NFT_BURNED);
      return;
    }

    this.logger.log(
      `Found ${nftsToburn.length} NFTs to burn and ${ftsToDistribute.length} FTs to distribute ` +
        `(excluding ${assetsToProcess.length - nonFeeAssets.length} fee assets)`
    );

    // Get treasury wallet for FT extraction
    const treasuryWallet = await this.treasuryWalletService.getTreasuryWallet(vault.id);
    const ftDestination = treasuryWallet?.address || this.adminAddress;

    let nftBurnTxHash: string | undefined;
    let ftExtractionTxHash: string | undefined;

    try {
      // Step 1a: Extract NFTs to burn wallet
      if (nftsToburn.length > 0) {
        this.logger.log(`Extracting ${nftsToburn.length} NFTs to burn wallet`);
        const burnResult = await this.treasuryExtractionService.extractAssetsFromVault({
          vaultId: vault.id,
          assetIds: nftsToburn.map(a => a.id),
          treasuryAddress: this.burnWallet,
        });
        nftBurnTxHash = burnResult.txHash;
        this.logger.log(`NFTs extracted to burn wallet: ${nftBurnTxHash}`);

        // Update NFTs status to BURNED
        await this.assetRepository.update({ id: In(nftsToburn.map(a => a.id)) }, { status: AssetStatus.BURNED });
      }

      // Step 1b: Extract FTs to treasury for distribution
      if (ftsToDistribute.length > 0) {
        this.logger.log(
          `Extracting ${ftsToDistribute.length} FTs to treasury (${ftDestination}) for VT holder distribution`
        );
        const ftResult = await this.treasuryExtractionService.extractAssetsFromVault({
          vaultId: vault.id,
          assetIds: ftsToDistribute.map(a => a.id),
          treasuryAddress: ftDestination,
        });
        ftExtractionTxHash = ftResult.txHash;
        this.logger.log(`FTs extracted to treasury: ${ftExtractionTxHash}`);

        // Update FTs status to EXTRACTED (will be distributed later)
        await this.assetRepository.update(
          { id: In(ftsToDistribute.map(a => a.id)) },
          { status: AssetStatus.EXTRACTED }
        );
      }

      // Store FT distribution info in metadata
      const ftsForDistribution = ftsToDistribute.map(ft => ({
        policyId: ft.policy_id,
        assetId: ft.asset_id,
        quantity: ft.quantity?.toString() || '1',
        name: ft.name,
      }));

      await this.updateTerminationStatus(vault.id, TerminationStatus.NFT_BURNED, {
        nftBurnTxHash,
        ftExtractionTxHash,
        ftsForDistribution: ftsForDistribution.length > 0 ? ftsForDistribution : undefined,
      });

      this.eventEmitter.emit('vault.assets_processed', {
        vaultId: vault.id,
        nftBurnTxHash,
        ftExtractionTxHash,
        nftsBurned: nftsToburn.length,
        ftsExtracted: ftsToDistribute.length,
      });
    } catch (error) {
      // If extraction fails (e.g., non-mainnet, no assets in UTXOs), log and continue
      if (error.message?.includes('non-mainnet') || error.message?.includes('only available on mainnet')) {
        this.logger.warn(`[TESTNET] Skipping on-chain asset extraction for vault ${vault.id}`);

        // Mark assets appropriately in database only
        if (nftsToburn.length > 0) {
          await this.assetRepository.update({ id: In(nftsToburn.map(a => a.id)) }, { status: AssetStatus.BURNED });
        }
        if (ftsToDistribute.length > 0) {
          await this.assetRepository.update(
            { id: In(ftsToDistribute.map(a => a.id)) },
            { status: AssetStatus.EXTRACTED }
          );
        }

        // Store FT distribution info even on testnet
        const ftsForDistribution = ftsToDistribute.map(ft => ({
          policyId: ft.policy_id,
          assetId: ft.asset_id,
          quantity: ft.quantity?.toString() || '1',
          name: ft.name,
        }));

        await this.updateTerminationStatus(vault.id, TerminationStatus.NFT_BURNED, {
          ftsForDistribution: ftsForDistribution.length > 0 ? ftsForDistribution : undefined,
        });
        return;
      }

      this.logger.error(`Failed to process assets for vault ${vault.id}: ${error.message}`, error.stack);
      await this.updateTerminationMetadata(vault.id, {
        error: `Asset processing failed: ${error.message}`,
      });
      throw error;
    }
  }

  /**
   * Step 2: Remove liquidity from VyFi pool
   * Sends LP tokens to VyFi order address with remove liquidity datum
   */
  private async stepRemoveLiquidity(vault: Vault): Promise<void> {
    this.logger.log(`[Step 2] Removing liquidity for vault ${vault.id}`);

    // Check if vault has LP tokens
    const lpClaim = await this.claimRepository.findOne({
      where: {
        vault: { id: vault.id },
        type: ClaimType.LP,
        status: ClaimStatus.CLAIMED,
      },
    });

    if (!lpClaim) {
      this.logger.log(`No LP tokens found for vault ${vault.id}, skipping to claims creation`);
      await this.updateTerminationStatus(vault.id, TerminationStatus.ADA_IN_TREASURY);
      return;
    }

    try {
      // Use VyfiService to remove liquidity
      const result = await this.vyfiService.removeLiquidityForVault(vault.id);

      this.logger.log(`LP removal transaction submitted: ${result.txHash}`);

      // Update status to awaiting return
      await this.updateTerminationStatus(vault.id, TerminationStatus.LP_REMOVAL_AWAITING, {
        lpRemovalTxHash: result.txHash,
        expectedVtReturn: result.poolInfo?.reserveA?.toString(),
        expectedAdaReturn: result.poolInfo?.reserveB?.toString(),
      });
    } catch (error) {
      this.logger.error(`Failed to remove liquidity for vault ${vault.id}: ${error.message}`, error.stack);

      // If pool not found, skip to claims creation (vault might not have LP)
      if (error.message.includes('Pool not found') || error.message.includes('No LP tokens')) {
        this.logger.log(`Skipping LP removal for vault ${vault.id}, proceeding to claims creation`);
        await this.updateTerminationStatus(vault.id, TerminationStatus.ADA_IN_TREASURY);
        return;
      }

      // Store error and re-throw
      await this.updateTerminationMetadata(vault.id, {
        error: `LP removal failed: ${error.message}`,
      });
      throw error;
    }
  }

  /**
   * Step 3: Check if VyFi has returned VT + ADA to admin wallet
   */
  private async stepCheckLPReturn(vault: Vault): Promise<void> {
    this.logger.debug(`[Step 3] Checking LP return for vault ${vault.id}`);

    // Update last checked timestamp
    await this.updateTerminationMetadata(vault.id, {
      lastCheckedAt: new Date().toISOString(),
    });

    // Check admin wallet for incoming VT tokens
    const vtUnit = `${vault.script_hash}${vault.asset_vault_name}`;
    const adminUtxos = await this.blockfrost.addressesUtxos(this.adminAddress);

    // Look for UTXOs containing the vault's VT
    const vtUtxo = adminUtxos.find(utxo => utxo.amount.some(a => a.unit === vtUnit && BigInt(a.quantity) > 0));

    if (vtUtxo) {
      const vtAmount = vtUtxo.amount.find(a => a.unit === vtUnit)?.quantity || '0';
      const adaAmount = vtUtxo.amount.find(a => a.unit === 'lovelace')?.quantity || '0';

      this.logger.log(`LP return received for vault ${vault.id}: ${vtAmount} VT, ${adaAmount} lovelace`);

      await this.updateTerminationStatus(vault.id, TerminationStatus.LP_RETURN_RECEIVED, {
        lpReturnTxHash: vtUtxo.tx_hash,
        expectedVtReturn: vtAmount,
        expectedAdaReturn: adaAmount,
      });
    } else {
      this.logger.debug(`LP return not yet received for vault ${vault.id}`);
    }
  }

  /**
   * Step 4: Burn the returned VT tokens (send to burn wallet)
   */
  private async stepBurnReturnedVT(vault: Vault): Promise<void> {
    this.logger.log(`[Step 4] Burning returned VT for vault ${vault.id}`);

    const termination = vault.termination_metadata as TerminationMetadata;
    const vtUnit = `${vault.script_hash}${vault.asset_vault_name}`;

    // Get admin UTXOs containing VT
    const { utxos: adminUtxos, requiredInputs } = await getUtxosExtract(
      Address.from_bech32(this.adminAddress),
      this.blockfrost,
      {
        targetAssets: [{ token: vtUnit, amount: Number(termination.expectedVtReturn || '0') }],
      }
    );

    if (adminUtxos.length === 0) {
      this.logger.warn(`No VT tokens found in admin wallet for vault ${vault.id}`);
      return;
    }

    // Build transaction to send VT to burn wallet
    const input = {
      changeAddress: this.adminAddress,
      utxos: adminUtxos,
      outputs: [
        {
          address: this.burnWallet,
          assets: [
            {
              assetName: { name: vault.asset_vault_name, format: 'hex' as const },
              policyId: vault.script_hash,
              quantity: BigInt(termination.expectedVtReturn || '0'),
            },
          ],
          lovelace: 2000000, // Min ADA for UTXO
        },
      ],
      requiredSigners: [this.adminHash],
      requiredInputs,
      validityInterval: {
        start: true,
        end: true,
      },
      network: this.isMainnet ? 'mainnet' : 'preprod',
    };

    const buildResponse = await this.blockchainService.buildTransaction(input);
    const txToSubmit = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
    txToSubmit.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

    const submitResponse = await this.blockchainService.submitTransaction({
      transaction: txToSubmit.to_hex(),
      signatures: [],
    });

    this.logger.log(`VT burn transaction submitted: ${submitResponse.txHash}`);

    await this.updateTerminationStatus(vault.id, TerminationStatus.VT_BURNED, {
      vtBurnTxHash: submitResponse.txHash,
    });
  }

  /**
   * Step 5: Transfer ADA from admin wallet to treasury
   */
  private async stepTransferAdaToTreasury(vault: Vault): Promise<void> {
    this.logger.log(`[Step 5] Transferring ADA to treasury for vault ${vault.id}`);

    const termination = vault.termination_metadata as TerminationMetadata;
    const treasuryAddress = vault.treasury_wallet?.treasury_address;

    if (!treasuryAddress) {
      this.logger.error(`No treasury wallet found for vault ${vault.id}`);
      return;
    }

    const adaToTransfer = BigInt(termination.expectedAdaReturn || '0') - BigInt(2000000); // Subtract min UTXO sent with VT

    if (adaToTransfer <= 0) {
      this.logger.warn(`No ADA to transfer for vault ${vault.id}`);
      await this.updateTerminationStatus(vault.id, TerminationStatus.ADA_IN_TREASURY, {
        totalAdaForDistribution: '0',
      });
      return;
    }

    // Get admin UTXOs
    const { utxos: adminUtxos, requiredInputs } = await getUtxosExtract(
      Address.from_bech32(this.adminAddress),
      this.blockfrost,
      {}
    );

    // Build transaction to send ADA to treasury
    const input = {
      changeAddress: this.adminAddress,
      utxos: adminUtxos,
      outputs: [
        {
          address: treasuryAddress,
          lovelace: Number(adaToTransfer),
        },
      ],
      requiredSigners: [this.adminHash],
      requiredInputs,
      validityInterval: {
        start: true,
        end: true,
      },
      network: this.isMainnet ? 'mainnet' : 'preprod',
    };

    const buildResponse = await this.blockchainService.buildTransaction(input);
    const txToSubmit = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
    txToSubmit.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

    const submitResponse = await this.blockchainService.submitTransaction({
      transaction: txToSubmit.to_hex(),
      signatures: [],
    });

    this.logger.log(`ADA transfer to treasury submitted: ${submitResponse.txHash}`);

    await this.updateTerminationStatus(vault.id, TerminationStatus.ADA_IN_TREASURY, {
      adaTransferTxHash: submitResponse.txHash,
      totalAdaForDistribution: adaToTransfer.toString(),
    });
  }

  /**
   * Step 6: Create termination claims for all VT holders
   * Claims include:
   * - ADA distribution (if above threshold)
   * - FT distribution (proportional to VT holdings)
   * If ADA amount is too small (below threshold), create VT-only claims
   * where users just burn their VT without receiving ADA distribution (but still get FTs if any)
   */
  private async stepCreateClaims(vault: Vault): Promise<void> {
    this.logger.log(`[Step 6] Creating termination claims for vault ${vault.id}`);

    const termination = vault.termination_metadata as TerminationMetadata;

    // Get the latest snapshot for VT holder balances
    const snapshot = await this.snapshotRepository.findOne({
      where: { vaultId: vault.id },
      order: { createdAt: 'DESC' },
    });

    if (!snapshot || !snapshot.addressBalances) {
      this.logger.error(`No snapshot found for vault ${vault.id}`);
      return;
    }

    const totalAda = BigInt(termination.totalAdaForDistribution || '0');
    const ftsForDistribution = termination.ftsForDistribution || [];
    const addressBalances = snapshot.addressBalances;

    // Calculate total VT supply from snapshot
    const totalVtSupply = Object.values(addressBalances).reduce((sum, balance) => sum + BigInt(balance), BigInt(0));

    if (totalVtSupply === BigInt(0)) {
      this.logger.warn(`No VT holders found in snapshot for vault ${vault.id}`);
      await this.updateTerminationStatus(vault.id, TerminationStatus.CLAIMS_COMPLETE);
      return;
    }

    // Count number of addresses with VT
    const vtHolderCount = Object.values(addressBalances).filter(b => BigInt(b) > BigInt(0)).length;

    // Check if we have enough ADA to distribute meaningfully
    // We need at least MIN_ADA_PER_CLAIM per user and MIN_TOTAL_ADA_FOR_DISTRIBUTION total
    const hasEnoughAdaForDistribution =
      totalAda >= BigInt(this.MIN_TOTAL_ADA_FOR_DISTRIBUTION) &&
      totalAda / BigInt(vtHolderCount) >= BigInt(this.MIN_ADA_PER_CLAIM);

    const hasFtsToDistribute = ftsForDistribution.length > 0;

    if (!hasEnoughAdaForDistribution) {
      this.logger.warn(
        `Not enough ADA for distribution. Total: ${totalAda} lovelace, Holders: ${vtHolderCount}. ` +
          `Creating VT-burn-only claims (no ADA payout).`
      );
    }

    if (hasFtsToDistribute) {
      this.logger.log(`Including ${ftsForDistribution.length} FT types for distribution to VT holders`);
    }

    // Create claims for each VT holder
    const claims: Partial<Claim>[] = [];

    for (const [address, balance] of Object.entries(addressBalances)) {
      const vtBalance = BigInt(balance);
      if (vtBalance === BigInt(0)) continue;

      // Calculate proportional ADA share (0 if not enough ADA)
      const adaShare = hasEnoughAdaForDistribution ? (totalAda * vtBalance) / totalVtSupply : BigInt(0);

      // Calculate proportional FT shares
      const ftShares = ftsForDistribution
        .map(ft => {
          const totalFtQuantity = BigInt(ft.quantity);
          const userFtShare = (totalFtQuantity * vtBalance) / totalVtSupply;
          return {
            policyId: ft.policyId,
            assetId: ft.assetId,
            quantity: userFtShare.toString(),
            name: ft.name,
          };
        })
        .filter(ft => BigInt(ft.quantity) > BigInt(0)); // Only include non-zero shares

      // Find user by address
      const user = await this.userRepository.findOne({
        where: { address },
      });

      // Build claim description
      let claimDescription = `Vault termination claim - Send ${vtBalance} VT to receive:`;
      if (hasEnoughAdaForDistribution) {
        claimDescription += ` ${adaShare} lovelace`;
      }
      if (ftShares.length > 0) {
        const ftDescriptions = ftShares.map(ft => `${ft.quantity} ${ft.name || ft.assetId}`).join(', ');
        claimDescription += hasEnoughAdaForDistribution ? ` + ${ftDescriptions}` : ` ${ftDescriptions}`;
      }
      if (!hasEnoughAdaForDistribution && ftShares.length === 0) {
        claimDescription = `Vault termination claim - Send ${vtBalance} VT to burn wallet (no distribution)`;
      }

      claims.push({
        user_id: user?.id,
        vault: vault,
        type: ClaimType.TERMINATION,
        status: ClaimStatus.AVAILABLE,
        amount: Number(vtBalance), // VT amount user needs to send
        lovelace_amount: Number(adaShare), // ADA amount user will receive (0 if no distribution)
        description: claimDescription,
        metadata: {
          address,
          vtAmount: vtBalance.toString(),
          adaAmount: adaShare.toString(),
          ftShares: ftShares.length > 0 ? ftShares : undefined,
          noAdaDistribution: !hasEnoughAdaForDistribution,
        },
      });
    }

    // Bulk insert claims
    await this.claimRepository.save(claims);

    this.logger.log(
      `Created ${claims.length} termination claims for vault ${vault.id} ` +
        `(ADA distribution: ${hasEnoughAdaForDistribution}, FT distribution: ${hasFtsToDistribute})`
    );

    await this.updateTerminationStatus(vault.id, TerminationStatus.CLAIMS_CREATED, {
      claimsCreatedAt: new Date().toISOString(),
    });

    this.eventEmitter.emit('vault.termination_claims_created', {
      vaultId: vault.id,
      claimCount: claims.length,
      totalAda: totalAda.toString(),
      hasAdaDistribution: hasEnoughAdaForDistribution,
      hasFtDistribution: hasFtsToDistribute,
      ftTypes: ftsForDistribution.length,
    });
  }

  /**
   * Step 7: Check if all claims have been processed
   */
  private async stepCheckClaimsComplete(vault: Vault): Promise<void> {
    this.logger.debug(`[Step 7] Checking claims completion for vault ${vault.id}`);

    const pendingClaims = await this.claimRepository.count({
      where: {
        vault: { id: vault.id },
        type: ClaimType.TERMINATION,
        status: In([ClaimStatus.AVAILABLE, ClaimStatus.PENDING]),
      },
    });

    if (pendingClaims === 0) {
      this.logger.log(`All termination claims processed for vault ${vault.id}`);
      await this.updateTerminationStatus(vault.id, TerminationStatus.CLAIMS_COMPLETE);
    } else {
      this.logger.debug(`${pendingClaims} claims still pending for vault ${vault.id}`);
      // Ensure status is CLAIMS_PROCESSING
      const termination = vault.termination_metadata as TerminationMetadata;
      if (termination.status === TerminationStatus.CLAIMS_CREATED) {
        await this.updateTerminationStatus(vault.id, TerminationStatus.CLAIMS_PROCESSING);
      }
    }
  }

  /**
   * Step 8: Burn the vault NFT (final step)
   * Uses VaultManagingService to create and submit the burn transaction with VaultBurn redeemer
   */
  private async stepBurnVault(vault: Vault): Promise<void> {
    this.logger.log(`[Step 8] Burning vault NFT for vault ${vault.id}`);

    try {
      // Use VaultManagingService to create the burn transaction
      const { presignedTx, txId } = await this.vaultManagingService.createBurnTx({
        vaultId: vault.id,
        vaultOwnerAddress: this.adminAddress, // Change goes to admin
        assetVaultName: vault.asset_vault_name,
        publicationHash: vault.last_update_tx_hash,
      });

      // Submit the pre-signed transaction
      const submitResponse = await this.blockchainService.submitTransaction({
        transaction: presignedTx,
        signatures: [],
      });

      this.logger.log(`Vault burn transaction submitted: ${submitResponse.txHash} (tx record: ${txId})`);

      // Update vault status to burned
      await this.vaultRepository.update({ id: vault.id }, { vault_status: VaultStatus.burned });

      await this.updateTerminationStatus(vault.id, TerminationStatus.VAULT_BURNED, {
        vaultBurnTxHash: submitResponse.txHash,
      });

      this.eventEmitter.emit('vault.burned', {
        vaultId: vault.id,
        txHash: submitResponse.txHash,
      });

      this.logger.log(`Vault ${vault.id} termination complete - vault burned`);
    } catch (error) {
      // Handle case where vault UTXO is not found (already burned)
      if (error.message?.includes('not found') || error.status === 404) {
        this.logger.warn(`Vault UTXO not found for ${vault.asset_vault_name} - may already be burned`);
        await this.vaultRepository.update({ id: vault.id }, { vault_status: VaultStatus.burned });
        await this.updateTerminationStatus(vault.id, TerminationStatus.VAULT_BURNED);
        return;
      }

      this.logger.error(`Failed to burn vault ${vault.id}: ${error.message}`, error.stack);
      await this.updateTerminationMetadata(vault.id, {
        error: `Vault burn failed: ${error.message}`,
      });
      throw error;
    }
  }

  /**
   * Step 9: Cleanup treasury wallet - sweep remaining ADA and delete KMS keys
   */
  private async stepCleanupTreasuryWallet(vault: Vault): Promise<void> {
    this.logger.log(`[Step 9] Cleaning up treasury wallet for vault ${vault.id}`);

    try {
      // Get treasury wallet
      const treasuryWallet = await this.treasuryWalletService.getTreasuryWallet(vault.id);

      if (!treasuryWallet) {
        this.logger.warn(`No treasury wallet found for vault ${vault.id} - skipping cleanup`);
        await this.updateTerminationStatus(vault.id, TerminationStatus.TREASURY_CLEANED);
        return;
      }

      const balance = await this.treasuryWalletService.getTreasuryWalletBalance(vault.id);

      if (balance && balance.lovelace > 0) {
        this.logger.log(`Treasury wallet has ${balance.lovelace} lovelace remaining - sweeping to admin wallet`);

        // Sweep remaining ADA to admin wallet
        const sweepTxHash = await this.treasuryWalletService.sweepTreasuryWallet(vault.id, this.adminAddress);

        this.logger.log(`Treasury wallet swept: ${sweepTxHash}`);

        await this.updateTerminationMetadata(vault.id, {
          treasurySweepTxHash: sweepTxHash,
          sweptLovelace: balance.lovelace.toString(),
        });
      } else {
        this.logger.log(`Treasury wallet is empty - proceeding to key deletion`);
      }

      // Delete KMS encryption keys
      await this.treasuryWalletService.deleteTreasuryWalletKeys(vault.id);
      this.logger.log(`KMS keys deleted for treasury wallet ${treasuryWallet.id}`);

      // Mark treasury wallet as deleted in database
      await this.treasuryWalletService.markTreasuryWalletAsDeleted(vault.id);

      await this.updateTerminationStatus(vault.id, TerminationStatus.TREASURY_CLEANED);

      this.eventEmitter.emit('vault.treasury.cleaned', {
        vaultId: vault.id,
        treasuryAddress: treasuryWallet.address,
      });

      this.logger.log(`Treasury wallet cleanup complete for vault ${vault.id}`);
    } catch (error) {
      this.logger.error(`Failed to cleanup treasury wallet for vault ${vault.id}: ${error.message}`, error.stack);
      await this.updateTerminationMetadata(vault.id, {
        error: `Treasury cleanup failed: ${error.message}`,
      });
      // Don't throw - this is cleanup, not critical to termination
    }
  }

  /**
   * Update termination status in vault metadata
   */
  private async updateTerminationStatus(
    vaultId: string,
    status: TerminationStatus,
    additionalData?: Partial<TerminationMetadata>
  ): Promise<void> {
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
    });

    if (!vault) return;

    const currentTermination = (vault.termination_metadata || {}) as TerminationMetadata;
    const updatedTermination: TerminationMetadata = {
      ...currentTermination,
      ...additionalData,
      status,
    };

    await this.vaultRepository.update(
      { id: vaultId },
      {
        termination_metadata: updatedTermination,
      }
    );
  }

  /**
   * Update termination metadata without changing status
   */
  private async updateTerminationMetadata(vaultId: string, data: Partial<TerminationMetadata>): Promise<void> {
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
    });

    if (!vault) return;

    const currentTermination = (vault.termination_metadata || {}) as TerminationMetadata;
    const updatedTermination: TerminationMetadata = {
      ...currentTermination,
      ...data,
    };

    await this.vaultRepository.update(
      { id: vaultId },
      {
        termination_metadata: updatedTermination,
      }
    );
  }

  /**
   * Get user's current on-chain VT balance for a vault
   * Used to verify actual VT holdings before processing termination claims
   */
  private async getUserVtBalance(userAddress: string, vault: Vault): Promise<bigint> {
    const vtUnit = `${vault.script_hash}${vault.asset_vault_name}`;

    try {
      const utxos = await this.blockfrost.addressesUtxosAsset(userAddress, vtUnit);
      const totalVt = utxos.reduce((sum, utxo) => {
        const vtAmount = utxo.amount.find(a => a.unit === vtUnit);
        return sum + BigInt(vtAmount?.quantity || '0');
      }, BigInt(0));

      return totalVt;
    } catch (error) {
      // If address has no UTXOs with this asset, Blockfrost returns 404
      if (error.status_code === 404) {
        return BigInt(0);
      }
      throw error;
    }
  }

  /**
   * Get total circulating VT supply from all addresses
   * Excludes burned tokens (at burn wallet)
   */
  private async getCirculatingVtSupply(vault: Vault): Promise<bigint> {
    const vtUnit = `${vault.script_hash}${vault.asset_vault_name}`;

    try {
      // Get asset info which includes total minted
      const assetInfo = await this.blockfrost.assetsById(vtUnit);
      const totalMinted = BigInt(assetInfo.quantity);

      // Subtract any VT at burn wallet
      try {
        const burnUtxos = await this.blockfrost.addressesUtxosAsset(this.burnWallet, vtUnit);
        const burnedVt = burnUtxos.reduce((sum, utxo) => {
          const vtAmount = utxo.amount.find(a => a.unit === vtUnit);
          return sum + BigInt(vtAmount?.quantity || '0');
        }, BigInt(0));

        return totalMinted - burnedVt;
      } catch {
        // No VT at burn wallet
        return totalMinted;
      }
    } catch (error) {
      this.logger.error(`Failed to get VT supply for vault ${vault.id}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get current treasury balance available for distribution
   */
  private async getTreasuryBalance(vault: Vault): Promise<bigint> {
    const treasuryWallet = vault.treasury_wallet;
    if (!treasuryWallet) {
      return BigInt(0);
    }

    try {
      const utxos = await this.blockfrost.addressesUtxosAll(treasuryWallet.treasury_address);
      const totalAda = utxos.reduce((sum, utxo) => {
        const adaAmount = utxo.amount.find(a => a.unit === 'lovelace');
        return sum + BigInt(adaAmount?.quantity || '0');
      }, BigInt(0));

      // Reserve some ADA for transaction fees (1 ADA)
      const reserved = BigInt(1_000_000);
      return totalAda > reserved ? totalAda - reserved : BigInt(0);
    } catch (error) {
      this.logger.error(`Failed to get treasury balance for vault ${vault.id}: ${error.message}`);
      return BigInt(0);
    }
  }

  /**
   * Calculate user's dynamic ADA share based on current VT holdings and treasury balance
   * This ensures fair distribution even if VT ownership has changed since snapshot
   */
  private async calculateDynamicShare(
    userAddress: string,
    vault: Vault
  ): Promise<{
    userVtBalance: bigint;
    circulatingSupply: bigint;
    treasuryBalance: bigint;
    adaShare: bigint;
    sharePercentage: number;
  }> {
    const [userVtBalance, circulatingSupply, treasuryBalance] = await Promise.all([
      this.getUserVtBalance(userAddress, vault),
      this.getCirculatingVtSupply(vault),
      this.getTreasuryBalance(vault),
    ]);

    if (circulatingSupply === BigInt(0) || userVtBalance === BigInt(0)) {
      return {
        userVtBalance,
        circulatingSupply,
        treasuryBalance,
        adaShare: BigInt(0),
        sharePercentage: 0,
      };
    }

    // Calculate proportional share: (userVT / totalVT) * treasuryADA
    const adaShare = (treasuryBalance * userVtBalance) / circulatingSupply;
    const sharePercentage = Number((userVtBalance * BigInt(10000)) / circulatingSupply) / 100;

    return {
      userVtBalance,
      circulatingSupply,
      treasuryBalance,
      adaShare,
      sharePercentage,
    };
  }

  /**
   * Request a termination claim for any address holding VT
   * This handles the case where VT was transferred to an address not in the original snapshot.
   *
   * Flow:
   * 1. Verify vault is in termination claims phase
   * 2. Check if user already has a claim for this vault
   * 3. Verify on-chain VT balance
   * 4. Create new claim dynamically (includes FT distribution if any)
   *
   * @param vaultId - The vault being terminated
   * @param userAddress - The address requesting a claim (must hold VT)
   * @param userId - Optional user ID if the requester is a registered user
   */
  async requestTerminationClaim(
    vaultId: string,
    userAddress: string,
    userId?: string
  ): Promise<{
    claimId: string;
    vtBalance: string;
    adaShare: string;
    ftShares?: Array<{ policyId: string; assetId: string; quantity: string; name?: string }>;
    sharePercentage: number;
    isNewClaim: boolean;
  }> {
    // Step 1: Verify vault exists and is in claims phase
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      relations: ['treasury_wallet'],
    });

    if (!vault) {
      throw new NotFoundException(`Vault ${vaultId} not found`);
    }

    const termination = vault.termination_metadata as TerminationMetadata | undefined;
    if (!termination) {
      throw new Error('Vault is not in termination process');
    }

    // Only allow claim requests during claims processing phase
    const validStatuses = [TerminationStatus.CLAIMS_CREATED, TerminationStatus.CLAIMS_PROCESSING];

    if (!validStatuses.includes(termination.status)) {
      throw new Error(
        `Cannot request claims at this stage. Current status: ${termination.status}. ` +
          `Claims can only be requested during CLAIMS_CREATED or CLAIMS_PROCESSING phase.`
      );
    }

    // Step 2: Check if claim already exists for this address
    const existingClaim = await this.claimRepository.findOne({
      where: {
        vault: { id: vaultId },
        type: ClaimType.TERMINATION,
        metadata: { address: userAddress },
      },
    });

    if (existingClaim) {
      // Claim already exists - return existing claim info with updated calculation
      const dynamicShare = await this.calculateDynamicShare(userAddress, vault);

      return {
        claimId: existingClaim.id,
        vtBalance: dynamicShare.userVtBalance.toString(),
        adaShare: dynamicShare.adaShare.toString(),
        sharePercentage: dynamicShare.sharePercentage,
        isNewClaim: false,
      };
    }

    // Step 3: Verify user has VT balance on-chain
    const dynamicShare = await this.calculateDynamicShare(userAddress, vault);

    if (dynamicShare.userVtBalance === BigInt(0)) {
      throw new Error(
        `Address ${userAddress} has no VT balance for this vault. ` +
          `You must hold vault tokens to claim termination distribution.`
      );
    }

    // Step 4: Find or create user record
    let user: User | null = null;

    if (userId) {
      user = await this.userRepository.findOne({ where: { id: userId } });
    }

    if (!user) {
      // Try to find user by wallet address
      user = await this.userRepository.findOne({
        where: { address: userAddress },
      });
    }

    // Step 5: Determine if ADA distribution is possible
    const noAdaDistribution =
      dynamicShare.treasuryBalance < BigInt(this.MIN_TOTAL_ADA_FOR_DISTRIBUTION) ||
      dynamicShare.adaShare < BigInt(this.MIN_ADA_PER_CLAIM);

    // Step 6: Calculate FT shares for this user (from termination metadata)
    const terminationMeta = vault.termination_metadata as TerminationMetadata;
    const ftsForDistribution = terminationMeta.ftsForDistribution || [];

    // Calculate proportional FT shares using circulating supply
    const ftShares = ftsForDistribution
      .map(ft => {
        const totalFtQuantity = BigInt(ft.quantity);
        const userFtShare = (totalFtQuantity * dynamicShare.userVtBalance) / dynamicShare.circulatingSupply;
        return {
          policyId: ft.policyId,
          assetId: ft.assetId,
          quantity: userFtShare.toString(),
          name: ft.name,
        };
      })
      .filter(ft => BigInt(ft.quantity) > BigInt(0));

    const hasFtDistribution = ftShares.length > 0;

    // Step 7: Create new claim
    const newClaim = this.claimRepository.create({
      user: user || undefined,
      vault,
      type: ClaimType.TERMINATION,
      status: ClaimStatus.AVAILABLE,
      amount: Number(dynamicShare.userVtBalance),
      lovelace_amount: noAdaDistribution ? 0 : Number(dynamicShare.adaShare),
      description: user
        ? `Termination claim for ${dynamicShare.userVtBalance} VT`
        : `Termination claim for unregistered address ${userAddress}`,
      metadata: {
        address: userAddress,
        vtAmount: dynamicShare.userVtBalance.toString(),
        adaAmount: noAdaDistribution ? '0' : dynamicShare.adaShare.toString(),
        ftShares: hasFtDistribution ? ftShares : undefined,
        noAdaDistribution,
      },
    });

    const savedClaim = await this.claimRepository.save(newClaim);

    this.logger.log(
      `Created on-demand termination claim ${savedClaim.id} for address ${userAddress} ` +
        `(VT: ${dynamicShare.userVtBalance}, ADA: ${dynamicShare.adaShare}, FTs: ${ftShares.length})`
    );

    return {
      claimId: savedClaim.id,
      vtBalance: dynamicShare.userVtBalance.toString(),
      adaShare: noAdaDistribution ? '0' : dynamicShare.adaShare.toString(),
      ftShares: hasFtDistribution ? ftShares : undefined,
      sharePercentage: dynamicShare.sharePercentage,
      isNewClaim: true,
    };
  }

  /**
   * Get termination status for a vault
   */
  async getTerminationStatus(vaultId: string): Promise<{
    vaultId: string;
    isTerminating: boolean;
    status?: string;
    proposalId?: string;
    totalAdaForDistribution?: string;
    treasuryBalance?: string;
    circulatingSupply?: string;
    claimsOpen: boolean;
  }> {
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      relations: ['treasury_wallet'],
    });

    if (!vault) {
      throw new NotFoundException(`Vault ${vaultId} not found`);
    }

    const termination = vault.termination_metadata as TerminationMetadata | undefined;

    if (!termination) {
      return {
        vaultId,
        isTerminating: false,
        claimsOpen: false,
      };
    }

    const claimsOpenStatuses = [TerminationStatus.CLAIMS_CREATED, TerminationStatus.CLAIMS_PROCESSING];
    const claimsOpen = claimsOpenStatuses.includes(termination.status);

    // Get treasury balance if claims are open
    let treasuryBalance: string | undefined;
    let circulatingSupply: string | undefined;

    if (claimsOpen && vault.treasury_wallet) {
      try {
        const balance = await this.getTreasuryBalance(vault);
        treasuryBalance = balance.toString();

        const supply = await this.getCirculatingVtSupply(vault);
        circulatingSupply = supply.toString();
      } catch {
        // Non-critical, continue without balance info
      }
    }

    return {
      vaultId,
      isTerminating: true,
      status: termination.status,
      proposalId: termination.proposalId,
      totalAdaForDistribution: termination.totalAdaForDistribution,
      treasuryBalance,
      circulatingSupply,
      claimsOpen,
    };
  }

  /**
   * Get all termination claims for a user across all vaults
   */
  async getUserTerminationClaims(
    userId: string,
    skip: number,
    limit = 10
  ): Promise<{
    claims: Pick<
      Claim,
      | 'id'
      | 'amount'
      | 'metadata'
      | 'lovelace_amount'
      | 'status'
      | 'created_at'
      | 'updated_at'
      | 'description'
      | 'vault'
    >[];
    total: number;
  }> {
    const [claims, total]: [
      Pick<
        Claim,
        | 'id'
        | 'amount'
        | 'metadata'
        | 'lovelace_amount'
        | 'status'
        | 'created_at'
        | 'updated_at'
        | 'description'
        | 'vault'
      >[],
      number,
    ] = await this.claimRepository.findAndCount({
      where: {
        user: { id: userId },
        type: ClaimType.TERMINATION,
      },
      order: { created_at: 'DESC' },
      relations: ['vault', 'vault.vault_image'],
      select: {
        id: true,
        amount: true,
        lovelace_amount: true,
        status: true,
        created_at: true,
        updated_at: true,
        description: true,
        metadata: true,
        vault: {
          id: true,
          name: true,
          vault_token_ticker: true,
          ft_token_decimals: true,
          vault_image: { file_url: true },
        },
      },
      skip,
      take: limit,
    });

    return {
      claims,
      total,
    };
  }

  /**
   * Build a simple VT burn transaction (no distribution)
   * User just sends their VT to burn wallet
   */
  private async buildSimpleVtBurnTransaction(
    claim: Claim,
    vault: Vault,
    userAddress: string,
    vtBalance: bigint
  ): Promise<{
    transactionId: string;
    presignedTx: string;
  }> {
    const { utxos: userUtxos, requiredInputs } = await getUtxosExtract(
      Address.from_bech32(userAddress),
      this.blockfrost,
      {
        targetAssets: [
          {
            amount: Number(vtBalance),
            token: `${vault.script_hash}${vault.asset_vault_name}`,
          },
        ],
        maxUtxos: 10,
        validateUtxos: false,
      }
    );

    const transaction = await this.transactionsService.createTransaction({
      vault_id: vault.id,
      type: TransactionType.claim,
      userId: claim.user?.id,
      metadata: {
        burnOnly: true,
      },
      assets: [], // No assets needed for this transaction as it's metadata update
    });
    // Build output: Send VT to burn wallet
    const outputs: any[] = [
      {
        address: this.adminAddress,
        assets: [
          {
            policyId: vault.script_hash,
            assetName: { name: vault.asset_vault_name, format: 'hex' },
            quantity: Number(vtBalance),
          },
        ],
      },
    ];

    // Build the transaction
    const buildInput = {
      changeAddress: userAddress, // User gets change back
      message: `Termination claim: Burn VT`,
      utxos: userUtxos,
      outputs,
      validityInterval: {
        start: true,
        end: true,
      },
      requiredInputs,
      network: this.isMainnet ? 'mainnet' : 'preprod',
    };

    const buildResponse = await this.blockchainService.buildTransaction(buildInput);

    // Store transaction data in claim metadata
    await this.claimRepository.update(
      { id: claim.id },
      {
        distribution_tx_id: transaction.id,
        metadata: {
          ...claim.metadata,
          pendingTransaction: {
            vtAmount: vtBalance.toString(),
            adaAmount: '0',
            ftShares: [],
            burnOnly: true, // Flag to indicate this is a burn-only transaction
            createdAt: new Date().toISOString(),
          },
        } as Record<string, any>,
      }
    );

    return {
      transactionId: transaction.id,
      presignedTx: FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex')).to_hex(),
    };
  }

  /**
   * Build a single atomic transaction that:
   * 1. Takes user's VT as input and sends to admin
   * 2. Takes treasury UTXOs as input and sends user's share (ADA + FTs) back to user
   * This ensures atomic swap - user gets their share only if VT is successfully sent
   */
  async buildTerminationClaimTransaction(
    claimId: string,
    userId: string
  ): Promise<{
    transactionId: string;
    presignedTx: string;
  }> {
    const claim = await this.claimRepository.findOne({
      where: {
        id: claimId,
        user: { id: userId },
        type: ClaimType.TERMINATION,
        status: ClaimStatus.AVAILABLE,
      },
      relations: ['vault', 'vault.treasury_wallet', 'user'],
    });

    if (!claim) {
      throw new NotFoundException('Termination claim not found or already processed');
    }

    const vault = claim.vault;
    const userAddress = claim.user?.address;
    const treasuryWallet = vault.treasury_wallet;

    if (!userAddress) {
      throw new Error('User address not found');
    }

    if (!treasuryWallet) {
      throw new Error('Treasury wallet not found for vault');
    }

    // Calculate dynamic share based on current VT holdings
    const dynamicShare = await this.calculateDynamicShare(userAddress, vault);

    if (dynamicShare.userVtBalance === BigInt(0)) {
      throw new Error('No VT balance found for claim');
    }

    // Check if there's ADA to distribute
    const terminationMetadata = claim.metadata as TerminationClaimMetadata;
    const noAdaDistribution =
      terminationMetadata?.noAdaDistribution === true ||
      dynamicShare.treasuryBalance < BigInt(this.MIN_TOTAL_ADA_FOR_DISTRIBUTION) ||
      dynamicShare.adaShare < BigInt(this.MIN_ADA_PER_CLAIM);

    // Get FT shares
    const ftShares = terminationMetadata?.ftShares || [];
    const hasFtDistribution = ftShares.length > 0 && ftShares.some(ft => BigInt(ft.quantity) > BigInt(0));

    const hasAda = !noAdaDistribution;

    // Build simple VT burn transaction (no treasury involvement)
    if (!hasAda && !hasFtDistribution) {
      return await this.buildSimpleVtBurnTransaction(claim, vault, userAddress, dynamicShare.userVtBalance);
    }

    // Get user's UTXOs (for VT input)
    const { utxos: userUtxos } = await getUtxosExtract(Address.from_bech32(userAddress), this.blockfrost, {
      minAda: 2_000_000, // Min ADA for transaction
      validateUtxos: false,
    });

    if (userUtxos.length === 0) {
      throw new Error('No UTXOs found in user wallet');
    }

    // Calculate ADA needed for distribution output
    const minAdaForAssets = hasFtDistribution ? BigInt(1_500_000) * BigInt(ftShares.length) : BigInt(0);
    const adaToSend = hasAda ? dynamicShare.adaShare : minAdaForAssets;
    const totalAdaNeeded = adaToSend + BigInt(1_000_000); // Add fee buffer

    // Get treasury UTXOs
    const { utxos: treasuryUtxos } = await getUtxosExtract(
      Address.from_bech32(treasuryWallet.treasury_address),
      this.blockfrost,
      {
        minAda: Number(totalAdaNeeded),
        validateUtxos: false,
      }
    );

    if (treasuryUtxos.length === 0) {
      throw new Error('Insufficient treasury balance for distribution');
    }

    // Build outputs
    const outputs: any[] = [
      // Output 1: Send VT to admin wallet
      {
        address: this.adminAddress,
        assets: [
          {
            policyId: vault.script_hash,
            assetName: { name: vault.vault_token_ticker || 'VT', format: 'utf8' },
            quantity: Number(dynamicShare.userVtBalance),
          },
        ],
      },
      // Output 2: Send ADA + FTs to user
      {
        address: userAddress,
        lovelace: adaToSend.toString(),
        ...(hasFtDistribution && {
          assets: ftShares
            .filter(ft => BigInt(ft.quantity) > BigInt(0))
            .map(ft => ({
              policyId: ft.policyId,
              assetName: { name: ft.assetId, format: 'hex' },
              quantity: Number(ft.quantity),
            })),
        }),
      },
    ];

    // Combine UTXOs from both user and treasury
    const combinedUtxos = [...userUtxos, ...treasuryUtxos];

    // Build the atomic transaction
    const buildInput = {
      changeAddress: userAddress, // User gets change from their inputs
      message: `Termination claim: Send VT and receive distribution`,
      utxos: combinedUtxos,
      outputs,
      validityInterval: {
        start: true,
        end: true,
      },
      network: this.isMainnet ? 'mainnet' : 'preprod',
    };

    const buildResponse = await this.blockchainService.buildTransaction(buildInput);

    // Create transaction record
    const transaction = await this.transactionsService.createTransaction({
      vault_id: vault.id,
      type: TransactionType.claim,
      userId: userId,
      amount: Number(dynamicShare.userVtBalance),
      metadata: {
        vtAmount: dynamicShare.userVtBalance.toString(),
        adaAmount: hasAda ? dynamicShare.adaShare.toString() : '0',
        ftShares: hasFtDistribution ? ftShares : [],
        treasuryAddress: treasuryWallet.treasury_address,
        burnOnly: false,
      },
      assets: [],
    });

    // Link transaction to claim
    await this.claimRepository.update(
      { id: claimId },
      {
        distribution_tx_id: transaction.id,
      }
    );

    this.logger.log(
      `Built atomic termination claim transaction for claim ${claimId}: ` +
        `VT: ${dynamicShare.userVtBalance}, ADA: ${hasAda ? dynamicShare.adaShare : 0}, FTs: ${ftShares.length}`
    );

    return {
      transactionId: transaction.id,
      presignedTx: buildResponse.complete,
    };
  }

  /**
   * Submit the atomic termination claim transaction
   * The user has already signed their part (VT inputs)
   * Now we add the treasury KMS signature and submit
   */
  async submitTerminationClaimTransaction(params: SubmitTransactionDto): Promise<{
    success: boolean;
    vtTxHash: string;
    distributionTxHash: string;
    adaReceived: string;
    ftsReceived?: Array<{ policyId: string; assetId: string; quantity: string; name?: string }>;
  }> {
    // Find claim by transaction ID
    const claim = await this.claimRepository.findOne({
      where: {
        distribution_tx_id: params.txId,
        type: ClaimType.TERMINATION,
        status: ClaimStatus.AVAILABLE,
      },
      relations: ['vault', 'vault.treasury_wallet', 'distribution_transaction'],
    });

    if (!claim) {
      throw new NotFoundException('Termination claim transaction not found');
    }

    const vault = claim.vault;
    const vaultId = vault.id;
    const transaction = claim.distribution_transaction;

    if (!transaction) {
      throw new Error('No transaction found for claim');
    }

    const txMetadata = transaction.metadata;

    try {
      let txHash: string;

      // Check if this is a burn-only transaction (no distribution)
      if (txMetadata?.burnOnly === true) {
        // Simple burn - just submit the user-signed transaction
        this.logger.log(`Submitting burn-only transaction for claim ${claim.id}`);

        const submitResponse = await this.blockchainService.submitTransaction({
          transaction: params.transaction,
          signatures: params.signatures || [],
        });

        txHash = submitResponse.txHash;
      } else {
        // Get treasury wallet private keys using KMS
        const { privateKey, stakePrivateKey } = await this.treasuryWalletService.getTreasuryWalletPrivateKey(vaultId);

        // Parse the user-signed transaction
        const txToSubmit = FixedTransaction.from_bytes(Buffer.from(params.transaction, 'hex'));

        // Add treasury wallet signatures
        txToSubmit.sign_and_add_vkey_signature(privateKey);
        txToSubmit.sign_and_add_vkey_signature(stakePrivateKey);

        // Submit the fully signed transaction
        const submitResponse = await this.blockchainService.submitTransaction({
          transaction: txToSubmit.to_hex(),
          signatures: [],
        });

        txHash = submitResponse.txHash;

        this.logger.log(
          `Atomic termination claim transaction submitted for claim ${claim.id}: ${txHash} ` +
            `(VT sent to admin + distribution sent to user in single tx)`
        );
      }

      // Get distribution amounts from transaction metadata
      const adaReceived = txMetadata?.adaAmount || '0';
      const ftsReceived = txMetadata?.ftShares || [];

      // Update transaction with tx hash
      await this.transactionsService.updateTransactionHash(transaction.id, txHash);

      // Mark claim as completed
      await this.claimRepository.update(
        { id: claim.id },
        {
          status: ClaimStatus.CLAIMED,
          amount: Number(txMetadata?.vtAmount || 0),
          lovelace_amount: Number(adaReceived),
          metadata: {
            ...claim.metadata,
            completedAt: new Date().toISOString(),
          } as Record<string, any>,
        }
      );

      return {
        success: true,
        vtTxHash: txHash,
        distributionTxHash: txHash, // Same tx for both VT and distribution
        adaReceived,
        ftsReceived: ftsReceived.length > 0 ? ftsReceived : undefined,
      };
    } catch (error) {
      // Mark transaction and claim as failed
      await this.transactionsService.updateTransactionStatusById(params.txId, TransactionStatus.failed);
      this.logger.error(`Failed to submit termination claim transaction: ${error.message}`, error.stack);
      throw error;
    }
  }
}
