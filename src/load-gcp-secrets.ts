import * as dotenv from 'dotenv';

export async function loadSecrets() {
  if (process.env.NODE_ENV !== 'prod') {
    dotenv.config();
    console.log('Loaded local .env');
    return;
  }

  try {
    const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');

    const client = new SecretManagerServiceClient();
    const name = `projects/${process.env.GCP_PROJECT_ID}/secrets/${process.env.GCP_SECRET_NAME || 'dev'}/versions/latest`;
    const [version] = await client.accessSecretVersion({ name });

    const secrets = version.payload?.data?.toString() || '';
    const parsed = dotenv.parse(secrets);
    Object.assign(process.env, parsed);

    console.log('Loaded secrets from GCP');
  } catch (e) {
    console.warn('Could not load GCP secrets, continuing without them:', e.message || e);
  }
}
