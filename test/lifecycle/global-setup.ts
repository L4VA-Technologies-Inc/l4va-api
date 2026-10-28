import { execSync } from 'child_process';
import { join } from 'path';

import { config } from 'dotenv';
import { Client } from 'pg';

import { assertLifecycleTestEnv } from './helpers/guard';

const DB = { host: 'localhost', port: 5544, user: 'postgres', password: 'postgres' };
const DB_NAME = 'l4va_lifecycle_test';

async function waitFor(what: string, check: () => Promise<unknown>): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      await check();
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`${what} is not reachable — run npm run test:lifecycle:up`);
}

/**
 * Recreate the test database and build it from every migration, so the suite
 * runs on exactly the schema the migrations produce and fails if the chain
 * stops applying to an empty database.
 */
export default async function globalSetup(): Promise<void> {
  const envFile = join(__dirname, '.env.lifecycle-test');
  assertLifecycleTestEnv(config({ path: envFile, processEnv: {} }).parsed);

  await waitFor('Postgres on :5544', async () => {
    const c = new Client({ ...DB, database: 'postgres' });
    await c.connect();
    await c.end();
  });
  await waitFor('anvil on :8546', () =>
    fetch('http://127.0.0.1:8546', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    })
  );

  const admin = new Client({ ...DB, database: 'postgres' });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  await admin.end();

  execSync('npm run -s migration:run', {
    cwd: join(__dirname, '..', '..'),
    stdio: 'pipe',
    env: { ...process.env, ENV_FILE: envFile },
  });
}
