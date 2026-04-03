import { Entity, PrimaryGeneratedColumn, Column, BeforeInsert, BeforeUpdate } from 'typeorm';

export enum VerificationPlatform {
  DEXHUNTER = 'dexhunter',
  WAYUP = 'wayup',
  TAPTOOLS = 'taptools',
  MANUAL = 'manual',
  JPG_STORE = 'jpg.store',
}

@Entity('token_verifications')
export class TokenVerification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'policy_id' })
  policy_id: string;

  @Column({ name: 'token_id', nullable: true, type: 'text' })
  token_id: string | null;

  @Column({ name: 'collection_name', nullable: true, type: 'text' }) //using as Collection name for nft and Ticker for FT
  collection_name: string | null;

  @Column({ name: 'is_verified', type: 'boolean' })
  is_verified: boolean;

  @Column({ type: 'enum', enum: VerificationPlatform, nullable: true })
  platform: VerificationPlatform | null;

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  created_at: Date;

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  updated_at: Date;

  @BeforeInsert()
  setDates(): void {
    const now = new Date();
    this.created_at = now;
    this.updated_at = now;
  }

  @BeforeUpdate()
  updateDate(): void {
    this.updated_at = new Date();
  }
}
