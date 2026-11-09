import { KeyManagementServiceClient } from '@google-cloud/kms';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Address, LocalAccount } from 'viem';

// Relative, not `@/`: specs that load the services importing this file run without the path alias.
import { createKmsAccount, type KmsSigningClient } from '../../../../common/evm/kms-account';

type Role = 'admin' | 'minting';

const CONFIG: Record<Role, { key: string; address: string; purpose: string }> = {
  admin: {
    key: 'EVM_ADMIN_KMS_KEY',
    address: 'EVM_ADMIN_ADDRESS',
    purpose: 'vault authority and creation approver',
  },
  minting: {
    key: 'EVM_MINTING_SIGNER_KMS_KEY',
    address: 'EVM_MINTING_SIGNER_ADDRESS',
    purpose: 'contribution minting key',
  },
};

/**
 * The backend's Robinhood signing keys. Both live in Cloud KMS and never leave
 * it; each is a full key-version resource name
 * (`projects/…/cryptoKeys/…/cryptoKeyVersions/N`) and must resolve to the
 * address configured beside it.
 *
 * Accounts are created on first use and cached. A failed load (KMS outage, IAM)
 * is not cached, so the next call retries instead of the process staying broken.
 */
@Injectable()
export class EvmKmsSigners implements OnModuleInit {
  private readonly logger = new Logger(EvmKmsSigners.name);
  private readonly accounts = new Map<Role, Promise<LocalAccount>>();
  private client: KmsSigningClient | null = null;

  readonly adminAddress: Address;
  readonly mintingAddress: Address;

  constructor(private readonly configService: ConfigService) {
    this.adminAddress = this.configService.get<string>(CONFIG.admin.address) as Address;
    this.mintingAddress = this.configService.get<string>(CONFIG.minting.address) as Address;
  }

  /** Loads both keys at boot so a misconfiguration shows up in the startup log, without blocking boot. */
  onModuleInit(): void {
    for (const role of Object.keys(CONFIG) as Role[]) {
      this.account(role)
        .then(account => this.logger.log(`KMS ${CONFIG[role].purpose} ready: ${account.address}`))
        .catch(err => this.logger.error(`KMS ${CONFIG[role].purpose} unavailable: ${(err as Error).message}`));
    }
  }

  /** Signs as the vault `authority` and `creationApprover`. */
  admin(): Promise<LocalAccount> {
    return this.account('admin');
  }

  /** Signs contribution authorizations as the vault `mintingKey`. */
  minting(): Promise<LocalAccount> {
    return this.account('minting');
  }

  private account(role: Role): Promise<LocalAccount> {
    const cached = this.accounts.get(role);
    if (cached) return cached;

    const loading = this.load(role);
    this.accounts.set(role, loading);
    loading.catch(() => this.accounts.delete(role));
    return loading;
  }

  private async load(role: Role): Promise<LocalAccount> {
    const { key, address, purpose } = CONFIG[role];
    const keyVersion = this.configService.get<string>(key);
    const expected = this.configService.get<string>(address) as Address | undefined;
    if (!keyVersion) throw new Error(`${key} is not configured (${purpose}).`);
    if (!expected) throw new Error(`${address} is not configured (${purpose}).`);

    this.client ??= new KeyManagementServiceClient() as unknown as KmsSigningClient;
    return createKmsAccount(this.client, keyVersion, expected);
  }
}
