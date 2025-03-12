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
      const owner = await this.usersRepository.findOne({
        where: {
          id: userId
        }
      });
      const newVault = {
        owner: owner,
        status: VaultStatus.published,
        ...mapCamelToSnake(data),
      } as Vault;
      const vault = this.vaultsRepository.create(newVault);
      return await this.vaultsRepository.save(vault);
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
    try {
      const owner = await this.usersRepository.findOne({
        where: {
          id: userId
        }
      });

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

      const assetsWhiteListCsvKey = data.assetsWhiteListCsv?.split('csv/')[1];
      const assetsWhiteListCsvFile = assetsWhiteListCsvKey ? await this.filesRepository.findOne({
        where: { key: assetsWhiteListCsvKey }
      }) : null;

      const investorsWhiteListCsvKey = data.investorsWhiteListCsv?.split('csv/')[1];
      const investorsWhiteListFile = investorsWhiteListCsvKey ? await this.filesRepository.findOne({
        where: { key: investorsWhiteListCsvKey }
      }) : null;

      const newVault = {
        owner: owner,
        asset_window: new Date(data.assetWindow).toISOString(),
        investment_window_duration: new Date(data.investmentWindowDuration).toISOString(),
        investment_open_window_time: new Date(data.investmentOpenWindowTime).toISOString(),
        contribution_open_window_time: new Date(data.contributionOpenWindowTime).toISOString(),
        ft_investment_window: new Date(data.ftInvestmentWindow).toISOString(),
        time_elapsedOis_equal_to_time: new Date(data.timeElapsedIsEqualToTime).toISOString(),
        status: VaultStatus.draft,
        vault_image: vaultImg,
        banner_image: bannerImg,
        ft_token_img: ftTokenImg,
        assets_whitelist_csv: assetsWhiteListCsvFile,
        investors_whitelist_csv: investorsWhiteListFile,
        ...data,
      };
      const vault = this.vaultsRepository.create(newVault);
      const vaultCreated = await this.vaultsRepository.save(vault);

      if (data.socialLinks.length > 0) {
        data.socialLinks.forEach(linkItem => {
          const link = this.linksRepository.create({
            vault: vaultCreated,
            name: linkItem.name,
            url: linkItem.url
          });
          return this.linksRepository.save(link);
        });
      }
      // Handle assets whitelist from both direct input and CSV
      const assetsFromCsv = assetsWhiteListCsvFile ?
        await this.parseCSVFromS3(assetsWhiteListCsvFile.key) : [];
      console.log('Assets from CSV:', assetsFromCsv);
      const allAssets = new Set([
        ...data.assetsWhitelist.map(item => item.id),
        ...assetsFromCsv
      ]);

      for (const assetId of allAssets) {
        const assetItem = this.assetsWhitelistRepository.create({
          vault: vaultCreated,
          asset_id: assetId
        });
        await this.assetsWhitelistRepository.save(assetItem);
      }

      // Handle investors whitelist from both direct input and CSV
      const investorsFromCsv = investorsWhiteListFile ?
        await this.parseCSVFromS3(investorsWhiteListFile.key) : [];
      console.log('Investors from CSV:', investorsFromCsv);
      const allInvestors = new Set([
        ...data.investorsWhiteList.map(item => item.wallet_address),
        ...investorsFromCsv
      ]);

      for (const walletAddress of allInvestors) {
        const investorItem = this.investorsWhiteListRepository.create({
          vault: vaultCreated,
          wallet_address: walletAddress
        });
        await this.investorsWhiteListRepository.save(investorItem);
      }
      return vaultCreated;
    } catch (error) {
      console.error(error);
      throw new BadRequestException('Failed to create vault');
    }
  }

  async getMyVaults(userId: string): Promise<Vault[]> {
    return this.vaultsRepository.find({
      where: {
        owner: {
          id: userId
        }
      },
      relations: ['social_links', 'assets_whitelist']
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
