import * as fs from 'fs';
import * as path from 'path';

import * as dotenv from 'dotenv';

// Define sensitive secrets that this script should avoid adding or updating in .env.
// Note: If these keys already exist in the .env file, they may still be preserved by merges.
const SENSITIVE_KEYS = [
  'ADMIN_S_KEY',
  'VAULT_SCRIPT_SKEY',
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
  'DB_NAME',
  'JWT_SECRET',
  'ANVIL_API_KEY',
  'GITHUB_TOKEN',
  'BLOCKFROST_WEBHOOK_AUTH_TOKEN',
  'BLOCKFROST_API_KEY',
  'ADMIN_SERVICE_TOKEN',
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

  if (!process.env.GCP_PROJECT_ID) {
    console.warn('GCP_PROJECT_ID not set, skipping secrets load.');
    return;
  }

  // GCP_PROJECT_ID is already validated above, now configure authentication
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
    // PRODUCTION/TESTNET: Using Application Default Credentials (ADC)
    // eslint-disable-next-line no-console
    console.log(`✅ Using ADC for GCP authentication (${nodeEnv}), project: ${process.env.GCP_PROJECT_ID}`);
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

    // Provide helpful guidance based on the error
    if (e.message?.includes('NOT_FOUND')) {
      console.error(`\n🔴 Secret "${secretName}" not found in project ${projectId}`);
      console.error('To fix this:');
      console.error(`1. Create the secret: gcloud secrets create ${secretName} --project=${projectId}`);
      console.error(
        `2. Add a version: echo -n "KEY=value" | gcloud secrets versions add ${secretName} --data-file=- --project=${projectId}`
      );
      console.error(
        `3. Grant access: gcloud secrets add-iam-policy-binding ${secretName} --member="serviceAccount:YOUR_SA@PROJECT.iam.gserviceaccount.com" --role="roles/secretmanager.secretAccessor" --project=${projectId}`
      );
    } else if (e.message?.includes('PERMISSION_DENIED')) {
      console.error('\n🔴 Permission denied accessing GCP Secret Manager');
      console.error('To fix this:');
      console.error('1. Ensure ADC is configured on the VM (it should be automatic for Compute Engine)');
      console.error('2. Grant the Compute Engine service account the "Secret Manager Secret Accessor" role');
      console.error(
        `3. Run: gcloud secrets add-iam-policy-binding ${secretName} --member="serviceAccount:COMPUTE_ENGINE_SA" --role="roles/secretmanager.secretAccessor" --project=${projectId}`
      );
    } else if (e.message?.includes('Could not load the default credentials')) {
      console.error('\n🔴 Application Default Credentials (ADC) not configured');
      console.error('To fix this on a GCP VM:');
      console.error('1. Ensure the VM has the correct service account attached');
      console.error('2. Ensure the service account has "Secret Manager Secret Accessor" role');
      console.error('3. ADC should work automatically on Compute Engine VMs');
    }

    console.warn('\n⚠️  Falling back to .env file only\n');
  }
}
