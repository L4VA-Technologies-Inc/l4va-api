/* eslint-disable no-console, @typescript-eslint/explicit-function-return-type */
import { config } from 'dotenv';
import { DataSource } from 'typeorm';

import { loadSecrets } from '../load-gcp-secrets';

function buildDataSource() {
  return new DataSource({
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
}

async function runMigrations(): Promise<void> {
  try {
    // Load .env first (no-op if vars already in environment)
    config();

    let dataSource = buildDataSource();

    // Try connecting with current environment (fast path: secrets already loaded by app container)
    console.log('Initializing database connection...');
    try {
      await dataSource.initialize();
    } catch (connError) {
      console.error('Initial connection failed:', connError);
      // Connection failed — likely missing credentials in a local/manual run; try loading GCP secrets
      console.log('Initial connection failed, loading secrets from GCP...');
      await loadSecrets();
      console.log('Secrets loaded, retrying connection...');

      dataSource = buildDataSource();
      await dataSource.initialize(); // throws real error if still failing
    }
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
