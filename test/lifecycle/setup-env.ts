import { join } from 'path';

import { config } from 'dotenv';

// Runs before any test module is imported. Several src modules call dotenv at
// import time with `process.env.ENV_FILE || '.env'`; without this they would
// load the developer's own .env into the suite.
const envFile = join(__dirname, '.env.lifecycle-test');
process.env.ENV_FILE = envFile;
config({ path: envFile, override: true });
