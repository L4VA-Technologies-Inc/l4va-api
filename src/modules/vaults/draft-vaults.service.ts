import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { classToPlain, plainToInstance } from 'class-transformer';
import { Vault } from '../../database/vault.entity';
import { User } from '../../database/user.entity';
import { FileEntity } from '../../database/file.entity';
import { LinkEntity } from '../../database/link.entity';
import { AssetsWhitelistEntity } from '../../database/assetsWhitelist.entity';
import { InvestorsWhitelistEntity } from '../../database/investorsWhitelist.entity';
import { ContributorWhitelistEntity } from '../../database/contributorWhitelist.entity';
import { TagEntity } from '../../database/tag.entity';
import { SaveDraftReq } from './dto/saveDraft.req';
import { VaultStatus } from '../../types/vault.types';
import { VaultSortField, SortOrder } from './dto/get-vaults.dto';
import { PaginatedResponseDto } from './dto/paginated-response.dto';
import { AwsService } from '../aws_bucket/aws.service';
import { transformImageToUrl } from '../../helpers';
import {VaultFullResponse, VaultShortResponse} from './dto/vault.response';

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
    @InjectRepository(InvestorsWhitelistEntity)
    private readonly investorsWhitelistRepository: Repository<InvestorsWhitelistEntity>,
    @InjectRepository(ContributorWhitelistEntity)
    private readonly contributorWhitelistRepository: Repository<ContributorWhitelistEntity>,
    @InjectRepository(TagEntity)
    private readonly tagsRepository: Repository<TagEntity>,
    private readonly awsService: AwsService
  ) {}


  async getMyDraftVaults(userId: string, page: number = 1, limit: number = 10, sortBy?: VaultSortField, sortOrder: SortOrder = SortOrder.DESC): Promise<PaginatedResponseDto<VaultShortResponse>> {
    const query = {
      where: {
        owner: { id: userId },
        vault_status: VaultStatus.draft
      },
      relations: ['social_links', 'vault_image', 'banner_image', 'ft_token_img'],
      skip: (page - 1) * limit,
      take: limit,
      order: {}
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
      totalPages: Math.ceil(total / limit)
    };
  }

  async getDraftVaultById(id: string, userId: string): Promise<any> {
    const vault = await this.vaultsRepository.findOne({
      where: {
        id,
        vault_status: VaultStatus.draft,
        owner: { id: userId }
      },
      relations: ['owner', 'social_links', 'assets_whitelist', 'investors_whitelist', 'contributor_whitelist', 'vault_image', 'banner_image', 'ft_token_img', 'investors_whitelist_csv']
    });

    if (!vault) {
      throw new BadRequestException('Draft vault not found');
    }

    // Transform image entities to URLs
    vault.vault_image = transformImageToUrl(vault.vault_image as FileEntity) as any;
    vault.banner_image = transformImageToUrl(vault.banner_image as FileEntity) as any;
    vault.ft_token_img = transformImageToUrl(vault.ft_token_img as FileEntity) as any;
    delete vault.owner
    delete vault.contribution_phase_start
    delete vault.investment_phase_start
    delete vault.locked_at

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
          owner: { id: userId }
        },
        relations: ['owner', 'social_links', 'assets_whitelist', 'investors_whitelist', 'investors_whitelist_csv', 'vault_image', 'banner_image', 'ft_token_img']
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
        if (existingVault.investors_whitelist?.length > 0) {
          await this.investorsWhitelistRepository.remove(existingVault.investors_whitelist);
        }
        if (existingVault.contributor_whitelist?.length > 0) {
          await this.contributorWhitelistRepository.remove(existingVault.contributor_whitelist);
        }
      }
    }

    try {
      const owner = await this.usersRepository.findOne({
        where: { id: userId }
      });

      // Process image files
      const imgKey = data.vaultImage?.split('image/')[1];
      const vaultImg = imgKey ? await this.filesRepository.findOne({
        where: { file_key: imgKey }
      }) : null;

      const bannerImgKey = data.bannerImage?.split('image/')[1];
      const bannerImg = bannerImgKey ? await this.filesRepository.findOne({
        where: { file_key: bannerImgKey }
      }) : null;

      const ftTokenImgKey = data.ftTokenImg?.split('image/')[1];
      const ftTokenImg = ftTokenImgKey ? await this.filesRepository.findOne({
        where: { file_key: ftTokenImgKey }
      }) : null;

      const investorsWhitelistCsvKey = data.investorsWhitelistCsv?.key;
      const investorsWhitelistFile = investorsWhitelistCsvKey ? await this.filesRepository.findOne({
        where: { file_key: investorsWhitelistCsvKey }
      }) : null;

      // Check if the vault already has these files to avoid duplicate relations
      const hasVaultImage = existingVault?.vault_image?.file_key === imgKey;
      const hasBannerImage = existingVault?.banner_image?.file_key === bannerImgKey;
      const hasFtTokenImage = existingVault?.ft_token_img?.file_key === ftTokenImgKey;
      const hasInvestorsWhitelistCsv = existingVault?.investors_whitelist_csv?.file_key === investorsWhitelistCsvKey;

      const vaultData: any = {
        owner: owner,
        vault_status: VaultStatus.draft
      };

      // Only include fields that are actually provided
      if (data.name !== undefined) vaultData.name = data.name;
      if (data.type !== undefined) vaultData.type = data.type;
      if (data.privacy !== undefined) vaultData.privacy = data.privacy;
      if (data.valuationType !== undefined) vaultData.valuation_type = data.valuationType;
      if (data.valuationCurrency !== undefined) vaultData.valuation_currency = data.valuationCurrency;
      if (data.valuationAmount !== undefined) vaultData.valuation_amount = data.valuationAmount;
      if (data.description !== undefined) vaultData.description = data.description;
      if(data.ftTokenDecimals) vaultData.ft_token_decimals = data.ftTokenDecimals;
      if(data.ftTokenSupply) vaultData.ft_token_supply = data.ftTokenSupply;
      if(data.terminationType) vaultData.termination_type = data.terminationType;
      if(data.ftTokenTicker) vaultData.ft_token_ticker = data.ftTokenTicker;
      if(data.offAssetsOffered) vaultData.off_assets_offered = data.offAssetsOffered;
      if(data.ftInvestmentReserve) vaultData.ft_investment_reserve = data.ftInvestmentReserve;
      if(data.liquidityPoolContribution) vaultData.liquidity_pool_contribution = data.liquidityPoolContribution;
      if(data.creationThreshold) vaultData.creation_threshold = data.creationThreshold;
      if(data.startThreshold) vaultData.start_threshold = data.startThreshold;
      if(data.voteThreshold) vaultData.vote_threshold = data.voteThreshold;
      if(data.executionThreshold) vaultData.execution_threshold = data.executionThreshold;
      if(data.cosigningThreshold) vaultData.cosigning_threshold = data.cosigningThreshold;
      if(data.vaultAppreciation) vaultData.vault_appreciation = data.vaultAppreciation


      if (data.contributionDuration !== undefined) {
        vaultData.contribution_duration = data.contributionDuration;
      }
      if (data.investmentWindowDuration !== undefined) {
        vaultData.investment_window_duration = data.investmentWindowDuration;
      }
      if (data.investmentOpenWindowTime !== undefined && data.investmentOpenWindowTime !== null) {
        vaultData.investment_open_window_time = new Date(data.investmentOpenWindowTime).toISOString();
      }
      if (data.investmentOpenWindowType !== undefined && data.investmentOpenWindowType !== null) {
        vaultData.investment_open_window_type = data.investmentOpenWindowType;
      }
      if (data.contributionOpenWindowTime !== undefined && data.contributionOpenWindowTime !== null) {
        vaultData.contribution_open_window_time = new Date(data.contributionOpenWindowTime).toISOString();
      }
      if (data.contributionOpenWindowType !== undefined && data.contributionOpenWindowType !== null) {
        vaultData.contribution_open_window_type = data.contributionOpenWindowType
      }
      if (data.timeElapsedIsEqualToTime !== undefined && data.timeElapsedIsEqualToTime !== null) {
        vaultData.time_elapsed_is_equal_to_time = data.timeElapsedIsEqualToTime;
      }

      // Handle file relationships only if provided and not already set
      if (vaultImg && !hasVaultImage) vaultData.vault_image = vaultImg;
      if (bannerImg && !hasBannerImage) vaultData.banner_image = bannerImg;
      if (ftTokenImg && !hasFtTokenImage) vaultData.ft_token_img = ftTokenImg;
      if (investorsWhitelistFile && !hasInvestorsWhitelistCsv) vaultData.investors_whitelist_csv = investorsWhitelistFile;

      let vault: Vault;
      if (existingVault) {
        vault = await this.vaultsRepository.save({
          ...existingVault,
          ...vaultData
        }) as Vault;
      } else {
        vault = await this.vaultsRepository.save(vaultData as Vault);
      }

      // Handle social links only if provided
      if (data.socialLinks !== undefined && data.socialLinks.length > 0) {
        const links = data.socialLinks.map(linkItem => {
          return this.linksRepository.create({
            vault: vault,
            name: linkItem.name,
            url: linkItem.url
          });
        });
        await this.linksRepository.save(links);
      }

      // Handle tags if provided
      if (data.tags?.length > 0) {
        const tags = await Promise.all(
          data.tags.map(async (tagData) => {
            let tag = await this.tagsRepository.findOne({
              where: { name: tagData.name }
            });
            if (!tag) {
              tag = await this.tagsRepository.save({
                name: tagData.name
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
        await Promise.all(data.assetsWhitelist.map(whitelistItem => {
          return this.assetsWhitelistRepository.save({
            vault: vault,
            policy_id: whitelistItem.policyId,
            asset_count_cap_min: whitelistItem?.countCapMin,
            asset_count_cap_max: whitelistItem?.countCapMax
          });
        }));
      }

      // Handle investors whitelist only if provided
      if (data.investorsWhitelist !== undefined && data.investorsWhitelist.length > 0) {
        const manualInvestors = data.investorsWhitelist?.map(item => item.walletAddress) || [];
        const allInvestors = new Set([...manualInvestors]);

        if (allInvestors.size > 0) {
          const investorItems = Array.from(allInvestors).map(walletAddress => {
            return this.investorsWhitelistRepository.create({
              vault: vault,
              wallet_address: walletAddress
            });
          });
          await this.investorsWhitelistRepository.save(investorItems);
        }
      }

      // Handle contributor whitelist only if provided and vault is private
      if (data.whitelistContributors !== undefined && data.whitelistContributors.length > 0) {
        const contributorItems = data.whitelistContributors.map(item => {
          return this.contributorWhitelistRepository.create({
            vault: vault,
            wallet_address: item.policyId
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
}
