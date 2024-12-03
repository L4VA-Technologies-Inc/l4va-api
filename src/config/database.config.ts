import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { resolve } from 'path';
import { config } from 'dotenv';

config();

export const databaseConfig: TypeOrmModuleOptions = {
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  username: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'l4va-db',
  entities: [resolve(__dirname, '../entities/*.entity{.ts,.js}')],
  synchronize: false,
  logging: true,
  keepConnectionAlive: true,
};
