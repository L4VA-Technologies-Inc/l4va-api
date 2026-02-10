import { Buffer } from 'node:buffer';

import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Address, FixedTransaction, PrivateKey } from '@emurgo/cardano-serialization-lib-nodejs';
import { Controller, Post, Body, Logger, HttpCode, HttpStatus, UseGuards, Get, Param } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';

import { AuthGuard } from '../auth/auth.guard';
import { ContributorPaymentBuilder } from '../distribution/builders/contributor-payment.builder';
import { AddressesUtxo } from '../distribution/distribution.types';
import { MultiBatchDistributionService } from '../distribution/multi-batch-distribution.service';

import { Claim } from '@/database/claim.entity';
import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { TransactionsService } from '@/modules/vaults/processing-tx/offchain-tx/transactions.service';
import { BlockchainService } from '@/modules/vaults/processing-tx/onchain/blockchain.service';
import { getAddressFromHash, getUtxosExtract } from '@/modules/vaults/processing-tx/onchain/utils/lib';
import { ClaimStatus, ClaimType } from '@/types/claim.types';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';

/**
 * Manual Distribution Controller
 *
 * Provides manual control over vault distribution process.
 * Use these endpoints when manual_distribution_mode is enabled.
 *
 * Workflow:
 * 1. Enable manual mode on vault
 * 2. Get pending claims
 * 3. Prepare vault update for specific claims
 * 4. Submit vault update with multipliers
 * 5. Trigger claim processing
 */
@ApiTags('manual-distribution')
@UseGuards(AuthGuard)
@Controller('manual-distribution')
export class DiagnosticController {
  private readonly logger = new Logger(DiagnosticController.name);

