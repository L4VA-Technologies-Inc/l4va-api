import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

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

  @Column({ name: 'policy_id', unique: true })
  policy_id: string;

  @Column({ name: 'token_id', nullable: true, type: 'text' })
  token_id: string | null;

  @Column({ name: 'collection_name', nullable: true, type: 'text' }) //using as Collection name for nft and Ticker for FT
  collection_name: string | null;

  @Column({ name: 'is_verified', type: 'boolean' })
  is_verified: boolean;

  @Column({ type: 'enum', enum: VerificationPlatform, nullable: true })
  platform: VerificationPlatform | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updated_at: Date;
}
