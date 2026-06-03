import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { classToPlain, plainToInstance } from 'class-transformer';
import { In, Repository } from 'typeorm';

import { transformImageToUrl } from '../../helpers';
import { VaultStatus } from '../../types/vault.types';

import { SortOrder, VaultSortField } from './dto/get-vaults.dto';
import { PaginatedResponseDto } from './dto/paginated-response.dto';
import { SaveDraftReq } from './dto/saveDraft.req';
import { VaultShortResponse } from './dto/vault.response';

import { AcquirerWhitelistEntity } from '@/database/acquirerWhitelist.entity';
import { AssetsWhitelistEntity } from '@/database/assetsWhitelist.entity';
import { ContributorWhitelistEntity } from '@/database/contributorWhitelist.entity';
import { FileEntity } from '@/database/file.entity';
import { LinkEntity } from '@/database/link.entity';
import { TagEntity } from '@/database/tag.entity';
import { TokenVerification } from '@/database/token-verification.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { AssetValuationMethod } from '@/types/asset.types';

@Injectable()
export class DraftVaultsService {
  constructor(
    @InjectRepository(Vault)
    private readonly vaultsRepository: Repository<Vault>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(LinkEntity)
    private readonly linksRepository: Repository<LinkEntity>,
    @InjectRepository(FileEntity)
    private readonly filesRepository: Repository<FileEntity>,
    @InjectRepository(AssetsWhitelistEntity)
    private readonly assetsWhitelistRepository: Repository<AssetsWhitelistEntity>,
    @InjectRepository(AcquirerWhitelistEntity)
    private readonly acquirerWhitelistRepository: Repository<AcquirerWhitelistEntity>,
    @InjectRepository(ContributorWhitelistEntity)
    private readonly contributorWhitelistRepository: Repository<ContributorWhitelistEntity>,
    @InjectRepository(TagEntity)
    private readonly tagsRepository: Repository<TagEntity>,
    @InjectRepository(TokenVerification)
    private readonly tokenVerificationRepo: Repository<TokenVerification>
  ) {}

