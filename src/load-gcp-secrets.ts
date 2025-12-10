import * as fs from 'fs';
import * as path from 'path';

import * as dotenv from 'dotenv';

export async function loadSecrets(): Promise<void> {
  dotenv.config();

  const nodeEnv = process.env.NODE_ENV;
  // eslint-disable-next-line no-console
  console.log(`NODE_ENV: ${nodeEnv}`);

  // Only use GCP Secret Manager for mainnet, otherwise use .env file only
  if (nodeEnv !== 'mainnet') {
    // eslint-disable-next-line no-console
    console.log(`Using .env file only (NODE_ENV=${nodeEnv})`);
    return;
  }

  // eslint-disable-next-line no-console
  console.log('Loading secrets from GCP Secret Manager for mainnet...');

  const credentialsFile = 'gcp-service-account.json';
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(process.cwd(), credentialsFile);

  if (!fs.existsSync(credentialsPath)) {
    // eslint-disable-next-line no-console
    console.warn(`GCP credentials file not found at ${credentialsPath}, using .env file only`);
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`Found GCP credentials file: ${credentialsPath}`);
  process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;

  if (!process.env.GCP_PROJECT_ID) {
    try {
      const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
      if (credentials.project_id) {
        process.env.GCP_PROJECT_ID = credentials.project_id;
        // eslint-disable-next-line no-console
        console.log(`Using project_id from credentials: ${credentials.project_id}`);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('Failed to read project_id from credentials:', e.message || e);
    }
  }

  if (!process.env.GCP_PROJECT_ID) {
    // eslint-disable-next-line no-console
    console.warn('GCP_PROJECT_ID not set, using .env file only');
    return;
  }

  const secretName = 'mainnet';
  const projectId = process.env.GCP_PROJECT_ID;

  try {
    const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');

    const client = new SecretManagerServiceClient();
    const secretPath = `projects/${projectId}/secrets/${secretName}/versions/latest`;
    // eslint-disable-next-line no-console
    console.log(`Accessing secret: ${secretPath}`);

    const [version] = await client.accessSecretVersion({ name: secretPath });

    const secrets = version.payload?.data?.toString() || '';
    const parsed = dotenv.parse(secrets);

    // eslint-disable-next-line no-console
    console.log(`Loaded ${Object.keys(parsed).length} secrets from GCP Secret Manager`);

    Object.assign(process.env, parsed);

    const envFilePath = path.join(process.cwd(), '.env');
    const existingEnv = dotenv.parse(fs.existsSync(envFilePath) ? fs.readFileSync(envFilePath, 'utf8') : '');
    const mergedEnv = { ...existingEnv, ...parsed };

    const envContent = Object.entries(mergedEnv)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    fs.writeFileSync(envFilePath, envContent, 'utf8');

    // eslint-disable-next-line no-console
    console.log(`Successfully loaded secrets from GCP Secret Manager (secret: ${secretName}) and updated .env file`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('Failed to load GCP secrets:', e.message || e);
    // eslint-disable-next-line no-console
    console.warn('Falling back to .env file only');
  }
}
