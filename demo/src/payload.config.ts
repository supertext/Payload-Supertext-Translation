import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { de } from '@payloadcms/translations/languages/de'
import { en } from '@payloadcms/translations/languages/en'
import { fr } from '@payloadcms/translations/languages/fr'
import { it } from '@payloadcms/translations/languages/it'
import path from 'path'
import { buildConfig } from 'payload'
import { supertextTranslation } from 'payload-supertext-translation'
import { fileURLToPath } from 'url'

import { Pages } from './collections/Pages'
import { migrations } from './migrations'
import { Users } from './collections/Users'
import { Header } from './globals/Header'
import { seed } from './seed'

const dirname = path.dirname(fileURLToPath(import.meta.url))

export default buildConfig({
  admin: {
    importMap: { baseDir: path.resolve(dirname) },
    meta: { titleSuffix: ' · Supertext Payload demo' },
    user: Users.slug,
  },
  collections: [Users, Pages],
  db: postgresAdapter({
    // The database is created on first start if it doesn't exist yet.
    pool: { connectionString: process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/payload_demo' },
    // Applied automatically on start in production. After changing collections or
    // globals, run `npm run payload migrate:create <name>` and commit the result.
    prodMigrations: migrations,
  }),
  editor: lexicalEditor(),
  globals: [Header],
  // Admin interface languages (Account → Language); the Supertext plugin brings its own strings for these.
  i18n: { fallbackLanguage: 'en', supportedLanguages: { de, en, fr, it } },
  localization: {
    defaultLocale: 'en',
    // "Publish" publishes only the language being viewed, so each translation is
    // reviewed and released on its own ("Publish all" stays in the dropdown).
    defaultLocalePublishOption: 'active',
    fallback: false,
    locales: [
      { code: 'en', label: 'English' },
      { code: 'de-CH', label: 'Deutsch (Schweiz)' },
      { code: 'fr-CH', label: 'Français (Suisse)' },
      { code: 'it-CH', label: 'Italiano (Svizzera)' },
    ],
  },
  onInit: seed,
  plugins: [
    supertextTranslation({
      apiUrl: process.env.SUPERTEXT_API_URL || undefined,
      collections: ['pages'],
      environment: (process.env.SUPERTEXT_ENVIRONMENT as 'live' | 'staging' | 'testing' | undefined) ?? 'live',
      globals: ['header'],
      // The language mapping is chosen under Supertext → Supertext settings (de-CH, fr-CH and
      // it-CH are Supertext codes already, `en` defaults to en-US); the seed sets German to formal.
    }),
  ],
  secret: process.env.PAYLOAD_SECRET || 'dev-only-secret-change-me',
  telemetry: false,
  typescript: { outputFile: path.resolve(dirname, 'payload-types.ts') },
})
