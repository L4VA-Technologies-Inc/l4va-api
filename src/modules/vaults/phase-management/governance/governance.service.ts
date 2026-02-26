import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import NodeCache from 'node-cache';
import { In, IsNull, Not, Repository } from 'typeorm';

import { BlockchainService } from '../../processing-tx/onchain/blockchain.service';

import { DistributionService } from './distribution.service';
import { CreateProposalReq, ExecType } from './dto/create-proposal.req';
import { CreateProposalRes } from './dto/create-proposal.res';
import { AssetBuySellDto } from './dto/get-assets.dto';
import { GetProposalDetailRes } from './dto/get-proposal-detail.res';
import { GetProposalsResItem } from './dto/get-proposal.dto';
import { VoteReq } from './dto/vote.req';
import { VoteRes } from './dto/vote.res';
import { GovernanceFeeService } from './governance-fee.service';
import { VoteCountingService } from './vote-counting.service';

import { Asset } from '@/database/asset.entity';
import { AssetsWhitelistEntity } from '@/database/assetsWhitelist.entity';
import { Claim } from '@/database/claim.entity';
import { Proposal } from '@/database/proposal.entity';
import { Snapshot } from '@/database/snapshot.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { Vote } from '@/database/vote.entity';
import { DexHunterPricingService } from '@/modules/dexhunter/dexhunter-pricing.service';
import { DexHunterService } from '@/modules/dexhunter/dexhunter.service';
import { AssetOriginType, AssetStatus, AssetType } from '@/types/asset.types';
import { ClaimStatus, ClaimType } from '@/types/claim.types';
import { ProposalStatus, ProposalType } from '@/types/proposal.types';
import { VaultStatus } from '@/types/vault.types';
import { VoteType } from '@/types/vote.types';

/*
        .-""""-.
       / -   -  \
      |  .-. .- |
      |  \o| |o (
      \     ^    \
       '.  )--'  /
         '-...-'`
    BLOCKCHAIN COUNCIL
    { } { } { } { } { }
     |   |   |   |   |
    /     VOTING     \
   /-------------------\
  |  YES   NO  ABSTAIN |
  |   |     |     |    |
  |  [X]   [ ]   [ ]   |
   \__________________/
      /   |   |   \
     /    |   |    \
    /     |   |     \
   /      |   |      \
  /_______|___|_______\

*/

@Injectable()
export class GovernanceService {
  private readonly logger = new Logger(GovernanceService.name);
  private blockfrost: BlockFrostAPI;
  private readonly votingPowerCache: NodeCache;
  private readonly proposalCreationCache: NodeCache;
  private readonly poolAddress: string;
  private readonly MIN_VOTING_DURATION = 86400000; // 24 hours in ms
  private readonly MAX_VOTING_DURATION = 259200000; // 3 days in ms
  private readonly MIN_LP_ADA_FOR_MARKET_PRICING = 5000;

  // private readonly snapshotCache: NodeCache;

