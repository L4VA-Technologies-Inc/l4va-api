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
import {mapCamelToSnake} from "../../helpers/mapCamelToSnake";

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
    private readonly investorsWhiteListRepository: Repository<InvestorsWhitelistEntity>
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

  async saveDraftVault(userId: string, data: SaveDraftReq): Promise<Vault> {
    try {
      const owner = await this.usersRepository.findOne({
        where: {
          id: userId
        }
      });
      const newVault = {
        owner: owner,
        asset_window: new Date(data.assetWindow).toISOString(),
        investment_window_duration: new Date(data.investmentWindowDuration).toISOString(),
        investment_open_window_time: new Date(data.investmentOpenWindowTime).toISOString(),
        contribution_open_window_time: new Date(data.contributionOpenWindowTime).toISOString(),
        ft_investment_window: new Date(data.ftInvestmentWindow).toISOString(),
        time_elapsedOis_equal_to_time: new Date(data.timeElapsedIsEqualToTime).toISOString(),
        status: VaultStatus.draft,
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
      if (data.assetsWhitelist.length > 0) {
        data.assetsWhitelist.forEach(whiteListItem => {
          const assetItem = this.assetsWhitelistRepository.create({
            vault: vaultCreated,
            asset_id: whiteListItem.id
          });
          return this.assetsWhitelistRepository.save(assetItem);
        });
      }
      if (data.investorsWhiteList.length > 0) {
        data.investorsWhiteList.forEach(whiteListItem => {
          const assetItem = this.investorsWhiteListRepository.create({
            vault: vaultCreated,
            wallet_address: whiteListItem.wallet_address
          });
          return this.investorsWhiteListRepository.save(assetItem);
        });
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
