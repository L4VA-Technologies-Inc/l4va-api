import {
  BeforeInsert,
  BeforeUpdate,
  Column,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity({ name: 'files' })
export class FileEntity {

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', nullable: false })
  key: string;

  @Column({ type: 'varchar', nullable: false })
  url: string;

  @Column({ type: 'varchar' })
  file_type: string;

  @Column('jsonb', { nullable: true })
  metadata: {}

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  updated_at: string;

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  created_at: string;

  @BeforeInsert()
  setDate() {
    this.created_at = new Date().toISOString();
  }

  @BeforeUpdate()
  updateDate() {
    this.updated_at = new Date().toISOString();
  }
}
