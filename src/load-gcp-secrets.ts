import * as fs from 'fs';
import * as path from 'path';

import * as dotenv from 'dotenv';

export async function loadSecrets(): Promise<void> {
  // Step 1: Load .env file (for local/development configuration only)
  // This file should only contain non-sensitive config committed to git
  dotenv.config();

  const nodeEnv = process.env.NODE_ENV;

  // Support both testnet and mainnet
  const shouldLoadGcpSecrets = nodeEnv === 'mainnet' || nodeEnv === 'testnet';

  if (!shouldLoadGcpSecrets) {
    // eslint-disable-next-line no-console
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

    // Load ALL secrets into process.env (memory only - never written to disk)
    // Preserve environment-specific values that are already set (e.g., from docker-compose)
    const ENV_SPECIFIC_KEYS = ['DB_HOST', 'REDIS_HOST'];
    const secretsToLoad = { ...parsed };

    ENV_SPECIFIC_KEYS.forEach(key => {
      if (process.env[key] && parsed[key]) {
        // eslint-disable-next-line no-console
        console.log(`⚠️  Keeping existing ${key}=${process.env[key]} (not overwriting with GCP value)`);
        delete secretsToLoad[key];
      }
    });

    Object.assign(process.env, secretsToLoad);

    // Debug: verify critical secrets are loaded (without exposing values)
    const criticalKeys = ['DB_HOST', 'DB_USERNAME', 'DB_PASSWORD', 'DB_NAME', 'REDIS_PASSWORD'];
    const missingKeys = criticalKeys.filter(key => !process.env[key]);
    if (missingKeys.length > 0) {
      console.warn(`⚠️  Missing critical secrets in process.env: ${missingKeys.join(', ')}`);
    }

    // eslint-disable-next-line no-console
    console.log(`✅ Loaded ${Object.keys(parsed).length} secrets from GCP into memory`);
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
