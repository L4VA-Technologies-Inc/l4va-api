import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Snapshot } from '@/database/snapshot.entity';
import { User } from '@/database/user.entity';

/**
 * Service for snapshot-related utility operations
 * Provides shared methods for working with snapshot data across governance services
 */
@Injectable()
export class SnapshotService {
  private readonly logger = new Logger(SnapshotService.name);

  constructor(
    @InjectRepository(Snapshot)
    private readonly snapshotsRepository: Repository<Snapshot>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>
  ) {}

  /**
   * Resolve user IDs of everyone with voting weight in the snapshot: VT holders plus,
   * on EVM, owners of Uniswap positions holding VT (`lpBalances`).
   * Unregistered wallets are silently skipped. Returns deduplicated user IDs.
   */
  async getTokenHolderIdsFromSnapshot(
    snapshot?: Pick<Snapshot, 'addressBalances' | 'lpBalances'> | null
  ): Promise<string[]> {
    if (!snapshot) return [];
    const holders = [...Object.keys(snapshot.addressBalances ?? {}), ...Object.keys(snapshot.lpBalances ?? {})];
    const addresses = [...new Set(holders.map(address => address?.trim().toLowerCase()))].filter(
      (address): address is string => !!address
    );
    if (addresses.length === 0) return [];

    const users = await this.userRepository
      .createQueryBuilder('user')
      .select('user.id', 'id')
      .where('LOWER(user.address) IN (:...addresses)', { addresses })
      .getRawMany<{ id: string }>();

    if (users.length === 0) {
      this.logger.debug(`No token-holder users matched snapshot addresses (addresses=${addresses.length}).`);
    }

    // Deduplicate user IDs (though DB should already ensure uniqueness)
    return [...new Set(users.map(u => u.id))];
  }

  /**
   * Fetch the latest snapshot for a vault and return token holder IDs.
   * Returns empty array if no snapshot exists.
   *
   * @param vaultId - The vault ID to fetch snapshot for
   * @returns Array of unique user IDs from the latest snapshot
   */
  async getTokenHolderIdsFromLatestSnapshot(vaultId: string): Promise<string[]> {
    const snapshot = await this.snapshotsRepository.findOne({
      where: { vaultId },
      order: { createdAt: 'DESC' },
      select: ['addressBalances', 'lpBalances'],
    });

    return this.getTokenHolderIdsFromSnapshot(snapshot);
  }
}
