# Developer guide

## Architecture

```
src/
  index.ts                 plugin factory: adds endpoints, the Translate control and the dashboard panel
  types.ts                 plugin options and endpoint request/response types
  endpoints.ts             /api/supertext/status, /translate, /export, /import, /check-key, /ping (auth, validation)
  reporting.ts             Commando Center glue: site URL, state in payload.kv, when Plugin Health's reporter runs
  versions.ts              plugin version (its package.json) and Payload version at runtime
  translate.ts             loadItem() (read source, collect, save into a locale) and translateDocument(): → Supertext → write target locales
  files.ts                 translation files: export (XLIFF/HTML) and import with the SDK's TranslationFiles, reference format
  collect.ts               walks the field schema + document; returns Segments and the update payload
  segments.ts              Segment type, HTML build/parse, applying translations
  lexical.ts               Lexical inline content <-> inline HTML (one segment per paragraph)
  languages.ts             Payload locale → Supertext code (the SDK's Languages: mapping, exact match, default)
  settings.ts              the Supertext settings global (one select per locale) and reading it (mapping + options)
  supertext/client.ts      the plugin's Supertext client on top of the Supertext SDK (no Payload dependency); forReview() for locales with Translation review
  vendor/supertext-sdk/    Supertext SDK sources (TypeScript), compiled with the plugin; see *Supertext SDK*
  vendor/supertext-plugin-health/  Supertext Plugin Health sources (TypeScript), compiled with the plugin; see *Supertext Plugin Health*
scripts/vendor-sdk.sh      updates src/vendor/supertext-sdk
scripts/vendor-plugin-health.sh  updates src/vendor/supertext-plugin-health
  translations.ts          UI and error strings in en/de/fr/it (namespace `supertext`)
  i18n.ts                  merges them into config.i18n.translations; req.t()-based messages for the endpoints
  components/TranslateButton.tsx   client component in the edit view header
  components/SupertextStatus.tsx   client component on the dashboard (admin.components.afterDashboard)
  exports/client.ts        'payload-supertext-translation/client' entry (import map)
demo/                      demo Payload site (Next.js), deployed to Railway — see "Demo app"
```

### Flow of one translation

1. The editor clicks **Translate** (`TranslateButton`, in `admin.components.edit.beforeDocumentControls` for collections and `admin.components.elements.beforeDocumentControls` for globals). It POSTs `{ collection | global, id, sourceLocale, targetLocales }` to `/api/supertext/translate`.
2. `endpoints.ts` checks the user, the `access` option, the API key, the slug allow-list and the locales.
3. `translateDocument` reads the saved source with `findByID`/`findGlobal` (`depth: 0`, `fallbackLocale: false`, latest draft when drafts are enabled) with `overrideAccess: false` and the editor as `user`.
4. Per target locale (in parallel): `collectSegments` deep-clones the document and walks the **sanitized** field config (`payload.collections[slug].config.fields`; `blockReferences` resolve via `payload.config.blocks`). Each localized text becomes a `Segment` that points at its location in the clone (`holder[key]`). The clone is trimmed to the top-level keys holding segments; it is the update payload.
5. `buildHtml` renders segments into one HTML file; `SupertextClient.translateHtml` runs the API round trip; `parseHtml` + `applyTranslations` write results into the clone.
6. Saves run **serialized** (`payload.update` / `updateGlobal` with `locale`, `draft`), because parallel saves of one document race on its version history and lose a locale.
7. The response lists a result per locale; one failing locale doesn't stop the others.

### Translation files (export and import)

*Export for translation* and *Import translation* (tabs in the Translate control) use the SDK's `TranslationFiles` (SDK 0.5.0, `src/vendor/supertext-sdk/translation-file.ts`, imported from `src/vendor/supertext-sdk/index.js`: it doesn't call the API, so it isn't in `v1/`). The glue is `src/files.ts`:

- **Segments:** `loadItem(...).collect()`, the same collector as API translation; the file key is the segment's `path` (`title`, `layout.0.heading`, `body.root.0` for a Lexical paragraph), rich text goes as its inline HTML (`html: true`, with the `data-n` attributes the Lexical rebuild needs), plain fields as text.
- **Job metadata:** `plugin` = `Payload-Supertext-Translation`; `sourceLanguage`/`targetLanguage` = the codes the mapping resolves (`Languages.source`/`target` with the settings and `languageMap`), else the Payload code with `_` → `-`, so unmapped locales can still be exported.
- **Reference format:** `collection:<slug>:<id>:<sourceLocale>:<targetLocale>` or `global:<slug>:<sourceLocale>:<targetLocale>`, each part URI-encoded (`formatReference`/`parseReference`). The source locale is part of it because the import must collect the segments from the same locale again.
- **Export** (`POST /api/supertext/export`, `exportItem`): XLIFF = one job per target locale in one file (`exportXliff`), HTML = exactly one target (`exportHtml`). File name `payload-<collection>-<id>[-<locale>].xlf|.html` (globals: `payload-<slug>-…`), `Content-Disposition: attachment`.
- **Import** (`POST /api/supertext/import`, raw file as the body, `?includeChanged=1`; `readUpload` refuses more than 10 MB by `Content-Length` and while streaming; nothing is stored): `TranslationFiles.read`, then per job: `plugin` must be ours (else *other system*), the reference must parse and name an enabled collection/global (else *not found*), both locales must exist (else *no language*), the item is loaded with the editor's access (`overrideAccess: false`), collected again and passed to `importTranslations`. `ok` results (and `source_changed` with the option) are written into the clone with the same rules as API results (plain: `holder[key]`, rich: the segment's `apply`); every other place gets the target locale's current value back (else it keeps the source, as API translation does), and the clone is saved with `item.save` (draft where drafts are on, serialized). Nothing is saved when nothing was imported.
- The response is `{ jobs: FileImportJob[] }` with the counts per job, or `{ error }` for errors of the whole file (`TranslationFileError` codes, too large: 413).

