import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import {
  BadRequestException,
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

import { DistributionService } from './distribution.service';
import { CreateProposalReq, ExecType } from './dto/create-proposal.req';
import { CreateProposalRes } from './dto/create-proposal.res';
import { AssetBuySellDto } from './dto/get-assets.dto';
import { GetProposalDetailRes } from './dto/get-proposal-detail.res';
import { GetProposalsResItem } from './dto/get-proposal.dto';
import { VoteReq } from './dto/vote.req';
import { VoteRes } from './dto/vote.res';
import { VoteCountingService } from './vote-counting.service';

import { Asset } from '@/database/asset.entity';
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
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly voteCountingService: VoteCountingService,
    private readonly distributionService: DistributionService,
    private readonly dexHunterPricingService: DexHunterPricingService,
    private readonly dexHunterService: DexHunterService
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
      const lockedVaults = await this.vaultRepository.find({
        where: {
          vault_status: VaultStatus.locked,
          asset_vault_name: Not(IsNull()),
          script_hash: Not(IsNull()),
          distribution_processed: true,
        },
        select: ['id', 'asset_vault_name', 'script_hash'],
      });

      if (lockedVaults.length === 0) {
        this.logger.log('No eligible vaults found for snapshot creation');
        return;
      }

      this.logger.log(`Found ${lockedVaults.length} locked vaults for snapshots`);

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
    this.logger.log(`Creating automatic snapshot for vault ${vaultId} with asset ${assetId}`);

    try {
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
      const addressBalances: Record<string, string> = {};
      let page = 1;
      let hasMorePages = true;

      while (hasMorePages) {
        try {
          const response = await this.blockfrost.assetsAddresses(assetId, { page, order: 'desc' });

          if (response.length === 0) {
            hasMorePages = false;
          } else {
            // Add addresses and balances to the mapping, excluding pool address (LP VTs)
            for (const item of response) {
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

      // Create and save the snapshot
      const snapshot = this.snapshotRepository.create({
        vaultId,
        assetId,
        addressBalances,
      });

      await this.snapshotRepository.save(snapshot);

      this.logger.log(
        `Automatic snapshot created for vault ${vaultId} with ${Object.keys(addressBalances).length} addresses`
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

    if (vault.vault_status !== VaultStatus.locked) {
      throw new BadRequestException('Governance is only available for locked vaults');
    }

    const latestSnapshot = await this.snapshotRepository.findOne({
      where: { vaultId },
      order: { createdAt: 'DESC' },
    });

    await this.getVotingPower(vaultId, userId, 'create_proposal');

    const startDate = new Date(createProposalReq.startDate ?? createProposalReq.proposalStart);

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
          // Fetch all locked FT assets for this vault to enable multi-asset swaps
          const allFTs = await this.assetRepository.find({
            where: {
              vault: { id: vaultId },
              type: AssetType.FT,
              status: AssetStatus.LOCKED,
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

        // Store only the action data, asset details will be fetched in getProposal
        proposal.metadata.marketplaceActions = actions;

        break;
      }
    }

    await this.proposalRepository.save(proposal);

    this.eventEmitter.emit('proposal.created', {
      proposalId: proposal.id,
      startDate: proposal.startDate,
      endDate: proposal.endDate,
      status: proposal.status,
    });

    const user = await this.userRepository.findOneBy({ id: proposal.creatorId });
    const finalContributorClaims = await this.claimRepository.find({
      where: {
        vault: { id: vault.id },
        type: ClaimType.CONTRIBUTOR,
      },
      relations: ['transaction', 'transaction.assets'],
      order: { created_at: 'ASC' },
    });

    this.eventEmitter.emit('governance.proposal_created', {
      address: user.address,
      vaultId: vault.id,
      vaultName: vault.name,
      proposalName: proposal.title,
      creatorId: proposal.creatorId,
    });

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

    const proposals = await this.proposalRepository.find({
      where: { vaultId },
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
          startDate: proposal.startDate.toISOString(),
          endDate: proposal.endDate.toISOString(),
          abstain: proposal.abstain,
          executionError: proposal.metadata?.executionError?.userFriendlyMessage
            ? proposal.metadata.executionError.userFriendlyMessage
            : proposal.metadata.executionError.message,
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
      const isActive = proposal.status === ProposalStatus.ACTIVE && new Date() <= proposal.endDate;

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

    if (new Date() > proposal.endDate) {
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
            status: AssetStatus.LOCKED,
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
      if (!vault || vault.vault_status !== VaultStatus.locked) {
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
   * Get fungible tokens available for swapping via DexHunter
   * Returns FT assets with current prices and estimated ADA values
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
      currentPriceAda: number;
      estimatedAdaValue: number;
      lastPriceUpdate: string;
    }[]
  > {
    // Query all FT assets for this vault with quantity > 0
    const ftAssets = await this.assetRepository.find({
      where: {
        vault: { id: vaultId },
        type: AssetType.FT,
      },
      relations: ['vault'],
    });

    // Filter assets with available quantity
    const availableAssets = ftAssets.filter(asset => asset.quantity > 0);

    if (availableAssets.length === 0) {
      return [];
    }

    // Group assets by token (policy_id + asset_id) and combine quantities
    const combinedAssets = availableAssets.reduce(
      (acc, asset) => {
        const tokenKey = `${asset.policy_id}_${asset.asset_id}`;

        if (acc.has(tokenKey)) {
          // Add quantity to existing token
          const existing = acc.get(tokenKey);
          existing.quantity += asset.quantity;
        } else {
          // First occurrence of this token
          acc.set(tokenKey, {
            id: asset.id,
            policy_id: asset.policy_id,
            asset_id: asset.asset_id,
            name: asset.name,
            metadata: asset.metadata,
            dex_price: asset.dex_price,
            quantity: asset.quantity,
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
      const estimatedAdaValue = currentPriceAda ? asset.quantity * currentPriceAda : null;

      return {
        id: asset.id,
        policyId: asset.policy_id,
        assetId: asset.asset_id,
        unit: tokenId, // Full token identifier for DexHunter
        name: asset.name,
        image: asset.metadata?.image || null,
        quantity: asset.quantity,
        currentPriceAda,
        estimatedAdaValue,
        lastPriceUpdate: new Date().toISOString(),
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
}
