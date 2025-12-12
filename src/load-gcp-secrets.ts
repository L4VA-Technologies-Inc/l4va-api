import * as fs from 'fs';
import * as path from 'path';

import * as dotenv from 'dotenv';

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
  const shouldLoadGcpSecrets = nodeEnv === 'mainnet';

  if (!shouldLoadGcpSecrets) {
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
      // eslint-disable-next-line no-console
      console.warn('Failed to read project_id from credentials:', e.message || e);
    }
  }

  if (!process.env.GCP_PROJECT_ID) {
    return;
  }

  const secretName = 'mainnet';
  const projectId = process.env.GCP_PROJECT_ID;

  try {
    const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');

    const client = new SecretManagerServiceClient();
    const secretPath = `projects/${projectId}/secrets/${secretName}/versions/latest`;

    const [version] = await client.accessSecretVersion({ name: secretPath });

    const secrets = version.payload?.data?.toString() || '';
    const parsed = dotenv.parse(secrets);

    Object.assign(process.env, parsed);

    const existingEnv = dotenv.parse(envExists ? fs.readFileSync(envFilePath, 'utf8') : '');
    const mergedEnv = { ...existingEnv, ...parsed };

    const envContent = Object.entries(mergedEnv)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    fs.writeFileSync(envFilePath, envContent, 'utf8');
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('Failed to load GCP secrets:', e.message || e);
    // eslint-disable-next-line no-console
    console.warn('Falling back to .env file only');
  }
}