  private readonly CACHE_TTL = {
    VOTING_POWER: 300, // 5 minutes - for general voting power checks
    CAN_CREATE_PROPOSAL: 1800, // 30 minutes - for canCreateProposal checks
    SNAPSHOT_DATA: 1800, // 30 minutes - for snapshot data
    NO_VOTING_POWER: 600, // 10 minutes - cache negative results longer to reduce spam
    PROPOSAL_DATA: 120, // 2 minutes - for proposal-specific data
  };

  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(Snapshot)
    private readonly snapshotRepository: Repository<Snapshot>,
    @InjectRepository(Proposal)
    private readonly proposalRepository: Repository<Proposal>,
    @InjectRepository(Claim)
    private readonly claimRepository: Repository<Claim>,
    @InjectRepository(Vote)
    private readonly voteRepository: Repository<Vote>,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
    @InjectRepository(AssetsWhitelistEntity)
    private readonly assetsWhitelistRepository: Repository<AssetsWhitelistEntity>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly voteCountingService: VoteCountingService,
    private readonly distributionService: DistributionService,
    private readonly governanceFeeService: GovernanceFeeService,
    private readonly dexHunterPricingService: DexHunterPricingService,
    private readonly dexHunterService: DexHunterService,
    private readonly blockchainService: BlockchainService
  ) {
    this.poolAddress = this.configService.get<string>('POOL_ADDRESS');

    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_API_KEY'),
    });
    this.votingPowerCache = new NodeCache({
      stdTTL: this.CACHE_TTL.VOTING_POWER,
      checkperiod: 120,
      useClones: false,
    });

    this.proposalCreationCache = new NodeCache({
      stdTTL: this.CACHE_TTL.CAN_CREATE_PROPOSAL,
      checkperiod: 300,
      useClones: false,
    });
  }

  @Cron(CronExpression.EVERY_3_HOURS)
  async createDailySnapshots(): Promise<void> {
    this.logger.log('Starting daily snapshot creation');

    try {
      // Include both locked and expansion vaults for snapshot creation
      const lockedVaults = await this.vaultRepository.find({
        where: [
          {
            vault_status: VaultStatus.locked,
            asset_vault_name: Not(IsNull()),
            script_hash: Not(IsNull()),
            distribution_processed: true,
          },
          {
            vault_status: VaultStatus.expansion,
            asset_vault_name: Not(IsNull()),
            script_hash: Not(IsNull()),
            distribution_processed: true,
          },
        ],
        select: ['id', 'asset_vault_name', 'script_hash'],
      });

      if (lockedVaults.length === 0) {
        this.logger.log('No eligible vaults found for snapshot creation');
        return;
      }

      this.logger.log(`Found ${lockedVaults.length} locked/expansion vaults for snapshots`);

      const results = await Promise.allSettled(
        lockedVaults.map(async (vault, index) => {
          if (index > 0) {
            await new Promise(resolve => setTimeout(resolve, 1000)); //  Add delay between requests to avoid overwhelming BlockFrost
          }
          return await this.createAutomaticSnapshot(vault.id, `${vault.script_hash}${vault.asset_vault_name}`);
        })
      );

      const successful = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;

      this.logger.log(`Daily snapshot creation completed: ${successful} successful, ${failed} failed`);
    } catch (error) {
      this.logger.error(`Failed to create daily snapshots: ${error.message}`, error.stack);
    }
  }

  /**
   * Creates an automatic snapshot for a vault.
   * @param vaultId - The ID of the vault
   * @param assetId - Concatenation of the policy ID and hex-encoded asset name
   * @returns - List of a addresses containing a specific asset.
   */
  async createAutomaticSnapshot(vaultId: string, assetId: string): Promise<Snapshot> {
    try {
      // Fetch vault decimals for proper supply calculation
      const vault = await this.vaultRepository.findOne({
        where: { id: vaultId },
        select: ['id', 'ft_token_decimals'],
      });

      if (!vault) {
        throw new NotFoundException(`Vault ${vaultId} not found`);
      }

      // First, check if there's at least one claimed contribution or acquisition for this vault
      const claimedContributions = await this.claimRepository.count({
        where: {
          vault: { id: vaultId },
          status: ClaimStatus.CLAIMED,
          type: In([ClaimType.CONTRIBUTOR, ClaimType.ACQUIRER]),
        },
      });

      if (claimedContributions === 0) {
        throw new BadRequestException(
          `No claimed contributions or acquisitions found for vault ${vaultId}. Cannot create snapshot.`
        );
      }

      // Fetch all addresses holding the asset using BlockFrost
      const addressBalances: Record<string, string> = {}; // For snapshot (excludes LP)
      let totalSupplyRaw = BigInt(0); // Total supply INCLUDING LP tokens
      let page = 1;
      let hasMorePages = true;

      while (hasMorePages) {
        try {
          const response = await this.blockfrost.assetsAddresses(assetId, { page, order: 'desc' });

          if (response.length === 0) {
            hasMorePages = false;
          } else {
            // Process all addresses
            for (const item of response) {
              // ALWAYS add to total supply (includes LP tokens)
              totalSupplyRaw += BigInt(item.quantity);

              // Only add to snapshot if NOT pool address (exclude LP from voting power)
              if (item.address !== this.poolAddress) {
                addressBalances[item.address] = item.quantity;
              } else {
                this.logger.log(`Excluded pool address ${this.poolAddress} from snapshot (${item.quantity} VT in LP)`);
              }
            }
            page++;
          }
        } catch (error) {
          if (error.message.includes('not been found') || error.status_code === 404) {
            this.logger.warn(`Asset ${assetId} not found on blockchain. Verify policy ID and asset name are correct.`);

            if (Object.keys(addressBalances).length === 0) {
              try {
                await this.blockfrost.assetsById(assetId);
              } catch (assetError) {
                this.logger.error(`Asset ${assetId} does not exist on blockchain: ${assetError.message}`);
                throw new NotFoundException(
                  `Asset ${assetId} not found on blockchain. Check policy ID and asset name.`
                );
              }
            }
          }

          // Stop fetching more pages on any error
          hasMorePages = false;
        }
      }

      // Adjust for token decimals (divide by 10^decimals)
      const decimals = vault.ft_token_decimals || 0;
      const divisor = BigInt(10) ** BigInt(decimals);
      const adjustedSupply = Number(totalSupplyRaw / divisor);

      // Update vault supply with TOTAL supply (including LP tokens)
      await this.vaultRepository.update(vaultId, {
        ft_token_supply: adjustedSupply,
      });

      this.logger.log(
        `Updated vault ${vaultId} total supply: ${adjustedSupply.toLocaleString()} tokens (raw: ${totalSupplyRaw.toLocaleString()}, decimals: ${decimals}). ` +
          `Snapshot created for ${Object.keys(addressBalances).length} addresses (LP tokens excluded from voting power)`
      );

      // Create and save the snapshot (addressBalances excludes LP for voting power calculation)
      const snapshot = this.snapshotRepository.create({
        vaultId,
        assetId,
        addressBalances,
      });

      await this.snapshotRepository.save(snapshot);

      this.logger.log(
        `Automatic snapshot created for vault ${vaultId} with ${Object.keys(addressBalances).length} voting addresses`
      );

      return snapshot;
    } catch (error) {
      this.logger.error(`Failed to create automatic snapshot: ${error.message}`, error.stack);
      throw error;
    }
  }

  async createProposal(
    vaultId: string,
    createProposalReq: CreateProposalReq,
    userId: string
  ): Promise<CreateProposalRes> {
    const vault: Pick<Vault, 'id' | 'vault_status' | 'policy_id' | 'asset_vault_name' | 'name'> =
      await this.vaultRepository.findOne({
        where: { id: vaultId },
        select: ['id', 'vault_status', 'policy_id', 'asset_vault_name', 'name'],
      });

    if (!vault) {
      throw new NotFoundException('Vault not found');
    }

    // Allow governance for both locked and expansion statuses
    // Expansion windows can be long/indefinite, so governance should continue
    if (vault.vault_status !== VaultStatus.locked && vault.vault_status !== VaultStatus.expansion) {
      throw new BadRequestException('Governance is only available for locked or expansion vaults');
    }

    // During expansion, only Distribution proposals are allowed
    // All other proposal types involve extracting assets from vault which conflicts with expansion
    if (vault.vault_status === VaultStatus.expansion) {
      if (createProposalReq.type !== ProposalType.DISTRIBUTION) {
        throw new BadRequestException(
          'During vault expansion, only Distribution proposals are allowed. ' +
            'Proposals that extract assets (Marketplace Actions, Burning, Termination, or new Expansions) must wait until the current expansion completes.'
        );
      }
    }

    const latestSnapshot = await this.snapshotRepository.findOne({ where: { vaultId }, order: { createdAt: 'DESC' } });

    // Get user early as we'll need their address for potential fee transaction
    const user = await this.userRepository.findOneBy({ id: userId });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    await this.getVotingPower(vaultId, userId, 'create_proposal');

    if (createProposalReq.duration < this.MIN_VOTING_DURATION) {
      throw new BadRequestException(
        `Voting duration must be at least 24 hours (${this.MIN_VOTING_DURATION}ms). Provided: ${createProposalReq.duration}ms`
      );
    }

    if (createProposalReq.duration > this.MAX_VOTING_DURATION) {
      throw new BadRequestException(
        `Voting duration cannot exceed 3 days (${this.MAX_VOTING_DURATION}ms). Provided: ${createProposalReq.duration}ms`
      );
    }

    // ===== PROPOSAL TYPE SPECIFIC CONSTRAINTS =====
    const startDate = new Date(createProposalReq.startDate ?? createProposalReq.proposalStart);

    // Check for only 1 active expansion proposal at a time
    if (createProposalReq.type === ProposalType.EXPANSION) {
      const activeExpansionProposal = await this.proposalRepository.findOne({
        where: {
          vaultId,
          proposalType: ProposalType.EXPANSION,
          status: In([ProposalStatus.ACTIVE, ProposalStatus.UPCOMING]),
        },
      });

      if (activeExpansionProposal) {
        throw new BadRequestException(
          `Only one expansion proposal can be active at a time. ` +
            `Please wait for the current expansion proposal "${activeExpansionProposal.title}" to complete before creating a new one.`
        );
      }
    }

    // Check for only 1 active market action proposal for the same asset at a time
    if (createProposalReq.type === ProposalType.MARKETPLACE_ACTION) {
      const requestedActions = createProposalReq.marketplaceActions || [];
      const requestedAssetIds = requestedActions.map(action => action.assetId);

      // Find all active/upcoming marketplace action proposals for this vault
      const activeMarketProposals = await this.proposalRepository.find({
        where: {
          vaultId,
          proposalType: ProposalType.MARKETPLACE_ACTION,
          status: In([ProposalStatus.ACTIVE, ProposalStatus.UPCOMING]),
        },
      });

      // Check if any of the requested assets are already in an active proposal
      for (const existingProposal of activeMarketProposals) {
        const existingActions = existingProposal.metadata?.marketplaceActions || [];
        const existingAssetIds = existingActions.map((action: any) => action.assetId);

        // Check for overlap
        const overlappingAssets = requestedAssetIds.filter(assetId => existingAssetIds.includes(assetId));

        if (overlappingAssets.length > 0) {
          // Get asset names for better error message
          const overlappingAssetRecords = await this.assetRepository.find({
            where: { id: In(overlappingAssets) },
            select: ['id', 'name'],
          });

          const assetNames = overlappingAssetRecords.map(a => a.name || a.id).join(', ');

          throw new BadRequestException(
            `Cannot create market action proposal. The following assets are already in an active proposal "${existingProposal.title}": ${assetNames}. ` +
              `Please wait for that proposal to complete before creating a new one for these assets.`
          );
        }
      }
    }

    // Create the proposal with the appropriate fields based on type
    const proposal = this.proposalRepository.create({
      vaultId,
      title: createProposalReq.title,
      description: createProposalReq.description,
      proposalType: createProposalReq.type,
      status: startDate <= new Date() ? ProposalStatus.ACTIVE : ProposalStatus.UPCOMING,
      startDate,
      endDate: new Date(startDate.getTime() + createProposalReq.duration),
      creatorId: userId,
      snapshotId: latestSnapshot.id,
    });

    // Initialize metadata object
    proposal.metadata = {};

    // Set type-specific fields based on proposal type
    switch (createProposalReq.type) {
      case ProposalType.STAKING:
        proposal.metadata.fungibleTokens = createProposalReq.fts || [];
        proposal.metadata.nonFungibleTokens = createProposalReq.nfts || [];
        break;

      case ProposalType.DISTRIBUTION: {
        const lovelaceAmount = createProposalReq.distributionLovelaceAmount;

        if (!lovelaceAmount || lovelaceAmount <= 0) {
          throw new BadRequestException('Distribution lovelace amount is required and must be greater than 0');
        }

        // Validate distribution using DistributionService
        const validation = await this.distributionService.validateDistribution(vaultId, lovelaceAmount.toString());

        if (!validation.valid) {
          throw new BadRequestException(validation.errors.join('; '));
        }

        // Store the lovelace amount in metadata
        proposal.metadata.distributionLovelaceAmount = lovelaceAmount.toString();
        break;
      }

      case ProposalType.TERMINATION:
        if (createProposalReq.metadata) {
          proposal.terminationDate = createProposalReq.metadata.terminationDate
            ? new Date(createProposalReq.metadata.terminationDate)
            : undefined;
        }
        break;

      case ProposalType.BURNING:
        if (createProposalReq.metadata) {
          proposal.metadata.burnAssets = createProposalReq.metadata.burnAssets || [];
        }
        break;

      case ProposalType.BUY_SELL: // Deprecated - use MARKETPLACE_ACTION instead
        if (createProposalReq.metadata) {
          // Prefer the canonical `marketplaceActions` field if present, otherwise fall back to
          // the legacy `buyingSellingOptions` field for backward compatibility.
          proposal.metadata.marketplaceActions =
            createProposalReq.metadata.marketplaceActions ?? createProposalReq.metadata.buyingSellingOptions ?? [];
          proposal.abstain = createProposalReq.metadata.abstain || false;

          for (const option of proposal.metadata.marketplaceActions) {
            const asset = await this.assetRepository.findOne({
              where: { id: option.assetId },
            });

            if (!asset) {
              throw new BadRequestException(`Asset with ID ${option.assetId} not found`);
            }
          }
        }
        break;

      case ProposalType.MARKETPLACE_ACTION: {
        // Use direct marketplaceActions from request body
        const actions = createProposalReq.marketplaceActions || [];

        // Validate that all actions use the same market (no mixing DexHunter and WayUp)
        const markets = new Set(actions.map(a => a.market));
        if (markets.size > 1) {
          throw new BadRequestException(
            'Cannot mix different markets in same proposal. Use either DexHunter or WayUp, not both.'
          );
        }

        const market = actions[0]?.market;

        // For DexHunter, fetch all assets and aggregate by token to allow multi-asset swaps
        const assetsByToken = new Map<
          string,
          Array<Pick<Asset, 'id' | 'status' | 'type' | 'policy_id' | 'asset_id' | 'quantity' | 'name'>>
        >();

        if (market === 'DexHunter') {
          // Fetch all swappable FT assets (LOCKED in vault + EXTRACTED in treasury)
          const allFTs = await this.assetRepository.find({
            where: {
              vault: { id: vaultId },
              type: AssetType.FT,
              status: In([AssetStatus.LOCKED, AssetStatus.EXTRACTED]),
            },
            select: ['id', 'status', 'type', 'policy_id', 'asset_id', 'quantity', 'name'],
          });

          // Group assets by token (policy_id + asset_id)
          allFTs.forEach(asset => {
            const tokenKey = asset.policy_id + asset.asset_id;
            if (!assetsByToken.has(tokenKey)) {
              assetsByToken.set(tokenKey, []);
            }
            assetsByToken.get(tokenKey).push(asset);
          });
        }

        // Validate all assets exist and handle market-specific validation
        await Promise.all(
          actions.map(async action => {
            const asset: Pick<Asset, 'id' | 'status' | 'type' | 'policy_id' | 'asset_id' | 'quantity' | 'name'> =
              await this.assetRepository.findOne({
                where: { id: action.assetId },
                select: ['id', 'status', 'type', 'policy_id', 'asset_id', 'quantity', 'name'],
              });

            if (!asset) {
              throw new BadRequestException(`Asset with ID ${action.assetId} not found`);
            }

            // DexHunter swap validation (FT tokens only)
            if (market === 'DexHunter') {
              // Validate it's a fungible token
              if (asset.type !== AssetType.FT) {
                throw new BadRequestException(
                  `DexHunter swaps only support fungible tokens. Asset ${action.assetId} is not an FT.`
                );
              }

              // Validate quantity against TOTAL available across all assets of this token
              const swapQuantity = parseFloat(action.quantity || '0');
              const tokenKey = asset.policy_id + asset.asset_id;
              const allTokenAssets = assetsByToken.get(tokenKey) || [];
              const totalAvailable = allTokenAssets.reduce((sum, a) => sum + a.quantity, 0);

              if (swapQuantity <= 0 || swapQuantity > totalAvailable) {
                throw new BadRequestException(
                  `Invalid swap quantity for ${asset.name || 'token'}. Requested: ${swapQuantity}, Available across all assets: ${totalAvailable}.`
                );
              }

              // Validate that swap quantity is a valid combination of individual asset quantities
              // This ensures we can swap complete asset entries (no partial swaps within an asset)
              const individualQuantities = allTokenAssets.map(a => a.quantity);
              const isValidCombination = this.isValidQuantityCombination(swapQuantity, individualQuantities);

              if (!isValidCombination) {
                throw new BadRequestException(
                  `Invalid swap quantity for ${asset.name || 'token'}. ` +
                    `Amount ${swapQuantity} is not a valid combination of available asset quantities. ` +
                    `Available individual amounts: [${individualQuantities.join(', ')}]. ` +
                    `Please select a quantity that equals a sum of one or more of these amounts.`
                );
              }

              // Validate slippage
              const slippage = action.slippage || 0.5;
              if (slippage < 0.5 || slippage > 5) {
                throw new BadRequestException(`Slippage must be between 0.5% and 5%. Got ${slippage}%`);
              }

              // Validate that swap pool exists and amount is sufficient by calling estimate endpoint
              try {
                const tokenId = asset.policy_id + asset.asset_id;
                await this.dexHunterService.estimateSwap({
                  tokenIn: tokenId,
                  tokenOut: 'ADA',
                  amountIn: swapQuantity,
                  slippage,
                });
                this.logger.log(`Swap pool verified for ${action.assetId} with quantity ${swapQuantity}`);
              } catch (error) {
                // Check if error is pool not found - could be no pool OR amount too low
                if (error.message?.includes('pool_not_found') || error.message?.includes('not found')) {
                  // Try with a high amount (1M tokens) to distinguish between "no pool" and "amount too low"
                  // This amount is high enough to exceed most minimums but reasonable for most pools
                  try {
                    const tokenId = asset.policy_id + asset.asset_id;
                    const testAmount = Math.min(1_000_000, asset.quantity); // Use 1M or available quantity, whichever is smaller
                    await this.dexHunterService.estimateSwap({
                      tokenIn: tokenId,
                      tokenOut: 'ADA',
                      amountIn: testAmount,
                      slippage,
                    });
                    // If higher amount works, the issue is insufficient swap amount
                    throw new BadRequestException(
                      `Swap amount too low for token ${asset.policy_id}${asset.asset_id}. ` +
                        `Quantity ${swapQuantity} is below the minimum liquidity threshold. ` +
                        `Try using the maximum available amount (${asset.quantity}) or check DexHunter for minimum swap requirements.`
                    );
                  } catch (maxError) {
                    // If higher amount also fails, pool genuinely doesn't exist
                    if (maxError instanceof BadRequestException) {
                      throw maxError; // Re-throw our custom error
                    }
                    throw new BadRequestException(
                      `No liquidity pool available for token ${asset.policy_id}${asset.asset_id}. ` +
                        `This token cannot be swapped via DexHunter.`
                    );
                  }
                }
                // Re-throw other errors
                throw new BadRequestException(`Failed to validate swap for ${action.assetId}: ${error.message}`);
              }

              // Validate custom price if not using market price
              if (action.useMarketPrice === false) {
                const customPrice = action.customPriceAda;
                if (!customPrice || customPrice <= 0) {
                  throw new BadRequestException(
                    `Custom price must be greater than 0 when not using market price. Got ${customPrice}`
                  );
                }
              }
            }
            // WayUp marketplace validation (NFTs)
            else if (market === 'WayUp') {
              // Validate price is provided for SELL (LIST) actions
              if (action.exec === ExecType.SELL) {
                // For List sellType, price is REQUIRED
                // For Market sellType, price is optional (will use floor price if not provided)
                if (action.sellType === 'List') {
                  const price = parseFloat(action.price || '0');
                  if (!action.price || isNaN(price) || price <= 0) {
                    throw new BadRequestException(
                      `Price is required for List sellType on asset ${action.assetId}. Please provide a valid price in ADA.`
                    );
                  }
                  if (price < 5) {
                    throw new BadRequestException(
                      `Minimum listing price is 5 ADA. Asset ${action.assetId} has price ${price} ADA.`
                    );
                  }
                } else if (action.sellType === 'Market') {
                  // Market sellType allows no price (uses floor price) or custom price
                  if (action.price) {
                    const price = parseFloat(action.price);
                    if (isNaN(price) || price <= 0) {
                      throw new BadRequestException(
                        `Invalid price for Market sellType on asset ${action.assetId}. Price must be a positive number.`
                      );
                    }
                    if (price < 5) {
                      throw new BadRequestException(
                        `Minimum listing price is 5 ADA. Asset ${action.assetId} has price ${price} ADA.`
                      );
                    }
                  }
                  // If no price provided for Market, it will use floor price at execution
                }
              }

              // Validate new price is provided for UPDATE_LISTING actions
              if (action.exec === ExecType.UPDATE_LISTING) {
                const newPrice = parseFloat(action.newPrice || '0');
                if (!action.newPrice || isNaN(newPrice) || newPrice <= 0) {
                  throw new BadRequestException(
                    `New price is required for updating listing of asset ${action.assetId}. Please provide a valid new price in ADA.`
                  );
                }
                if (newPrice < 5) {
                  throw new BadRequestException(
                    `Minimum listing price is 5 ADA. Asset ${action.assetId} has new price ${newPrice} ADA.`
                  );
                }
              }

              // For UNLIST and UPDATE_LISTING, verify asset is currently listed
              if (action.exec === ExecType.UNLIST || action.exec === ExecType.UPDATE_LISTING) {
                if (asset.status !== 'listed') {
                  throw new BadRequestException(`Asset ${action.assetId} is not currently listed`);
                }
              }
            }
          })
        );

        // For DexHunter swaps, resolve specific asset IDs needed for each action
        if (market === 'DexHunter') {
          for (const action of actions) {
            const asset = await this.assetRepository.findOne({
              where: { id: action.assetId },
              select: ['id', 'policy_id', 'asset_id', 'quantity'],
            });

            // Get all assets for this token type
            const tokenKey = asset.policy_id + asset.asset_id;
            const allTokenAssets = assetsByToken.get(tokenKey) || [];

            // Sort by quantity descending (largest first) for greedy algorithm
            const sorted = [...allTokenAssets].sort((a, b) => b.quantity - a.quantity);

            // Resolve which specific assets to use
            const swapQuantity = parseFloat(action.quantity);
            const resolvedAssets = [];
            let remaining = swapQuantity;

            for (const record of sorted) {
              if (remaining <= 0) break;

              const takeAmount = Math.min(record.quantity, remaining);
              resolvedAssets.push({
                assetId: record.id,
                quantity: takeAmount,
              });
              remaining -= takeAmount;
            }

            // Store resolved assets in action metadata
            action.resolvedAssets = resolvedAssets;

            this.logger.log(
              `Resolved ${resolvedAssets.length} asset records for swap of ${swapQuantity} ${asset.policy_id}${asset.asset_id}`
            );
          }
        }

        // Store only the action data, asset details will be fetched in getProposal
        proposal.metadata.marketplaceActions = actions;

        break;
      }

      case ProposalType.EXPANSION: {
        // Validate expansion fields
        const {
          expansionPolicyIds,
          expansionDuration,
          expansionNoLimit,
          expansionAssetMax,
          expansionNoMax,
          expansionPriceType,
          expansionLimitPrice,
        } = createProposalReq;

        if (!expansionPolicyIds || expansionPolicyIds.length === 0) {
          throw new BadRequestException('At least one policy ID must be selected for expansion');
        }

        const policyIdStrings = expansionPolicyIds.map(p => p.policyId);
        const policyLabels = expansionPolicyIds.map(p => p.label ?? p.policyId);

        // Validate policy IDs are whitelisted for this vault
        const whitelistedPolicies = await this.assetsWhitelistRepository.find({
          where: { vault: { id: vaultId } },
        });

        const whitelistedPolicyIds = whitelistedPolicies.map(w => w.policy_id);

        for (const policyId of policyIdStrings) {
          if (!whitelistedPolicyIds.includes(policyId)) {
            throw new BadRequestException(`Policy ID ${policyId} is not whitelisted for this vault`);
          }
        }

        // Validate that at least one limit is set (cannot have both noLimit and noMax true)
        if (expansionNoLimit && expansionNoMax) {
          throw new BadRequestException(
            'At least one limit must be specified. You cannot have both "No Duration Limit" and "No Asset Max" enabled simultaneously.'
          );
        }

        // Validate duration if no limit is not set
        if (!expansionNoLimit && (!expansionDuration || expansionDuration <= 0)) {
          throw new BadRequestException('Expansion duration is required when "No Limit" is not selected');
        }

        // Validate asset max if no max is not set
        if (!expansionNoMax && (!expansionAssetMax || expansionAssetMax <= 0)) {
          throw new BadRequestException('Asset max is required when "No Max" is not selected');
        }

        // Validate price type
        if (!expansionPriceType || !['limit', 'market'].includes(expansionPriceType)) {
          throw new BadRequestException('Price type must be either "limit" or "market"');
        }

        // Validate limit price if using limit pricing
        if (expansionPriceType === 'limit') {
          if (!expansionLimitPrice || expansionLimitPrice <= 0) {
            throw new BadRequestException('Limit price is required when using limit pricing');
          }
        }

        // Validate market pricing requirements
        if (expansionPriceType === 'market') {
          // Check if vault has FT token configured (required for market pricing)
          const vaultForLpCheck = await this.vaultRepository.findOne({
            where: { id: vaultId },
            select: ['policy_id', 'asset_vault_name', 'name'],
          });

          if (!vaultForLpCheck.policy_id || !vaultForLpCheck.asset_vault_name) {
            throw new BadRequestException(
              'Market pricing requires vault token configuration. Vault must have a policy_id and asset_vault_name.'
            );
          }

          try {
            const liquidityCheck = await this.dexHunterPricingService.checkTokenLiquidity(
              `${vaultForLpCheck.policy_id}${vaultForLpCheck.asset_vault_name}`
            );

            if (!liquidityCheck || !liquidityCheck.hasLiquidity) {
              throw new BadRequestException(
                'Market pricing requires an active Liquidity Pool. ' +
                  'No LP found on any DEX (checked MinSwap, VyFi, SundaeSwap, Spectrum). ' +
                  'Please use limit pricing or create an LP first.'
              );
            }

            if (liquidityCheck.totalAdaLiquidity < this.MIN_LP_ADA_FOR_MARKET_PRICING) {
              const dexList = liquidityCheck.pools.map(p => `${p.dex} (${p.adaAmount.toFixed(2)} ADA)`).join(', ');
              throw new BadRequestException(
                `Market pricing requires LP TVL of at least ${this.MIN_LP_ADA_FOR_MARKET_PRICING.toLocaleString()} ADA across all DEXes. ` +
                  `Current total LP TVL: ${liquidityCheck.totalAdaLiquidity.toFixed(2)} ADA. ` +
                  `Found on: ${dexList}. ` +
                  'Please use limit pricing or wait for LP to accumulate more liquidity.'
              );
            }

            // Log success with DEX details
            const dexList = liquidityCheck.pools.map(p => p.dex).join(', ');
            this.logger.log(
              `Expansion proposal validated: Vault ${vaultForLpCheck.name} has active LP on ${liquidityCheck.pools.length} DEX(es): ${dexList}. ` +
                `Total TVL: ${liquidityCheck.totalAdaLiquidity.toFixed(2)} ADA`
            );
          } catch (error) {
            // If it's already a BadRequestException, re-throw it
            if (error instanceof BadRequestException) {
              throw error;
            }
            // For other errors (API failures, etc), log and throw a user-friendly error
            this.logger.error(`Error checking LP status for expansion proposal: ${error.message}`, error.stack);
            throw new BadRequestException(
              'Unable to verify Liquidity Pool status. Please try again later or contact support.'
            );
          }
        }

        // Store expansion config in metadata
        proposal.metadata.expansion = {
          policyIds: policyIdStrings,
          labels: policyLabels,
          duration: expansionNoLimit ? undefined : expansionDuration,
          noLimit: expansionNoLimit || false,
          assetMax: expansionNoMax ? undefined : expansionAssetMax,
          noMax: expansionNoMax || false,
          priceType: expansionPriceType,
          limitPrice: expansionPriceType === 'limit' ? expansionLimitPrice : undefined,
          currentAssetCount: 0,
        };

        break;
      }
    }

    // Check if governance fee is required for this proposal type
    const feeAmount = this.governanceFeeService.getProposalFee(createProposalReq.type);
    const requiresPayment = feeAmount > 0;

    // If payment is required, set status to UNPAID and clear dates
    // Store original duration and start date in metadata so we can set correct dates after payment
    if (requiresPayment) {
      proposal.status = ProposalStatus.UNPAID;
      proposal.metadata._pendingPayment = {
        duration: createProposalReq.duration,
        originalStartDate: startDate.toISOString(),
        feeAmount,
      };
      proposal.startDate = null;
      proposal.endDate = null;
    }

    await this.proposalRepository.save(proposal);

    // Fetch contributor claims early (needed for both fee and non-fee proposals)
    const finalContributorClaims = await this.claimRepository.find({
      where: {
        vault: { id: vault.id },
        type: ClaimType.CONTRIBUTOR,
      },
      relations: ['transaction', 'transaction.assets'],
      order: { created_at: 'ASC' },
    });

    // If payment is required, build fee transaction BEFORE emitting events
    // This ensures we don't notify users of proposals that fail to create
    if (requiresPayment) {
      try {
        const feeTransaction = await this.governanceFeeService.buildProposalFeeTransaction({
          userAddress: user.address,
          proposalType: createProposalReq.type,
          vaultId,
        });

        // Transaction built successfully - now emit events for UNPAID proposal
        this.eventEmitter.emit('proposal.created', {
          proposalId: proposal.id,
          startDate: proposal.startDate,
          endDate: proposal.endDate,
          status: proposal.status,
        });

        this.eventEmitter.emit('governance.proposal_created', {
          address: user.address,
          vaultId: vault.id,
          vaultName: vault.name,
          proposalName: proposal.title,
          creatorId: proposal.creatorId,
        });

        return {
          success: true,
          message: 'Proposal created. Please complete payment to activate.',
          proposal: {
            id: proposal.id,
            vaultId,
            title: proposal.title,
            description: proposal.description,
            creatorId: userId,
            status: proposal.status,
            createdAt: proposal.createdAt,
            endDate: proposal.endDate,
          },
          requiresPayment: true,
          presignedTx: feeTransaction.presignedTx,
          feeAmount: feeTransaction.feeAmount,
        };
      } catch (error) {
        // If fee transaction build fails, delete the proposal and throw error
        await this.proposalRepository.remove(proposal);
        this.logger.error(`Failed to build governance fee transaction: ${error.message}`, error.stack);
        throw new InternalServerErrorException(`Failed to build governance fee transaction: ${error.message}`);
      }
    }

    // No payment required - emit proposal.created and proposal.started events
    this.eventEmitter.emit('proposal.created', {
      proposalId: proposal.id,
      startDate: proposal.startDate,
      endDate: proposal.endDate,
      status: proposal.status,
    });

    this.eventEmitter.emit('governance.proposal_created', {
      address: user.address,
      vaultId: vault.id,
      vaultName: vault.name,
      proposalName: proposal.title,
      creatorId: proposal.creatorId,
    });

    // No payment required - emit proposal.started event
    this.eventEmitter.emit('proposal.started', {
      address: user.address,
      vaultId: vault.id,
      vaultName: vault.name,
      proposalName: proposal.title,
      creatorId: proposal.creatorId,
      tokenHolderIds: [...new Set(finalContributorClaims.map(c => c.user_id))],
    });

    return {
      success: true,
      message: 'Proposal created successfully',
      proposal: {
        id: proposal.id,
        vaultId,
        title: proposal.title,
        description: proposal.description,
        creatorId: userId,
        status: proposal.status,
        createdAt: proposal.createdAt,
        endDate: proposal.endDate,
      },
    };
  }

  async getProposals(vaultId: string): Promise<GetProposalsResItem[]> {
    const vaultExists = await this.vaultRepository.exists({
      where: { id: vaultId },
    });

    if (!vaultExists) {
      throw new NotFoundException('Vault not found');
    }

    // Exclude UNPAID proposals from public list (they're awaiting payment)
    const proposals = await this.proposalRepository.find({
      where: {
        vaultId,
        status: Not(ProposalStatus.UNPAID),
      },
      order: { createdAt: 'DESC' },
    });

    // Process each proposal to add vote information
    return await Promise.all(
      proposals.map(async proposal => {
        const baseProposal = {
          id: proposal.id,
          title: proposal.title,
          description: proposal.description,
          creatorId: proposal.creatorId,
          status: proposal.status,
          createdAt: proposal.createdAt,
          startDate: proposal.startDate ? proposal.startDate.toISOString() : null,
          endDate: proposal.endDate ? proposal.endDate.toISOString() : null,
          abstain: proposal.abstain,
          executionError: proposal.metadata?.executionError?.userFriendlyMessage
            ? proposal.metadata.executionError.userFriendlyMessage
            : proposal.metadata?.executionError?.message,
        };

        if (proposal.status === ProposalStatus.UPCOMING) {
          return baseProposal;
        }

        try {
          const { votes: voteList, totals } = await this.getVotes(proposal.id);
          const voteResult = this.voteCountingService.calculateResult(voteList, 0, 0, BigInt(totals.totalVotingPower));

          return {
            ...baseProposal,
            votes: {
              yes: voteResult.yesVotePercent,
              no: voteResult.noVotePercent,
              abstain: proposal.abstain ? voteResult.abstainVotePercent : 0,
            },
          };
        } catch (error) {
          this.logger.error(`Error fetching votes for proposal ${proposal.id}: ${error.message}`, error.stack);
          return baseProposal;
        }
      })
    );
  }

  async getProposal(proposalId: string, userId: string): Promise<GetProposalDetailRes> {
    const proposal = await this.proposalRepository.findOne({
      where: { id: proposalId },
      relations: ['vault', 'snapshot'],
      select: {
        vault: {
          id: true,
          name: true,
          vault_token_ticker: true,
          vault_status: true,
          termination_type: true,
          termination_metadata: true,
        },
      },
    });

    if (!proposal) {
      throw new NotFoundException('Proposal not found');
    }

    // Parallelize independent queries for better performance
    const [user, proposer, { votes, totals }] = await Promise.all([
      this.userRepository.findOne({
        where: { id: userId },
        select: ['id', 'address'],
      }),
      this.userRepository.findOne({
        where: { id: proposal.creatorId },
        select: ['id', 'address'],
      }),
      this.getVotes(proposalId),
    ]);

    // Calculate voting eligibility
    let canVote = false;
    let selectedVote: VoteType | null = null;

    try {
      const isActive = proposal.status === ProposalStatus.ACTIVE && proposal.endDate && new Date() <= proposal.endDate;

      if (user?.address && proposal.snapshot) {
        const voteWeight = proposal.snapshot.addressBalances[user.address];
        const hasVotingPower = voteWeight && voteWeight !== '0';

        const existingVote = await this.voteRepository.findOne({
          where: {
            proposalId,
            voterAddress: user.address,
          },
          select: ['vote'],
        });

        if (existingVote) {
          selectedVote = existingVote.vote;
        } else {
          canVote = isActive && hasVotingPower;
        }
      }
    } catch (error) {
      this.logger.error(
        `Error checking voting eligibility for user ${userId} on proposal ${proposalId}: ${error.message}`
      );
    }

    // Consolidate all asset IDs from metadata
    const allAssetIds = new Set<string>();
    const burnAssetIds = proposal.metadata?.burnAssets || [];
    const fungibleTokenIds = proposal.metadata?.fungibleTokens?.map(ft => ft.id) || [];
    const nonFungibleTokenIds = proposal.metadata?.nonFungibleTokens?.map(nft => nft.id) || [];
    const marketplaceActionIds = proposal.metadata?.marketplaceActions?.map(ma => ma.assetId) || [];

    [...burnAssetIds, ...fungibleTokenIds, ...nonFungibleTokenIds, ...marketplaceActionIds].forEach(id =>
      allAssetIds.add(id)
    );

    // Fetch all assets in a single query
    const allAssets =
      allAssetIds.size > 0
        ? await this.assetRepository.find({
            where: { id: In(Array.from(allAssetIds)) },
            select: [
              'id',
              'policy_id',
              'asset_id',
              'type',
              'quantity',
              'image',
              'name',
              'metadata',
              'floor_price',
              'dex_price',
              'listing_price',
              'status',
            ],
          })
        : [];

    // Create asset lookup map for O(1) access
    const assetMap = new Map(allAssets.map(asset => [asset.id, asset]));

    // Transform assets using direct properties and imageUrl getter
    const burnAssetsWithNames = burnAssetIds
      .map(id => assetMap.get(id))
      .filter(Boolean)
      .map(asset => ({
        id: asset.id,
        name: asset.name || asset.metadata?.name || 'Unknown Asset',
        imageUrl: asset.imageUrl,
        policyId: asset.policy_id,
        assetId: asset.asset_id,
        type: asset.type,
        quantity: asset.quantity,
      }));

    // Get distribution info for DISTRIBUTION proposals
    const distributionLovelaceAmount = proposal.metadata?.distributionLovelaceAmount || null;
    let distributionInfo = null;

    if (proposal.proposalType === ProposalType.DISTRIBUTION && distributionLovelaceAmount) {
      // Calculate distribution info from snapshot
      const snapshot = proposal.snapshot;
      if (snapshot?.addressBalances) {
        const totalLovelace = BigInt(distributionLovelaceAmount);
        const minAdaPerRecipient = BigInt(2_000_000); // 2 ADA minimum

        // Calculate total VT supply and eligible holders
        const totalVtSupply = Object.values(snapshot.addressBalances).reduce(
          (sum, balance) => sum + BigInt(balance as string),
          BigInt(0)
        );

        let eligibleHolders = 0;

        for (const balance of Object.values(snapshot.addressBalances)) {
          const vtBalance = BigInt(balance as string);
          if (vtBalance === BigInt(0)) continue;

          // Calculate proportional share
          const share = (totalLovelace * vtBalance) / totalVtSupply;
          if (share >= minAdaPerRecipient) {
            eligibleHolders++;
          }
        }

        const totalHolders = Object.values(snapshot.addressBalances).filter(
          b => BigInt(b as string) > BigInt(0)
        ).length;
        const skippedHolders = totalHolders - eligibleHolders;

        // Calculate average ADA per eligible holder
        const avgLovelacePerHolder = eligibleHolders > 0 ? Number(totalLovelace) / eligibleHolders : 0;

        distributionInfo = {
          totalAdaAmount: Number(totalLovelace) / 1_000_000,
          totalHolders,
          eligibleHolders,
          skippedHolders,
          avgAdaPerHolder: avgLovelacePerHolder / 1_000_000,
          minAdaPerRecipient: Number(minAdaPerRecipient) / 1_000_000,
        };
      }
    }

    const amountMap = new Map(proposal.metadata?.fungibleTokens?.map(ft => [ft.id, ft.amount]) || []);
    const fungibleTokensWithNames = fungibleTokenIds
      .map(id => assetMap.get(id))
      .filter(Boolean)
      .map(asset => ({
        id: asset.id,
        name: asset.name || asset.metadata?.name || 'Unknown Asset',
        imageUrl: asset.imageUrl,
        policyId: asset.policy_id,
        assetId: asset.asset_id,
        type: asset.type,
        quantity: asset.quantity,
        amount: amountMap.get(asset.id),
      }));

    const marketMap = new Map(proposal.metadata?.nonFungibleTokens?.map(nft => [nft.id, nft.market]) || []);
    const nonFungibleTokensWithNames = nonFungibleTokenIds
      .map(id => assetMap.get(id))
      .filter(Boolean)
      .map(asset => ({
        id: asset.id,
        name: asset.name || asset.metadata?.name || 'Unknown Asset',
        imageUrl: asset.imageUrl,
        policyId: asset.policy_id,
        assetId: asset.asset_id,
        type: asset.type,
        quantity: asset.quantity,
        market: marketMap.get(asset.id),
      }));

    // Transform marketplace actions with enriched asset data and WayUp URLs
    // For DexHunter swaps, combine quantities by token (policy_id + asset_id)
    const marketplaceActions = (proposal.metadata?.marketplaceActions || []).map(action => {
      const asset = assetMap.get(action.assetId);

      // Check if this is a DexHunter swap action (has slippage field)
      const isSwapAction = action.slippage !== undefined || action.market === 'DexHunter';

      // Generate WayUp URL only for non-swap actions (NFT marketplace actions)
      let wayupUrl: string | undefined;
      if (!isSwapAction && asset?.policy_id && asset?.asset_id) {
        wayupUrl = `https://www.wayup.io/collection/${asset.policy_id}/asset/${asset.asset_id}?tab=activity`;
      }

      return {
        ...action,
        assetName: asset?.name || asset?.metadata?.name || 'Unknown Asset',
        assetImg: asset?.imageUrl,
        assetPrice: asset?.floor_price || asset?.dex_price || 0,
        listingPrice: asset?.listing_price,
        assetStatus: asset?.status,
        wayupUrl,
      };
    });

    // Get distribution status for DISTRIBUTION proposals that have started execution
    let distributionStatus = null;
    if (
      proposal.proposalType === ProposalType.DISTRIBUTION &&
      proposal.metadata?.distribution &&
      (proposal.status === ProposalStatus.PASSED || proposal.status === ProposalStatus.EXECUTED)
    ) {
      try {
        const status = await this.distributionService.getDistributionStatus(proposalId);
        distributionStatus = {
          status: status.status,
          totalBatches: status.totalBatches,
          completedBatches: status.completedBatches,
          failedBatches: status.failedBatches,
          pendingRetry: status.pendingRetry,
          totalDistributed: status.totalDistributed,
          totalRecipients: proposal.metadata.distribution.totalRecipients || 0,
          batches: status.batches.map(b => ({
            batchId: b.batchId,
            batchNumber: b.batchNumber,
            totalBatches: b.totalBatches,
            recipientCount: b.recipientCount,
            lovelaceAmount: b.lovelaceAmount,
            status: b.status,
            txHash: b.txHash,
            retryCount: b.retryCount,
            error: b.error,
          })),
        };
      } catch (error) {
        this.logger.warn(`Failed to get distribution status for proposal ${proposalId}: ${error.message}`);
      }
    }

    // Extract execution error from metadata if present
    const executionError = proposal.metadata?.executionError
      ? {
          message: proposal.metadata.executionError.message,
          timestamp: proposal.metadata.executionError.timestamp,
          errorCode: proposal.metadata.executionError.errorCode,
          userFriendlyMessage: proposal.metadata.executionError.userFriendlyMessage,
        }
      : undefined;

    // Calculate vote percentages
    let votePercentages = null;
    try {
      const voteResult = this.voteCountingService.calculateResult(votes, 0, 0, BigInt(totals.totalVotingPower));
      votePercentages = {
        yes: voteResult.yesVotePercent,
        no: voteResult.noVotePercent,
        abstain: proposal.abstain ? voteResult.abstainVotePercent : 0,
      };
    } catch (error) {
      this.logger.error(
        `Error calculating vote percentages for proposal ${proposal.id}: ${error.message}`,
        error.stack
      );
    }

    // Map proposal entity to DTO with only needed fields
    const proposalDto = {
      id: proposal.id,
      title: proposal.title,
      description: proposal.description,
      status: proposal.status,
      proposalType: proposal.proposalType,
      ipfsHash: proposal.ipfsHash,
      externalLink: proposal.externalLink,
      startDate: proposal.startDate,
      endDate: proposal.endDate,
      executionDate: proposal.executionDate,
      terminationDate: proposal.terminationDate,
      abstain: proposal.abstain,
      snapshotId: proposal.snapshotId,
      vaultId: proposal.vaultId,
      creatorId: proposal.creatorId,
      createdAt: proposal.createdAt,
      metadata: proposal.metadata,
      executionError,
      votes: votePercentages,
      vault: proposal.vault
        ? {
            id: proposal.vault.id,
            name: proposal.vault.name,
            vault_token_ticker: proposal.vault.vault_token_ticker,
            vault_status: proposal.vault.vault_status,
            termination_type: proposal.vault.termination_type,
            terminationMetadata: proposal.vault.termination_metadata, // Includes status, txHashes, etc.
          }
        : undefined,
    };

    const response = {
      proposal: proposalDto,
      votes,
      totals,
      canVote,
      selectedVote,
      proposer,
      burnAssets: burnAssetsWithNames,
      distributionLovelaceAmount,
      distributionInfo,
      distributionStatus,
      fungibleTokens: fungibleTokensWithNames,
      nonFungibleTokens: nonFungibleTokensWithNames,
      marketplaceActions,
    };

    return plainToInstance(GetProposalDetailRes, response, {
      excludeExtraneousValues: true,
    });
  }

  async vote(proposalId: string, voteReq: VoteReq, userId: string): Promise<VoteRes> {
    const proposal = await this.proposalRepository.findOne({
      where: { id: proposalId },
    });

    if (!proposal) {
      throw new NotFoundException('Proposal not found');
    }

    if (proposal.status !== ProposalStatus.ACTIVE) {
      throw new BadRequestException('Voting is only allowed on active proposals');
    }

    if (!proposal.endDate || new Date() > proposal.endDate) {
      throw new BadRequestException('Voting period has ended');
    }

    if (!proposal.abstain && voteReq.vote === VoteType.ABSTAIN) {
      throw new BadRequestException('Abstain option is not allowed for this proposal');
    }

    // Check if user has already voted
    const existingVote = await this.voteRepository.exists({
      where: {
        proposalId,
        voterAddress: voteReq.voterAddress,
      },
    });

    if (existingVote) {
      throw new BadRequestException('Address has already voted on this proposal');
    }

    const voteWeight = await this.getVotingPower(proposal.vaultId, userId, 'vote');

    const vote = this.voteRepository.create({
      proposalId,
      snapshotId: proposal.snapshotId,
      voterId: userId,
      voterAddress: voteReq.voterAddress,
      voteWeight,
      vote: voteReq.vote,
    });

    await this.voteRepository.save(vote);

    return {
      success: true,
      message: 'Vote recorded successfully',
      vote: {
        id: vote.id,
        proposalId,
        voterId: userId,
        voterAddress: voteReq.voterAddress,
        voteWeight,
        vote: voteReq.vote,
        timestamp: vote.timestamp,
      },
    };
  }

  /**
   * Submit governance fee payment transaction and activate proposal
   * Takes signed transaction, submits to blockchain, and activates the proposal
   * Only the proposal creator can submit the fee payment
   */
  async submitProposalFeePayment(
    proposalId: string,
    transaction: string,
    signatures: string[],
    userId: string
  ): Promise<{ success: boolean; message: string; txHash: string }> {
    // Fetch proposal to validate
    const proposal = await this.proposalRepository.findOne({
      where: { id: proposalId },
      relations: ['vault', 'creator'],
    });

    if (!proposal) {
      throw new NotFoundException('Proposal not found');
    }

    // Verify that the authenticated user is the proposal creator
    if (proposal.creatorId !== userId) {
      throw new ForbiddenException('Only the proposal creator can submit fee payment');
    }

    if (proposal.status !== ProposalStatus.UNPAID) {
      throw new BadRequestException(`Proposal is not in UNPAID status. Current status: ${proposal.status}`);
    }

    // Submit transaction to blockchain
    let txHash: string;
    try {
      const result = await this.blockchainService.submitTransaction({
        transaction: transaction,
        signatures: signatures || [],
      });

      if (!result.txHash) {
        throw new Error('No transaction hash returned from blockchain submission');
      }

      txHash = result.txHash;
      this.logger.log(`Submitted governance fee transaction: ${txHash} for proposal ${proposalId}`);
    } catch (error) {
      const errorMsg = error?.message || error?.toString() || 'Unknown error';
      this.logger.error(`Failed to submit governance fee transaction: ${errorMsg}`, error?.stack);

      // Delete the UNPAID proposal if blockchain submission fails
      try {
        await this.proposalRepository.remove(proposal);
        this.logger.warn(`Deleted UNPAID proposal ${proposalId} after failed transaction submission`);
      } catch (deleteError) {
        this.logger.error(`Failed to delete UNPAID proposal ${proposalId}: ${deleteError.message}`);
      }

      throw new BadRequestException(`Failed to submit transaction: ${errorMsg}`);
    }

    // Get pending payment metadata
    const pendingPayment = proposal.metadata?._pendingPayment;
    if (!pendingPayment) {
      throw new InternalServerErrorException('Proposal missing pending payment metadata');
    }

    // Use originalStartDate from metadata (user's intended start date)
    const now = new Date();
    const startDate = new Date(pendingPayment.originalStartDate);
    const endDate = new Date(startDate.getTime() + pendingPayment.duration);

    // Update proposal status based on originalStartDate
    // If originalStartDate is in the past or now, proposal is ACTIVE
    // If originalStartDate is in the future, proposal is UPCOMING
    if (now >= startDate) {
      proposal.status = ProposalStatus.ACTIVE;
    } else {
      proposal.status = ProposalStatus.UPCOMING;
    }
    proposal.startDate = startDate;
    proposal.endDate = endDate;

    // Clear pending payment metadata
    delete proposal.metadata._pendingPayment;

    await this.proposalRepository.save(proposal);

    // Emit proposal started event
    const finalContributorClaims = await this.claimRepository.find({
      where: {
        vault: { id: proposal.vault.id },
        type: ClaimType.CONTRIBUTOR,
      },
      relations: ['transaction', 'transaction.assets'],
      order: { created_at: 'ASC' },
    });

    this.eventEmitter.emit('proposal.started', {
      address: proposal.creator.address,
      vaultId: proposal.vault.id,
      vaultName: proposal.vault.name,
      proposalName: proposal.title,
      creatorId: proposal.creatorId,
      tokenHolderIds: [...new Set(finalContributorClaims.map(c => c.user_id))],
    });

    this.logger.log(
      `Proposal ${proposalId} activated after payment submission. TxHash: ${txHash}, Start: ${startDate.toISOString()}, End: ${endDate.toISOString()}`
    );

    return {
      success: true,
      message: 'Payment submitted and proposal activated successfully',
      txHash,
    };
  }

  async getVotes(proposalId: string): Promise<{
    votes: {
      id: string;
      voterAddress: string;
      voteWeight: string;
      vote: VoteType;
      timestamp: Date;
    }[];
    totals: {
      yes: string;
      no: string;
      abstain: string;
      totalVotingPower: string;
      votedPercentage: number;
    };
  }> {
    const proposal = await this.proposalRepository.findOne({
      where: { id: proposalId },
    });

    if (!proposal) {
      throw new NotFoundException('Proposal not found');
    }

    const votes = await this.voteRepository.find({
      where: { proposalId },
      order: { timestamp: 'DESC' },
      select: ['id', 'voterAddress', 'voteWeight', 'vote', 'timestamp'],
    });

    const snapshot = await this.snapshotRepository.findOne({
      where: { id: proposal.snapshotId },
    });

    if (!snapshot) {
      throw new NotFoundException('Snapshot not found');
    }

    const totalVotingPowerBigInt = Object.values(snapshot.addressBalances).reduce(
      (sum, balance) => BigInt(sum) + BigInt(balance),
      BigInt(0)
    );
    const totalVotingPower = totalVotingPowerBigInt.toString();

    // Use vote counting service to calculate all vote totals and percentages
    const voteResult = this.voteCountingService.calculateResult(votes, 0, 0, totalVotingPowerBigInt);

    const totals = {
      yes: voteResult.yesVotes.toString(),
      no: voteResult.noVotes.toString(),
      abstain: voteResult.abstainVotes.toString(),
      totalVotingPower,
      votedPercentage: 0,
    };

    // Calculate the percentage of total voting power that has voted
    const votedVotingPower = voteResult.yesVotes + voteResult.noVotes + voteResult.abstainVotes;
    if (totalVotingPowerBigInt > 0) {
      totals.votedPercentage = Number((votedVotingPower * BigInt(100)) / totalVotingPowerBigInt);
    }

    return {
      votes: votes.map(vote => ({
        id: vote.id,
        voterAddress: vote.voterAddress,
        voteWeight: vote.voteWeight,
        vote: vote.vote,
        timestamp: vote.timestamp,
      })),
      totals,
    };
  }

  async getVotingPower(vaultId: string, userId: string, action?: 'vote' | 'create_proposal'): Promise<string> {
    // Check if distribution is processed - don't use cache during distribution
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      select: ['id', 'distribution_processed'],
    });

    if (!vault) {
      throw new NotFoundException('Vault not found');
    }

    const cacheKey = `voting_power:${vaultId}:${userId}:${action || 'general'}`;

    // Only check cache if distribution is processed
    if (vault.distribution_processed) {
      const cached = this.votingPowerCache.get<{
        power: string;
        error?: { type: string; message: string };
      }>(cacheKey);

      if (cached !== undefined) {
        this.logger.debug(`Cache hit for voting power: ${cacheKey}`);
        if (cached.error) {
          // Re-throw cached error
          if (cached.error.type === 'BadRequestException') {
            throw new BadRequestException(cached.error.message);
          } else if (cached.error.type === 'NotFoundException') {
            throw new NotFoundException(cached.error.message);
          }
        }
        return cached.power;
      }
    }

    try {
      const power = await this._getVotingPowerUncached(vaultId, userId, action);

      // Cache successful result only if distribution is processed
      if (vault.distribution_processed) {
        this.votingPowerCache.set(cacheKey, { power }, this.CACHE_TTL.VOTING_POWER);
      }

      return power;
    } catch (error) {
      let cacheTTL = this.CACHE_TTL.VOTING_POWER;

      // Cache errors with longer TTL to redce repeated failed calls (only if distribution is processed)
      if (error instanceof BadRequestException) {
        if (error.message.includes('NO_VOTING_POWER')) {
          cacheTTL = this.CACHE_TTL.NO_VOTING_POWER;
        }

        if (vault.distribution_processed) {
          this.votingPowerCache.set(
            cacheKey,
            {
              power: '0',
              error: { type: 'BadRequestException', message: error.message },
            },
            cacheTTL
          );
        }
      } else if (error instanceof NotFoundException) {
        if (vault.distribution_processed) {
          this.votingPowerCache.set(
            cacheKey,
            {
              power: '0',
              error: { type: 'NotFoundException', message: error.message },
            },
            cacheTTL
          );
        }
      } else {
        this.logger.error(`Unexpected error in voting power check for ${userId} in vault ${vaultId}:`, error);
      }

      throw error;
    }
  }

  async getAssetsToStake(vaultId: string): Promise<Asset[]> {
    try {
      return await this.assetRepository.find({
        where: {
          vault: { id: vaultId },
          type: In([AssetType.FT]),
          origin_type: AssetOriginType.CONTRIBUTED,
          status: AssetStatus.LOCKED,
        },
      });
    } catch (error) {
      this.logger.error(`Error getting assets to stake for vault ${vaultId}: ${error.message}`, error.stack);
      throw new InternalServerErrorException('Error getting assets to stake');
    }
  }

  async getAssetsToTerminate(vaultId: string): Promise<AssetBuySellDto[]> {
    try {
      // Get all assets in the vault eligible for termination
      const assets = await this.assetRepository.find({
        where: {
          vault: { id: vaultId },
          type: In([AssetType.NFT, AssetType.FT]),
          status: AssetStatus.LOCKED,
          origin_type: AssetOriginType.CONTRIBUTED,
          deleted: false,
        },
        relations: ['vault'],
        select: ['id', 'policy_id', 'asset_id', 'type', 'quantity', 'dex_price', 'floor_price', 'metadata'],
      });

      return plainToInstance(AssetBuySellDto, assets, {
        excludeExtraneousValues: true,
      });
    } catch (error) {
      this.logger.error(`Error getting assets to terminate for vault ${vaultId}: ${error.message}`, error.stack);
      throw new InternalServerErrorException('Error getting assets to terminate');
    }
  }

  async getAssetsToBurn(vaultId: string): Promise<AssetBuySellDto[]> {
    try {
      const assets = await this.assetRepository.find({
        where: {
          vault: { id: vaultId },
          type: In([AssetType.NFT, AssetType.FT]),
          status: AssetStatus.LOCKED,
          origin_type: AssetOriginType.CONTRIBUTED,
          deleted: false,
        },
        relations: ['vault'],
        select: ['id', 'policy_id', 'asset_id', 'type', 'quantity', 'dex_price', 'floor_price', 'metadata'],
      });

      return plainToInstance(AssetBuySellDto, assets, {
        excludeExtraneousValues: true,
      });
    } catch (error) {
      this.logger.error(`Error getting assets to burn for vault ${vaultId}: ${error.message}`, error.stack);
      throw new InternalServerErrorException('Error getting assets to burn');
    }
  }

  async getAssetsToList(vaultId: string): Promise<AssetBuySellDto[]> {
    try {
      // Get all assets in the vault
      const assets: Pick<
        Asset,
        'id' | 'policy_id' | 'quantity' | 'dex_price' | 'floor_price' | 'metadata' | 'type' | 'name' | 'image'
      >[] = await this.assetRepository.find({
        where: [
          {
            vault: { id: vaultId },
            type: In([AssetType.NFT]),
            status: In([AssetStatus.LOCKED, AssetStatus.EXTRACTED]),
            origin_type: AssetOriginType.CONTRIBUTED,
          },
        ],
        select: [
          'id',
          'policy_id',
          'quantity',
          'dex_price',
          'floor_price',
          'metadata',
          'type',
          'name',
          'image',
          'listing_market',
          'listing_price',
          'listing_tx_hash',
        ],
      });

      return plainToInstance(AssetBuySellDto, assets, {
        excludeExtraneousValues: true,
      });
    } catch (error) {
      this.logger.error(`Error getting assets for buy-sell proposals for vault ${vaultId}: ${error.message}`);
      throw new InternalServerErrorException('Error getting assets for buying/selling');
    }
  }

  async getAssetsToUnlist(vaultId: string): Promise<AssetBuySellDto[]> {
    try {
      // Get all listed assets in the vault
      const assets = await this.assetRepository.find({
        where: [{ vault: { id: vaultId }, type: In([AssetType.NFT, AssetType.FT]), status: AssetStatus.LISTED }],
        select: [
          'id',
          'name',
          'policy_id',
          'quantity',
          'dex_price',
          'floor_price',
          'image',
          'metadata',
          'type',
          'listing_market',
          'listing_price',
          'listing_tx_hash',
          'listed_at',
        ],
      });

      return plainToInstance(AssetBuySellDto, assets, {
        excludeExtraneousValues: true,
      });
    } catch (error) {
      this.logger.error(`Error getting assets to unlist for vault ${vaultId}: ${error.message}`);
      throw new InternalServerErrorException('Error getting assets for unlisting');
    }
  }

  async getAssetsToUpdateListing(vaultId: string): Promise<AssetBuySellDto[]> {
    try {
      // Get all listed assets in the vault that can have their listing updated
      const assets = await this.assetRepository.find({
        where: [{ vault: { id: vaultId }, type: In([AssetType.NFT, AssetType.FT]), status: AssetStatus.LISTED }],
        select: [
          'id',
          'name',
          'policy_id',
          'quantity',
          'dex_price',
          'floor_price',
          'image',
          'metadata',
          'type',
          'listing_market',
          'listing_price',
          'listing_tx_hash',
          'listed_at',
        ],
      });

      return plainToInstance(AssetBuySellDto, assets, {
        excludeExtraneousValues: true,
      });
    } catch (error) {
      this.logger.error(`Error getting assets to update listing for vault ${vaultId}: ${error.message}`);
      throw new InternalServerErrorException('Error getting assets for updating listings');
    }
  }

  async canUserCreateProposal(vaultId: string, userId: string): Promise<boolean> {
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      select: ['id', 'vault_status', 'distribution_processed'],
    });

    const cacheKey = `can_create_proposal:${vaultId}:${userId}`;

    // Only check cache if distribution is processed
    if (vault?.distribution_processed) {
      const cached = this.proposalCreationCache.get<boolean>(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
    }

    try {
      // Allow proposal creation for both locked and expansion vaults
      if (!vault || (vault.vault_status !== VaultStatus.locked && vault.vault_status !== VaultStatus.expansion)) {
        if (vault?.distribution_processed) {
          this.proposalCreationCache.set(cacheKey, false, this.CACHE_TTL.CAN_CREATE_PROPOSAL);
        }
        return false;
      }
      await this.getVotingPower(vaultId, userId, 'create_proposal');
      if (vault.distribution_processed) {
        this.proposalCreationCache.set(cacheKey, true, this.CACHE_TTL.CAN_CREATE_PROPOSAL);
      }
      return true;
    } catch {
      if (vault?.distribution_processed) {
        this.proposalCreationCache.set(cacheKey, false, this.CACHE_TTL.CAN_CREATE_PROPOSAL);
      }
      return false;
    }
  }

  /**
   * Calculate all valid quantity combinations from individual asset amounts
   * Uses subset sum to find all possible sums
   * @param amounts - Array of individual asset quantities
   * @returns Sorted array of all valid combination sums (excluding 0)
   */
  private calculateValidCombinations(amounts: number[]): number[] {
    if (!amounts || amounts.length === 0) {
      return [];
    }

    const combinations = new Set<number>([0]);
    for (const amount of amounts) {
      const newCombinations = new Set(combinations);
      for (const sum of combinations) {
        newCombinations.add(sum + amount);
      }
      for (const sum of newCombinations) {
        combinations.add(sum);
      }
    }

    // Return sorted array excluding 0
    return Array.from(combinations)
      .filter(c => c > 0)
      .sort((a, b) => a - b);
  }

  /**
   * Get fungible tokens available for swapping via DexHunter
   * Returns FT assets with current prices and estimated ADA values
   * Includes both vault assets (LOCKED) and treasury assets (EXTRACTED)
   * Provides breakdown of quantities in vault vs treasury
   */
  async getSwappableAssets(vaultId: string): Promise<
    {
      id: string;
      policyId: string;
      assetId: string;
      unit: string;
      name: string;
      image: any;
      quantity: number;
      lockedQuantity: number;
      extractedQuantity: number;
      treasuryQuantity: number;
      currentPriceAda: number;
      estimatedAdaValue: number;
      lastPriceUpdate: string;
      /** Individual asset records with their IDs and quantities */
      assetRecords: Array<{ id: string; quantity: number; status: string }>;
      /** Individual asset quantities (for backwards compatibility) */
      availableAmounts: number[];
      /** Precomputed valid quantity combinations */
      validCombinations: number[];
    }[]
  > {
    // Get vault with treasury wallet info
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      relations: ['treasury_wallet'],
    });

    if (!vault) {
      throw new Error(`Vault ${vaultId} not found`);
    }

    // Query all FT assets for this vault (LOCKED + EXTRACTED)
    const ftAssets = await this.assetRepository.find({
      where: {
        vault: { id: vaultId },
        type: AssetType.FT,
        status: In([AssetStatus.LOCKED, AssetStatus.EXTRACTED]),
      },
      select: ['id', 'policy_id', 'asset_id', 'name', 'metadata', 'dex_price', 'quantity', 'status'],
    });

    // Filter assets with available quantity
    const availableAssets = ftAssets.filter(asset => asset.quantity > 0);

    if (availableAssets.length === 0) {
      return [];
    }

    // Get treasury balances from Blockfrost
    const treasuryBalances = new Map<string, number>();
    if (vault.treasury_wallet?.treasury_address) {
      try {
        const treasuryInfo = await this.blockfrost.addresses(vault.treasury_wallet.treasury_address);
        for (const amount of treasuryInfo.amount) {
          if (amount.unit !== 'lovelace') {
            treasuryBalances.set(amount.unit, parseInt(amount.quantity));
          }
        }
      } catch (error) {
        // Treasury wallet empty or not found - that's ok
        if (error.status_code !== 404) {
          this.logger.warn(`Failed to fetch treasury balance: ${error.message}`);
        }
      }
    }

    // Group assets by token (policy_id + asset_id) and separate by status
    const combinedAssets = availableAssets.reduce(
      (acc, asset) => {
        const tokenKey = `${asset.policy_id}_${asset.asset_id}`;
        const tokenUnit = asset.policy_id + asset.asset_id;

        if (acc.has(tokenKey)) {
          // Add to existing token
          const existing = acc.get(tokenKey);
          existing.quantity += asset.quantity;

          if (asset.status === AssetStatus.LOCKED) {
            existing.lockedQuantity += asset.quantity;
          } else if (asset.status === AssetStatus.EXTRACTED) {
            existing.extractedQuantity += asset.quantity;
          }

          existing.assetRecords.push({
            id: asset.id,
            quantity: asset.quantity,
            status: asset.status,
          });
        } else {
          // First occurrence of this token
          const lockedQty = asset.status === AssetStatus.LOCKED ? asset.quantity : 0;
          const extractedQty = asset.status === AssetStatus.EXTRACTED ? asset.quantity : 0;
          const treasuryQty = treasuryBalances.get(tokenUnit) || 0;

          acc.set(tokenKey, {
            id: asset.id, // Keep first asset ID for backwards compatibility
            policy_id: asset.policy_id,
            asset_id: asset.asset_id,
            name: asset.name,
            metadata: asset.metadata,
            dex_price: asset.dex_price,
            quantity: asset.quantity,
            lockedQuantity: lockedQty,
            extractedQuantity: extractedQty,
            treasuryQuantity: treasuryQty,
            assetRecords: [
              {
                id: asset.id,
                quantity: asset.quantity,
                status: asset.status,
              },
            ],
          });
        }

        return acc;
      },
      new Map<
        string,
        {
          id: string;
          policy_id: string;
          asset_id: string;
          name: string;
          metadata: any;
          dex_price: number;
          quantity: number;
          lockedQuantity: number;
          extractedQuantity: number;
          treasuryQuantity: number;
          assetRecords: Array<{ id: string; quantity: number; status: string }>;
        }
      >()
    );

    // Convert map to array and build token IDs for price fetching
    const combinedAssetsList = Array.from(combinedAssets.values());
    const tokenIds = combinedAssetsList.map(asset => asset.policy_id + asset.asset_id);

    // Batch fetch prices from DexHunter
    const priceMap = await this.dexHunterPricingService.getTokenPrices(tokenIds);

    // Map assets with pricing data
    return combinedAssetsList.map(asset => {
      const tokenId = asset.policy_id + asset.asset_id;
      const currentPriceAda = priceMap.get(tokenId) || asset.dex_price || null;
      const totalQuantity = asset.quantity;
      const estimatedAdaValue = currentPriceAda ? totalQuantity * currentPriceAda : null;

      // Sort records by quantity (smallest first) for greedy algorithm
      const sortedRecords = asset.assetRecords.sort((a, b) => a.quantity - b.quantity);

      // Both LOCKED (in vault) and EXTRACTED (already in treasury) can be swapped
      // LOCKED assets need extraction first, EXTRACTED assets can swap directly
      const swappableRecords = sortedRecords.filter(
        r => r.status === AssetStatus.LOCKED || r.status === AssetStatus.EXTRACTED
      );
      const swappableAmounts = swappableRecords.map(r => r.quantity);

      return {
        id: asset.id, // First asset ID (for backwards compatibility)
        policyId: asset.policy_id,
        assetId: asset.asset_id,
        unit: tokenId, // Full token identifier for DexHunter
        name: asset.name,
        image: asset.metadata?.image || null,
        quantity: totalQuantity, // Total across all statuses (locked + extracted + treasury)
        lockedQuantity: asset.lockedQuantity, // In vault (needs extraction)
        extractedQuantity: asset.extractedQuantity, // Already in treasury (ready to swap)
        treasuryQuantity: asset.treasuryQuantity, // Currently in treasury wallet (from Blockfrost)
        currentPriceAda,
        estimatedAdaValue,
        lastPriceUpdate: new Date().toISOString(),
        assetRecords: sortedRecords, // All individual asset records with IDs and status
        availableAmounts: swappableAmounts, // LOCKED + EXTRACTED quantities (swappable)
        validCombinations: this.calculateValidCombinations(swappableAmounts), // From LOCKED + EXTRACTED
      };
    });
  }

  private async _getVotingPowerUncached(
    vaultId: string,
    userId: string,
    action?: 'vote' | 'create_proposal'
  ): Promise<string> {
    try {
      const snapshot = await this.snapshotRepository.findOne({
        where: { vaultId },
        order: { createdAt: 'DESC' },
      });

      if (!snapshot) {
        throw new NotFoundException('No voting snapshot found for this vault');
      }

      const vault = await this.vaultRepository.findOne({
        where: { id: vaultId },
        select: ['creation_threshold', 'vote_threshold'],
      });

      if (!vault) {
        throw new NotFoundException('Vault not found');
      }

      const user = await this.userRepository.findOne({
        where: { id: userId },
        select: ['id', 'address'],
      });

      if (!user) {
        throw new NotFoundException('User not found');
      }

      // Verify user is not the pool address (LP VTs should not have voting power)
      if (user.address === this.poolAddress) {
        throw new BadRequestException(
          'NO_VOTING_POWER',
          'Liquidity pool addresses cannot vote. VT tokens in LP are excluded from governance.'
        );
      }

      const voteWeight = snapshot.addressBalances[user.address];

      if (!voteWeight || voteWeight === '0') {
        throw new BadRequestException(
          'NO_VOTING_POWER',
          'You have no voting power in this vault. You must hold vault tokens to vote.'
        );
      }

      const totalVotingPower = Object.values(snapshot.addressBalances)
        .reduce((sum, balance) => BigInt(sum) + BigInt(balance), BigInt(0))
        .toString();
      const voteWeightPercentFromAll = (BigInt(voteWeight) * BigInt(100)) / BigInt(totalVotingPower);

      if (voteWeightPercentFromAll < vault.creation_threshold && action === 'create_proposal') {
        throw new BadRequestException(
          'BELOW_THRESHOLD',
          `Your voting power (${voteWeightPercentFromAll}) is below the minimum threshold (${vault.creation_threshold}).`
        );
      }

      if (voteWeightPercentFromAll < vault.vote_threshold && action === 'vote') {
        throw new BadRequestException(
          'BELOW_THRESHOLD',
          `Your voting power (${voteWeightPercentFromAll}) is below the minimum threshold (${vault.vote_threshold}).`
        );
      }

      return voteWeight;
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }

      this.logger.error(
        `Error getting voting power for user ${userId} in vault ${vaultId}: ${error.message}`,
        error.stack
      );
      throw new InternalServerErrorException('Error getting voting power. Please try again later.');
    }
  }

  /**
   * Check if a target quantity is a valid combination (sum) of available amounts
   * Uses subset sum algorithm with memoization for efficiency
   *
   * @param target - The target quantity to validate
   * @param amounts - Array of available individual quantities
   * @returns true if target can be achieved by summing a subset of amounts
   */
  private isValidQuantityCombination(target: number, amounts: number[]): boolean {
    // Handle floating point precision by working with integers (multiply by 100 for 2 decimal places)
    const precision = 100;
    const targetInt = Math.round(target * precision);
    const amountsInt = amounts.map(a => Math.round(a * precision));

    // Use dynamic programming subset sum
    const possible = new Set<number>([0]);

    for (const amount of amountsInt) {
      const newPossible = new Set<number>(possible);
      for (const sum of possible) {
        const newSum = sum + amount;
        if (newSum <= targetInt) {
          newPossible.add(newSum);
        }
      }
      // Early exit if we found the target
      if (newPossible.has(targetInt)) {
        return true;
      }
      // Update possible sums
      for (const sum of newPossible) {
        possible.add(sum);
      }
    }

    return possible.has(targetInt);
  }
}
