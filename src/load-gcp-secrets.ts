import * as fs from 'fs';
import * as path from 'path';

import * as dotenv from 'dotenv';

// Define sensitive secrets that this script should avoid adding or updating in .env.
// Note: If these keys already exist in the .env file, they may still be preserved by merges.
const SENSITIVE_KEYS = ['ADMIN_S_KEY', 'VAULT_SCRIPT_SKEY'];

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

  // Check for GCP_PROJECT_ID
  if (!process.env.GCP_PROJECT_ID) {
    const actualEnv = process.env.NODE_ENV;
    const isDevelopment = actualEnv === 'dev' || actualEnv === 'development';

    if (isDevelopment) {
      // DEVELOPMENT ONLY: Try to load from local credentials file
      const credentialsFile = 'gcp-service-account.json';
      const credentialsPath = path.join(process.cwd(), credentialsFile);

      if (fs.existsSync(credentialsPath)) {
        try {
          const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
          if (credentials.project_id) {
            process.env.GCP_PROJECT_ID = credentials.project_id;
            process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
            // eslint-disable-next-line no-console
            console.log('✅ Using local credentials file for GCP (development mode)');
          }
        } catch (e) {
          console.warn('Failed to read project_id from credentials:', e.message || e);
        }
      } else {
        console.warn('GCP_PROJECT_ID not set and no credentials file found in development mode');
      }
    } else {
      // PRODUCTION/TESTNET: GCP_PROJECT_ID must be in .env, ADC will be used automatically
      console.warn('GCP_PROJECT_ID not set. It must be provided in .env for production/testnet (uses ADC).');
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

    // eslint-disable-next-line no-console
    console.log(
      `✅ Loaded ${Object.keys(parsed).length} secrets from GCP (${sensitiveSecretsCount} kept in memory only)`
    );
  } catch (e) {
    console.error('Failed to load GCP secrets:', e.stack || e.message || e);
    console.warn('Falling back to .env file only');
  }
}
