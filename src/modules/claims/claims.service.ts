import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CreateClaimDto } from './dto/create-claim.dto';
import { UpdateClaimStatusDto } from './dto/update-claim-status.dto';

import { Claim } from '@/database/claim.entity';
import { User } from '@/database/user.entity';
import { ClaimStatus } from '@/types/claim.types';

@Injectable()
export class ClaimsService {
  constructor(
    @InjectRepository(Claim)
    private claimRepository: Repository<Claim>,
    @InjectRepository(User)
    private userRepository: Repository<User>
  ) {}

  async getUserClaims(userId: string): Promise<Claim[]> {
    return this.claimRepository.find({
      where: { user: { id: userId } },
      order: { created_at: 'DESC' },
    });
  }

  async createClaim(createClaimDto: CreateClaimDto): Promise<Claim> {
    const user = await this.userRepository.findOne({
      where: { id: createClaimDto.userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const claim = this.claimRepository.create({
      ...createClaimDto,
      user,
      status: ClaimStatus.DISABLED,
    });

    return this.claimRepository.save(claim);
  }

  async updateClaimStatus(claimId: string, updateStatusDto: UpdateClaimStatusDto): Promise<Claim> {
    const claim = await this.claimRepository.findOne({
      where: { id: claimId },
    });

    if (!claim) {
      throw new NotFoundException('Claim not found');
    }

    claim.status = updateStatusDto.status;
    return this.claimRepository.save(claim);
  }

  async updateClaimTxHash(claimId: string, txHash: string): Promise<Claim> {
    const claim = await this.claimRepository.findOne({
      where: { id: claimId },
    });

    if (!claim) {
      throw new NotFoundException('Claim not found');
    }

    claim.tx_hash = txHash;
    claim.status = ClaimStatus.CLAIMED;
    return this.claimRepository.save(claim);
  }

  async buildClaimTransaction(claimId: string): Promise<any> {
    const claim = await this.claimRepository.findOne({
      where: { id: claimId },
      relations: ['user'],
    });

    if (!claim) {
      throw new NotFoundException('Claim not found');
    }

    if (claim.status !== ClaimStatus.PENDING) {
      throw new Error('Claim is not in pending status');
    }

    const mockTransaction = {
      inputs: [],
      outputs: [
        {
          address: claim.user.address,
          amount: claim.amount,
          assets: [],
        },
      ],
      metadata: {
        claimId: claim.id,
        type: claim.type,
      },
    };

    // Update status to CLAIMED and add mock tx hash
    const mockTxHash = `mock_tx_${Date.now()}_${claim.id.slice(0, 8)}`;
    await this.updateClaimTxHash(claim.id, mockTxHash);

    return {
      transaction: mockTransaction,
      txHash: mockTxHash,
    };
  }
}
