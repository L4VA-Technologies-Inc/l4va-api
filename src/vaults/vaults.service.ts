import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Vault } from '../database/vault.entity';

@Injectable()
export class VaultsService {
  constructor(
    @InjectRepository(Vault)
    private readonly vaultsRepository: Repository<Vault>,
  ) {}

  async createVault(userId: string, data: {
    name: string;
    type: 'single' | 'multi' | 'cnt';
    privacy: 'private' | 'public' | 'semi-private';
    brief?: string;
    imageUrl?: string;
    bannerUrl?: string;
    socialLinks?: { facebook?: string; twitter?: string };
  }): Promise<Vault> {
    try {
      const vault = this.vaultsRepository.create({
        ...data,
        ownerId: userId
      });
      return await this.vaultsRepository.save(vault);
    } catch (error) {
      console.log(error);
      throw new BadRequestException('Failed to create vault');
    }
  }

  async getMyVaults(userId: string): Promise<Vault[]> {
    return this.vaultsRepository.find({
      where: { ownerId: userId }
    });
  }

  async getVaultById(id: number): Promise<Vault> {
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
