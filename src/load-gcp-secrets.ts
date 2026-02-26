import * as fs from 'fs';
import * as path from 'path';

import * as dotenv from 'dotenv';

// Define sensitive secrets that this script should avoid adding or updating in .env.
// Note: If these keys already exist in the .env file, they may still be preserved by merges.
const SENSITIVE_KEYS = [
  'ADMIN_S_KEY',
  'VAULT_SCRIPT_SKEY',
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

  // Support both testnet and mainnet
  const shouldLoadGcpSecrets = nodeEnv === 'mainnet' || nodeEnv === 'testnet';

  if (!shouldLoadGcpSecrets) {
    console.log(`Skipping GCP secrets load because NODE_ENV is "${nodeEnv}" (expected "mainnet" or "testnet")`);
    return;
  }

  // Option 1: Use GCP_SERVICE_ACCOUNT_JSON environment variable (secure, no file)
  let credentials: any = null;
  if (process.env.GCP_SERVICE_ACCOUNT_JSON) {
    try {
      credentials = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_JSON);
      console.log('Using GCP credentials from environment variable (secure mode)');
    } catch (e) {
      console.warn('Failed to parse GCP_SERVICE_ACCOUNT_JSON:', e.message || e);
    }
  }

  // Option 2: Use GOOGLE_APPLICATION_CREDENTIALS file path (fallback)
  if (!credentials && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    let credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!path.isAbsolute(credentialsPath)) {
      credentialsPath = path.join(process.cwd(), credentialsPath);
    }
    if (fs.existsSync(credentialsPath)) {
      try {
        credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
        console.log('Using GCP credentials from file (legacy mode)');
      } catch (e) {
        console.warn('Failed to read credentials file:', e.message || e);
      }
    }
  }

  // Option 3: Check for local gcp-service-account.json (fallback for dev)
  if (!credentials) {
    const credentialsFile = path.join(process.cwd(), 'gcp-service-account.json');
    if (fs.existsSync(credentialsFile)) {
      try {
        credentials = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
        console.log('Using GCP credentials from local file (dev mode)');
      } catch (e) {
        console.warn('Failed to read local credentials file:', e.message || e);
      }
    }
  }

  // Option 4: Use Application Default Credentials (for GCP VMs, Cloud Run, GKE)
  // If no credentials are found, the SDK will attempt to use ADC automatically
  if (!credentials) {
    console.log('No credentials file/env found, will attempt Application Default Credentials');
  }

  // Extract project_id from credentials if available
  if (credentials?.project_id && !process.env.GCP_PROJECT_ID) {
    process.env.GCP_PROJECT_ID = credentials.project_id;
  }

  if (!process.env.GCP_PROJECT_ID) {
    console.warn('GCP_PROJECT_ID not set, skipping secrets load.');
    return;
  }

  const secretName = nodeEnv === 'mainnet' ? 'mainnet' : 'testnet';
  const projectId = process.env.GCP_PROJECT_ID;

  try {
    const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');

    // Initialize client with credentials from environment variable if available
    const clientOptions: any = {};
    if (credentials) {
      clientOptions.credentials = credentials;
    }
    // Otherwise, the SDK will use Application Default Credentials automatically

    const client = new SecretManagerServiceClient(clientOptions);
    const secretPath = `projects/${projectId}/secrets/${secretName}/versions/latest`;

    const [version] = await client.accessSecretVersion({ name: secretPath });

    const secrets = version.payload?.data?.toString() || '';

    const parsed = dotenv.parse(secrets);

    // Separate sensitive and non-sensitive secrets
    let sensitiveSecretsCount = 0;
    const nonSensitiveSecrets: Record<string, string> = {};

    Object.entries(parsed).forEach(([key, value]) => {
      if (SENSITIVE_KEYS.includes(key)) {
        sensitiveSecretsCount++;
      } else {
        nonSensitiveSecrets[key] = value;
      }
    });

    // Load ALL secrets into process.env (memory)
    Object.assign(process.env, parsed);

    // Only write non-sensitive secrets to .env file
    const existingEnv = dotenv.parse(envExists ? fs.readFileSync(envFilePath, 'utf8') : '');

    // Filter out sensitive keys from existing .env to ensure they are removed from disk
    const filteredExistingEnv = Object.fromEntries(
      Object.entries(existingEnv).filter(([key]) => !SENSITIVE_KEYS.includes(key))
    );

    const mergedEnv = { ...filteredExistingEnv, ...nonSensitiveSecrets };

    const envContent = Object.entries(mergedEnv)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    fs.writeFileSync(envFilePath, envContent, 'utf8');

    console.log(
      `✅ Loaded ${Object.keys(parsed).length} secrets from GCP (${sensitiveSecretsCount} kept in memory only)`
    );
  } catch (e) {
    console.error('Failed to load GCP secrets:', e.stack || e.message || e);
    console.warn('Falling back to .env file only');
  }
}
