/**
 * Refuse to run unless every connection points at the throwaway lifecycle-test
 * services. The suite drops its database and sends transactions, so a stray
 * .env must never be able to aim it at a real environment.
 */
export function assertLifecycleTestEnv(env: NodeJS.ProcessEnv = process.env): void {
  const problems: string[] = [];
  if (env.DB_HOST !== 'localhost' || env.DB_PORT !== '5544') problems.push(`DB ${env.DB_HOST}:${env.DB_PORT}`);
  if (env.DB_NAME !== 'l4va_lifecycle_test') problems.push(`DB_NAME ${env.DB_NAME}`);
  if (env.REDIS_HOST !== 'localhost' || env.REDIS_PORT !== '6390' || env.BULL_REDIS_PORT !== '6390') {
    problems.push(`Redis ${env.REDIS_HOST}:${env.REDIS_PORT} (bull ${env.BULL_REDIS_PORT})`);
  }
  if (env.EVM_CHAIN_ID !== '31337' || env.EVM_RPC_URL !== 'http://127.0.0.1:8546') {
    problems.push(`EVM ${env.EVM_RPC_URL} chain ${env.EVM_CHAIN_ID}`);
  }
  if (problems.length > 0) {
    throw new Error(`Lifecycle tests only run against test/lifecycle services; refusing: ${problems.join(', ')}`);
  }
}
