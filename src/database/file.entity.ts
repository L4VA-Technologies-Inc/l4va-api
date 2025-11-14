import { Expose } from 'class-transformer';
import { BeforeInsert, BeforeUpdate, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'files' })
export class FileEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Expose({ name: 'key' })
  @Column({ name: 'file_key', type: 'varchar', nullable: false })
  file_key: string;

  @Expose({ name: 'url' })
  @Column({ name: 'file_url', type: 'varchar', nullable: false })
  file_url: string;

  @Expose({ name: 'fileType' })
  @Column({ name: 'file_type', type: 'varchar' })
  file_type: string;

  @Expose({ name: 'fileName' })
  @Column({ name: 'file_name', type: 'varchar' })
  file_name: string;

  @Expose({ name: 'metadata' })
  @Column({ name: 'metadata', type: 'jsonb', nullable: true })
  metadata: any;

  @Expose({ name: 'updatedAt' })
  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  updated_at: string;

  @Expose({ name: 'createdAt' })
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
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
