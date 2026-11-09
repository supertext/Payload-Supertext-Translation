import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "supertext_settings" ADD COLUMN "languages_l_en_review" boolean DEFAULT false;
  ALTER TABLE "supertext_settings" ADD COLUMN "languages_l_de_ch_review" boolean DEFAULT false;
  ALTER TABLE "supertext_settings" ADD COLUMN "languages_l_fr_ch_review" boolean DEFAULT false;
  ALTER TABLE "supertext_settings" ADD COLUMN "languages_l_it_ch_review" boolean DEFAULT false;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "supertext_settings" DROP COLUMN "languages_l_en_review";
  ALTER TABLE "supertext_settings" DROP COLUMN "languages_l_de_ch_review";
  ALTER TABLE "supertext_settings" DROP COLUMN "languages_l_fr_ch_review";
  ALTER TABLE "supertext_settings" DROP COLUMN "languages_l_it_ch_review";`)
}
