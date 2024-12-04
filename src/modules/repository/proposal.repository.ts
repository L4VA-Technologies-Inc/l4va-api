import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Proposal } from '../../entities/proposal.entity';

@Injectable()
export class ProposalRepository extends Repository<Proposal> {
  private readonly logger = new Logger(ProposalRepository.name);

  constructor(
    @InjectRepository(Proposal)
    private readonly proposalEntityRepository: Repository<Proposal>,
  ) {
    super(
      proposalEntityRepository.target,
      proposalEntityRepository.manager,
      proposalEntityRepository.queryRunner,
    );
  }
}
