import { Injectable, BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { classToPlain, plainToInstance } from 'class-transformer';
import { Repository } from 'typeorm';

import { transformImageToUrl } from '../../helpers';
import { VaultStatus } from '../../types/vault.types';

import { VaultSortField, SortOrder } from './dto/get-vaults.dto';
import { PaginatedResponseDto } from './dto/paginated-response.dto';
import { SaveDraftReq } from './dto/saveDraft.req';
import { VaultShortResponse } from './dto/vault.response';

import { AcquirerWhitelistEntity } from '@/database/acquirerWhitelist.entity';
import { AssetsWhitelistEntity } from '@/database/assetsWhitelist.entity';
import { ContributorWhitelistEntity } from '@/database/contributorWhitelist.entity';
import { FileEntity } from '@/database/file.entity';
import { LinkEntity } from '@/database/link.entity';
import { TagEntity } from '@/database/tag.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';

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
    private readonly tagsRepository: Repository<TagEntity>
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

    // todo need to create additional model for remove owner, and transform image to link
    return classToPlain(vault);
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
        if (existingVault.social_links?.length > 0) {
          await this.linksRepository.remove(existingVault.social_links);
        }
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

      // Handle social links only if provided
      if (data.socialLinks !== undefined && data.socialLinks.length > 0) {
        const links = data.socialLinks.map(linkItem => {
          return this.linksRepository.create({
            vault: vault,
            name: linkItem.name,
            url: linkItem.url,
          });
        });
        await this.linksRepository.save(links);
      }

      // Handle tags if provided
      if (data.tags?.length > 0) {
        const tags = await Promise.all(
          data.tags.map(async tagName => {
            let tag = await this.tagsRepository.findOne({
              where: { name: tagName },
            });
            if (!tag) {
              tag = await this.tagsRepository.save({
                name: tagName,
              });
            }
            return tag;
          })
        );
        vault.tags = tags;
        await this.vaultsRepository.save(vault);
      }

      // Handle assets whitelist only if provided
      if (data.assetsWhitelist !== undefined && data.assetsWhitelist.length > 0) {
        await Promise.all(
          data.assetsWhitelist.map(whitelistItem => {
            return this.assetsWhitelistRepository.save({
              vault: vault,
              policy_id: whitelistItem.policyId,
              asset_count_cap_min: whitelistItem?.countCapMin,
              asset_count_cap_max: whitelistItem?.countCapMax,
              valuation_method: whitelistItem?.valuationMethod || 'market',
              custom_price_ada: whitelistItem?.customPriceAda || null,
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
      await this.vaultsRepository.delete(vaultId);
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
