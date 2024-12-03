import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { config } from 'dotenv';

function getEnvFilePath() {
  if (process.env.NODE_ENV) {
    return `${process.env.NODE_ENV}.env`;
  }
  return '.env';
}

config({ path: getEnvFilePath() });

const configService = new ConfigService();

export default new DataSource({
  type: 'postgres',
  host: configService.get('POSTGRES_HOST'),
  port: configService.get('POSTGRES_PORT'),
  username: configService.get('POSTGRES_USER'),
  password: configService.get('POSTGRES_PASSWORD'),
  database: configService.get('POSTGRES_DATABASE') as string,
  entities: [
    __dirname + '/src/database/entities/**/*{.ts,.js}',
    __dirname + '/src/database/entities/*{.ts,.js}',
  ],
  migrations: [__dirname + '/src/database/migrationsInput/*{.ts,.js}'],
  migrationsTransactionMode: 'each',
});
