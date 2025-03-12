import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Vault } from '../../database/vault.entity';
import { CreateVaultReq } from './dto/createVault.req';
import { User } from '../../database/user.entity';
import { SaveDraftReq } from './dto/saveDraft.req';
import { VaultStatus } from '../../types/vault.types';
import { LinkEntity } from '../../database/link.entity';
import { FileEntity } from '../../database/file.entity';
import { AssetsWhitelistEntity } from '../../database/assetsWhitelist.entity';
import { InvestorsWhitelistEntity } from '../../database/investorsWhitelist.entity';
import { mapCamelToSnake } from '../../helpers/mapCamelToSnake';
import * as csv from 'csv-parse';
import { AwsService } from '../aws_bucket/aws.service';

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

  async createVault(userId: string, data: CreateVaultReq): Promise<Vault> {
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
        where: { key: imgKey }
      }) : null;

      const bannerImgKey = data.bannerImage?.split('image/')[1];
      const bannerImg = bannerImgKey ? await this.filesRepository.findOne({
        where: { key: bannerImgKey }
      }) : null;

      const ftTokenImgKey = data.ftTokenImg?.split('image/')[1];
      const ftTokenImg = ftTokenImgKey ? await this.filesRepository.findOne({
        where: { key: ftTokenImgKey }
      }) : null;

      // Process CSV files
      const assetsWhiteListCsvKey = data.assetsWhiteListCsv?.split('csv/')[1];
      const assetsWhiteListCsvFile = assetsWhiteListCsvKey ? await this.filesRepository.findOne({
        where: { key: assetsWhiteListCsvKey }
      }) : null;

      const investorsWhiteListCsvKey = data.investorsWhiteListCsv?.split('csv/')[1];
      const investorsWhiteListFile = investorsWhiteListCsvKey ? await this.filesRepository.findOne({
        where: { key: investorsWhiteListCsvKey }
      }) : null;

      // Prepare vault data
      const vaultData = {
        owner: owner,
        asset_window: new Date(data.assetWindow).toISOString(),
        investment_window_duration: new Date(data.investmentWindowDuration).toISOString(),
        investment_open_window_time: new Date(data.investmentOpenWindowTime).toISOString(),
        contribution_open_window_time: new Date(data.contributionOpenWindowTime).toISOString(),
        ft_investment_window: new Date(data.ftInvestmentWindow).toISOString(),
        time_elapsedOis_equal_to_time: new Date(data.timeElapsedIsEqualToTime).toISOString(),
        vault_status: VaultStatus.published,
        vault_image: vaultImg,
        banner_image: bannerImg,
        ft_token_img: ftTokenImg,
        assets_whitelist_csv: assetsWhiteListCsvFile,
        investors_whitelist_csv: investorsWhiteListFile,
        ...mapCamelToSnake(data),
      };
      vault = this.vaultsRepository.create(vaultData as Vault);
      vault = await this.vaultsRepository.save(vault);

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
        await this.parseCSVFromS3(assetsWhiteListCsvFile.key) : [];
      console.log('Assets from CSV:', assetsFromCsv);
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
        await this.parseCSVFromS3(investorsWhiteListFile.key) : [];
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

      return vault;
    } catch (error) {
      console.error(error);
      throw new BadRequestException('Failed to create vault');
    }
  }

  private async parseCSVFromS3(fileKey: string): Promise<string[]> {
    try {
      const csvStream = await this.awsService.getCsv(fileKey);
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

  async saveDraftVault(userId: string, data: SaveDraftReq): Promise<Vault> {
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
        where: { key: imgKey }
      }) : null;

      const bannerImgKey = data.bannerImage?.split('image/')[1];
      const bannerImg = bannerImgKey ? await this.filesRepository.findOne({
        where: { key: bannerImgKey }
      }) : null;

      const ftTokenImgKey = data.ftTokenImg?.split('image/')[1];
      const ftTokenImg = ftTokenImgKey ? await this.filesRepository.findOne({
        where: { key: ftTokenImgKey }
      }) : null;

      // Process CSV files
      const assetsWhiteListCsvKey = data.assetsWhiteListCsv?.split('csv/')[1];
      const assetsWhiteListCsvFile = assetsWhiteListCsvKey ? await this.filesRepository.findOne({
        where: { key: assetsWhiteListCsvKey }
      }) : null;

      const investorsWhiteListCsvKey = data.investorsWhiteListCsv?.split('csv/')[1];
      const investorsWhiteListFile = investorsWhiteListCsvKey ? await this.filesRepository.findOne({
        where: { key: investorsWhiteListCsvKey }
      }) : null;

      // Prepare vault data
      const vaultData = {
        owner: owner,
        asset_window: new Date(data.assetWindow).toISOString(),
        investment_window_duration: new Date(data.investmentWindowDuration).toISOString(),
        investment_open_window_time: new Date(data.investmentOpenWindowTime).toISOString(),
        contribution_open_window_time: new Date(data.contributionOpenWindowTime).toISOString(),
        ft_investment_window: new Date(data.ftInvestmentWindow).toISOString(),
        time_elapsedOis_equal_to_time: new Date(data.timeElapsedIsEqualToTime).toISOString(),
        vault_status: VaultStatus.draft,
        vault_image: vaultImg,
        banner_image: bannerImg,
        ft_token_img: ftTokenImg,
        assets_whitelist_csv: assetsWhiteListCsvFile,
        investors_whitelist_csv: investorsWhiteListFile,
        ...data,
      };

      let vault: Vault;
      if (existingVault) {
        // Update existing draft vault
        Object.assign(existingVault, vaultData);
        vault = await this.vaultsRepository.save(existingVault);
      } else {
        // Create new draft vault
        vault = this.vaultsRepository.create(vaultData);
        vault = await this.vaultsRepository.save(vault);
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
        await this.parseCSVFromS3(assetsWhiteListCsvFile.key) : [];
      console.log('Assets from CSV:', assetsFromCsv);
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
        await this.parseCSVFromS3(investorsWhiteListFile.key) : [];
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

      return vault;
    } catch (error) {
      console.error(error);
      throw new BadRequestException('Failed to create vault');
    }
  }

  async getMyVaults(userId: string, includeDrafts: boolean = false): Promise<Vault[]> {
    const query = {
      where: {
        owner: { id: userId }
      },
      relations: ['social_links', 'assets_whitelist', 'investors_whitelist']
    };

    if (!includeDrafts) {
      query.where['vault_status'] = VaultStatus.published;
    }

    return this.vaultsRepository.find(query);
  }

  async getMyDraftVaults(userId: string): Promise<Vault[]> {
    return this.vaultsRepository.find({
      where: {
        owner: { id: userId },
        vault_status: VaultStatus.draft
      },
      relations: ['social_links', 'assets_whitelist', 'investors_whitelist']
    });
  }

  async getVaultById(id: string): Promise<Vault> {
    const vault = await this.vaultsRepository.findOne({ where: { id } });
    if (!vault) {
      throw new BadRequestException('Vault not found');
    }
    return vault;
  }

  async getVaults(): Promise<Vault[]> {
    return this.vaultsRepository.find();
  }
}
