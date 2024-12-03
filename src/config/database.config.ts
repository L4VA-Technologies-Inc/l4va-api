import { TypeOrmModuleOptions } from '@nestjs/typeorm';

import { Asset } from '../entities/asset.entity';
import { Proposal } from '../entities/proposal.entity';
import { Stake } from '../entities/stake.entity';
import { Vault } from '../entities/vault.entity';
import { Vote } from '../entities/vote.entity';

export const databaseConfig: TypeOrmModuleOptions = {
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  username: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'l4va-db',
  entities: [Asset, Proposal, Stake, Vault, Vote],
  migrations: ['dist/migrations/*{.ts,.js}'],
  synchronize: false,
  logging: true,
};
