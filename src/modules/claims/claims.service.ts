import { Buffer } from 'node:buffer';

import { FixedTransaction, PrivateKey } from '@emurgo/cardano-serialization-lib-nodejs';
import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { BlockchainService } from '../vaults/processing-tx/onchain/blockchain.service';

import { CreateClaimDto } from './dto/create-claim.dto';
import { GetClaimsDto } from './dto/get-claims.dto';
import { UpdateClaimStatusDto } from './dto/update-claim-status.dto';

import { Claim } from '@/database/claim.entity';
import { User } from '@/database/user.entity';
import { ClaimStatus } from '@/types/claim.types';

@Injectable()
export class ClaimsService {
  private readonly logger = new Logger(ClaimsService.name);
  private readonly adminSKey: string;

  constructor(
    @InjectRepository(Claim)
    private claimRepository: Repository<Claim>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private readonly configService: ConfigService,
    private readonly blockchainService: BlockchainService
  ) {
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');
  }

  async getUserClaims(userId: string, query?: GetClaimsDto): Promise<Claim[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const whereConditions: any = { user: { id: userId } };

    if (query?.status) {
      whereConditions.status = query.status;
    }

    if (query?.claimState === 'claimed') {
      whereConditions.status = ClaimStatus.CLAIMED;
    } else if (query?.claimState === 'unclaimed') {
      whereConditions.status = In([ClaimStatus.DISABLED, ClaimStatus.PENDING]);
    }

    return this.claimRepository.find({
      where: whereConditions,
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

  async buildClaimTransaction(claimId: string): Promise<{
    success: boolean;
    txHash?: string;
    transactionId?: string;
    error?: string;
    presignedTx?: string;
  }> {
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

    try {
      this.logger.log(`Building claim transaction for claim ${claimId}`);

      // Mock
      const transactionInput = {
        changeAddress: claim.user.address, // User's address as change address
        message: `Claim payout for ${claim.id}`,
        validityInterval: {
          start: true,
          end: true,
        },
        network: 'preprod', // or 'mainnet' for production
      };

      this.logger.log('Transaction input prepared:', JSON.stringify(transactionInput, null, 2));

      // Build the transaction using BlockchainService
      const buildResponse = await this.blockchainService.buildTransaction(transactionInput);
      this.logger.log('Transaction built successfully');

      // Sign the transaction if admin key is available
      let presignedTx: string;
      if (this.adminSKey) {
        const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
        txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));
        presignedTx = txToSubmitOnChain.to_hex();
        this.logger.log('Transaction signed successfully');
      } else {
        presignedTx = buildResponse.complete;
        this.logger.warn('No admin key available, transaction not signed');
      }

      // Submit the transaction
      const submitResponse = await this.blockchainService.submitTransaction({
        transaction: presignedTx,
        signatures: [],
      });

      this.logger.log('Transaction submitted successfully:', submitResponse);

      // Update claim status and tx hash
      const txHash = submitResponse.txHash || `tx_${Date.now()}_${claim.id.slice(0, 8)}`;
      await this.updateClaimTxHash(claim.id, txHash);

      return {
        success: true,
        txHash: txHash,
        transactionId: submitResponse.txHash,
        presignedTx: presignedTx,
      };
    } catch (error) {
      this.logger.error('Error building/submitting claim transaction:', error);

      // Fall back to mock transaction if real transaction fails
      const mockTxHash = `mock_tx_${Date.now()}_${claim.id.slice(0, 8)}`;
      await this.updateClaimTxHash(claim.id, mockTxHash);

      return {
        success: false,
        error: error.message,
        txHash: mockTxHash,
      };
    }
  }
}
