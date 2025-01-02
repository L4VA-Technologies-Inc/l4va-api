import {
  Entity,
  PrimaryGeneratedColumn,
  Column, CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

@Entity('audit')
export class AuditEntity {

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar'})
  vaultId: string;

  @Column({ type: 'varchar', nullable: true })
  typeRequest: string;

  @Column({ type: 'varchar', nullable: true })
  endpoint: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
