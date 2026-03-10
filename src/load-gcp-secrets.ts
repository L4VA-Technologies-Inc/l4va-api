import * as fs from 'fs';
import * as path from 'path';

import * as dotenv from 'dotenv';

// Define sensitive secrets that this script should avoid adding or updating in .env.
// Note: If these keys already exist in the .env file, they may still be preserved by merges.
const SENSITIVE_KEYS = ['ADMIN_S_KEY', 'VAULT_SCRIPT_SKEY', 'TAPTOOLS_API_KEY', 'ADMIN_SERVICE_TOKEN', 'GITHUB_TOKEN'];

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
  const shouldLoadGcpSecrets = nodeEnv === 'mainnet';
  const shouldRemoveSecretsFromEnv = nodeEnv === 'mainnet' || nodeEnv === 'testnet';

  if (!shouldLoadGcpSecrets) {
    if (!shouldRemoveSecretsFromEnv) {
      console.log(
        `Skipping GCP secrets load because NODE_ENV is "${nodeEnv}" (expected "mainnet" or "testnet"), keeping existing .env as is.`
      );
      return;
    }

    console.log(
      `Skipping GCP secrets load because NODE_ENV is "${nodeEnv}" (expected "mainnet"), just removing any existing sensitive secrets from .env if present.`
    );

    const existingEnv = dotenv.parse(envExists ? fs.readFileSync(envFilePath, 'utf8') : '');

    // Separate sensitive and non-sensitive keys
    let sensitiveSecretsCount = 0;
    const nonSensitiveEnv: Record<string, string> = {};

    Object.entries(existingEnv).forEach(([key, value]) => {
      if (SENSITIVE_KEYS.includes(key)) {
        sensitiveSecretsCount++;
      } else {
        nonSensitiveEnv[key] = value;
      }
    });

    // Load ALL env vars into process.env (including sensitive ones in memory)
    Object.assign(process.env, existingEnv);

    // Only write non-sensitive keys to .env file
    const envContent = Object.entries(nonSensitiveEnv)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    fs.writeFileSync(envFilePath, envContent, 'utf8');

    if (sensitiveSecretsCount > 0) {
      console.log(`✅ Filtered ${sensitiveSecretsCount} sensitive key(s) from .env (kept in memory only)`);
    }

    return;
  }

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
    console.warn('Credentials file not found, skipping secrets load.');
    return;
  }

  process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;

  if (!process.env.GCP_PROJECT_ID) {
    try {
      const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
      if (credentials.project_id) {
        process.env.GCP_PROJECT_ID = credentials.project_id;
      }
    } catch (e) {
      console.warn('Failed to read project_id from credentials:', e.message || e);
    }
  }

  if (!process.env.GCP_PROJECT_ID) {
    console.warn('GCP_PROJECT_ID not set, skipping secrets load.');
    return;
  }

  const secretName = nodeEnv === 'mainnet' ? 'mainnet' : 'testnet';
  const projectId = process.env.GCP_PROJECT_ID;

  try {
    const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');

    const client = new SecretManagerServiceClient();
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
