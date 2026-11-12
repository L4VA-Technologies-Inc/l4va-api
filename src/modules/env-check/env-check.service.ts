import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import axios from 'axios';

import { checkEnv, EnvIssue, EnvMap } from './env-check.rules';

import { AlertsService } from '@/modules/alerts/alerts.service';

const PROBE_TIMEOUT_MS = 8000;

/**
 * Validates env config once the app has booted (GCP secrets are already in process.env by then).
 *
 * - Static rules (env-check.rules.ts): network coherence across keys/addresses/URLs, formats.
 * - Live probes: RPC eth_chainId vs EVM_CHAIN_ID, Blockfrost key accepted by its network.
 *
 * Never blocks or crashes startup unless ENV_CHECK_STRICT=true and an error-level issue is found.
 * Issues are logged and sent to Slack as one `env_config_invalid` alert.
 */
@Injectable()
export class EnvCheckService implements OnApplicationBootstrap {
  private readonly logger = new Logger(EnvCheckService.name);

  constructor(private readonly alerts: AlertsService) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.ENV_CHECK_DISABLED === 'true') {
      this.logger.warn('Env check disabled via ENV_CHECK_DISABLED=true');
      return;
    }

    const env = process.env as EnvMap;
    const issues = checkEnv(env);
    this.report(issues, 'static');

    if (process.env.ENV_CHECK_STRICT === 'true' && issues.some(i => i.level === 'error')) {
      throw new Error('Env check failed (ENV_CHECK_STRICT=true); see log above');
    }

    // Live probes run in the background so a slow provider never delays boot.
    void this.runLiveProbes(env)
      .then(live => {
        this.report(live, 'live');
        const all = [...issues, ...live];
        if (all.length > 0) return this.alert(all, env);
      })
      .catch(e => this.logger.error(`Env live probes crashed: ${e instanceof Error ? e.message : e}`));
  }

  async runLiveProbes(env: EnvMap): Promise<EnvIssue[]> {
    const issues: EnvIssue[] = [];
    const expectedChainId = Number(env.EVM_CHAIN_ID?.trim());

    const rpcKeys = ['EVM_RPC_URL', 'ROBINHOOD_RPC_URL', 'ROBINHOOD_ALCHEMY_RPC_URL'];
    await Promise.all(
      rpcKeys.map(async key => {
        const url = env[key]?.trim();
        if (!url || !expectedChainId) return;
        try {
          const { data } = await axios.post(
            url,
            { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
            { timeout: PROBE_TIMEOUT_MS }
          );
          const actual = data?.result ? Number(BigInt(data.result)) : NaN;
          if (actual !== expectedChainId) {
            issues.push({
              level: 'error',
              key,
              message: `RPC reports chainId ${actual || data?.error?.message || '?'} but EVM_CHAIN_ID=${expectedChainId}`,
            });
          }
        } catch (e) {
          issues.push({ level: 'warn', key, message: `RPC unreachable: ${this.httpError(e)}` });
        }
      })
    );

    const bfKey = env.BLOCKFROST_API_KEY?.trim();
    const net = env.CARDANO_NETWORK?.trim();
    if (bfKey && net && ['mainnet', 'preprod', 'preview'].includes(net)) {
      try {
        await axios.get(`https://cardano-${net}.blockfrost.io/api/v0/`, {
          headers: { project_id: bfKey },
          timeout: PROBE_TIMEOUT_MS,
        });
      } catch (e) {
        const status = axios.isAxiosError(e) ? e.response?.status : undefined;
        issues.push({
          level: status === 400 || status === 403 ? 'error' : 'warn',
          key: 'BLOCKFROST_API_KEY',
          message:
            status === 400 || status === 403
              ? `rejected by Blockfrost ${net} (HTTP ${status}) — wrong network or revoked key`
              : `Blockfrost probe failed: ${this.httpError(e)}`,
        });
      }
    }

    return issues;
  }

  private report(issues: EnvIssue[], phase: 'static' | 'live'): void {
    if (issues.length === 0) {
      this.logger.log(`Env check (${phase}): OK`);
      return;
    }
    for (const i of issues) {
      const line = `Env check (${phase}) ${i.key}: ${i.message}`;
      if (i.level === 'error') this.logger.error(line);
      else this.logger.warn(line);
    }
    const errors = issues.filter(i => i.level === 'error').length;
    this.logger.warn(`Env check (${phase}): ${errors} error(s), ${issues.length - errors} warning(s)`);
  }

  private async alert(issues: EnvIssue[], env: EnvMap): Promise<void> {
    const errors = issues.filter(i => i.level === 'error');
    await this.alerts.sendAlert('env_config_invalid', {
      nodeEnv: env.NODE_ENV,
      cardanoNetwork: env.CARDANO_NETWORK,
      evmChainId: env.EVM_CHAIN_ID,
      errors: errors.map(i => `${i.key}: ${i.message}`),
      warnings: issues.filter(i => i.level === 'warn').map(i => `${i.key}: ${i.message}`),
    });
  }

  private httpError(e: unknown): string {
    if (axios.isAxiosError(e)) return e.response ? `HTTP ${e.response.status}` : e.code || e.message;
    return e instanceof Error ? e.message : String(e);
  }
}
