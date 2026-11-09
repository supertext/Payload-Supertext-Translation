import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_st_l_en" AS ENUM('sq', 'bg', 'zh-Hans', 'zh-Hant', 'hr', 'cs', 'da', 'nl', 'en-GB', 'en-US', 'fi', 'fr-FR', 'fr-CH', 'de-AT', 'de-DE', 'de-CH', 'el', 'hu', 'it-IT', 'it-CH', 'ja', 'ko', 'nb', 'pl', 'pt-BR', 'pt-PT', 'rm', 'ru', 'sr-Cyrl', 'sr-Latn', 'sk', 'sl', 'es', 'sv', 'gsw-u-sd-chbe', 'gsw-u-sd-chzh', 'tr');
  CREATE TYPE "public"."enum_st_l_en_tone" AS ENUM('default', 'more', 'less');
  CREATE TYPE "public"."enum_st_l_de_CH" AS ENUM('sq', 'bg', 'zh-Hans', 'zh-Hant', 'hr', 'cs', 'da', 'nl', 'en-GB', 'en-US', 'fi', 'fr-FR', 'fr-CH', 'de-AT', 'de-DE', 'de-CH', 'el', 'hu', 'it-IT', 'it-CH', 'ja', 'ko', 'nb', 'pl', 'pt-BR', 'pt-PT', 'rm', 'ru', 'sr-Cyrl', 'sr-Latn', 'sk', 'sl', 'es', 'sv', 'gsw-u-sd-chbe', 'gsw-u-sd-chzh', 'tr');
  CREATE TYPE "public"."enum_st_l_de_CH_tone" AS ENUM('default', 'more', 'less');
  CREATE TYPE "public"."enum_st_l_fr_CH" AS ENUM('sq', 'bg', 'zh-Hans', 'zh-Hant', 'hr', 'cs', 'da', 'nl', 'en-GB', 'en-US', 'fi', 'fr-FR', 'fr-CH', 'de-AT', 'de-DE', 'de-CH', 'el', 'hu', 'it-IT', 'it-CH', 'ja', 'ko', 'nb', 'pl', 'pt-BR', 'pt-PT', 'rm', 'ru', 'sr-Cyrl', 'sr-Latn', 'sk', 'sl', 'es', 'sv', 'gsw-u-sd-chbe', 'gsw-u-sd-chzh', 'tr');
  CREATE TYPE "public"."enum_st_l_fr_CH_tone" AS ENUM('default', 'more', 'less');
  CREATE TYPE "public"."enum_st_l_it_CH" AS ENUM('sq', 'bg', 'zh-Hans', 'zh-Hant', 'hr', 'cs', 'da', 'nl', 'en-GB', 'en-US', 'fi', 'fr-FR', 'fr-CH', 'de-AT', 'de-DE', 'de-CH', 'el', 'hu', 'it-IT', 'it-CH', 'ja', 'ko', 'nb', 'pl', 'pt-BR', 'pt-PT', 'rm', 'ru', 'sr-Cyrl', 'sr-Latn', 'sk', 'sl', 'es', 'sv', 'gsw-u-sd-chbe', 'gsw-u-sd-chzh', 'tr');
  CREATE TYPE "public"."enum_st_l_it_CH_tone" AS ENUM('default', 'more', 'less');
  CREATE TABLE "supertext_settings" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"languages_l_en" "enum_st_l_en" DEFAULT 'en-US',
  	"languages_l_en_tone" "enum_st_l_en_tone" DEFAULT 'default',
  	"languages_l_de_ch" "enum_st_l_de_CH" DEFAULT 'de-CH',
  	"languages_l_de_ch_tone" "enum_st_l_de_CH_tone" DEFAULT 'default',
  	"languages_l_fr_ch" "enum_st_l_fr_CH" DEFAULT 'fr-CH',
  	"languages_l_fr_ch_tone" "enum_st_l_fr_CH_tone" DEFAULT 'default',
  	"languages_l_it_ch" "enum_st_l_it_CH" DEFAULT 'it-CH',
  	"languages_l_it_ch_tone" "enum_st_l_it_CH_tone" DEFAULT 'default',
  	"updated_at" timestamp(3) with time zone,
  	"created_at" timestamp(3) with time zone
  );
  `)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "supertext_settings" CASCADE;
  DROP TYPE "public"."enum_st_l_en";
  DROP TYPE "public"."enum_st_l_en_tone";
  DROP TYPE "public"."enum_st_l_de_CH";
  DROP TYPE "public"."enum_st_l_de_CH_tone";
  DROP TYPE "public"."enum_st_l_fr_CH";
  DROP TYPE "public"."enum_st_l_fr_CH_tone";
  DROP TYPE "public"."enum_st_l_it_CH";
  DROP TYPE "public"."enum_st_l_it_CH_tone";`)
}
