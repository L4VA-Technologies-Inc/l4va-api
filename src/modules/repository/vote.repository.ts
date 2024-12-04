import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Vote } from '../../entities/vote.entity';

@Injectable()
export class VoteRepository extends Repository<Vote> {
  private readonly logger = new Logger(VoteRepository.name);

  constructor(
    @InjectRepository(Vote)
    private readonly voteEntityRepository: Repository<Vote>,
  ) {
    super(
      voteEntityRepository.target,
      voteEntityRepository.manager,
      voteEntityRepository.queryRunner,
    );
  }
}
