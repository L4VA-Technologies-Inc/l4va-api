import {
  MigrationInterface,
  QueryRunner,
  TableColumn,
} from 'typeorm';

export class CreateVault1733404518297 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('audit', 'rateRequest');
    await queryRunner.dropColumn('audit', 'countRequest');

    await queryRunner.addColumn('audit', new TableColumn({
      name: 'endpoint',
      type: 'varchar',
      isNullable: true,
    }));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn('audit_entity', new TableColumn({
      name: 'rateRequest',
      type: 'integer',
      isNullable: true,
    }));

    await queryRunner.addColumn('audit_entity', new TableColumn({
      name: 'countRequest',
      type: 'integer',
      isNullable: true,
    }));
    await queryRunner.dropColumn('audit', 'endpoint');
  }
}
