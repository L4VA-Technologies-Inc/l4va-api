import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Stake } from '../../entities/stake.entity';

@Injectable()
export class StakeRepository extends Repository<Stake> {
  private readonly logger = new Logger(StakeRepository.name);

  constructor(
    @InjectRepository(Stake)
    private readonly stakeEntityRepository: Repository<Stake>,
  ) {
    super(
      stakeEntityRepository.target,
      stakeEntityRepository.manager,
      stakeEntityRepository.queryRunner,
    );
  }
}
