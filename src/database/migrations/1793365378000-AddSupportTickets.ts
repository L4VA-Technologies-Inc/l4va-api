import { MigrationInterface, QueryRunner } from 'typeorm';

/** In-app support chats mirrored to Discord ticket channels. */
export class AddSupportTickets1793365378000 implements MigrationInterface {
  name = 'AddSupportTickets1793365378000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "public"."support_tickets_status_enum" AS ENUM('open', 'closed')`);
    await queryRunner.query(`
      CREATE TABLE "support_tickets" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "number" SERIAL NOT NULL,
        "user_id" uuid NOT NULL,
        "status" "public"."support_tickets_status_enum" NOT NULL DEFAULT 'open',
        "chain" character varying(16),
        "discord_channel_id" character varying,
        "discord_webhook_id" character varying,
        "discord_webhook_token" character varying,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "last_message_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "closed_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "UQ_support_tickets_number" UNIQUE ("number"),
        CONSTRAINT "PK_support_tickets" PRIMARY KEY ("id"),
        CONSTRAINT "FK_support_tickets_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_support_tickets_user_id" ON "support_tickets" ("user_id")`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_support_tickets_discord_channel_id" ON "support_tickets" ("discord_channel_id")`
    );

    await queryRunner.query(`CREATE TYPE "public"."support_messages_author_enum" AS ENUM('user', 'team', 'system')`);
    await queryRunner.query(`
      CREATE TABLE "support_messages" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "ticket_id" uuid NOT NULL,
        "author" "public"."support_messages_author_enum" NOT NULL,
        "author_name" character varying(100),
        "content" text NOT NULL,
        "discord_message_id" character varying,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_support_messages" PRIMARY KEY ("id"),
        CONSTRAINT "FK_support_messages_ticket" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_support_messages_ticket_created" ON "support_messages" ("ticket_id", "created_at")`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_support_messages_discord_message_id" ON "support_messages" ("discord_message_id")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "support_messages"`);
    await queryRunner.query(`DROP TYPE "public"."support_messages_author_enum"`);
    await queryRunner.query(`DROP TABLE "support_tickets"`);
    await queryRunner.query(`DROP TYPE "public"."support_tickets_status_enum"`);
  }
}
