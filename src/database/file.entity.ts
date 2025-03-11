import {
  BeforeInsert,
  BeforeUpdate,
  Column,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';
import {Expose} from "class-transformer";

@Entity({ name: 'files' })
export class FileEntity {

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', nullable: false })
  key: string;

  @Column({ type: 'varchar', nullable: false })
  url: string;

  @Expose({ name: 'fileType'})
  @Column({name: 'file_type', type: 'varchar' })
  file_type: string;

  @Expose({ name: 'fileName'})
  @Column({name: 'file_name', type: 'varchar' })
  file_name: string;

  @Column('jsonb', { nullable: true })
  metadata: {}

  @Expose({ name: 'updatedAt'})
  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  updated_at: string;

  @Expose({ name: 'createdAt'})
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
