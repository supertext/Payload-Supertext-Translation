import type { CollectionSlug, GlobalSlug, PayloadRequest } from 'payload'

import type { Politeness, SupertextEnvironment } from './supertext/client.js'

export type SupertextTranslationOptions = {
  /**
   * Collections that get the "Translate with Supertext" panel.
   * Only fields marked `localized` (directly or via an ancestor) are translated.
   */
  collections?: CollectionSlug[]
  /** Globals that get the panel. */
  globals?: GlobalSlug[]

  /**
   * Supertext API key. Defaults to `process.env.SUPERTEXT_API_KEY`. Never commit it.
   *
   * No Supertext account yet? Create one at https://www.supertext.com/person/en/account/signin.
   * Generate the key at supertext.com → Integrations → API (https://www.supertext.com/en/integrations/api);
   * this requires the Admin role in your Supertext account.
   */
  apiKey?: string
  /** `live` (default), `staging` or `testing`. Ignored when `apiUrl` is set. */
  environment?: SupertextEnvironment
  /** Explicit API base URL. Overrides `environment`. For Translation review use the settings' checkbox instead. */
  apiUrl?: string
  /**
   * Review service for locales with *Translation review* on (Supertext → Supertext settings).
   * Default: `process.env.SUPERTEXT_REVIEW_URL`, else Supertext's review service (`REVIEW_URL`).
   * `''` turns review off for every locale. Only change it when Supertext gives you another address.
   */
  reviewUrl?: string

  /**
   * Optional override of the *Supertext settings* screen (one combo box per locale), for
   * automated setups: Payload locale code → Supertext language code, e.g.
   * `{ de: 'de-CH', zh: 'zh-Hans' }`. An entry here wins over the screen (which then shows it
   * read-only). Without either, a locale that is a Supertext code (`de-CH`, `fr_ch`, `es`) is used
   * as it is, else the SDK's default (`de` → `de-DE`, `en` → `en-US`, `zh` → `zh-Hans`); a locale
   * with neither (`en-IE`, `de-LI`, `gsw`) fails with "has no Supertext language yet" and
   * nothing is sent. Supported codes: `SUPERTEXT_TARGETS` and docs/INSTALLATION.md.
   */
  languageMap?: Record<string, string>
  /**
   * Optional override of the formal/informal setting on the Supertext settings screen:
   * Payload locale code → politeness (`more` = formal, `less` = informal). Only for targets that
   * offer it (see docs/INSTALLATION.md); for others the translation fails with a clear message.
   */
  politeness?: Record<string, Politeness>
  /**
   * Optional override of the *Translation review* checkbox on the Supertext settings screen:
   * Payload locale code → on/off, e.g. `{ 'de-CH': true }`. An entry here wins (the checkbox is
   * then read-only).
   */
  review?: Record<string, boolean>
  /**
   * Who may open and change the *Supertext settings* (language mapping). Default: the `access`
   * option, else any logged-in user. Restrict it to administrators where your users have roles,
   * e.g. `({ req }) => req.user?.role === 'admin'`.
   */
  settingsAccess?: (args: { req: PayloadRequest }) => boolean | Promise<boolean>

  /**
   * "Send version information to Supertext": the site URL and the versions of this plugin,
   * Payload, Node.js and the Supertext SDK, whether an API key is set and the latest key check,
   * and the ping URL. No content, no API key, no personal data. Default: `true`.
   * The environment variable `SUPERTEXT_VERSION_REPORTS=0` turns it off (and `=1` on) regardless.
   */
  versionReports?: boolean

  /** Field names never translated at any depth. Default: `['slug']`. */
  skipFieldNames?: string[]
  /**
   * For collections/globals with drafts enabled, save translations as a draft so
   * an editor reviews before publishing. Default: `true`.
   */
  saveAsDraft?: boolean

  /** Delay between status polls. Default 2000 ms. */
  pollIntervalMs?: number
  /** Maximum wait for one translation. Default 180000 ms (3 min). */
  timeoutMs?: number

  /**
   * Who may start translations. Default: any logged-in user. Collection/global
   * update access is always enforced on top of this.
   */
  access?: (args: { req: PayloadRequest }) => boolean | Promise<boolean>

  /**
   * Show the Supertext panel (plugin version, API key check, languages, version reports) on the
   * admin dashboard, for users who may translate. Default: `true`.
   */
  dashboardPanel?: boolean

  /**
   * Keep the endpoints and admin controls out of the config (e.g. per environment) without
   * changing the database schema: the Supertext settings global stays, hidden from the admin.
   */
  disabled?: boolean
}

export type TranslateRequestBody = {
  collection?: string
  global?: string
  id?: number | string
  sourceLocale: string
  targetLocales: string[]
}

export type LocaleResult =
  | { locale: string; ok: true; segments: number; missing: string[] }
  | { locale: string; ok: false; error: string; code?: string; status?: number }

export type TranslateResponse = {
  results: LocaleResult[]
}

export type LanguageStatus = {
  locale: string
  /** The Supertext code it is sent as; null when it has none (no mapping and no default). */
  supertext: string | null
  /** Where the code comes from: the `languageMap` option, the Supertext settings, or automatic (exact match or SDK default). */
  origin: 'option' | 'settings' | 'automatic' | null
  politeness: Politeness
  /** False when `politeness` is set but the target offers no formal/informal choice. */
  politenessSupported: boolean
}

export type KeyCheckStatus = {
  status: 'ok' | 'invalid' | 'missing' | 'unreachable' | 'error'
  checkedAt: string
  httpStatus: number | null
  errorCode: string | null
}

export type StatusResponse = {
  apiKeyConfigured: boolean
  canTranslate: boolean
  locales: string[]
  languages: LanguageStatus[]
  version: string | null
  releaseUrl: string | null
  sdkVersion: string
  /** Admin path of the Supertext settings (language mapping). */
  settingsUrl: string
  reports: { enabled: boolean; pingUrl: string | null }
  keyCheck: KeyCheckStatus | null
}

export type FileExportRequestBody = TranslateRequestBody & {
  format: 'xliff' | 'html'
}

/** One job (item × target locale) of an imported translation file. */
export type FileImportJob = {
  /** `<collection> <id>` or the global's slug. */
  item: string
  targetLocale: string
  /** Set when the job couldn't be imported at all (other system, not found, no such locale…). */
  error?: string
  imported?: number
  /** Translated, but the source changed since the export, and not imported (the option was off). */
  sourceChanged?: number
  untranslated?: number
  invalid?: number
  missing?: number
}

export type FileImportResponse = {
  jobs: FileImportJob[]
}
