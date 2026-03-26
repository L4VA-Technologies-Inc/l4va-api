/* eslint-disable no-console, @typescript-eslint/explicit-function-return-type */
import { config } from 'dotenv';
import { DataSource } from 'typeorm';

import { loadSecrets } from '../load-gcp-secrets';

async function runMigrations(): Promise<void> {
  try {
    // Load .env first
    config();

    // Load GCP secrets (which populate process.env)
    console.log('Loading secrets from GCP...');
    await loadSecrets();
    console.log('Secrets loaded successfully');

    // Create DataSource AFTER secrets are loaded
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

    console.log('Initializing database connection...');
    await dataSource.initialize();
    console.log('Database connected');

    console.log('Running migrations...');
    const migrations = await dataSource.runMigrations();

    if (migrations.length === 0) {
      console.log('No migrations to run');
    } else {
      console.log(`Successfully ran ${migrations.length} migration(s):`);
      migrations.forEach(migration => {
        console.log(`  - ${migration.name}`);
      });
    }

    await dataSource.destroy();
    console.log('Migration completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

runMigrations();
