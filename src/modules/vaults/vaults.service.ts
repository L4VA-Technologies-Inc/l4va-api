import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Vault } from '../../database/vault.entity';
import { CreateVaultReq } from './dto/createVault.req';
import {User} from "../../database/user.entity";

@Injectable()
export class VaultsService {
  constructor(
    @InjectRepository(Vault)
    private readonly vaultsRepository: Repository<Vault>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>
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
        ...data,
      } as Vault;
      const vault = this.vaultsRepository.create(newVault);
      return await this.vaultsRepository.save(vault);
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
      }
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