### Field rules

- Localized = field or any ancestor has `localized: true`.
- Translated leaf types: `text` (incl. `hasMany`), `textarea`, `richText` (Lexical JSON).
- Opt-out: `custom: { supertext: false }` or `custom: { supertext: { translate: false } }`; names in `skipFieldNames` (default `slug`).
- **Row ids**: rows of non-localized arrays/blocks keep their `id` (rows are shared across locales; Payload matches them by id). Rows inside a localized array/blocks field (and below) have `id` removed, so the target locale gets fresh rows instead of colliding with the source locale's row ids.
- Non-localized siblings inside included arrays are sent with their unchanged source values.

### HTML format

```html
<!DOCTYPE html>
<html><head><meta charset="utf-8"></head><body>
<p data-st-id="0">Plain field text</p>
<p data-st-id="1">Need a <b data-n="0">human review</b>? Read <a data-n="1" href="https://example.com">our guide</a>.</p>   <!-- one Lexical paragraph -->
</body></html>
```

- Text is HTML-escaped; every segment carries `data-st-id` = its index. Supertext keeps markup and attributes and translates text nodes.
- Each Lexical block element whose children are inline (paragraph, heading, list item, quote) is **one segment**, sent as inline HTML (`src/lexical.ts`): formatted text nodes become `<b>`, `<i>`, `<u>`, `<s>`, `<code>`, `<sub>`, `<sup>` (or `<span>`), links `<a href>`, line breaks `<br>`, each tagged `data-n` = index of the original node; unformatted text is bare. The translator can reorder words across formatting. On the way back each tagged element clones its original node (format, style, link fields) with the translated text; bare text becomes plain text nodes; tags the translator added are dropped, their text kept.
- Earlier versions sent every text node as its own `<span data-st-id>`. The live API translates each `data-st-id` element on its own, which broke sentences at formatting boundaries (lower-case sentence starts, text moved outside spans), so don't go back to that.
- Plain fields: leading/trailing whitespace is stored on the segment and re-applied.
- A segment missing or empty in the response keeps its source text and is reported in `missing` (logged as a warning, surfaced to the editor).

### Interface strings

All strings the plugin shows live in `src/translations.ts` (`en`, `de`, `fr`, `it`). `withSupertextTranslations` (in `src/i18n.ts`) merges them into `config.i18n.translations` under the `supertext` namespace: each language gets its own strings, every other supported language gets English, and strings the project defines itself win. The client component reads them with `useTranslation()` (`t('supertext:translate')`); the endpoints and `translateDocument` use the request's `req.t` through `translate(req, key)` and `errorMessage(req, err)`, so editors get server messages in their admin language too. Placeholders use Payload's `{{name}}` syntax.

`SupertextError.message` stays English (logs, API clients). UIs translate `code` (`error_<code>` keys) and append `detail`, the API's own text.

New or changed strings need all four languages in the same commit: formal address (Sie, vous, Lei), Payload's own terms (*Dokument*/*document*/*documento*, *Entwurf*/*brouillon*/*bozza*), "Supertext", `{{placeholders}}` and URLs unchanged. `test/translations.test.ts` checks keys, placeholders and URLs.

## Supertext API protocol

AI file translation API v1, same as the WordPress plugin and every other Supertext plugin, done by the Supertext SDK. Base URLs: `https://api.supertext.com/v1/` (live), `https://api.staging.supertext.com/v1/`, `https://api.testing.supertext.com/v1/`. Header `Authorization: Supertext-Auth-Key <key>`; the key may be configured with or without the `Supertext-Auth-Key ` prefix, exactly one is sent.

| Step | Request | Notes |
| --- | --- | --- |
| Upload | `POST translate/ai/file` multipart: `file` (`content.html`, type exactly `text/html`), `target_lang`, optional `source_lang`, optional `politeness` (`more`/`less`) | Returns `{ file_id }`. A `; charset=` suffix on the part type is rejected with 415. Up to 1,000,000 characters per file. |
| Poll | `GET translate/ai/file/{id}/status` | `translating` → keep polling; `done`; `error`; `limit_exceeded`; `deleted`. |
| Download | `GET translate/ai/file/{id}/translation` | Translated HTML. |
| Delete | `DELETE translate/ai/file/{id}` | Always attempted, also after errors; files expire after 24 h. |
| Key check | `GET features` | Cost-free (the SDK's `SupertextClient.checkApiKey`, run by Plugin Health's reporter; see *Commando Center*). |

Errors are the SDK's `SupertextError` with a stable `code`: `missing_api_key`, `authentication_failure` (401/403), `invalid_language_pair` (404 `INVALID_LANGUAGE_PAIR`), `unsupported_language` (the locale has no Supertext code; nothing sent; `targetLang`/`sourceLang` name it, shown as `{{language}}`), `unsupported_feature` (400 `FEATURE_ERROR`, e.g. politeness for `en-US`), `not_found` (404), `payload_too_large` (413), `too_many_requests` (429), `service_unavailable` (5xx), `unexpected_status`, `transport_error`, `no_file_id`, `translation_error`, `quota_exceeded`, `file_deleted`, `timeout`, `incomplete_response`; `detail` carries the API's own text (at most 200 characters). Each code has an `error_<code>` message in all four languages. The API key never appears in messages.

