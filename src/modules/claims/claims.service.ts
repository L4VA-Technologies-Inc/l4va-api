import { Buffer } from 'node:buffer';

import { FixedTransaction, PrivateKey } from '@emurgo/cardano-serialization-lib-nodejs';
import { Injectable, NotFoundException, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { TransactionsService } from '../vaults/processing-tx/offchain-tx/transactions.service';
import { BlockchainService } from '../vaults/processing-tx/onchain/blockchain.service';

import { CreateClaimDto } from './dto/create-claim.dto';
import { GetClaimsDto } from './dto/get-claims.dto';

import { Claim } from '@/database/claim.entity';
import { Transaction } from '@/database/transaction.entity';
import { User } from '@/database/user.entity';
import { ClaimStatus } from '@/types/claim.types';
import { TransactionType } from '@/types/transaction.types';

@Injectable()
export class ClaimsService {
  private readonly logger = new Logger(ClaimsService.name);
  private readonly adminSKey: string;

  constructor(
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    @InjectRepository(Claim)
    private claimRepository: Repository<Claim>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private readonly configService: ConfigService,
    private readonly transactionsService: TransactionsService,
    private readonly blockchainService: BlockchainService
  ) {
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');
  }

  /**
   * Retrieves claims for a specific user with optional filtering
   *
   * @param userId - The ID of the user whose claims to retrieve
   * @param query - Optional query parameters for filtering claims
   * @returns Promise with an array of Claim entities
   */
  async getUserClaims(userId: string, query?: GetClaimsDto): Promise<Claim[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const whereConditions: any = { user: { id: userId } };

    if (query?.status) {
      whereConditions.status = query.status;
    }

    if (query?.claimState === 'claimed') {
      whereConditions.status = ClaimStatus.CLAIMED;
    } else if (query?.claimState === 'unclaimed') {
      whereConditions.status = In([ClaimStatus.AVAILABLE, ClaimStatus.PENDING]);
    }

    return this.claimRepository.find({
      where: whereConditions,
      order: { created_at: 'DESC' },
    });
  }

  /**
   * Creates a new claim for a user
   *
   * @param createClaimDto - Data Transfer Object containing claim creation details
   * @returns Promise with the newly created Claim entity
   * @throws NotFoundException if the user is not found
   */
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
      status: ClaimStatus.AVAILABLE,
    });

    return this.claimRepository.save(claim);
  }

  /**
   * Updates the transaction hash for a claim and marks it as claimed
   *
   * @param claimId - The ID of the claim to updateв
   * @param txHash - The transaction hash to associate with the claim
   * @returns Promise with the updated Claim entity
   * @throws NotFoundException if the claim is not found
   */
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

  /**
   * User press "claim" button
   *
   * Frontend send request to build tx of claim
   *
   * backend create internal tx, then backend create blockchain tx and connect both tx by txHash
   *
   * then backend sign blockchain tx with admin wallet, and return presigned tx to user
   *
   * then user sign presigned tx with his own wallet
   *
   * then tx send to backend and publish to blockchain
   *
   * then scanner call webhook with tx detail when tx will exist on chain.
   *
   * then using information txHash we will update internal tx and maybe claim status
   */
  async buildClaimTransaction(claimId: string): Promise<{
    success: boolean;
    transactionId: string;
    presignedTx: string;
  }> {
    const claim = await this.claimRepository.findOne({
      where: { id: claimId },
      relations: ['user'],
    });

    if (!claim) {
      throw new NotFoundException('Claim not found');
    }

    if (claim.status !== ClaimStatus.PENDING) {
      throw new BadRequestException('Claim is not in pending status');
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

      // Create internal transaction
      const internalTx = await this.transactionRepository.save({
        amount: claim.amount,
        user: claim.user,
        type: TransactionType.claim,
        metadata: {
          claimId: claim.id,
          createdAt: new Date().toISOString(),
          transactionType: 'claim',
          description: `Claim payout for user ${claim.user.id}`,
        },
      });

      // Build the transaction
      const buildResponse = await this.blockchainService.buildTransaction(transactionInput);
      this.logger.log('Transaction built successfully');

      // Sign the transaction
      const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
      txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

      return {
        success: true,
        transactionId: internalTx.id,
        presignedTx: txToSubmitOnChain.to_hex(),
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }

  async submitSignedTransaction(
    transactionId: string,
    signedTxHex: string
  ): Promise<{
    success: boolean;
    transactionId: string;
    blockchainTxHash: string;
  }> {
    // Find the internal transaction
    const internalTx = await this.transactionRepository.findOne({
      where: { id: transactionId },
    });

    if (!internalTx) {
      throw new NotFoundException('Transaction not found');
    }

    try {
      // Submit to blockchain
      const submitResponse = await this.blockchainService.submitTransaction({
        transaction: signedTxHex,
        signatures: [],
      });

      internalTx.tx_hash = submitResponse.txHash; // Connect offchain and onchain tx

      await this.transactionRepository.save(internalTx);

      // Also update the claim with the tx hash reference
      const claim = await this.claimRepository.findOne({
        where: { id: internalTx.metadata.claimId },
      });
      if (claim) {
        claim.status = ClaimStatus.CLAIMED;
        claim.tx_hash = submitResponse.txHash;
        await this.claimRepository.save(claim);
      }

      return {
        success: true,
        transactionId: internalTx.id,
        blockchainTxHash: submitResponse.txHash,
      };
    } catch (error) {
      await this.transactionRepository.save(internalTx);
      throw error;
    }
  }

  async processConfirmedTransaction(txHash: string): Promise<void> {
    // Find the internal transaction by blockchain hash
    const internalTx = await this.transactionRepository.findOne({
      where: { tx_hash: txHash },
    });

    if (!internalTx) {
      this.logger.warn(`No internal transaction found for blockchain hash: ${txHash}`);
      return;
    }

    // Update the claim status
    const claim = await this.claimRepository.findOne({
      where: { id: internalTx.metadata.claimId },
    });

    if (claim) {
      claim.status = ClaimStatus.CLAIMED;
      await this.claimRepository.save(claim);
      this.logger.log(`Claim ${claim.id} marked as CLAIMED with tx ${txHash}`);
    }
  }
}