  async getMyDraftVaults(
    userId: string,
    page: number = 1,
    limit: number = 10,
    sortBy?: VaultSortField,
    sortOrder: SortOrder = SortOrder.DESC
  ): Promise<PaginatedResponseDto<VaultShortResponse>> {
    const query = {
      where: {
        owner: { id: userId },
        vault_status: VaultStatus.draft,
      },
      relations: ['social_links', 'vault_image', 'ft_token_img'],
      skip: (page - 1) * limit,
      take: limit,
      order: {},
    };

    // Add sorting if specified
    if (sortBy) {
      query.order[sortBy] = sortOrder;
    } else {
      // Default sort by created_at DESC if no sort specified
      query.order['created_at'] = SortOrder.DESC;
    }

    const [listOfVaults, total] = await this.vaultsRepository.findAndCount(query);
    const transformedItems = listOfVaults.map(vault =>
      plainToInstance(VaultShortResponse, classToPlain(vault), { excludeExtraneousValues: true })
    );

    return {
      items: transformedItems,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getDraftVaultById(id: string, userId: string): Promise<Record<string, unknown>> {
    const vault = await this.vaultsRepository.findOne({
      where: {
        id,
        vault_status: VaultStatus.draft,
        owner: { id: userId },
      },
      relations: [
        'owner',
        'social_links',
        'assets_whitelist',
        'acquirer_whitelist',
        'contributor_whitelist',
        'vault_image',
        'ft_token_img',
        'acquirer_whitelist_csv',
        'tags',
      ],
    });

    if (!vault) {
      throw new BadRequestException('Draft vault not found');
    }

    // Transform image entities to URLs
    vault.vault_image = transformImageToUrl(vault.vault_image as FileEntity) as any;
    vault.ft_token_img = transformImageToUrl(vault.ft_token_img as FileEntity) as any;
    delete vault.owner;
    delete vault.contribution_phase_start;
    delete vault.acquire_phase_start;
    delete vault.locked_at;

    const plain = classToPlain(vault) as Record<string, unknown>;
    plain.tokenDescription = plain.token_description;
    delete plain.token_description;
    plain.isExpandableAssetWhitelist = vault.is_expandable_asset_whitelist;
    delete plain.is_expandable_asset_whitelist;
    plain.tags = vault.tags?.map(t => t.name) ?? [];

    // todo need to create additional model for remove owner, and transform image to link
    return plain;
  }

  async saveDraftVault(userId: string, data: SaveDraftReq): Promise<any> {
    let existingVault: Vault | null = null;

    if (data.id) {
      existingVault = await this.vaultsRepository.findOne({
        where: {
          id: data.id,
          vault_status: VaultStatus.draft,
          owner: { id: userId },
        },
        relations: [
          'owner',
          'social_links',
          'assets_whitelist',
          'acquirer_whitelist',
          'acquirer_whitelist_csv',
          'vault_image',
          'ft_token_img',
        ],
      });

      if (existingVault && existingVault.vault_status !== VaultStatus.draft) {
        throw new BadRequestException('Cannot modify a published vault');
      }

      if (existingVault) {
        if (existingVault.assets_whitelist?.length > 0) {
          await this.assetsWhitelistRepository.remove(existingVault.assets_whitelist);
        }
        if (existingVault.acquirer_whitelist?.length > 0) {
          await this.acquirerWhitelistRepository.remove(existingVault.acquirer_whitelist);
        }
        if (existingVault.contributor_whitelist?.length > 0) {
          await this.contributorWhitelistRepository.remove(existingVault.contributor_whitelist);
        }
      }
    }

    try {
      const owner = await this.usersRepository.findOne({
        where: { id: userId },
      });

      // Process image files
      const imgKey = data.vaultImage?.split('image/')[1];
      const vaultImg = imgKey
        ? await this.filesRepository.findOne({
            where: { file_key: imgKey },
          })
        : null;

      const ftTokenImgKey = data.ftTokenImg?.split('image/')[1];
      const ftTokenImg = ftTokenImgKey
        ? await this.filesRepository.findOne({
            where: { file_key: ftTokenImgKey },
          })
        : null;

      const acquirerWhitelistCsvKey = data.acquirerWhitelistCsv?.key;
      const acquirerWhitelistFile = acquirerWhitelistCsvKey
        ? await this.filesRepository.findOne({
            where: { file_key: acquirerWhitelistCsvKey },
          })
        : null;

      // Check if the vault already has these files to avoid duplicate relations
      const hasVaultImage = existingVault?.vault_image?.file_key === imgKey;
      const hasFtTokenImage = existingVault?.ft_token_img?.file_key === ftTokenImgKey;
      const hasAcquirerWhitelistCsv = existingVault?.acquirer_whitelist_csv?.file_key === acquirerWhitelistCsvKey;

      const vaultData: any = {
        owner: owner,
        vault_status: VaultStatus.draft,
      };

      // Only include fields that are actually provided
      if (data.name !== undefined) vaultData.name = data.name;
      if (data.type !== undefined) vaultData.type = data.type;
      if (data.preset_id !== undefined) vaultData.preset_id = data.preset_id;
      if (data.privacy !== undefined) vaultData.privacy = data.privacy;
      if (data.valueMethod !== undefined) vaultData.value_method = data.valueMethod;
      if (data.valuationCurrency !== undefined) vaultData.valuation_currency = data.valuationCurrency;
      if (data.valuationAmount !== undefined) vaultData.valuation_amount = data.valuationAmount;
      if (data.description !== undefined) vaultData.description = data.description;
      if (data.tokenDescription !== undefined) vaultData.token_description = data.tokenDescription;
      if (data.ftTokenDecimals) vaultData.ft_token_decimals = data.ftTokenDecimals;
      if (data.ftTokenSupply) vaultData.ft_token_supply = data.ftTokenSupply;
      if (data.terminationType) vaultData.termination_type = data.terminationType;
      if (data.vaultTokenTicker) vaultData.vault_token_ticker = data.vaultTokenTicker;
      if (data.tokensForAcquires !== undefined && data.tokensForAcquires !== null) {
        vaultData.tokens_for_acquires = data.tokensForAcquires;
      }
      if (data.acquireReserve !== undefined && data.acquireReserve !== null) {
        vaultData.acquire_reserve = data.acquireReserve;
      }
      if (data.liquidityPoolContribution !== undefined && data.liquidityPoolContribution !== null) {
        vaultData.liquidity_pool_contribution = data.liquidityPoolContribution;
      }
      if (data.creationThreshold) vaultData.creation_threshold = data.creationThreshold;
      if (data.startThreshold) vaultData.start_threshold = data.startThreshold;
      if (data.voteThreshold) vaultData.vote_threshold = data.voteThreshold;
      if (data.executionThreshold) vaultData.execution_threshold = data.executionThreshold;
      if (data.cosigningThreshold) vaultData.cosigning_threshold = data.cosigningThreshold;
      if (data.vaultAppreciation) vaultData.vault_appreciation = data.vaultAppreciation;
      if (data.isExpandableAssetWhitelist !== undefined)
        vaultData.is_expandable_asset_whitelist = data.isExpandableAssetWhitelist;

      if (data.contributionDuration !== undefined) {
        vaultData.contribution_duration = data.contributionDuration;
      }
      if (data.acquireWindowDuration !== undefined) {
        vaultData.acquire_window_duration = data.acquireWindowDuration;
      }
      if (data.acquireOpenWindowTime !== undefined && data.acquireOpenWindowTime !== null) {
        vaultData.acquire_open_window_time = new Date(data.acquireOpenWindowTime);
      }
      if (data.acquireOpenWindowType !== undefined && data.acquireOpenWindowType !== null) {
        vaultData.acquire_open_window_type = data.acquireOpenWindowType;
      }
      if (data.contributionOpenWindowTime !== undefined && data.contributionOpenWindowTime !== null) {
        vaultData.contribution_open_window_time = new Date(data.contributionOpenWindowTime);
      }
      if (data.contributionOpenWindowType !== undefined && data.contributionOpenWindowType !== null) {
        vaultData.contribution_open_window_type = data.contributionOpenWindowType;
      }
      if (data.timeElapsedIsEqualToTime !== undefined && data.timeElapsedIsEqualToTime !== null) {
        vaultData.time_elapsed_is_equal_to_time = data.timeElapsedIsEqualToTime;
      }

      // Handle file relationships only if provided and not already set
      if (vaultImg && !hasVaultImage) vaultData.vault_image = vaultImg;
      if (ftTokenImg && !hasFtTokenImage) vaultData.ft_token_img = ftTokenImg;
      if (acquirerWhitelistFile && !hasAcquirerWhitelistCsv) vaultData.acquirer_whitelist_csv = acquirerWhitelistFile;

      let vault: Vault;
      if (existingVault) {
        vault = (await this.vaultsRepository.save({
          ...existingVault,
          ...vaultData,
        })) as Vault;
      } else {
        vault = await this.vaultsRepository.save(vaultData as Vault);
      }

      // Social links: only touch DB when the client sends the field; empty array clears them.
      if (data.socialLinks !== undefined && data.socialLinks !== null) {
        await this.linksRepository.delete({ vault: { id: vault.id } });
        if (data.socialLinks.length > 0) {
          const newLinks = data.socialLinks.map(linkItem =>
            this.linksRepository.create({
              name: linkItem.name,
              url: linkItem.url,
              vault: vault,
            })
          );
          vault.social_links = await this.linksRepository.save(newLinks);
        } else {
          vault.social_links = [];
        }
      }

      if (data.tags !== undefined && data.tags !== null) {
        const normalizedTagNames = [...new Set(data.tags.map(tag => tag.trim()).filter(tag => tag.length > 0))];
        if (normalizedTagNames.length > 0) {
          const existingTags = await this.tagsRepository.find({
            where: { name: In(normalizedTagNames) },
          });

          const existingTagNames = new Set(existingTags.map(tag => tag.name));
          const missingTagNames = normalizedTagNames.filter(tagName => !existingTagNames.has(tagName));

          let newTags = [];
          if (missingTagNames.length > 0) {
            const tagsToCreate = missingTagNames.map(name => ({ name }));
            newTags = await this.tagsRepository.save(tagsToCreate);
          }

          vault.tags = [...existingTags, ...newTags];
        } else {
          vault.tags = [];
        }

        await this.vaultsRepository.save(vault);
      }

      // Handle assets whitelist only if provided
      if (data.assetsWhitelist !== undefined && data.assetsWhitelist.length > 0) {
        // Fetch LP token metadata AND verify valuation methods
        const policyIds = data.assetsWhitelist.map(item => item.policyId).filter(Boolean);
        const lpTokensData =
          policyIds.length > 0
            ? await this.tokenVerificationRepo.find({
                where: { policy_id: In(policyIds) },
                select: ['policy_id', 'lp_pool_onchain_id', 'is_lp_token'],
              })
            : [];
        const lpTokenMap = new Map(
          lpTokensData.map(lp => [lp.policy_id, { onchainId: lp.lp_pool_onchain_id, isLp: lp.is_lp_token }])
        );

        // Validate LP token pricing configuration
        for (const whitelistItem of data.assetsWhitelist) {
          const lpData = lpTokenMap.get(whitelistItem.policyId);

          if (lpData?.isLp) {
            // LP token detected - enforce lp_token_dynamic pricing
            // Validate that LP token has an on-chain pool ID
            if (!lpData.onchainId) {
              throw new BadRequestException(
                `Policy ${whitelistItem.policyId} is an LP token but missing lp_pool_onchain_id in token_verifications. ` +
                  `Please ensure the LP token has a valid pool ID before adding it to the vault.`
              );
            }
            // Auto-set to LP_TOKEN_DYNAMIC for LP tokens
            whitelistItem.valuationMethod = AssetValuationMethod.LP_TOKEN_DYNAMIC;
          } else if (whitelistItem.valuationMethod === AssetValuationMethod.LP_TOKEN_DYNAMIC) {
            // Non-LP token attempting to use lp_token_dynamic
            throw new BadRequestException(
              `Policy ${whitelistItem.policyId} is not an LP token and cannot use "lp_token_dynamic" valuation method. ` +
                `Please mark it as an LP token in token_verifications or use a different valuation method.`
            );
          }
        }

        await Promise.all(
          data.assetsWhitelist.map(whitelistItem => {
            const lpData = lpTokenMap.get(whitelistItem.policyId);
            return this.assetsWhitelistRepository.save({
              vault: vault,
              policy_id: whitelistItem.policyId,
              collection_name:
                typeof whitelistItem.collectionName === 'string'
                  ? whitelistItem.collectionName.slice(0, 255)
                  : whitelistItem.collectionName,
              asset_count_cap_min: whitelistItem?.countCapMin,
              asset_count_cap_max: whitelistItem?.countCapMax,
              valuation_method: whitelistItem?.valuationMethod || 'market',
              custom_price_ada: whitelistItem?.customPriceAda || null,
              lp_pool_onchain_id: lpData?.onchainId || null,
            });
          })
        );
      }

      // Handle acquirer whitelist only if provided
      if (data.acquirerWhitelist !== undefined && data.acquirerWhitelist.length > 0) {
        const manualAcquirer = data.acquirerWhitelist?.map(item => item.walletAddress) || [];
        const allAcquirer = new Set([...manualAcquirer]);

        if (allAcquirer.size > 0) {
          const investorItems = Array.from(allAcquirer).map(walletAddress => {
            return this.acquirerWhitelistRepository.create({
              vault: vault,
              wallet_address: walletAddress,
            });
          });
          await this.acquirerWhitelistRepository.save(investorItems);
        }
      }

      // Handle contributor whitelist only if provided and vault is private
      if (data.contributorWhitelist !== undefined && data.contributorWhitelist.length > 0) {
        const contributorItems = data.contributorWhitelist.map(item => {
          return this.contributorWhitelistRepository.create({
            vault: vault,
            wallet_address: item.walletAddress,
          });
        });
        await this.contributorWhitelistRepository.save(contributorItems);
      }

      return await this.getDraftVaultById(vault.id, userId);
    } catch (error) {
      console.error(error);
      throw new BadRequestException('Failed to save draft vault');
    }
  }

  async deleteDraftedVault(userId: string, vaultId: string): Promise<{ success: boolean }> {
    const canDelete = await this.vaultsRepository.exists({
      where: { id: vaultId, vault_status: VaultStatus.draft, owner: { id: userId } },
    });

    if (canDelete) {
      await this.vaultsRepository.manager.transaction(async manager => {
        await manager
          .createQueryBuilder()
          .delete()
          .from('vault_tags')
          .where('vault_id = :vaultId', { vaultId })
          .execute();

        await manager.delete(Vault, vaultId);
      });

      return { success: true };
    }

    const vault = await this.vaultsRepository.findOne({
      where: { id: vaultId },
      select: ['id', 'vault_status'],
      relations: { owner: true },
    });

    if (!vault) {
      throw new NotFoundException('Vault not found');
    }

    if (vault.vault_status !== VaultStatus.draft) {
      throw new BadRequestException('Cannot delete published vault');
    }

    throw new UnauthorizedException('Vault does not belong to the user');
  }
}
