import { MigrationInterface, QueryRunner } from 'typeorm';

export class RenameVoteThresholdToCosigningInPresets1770374336607 implements MigrationInterface {
  name = 'RenameVoteThresholdToCosigningInPresets1770374336607';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "vault_preset"
      SET config = (config - 'voteThreshold') || jsonb_build_object('cosigningThreshold', config->'voteThreshold')
      WHERE config ? 'voteThreshold'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "vault_preset"
      SET config = (config - 'cosigningThreshold') || jsonb_build_object('voteThreshold', config->'cosigningThreshold')
      WHERE config ? 'cosigningThreshold'
    `);
  }
}
