import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableForeignKey,
} from 'typeorm';

export class CreateVaultEntities1733393364048 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'vault',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'uuid_generate_v4()',
          },
          {
            name: 'contractAddress',
            type: 'varchar',
            isNullable: false,
          },
          {
            name: 'type',
            type: 'varchar',
          },
          {
            name: 'status',
            type: 'varchar',
          },
          {
            name: 'fractionalizationTokenAddress',
            type: 'varchar',
            isNullable: true,
          },
          {
            name: 'fractionalizationPercentage',
            type: 'numeric',
            isNullable: true,
          },
          {
            name: 'tokenSupply',
            type: 'integer',
            isNullable: true,
          },
          {
            name: 'tokenDecimals',
            type: 'integer',
            isNullable: true,
          },
          {
            name: 'metadata',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'createdAt',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
          },
          {
            name: 'updatedAt',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
            onUpdate: 'CURRENT_TIMESTAMP',
          },
        ],
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'asset',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'uuid_generate_v4()',
          },
          {
            name: 'vaultId',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'type',
            type: 'varchar',
          },
          {
            name: 'contractAddress',
            type: 'varchar',
          },
          {
            name: 'tokenId',
            type: 'varchar',
            isNullable: true,
          },
          {
            name: 'quantity',
            type: 'numeric',
          },
          {
            name: 'floorPrice',
            type: 'numeric',
            isNullable: true,
          },
          {
            name: 'dexPrice',
            type: 'numeric',
            isNullable: true,
          },
          {
            name: 'metadata',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'addedAt',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
          },
          {
            name: 'updatedAt',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
            onUpdate: 'CURRENT_TIMESTAMP',
          },
        ],
      }),
    );

    await queryRunner.createForeignKey(
      'asset',
      new TableForeignKey({
        columnNames: ['vaultId'],
        referencedColumnNames: ['id'],
        referencedTableName: 'vault',
        onDelete: 'CASCADE',
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'proposal',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'uuid_generate_v4()',
          },
          {
            name: 'vaultId',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'type',
            type: 'varchar',
          },
          {
            name: 'quorum',
            type: 'numeric',
            isNullable: true,
          },
          {
            name: 'metadata',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'createdAt',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
          },
          {
            name: 'updatedAt',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
            onUpdate: 'CURRENT_TIMESTAMP',
          },
        ],
      }),
    );

    await queryRunner.createForeignKey(
      'proposal',
      new TableForeignKey({
        columnNames: ['vaultId'],
        referencedColumnNames: ['id'],
        referencedTableName: 'vault',
        onDelete: 'CASCADE',
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'stake',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'uuid_generate_v4()',
          },
          {
            name: 'vaultId',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'wallet',
            type: 'varchar',
          },
          {
            name: 'amount',
            type: 'numeric',
          },
          {
            name: 'metadata',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'createdAt',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
          },
          {
            name: 'updatedAt',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
            onUpdate: 'CURRENT_TIMESTAMP',
          },
        ],
      }),
    );

    await queryRunner.createForeignKey(
      'stake',
      new TableForeignKey({
        columnNames: ['vaultId'],
        referencedColumnNames: ['id'],
        referencedTableName: 'vault',
        onDelete: 'CASCADE',
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'vote',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'uuid_generate_v4()',
          },
          {
            name: 'proposalId',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'wallet',
            type: 'varchar',
          },
          {
            name: 'decision',
            type: 'varchar',
          },
          {
            name: 'amount',
            type: 'numeric',
          },
          {
            name: 'castAt',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
          },
          {
            name: 'confirmedAt',
            type: 'timestamp',
            isNullable: true,
          },
        ],
      }),
    );

    await queryRunner.createForeignKey(
      'vote',
      new TableForeignKey({
        columnNames: ['proposalId'],
        referencedColumnNames: ['id'],
        referencedTableName: 'proposal',
        onDelete: 'CASCADE',
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('vote');
    await queryRunner.dropTable('stake');
    await queryRunner.dropTable('proposal');
    await queryRunner.dropTable('asset');
    await queryRunner.dropTable('vault');
  }
}
