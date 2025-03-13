import { Injectable, BadRequestException } from '@nestjs/common';
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

      // Process CSV files
      const assetsWhiteListCsvKey = data.assetsWhiteListCsv?.split('csv/')[1];
      const assetsWhiteListCsvFile = assetsWhiteListCsvKey ? await this.filesRepository.findOne({
        where: { file_key: assetsWhiteListCsvKey }
      }) : null;

      const investorsWhiteListCsvKey = data.investorsWhiteListCsv?.split('csv/')[1];
      const investorsWhiteListFile = investorsWhiteListCsvKey ? await this.filesRepository.findOne({
        where: { file_key: investorsWhiteListCsvKey }
      }) : null;
      // Prepare vault data
      const vaultData = this.transformToSnakeCase({
        ...data,
        owner: owner,
        assetWindow: new Date(data.assetWindow).toISOString(),
        investmentWindowDuration: new Date(data.investmentWindowDuration).toISOString(),
        investmentOpenWindowTime: new Date(data.investmentOpenWindowTime).toISOString(),
        contributionOpenWindowTime: new Date(data.contributionOpenWindowTime).toISOString(),
        ftInvestmentWindow: new Date(data.ftInvestmentWindow).toISOString(),
        timeElapsedIsEqualToTime: new Date(data.timeElapsedIsEqualToTime).toISOString(),
        vaultStatus: VaultStatus.published,
        // Ensure FileEntity relationships are preserved by placing them after the spread
        vaultImage: vaultImg,
        bannerImage: bannerImg,
        ftTokenImg: ftTokenImg,
        assetWhitelistCsv: assetsWhiteListCsvFile,
        investorsWhitelistCsv: investorsWhiteListFile
      });
        delete vaultData.assets_whitelist;
      delete vaultData.investors_whitelist

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

      // Handle assets whitelist
      const assetsFromCsv = assetsWhiteListCsvFile ?
        await this.parseCSVFromS3(assetsWhiteListCsvFile.file_key) : [];
      console.log('Assets from CSV:', assetsFromCsv);
      const allAssets = new Set([
        ...data.assetsWhitelist.map(item => item.id),
        ...assetsFromCsv
      ]);

      const assetItems = Array.from(allAssets).map(assetId => {
        return this.assetsWhitelistRepository.save({
          vault: vault,
          asset_id: assetId
        });
      });

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
          if (address && typeof address === 'string' && address.startsWith('0x')) {
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

      // Process CSV files
      const assetsWhiteListCsvKey = data.assetsWhiteListCsv?.split('csv/')[1];
      const assetsWhiteListCsvFile = assetsWhiteListCsvKey ? await this.filesRepository.findOne({
        where: { file_key: assetsWhiteListCsvKey }
      }) : null;

      const investorsWhiteListCsvKey = data.investorsWhiteListCsv?.split('csv/')[1];
      const investorsWhiteListFile = investorsWhiteListCsvKey ? await this.filesRepository.findOne({
        where: { file_key: investorsWhiteListCsvKey }
      }) : null;

      // Prepare vault data
      const vaultData = this.transformToSnakeCase({
        ...data,
        owner: owner,
        assetWindow: new Date(data.assetWindow).toISOString(),
        investmentWindowDuration: new Date(data.investmentWindowDuration).toISOString(),
        investmentOpenWindowTime: new Date(data.investmentOpenWindowTime).toISOString(),
        contributionOpenWindowTime: new Date(data.contributionOpenWindowTime).toISOString(),
        ftInvestmentWindow: new Date(data.ftInvestmentWindow).toISOString(),
        timeElapsedIsEqualToTime: new Date(data.timeElapsedIsEqualToTime).toISOString(),
        vaultStatus: VaultStatus.draft,
        // Ensure FileEntity relationships are preserved by placing them after the spread
        vaultImage: vaultImg,
        bannerImage: bannerImg,
        ftTokenImg: ftTokenImg,
        assetWhitelistCsv: assetsWhiteListCsvFile,
        investorsWhitelistCsv: investorsWhiteListFile
      });

      delete vaultData.assets_whitelist
      delete vaultData.investors_whitelist

      let vault: Vault;
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

      // Handle assets whitelist
      const assetsFromCsv = assetsWhiteListCsvFile ?
        await this.parseCSVFromS3(assetsWhiteListCsvFile.file_key) : [];
      const allAssets = new Set([
        ...data.assetsWhitelist.map(item => item.id),
        ...assetsFromCsv
      ]);

      const assetItems = Array.from(allAssets).map(assetId => {
        return this.assetsWhitelistRepository.create({
          vault: vault,
          asset_id: assetId
        });
      });
      await this.assetsWhitelistRepository.save(assetItems);

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

  async getMyVaults(userId: string, filter?: VaultFilter): Promise<any[]> {
    const query = {
      where: {
        owner: { id: userId }
      },
      relations: ['social_links', 'assets_whitelist', 'investors_whitelist']
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

    const listOfVaults = await this.vaultsRepository.find(query);

    return listOfVaults.map(item => {
      return classToPlain(item)
    })
  }

  async getMyDraftVaults(userId: string): Promise<any[]> {
    const listOfVaults = await  this.vaultsRepository.find({
      where: {
        owner: { id: userId },
        vault_status: VaultStatus.draft
      },
      relations: ['social_links', 'assets_whitelist', 'investors_whitelist']
    });

    return listOfVaults.map(item => {
      return classToPlain(item)
    })
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
      relations: ['owner', 'social_links', 'assets_whitelist', 'investors_whitelist', 'vaultImage', 'bannerImage', 'ftTokenImg']
    });
    return listOfVaults.map(item => {
      return classToPlain(item)
    })
  }
}
