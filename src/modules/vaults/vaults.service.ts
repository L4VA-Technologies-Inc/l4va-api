import {Injectable, BadRequestException, UnauthorizedException} from '@nestjs/common';
import { ValuationType, VaultPrivacy } from '../../types/vault.types';
import { InjectRepository } from '@nestjs/typeorm';
import {In, Repository} from 'typeorm';
import { Vault } from '../../database/vault.entity';
import { CreateVaultReq } from './dto/createVault.req';
import { SaveDraftReq } from './dto/saveDraft.req';
import { User } from '../../database/user.entity';
import { VaultStatus } from '../../types/vault.types';
import { LinkEntity } from '../../database/link.entity';
import { FileEntity } from '../../database/file.entity';
import { AssetsWhitelistEntity } from '../../database/assetsWhitelist.entity';
import { InvestorsWhitelistEntity } from '../../database/investorsWhitelist.entity';
import * as csv from 'csv-parse';
import { AwsService } from '../aws_bucket/aws.service';
import { snakeCase } from 'typeorm/util/StringUtils';
import {classToPlain} from "class-transformer";
import { VaultFilter, VaultSortField, SortOrder } from './dto/get-vaults.dto';
import { PaginatedResponseDto } from './dto/paginated-response.dto';
import { TagEntity } from '../../database/tag.entity';

