import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Vault } from '../../entities/vault.entity';

@Injectable()
export class VaultRepository extends Repository<Vault> {
  private readonly logger = new Logger(VaultRepository.name);

  constructor(
    @InjectRepository(Vault)
    private readonly vaultEntityRepository: Repository<Vault>,
  ) {
    super(
      vaultEntityRepository.target,
      vaultEntityRepository.manager,
      vaultEntityRepository.queryRunner,
    );
  }
}
