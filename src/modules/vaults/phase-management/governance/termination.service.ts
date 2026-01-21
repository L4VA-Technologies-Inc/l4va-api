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
    private readonly vyfiService: VyfiService
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
   * Monitor termination progress every 2 minutes
   * Checks for pending LP returns and advances termination state
   */
  @Cron(CronExpression.EVERY_MINUTE)
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

    // Create claims for each VT holder
    const claims: Partial<Claim>[] = [];

    for (const [address, balance] of Object.entries(addressBalances)) {
      const vtBalance = BigInt(balance);
      if (vtBalance === BigInt(0)) continue;

      // Calculate proportional ADA share
      const adaShare = (totalAda * vtBalance) / totalVtSupply;

      // Find user by address
      const user = await this.userRepository.findOne({
        where: { address },
      });

      claims.push({
        user_id: user?.id,
        vault: vault,
        type: ClaimType.TERMINATION as any, // Will add to enum
        status: ClaimStatus.AVAILABLE,
        amount: Number(vtBalance), // VT amount user needs to send
        lovelace_amount: Number(adaShare), // ADA amount user will receive
        description: `Vault termination claim - Send ${vtBalance} VT to receive ${adaShare} lovelace`,
        metadata: {
          address,
          vtAmount: vtBalance.toString(),
          adaAmount: adaShare.toString(),
          snapshotId: snapshot.id,
        },
      });
    }

    // Bulk insert claims
    await this.claimRepository.save(claims);

    this.logger.log(`Created ${claims.length} termination claims for vault ${vault.id}`);

    await this.updateTerminationStatus(vault.id, TerminationStatus.CLAIMS_CREATED, {
      claimsCreatedAt: new Date().toISOString(),
    });

    this.eventEmitter.emit('vault.termination_claims_created', {
      vaultId: vault.id,
      claimCount: claims.length,
      totalAda: totalAda.toString(),
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
   */
  private async stepBurnVault(vault: Vault): Promise<void> {
    this.logger.log(`[Step 8] Burning vault NFT for vault ${vault.id}`);

    // TODO: Implement vault NFT burning using VaultBurn redeemer
    // This requires spending from vault script with admin signature

    // For now, just update the vault status to burned
    await this.vaultRepository.update({ id: vault.id }, { vault_status: VaultStatus.burned });

    await this.updateTerminationStatus(vault.id, TerminationStatus.VAULT_BURNED);

    this.eventEmitter.emit('vault.burned', {
      vaultId: vault.id,
    });

    this.logger.log(`Vault ${vault.id} termination complete - vault burned`);
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
   * Process a termination claim (user sends VT, receives ADA)
   */
  async processTerminationClaim(claimId: string, _userVtTxHash: string): Promise<{ adaTxHash: string }> {
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

    // Verify the user's VT transfer transaction
    // TODO: Implement verification that user sent VT to burn wallet

    // Mark claim as pending
    await this.claimRepository.update({ id: claimId }, { status: ClaimStatus.PENDING });

    try {
      // Send ADA from treasury to user
      const adaTxHash = await this.sendAdaToUser(claim);

      // Mark claim as completed
      await this.claimRepository.update(
        { id: claimId },
        {
          status: ClaimStatus.CLAIMED,
          distribution_tx_id: adaTxHash,
        }
      );

      return { adaTxHash };
    } catch (error) {
      // Mark claim as failed
      await this.claimRepository.update({ id: claimId }, { status: ClaimStatus.FAILED });
      throw error;
    }
  }

  /**
   * Send ADA from treasury to user for termination claim
   */
  private async sendAdaToUser(claim: Claim): Promise<string> {
    const userAddress = claim.metadata?.address;
    const adaAmount = claim.lovelace_amount;

    if (!userAddress || !adaAmount) {
      throw new Error('Invalid claim data');
    }

    // TODO: Implement treasury wallet signing using KMS
    // For now, this is a placeholder
    this.logger.warn('sendAdaToUser: Treasury signing not yet implemented');

    return 'placeholder_tx_hash';
  }
}
