import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { User } from '@/database/user.entity';

/**
 * Service for snapshot-related utility operations
 * Provides shared methods for working with snapshot data across governance services
 */
@Injectable()
export class SnapshotService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>
  ) {}

  /**
   * Resolve user IDs from snapshot addressBalances.
   * All addresses in the snapshot are included; unregistered wallets are silently skipped.
   * Returns deduplicated user IDs.
   *
   * @param addressBalances - Snapshot address balances record
   * @returns Array of unique user IDs
   */
  async getTokenHolderIdsFromSnapshot(addressBalances?: Record<string, string>): Promise<string[]> {
    if (!addressBalances) return [];
    const addresses = Object.keys(addressBalances);
    if (addresses.length === 0) return [];

    const users = await this.userRepository.find({
      where: { address: In(addresses) },
      select: ['id'],
    });

    // Deduplicate user IDs (though DB should already ensure uniqueness)
    return [...new Set(users.map(u => u.id))];
  }
}
