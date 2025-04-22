import { Injectable, Logger } from '@nestjs/common';

export enum OnchainTransactionStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  FAILED = 'failed',
  NOT_FOUND = 'not_found'
}

@Injectable()
export class BlockchainService {
  private readonly logger = new Logger(BlockchainService.name);
  constructor() {}

  private readonly config = {
    network: process.env.BLOCKCHAIN_NETWORK || 'testnet',
    rpcUrl: process.env.BLOCKCHAIN_RPC_URL,
  };


}
