import './instrument';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import * as bodyParser from 'body-parser';
import { DataSource } from 'typeorm';

import { AppModule } from './app.module';
import { loadSecrets } from './load-gcp-secrets';

async function runMigrations(): Promise<void> {
  const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    synchronize: false,
    entities: ['src/**/*.entity.ts'],
    migrations: ['src/database/migrations/*.ts'],
    migrationsRun: false,
    logging: true,
  });
  await dataSource.initialize();
  const migrations = await dataSource.runMigrations();
  if (migrations.length === 0) {
    // eslint-disable-next-line no-console
    console.log('No migrations to run');
  } else {
    // eslint-disable-next-line no-console
    console.log(`Ran ${migrations.length} migration(s): ${migrations.map(m => m.name).join(', ')}`);
  }
  await dataSource.destroy();
}

async function bootstrap(): Promise<void> {
  try {
    await loadSecrets();
    // eslint-disable-next-line no-console
    console.log('Secrets loaded successfully, initializing application modules...');
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to load secrets:', error.message || error);
  }

  const nodeEnv = process.env.NODE_ENV;
  if (nodeEnv === 'testnet' || nodeEnv === 'mainnet') {
    try {
      // eslint-disable-next-line no-console
      console.log('Running migrations...');
      await runMigrations();
      // eslint-disable-next-line no-console
      console.log('Migrations completed successfully');
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Migration failed, aborting startup:', error.message || error);
      process.exit(1);
    }
  } else {
    // eslint-disable-next-line no-console
    console.log(`Skipping auto-migrations (NODE_ENV="${nodeEnv}")`);
  }

  const app = await NestFactory.create(AppModule, {
    bodyParser: false, // Disable default body parser so we can configure it manually
  });

  // Configure CORS
  app.enableCors({
    origin: [
      'https://app.l4va.org',
      'https://admin.l4va.org',
      'https://testnet.l4va.org',
      'https://dev-admin.l4va.org',
      'https://l4va.cryptounity.space',
      'http://localhost:3000',
      'http://localhost:5173',
      'http://localhost:8000',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:5173',
      'http://127.0.0.1:8000',
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  });

  // Configure body parsers with increased limits for webhook endpoint
  // Raw body parser for signature verification on webhook
  app.use('/blockchain/tx-webhook', bodyParser.raw({ type: 'application/json', limit: '50mb' }));

  // JSON body parser for all other routes with increased limit
  app.use(bodyParser.json({ limit: '50mb' }));
  app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

  app.setGlobalPrefix('api');
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  const config = new DocumentBuilder()
    .setTitle('L4VA API Documentation')
    .setDescription('API documentation for the L4VA system')
    .setVersion('1.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
      transformOptions: { excludeExtraneousValues: false },
    })
  );

  await app.listen(process.env.PORT ?? 3000).then(() => {
    console.log(`Server started on port: ${process.env.PORT ?? 3000}`);
  });
}
bootstrap();
