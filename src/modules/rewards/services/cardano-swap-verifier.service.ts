import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Address, BaseAddress, RewardAddress } from '@emurgo/cardano-serialization-lib-nodejs';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { ChainType } from '@/types/vault.types';

export type VerifiedCardanoSwap =
  | {
      ok: true;
      vault: Pick<Vault, 'id' | 'name' | 'script_hash'>;
      side: 'buy' | 'sell';
      /** Net change of the vault token in the caller's wallet (signed, raw units). */
      vtDelta: string;
      vtUnit: string;
    }
  | { ok: false; reason: string };

/**
 * Verifies a Cardano widget swap from chain data (Blockfrost) — the Cardano twin of
 * EvmSwapVerifier. Nothing in the request is trusted beyond the tx hash: the tx must exist, spend
 * at least one of the caller's UTxOs (so the caller made it), and change the caller's balance of a
 * vault token. The reward always goes to the authenticated user.
 */
@Injectable()
export class CardanoSwapVerifier {
  private readonly logger = new Logger(CardanoSwapVerifier.name);
  private readonly blockfrost: BlockFrostAPI | null;

  constructor(
    configService: ConfigService,
    @InjectRepository(Vault) private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(User) private readonly userRepository: Repository<User>
  ) {
    const projectId = configService.get<string>('BLOCKFROST_API_KEY');
    this.blockfrost = projectId ? new BlockFrostAPI({ projectId }) : null;
  }

  async verify(txHash: string, userId: string): Promise<VerifiedCardanoSwap> {
    if (!/^[0-9a-fA-F]{64}$/.test(txHash ?? '')) return { ok: false, reason: 'invalid transaction hash' };
    if (!this.blockfrost) return { ok: false, reason: 'swap verification unavailable' };

    const user = await this.userRepository.findOne({
      where: { id: userId },
      select: ['id', 'address', 'stake_address'],
    });
    if (!user?.address) return { ok: false, reason: 'caller has no Cardano address' };
    const callerStake = stakeKeyHashOf(user.stake_address) ?? stakeKeyHashOf(user.address);
    const isCaller = (addr: string): boolean =>
      addr === user.address || (!!callerStake && stakeKeyHashOf(addr) === callerStake);

    let utxos: Awaited<ReturnType<BlockFrostAPI['txsUtxos']>>;
    try {
      utxos = await this.blockfrost.txsUtxos(txHash.toLowerCase());
    } catch (err) {
      const status = (err as { status_code?: number }).status_code;
      if (status === 404) return { ok: false, reason: 'transaction not found on chain' };
      this.logger.warn(`Cardano swap verify ${txHash}: Blockfrost failed — ${(err as Error).message}`);
      return { ok: false, reason: 'could not verify transaction' };
    }

    const callerInputs = utxos.inputs.filter(i => !i.collateral && !i.reference && isCaller(i.address));
    if (callerInputs.length === 0) return { ok: false, reason: 'transaction was not made by the caller' };

    // Net change per token unit in the caller's wallet: outputs to the caller minus caller inputs.
    const delta = new Map<string, bigint>();
    const add = (unit: string, qty: string, sign: 1n | -1n): void => {
      if (unit === 'lovelace') return;
      delta.set(unit, (delta.get(unit) ?? 0n) + sign * BigInt(qty));
    };
    for (const i of callerInputs) for (const a of i.amount) add(a.unit, a.quantity, -1n);
    for (const o of utxos.outputs) {
      if (o.collateral || !isCaller(o.address)) continue;
      for (const a of o.amount) add(a.unit, a.quantity, 1n);
    }

    const moved = [...delta].filter(([, d]) => d !== 0n);
    if (moved.length === 0) return { ok: false, reason: 'no token moved to or from the caller' };

    const policies = [...new Set(moved.map(([unit]) => unit.slice(0, 56)))];
    const vault = await this.vaultRepository.findOne({
      where: { script_hash: In(policies), chain_type: ChainType.cardano },
      select: ['id', 'name', 'script_hash'],
    });
    if (!vault) return { ok: false, reason: 'no vault tokens involved' };

    const [vtUnit, vtDelta] = moved.find(([unit]) => unit.startsWith(vault.script_hash))!;
    return { ok: true, vault, side: vtDelta > 0n ? 'buy' : 'sell', vtDelta: vtDelta.toString(), vtUnit };
  }
}

/** Stake key hash of a bech32 base or stake address, or null (enterprise / script / invalid). */
function stakeKeyHashOf(bech32?: string | null): string | null {
  if (!bech32) return null;
  try {
    const addr = Address.from_bech32(bech32);
    const base = BaseAddress.from_address(addr);
    if (base) return base.stake_cred().to_keyhash()?.to_hex() ?? null;
    const reward = RewardAddress.from_address(addr);
    if (reward) return reward.payment_cred().to_keyhash()?.to_hex() ?? null;
    return null;
  } catch {
    return null;
  }
}
