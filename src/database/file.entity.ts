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
  updated_at: Date;

  @Expose({ name: 'createdAt' })
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  created_at: Date;

  @BeforeInsert()
  setDate() {
    const now = new Date();
    this.created_at = now;
    this.updated_at = now;
  }

  @BeforeUpdate()
  updateDate() {
    this.updated_at = new Date();
  }
}
