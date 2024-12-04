import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Asset } from '../../entities/asset.entity';

@Injectable()
export class AssetRepository extends Repository<Asset> {
  private readonly logger = new Logger(AssetRepository.name);

  constructor(
    @InjectRepository(Asset)
    private readonly assetEntityRepository: Repository<Asset>,
  ) {
    super(
      assetEntityRepository.target,
      assetEntityRepository.manager,
      assetEntityRepository.queryRunner,
    );
  }
}