@Injectable()
export class VaultsService {
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
    private readonly investorsWhiteListRepository: Repository<InvestorsWhitelistEntity>,
    @InjectRepository(TagEntity)
    private readonly tagsRepository: Repository<TagEntity>,
    private readonly awsService: AwsService
  ) {}

  private transformImageToUrl(imageEntity: FileEntity | null): string | null {
    return imageEntity?.file_url || null;
  }

  private transformToSnakeCase(obj: any): any {
    if (Array.isArray(obj)) {
      return obj.map(item => this.transformToSnakeCase(item));
    }
    if (obj !== null && typeof obj === 'object' && !(obj instanceof Date) && !(obj instanceof FileEntity) && !(obj instanceof User)) {
      return Object.keys(obj).reduce((acc, key) => {
        const snakeKey = snakeCase(key);
        acc[snakeKey] = this.transformToSnakeCase(obj[key]);
        return acc;
      }, {});
    }
    return obj;
  }

  private async parseCSVFromS3(file_key: string): Promise<string[]> {
    try {
      const csvStream = await this.awsService.getCsv(file_key);
      const csvData = await csvStream.data.toArray();
      const csvString = Buffer.concat(csvData).toString();

      return new Promise((resolve, reject) => {
        const results: string[] = [];
        csv.parse(csvString, {
          columns: false,
          skip_empty_lines: true,
          trim: true
        })
        .on('data', (data) => {
          const address = data[0];
          if (address && typeof address === 'string' && /^addr1[a-zA-Z0-9]{98}$/.test(address)) {
            results.push(address);
          }
        })
        .on('end', () => resolve(results))
        .on('error', (error) => reject(error));
      });
    } catch (error) {
      console.error('Error parsing CSV from S3:', error);
      throw new BadRequestException('Failed to parse CSV file from S3');
    }
  }



  async createVault(userId: string, data: CreateVaultReq): Promise<any> {
    try {
      const owner = await this.usersRepository.findOne({
        where: { id: userId }
      });

      if (!owner) {
        throw new UnauthorizedException('User was not authorized!');
      }

      // Validate valuation type based on privacy setting
      if (data.privacy === VaultPrivacy.public && data.valuationType !== ValuationType.lbe) {
        throw new BadRequestException('Public vaults can only use LBE valuation type');
      }
      if ((data.privacy === VaultPrivacy.private || data.privacy === VaultPrivacy.semiPrivate) &&
          ![ValuationType.lbe, ValuationType.fixed].includes(data.valuationType)) {
        throw new BadRequestException('Private and semi-private vaults can use either LBE or fixed valuation type');
      }

      // Validate required fields for fixed valuation type
      if (data.valuationType === ValuationType.fixed) {
        if (!data.valuationCurrency) {
          throw new BadRequestException('Valuation currency is required when using fixed valuation type');
        }
        if (!data.valuationAmount) {
          throw new BadRequestException('Valuation amount is required when using fixed valuation type');
        }
      }

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

      const investorsWhiteListCsvKey = data.investorsWhiteListCsv?.split('csv/')[1];
      const investorsWhiteListFile = investorsWhiteListCsvKey ? await this.filesRepository.findOne({
        where: { file_key: investorsWhiteListCsvKey }
      }) : null;

      // Prepare vault data
      const vaultData = this.transformToSnakeCase({
        ...data,
        owner: owner,
        contributionDuration: data.contributionDuration,
        investmentWindowDuration: data.investmentWindowDuration,
        investmentOpenWindowTime: new Date(data.investmentOpenWindowTime).toISOString(),
        contributionOpenWindowTime: new Date(data.contributionOpenWindowTime).toISOString(),
        timeElapsedIsEqualToTime: data.timeElapsedIsEqualToTime,
        vaultStatus: VaultStatus.published,
        vaultImage: vaultImg,
        bannerImage: bannerImg,
        ftTokenImg: ftTokenImg,
        investorsWhitelistCsv: investorsWhiteListFile
      });

      delete vaultData.assets_whitelist;
      delete vaultData.investors_whitelist;
      delete vaultData.tags;

      const newVault = await this.vaultsRepository.save(vaultData as Vault);

      // Handle social links
      if (data.socialLinks?.length > 0) {
        const links = data.socialLinks.map(linkItem => {
          return this.linksRepository.create({
            vault: newVault,
            name: linkItem.name,
            url: linkItem.url
          });
        });
        await this.linksRepository.save(links);
      }

      // Handle assets whitelist
      if (data.assetsWhitelist?.length > 0) {
        await Promise.all(data.assetsWhitelist.map(assetItem => {
          return this.assetsWhitelistRepository.save({
            vault: newVault,
            policy_id: assetItem.id,
            asset_count_cap_min: assetItem.countCapMin,
            asset_count_cap_max: assetItem.countCapMax
          });
        }));
      }

      // Handle investors whitelist
      const investorsFromCsv = investorsWhiteListFile ?
        await this.parseCSVFromS3(investorsWhiteListFile.file_key) : [];

      const allInvestors = new Set([
        ...data.investorsWhiteList.map(item => item.wallet_address),
        ...investorsFromCsv
      ]);

      await Promise.all(Array.from(allInvestors).map(walletAddress => {
        return this.investorsWhiteListRepository.save({
          vault: newVault,
          wallet_address: walletAddress
        });
      }));

      // Handle tags
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
        newVault.tags = tags;
        await this.vaultsRepository.save(newVault);
      }

      const finalVault = await this.vaultsRepository.findOne({
        where: { id: newVault.id },
        relations: ['owner', 'social_links', 'assets_whitelist', 'investors_whitelist', 'tags', 'vault_image', 'banner_image', 'ft_token_img']
      });

      if (!finalVault) {
        throw new BadRequestException('Failed to retrieve created vault');
      }

      // Transform image entities to URLs
      finalVault.vault_image = this.transformImageToUrl(finalVault.vault_image as FileEntity) as any;
      finalVault.banner_image = this.transformImageToUrl(finalVault.banner_image as FileEntity) as any;
      finalVault.ft_token_img = this.transformImageToUrl(finalVault.ft_token_img as FileEntity) as any;

      return classToPlain(finalVault);
    } catch (error) {
      console.error(error);
      throw new BadRequestException('Failed to create vault');
    }
  }



  async saveDraftVault(userId: string, data: SaveDraftReq): Promise<any> {
    let existingVault: Vault | null = null;

    // Check for existing draft vault if ID is provided
    if (data.id) {
      existingVault = await this.vaultsRepository.findOne({
        where: {
          id: data.id,
          vault_status: VaultStatus.draft,
          owner: { id: userId }
        },
        relations: ['owner', 'social_links', 'assets_whitelist', 'investors_whitelist']
      });

      // If found but not a draft, throw error
      if (existingVault && existingVault.vault_status !== VaultStatus.draft) {
        throw new BadRequestException('Cannot modify a published vault');
      }

      // If found and is draft, remove existing relationships
      if (existingVault) {
        if (existingVault.social_links?.length > 0) {
          await this.linksRepository.remove(existingVault.social_links);
        }
        if (existingVault.assets_whitelist?.length > 0) {
          await this.assetsWhitelistRepository.remove(existingVault.assets_whitelist);
        }
        if (existingVault.investors_whitelist?.length > 0) {
          await this.investorsWhiteListRepository.remove(existingVault.investors_whitelist);
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

      const investorsWhiteListCsvKey = data.investorsWhiteListCsv?.split('csv/')[1];
      const investorsWhiteListFile = investorsWhiteListCsvKey ? await this.filesRepository.findOne({
        where: { file_key: investorsWhiteListCsvKey }
      }) : null;

      // Prepare vault data with only the provided fields
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

      // Handle date fields only if they are provided
      if (data.contributionDuration !== undefined) {
        vaultData.contribution_duration = data.contributionDuration;
      }
      if (data.investmentWindowDuration !== undefined) {
        vaultData.investment_window_duration = data.investmentWindowDuration;
      }
      if (data.investmentOpenWindowTime !== undefined) {
        vaultData.investment_open_window_time = new Date(data.investmentOpenWindowTime).toISOString();
      }
      if (data.contributionOpenWindowTime !== undefined) {
        vaultData.contribution_open_window_time = new Date(data.contributionOpenWindowTime).toISOString();
      }
      if (data.timeElapsedIsEqualToTime !== undefined) {
        vaultData.time_elapsed_is_equal_to_time = data.timeElapsedIsEqualToTime;
      }

      // Handle file relationships only if provided
      if (vaultImg) vaultData.vault_image = vaultImg;
      if (bannerImg) vaultData.banner_image = bannerImg;
      if (ftTokenImg) vaultData.ft_token_img = ftTokenImg;
      if (investorsWhiteListFile) vaultData.investors_whitelist_csv = investorsWhiteListFile;

      let vault: Vault;
      if (existingVault) {
        // Update only the provided fields in existing draft vault
        vault = await this.vaultsRepository.save({
          ...existingVault,
          ...vaultData
        }) as Vault;
      } else {
        // Create new draft vault with provided fields
        vault = await this.vaultsRepository.save(vaultData as Vault);
      }

      // Handle social links only if provided
      if (data.socialLinks !== undefined) {
        if (data.socialLinks.length > 0) {
          const links = data.socialLinks.map(linkItem => {
            return this.linksRepository.create({
              vault: vault,
              name: linkItem.name,
              url: linkItem.url
            });
          });
          await this.linksRepository.save(links);
        }
      }

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
            policy_id: whitelistItem.id,
            asset_count_cap_min: whitelistItem?.countCapMin,
            asset_count_cap_max: whitelistItem?.countCapMax
          });
        }));
      }

      // Handle investors whitelist only if provided
      if (data.investorsWhiteList !== undefined || investorsWhiteListFile) {
        const investorsFromCsv = investorsWhiteListFile ?
          await this.parseCSVFromS3(investorsWhiteListFile.file_key) : [];

        const manualInvestors = data.investorsWhiteList?.map(item => item.wallet_address) || [];
        const allInvestors = new Set([...manualInvestors, ...investorsFromCsv]);

        if (allInvestors.size > 0) {
          const investorItems = Array.from(allInvestors).map(walletAddress => {
            return this.investorsWhiteListRepository.create({
              vault: vault,
              wallet_address: walletAddress
            });
          });
          await this.investorsWhiteListRepository.save(investorItems);
        }
      }

      return await this.prepareDraftResponse(vault.id)
    } catch (error) {
      console.error(error);
      throw new BadRequestException('Failed to create vault');
    }
  }

  async getMyVaults(userId: string, filter?: VaultFilter, page: number = 1, limit: number = 10, sortBy?: VaultSortField, sortOrder: SortOrder = SortOrder.DESC): Promise<PaginatedResponseDto<any>> {
    const query = {
      where: {
        owner: { id: userId }
      },
      relations: ['social_links', 'assets_whitelist', 'investors_whitelist', 'vault_image', 'banner_image', 'ft_token_img'],
      skip: (page - 1) * limit,
      take: limit,
      order: {}
    };

    if (filter === VaultFilter.open) {
      query.where['vault_status'] = In([
        VaultStatus.published,
        VaultStatus.contribution,
        VaultStatus.investment
      ]);
    } else if (filter === VaultFilter.locked) {
      query.where['vault_status'] = VaultStatus.locked;
    }

    // Add sorting if specified
    if (sortBy) {
      query.order[sortBy] = sortOrder;
    } else {
      // Default sort by created_at DESC if no sort specified
      query.order['created_at'] = SortOrder.DESC;
    }

    const [listOfVaults, total] = await this.vaultsRepository.findAndCount(query);

    return {
      items: listOfVaults.map(item => {
        // Transform image entities to URLs
        item.vault_image = this.transformImageToUrl(item.vault_image as FileEntity) as any;
        item.banner_image = this.transformImageToUrl(item.banner_image as FileEntity) as any;
        item.ft_token_img = this.transformImageToUrl(item.ft_token_img as FileEntity) as any;
        return classToPlain(item);
      }),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    };
  }

  async getMyDraftVaults(userId: string, page: number = 1, limit: number = 10): Promise<PaginatedResponseDto<any>> {
    const [listOfVaults, total] = await this.vaultsRepository.findAndCount({
      where: {
        owner: { id: userId },
        vault_status: VaultStatus.draft
      },
      relations: ['social_links', 'assets_whitelist', 'investors_whitelist'],
      skip: (page - 1) * limit,
      take: limit
    });

    return {
      items: listOfVaults.map(item => classToPlain(item)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    };
  }



  async prepareDraftResponse(id: string) {
    const vault = await this.vaultsRepository.findOne({
      where: { id },
      relations: ['owner', 'social_links', 'investors_whitelist',
        'tags', 'vault_image', 'banner_image', 'ft_token_img']
    });

    if (!vault) {
      throw new BadRequestException('Vault not found');
    }

    // Transform image entities to URLs before converting to plain object
    vault.vault_image = this.transformImageToUrl(vault.vault_image as FileEntity) as any;
    vault.banner_image = this.transformImageToUrl(vault.banner_image as FileEntity) as any;
    vault.ft_token_img = this.transformImageToUrl(vault.ft_token_img as FileEntity) as any;

    return classToPlain(vault);
  }


  async getVaultById(id: string, userId: string): Promise<any> {
    const vault = await this.vaultsRepository.findOne({
      where: { id },
      relations: ['owner', 'social_links', 'assets_whitelist', 'investors_whitelist', 'vault_image', 'banner_image', 'ft_token_img']
    });

    if (!vault) {
      throw new BadRequestException('Vault not found');
    }

    if (vault.owner.id !== userId) {
      throw new BadRequestException('Access denied: You are not the owner of this vault');
    }

    // Transform image entities to URLs
    vault.vault_image = this.transformImageToUrl(vault.vault_image as FileEntity) as any;
    vault.banner_image = this.transformImageToUrl(vault.banner_image as FileEntity) as any;
    vault.ft_token_img = this.transformImageToUrl(vault.ft_token_img as FileEntity) as any;

    return classToPlain(vault);
  }

  async getVaults(filter?: VaultFilter, page: number = 1, limit: number = 10, sortBy?: VaultSortField, sortOrder: SortOrder = SortOrder.DESC): Promise<PaginatedResponseDto<any>> {
    const queryBuilder = this.vaultsRepository.createQueryBuilder('vault')
      .leftJoinAndSelect('vault.social_links', 'social_links')
      .leftJoinAndSelect('vault.assets_whitelist', 'assets_whitelist')
      .leftJoinAndSelect('vault.vault_image', 'vault_image')
      .leftJoinAndSelect('vault.banner_image', 'banner_image')
      .leftJoinAndSelect('vault.ft_token_img', 'ft_token_img')
      .leftJoinAndSelect('vault.tags', 'tags')
      .where('vault.vault_status != :draftStatus', { draftStatus: VaultStatus.draft })
      // Only show public vaults in the public listing
      .andWhere('vault.privacy = :privacy', { privacy: VaultPrivacy.public });

    // Apply status filter if provided
    if (filter === VaultFilter.open) {
      queryBuilder.andWhere('vault.vault_status IN (:...statuses)', {
        statuses: [VaultStatus.published, VaultStatus.contribution, VaultStatus.investment]
      });
    } else if (filter === VaultFilter.locked) {
      queryBuilder.andWhere('vault.vault_status = :status', { status: VaultStatus.locked });
    }

    // Apply sorting
    if (sortBy) {
      queryBuilder.orderBy(`vault.${sortBy}`, sortOrder);
    } else {
      // Default sort by created_at DESC
      queryBuilder.orderBy('vault.created_at', SortOrder.DESC);
    }

    // Add pagination and ordering
    queryBuilder
      .orderBy('vault.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [listOfVaults, total] = await queryBuilder.getManyAndCount();

    return {
      items: listOfVaults.map(item => {
        // Transform image entities to URLs
        item.vault_image = this.transformImageToUrl(item.vault_image as FileEntity) as any;
        item.banner_image = this.transformImageToUrl(item.banner_image as FileEntity) as any;
        item.ft_token_img = this.transformImageToUrl(item.ft_token_img as FileEntity) as any;
        return classToPlain(item);
      }),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    };
  }
}
