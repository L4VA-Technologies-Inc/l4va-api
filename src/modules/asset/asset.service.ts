import { Injectable, Inject } from '@nestjs/common';
import { CreateVaultDto } from '../../dto/create-vault.dto';
import { VaultResponseDto } from '../../dto/vault-response.dto';
import { VaultRepository } from '../repository/vault.repository';

@Injectable()
export class AssetService {

  @Inject()
  private readonly vaultRepository: VaultRepository;

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
