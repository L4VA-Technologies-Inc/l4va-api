import {Injectable, BadRequestException, UnauthorizedException} from '@nestjs/common';
import { ValuationType, VaultPrivacy } from '../../types/vault.types';
import { InjectRepository } from '@nestjs/typeorm';
import {In, Repository} from 'typeorm';
import { Vault } from '../../database/vault.entity';
import { CreateVaultReq } from './dto/createVault.req';
import { User } from '../../database/user.entity';
import { SaveDraftReq } from './dto/saveDraft.req';
import { VaultStatus } from '../../types/vault.types';
import { LinkEntity } from '../../database/link.entity';
import { FileEntity } from '../../database/file.entity';
import { AssetsWhitelistEntity } from '../../database/assetsWhitelist.entity';
import { InvestorsWhitelistEntity } from '../../database/investorsWhitelist.entity';
import * as csv from 'csv-parse';
import { AwsService } from '../aws_bucket/aws.service';
import { snakeCase } from 'typeorm/util/StringUtils';
import {classToPlain} from "class-transformer";
import { VaultFilter } from './dto/get-vaults.dto';
import { PaginatedResponseDto } from './dto/paginated-response.dto';
import { AssetWhiteList } from './types';
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

  async createVault(userId: string, data: CreateVaultReq): Promise<any> {
    try {
      let vault: Vault;

      // If vault ID is provided, try to find an existing draft vault
      if (data.id) {
        vault = await this.vaultsRepository.findOne({
          where: {
            id: data.id,
            vault_status: VaultStatus.draft,
            owner: { id: userId }
          },
          relations: ['owner', 'social_links', 'assets_whitelist', 'investors_whitelist']
        });

        if (vault) {
          // Only update the vault status to published, preserve all other fields
          await this.vaultsRepository.update(
            { id: vault.id },
            { vault_status: VaultStatus.published }
          );
          return await this.vaultsRepository.findOne({
            where: { id: vault.id },
            relations: ['owner', 'social_links', 'assets_whitelist', 'investors_whitelist']
          });
        }
      }

      // If no draft vault found or no ID provided, create a new published vault
      const owner = await this.usersRepository.findOne({
        where: { id: userId }
      });

      if(!owner){
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
        // Ensure FileEntity relationships are preserved by placing them after the spread
        vaultImage: vaultImg,
        bannerImage: bannerImg,
        ftTokenImg: ftTokenImg,
        investorsWhitelistCsv: investorsWhiteListFile
      });
        delete vaultData.assets_whitelist;
      delete vaultData.investors_whitelist;
      delete vaultData.tags;

        vault = await this.vaultsRepository.save(vaultData as Vault);

      // Handle social links
      if (data.socialLinks?.length > 0) {
        const links = data.socialLinks.map(linkItem => {
          return this.linksRepository.create({
            vault: vault,
            name: linkItem.name,
            url: linkItem.url
          });
        });
        await this.linksRepository.save(links);
      }

      if(data.assetsWhitelist.length > 0){
      data.assetsWhitelist.map(assetItem => {
          return this.assetsWhitelistRepository.save({
            vault: vault,
            policy_id: assetItem.id,
            asset_count_cap_min: assetItem.countCapMin,
            asset_count_cap_max: assetItem.countCapMax
          });
        });
      }


      // Handle investors whitelist
      const investorsFromCsv = investorsWhiteListFile ?
        await this.parseCSVFromS3(investorsWhiteListFile.file_key) : [];
      console.log('Investors from CSV:', investorsFromCsv);
      const allInvestors = new Set([
        ...data.investorsWhiteList.map(item => item.wallet_address),
        ...investorsFromCsv
      ]);

       Array.from(allInvestors).map(walletAddress => {
        return this.investorsWhiteListRepository.save({
          vault: vault,
          wallet_address: walletAddress
        });
      });

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
        vault.tags = tags;
        await this.vaultsRepository.save(vault);
      }

      return classToPlain(vault);
    } catch (error) {
      console.error(error);
      throw new BadRequestException('Failed to create vault');
    }
  }

  private async parseCSVFromS3(file_key: string): Promise<string[]> {
    try {
      const csvStream = await this.awsService.getCsv(file_key);
      const csvData = await csvStream.data.toArray();
      const csvString = Buffer.concat(csvData).toString();

      return new Promise((resolve, reject) => {
        const results: string[] = [];
        csv.parse(csvString, {
          columns: false, // No column headers in the CSV
          skip_empty_lines: true,
          trim: true // Remove any whitespace
        })
        .on('data', (data) => {
          // Each row is an array with a single address
          const address = data[0];
          if (address && typeof address === 'string' && /^addr1[a-zA-Z0-9]{98}$/.test(address)) {
            results.push(address);
          }
        })
        .on('end', () => {
          console.log('Parsed addresses:', results);
          resolve(results);
        })
        .on('error', (error) => reject(error));
      });
    } catch (error) {
      console.error('Error parsing CSV from S3:', error);
      throw new BadRequestException('Failed to parse CSV file from S3');
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

      // Prepare vault data
      const vaultData = this.transformToSnakeCase({
        ...data,
        owner: owner,
        contributionDuration: data.contributionDuration,
        investmentWindowDuration: new Date(data.investmentWindowDuration).toISOString(),
        investmentOpenWindowTime: new Date(data.investmentOpenWindowTime).toISOString(),
        contributionOpenWindowTime: new Date(data.contributionOpenWindowTime).toISOString(),

        timeElapsedIsEqualToTime: new Date(data.timeElapsedIsEqualToTime).toISOString(),
        vaultStatus: VaultStatus.draft,
        // Ensure FileEntity relationships are preserved by placing them after the spread
        vaultImage: vaultImg,
        bannerImage: bannerImg,
        ftTokenImg: ftTokenImg,
        investorsWhitelistCsv: investorsWhiteListFile
      });

      delete vaultData.assets_whitelist
      delete vaultData.investors_whitelist

      let vault: Vault;
      // Remove asset count cap fields as they are now in AssetsWhitelist

      if (existingVault) {
        // Update existing draft vault
        Object.assign(existingVault, vaultData);
        vault = await this.vaultsRepository.save(existingVault);
      } else {
        // Create new draft vault
        vault = await this.vaultsRepository.save(vaultData as Vault);
      }

      // Handle social links
      if (data.socialLinks?.length > 0) {
        const links = data.socialLinks.map(linkItem => {
          return this.linksRepository.create({
            vault: vault,
            name: linkItem.name,
            url: linkItem.url
          });
        });
        await this.linksRepository.save(links);
      }

      if(data.assetsWhitelist.length > 0){
        data.assetsWhitelist.map(whitelistItem => {
          // Find matching whitelist item from request data

          // Create the whitelist entity with properly transformed property names
          this.assetsWhitelistRepository.save({
            vault: vault,
            policy_id: whitelistItem.id,
            asset_count_cap_min: whitelistItem?.countCapMin,  // Optional field
            asset_count_cap_max: whitelistItem?.countCapMax   // Optional field
          });
        });
      }
      // Handle investors whitelist
      const investorsFromCsv = investorsWhiteListFile ?
        await this.parseCSVFromS3(investorsWhiteListFile.file_key) : [];
      console.log('Investors from CSV:', investorsFromCsv);
      const allInvestors = new Set([
        ...data.investorsWhiteList.map(item => item.wallet_address),
        ...investorsFromCsv
      ]);

      const investorItems = Array.from(allInvestors).map(walletAddress => {
        return this.investorsWhiteListRepository.create({
          vault: vault,
          wallet_address: walletAddress
        });
      });
      await this.investorsWhiteListRepository.save(investorItems);

      return classToPlain(vault);
    } catch (error) {
      console.error(error);
      throw new BadRequestException('Failed to create vault');
    }
  }

  async getMyVaults(userId: string, filter?: VaultFilter, page: number = 1, limit: number = 10): Promise<PaginatedResponseDto<any>> {
    const query = {
      where: {
        owner: { id: userId }
      },
      relations: ['social_links', 'assets_whitelist', 'investors_whitelist'],
      skip: (page - 1) * limit,
      take: limit
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

    const [listOfVaults, total] = await this.vaultsRepository.findAndCount(query);

    return {
      items: listOfVaults.map(item => classToPlain(item)),
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

  async getVaultById(id: string, userId: string): Promise<any> {
    const vault = await this.vaultsRepository.findOne({
      where: { id },
      relations: ['owner', 'social_links', 'assets_whitelist', 'investors_whitelist', 'vaultImage', 'bannerImage', 'ftTokenImg']
    });

    if (!vault) {
      throw new BadRequestException('Vault not found');
    }

    if (vault.owner.id !== userId) {
      throw new BadRequestException('Access denied: You are not the owner of this vault');
    }

    return classToPlain(vault);
  }

  async getVaults(userId: string): Promise<any[]> {
    const listOfVaults = await  this.vaultsRepository.find({
      where: {
        owner: { id: userId }
      },
      relations: ['owner', 'social_links', 'assets_whitelist', 'investors_whitelist', 'vault_image', 'banner_image', 'ft_token_img']
    });
    return listOfVaults.map(item => {
      return classToPlain(item)
    })
  }
}
