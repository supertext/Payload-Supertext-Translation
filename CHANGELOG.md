# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Support for Node.js 24 and 26, tested in CI next to Node 20 and 22. Tested with Payload 3.92 (the demo runs 3.92.1 with Next.js 16.4.3). Payload 3.92 itself needs Node.js 22.23.4 or newer; the plugin still runs on Node 20 with older Payload 3 versions.
- **Translation review** per locale (**Supertext → Supertext settings** → *Translation review* under each locale, off by default): translations into a locale with it ticked go through Supertext's review service (Supertext Localization Review), where customers and Supertext linguists correct them on the website with a Chrome extension; corrections come back into Payload with the next translation, and texts translated before keep their (reviewed) wording. Same API key, billing, languages and messages; other locales keep going directly to Supertext. New options `reviewUrl` (default `SUPERTEXT_REVIEW_URL`, else Supertext's review service; `''` turns review off everywhere) and `review` (per-locale override, the checkbox is then read-only). All four interface languages. **SQL databases: create a migration after updating** (`npx payload migrate:create supertext_translation_review`): the *Supertext settings* global gets one boolean column per locale (`languages_l_<locale>_review`, default off).
- Requests to Supertext name the plugin's version in the User-Agent (`Payload-Supertext-Translation/<version>`).

- Export for translation (XLIFF 1.2 or HTML) and import of translated files; Supertext SDK 0.5.0. In the Translate control, *Export for translation* downloads the document's texts for the chosen languages as an XLIFF file (for translation tools) or an HTML file (one language, e.g. for Supertext's web app); *Import translation* reads the translated file back and saves it like a Supertext translation (as a draft where drafts are on), with a summary of imported, skipped (source changed since the export; optional), untranslated, invalid and missing texts. No API key needed; uploads up to 10 MB, never stored. New endpoints `POST /api/supertext/export` and `/api/supertext/import`.

- **Supertext settings** (admin sidebar → *Supertext* → *Supertext settings*): one combo box per Payload locale (source locale included) with Supertext's languages as *Name (code)*, preselected with Supertext's suggestion, plus a formal/informal select where the chosen language offers one. Stored in a new global `supertext-settings`; only Supertext's codes can be saved. New option `settingsAccess` (default: `access`, else any logged-in user) decides who may change it. **SQL databases: create a migration after updating** (`npx payload migrate:create supertext_settings`), and again whenever you add or remove a locale.
- The Supertext panel shows where each locale's code comes from (automatic, chosen in the settings, or the `languageMap` option) and links to the settings.
- Support: the Supertext support form is linked in the README, the user guide and GitHub's "New issue" page.

### Changed

- **Default languages** (bundled Supertext SDK 0.4.0, commit `6aaad33`): a locale nobody mapped now uses Supertext's obvious default instead of failing: `de` → `de-DE`, `en` → `en-US`, `fr` → `fr-FR`, `it` → `it-IT`, `pt` → `pt-PT`, `zh` → `zh-Hans`, `zh-TW` → `zh-Hant`, `sr` → `sr-Latn`, `es-ES` → `es`. Only locales without mapping and default (`en-IE`, `de-LI`, `gsw`, …) are still marked *no Supertext language yet* and fail with *has no Supertext language yet*; that message now points to *Supertext → Supertext settings*.
- The `languageMap` and `politeness` options are now optional overrides of the settings screen (they win per locale; such a combo box is read-only). Existing configurations keep working unchanged.

