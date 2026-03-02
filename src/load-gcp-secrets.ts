import * as fs from 'fs';
import * as path from 'path';

import * as dotenv from 'dotenv';

// Define sensitive secrets that this script should avoid adding or updating in .env.
// Note: If these keys already exist in the .env file, they may still be preserved by merges.
const SENSITIVE_KEYS = [
  'ADMIN_S_KEY',
  'VAULT_SCRIPT_SKEY',
  'GCP_SERVICE_ACCOUNT_JSON_BASE64',
  'GOOGLE_BUCKET_CREDENTIALS_BASE64',
  'DEXHUNTER_API_KEY',
  'GCP_SERVICE_ACCOUNT_JSON',
  'TAPTOOLS_API_KEY',
  'CHARLI3_API_KEY',
  'GOOGLE_BUCKET_CREDENTIALS',
  'GCP_KMS_KEY',
  'GCP_KMS_KEYRING',
  'SENTRY_DNS_KEY',
  'SLACK_BOT_TOKEN',
  'NOVU_API_KEY',
  'REDIS_PASSWORD',
  'DB_PASSWORD',
  'DB_USERNAME',
  'JWT_SECRET',
  'ANVIL_API_KEY',
  'GITHUB_TOKEN',
  'BLOCKFROST_WEBHOOK_AUTH_TOKEN',
];

export async function loadSecrets(): Promise<void> {
  // Step 1: Load .env file first (from git repository)
  dotenv.config();

  const nodeEnv = process.env.NODE_ENV;
  const envFilePath = path.join(process.cwd(), '.env');
  const envExists = fs.existsSync(envFilePath);

  if (envExists) {
    const envContent = fs.readFileSync(envFilePath, 'utf8');
    const parsed = dotenv.parse(envContent);
    Object.assign(process.env, parsed);
  }

  // Step 2: Clean sensitive keys from .env file immediately after loading to memory
  // This ensures sensitive secrets are only in memory, never persisted to disk
  if (envExists && (nodeEnv === 'mainnet' || nodeEnv === 'testnet')) {
    const existingEnv = dotenv.parse(fs.readFileSync(envFilePath, 'utf8'));
    const beforeCount = Object.keys(existingEnv).length;

    // Filter out sensitive keys from .env file
    const filteredEnv = Object.fromEntries(
      Object.entries(existingEnv).filter(([key]) => !SENSITIVE_KEYS.includes(key))
    );

    // Only write back if we actually removed something
    if (Object.keys(filteredEnv).length < beforeCount) {
      const envContent = Object.entries(filteredEnv)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');
      fs.writeFileSync(envFilePath, envContent, 'utf8');

      const removedCount = beforeCount - Object.keys(filteredEnv).length;
      console.log(`🔒 Removed ${removedCount} sensitive key(s) from .env file (kept in memory only)`);
    }
  }

  // Support both testnet and mainnet
  const isDevelopment = nodeEnv === 'dev' || nodeEnv === 'development';

  // For production/testnet: Just verify base64 credentials exist
  // The actual decoding is done by each GCP service (KMS, Secret Manager, Bucket)
  if (!isDevelopment) {
    if (process.env.GCP_SERVICE_ACCOUNT_JSON_BASE64 && process.env.GOOGLE_BUCKET_CREDENTIALS_BASE64) {
      // eslint-disable-next-line no-console
      console.log('✅ GCP credentials available in environment (base64, memory-only)');
    } else {
      console.warn(
        'GCP_SERVICE_ACCOUNT_JSON_BASE64 or GOOGLE_BUCKET_CREDENTIALS_BASE64 not set for production/testnet'
      );
    }
    // No need to decode here - each GCP service handles its own decoding
    return;
  }

  // Development only: Set up file-based credentials path
  let credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (!credentialsPath) {
    const credentialsFile = 'gcp-service-account.json';
    credentialsPath = path.join(process.cwd(), credentialsFile);
  } else {
    if (!path.isAbsolute(credentialsPath)) {
      credentialsPath = path.join(process.cwd(), credentialsPath);
    }
  }

  if (!fs.existsSync(credentialsPath)) {
    console.warn('Credentials file not found for development, skipping GCP setup.');
    return;
  }

  process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
  // eslint-disable-next-line no-console
  console.log('✅ Using GCP credentials from file (development mode)');
}
