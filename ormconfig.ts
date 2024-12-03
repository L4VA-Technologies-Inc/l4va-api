import { DataSource } from 'typeorm';
import { config } from 'dotenv';

config();

export default new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT, 10) || 5432,
  username: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'l4va-db',
  entities: [
    __dirname + '/src/entities/**/*{.ts,.js}',
    __dirname + '/src/entities/*{.ts,.js}',
  ],
  migrations: [__dirname + '/src/migrations/*{.ts,.js}'],
  migrationsTransactionMode: 'each',
});
