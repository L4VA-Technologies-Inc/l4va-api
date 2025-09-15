import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '@/database/user.entity';
import axios from "axios";
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { ConfigService } from '@nestjs/config';
import { getUtxos } from '../vaults/processing-tx/onchain/utils/lib';
import { Address } from '@emurgo/cardano-serialization-lib-nodejs';


@Injectable()
export class DexHunterService {
  private readonly logger = new Logger(DexHunterService.name);

  private readonly blockfrost: BlockFrostAPI;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(
    // @InjectRepository(User)
    // private usersRepository: Repository<User>,
    private readonly configService: ConfigService
  ) {
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_TESTNET_API_KEY'),
    });
    this.baseUrl = this.configService.get<string>('ANVIL_API_URL');
    this.apiKey = this.configService.get<string>('ANVIL_API_KEY');
  }







  async sell() {
    const utxos = await this.blockfrost.addressesUtxosAll(
      'addr_test1wzwdhey2vadqmk3q3xxl3ft0tr99gqtf4fz4amc60xeca2s7pnuqd'
    );
  }

}