**Rate limit:** the API limits requests per second per key (HTTP 429, `RATE_LIMIT_EXCEEDED`); translating into several languages at once hits it. A 429 is retried up to 4 times, waiting for `Retry-After` if sent, otherwise 1, 2, 4 and 8 seconds (plus jitter, at most 30 s), before reporting *Too many requests*.

### Supertext SDK

All Supertext calls go through the [Supertext SDK](https://github.com/Supertext/Supertext-API-SDK-Guide) (`sdk/typescript`), the shared client of all Supertext plugins: it provides the client and the API key check (`checkApiKey()`, `apiKeyFingerprint`, `SDK_VERSION`); version reports and the ping are in *Supertext Plugin Health* (below). Its TypeScript sources (the whole `src/` tree, with the API in the versioned folder `v1/`) are copied into `src/vendor/supertext-sdk/` and compiled with the plugin into `dist/vendor/supertext-sdk/`, so sites install nothing besides the plugin; `COMMIT` and `VERSION` name the SDK commit and version. Never edit the copy: fix the SDK repository and copy it again:

```bash
scripts/vendor-sdk.sh                  # latest main of the SDK repository
scripts/vendor-sdk.sh <commit-or-tag>
SDK_DIR=../Supertext-API-SDK-Guide scripts/vendor-sdk.sh   # a local clone
```

Then run typecheck, tests and build, and note the update in `CHANGELOG.md`. The plugin imports the API from `src/vendor/supertext-sdk/v1/index.js` (the SDK's `supertext-sdk/v1`) and `SDK_VERSION` from `src/vendor/supertext-sdk/version.js`. `src/supertext/client.ts` wraps the SDK client (options in milliseconds, a `fetch` for tests, the User-Agent `supertext-sdk-typescript Payload-Supertext-Translation/<version>`, the version from package.json as in the reports, `versions.ts` → `userAgent()`) and keeps the plugin's exported `SupertextClient`, `SupertextError` and `SUPERTEXT_ENVIRONMENTS`.

### Supertext Plugin Health

[Supertext Plugin Health](https://github.com/Supertext/Commando-Center-Supertext-Translation/tree/main/plugin-health) (`plugin-health/typescript` in the Commando Center repository) sends the version reports and the API key check result to the Supertext Commando Center and answers its reachability ping (`InstallationReporter`, `reportsEnabled()`, `reporterState()`, `pingResponse()`; see *Commando Center*). It has no dependencies and doesn't need the SDK: `src/reporting.ts` passes in the SDK's `SDK_VERSION` and a key checker built from the SDK's `checkApiKey()` and `apiKeyFingerprint`. Like the SDK, its sources are copied into `src/vendor/supertext-plugin-health/` (imported from `src/vendor/supertext-plugin-health/index.js`) and compiled with the plugin; `COMMIT` and `VERSION` name the commit and version. Never edit the copy: fix it in Commando-Center-Supertext-Translation/plugin-health and copy it again:

```bash
scripts/vendor-plugin-health.sh plugin-health-v0.1.0   # a release tag
scripts/vendor-plugin-health.sh                        # latest main of the Commando Center repository
PLUGIN_HEALTH_DIR=../Commando-Center-Supertext-Translation scripts/vendor-plugin-health.sh   # a local clone
```

Then run typecheck, tests and build, and note the update in `CHANGELOG.md`.

### Language codes

Supertext accepts exactly the codes of its `GET features` list (the SDK's `Languages.TARGETS` / `Languages.SOURCES`, `spec/languages.json` in the SDK repo): **sources are bare** (`en`, `de`); **targets** are regional only for German, English, French, Italian and Portuguese (`de-CH`, `en-US`, `pt-BR`), `zh-Hans`/`zh-Hant`, `sr-Latn`/`sr-Cyrl`, `gsw-u-sd-chzh`/`gsw-u-sd-chbe`, and **bare for all others** (`es`, `nl`, `sl`). Anything else is rejected (`INVALID_LANGUAGE_PAIR`, HTTP 404) — e.g. `es-ES`, `sl-SI`, `zh-CN`.

**The mapping** (`src/settings.ts`): the global `supertext-settings` has a group `languages` with one row per Payload locale (built from `config.localization.locales` when the plugin runs): a `select` named `l_<locale>` (non-alphanumerics → `_`, made unique; enum `enum_st_l_<locale>`) whose options are the SDK's `Languages.targetOptions()` as *Name (code)* (names from `Intl.DisplayNames` per admin language, the SDK's English name as fallback), `defaultValue` = `Languages.suggestTarget(locale)` (none → Payload's empty *Select a value*), `l_<locale>_tone` (`default`/`more`/`less`) whose `admin.condition` shows it only where the chosen target supports politeness, and the checkbox `l_<locale>_review` (*Translation review*, default `false`, column `languages_l_<locale>_review`). Payload validates select values against the options server-side. Access: `settingsAccess`, else `access`, else a logged-in user; `readVersions` is off. `loadSettings(payload)` reads it (`overrideAccess`, codes not in the SDK list ignored, errors logged at debug and treated as empty); `effectiveSettings(saved, options)` puts the `languageMap`/`politeness`/`review` options on top per locale and drops a saved tone the effective target lacks. A locale set by an option gets a read-only select with a note. Adding or removing a locale (or an SDK release with new targets) changes the schema: SQL users need a migration. With `disabled`, the global stays (hidden) so the schema doesn't change.

**Translation review** (`l_<locale>_review` or the `review` option, per target locale): `translateDocument` takes `client.forReview(settings.review[locale])` for each target, a second SDK client (created once per `SupertextClient`) with the same key, timeouts, `fetch` and User-Agent whose base URL is `reviewUrl` (the option, else `SUPERTEXT_REVIEW_URL`, else `REVIEW_URL`, the translation proxy of [Supertext Localization Review](https://github.com/Supertext/Localization-Review-Supertext-Translation); `resolveReviewUrl()` in `src/endpoints.ts`). `translateHtml` is one round trip on one SDK client, so a job is always collected (status, download, delete) by the client that submitted it. The proxy speaks the same API v1, forwards to the live Supertext API with the plugin's key, stores every segment per key and serves reviewers' corrections on the next upload, so nothing else changes in the plugin. `reviewUrl: ''` (or the same URL as the API) means `forReview()` always returns the direct client. The key check and reports (`src/reporting.ts`, their own SDK client) and file export/import (no API calls) never use the review service.

**Resolution** (`src/languages.ts`), with the effective mapping:

- `targetCode(locale, map)` = `Languages.target()`: the mapping wins (sent as given), else a locale equal to a Supertext code apart from case and `_`/`-` (`de_ch` → `de-CH`, `es`), else the SDK default (`Languages.defaultTarget`: `de` → `de-DE`, `en` → `en-US`, `fr` → `fr-FR`, `it` → `it-IT`, `pt` → `pt-PT`, `zh`/`zh-CN`/`zh-SG` → `zh-Hans`, `zh-TW`/`zh-HK`/`zh-MO` → `zh-Hant`, `sr` → `sr-Latn`, `es-ES` → `es`), else `SupertextError('unsupported_language')` and nothing is sent (`en-IE`, `de-LI`, `gsw`, `sr-RS`). `targetCodeOrNull` is the same without throwing (status panel, Translate menu); `suggestTargetCode` (= `Languages.suggestTarget`) is the select's preselection.
- `languageStatus()` (status endpoint) reports per locale the code, `origin` (`option`, `settings` — only when the saved value differs from the suggestion —, `automatic`, or `null` without code) and the tone; the response's `settingsUrl` links the panel to the global.
- `sourceCode(locale, languageMap)`: the SDK's `Languages.source(locale, languageMap)`. One map serves both directions: a mapped value is sent in its source form (`{ de: 'de-CH' }` → `de`, `{ en: 'en-US' }` → `en`), else the locale's language (`de-CH` → `de`).
- `politenessForTarget(locale, target, politeness)`: `more`/`less` for a target where `Languages.supportsPoliteness()` is false throws `unsupported_feature` before anything is sent, so a setting is never dropped silently; the status panel shows the same as a warning.

`test/fakeSupertext.ts` accepts exactly the SDK's target list (HTTP 404 otherwise), bare sources, and politeness only where offered (HTTP 400 `FEATURE_ERROR`), like the live API.

### Commando Center (version reports, API key check, ping)

The protocol is Supertext Plugin Health's (`InstallationReporter`, `pingResponse`, `reporterState`, `reportsEnabled`; Commando-Center-Supertext-Translation → `docs/DEVELOPER.md` → *Report protocol*); the key check is the SDK's `checkApiKey()` with `apiKeyFingerprint`, passed in as the reporter's key checker (the SDK client gets the plugin's API address and User-Agent). `src/reporting.ts` only supplies what Payload knows:

- **Options:** `plugin.name` = `Payload-Supertext-Translation` (the GitHub repo name), `plugin.version` from the plugin's `package.json` (`src/versions.ts`: searched upwards from the module, else in `<cwd>/node_modules`, because Next.js bundles the plugin), `system` = `Payload` and the version of the app's `payload` package, runtime from Plugin Health, `sdkVersion` = the SDK's `SDK_VERSION`, `siteUrl` = `config.serverURL`, else the request's `x-forwarded-host`/`host` (and `x-forwarded-proto`), `callbackUrl` = `<siteUrl><routes.api>/supertext/ping`.
- **Setting:** the `versionReports` option (default on); `SUPERTEXT_VERSION_REPORTS` wins (`reportsEnabled`). `SUPERTEXT_REPORT_URL` points reports elsewhere (tests, screenshots).
- **When:** the settings are code, so there is no `afterSettingsSaved`. `onRequest` runs in the background on `GET /status` (the Translate control and the dashboard panel load it) and `POST /translate`; the reporter checks the key when its fingerprint changed and reports `installed`, `upgraded` or a changed key status. `authenticationFailed` runs when a translation came back with `authentication_failure` (401/403). `testConnection` runs on `POST /check-key` (*Check again* on the panel), which waits for the result and returns it.
- **State:** `payload.kv` (Payload's key-value store; by default the `payload-kv` collection Payload adds itself, so the plugin needs no migration), key `supertext-reporter`, Plugin Health's `ReporterState` as JSON (the same format the SDK 0.1–0.2 reporter stored, so the switch kept the history: no new `installed` report). Without `payload.kv` (older Payload 3) it is kept in memory. The fingerprint stays there; the endpoints return the check without it. Calls are queued (one at a time per plugin instance) and never throw: storage errors are logged at debug level and swallowed.
- **Ping:** `GET /api/supertext/ping` (`Reporting.ping` → `pingResponse`), public, status, headers (`Content-Type`, `Cache-Control: no-store`) and body exactly as Plugin Health returns them; 404 while reports are off.

## Endpoints

| Method | Path | Body / response |
| --- | --- | --- |
| GET | `/api/supertext/status` | `StatusResponse`: `{ apiKeyConfigured, canTranslate, locales, languages, version, releaseUrl, sdkVersion, reports: { enabled, pingUrl }, keyCheck }` — used by the Translate control and the dashboard panel. 401 when not logged in. Runs the reporter's `onRequest` in the background. |
| POST | `/api/supertext/translate` | Body `TranslateRequestBody`. 200 with `{ results: LocaleResult[] }` if any locale succeeded, 502 if all failed, 400/401/403/500 with `{ error }` for validation, auth, permission and missing-key errors. |

| POST | `/api/supertext/export` | Body `FileExportRequestBody` (`TranslateRequestBody` + `format: 'xliff' \| 'html'`). 200 with the file (`application/x-xliff+xml` or `text/html; charset=utf-8`, `Content-Disposition: attachment`), 422 *Nothing to translate.*, 400/401/403 like `/translate`. No API key needed. |
| POST | `/api/supertext/import` | Raw file body (≤ 10 MB), `?includeChanged=1`. 200 with `{ jobs: FileImportJob[] }`, 413 too large, 422 for an unreadable file, 401/403 like `/translate`. |
| POST | `/api/supertext/check-key` | Checks the API key now (`testConnection`), returns `{ keyCheck }`. 401/403 like `/translate`. |
| GET | `/api/supertext/ping?challenge=…` | Public reachability check for the Commando Center (see above). |

`LocaleResult` is `{ locale, ok: true, segments, missing: string[] }` or `{ locale, ok: false, error, code?, status? }`.

`translateDocument` is exported for server-side use (hooks, jobs, scripts); without `req` it runs with `overrideAccess: true`.

## Local setup

```bash
git clone https://github.com/Supertext/Payload-Supertext-Translation.git
cd Payload-Supertext-Translation
npm install          # also builds dist/ via the prepare script
npm test             # unit + integration tests
npm run typecheck
npm run build
```

To try it in a Payload app, link it (`npm link`, or `"payload-supertext-translation": "file:../Payload-Supertext-Translation"`), add the plugin, run `npx payload generate:importmap`, and set `SUPERTEXT_API_KEY` (use `environment: 'staging'` with a staging key while developing).

## Tests

Vitest, in `test/`:

- `segments.test.ts` — HTML build/parse, escaping, whitespace, missing segments
- `collect.test.ts` — schema walking for every supported field type, Lexical grouping, row-id rules, opt-outs
- `client.test.ts` — the plugin's client on the SDK: API round trip, form fields, status and HTTP error mapping, timeout, 429 retries, key prefix, the review client (`forReview`: all four calls to the review URL, others direct, off without a review URL, `reviewUrl`/`SUPERTEXT_REVIEW_URL`/default `REVIEW_URL`), the User-Agent with the plugin's version, language codes (exact matches, SDK defaults, nothing guessed beyond them, mapping, source from the mapped code, politeness) (the SDK's own tests run in the SDK repository)
- `reporting.test.ts` — the Commando Center glue: repo name and version, the setting and `SUPERTEXT_VERSION_REPORTS`, site URL, state in `payload.kv` or memory, `installed` → nothing → `upgraded`, back-off and never throwing, ping answers, the language table
- `translations.test.ts` — all four languages have the English keys, placeholders and URLs; every key the control and endpoints use and every error code of the SDK has a message; config merging; French messages through Payload's own `initI18n`
- `files.test.ts` — translation files on a real Payload instance: reference round trip; export (collector keys, mapped and unmapped languages, XLIFF with several targets, HTML with one, globals, nothing to translate, auth); import (XLIFF and HTML written as drafts with Lexical formatting kept, `source_changed` only with the option, untranslated/invalid/missing not written and the target's own text kept, other system, unknown reference, missing locale, unreadable files, 10 MB limit)
- `integration.test.ts` — boots a real Payload 3 instance on in-memory SQLite with Lexical, drafts, arrays, blocks and a global; covers translating into several locales, drafts, globals, failures, a locale without mapping and default, politeness, the Supertext settings global (selects, preselection, saved mapping used, option wins, unknown codes refused, access; *Translation review* checkboxes off by default, a ticked locale goes through the review service for all four calls while another goes directly) and the endpoints (auth, validation, happy path; status with languages, one `installed` report to a fake center, `api_key_check` after a 401, *Check again*, reports off, the ping)

`test/fakeSupertext.ts` is an in-memory Supertext API that "translates" by prefixing `[<target_lang>]`, and a fake Commando Center (`POST …/report` → 202, recorded in `reports`). No test calls the real API or the real center.

## CI / deploy

`.github/workflows/ci.yml` runs typecheck, tests and build on Node 22, 24 and 26 for pushes to `main` and pull requests.
`.github/workflows/e2e.yml` runs the end-to-end test against the real Supertext API and regenerates the docs screenshots (see *End-to-end tests*).

### Demo app (`demo/`)

A small Payload 3 + Next.js 16 site that uses the plugin the way a customer would: Pages (drafts, blocks in tabs, rich text, SEO group, a non-localized field) and a Header global, locales `en`, `de-CH`, `fr-CH`, `it-CH`, Postgres. A public frontend at `/<locale>/<slug>` shows the published version of each language.

- `src/seed.ts` runs on every start: creates the demo accounts from `DEMO_ADMIN_EMAIL`/`DEMO_ADMIN_PASSWORD` (fallback: `PAYLOAD_ADMIN_*`) and `DEMO_EDITOR_EMAIL`/`DEMO_EDITOR_PASSWORD` if they don't exist yet — existing accounts are never changed, and the demo has no roles, so both accounts have full access — and English sample content when there are no pages. With an account variable set, Payload's "create first user" screen no longer appears.
- No `languageMap`: the mapping is chosen under *Supertext → Supertext settings* (`de-CH`, `fr-CH` and `it-CH` are Supertext codes, `en` is preselected as `en-US`); on the first start the seed sets German (`de-CH`) to formal there. The global's table comes from the migration `20261017_185426_supertext_settings`.
- Schema changes need a migration: `cd demo && npm run payload migrate:create <name>`, commit `src/migrations/`. Production applies them on start (`prodMigrations`); there is no automatic schema push in production.
- `i18n.supportedLanguages` offers English, German, French and Italian as admin languages.
- `localization.defaultLocalePublishOption: 'active'` makes **Publish** release only the language being viewed (see "Publishing" in the user guide).

Run locally:

```bash
cd demo
docker compose up -d        # local Postgres on :5432 (or point DATABASE_URL at any Postgres)
cp .env.example .env        # set PAYLOAD_SECRET, SUPERTEXT_API_KEY (staging key + SUPERTEXT_ENVIRONMENT=staging while developing)
npm run plugin              # build + pack the plugin from the repo root into demo/vendor/
npm install
npm run dev                 # http://localhost:3000, admin at /admin
```

After changing plugin code, run `npm run plugin && npm install` again. The plugin is installed from a packed tarball (not a symlink) so Payload/React resolve to a single copy. Because the tarball changes with every edit, `scripts/unpin-plugin.mjs` removes its hash from `package-lock.json` (otherwise npm fails with EINTEGRITY, or installs a stale copy from its cache); the Dockerfile runs it too.

`SUPERTEXT_API_URL` points the demo at any API base URL, e.g. a local fake Supertext for offline testing (to try the review service, tick *Translation review* in **Supertext settings** instead). `SUPERTEXT_REVIEW_URL` (optional) points *Translation review* at another review service than Supertext's; empty keeps the default. The demo's schema for the checkboxes comes from the migration `20261018_222059_translation_review`.

### Railway deployment

Service **Payload** in the Railway project `supertext-cms-demos` (region Amsterdam), deployed from this repo's `main` on every push.

| Setting | Value |
| --- | --- |
| Builder | Dockerfile, path `demo/Dockerfile`, build context = repo root |
| Database | Database `payload_demo` on the project's shared **Postgres** service (created automatically on first start; Strapi's data lives in its own database). No volume — the project is at Railway's 3-volume limit. |
| Healthcheck | `/` |
| Variables | `DATABASE_URL` (Railway reference to the Postgres service's user, password, host and port, with database `payload_demo`), `PAYLOAD_SECRET`, `SUPERTEXT_API_KEY`, `SUPERTEXT_ENVIRONMENT`, optionally `SUPERTEXT_REVIEW_URL` (another review service; unset = Supertext's), `SUPERTEXT_VERSION_REPORTS` (`0` turns version reports off), `DEMO_ADMIN_EMAIL`, `DEMO_ADMIN_PASSWORD`, `DEMO_EDITOR_EMAIL`, `DEMO_EDITOR_PASSWORD` (older `PAYLOAD_ADMIN_*` still work) — set in Railway, never in the repo |

The Dockerfile packs the plugin from the repo root, installs it into the demo, builds Next.js in standalone mode and runs `node server.js` on port 3000. If a push does not start a deployment, Railway's GitHub app has no access to this repository: in the Supertext GitHub organisation settings → *GitHub Apps* → **Railway** → *Configure*, add the repository under *Repository access*. A manual redeploy in Railway works in the meantime.

Migrations run on start. To reset the demo content, drop the `payload_demo` database on the Postgres service and redeploy; it is recreated and re-seeded.

## End-to-end tests

The unit and integration tests use fakes. `.github/workflows/e2e.yml` also tests against the **real Supertext API**, so changes on Supertext's side (language codes, regional variants, formatting, rate limits) show up. It runs on every push to `main` that touches the plugin, the demo or the tests, on pull requests that change the E2E test or workflow, every Monday, and by hand (*Actions → E2E → Run workflow*). It builds the demo image once (Docker layer cache in GitHub Actions) and starts it twice on a Postgres service, each with a new database and demo accounts made up for the run:

1. **Real API** (repository or organization secret `SUPERTEXT_API_KEY`; without it these steps are skipped with a warning). Version reports are off (`SUPERTEXT_VERSION_REPORTS=0`), so CI runs don't appear in the Commando Center.
   - `test/e2e/features.mjs` asks the live `GET features` (cost-free, no plugin or SDK code) whether every pair the demo translates (`en` → `de-CH`, `fr-CH`, `it-CH`) is offered; a missing pair fails the run. Whether the plugin's own language list matches the API is the SDK's job (its own tests).
   - `test/e2e/live.mjs` (Playwright): the editor account (`DEMO_EDITOR_*`) opens every page and the Header global in the admin, clicks **Translate**, ticks every other locale and translates; then Payload's REST API (as the editor) is checked: every field of each document is filled in each target locale and, per locale over all documents, at least 80 % of them changed (single words like "Home" can stay the same), no `data-st-id`/`data-n`/placeholder or HTML tag is left, the rich text keeps its paragraphs, bold text and links (same URLs), slug and the non-localized field are unchanged, the text of all documents is in the target language (common words of each language counted), de-CH has no "ß", and pages are translated into a draft (the published version has nothing in the target locale). No error message may appear in the admin. Translating again must update the same documents and rows (no new pages, same row ids). Each run translates the demo content twice into three languages (a few thousand characters on the key's account).
2. **Stand-in API**: the docs screenshots (see *Docs screenshots*), so the images don't change with each machine translation. If `docs/images/` changed, a second job pushes the branch `automation/docs-screenshots` and opens (or updates) the pull request "Docs: regenerate screenshots". This needs *Settings → Actions → General → Allow GitHub Actions to create and approve pull requests*.

If a run fails, the artifact `e2e-debug` has the result pages, the demo logs and the stand-in log. Locally:

```bash
cd test/e2e && npm install && npx playwright install chromium
# fresh demo (new database) with a real SUPERTEXT_API_KEY and DEMO_EDITOR_*, e.g. on port 3001
SUPERTEXT_API_KEY=… E2E_TARGETS=de-CH,fr-CH,it-CH node features.mjs
BASE_URL=http://localhost:3001 EDITOR_EMAIL=… EDITOR_PASSWORD=… npm run live
```

`live.mjs` needs real translations into every target locale; the docs stand-in only knows German, so run it against the real API.

## Docs screenshots

The images in `docs/images/` are generated by `test/docs/screenshots.mjs` (Playwright) from the local demo on a **fresh database**, against `test/docs/stand-in.mjs`, which answers like the Supertext API and returns real German for the seeded content (`test/docs/sample-de.json`). Regenerate them whenever the Translate control, the edit view, the Supertext settings screen (`settings-languages*.png`) or the demo content changes:

```bash
cd test/docs && npm install && npx playwright install chromium
npm run stand-in &                                  # http://127.0.0.1:8765/v1/ (and a fake center at /report)
cd ../../demo && npm run plugin                      # pack the current plugin into the demo
# empty database, e.g. dropdb payload_demo, then:
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/payload_demo PAYLOAD_SECRET=local \
  SUPERTEXT_API_KEY=test-key SUPERTEXT_API_URL=http://127.0.0.1:8765/v1/ SUPERTEXT_REPORT_URL=http://127.0.0.1:8765/report \
  DEMO_ADMIN_EMAIL=anna.muster@example.com DEMO_ADMIN_PASSWORD='Docs12345!' npm run dev &
cd ../test/docs && BASE_URL=http://localhost:3000 npm run screenshots
```

Use `localhost`, not `127.0.0.1`: `next dev` blocks its dev assets for other origins and the admin stays blank. Always set `SUPERTEXT_REPORT_URL` to the stand-in, so a screenshot run never reports to the live Commando Center. The dashboard panel (`status-panel.png`) shows the live demo's ping URL instead of the local one. The script hides the Next.js dev badge and the account avatar (Gravatar), and shows fixed dates instead of *Last Modified*, *Created* and the key check's time, so the images only change when the UI does. The E2E workflow takes them in CI too (see *End-to-end tests*). When the seeded content changes, add the new English strings and their German to `sample-de.json`.

## Demo movie

`docs/images/demo.gif` (at the top of the README) is recorded by `test/docs/movie.mjs` with Supertext's shared movie kit (`test/docs/movie/movie-kit.mjs` and `assets/`: intro and outro cards, caption bar, cursor, cuts the waiting time; Inter under the SIL OFL, `assets/fonts/Inter-LICENSE.txt`). It shows, with a spoken line for every step (the GIF is silent), as the demo's **editor**: the seeded home page in English, *Translate* with *Deutsch* and *Français* ticked, *Translate into 2*, the waiting state, the *Translated into …* message, the locale switched to *Deutsch (Schweiz)* and the German draft. Run it against a fresh demo (new database, set up as for the screenshots, plus the `DEMO_EDITOR_*` account) and the stand-in with a delay, so the waiting state is visible:

```bash
cd test/docs && npm install && npx playwright install chromium
STAND_IN_DELAY=8 npm run stand-in &                  # files stay "translating" for 8 s
# fresh demo as in "Docs screenshots", with DEMO_EDITOR_EMAIL / DEMO_EDITOR_PASSWORD set too
pip install piper-tts                                # the voice (once)
BASE_URL=http://localhost:3000 DEMO_EDITOR_EMAIL=… DEMO_EDITOR_PASSWORD=… npm run movie
```

The MP4 is narrated with [Piper](https://pypi.org/project/piper-tts/) (`pip install piper-tts`): the kit's `say()` speaks each step's line, shows its caption and holds until the line is finished; the time spent making the speech is cut. The voice model (63 MB, pinned revision, checked by SHA-256) downloads itself once into `test/docs/movie/voice/` (git-ignored; never commit it). Without Piper, or with `MOVIE_VOICE=0`, the movie is made silent with the captions only.

Voice: Piper voice “alba” (en_GB), trained on a dataset from the University of Edinburgh's Centre for Speech Technology Research, CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)

It needs `ffmpeg` and writes 1280×720 at 30 fps. The GIF (800 px, 12 fps, keep it under 3 MB) is committed; the MP4 (about 40 s) isn't: it goes to `test/docs/movie/out/Payload-Supertext-Translation.mp4` (git-ignored) or to `MOVIE_OUT`. `CHROMIUM_PATH` picks another Chromium. Record it again when the Translate control or the edit view changes. The kit is the same in every Supertext plugin repo: don't restyle it here.

### Install movie

`test/docs/movie-install.mjs` records the install and configuration movie with the same kit and voice (MP4 only, no GIF). It shows the install steps from `docs/INSTALLATION.md` in the kit's terminal (`npm install github:Supertext/Payload-Supertext-Translation`, the plugin in `payload.config.ts` as a config excerpt, `npx payload generate:importmap`, `npx payload migrate:create supertext_settings`, `SUPERTEXT_API_KEY` in `.env` with the fake key `st-demo-0000-0000-0000`, `npm run dev`), where the key comes from, then, as the demo's **administrator**: the Supertext panel on the dashboard (*Check again*: the key works), **Supertext → Supertext settings** (German → *Swiss High German (de-CH)*, *Translation review* left off, *Save*) and the *Translate* button on a page. Page loads are cut, and local addresses (the panel's ping URL) are shown as the live demo's. Any demo whose plugin talks to the stand-in works (it needn't be fresh):

```bash
cd test/docs && npm run stand-in &
BASE_URL=http://localhost:3000 DEMO_ADMIN_EMAIL=… DEMO_ADMIN_PASSWORD=… npm run movie:install
```

The MP4 (about 90 s) goes to `test/docs/movie/out/Payload-Supertext-Translation-install.mp4` (git-ignored) or to `MOVIE_OUT`; it isn't committed. Record it again when the install steps, the Supertext panel or the Supertext settings change.

## Dependency updates

Dependabot (`.github/dependabot.yml`) opens weekly pull requests: minor and patch updates grouped into one, GitHub Actions in another, each major update on its own. Merge one when CI is green and it doesn't change what the plugin supports.

`.github/workflows/dependabot-merge.yml` merges a minor or patch package update by itself once every other check on its pull request has passed (it waits up to 85 minutes and leaves the pull request alone if a check fails). GitHub Actions updates and majors stay for a person: the workflow's built-in token can't merge changes to workflow files, and a major needs a decision. Merges by the workflow don't start CI on `main`; the weekly health check looks at `main`.

One major version is ignored on purpose: `@types/node` (the types must match the oldest Node version the plugin supports, 22, not the newest). Lift the rule when the plugin moves to a new minimum Node version.

The plugin is type-checked and built with TypeScript 7 (the native compiler, `tsc`). The demo stays on TypeScript 5: Next.js type-checks through TypeScript's JavaScript API, which TypeScript 7 doesn't have yet.

`overrides` in `package.json` force the fixed versions of two packages that dependencies pin to vulnerable releases (security advisories, November 2026): `dompurify` 3.4.17 or newer (pinned by `monaco-editor` in `@payloadcms/ui`) and `happy-dom` 21.0.4 or newer (`@lexical/headless` 0.50 asks for 20; Lexical 0.53 itself moved to 21). `demo/package.json` has the `happy-dom` override too. Remove them once Payload's dependencies ship the fixed versions. Remaining advisories (low and moderate, development tools only): `esbuild` 0.18 inside `drizzle-kit`'s `@esbuild-kit` loader and `deepmerge` (no fixed version).

## Code quality and security checks

- **Checks** workflow (`.github/workflows/checks.yml`): [actionlint](https://github.com/rhysd/actionlint) and [zizmor](https://docs.zizmor.sh/) lint the workflows on every push and pull request. Dependency review fails a pull request that adds a package with a known vulnerability (moderate or worse). Third-party actions are pinned to commit SHAs; Dependabot keeps the pins up to date. To run the workflow lint locally: `pip install actionlint-py zizmor`, then `actionlint` and `zizmor .github/workflows` in the repo root.
- **Links** workflow (`.github/workflows/links.yml`): [lychee](https://lychee.cli.rs/) checks the links in all Markdown files weekly and whenever docs change on `main`. Broken links open (or update) the issue "Broken links in the docs". Links that can't work from CI (local URLs, placeholders, pages behind a login) are excluded in `.lycheeignore`.
- JavaScript and TypeScript are analysed by CodeQL (see below), so this repo runs no separate static analyser.
- GitHub settings (set by Remy's setup script, not stored in the repo): **secret scanning with push protection** (a push containing a known token format is rejected; findings under *Security → Secret scanning*) and **CodeQL default setup** (findings under *Security → Code scanning* and as comments on pull requests; PHP isn't covered by CodeQL, which is why the PHP plugins run PHPStan).
- `.github/workflows/support-triage.yml`: support requests from the Supertext integrations website arrive as issues labelled `support` (contact details stay in the Supertext CMS). Claude classifies each one: answers questions (marked `<!-- supertext:reply -->`, emailed to the sender by the CMS) and closes them, fixes bugs as pull requests for review (never merged automatically), labels feature requests `feature-request`. Only people with triage rights can add labels, so outsiders can't start it. Needs the organisation secret `ANTHROPIC_API_KEY`; the workflow is the same in every Supertext repo.

Before starting work in this repo, look at its open findings: code scanning alerts, secret scanning alerts, Dependabot PRs and the "Broken links in the docs" issue.

## Releasing

Releases are published by `.github/workflows/release.yml` when the version is officially bumped; nobody tags or creates releases by hand.

1. Move the *Unreleased* entries in `CHANGELOG.md` under a new `## [X.Y.Z] - YYYY-MM-DD` section, and keep an empty *Unreleased* above it.
2. Set the same version in:
   - `package.json`: the npm package version
3. Push to `main`. The workflow checks that the version files match `CHANGELOG.md`, then tags `vX.Y.Z` and creates the GitHub release with the CHANGELOG section as notes (0.x versions as pre-releases). A push that adds no new version does nothing, and a version that is already released is skipped. After fixing a failed run, start it again with *Run workflow* on the *Release* workflow.

Publishing to npm is not set up yet; until then installs use the GitHub URL (optionally `#vX.Y.Z`).
## Known limitations / roadmap

- Translation is synchronous within the HTTP request (like the WordPress plugin). Next: run it as a Payload Jobs Queue task so long documents and bulk translation don't depend on request timeouts.
- No bulk action in list views yet.
- Payload blocks embedded in Lexical (BlocksFeature) and Lexical code blocks are not translated.
- Slate rich text (Payload 2 legacy) is not supported.
- Translation files: one document per export (no bulk export from list views yet); no screenshots of the Export/Import tabs yet.
- Re-translating overwrites the target locale's translated fields; no change detection. A translation memory and reviewers' corrections come from the review service when a locale has *Translation review* on; corrections reach Payload only with the next translation (no push).
- No settings form apart from **Supertext settings** (language mapping, tone, *Translation review*): other options are code, so the Supertext panel only shows them, and there is no `settings_saved` report (the key check runs when the key's fingerprint changes and on *Check again*).
- Human (professional) translation orders, as in the WordPress plugin, are not implemented.
- Not published on npm yet.