  constructor(
    private readonly multiBatchService: MultiBatchDistributionService,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(Claim)
    private readonly claimRepository: Repository<Claim>,
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    private readonly paymentBuilder: ContributorPaymentBuilder,
    private readonly blockchainService: BlockchainService,
    private readonly transactionsService: TransactionsService,
    private readonly blockfrost: BlockFrostAPI,
    private readonly configService: ConfigService
  ) {
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_API_KEY'),
    });
  }

  /**
   * Get required multipliers for specific claims
   *
   * Use this to diagnose which multipliers are missing for claims that cannot be processed.
   */
  @Post('vault/required-multipliers')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get required multipliers for specific claims',
    description: 'Diagnostic endpoint to identify which multipliers are needed for specific claims to be processed',
  })
  async getRequiredMultipliersForClaims(@Body() body: { vaultId: string; claimIds: string[] }): Promise<any> {
    this.logger.log(`Getting required multipliers for vault ${body.vaultId}, claims: ${body.claimIds.join(', ')}`);

    const result = await this.multiBatchService.getRequiredMultipliersForClaims(body.vaultId, body.claimIds);

    return {
      success: true,
      data: result,
    };
  }

  /**
   * Manually update vault multipliers
   *
   * Use this to manually add multipliers to a vault on-chain.
   * WARNING: Only use this when manual_distribution_mode is enabled!
   */
  @Post('vault/manual-update-multipliers')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Manually update vault multipliers on-chain',
    description: 'Manually add multipliers to vault. Requires manual_distribution_mode = true on the vault.',
  })
  async manuallyUpdateVaultMultipliers(
    @Body()
    body: {
      vaultId: string;
      multipliers: Array<[string, string | null, number]>;
      adaDistribution: Array<[string, string, number]>;
      reason: string;
    }
  ): Promise<any> {
    this.logger.log(`Manual vault update for ${body.vaultId}: ${body.reason}`);

    const result = await this.multiBatchService.manuallyUpdateVaultMultipliers(
      body.vaultId,
      body.multipliers,
      body.adaDistribution,
      body.reason
    );

    return {
      success: true,
      data: result,
    };
  }

  /**
   * Check if a claim can be processed
   *
   * Verifies if a claim's multipliers are already on-chain.
   */
  @Post('vault/can-claim-be-processed')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Check if claim can be processed',
    description: "Verify if a claim's multipliers are on-chain and the claim is ready for processing",
  })
  async canClaimBeProcessed(@Body() body: { vaultId: string; claimId: string }): Promise<any> {
    this.logger.log(`Checking if claim ${body.claimId} can be processed for vault ${body.vaultId}`);

    const result = await this.multiBatchService.canClaimBeProcessed(body.vaultId, body.claimId);

    return {
      success: true,
      data: result,
    };
  }

  /**
   * Calculate multipliers for a specific claim
   *
   * This calculates the exact multipliers needed for a claim's assets.
   * Uses pending_multipliers if available, otherwise calculates from claim amounts.
   *
   * The returned multipliers can be passed directly to manual-update-multipliers.
   */
  @Post('vault/calculate-multipliers-for-claim')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Calculate multipliers for a specific claim',
    description: 'Calculate the exact VT and ADA multipliers for a claim. Returns data ready for vault update.',
  })
  async calculateMultipliersForClaim(@Body() body: { vaultId: string; claimId: string }): Promise<any> {
    this.logger.log(`Calculating multipliers for claim ${body.claimId} in vault ${body.vaultId}`);

    const vault = await this.vaultRepository.findOne({
      where: { id: body.vaultId },
      select: ['id', 'pending_multipliers', 'pending_ada_distribution', 'acquire_multiplier', 'ada_distribution'],
    });

    if (!vault) {
      return { success: false, message: `Vault ${body.vaultId} not found` };
    }

    const claim = await this.claimRepository.findOne({
      where: { id: body.claimId, vault_id: body.vaultId },
      relations: ['transaction', 'transaction.assets'],
    });

    if (!claim) {
      return { success: false, message: `Claim ${body.claimId} not found in vault ${body.vaultId}` };
    }

    if (!claim.transaction?.assets?.length) {
      return { success: false, message: `Claim ${body.claimId} has no transaction assets` };
    }

    const assets = claim.transaction.assets;
    const claimVtAmount = Number(claim.amount) || 0;
    const claimLovelaceAmount = Number(claim.lovelace_amount) || 0;

    // Calculate total quantity to distribute proportionally
    const totalQuantity = assets.reduce((sum, a) => sum + Number(a.quantity), 0);

    const multipliersToAdd: Array<[string, string | null, number]> = [];
    const adaDistributionToAdd: Array<[string, string, number]> = [];

    // Check existing on-chain multipliers
    const onChainMap = new Map<string, number>();
    for (const [policyId, assetName, mult] of vault.acquire_multiplier || []) {
      const key = assetName ? `${policyId}:${assetName}` : policyId;
      onChainMap.set(key, mult);
    }

    const onChainAdaMap = new Map<string, number>();
    for (const [policyId, assetName, mult] of vault.ada_distribution || []) {
      const key = assetName ? `${policyId}:${assetName}` : policyId;
      onChainAdaMap.set(key, mult);
    }

    // Check pending multipliers
    const pendingMap = new Map<string, [string, string | null, number]>();
    for (const mult of vault.pending_multipliers || []) {
      const key = mult[1] ? `${mult[0]}:${mult[1]}` : mult[0];
      pendingMap.set(key, mult);
    }

    const pendingAdaMap = new Map<string, [string, string, number]>();
    for (const mult of vault.pending_ada_distribution || []) {
      const key = mult[1] ? `${mult[0]}:${mult[1]}` : mult[0];
      pendingAdaMap.set(key, mult);
    }

    const assetDetails: Array<{
      policyId: string;
      assetId: string;
      assetName: string;
      quantity: number;
      vtMultiplier: number;
      adaMultiplier: number;
      calculatedVt: number;
      calculatedAda: number;
      source: string;
    }> = [];

    let calculatedTotalVt = 0;
    let calculatedTotalAda = 0;

    for (const asset of assets) {
      const key = asset.asset_id ? `${asset.policy_id}:${asset.asset_id}` : asset.policy_id;
      const quantity = Number(asset.quantity);

      let vtMultiplier: number;
      let adaMultiplier: number;
      let source: string;

      // Check if already on-chain
      if (onChainMap.has(key)) {
        vtMultiplier = onChainMap.get(key)!;
        adaMultiplier = onChainAdaMap.get(key) || 0;
        source = 'on-chain (skip)';
      }
      // Check pending multipliers
      else if (pendingMap.has(key)) {
        const pendingMult = pendingMap.get(key)!;
        vtMultiplier = pendingMult[2];
        const pendingAda = pendingAdaMap.get(key);
        adaMultiplier = pendingAda ? pendingAda[2] : 0;
        source = 'pending';

        // Add to multipliers to submit
        multipliersToAdd.push([asset.policy_id, asset.asset_id || null, vtMultiplier]);
        if (adaMultiplier > 0) {
          adaDistributionToAdd.push([asset.policy_id, asset.asset_id || '', adaMultiplier]);
        }
      }
      // Calculate from claim amounts
      else {
        // Distribute proportionally by quantity
        const proportion = quantity / totalQuantity;
        const assetVtShare = claimVtAmount * proportion;
        const assetAdaShare = claimLovelaceAmount * proportion;

        // multiplier = vtAmount / quantity (integer)
        vtMultiplier = quantity > 0 ? Math.floor(assetVtShare / quantity) : 0;
        adaMultiplier = quantity > 0 ? Math.floor(assetAdaShare / quantity) : 0;
        source = 'calculated';

        // Add to multipliers to submit
        multipliersToAdd.push([asset.policy_id, asset.asset_id || null, vtMultiplier]);
        if (adaMultiplier > 0) {
          adaDistributionToAdd.push([asset.policy_id, asset.asset_id || '', adaMultiplier]);
        }
      }

      const calculatedVt = quantity * vtMultiplier;
      const calculatedAda = quantity * adaMultiplier;

      if (source !== 'on-chain (skip)') {
        calculatedTotalVt += calculatedVt;
        calculatedTotalAda += calculatedAda;
      }

      assetDetails.push({
        policyId: asset.policy_id,
        assetId: asset.asset_id || '',
        assetName: asset.name || '',
        quantity,
        vtMultiplier,
        adaMultiplier,
        calculatedVt,
        calculatedAda,
        source,
      });
    }

    const vtDifference = claimVtAmount - calculatedTotalVt;
    const adaDifference = claimLovelaceAmount - calculatedTotalAda;

    return {
      success: true,
      claimId: body.claimId,
      vaultId: body.vaultId,
      claim: {
        expectedVtAmount: claimVtAmount,
        expectedLovelaceAmount: claimLovelaceAmount,
        assetCount: assets.length,
        totalQuantity,
      },
      calculation: {
        calculatedTotalVt,
        calculatedTotalAda,
        vtDifference,
        adaDifference,
        note:
          vtDifference !== 0 || adaDifference !== 0
            ? '⚠️ Rounding difference due to integer multipliers. This is expected.'
            : '✅ Exact match',
      },
      assets: assetDetails,
      // Ready to use for vault update
      multipliersToAdd,
      adaDistributionToAdd,
      multipliersCount: multipliersToAdd.length,
      usage:
        multipliersToAdd.length > 0
          ? 'Pass multipliersToAdd and adaDistributionToAdd to POST /vault/manual-update-multipliers'
          : 'All multipliers already on-chain. Claim can be processed directly.',
    };
  }

  // ========================================
  // MANUAL DISTRIBUTION CONTROL ENDPOINTS
  // ========================================

  /**
   * STEP 1: Enable manual distribution mode on a vault
   *
   * This stops automatic batch progression and allows manual control.
   */
  @Post('vault/:vaultId/enable-manual-mode')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Enable manual distribution mode',
    description: 'Enable manual distribution mode to stop automatic batch progression and allow manual control',
  })
  async enableManualMode(@Param('vaultId') vaultId: string): Promise<any> {
    this.logger.log(`Enabling manual distribution mode for vault ${vaultId}`);

    const vault = await this.vaultRepository.findOne({ where: { id: vaultId } });
    if (!vault) {
      return { success: false, message: `Vault ${vaultId} not found` };
    }

    await this.vaultRepository.update(vaultId, { manual_distribution_mode: true });

    return {
      success: true,
      message: `Manual distribution mode enabled for vault ${vaultId}`,
      vaultId,
    };
  }

  /**
   * Disable manual distribution mode
   */
  @Post('vault/:vaultId/disable-manual-mode')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Disable manual distribution mode',
    description: 'Disable manual mode and resume automatic distribution',
  })
  async disableManualMode(@Param('vaultId') vaultId: string): Promise<any> {
    this.logger.log(`Disabling manual distribution mode for vault ${vaultId}`);

    await this.vaultRepository.update(vaultId, { manual_distribution_mode: false });

    return {
      success: true,
      message: `Manual distribution mode disabled for vault ${vaultId}. Automatic distribution will resume.`,
      vaultId,
    };
  }

  /**
   * STEP 2: Get all pending claims for a vault
   */
  @Get('vault/:vaultId/pending-claims')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get all pending claims',
    description: 'List all pending claims for a vault that need processing',
  })
  async getPendingClaims(@Param('vaultId') vaultId: string): Promise<any> {
    this.logger.log(`Getting pending claims for vault ${vaultId}`);

    const claims = await this.claimRepository.find({
      where: {
        vault_id: vaultId,
        status: ClaimStatus.PENDING,
        type: ClaimType.CONTRIBUTOR,
      },
      relations: ['transaction', 'transaction.assets', 'user'],
      order: { created_at: 'ASC' },
    });

    const claimDetails = claims.map(claim => ({
      claimId: claim.id,
      userId: claim.user?.id,
      userName: claim.user?.address,
      transactionId: claim.transaction?.id,
      contributionTxHash: claim.transaction?.tx_hash,
      distributionBatch: claim.distribution_batch,
      assetCount: claim.transaction?.assets?.length || 0,
      assets: claim.transaction?.assets?.map(asset => ({
        policyId: asset.policy_id,
        assetName: asset.name,
        assetId: asset.asset_id,
        quantity: asset.quantity,
      })),
      createdAt: claim.created_at,
    }));

    return {
      success: true,
      vaultId,
      totalPendingClaims: claims.length,
      claims: claimDetails,
    };
  }

  /**
   * STEP 3: Prepare vault update for specific claims
   *
   * This analyzes which multipliers are needed for the selected claims
   * and returns the data you need to submit a vault update.
   */
  @Post('vault/:vaultId/prepare-update-for-claims')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Prepare vault update for specific claims',
    description: 'Analyze which multipliers are needed for selected claims and prepare vault update transaction data',
  })
  async prepareVaultUpdateForClaims(
    @Param('vaultId') vaultId: string,
    @Body() body: { claimIds: string[] }
  ): Promise<any> {
    this.logger.log(`Preparing vault update for vault ${vaultId}, claims: ${body.claimIds.join(', ')}`);

    const analysis = await this.multiBatchService.getRequiredMultipliersForClaims(vaultId, body.claimIds);

    // Check if any multipliers are missing
    const allReady = analysis.claims.every(c => c.canProcess);

    if (allReady) {
      return {
        success: true,
        ready: true,
        message: '✅ All selected claims can be processed immediately. No vault update needed.',
        vaultId,
        claimIds: body.claimIds,
        analysis,
      };
    }

    return {
      success: true,
      ready: false,
      message: `⚠️ Vault update required. ${analysis.requiredMultipliers.length} multiplier(s) need to be added.`,
      vaultId,
      claimIds: body.claimIds,
      multipliersToAdd: analysis.requiredMultipliers,
      adaDistributionToAdd: [], // Can be calculated if needed
      analysis,
      nextStep: 'Call POST /vault/:vaultId/submit-update-for-claims with the multipliers',
    };
  }

  /**
   * STEP 4: Submit vault update with multipliers for specific claims
   *
   * This actually submits the on-chain transaction to update the vault.
   */
  @Post('vault/:vaultId/submit-update-for-claims')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit vault update for specific claims',
    description: 'Submit on-chain transaction to add multipliers for selected claims',
  })
  async submitVaultUpdateForClaims(
    @Param('vaultId') vaultId: string,
    @Body()
    body: {
      claimIds: string[];
      multipliers?: Array<[string, string | null, number]>;
      adaDistribution?: Array<[string, string, number]>;
    }
  ): Promise<any> {
    this.logger.log(`Submitting vault update for vault ${vaultId}, claims: ${body.claimIds.join(', ')}`);

    // If multipliers not provided, calculate them from claims
    let multipliers = body.multipliers;
    const adaDistribution = body.adaDistribution || [];

    if (!multipliers || multipliers.length === 0) {
      const analysis = await this.multiBatchService.getRequiredMultipliersForClaims(vaultId, body.claimIds);
      multipliers = analysis.requiredMultipliers;
      this.logger.log(`Auto-calculated ${multipliers.length} multipliers from claims`);
    }

    if (multipliers.length === 0) {
      return {
        success: false,
        message: 'No multipliers to add. Claims might already be ready for processing.',
        vaultId,
      };
    }

    // Submit the vault update
    const result = await this.multiBatchService.manuallyUpdateVaultMultipliers(
      vaultId,
      multipliers,
      adaDistribution,
      `Manual update for claims: ${body.claimIds.join(', ')}`
    );

    // Update the distribution_batch on these claims if needed
    await this.claimRepository.update(
      { id: In(body.claimIds) },
      { distribution_batch: 1 } // Mark as batch 1 since we're manually controlling
    );

    return {
      success: true,
      message: result.message,
      txHash: result.txHash,
      vaultId,
      claimIds: body.claimIds,
      multipliersAdded: multipliers.length,
      totalOnChainMultipliers: result.newMultiplierCount,
      nextStep: 'Wait for transaction to confirm, then call POST /vault/:vaultId/process-claims',
    };
  }

  /**
   * STEP 5: Process specific contribution claims using buildPaymentInput
   *
   * This builds and submits a claim payment transaction for specific contributor claims.
   * Uses buildPaymentInput directly for full control over the transaction building process.
   *
   * The vault must have last_update_tx_hash set from a previous vault update.
   * Only process claims whose multipliers were just added via submit-update-for-claims.
   */
  @Post('vault/:vaultId/process-claims')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Process specific contribution claims manually',
    description:
      'Build and submit claim payment transaction for specific contributor claims (mints VT, burns receipts).',
  })
  async processClaims(@Param('vaultId') vaultId: string, @Body() body: { claimIds: string[] }): Promise<any> {
    this.logger.log(`Processing ${body.claimIds.length} specific claims for vault ${vaultId}`);

    if (!body.claimIds || body.claimIds.length === 0) {
      return {
        success: false,
        message: 'Please provide at least one claim ID to process',
      };
    }

    const vault = await this.vaultRepository.findOne({ where: { id: vaultId } });
    if (!vault) {
      return { success: false, message: `Vault ${vaultId} not found` };
    }

    if (!vault.last_update_tx_hash) {
      return {
        success: false,
        message: 'Vault has no last_update_tx_hash. Please submit a vault update first.',
      };
    }

    // Get admin config from environment
    const adminAddress = process.env.ADMIN_ADDRESS;
    const adminHash = process.env.ADMIN_KEY_HASH;
    const adminSKey = process.env.ADMIN_S_KEY;
    const unparametizedDispatchHash = process.env.DISPATCH_SCRIPT_HASH;
    const networkId = Number(process.env.NETWORK_ID) || 0;

    if (!adminAddress || !adminHash || !adminSKey || !unparametizedDispatchHash) {
      return {
        success: false,
        message: 'Missing admin configuration in environment variables',
      };
    }

    try {
      // Get only the specific claims requested by ID
      const claims = await this.claimRepository.find({
        where: {
          id: In(body.claimIds),
          vault_id: vaultId,
          type: ClaimType.CONTRIBUTOR,
        },
        relations: ['transaction', 'transaction.assets', 'user'],
        order: { created_at: 'ASC' },
      });

      if (claims.length === 0) {
        return {
          success: false,
          message: 'No claims found with the provided IDs for this vault',
        };
      }

      if (claims.length !== body.claimIds.length) {
        const foundIds = claims.map(c => c.id);
        const missingIds = body.claimIds.filter(id => !foundIds.includes(id));
        this.logger.warn(`Some claim IDs not found: ${missingIds.join(', ')}`);
      }

      this.logger.log(`Found ${claims.length} claims to process: ${claims.map(c => c.id).join(', ')}`);

      // Get admin UTXOs
      const { utxos: adminUtxos } = await getUtxosExtract(Address.from_bech32(adminAddress), this.blockfrost, {
        minAda: 4_000_000,
      });

      if (adminUtxos.length === 0) {
        return {
          success: false,
          message: 'No admin UTXOs available with sufficient ADA',
        };
      }

      // Get dispatch UTXOs only if vault has tokens for acquirers (ADA distribution)
      const hasDispatchFunding = Number(vault.tokens_for_acquires) > 0;
      let dispatchUtxos: AddressesUtxo[] = [];

      if (hasDispatchFunding) {
        this.logger.log('Vault has tokens for acquirers, fetching dispatch UTXOs...');
        const dispatchAddress = getAddressFromHash(vault.dispatch_parametized_hash, networkId);
        const dispatchAddressUtxos = await this.blockfrost.addressesUtxos(dispatchAddress);
        dispatchUtxos = dispatchAddressUtxos
          .filter(utxo => {
            const lovelaceAmount = utxo.amount.find(a => a.unit === 'lovelace');
            return lovelaceAmount && BigInt(lovelaceAmount.quantity) >= BigInt(2_000_000);
          })
          .map(utxo => ({
            address: dispatchAddress,
            tx_hash: utxo.tx_hash,
            tx_index: utxo.tx_index,
            output_index: utxo.output_index,
            amount: utxo.amount,
            block: utxo.block,
            data_hash: utxo.data_hash,
            inline_datum: utxo.inline_datum,
            reference_script_hash: utxo.reference_script_hash,
          }));

        if (dispatchUtxos.length === 0) {
          return {
            success: false,
            message: 'No dispatch UTXOs found with sufficient ADA (>= 2 ADA)',
          };
        }
      } else {
        this.logger.log(
          'Vault has 0% for acquirers. No dispatch funding required, processing vault token minting only.'
        );
      }

      this.logger.log(
        `Building payment transaction: ${claims.length} claims, ${adminUtxos.length} admin UTXOs, ${dispatchUtxos.length} dispatch UTXOs`
      );

      // Build payment input using ContributorPaymentBuilder
      const paymentInput = await this.paymentBuilder.buildPaymentInput(vault, claims, adminUtxos, dispatchUtxos, {
        adminAddress,
        adminHash,
        unparametizedDispatchHash,
      });

      this.logger.log('Payment input built successfully, building transaction...');

      // Build the transaction
      const buildResponse = await this.blockchainService.buildTransaction(paymentInput);

      // Sign the transaction
      const txToSubmit = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
      txToSubmit.sign_and_add_vkey_signature(PrivateKey.from_bech32(adminSKey));
      const signedTxHex = txToSubmit.to_hex();

      this.logger.log('Transaction signed, submitting to blockchain...');

      // Submit the transaction
      const response = await this.blockchainService.submitTransaction({
        transaction: signedTxHex,
      });

      this.logger.log(`Transaction submitted successfully: ${response.txHash}`);

      // Create transaction record
      const batchTransaction = await this.transactionRepository.save({
        vault_id: vaultId,
        user_id: null,
        type: TransactionType.claim,
        status: TransactionStatus.pending,
        tx_hash: response.txHash,
        metadata: {
          claimIds: claims.map(c => c.id),
          manual: true,
        },
      });

      // Update all claims to PENDING status with reference to the distribution transaction
      await this.claimRepository.update(
        { id: In(claims.map(c => c.id)) },
        {
          status: ClaimStatus.PENDING,
          distribution_tx_id: batchTransaction.id,
        }
      );

      return {
        success: true,
        message: `Successfully submitted claim processing transaction for ${claims.length} claim(s)`,
        vaultId,
        txHash: response.txHash,
        transactionId: batchTransaction.id,
        claimIds: claims.map(c => c.id),
        claimCount: claims.length,
        note: 'Claims are now PENDING. They will be marked CLAIMED once the transaction is confirmed on-chain.',
      };
    } catch (error) {
      this.logger.error(`Failed to process claims:`, error);
      return {
        success: false,
        message: `Failed to process claims: ${error.message}`,
        error: error.toString(),
        stack: error.stack,
      };
    }
  }

  /**
   * Get vault distribution status
   */
  @Get('vault/:vaultId/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get vault distribution status',
    description: 'Get current distribution status and batch information',
  })
  async getVaultStatus(@Param('vaultId') vaultId: string): Promise<any> {
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      select: [
        'id',
        'name',
        'manual_distribution_mode',
        'acquire_multiplier',
        'pending_multipliers',
        'current_distribution_batch',
        'total_distribution_batches',
      ],
    });

    if (!vault) {
      return { success: false, message: `Vault ${vaultId} not found` };
    }

    const pendingClaims = await this.claimRepository.count({
      where: { vault_id: vaultId, status: ClaimStatus.PENDING, type: ClaimType.CONTRIBUTOR },
    });

    const completedClaims = await this.claimRepository.count({
      where: { vault_id: vaultId, status: ClaimStatus.CLAIMED, type: ClaimType.CONTRIBUTOR },
    });

    return {
      success: true,
      vaultId,
      vaultName: vault.name,
      manualMode: vault.manual_distribution_mode || false,
      multipliers: {
        onChain: (vault.acquire_multiplier || []).length,
        pending: (vault.pending_multipliers || []).length,
      },
      batches: {
        current: vault.current_distribution_batch || 0,
        total: vault.total_distribution_batches || 0,
      },
      claims: {
        pending: pendingClaims,
        completed: completedClaims,
        total: pendingClaims + completedClaims,
      },
    };
  }
}
