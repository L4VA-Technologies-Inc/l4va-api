import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Progress of the Uniswap v4 position scan of one pool (EvmV4PositionScanner): the token ids of
 * PositionManager positions that ever touched the pool, found by scanning `ModifyLiquidity` logs
 * from `start_block` up to `next_block - 1`. Kept so a restart resumes the scan instead of reading
 * the pool's whole history again.
 */
@Entity('evm_v4_position_scans')
export class EvmV4PositionScan {
  @PrimaryColumn({ name: 'pool_id', type: 'varchar', length: 66 })
  poolId: string;

  @PrimaryColumn({ name: 'position_manager', type: 'varchar', length: 42 })
  positionManager: string;

  @Column({ name: 'start_block', type: 'numeric', precision: 30, scale: 0 })
  startBlock: string;

  @Column({ name: 'next_block', type: 'numeric', precision: 30, scale: 0 })
  nextBlock: string;

  /** Token ids as decimal strings. */
  @Column({ name: 'token_ids', type: 'text', array: true, default: () => "'{}'" })
  tokenIds: string[];

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
