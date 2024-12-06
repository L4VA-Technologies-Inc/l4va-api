import { Injectable, Inject } from '@nestjs/common';
import { CreateVaultDto } from '../../dto/create-vault.dto';
import { VaultResponseDto } from '../../dto/vault-response.dto';
import { VaultRepository } from '../repository/vault.repository';

@Injectable()
export class VaultService {
  @Inject()
  private readonly vaultRepository: VaultRepository;

  async getAllVaults(): Promise<VaultResponseDto[]> {
    const vaults = await this.vaultRepository.findAll();
    return vaults.map((vault) => ({
      ...vault,
    }));
  }

  async createVault(createVaultDto: CreateVaultDto): Promise<VaultResponseDto> {
    const savedVault = this.vaultRepository.createVault(createVaultDto);
    return {
      ...savedVault,
    };
  }
}
