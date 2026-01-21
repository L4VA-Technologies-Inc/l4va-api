import { Buffer } from 'buffer';

import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Address, FixedTransaction, PrivateKey } from '@emurgo/cardano-serialization-lib-nodejs';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { BlockchainService } from '../../processing-tx/onchain/blockchain.service';
import { getUtxosExtract } from '../../processing-tx/onchain/utils/lib';
import { VaultManagingService } from '../../processing-tx/onchain/vault-managing.service';
import { TreasuryWalletService } from '../../treasure/treasure-wallet.service';

import { Asset } from '@/database/asset.entity';
import { Claim } from '@/database/claim.entity';
import { Proposal } from '@/database/proposal.entity';
import { Snapshot } from '@/database/snapshot.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { VaultTreasuryWallet } from '@/database/vaultTreasuryWallet.entity';
import { VyfiService } from '@/modules/vyfi/vyfi.service';
import { AssetStatus } from '@/types/asset.types';
import { ClaimStatus, ClaimType } from '@/types/claim.types';
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
  lpRemovalTxHash?: string;
  lpReturnTxHash?: string;
  vtBurnTxHash?: string;
  adaTransferTxHash?: string;
  vaultBurnTxHash?: string;
  treasurySweepTxHash?: string;
  sweptLovelace?: string;
  totalAdaForDistribution?: string; // In lovelace
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
    @InjectRepository(VaultTreasuryWallet)
    private readonly treasuryWalletRepository: Repository<VaultTreasuryWallet>,
    private readonly configService: ConfigService,
    private readonly blockchainService: BlockchainService,
    private readonly eventEmitter: EventEmitter2,
    private readonly vyfiService: VyfiService,
    private readonly treasuryWalletService: TreasuryWalletService,
    private readonly vaultManagingService: VaultManagingService
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
   * Monitor termination progress every 5 minutes
   * Checks for pending LP returns and advances termination state
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async monitorTerminations(): Promise<void> {
    try {
      // Find vaults in terminating status
      const terminatingVaults = await this.vaultRepository.find({
        where: { vault_status: VaultStatus.terminating as any }, // Will add to enum
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
   * Step 1: Burn all NFTs in the vault
   */
  private async stepBurnNFTs(vault: Vault): Promise<void> {
    this.logger.log(`[Step 1] Burning NFTs for vault ${vault.id}`);

    // Get all NFTs in the vault
    const nfts = await this.assetRepository.find({
      where: {
        vault: { id: vault.id },
        type: 'nft' as any,
        status: AssetStatus.LOCKED,
      },
    });

    if (nfts.length === 0) {
      this.logger.log(`No NFTs to burn for vault ${vault.id}, skipping to LP removal`);
      await this.updateTerminationStatus(vault.id, TerminationStatus.NFT_BURNED);
      return;
    }

    // TODO: Implement NFT burning via TreasuryExtractionService
    // For now, mark as burned and continue
    this.logger.log(`Would burn ${nfts.length} NFT(s) for vault ${vault.id}`);

    await this.updateTerminationStatus(vault.id, TerminationStatus.NFT_BURNED);
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
   * If ADA amount is too small (below threshold), create VT-only claims
   * where users just burn their VT without receiving ADA distribution
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

    if (!hasEnoughAdaForDistribution) {
      this.logger.warn(
        `Not enough ADA for distribution. Total: ${totalAda} lovelace, Holders: ${vtHolderCount}. ` +
          `Creating VT-burn-only claims (no ADA payout).`
      );
    }

    // Create claims for each VT holder
    const claims: Partial<Claim>[] = [];

    for (const [address, balance] of Object.entries(addressBalances)) {
      const vtBalance = BigInt(balance);
      if (vtBalance === BigInt(0)) continue;

      // Calculate proportional ADA share (0 if not enough ADA)
      const adaShare = hasEnoughAdaForDistribution ? (totalAda * vtBalance) / totalVtSupply : BigInt(0);

      // Find user by address
      const user = await this.userRepository.findOne({
        where: { address },
      });

      const claimDescription = hasEnoughAdaForDistribution
        ? `Vault termination claim - Send ${vtBalance} VT to receive ${adaShare} lovelace`
        : `Vault termination claim - Send ${vtBalance} VT to burn wallet (no ADA distribution)`;

      claims.push({
        user_id: user?.id,
        vault: vault,
        type: ClaimType.TERMINATION as any,
        status: ClaimStatus.AVAILABLE,
        amount: Number(vtBalance), // VT amount user needs to send
        lovelace_amount: Number(adaShare), // ADA amount user will receive (0 if no distribution)
        description: claimDescription,
        metadata: {
          address,
          vtAmount: vtBalance.toString(),
          adaAmount: adaShare.toString(),
          snapshotId: snapshot.id,
          noAdaDistribution: !hasEnoughAdaForDistribution,
        },
      });
    }

    // Bulk insert claims
    await this.claimRepository.save(claims);

    this.logger.log(
      `Created ${claims.length} termination claims for vault ${vault.id} ` +
        `(ADA distribution: ${hasEnoughAdaForDistribution})`
    );

    await this.updateTerminationStatus(vault.id, TerminationStatus.CLAIMS_CREATED, {
      claimsCreatedAt: new Date().toISOString(),
    });

    this.eventEmitter.emit('vault.termination_claims_created', {
      vaultId: vault.id,
      claimCount: claims.length,
      totalAda: totalAda.toString(),
      hasAdaDistribution: hasEnoughAdaForDistribution,
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
        type: ClaimType.TERMINATION as any,
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

      // Check if wallet has any remaining balance
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
   * Process a termination claim with dynamic VT verification
   *
   * IMPORTANT: This now verifies the user's CURRENT on-chain VT balance
   * and calculates their share dynamically based on:
   * - Current VT holdings (not snapshot)
   * - Current treasury balance (not original amount)
   * - Current circulating VT supply (excludes burned tokens)
   *
   * This handles the edge case where users swap VT after claims are created.
   */
  async processTerminationClaim(
    claimId: string,
    userVtTxHash: string
  ): Promise<{
    adaTxHash: string;
    actualVtBurned: string;
    adaReceived: string;
    sharePercentage: number;
  }> {
    const claim = await this.claimRepository.findOne({
      where: {
        id: claimId,
        type: ClaimType.TERMINATION as any,
        status: ClaimStatus.AVAILABLE,
      },
      relations: ['vault', 'vault.treasury_wallet'],
    });

    if (!claim) {
      throw new NotFoundException(`Claim ${claimId} not found or already processed`);
    }

    const userAddress = claim.metadata?.address;
    if (!userAddress) {
      throw new Error('Claim missing user address');
    }

    const vault = claim.vault;
    if (!vault) {
      throw new Error('Claim missing vault reference');
    }

    // Step 1: Calculate dynamic share based on CURRENT on-chain state
    this.logger.log(`Calculating dynamic share for claim ${claimId}, user: ${userAddress}`);

    const dynamicShare = await this.calculateDynamicShare(userAddress, vault);

    this.logger.log(
      `Dynamic share calculation: ` +
        `userVT=${dynamicShare.userVtBalance}, ` +
        `circulating=${dynamicShare.circulatingSupply}, ` +
        `treasury=${dynamicShare.treasuryBalance}, ` +
        `adaShare=${dynamicShare.adaShare} (${dynamicShare.sharePercentage}%)`
    );

    // Step 2: Verify user actually has VT to claim
    if (dynamicShare.userVtBalance === BigInt(0)) {
      this.logger.warn(`User ${userAddress} has no VT balance - claim ${claimId} invalid`);

      // Mark claim as invalid/expired since user sold their VT
      await this.claimRepository.update(
        { id: claimId },
        {
          status: ClaimStatus.FAILED,
          metadata: {
            ...claim.metadata,
            failureReason: 'no_vt_balance',
            checkedAt: new Date().toISOString(),
          } as Record<string, any>,
        }
      );

      throw new Error('No VT balance found. You may have sold or transferred your VT tokens.');
    }

    // Step 3: Verify user has sent VT to burn wallet (if txHash provided)
    if (userVtTxHash && userVtTxHash !== 'pending') {
      const vtBurnVerified = await this.verifyVtBurnTransaction(
        userVtTxHash,
        userAddress,
        vault,
        dynamicShare.userVtBalance
      );

      if (!vtBurnVerified.success) {
        throw new Error(`VT burn verification failed: ${vtBurnVerified.reason}`);
      }
    }

    // Step 4: Check if there's ADA to distribute
    const noAdaDistribution =
      claim.metadata?.noAdaDistribution === true ||
      dynamicShare.treasuryBalance < BigInt(this.MIN_TOTAL_ADA_FOR_DISTRIBUTION) ||
      dynamicShare.adaShare < BigInt(this.MIN_ADA_PER_CLAIM);

    // Mark claim as pending
    await this.claimRepository.update(
      { id: claimId },
      {
        status: ClaimStatus.PENDING,
        // Update with actual calculated amounts
        amount: Number(dynamicShare.userVtBalance),
        lovelace_amount: noAdaDistribution ? 0 : Number(dynamicShare.adaShare),
        metadata: {
          ...claim.metadata,
          dynamicCalculation: {
            userVtBalance: dynamicShare.userVtBalance.toString(),
            circulatingSupply: dynamicShare.circulatingSupply.toString(),
            treasuryBalance: dynamicShare.treasuryBalance.toString(),
            adaShare: dynamicShare.adaShare.toString(),
            sharePercentage: dynamicShare.sharePercentage,
            calculatedAt: new Date().toISOString(),
          },
        } as Record<string, any>,
      }
    );

    try {
      if (noAdaDistribution) {
        this.logger.log(`Claim ${claimId} has insufficient ADA for distribution - completing as VT-burn-only`);

        await this.claimRepository.update(
          { id: claimId },
          {
            status: ClaimStatus.CLAIMED,
            description: 'VT burned - insufficient treasury for ADA distribution',
          }
        );

        return {
          adaTxHash: 'no_ada_distribution',
          actualVtBurned: dynamicShare.userVtBalance.toString(),
          adaReceived: '0',
          sharePercentage: dynamicShare.sharePercentage,
        };
      }

      // Step 5: Send calculated ADA share from treasury to user
      const updatedClaim = await this.claimRepository.findOne({
        where: { id: claimId },
        relations: ['vault', 'vault.treasury_wallet'],
      });

      const adaTxHash = await this.sendAdaToUser(updatedClaim);

      // Mark claim as completed
      await this.claimRepository.update(
        { id: claimId },
        {
          status: ClaimStatus.CLAIMED,
          distribution_tx_id: adaTxHash,
        }
      );

      return {
        adaTxHash,
        actualVtBurned: dynamicShare.userVtBalance.toString(),
        adaReceived: dynamicShare.adaShare.toString(),
        sharePercentage: dynamicShare.sharePercentage,
      };
    } catch (error) {
      await this.claimRepository.update(
        { id: claimId },
        {
          status: ClaimStatus.FAILED,
          metadata: {
            ...claim.metadata,
            failureReason: error.message,
            failedAt: new Date().toISOString(),
          } as Record<string, any>,
        }
      );
      throw error;
    }
  }

  /**
   * Verify that user has sent VT to burn wallet
   */
  private async verifyVtBurnTransaction(
    txHash: string,
    userAddress: string,
    vault: Vault,
    expectedAmount: bigint
  ): Promise<{ success: boolean; reason?: string; actualAmount?: bigint }> {
    try {
      const txUtxos = await this.blockfrost.txsUtxos(txHash);
      const vtUnit = `${vault.script_hash}${vault.asset_vault_name}`;

      // Check if any output sends VT to burn wallet
      const burnOutput = txUtxos.outputs.find(
        output => output.address === this.burnWallet && output.amount.some(a => a.unit === vtUnit)
      );

      if (!burnOutput) {
        return { success: false, reason: 'No VT sent to burn wallet in this transaction' };
      }

      // Verify sender is the claim owner
      const senderInput = txUtxos.inputs.find(input => input.address === userAddress);
      if (!senderInput) {
        return { success: false, reason: 'Transaction not sent from claim owner address' };
      }

      // Get actual VT amount burned
      const vtAmount = burnOutput.amount.find(a => a.unit === vtUnit);
      const actualAmount = BigInt(vtAmount?.quantity || '0');

      if (actualAmount < expectedAmount) {
        return {
          success: false,
          reason: `Insufficient VT burned. Expected: ${expectedAmount}, Actual: ${actualAmount}`,
          actualAmount,
        };
      }

      return { success: true, actualAmount };
    } catch (error) {
      return { success: false, reason: `Failed to verify transaction: ${error.message}` };
    }
  }

  /**
   * Get current claim status with dynamic share calculation
   * Allows users to preview their claim before executing
   */
  async getTerminationClaimPreview(claimId: string): Promise<{
    claimId: string;
    originalVtAmount: string;
    currentVtBalance: string;
    originalAdaShare: string;
    currentAdaShare: string;
    sharePercentage: number;
    treasuryBalance: string;
    circulatingSupply: string;
    status: ClaimStatus;
    canClaim: boolean;
    reason?: string;
  }> {
    const claim = await this.claimRepository.findOne({
      where: { id: claimId },
      relations: ['vault', 'vault.treasury_wallet'],
    });

    if (!claim) {
      throw new NotFoundException(`Claim ${claimId} not found`);
    }

    const userAddress = claim.metadata?.address;
    if (!userAddress || !claim.vault) {
      throw new Error('Invalid claim data');
    }

    const dynamicShare = await this.calculateDynamicShare(userAddress, claim.vault);

    const canClaim =
      claim.status === ClaimStatus.AVAILABLE &&
      dynamicShare.userVtBalance > BigInt(0) &&
      dynamicShare.adaShare >= BigInt(this.MIN_ADA_PER_CLAIM);

    let reason: string | undefined;
    if (claim.status !== ClaimStatus.AVAILABLE) {
      reason = `Claim already ${claim.status}`;
    } else if (dynamicShare.userVtBalance === BigInt(0)) {
      reason = 'No VT balance - tokens may have been sold or transferred';
    } else if (dynamicShare.adaShare < BigInt(this.MIN_ADA_PER_CLAIM)) {
      reason = `ADA share (${dynamicShare.adaShare}) below minimum (${this.MIN_ADA_PER_CLAIM})`;
    }

    return {
      claimId,
      originalVtAmount: claim.metadata?.vtAmount || claim.amount?.toString() || '0',
      currentVtBalance: dynamicShare.userVtBalance.toString(),
      originalAdaShare: claim.metadata?.adaAmount || claim.lovelace_amount?.toString() || '0',
      currentAdaShare: dynamicShare.adaShare.toString(),
      sharePercentage: dynamicShare.sharePercentage,
      treasuryBalance: dynamicShare.treasuryBalance.toString(),
      circulatingSupply: dynamicShare.circulatingSupply.toString(),
      status: claim.status,
      canClaim,
      reason,
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
   * 4. Create new claim dynamically
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
        type: ClaimType.TERMINATION as any,
        metadata: { address: userAddress } as any,
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

    // Step 6: Create new claim
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
        noAdaDistribution,
        isTransferredVT: true, // Flag indicating this VT was transferred after snapshot
        createdOnDemand: true,
        createdAt: new Date().toISOString(),
        calculationSnapshot: {
          userVtBalance: dynamicShare.userVtBalance.toString(),
          circulatingSupply: dynamicShare.circulatingSupply.toString(),
          treasuryBalance: dynamicShare.treasuryBalance.toString(),
          sharePercentage: dynamicShare.sharePercentage,
        },
      },
    });

    const savedClaim = await this.claimRepository.save(newClaim);

    this.logger.log(
      `Created on-demand termination claim ${savedClaim.id} for address ${userAddress} ` +
        `(VT: ${dynamicShare.userVtBalance}, ADA share: ${dynamicShare.adaShare})`
    );

    return {
      claimId: savedClaim.id,
      vtBalance: dynamicShare.userVtBalance.toString(),
      adaShare: noAdaDistribution ? '0' : dynamicShare.adaShare.toString(),
      sharePercentage: dynamicShare.sharePercentage,
      isNewClaim: true,
    };
  }

  /**
   * Get termination claim preview by address (for users who may not have a claim yet)
   * This allows any VT holder to see what they could claim before requesting it.
   */
  async getTerminationPreviewByAddress(
    vaultId: string,
    userAddress: string
  ): Promise<{
    vaultId: string;
    address: string;
    vtBalance: string;
    adaShare: string;
    sharePercentage: number;
    treasuryBalance: string;
    circulatingSupply: string;
    hasExistingClaim: boolean;
    existingClaimId?: string;
    existingClaimStatus?: ClaimStatus;
    canClaim: boolean;
    reason?: string;
  }> {
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      relations: ['treasury_wallet'],
    });

    if (!vault) {
      throw new NotFoundException(`Vault ${vaultId} not found`);
    }

    // Check termination status
    const termination = vault.termination_metadata as TerminationMetadata | undefined;
    if (!termination) {
      return {
        vaultId,
        address: userAddress,
        vtBalance: '0',
        adaShare: '0',
        sharePercentage: 0,
        treasuryBalance: '0',
        circulatingSupply: '0',
        hasExistingClaim: false,
        canClaim: false,
        reason: 'Vault is not in termination process',
      };
    }

    // Calculate dynamic share
    const dynamicShare = await this.calculateDynamicShare(userAddress, vault);

    // Check for existing claim
    const existingClaim = await this.claimRepository.findOne({
      where: {
        vault: { id: vaultId },
        type: ClaimType.TERMINATION as any,
        metadata: { address: userAddress } as any,
      },
    });

    // Determine if can claim
    const validStatuses = [TerminationStatus.CLAIMS_CREATED, TerminationStatus.CLAIMS_PROCESSING];

    let canClaim = false;
    let reason: string | undefined;

    if (!validStatuses.includes(termination.status)) {
      reason = `Claims not available at current status: ${termination.status}`;
    } else if (dynamicShare.userVtBalance === BigInt(0)) {
      reason = 'No VT balance at this address';
    } else if (existingClaim && existingClaim.status !== ClaimStatus.AVAILABLE) {
      reason = `Claim already ${existingClaim.status}`;
    } else {
      canClaim = true;
    }

    return {
      vaultId,
      address: userAddress,
      vtBalance: dynamicShare.userVtBalance.toString(),
      adaShare: dynamicShare.adaShare.toString(),
      sharePercentage: dynamicShare.sharePercentage,
      treasuryBalance: dynamicShare.treasuryBalance.toString(),
      circulatingSupply: dynamicShare.circulatingSupply.toString(),
      hasExistingClaim: !!existingClaim,
      existingClaimId: existingClaim?.id,
      existingClaimStatus: existingClaim?.status,
      canClaim,
      reason,
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
  async getUserTerminationClaims(userId: string): Promise<{
    claims: Array<{
      claimId: string;
      vaultId: string;
      vaultName: string;
      vtAmount: string;
      adaAmount: string;
      status: string;
      createdAt: Date;
    }>;
  }> {
    const claims = await this.claimRepository.find({
      where: {
        user: { id: userId },
        type: ClaimType.TERMINATION as any,
      },
      relations: ['vault'],
      order: { created_at: 'DESC' },
    });

    return {
      claims: claims.map(claim => ({
        claimId: claim.id,
        vaultId: claim.vault?.id || '',
        vaultName: claim.vault?.name || 'Unknown',
        vtAmount: claim.metadata?.vtAmount || claim.amount?.toString() || '0',
        adaAmount: claim.metadata?.adaAmount || claim.lovelace_amount?.toString() || '0',
        status: claim.status,
        createdAt: claim.created_at,
      })),
    };
  }

  /**
   * Get termination claims for a user in a specific vault
   */
  async getUserVaultTerminationClaims(
    vaultId: string,
    userId: string
  ): Promise<{
    claims: Array<{
      claimId: string;
      vtAmount: string;
      adaAmount: string;
      status: string;
      canClaim: boolean;
    }>;
  }> {
    // Get user to find their address
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      return { claims: [] };
    }

    // Find claims by user ID or by address in metadata
    const claims = await this.claimRepository.find({
      where: [
        {
          vault: { id: vaultId },
          user: { id: userId },
          type: ClaimType.TERMINATION as any,
        },
        {
          vault: { id: vaultId },
          type: ClaimType.TERMINATION as any,
          metadata: { address: user.address } as any,
        },
      ],
      relations: ['vault', 'vault.treasury_wallet'],
    });

    // Deduplicate by claim ID
    const uniqueClaims = [...new Map(claims.map(c => [c.id, c])).values()];

    const result = await Promise.all(
      uniqueClaims.map(async claim => {
        let canClaim = claim.status === ClaimStatus.AVAILABLE;

        // Check if user still has VT balance
        if (canClaim && claim.vault && claim.metadata?.address) {
          try {
            const vtBalance = await this.getUserVtBalance(claim.metadata.address, claim.vault);
            canClaim = vtBalance > BigInt(0);
          } catch {
            // If we can't check, assume can claim
          }
        }

        return {
          claimId: claim.id,
          vtAmount: claim.metadata?.vtAmount || claim.amount?.toString() || '0',
          adaAmount: claim.metadata?.adaAmount || claim.lovelace_amount?.toString() || '0',
          status: claim.status,
          canClaim,
        };
      })
    );

    return { claims: result };
  }

  /**
   * Send ADA from treasury to user for termination claim
   * Uses KMS-based treasury wallet signing
   */
  private async sendAdaToUser(claim: Claim): Promise<string> {
    const userAddress = claim.metadata?.address;
    const adaAmount = claim.lovelace_amount;
    const vaultId = claim.vault?.id;

    if (!userAddress || !adaAmount) {
      throw new Error('Invalid claim data: missing address or amount');
    }

    if (!vaultId) {
      throw new Error('Invalid claim data: missing vault reference');
    }

    // Skip if ADA amount is too small (covers min UTXO + fees)
    if (adaAmount < this.MIN_ADA_PER_CLAIM) {
      this.logger.warn(`Claim ${claim.id} ADA amount (${adaAmount}) below minimum (${this.MIN_ADA_PER_CLAIM})`);
      return 'amount_below_minimum';
    }

    // Get treasury wallet
    const treasuryWallet = claim.vault?.treasury_wallet;
    if (!treasuryWallet) {
      throw new Error(`No treasury wallet found for vault ${vaultId}`);
    }

    try {
      // Get treasury wallet private keys using KMS
      const { privateKey, stakePrivateKey } = await this.treasuryWalletService.getTreasuryWalletPrivateKey(vaultId);

      // Get treasury UTXOs
      const { utxos: treasuryUtxos } = await getUtxosExtract(
        Address.from_bech32(treasuryWallet.treasury_address),
        this.blockfrost,
        {
          minAda: adaAmount + 500_000, // Amount + fee buffer
          validateUtxos: false,
        }
      );

      if (treasuryUtxos.length === 0) {
        throw new Error(`Insufficient treasury balance for claim ${claim.id}`);
      }

      // Build the ADA transfer transaction
      const input = {
        changeAddress: treasuryWallet.treasury_address,
        message: `Termination claim payout - Vault ${vaultId}`,
        utxos: treasuryUtxos,
        outputs: [
          {
            address: userAddress,
            lovelace: adaAmount.toString(),
          },
        ],
        validityInterval: {
          start: true,
          end: true,
        },
        network: this.isMainnet ? 'mainnet' : 'preprod',
      };

      const buildResponse = await this.blockchainService.buildTransaction(input);
      const txToSubmit = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));

      // Sign with treasury wallet keys (KMS-decrypted)
      txToSubmit.sign_and_add_vkey_signature(privateKey);
      txToSubmit.sign_and_add_vkey_signature(stakePrivateKey);

      // Submit the transaction
      const submitResponse = await this.blockchainService.submitTransaction({
        transaction: txToSubmit.to_hex(),
        signatures: [],
      });

      this.logger.log(`Treasury payout for claim ${claim.id} submitted: ${submitResponse.txHash}`);

      return submitResponse.txHash;
    } catch (error) {
      this.logger.error(`Failed to send ADA to user for claim ${claim.id}: ${error.message}`, error.stack);
      throw new Error(`Treasury payout failed: ${error.message}`);
    }
  }
}
