import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Vault } from '../entities/vault.entity';
import { CreateVaultDto } from '../dto/create-vault.dto';
import { VaultResponseDto } from '../dto/vault-response.dto';

@Injectable()
export class VaultService {
  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
  ) {}

  async getAllVaults(): Promise<VaultResponseDto[]> {
    const vaults = await this.vaultRepository.find();
    return vaults.map((vault) => ({
      ...vault,
    }));
  }

  async createVault(createVaultDto: CreateVaultDto): Promise<VaultResponseDto> {
    const newVault = this.vaultRepository.create(createVaultDto);
    const savedVault = await this.vaultRepository.save(newVault);
    return {
      ...savedVault,
    };
  }
}