- Version reports, the API key check result and the reachability ping now use [Supertext Plugin Health](https://github.com/Supertext/Commando-Center-Supertext-Translation/tree/main/plugin-health) 0.1.0 (bundled in `src/vendor/supertext-plugin-health`); Supertext SDK updated to 0.3.0. No change for sites: settings and stored state stay as they are.
- **Languages: no more guessed codes** (bundled Supertext SDK 0.2.0, commit `c66cb4d`). Supertext accepts only the codes of its language list: `de-CH`, `en-US`, `pt-BR`, but bare `es`, `nl`, `sl`, and `zh-Hans`, `sr-Latn`. A Payload locale that is such a code (apart from case and `_`/`-`) is used as it is; every other locale needs an entry in `languageMap` (e.g. `{ en: 'en-US', de: 'de-CH', fr: 'fr-FR' }`). The default regions (`de` → `de-DE`, `es` → `es-ES`, `zh` → `zh-CN`, …) are gone: several were rejected by Supertext. **Check your locales after updating:** an unmapped locale is marked *no Supertext language yet* in the Translate menu, *Not mapped* on the new Supertext panel, and a translation into it fails with *The language … has no Supertext language yet* (nothing is sent). For a mapped locale used as the source, the mapped code's language is sent.
- A formal or informal tone (`politeness`) for a target without one (English, Swiss German, Romansh, Albanian, Serbian) now fails with *Supertext offers no formal or informal tone for this language* instead of being sent; the Supertext panel warns about it.
- After updating, run `npx payload generate:importmap`: the plugin adds a second client component (`payload-supertext-translation/client#SupertextStatus`).

### Added

- **Supertext panel** on the admin dashboard (for users who may translate; `dashboardPanel: false` hides it): plugin and SDK version, the latest API key check with its time and **Check again**, every locale with the Supertext code and tone it is sent with, and whether version information is sent.
- **Automatic API key check** (Supertext's cost-free `features` call) when the plugin first runs with a new key, on *Check again* and when Supertext rejects the key during a translation; messages in English, German, French and Italian with the links to create an account and generate a key.
- **Send version information to Supertext** (option `versionReports`, on by default; `SUPERTEXT_VERSION_REPORTS=0` turns it off): after an update and when the key check changes, the plugin sends the site URL, the plugin, Payload, Node.js and SDK versions, whether a key is set, the key check result and the ping URL to the Supertext Commando Center. No content, no API key, no personal data. The state is kept in Payload's key-value store (`payload.kv`); no migration needed.
- Public ping endpoint `GET /api/supertext/ping` (answers only while version information is sent), so Supertext can see that the site is reachable.
- Messages for the new Supertext errors `unsupported_language` and `unsupported_feature` in all four languages.

### Changed

- The connection to Supertext now uses the shared [Supertext SDK](https://github.com/Supertext/Supertext-API-SDK-and-Guide) (TypeScript SDK 0.1.0), compiled into the plugin, so nothing else needs installing. Translation works as before; an unsupported language pair now has its own message (*Supertext does not support this language pair*) in all four languages, and the file at Supertext is also deleted after errors. An unknown language (e.g. `xx-YY`) is now reported as an unsupported language pair too, not as "resource not found" (Supertext answers it with HTTP 404).

### Added

- French and Italian interface (and German where it was missing): the Translate control, its messages and the endpoints' errors follow the user's Payload admin language (English, German, French, Italian; other languages show English). Strings are merged into `i18n.translations` under the `supertext` namespace and can be overridden there. The demo offers all four admin languages.

### Changed

- The *Authentication failure* message now links to Supertext account signup and API key generation.

### Fixed

- **One language map for both directions** (bundled Supertext SDK 0.2.1, commit `eeba8fa`): a mapped locale is sent as a source in its source form (`{ de: 'de-CH' }` translates from `de`), so English as the source no longer fails with an `{ en: 'en-US' }` mapping.

- Bare locales such as `de` were sent as bare targets, which Supertext rejected with `INVALID_LANGUAGE_PAIR`. (An interim fix gave them a default region; that is replaced by the language mapping above.) Regional codes are matched regardless of case and `_`/`-` (`de_ch` → `de-CH`).

## [0.1.0] - 2026-10-07

### Changed

- Where the API key is set up (installation guide, README, `apiKey` option docs, demo `.env.example`) and in the "No Supertext API key is configured" server error, administrators now get links to create a Supertext account and to generate the API key at supertext.com → Integrations → API (requires the Admin role).

### Fixed

- Rich text is translated a whole paragraph at a time with formatting and links as inline tags, instead of one piece per formatted run. Sentences that contain bold text or links now translate naturally.
- Translating into several locales at once no longer fails with *Too many requests*: requests that hit Supertext's per-second rate limit are retried automatically.
- The API key now works whether it is entered with or without the `Supertext-Auth-Key ` prefix Supertext shows it with.

### Added

- Payload 3 plugin `supertextTranslation()` for collections and globals.
- **Translate** control in the edit view: translate the saved document from the current locale into one or more locales.
- Translation of localized `text` (incl. `hasMany`), `textarea` and Lexical `richText` fields, also inside groups, rows, collapsibles, tabs, arrays and blocks (incl. `blockReferences`). Rich-text formatting and links are preserved.
- Translations are saved as drafts when the collection/global has drafts enabled (`saveAsDraft`, default `true`).
- Endpoints `GET /api/supertext/status` and `POST /api/supertext/translate`, enforcing login, the `access` option and collection/global access.
- Supertext AI file translation API v1 client (live/staging/testing environments, custom `apiUrl`).
- Options: `languageMap`, `politeness`, `skipFieldNames` (default `slug`), per-field opt-out via `custom: { supertext: false }`, `pollIntervalMs`, `timeoutMs`, `disabled`.
- Installation, user and developer guides; CI on Node 20 and 22.
- Demo Payload site in `demo/` (Pages + Header, four Swiss locales, sample content, Postgres) with a Dockerfile for the Railway demo.
- Docs: screenshots in the user and installation guides (Translate control, result, rich text, locales), regenerated with `test/docs/screenshots.mjs`.
- Demo: accounts from `DEMO_ADMIN_*` and `DEMO_EDITOR_*` variables, created on every start if missing (`PAYLOAD_ADMIN_*` still work).
- Docs: how to publish one language at a time (`defaultLocalePublishOption: 'active'`), since Payload's default Publish releases all languages' drafts.
