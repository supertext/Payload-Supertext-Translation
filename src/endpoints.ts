import type { Endpoint, PayloadRequest } from 'payload'

import { exportItem, FileGlueError, importFile, readUpload, TranslationFileError } from './files.js'
import type { FileFormat } from './files.js'
import { translate } from './i18n.js'
import { politenessFor, suggestTargetCode, supportsPoliteness, targetCodeOrNull } from './languages.js'
import { Reporting, SDK_VERSION, siteUrl } from './reporting.js'
import { effectiveSettings, loadSettings, SETTINGS_SLUG } from './settings.js'
import type { SavedSettings } from './settings.js'
import { REVIEW_URL, SupertextClient, SUPERTEXT_ENVIRONMENTS } from './supertext/client.js'
import { translateDocument } from './translate.js'
import type {
  FileExportRequestBody,
  FileImportResponse,
  KeyCheckStatus,
  LanguageStatus,
  StatusResponse,
  SupertextTranslationOptions,
  TranslateRequestBody,
  TranslateResponse,
} from './types.js'
import { pluginVersion, releaseUrl } from './versions.js'

export const ENDPOINT_BASE = '/supertext'

export function resolveApiKey(options: SupertextTranslationOptions): string {
  return options.apiKey ?? process.env.SUPERTEXT_API_KEY ?? ''
}

export function apiBaseUrl(options: SupertextTranslationOptions): string {
  return options.apiUrl ?? SUPERTEXT_ENVIRONMENTS[options.environment ?? 'live']
}

/**
 * The review service for locales with *Translation review* on: the `reviewUrl` option, else
 * `SUPERTEXT_REVIEW_URL`, else Supertext's review service. `''` turns review off everywhere.
 */
export function resolveReviewUrl(options: SupertextTranslationOptions): string {
  return (options.reviewUrl ?? process.env.SUPERTEXT_REVIEW_URL ?? REVIEW_URL).trim()
}

/** The client for translations; `forReview(true)` gives the one for review locales. */
export function createClient(options: SupertextTranslationOptions): SupertextClient {
  return new SupertextClient({
    apiKey: resolveApiKey(options),
    baseUrl: apiBaseUrl(options),
    pollIntervalMs: options.pollIntervalMs,
    reviewUrl: resolveReviewUrl(options),
    timeoutMs: options.timeoutMs,
  })
}

const error = (status: number, message: string) => Response.json({ error: message }, { status })

function localeCodes(req: PayloadRequest): string[] {
  const loc = req.payload.config.localization
  if (!loc) return []
  return loc.locales.map((l) => (typeof l === 'string' ? l : l.code))
}

async function readBody(req: PayloadRequest): Promise<unknown> {
  try {
    return typeof req.json === 'function' ? await req.json() : (req.data ?? null)
  } catch {
    return null
  }
}

/**
 * How each locale is sent to Supertext (for the status panel and the dialog): the plugin options
 * win, then the saved Supertext settings, then the SDK's exact match or default.
 */
export function languageStatus(
  locales: string[],
  options: SupertextTranslationOptions,
  saved: SavedSettings = { languageMap: {}, politeness: {}, review: {} },
): LanguageStatus[] {
  const settings = effectiveSettings(saved, options)
  return locales.map((locale) => {
    const supertext = targetCodeOrNull(locale, settings.languageMap)
    const politeness = politenessFor(locale, settings.politeness)
    const supported = supertext === null || politeness === 'default' || supportsPoliteness(supertext) !== false
    // A saved value equal to the suggestion is the preselected default, not a choice of its own.
    const chosen = saved.languageMap[locale]
    const origin: LanguageStatus['origin'] =
      supertext === null
        ? null
        : options.languageMap?.[locale]
          ? 'option'
          : chosen && chosen !== suggestTargetCode(locale)
            ? 'settings'
            : 'automatic'
    return { locale, origin, politeness, politenessSupported: supported, supertext }
  })
}

/** The stored key check (Plugin Health's `KeyCheck`, status as a string) without the fingerprint. */
const publicCheck = (check: (Omit<KeyCheckStatus, 'status'> & { status: string }) | null): KeyCheckStatus | null =>
  check && { checkedAt: check.checkedAt, errorCode: check.errorCode, httpStatus: check.httpStatus, status: check.status as KeyCheckStatus['status'] }

export function createEndpoints(
  options: SupertextTranslationOptions,
  reporting: Reporting = new Reporting({ apiBaseUrl: apiBaseUrl(options), versionReports: options.versionReports }),
): Endpoint[] {
  const allowedCollections = new Set<string>(options.collections ?? [])
  const allowedGlobals = new Set<string>(options.globals ?? [])

  const canTranslate = async (req: PayloadRequest) =>
    Boolean(req.user) && (options.access ? await options.access({ req }) : true)

  /** Validates the item part of a translate or export request; returns an error text or the request. */
  const checkItemRequest = (body: Partial<TranslateRequestBody> | null, locales: string[]): string | TranslateRequestBody => {
    if (!body || typeof body !== 'object') return 'Expected a JSON body.'
    const { collection, global, id, sourceLocale } = body
    const targetLocales = Array.isArray(body.targetLocales) ? body.targetLocales.map(String) : []
    if (!collection === !global) return 'Pass exactly one of "collection" or "global".'
    if (collection && !allowedCollections.has(collection)) return `Collection "${collection}" is not enabled for Supertext translation.`
    if (global && !allowedGlobals.has(global)) return `Global "${global}" is not enabled for Supertext translation.`
    if (collection && (id === undefined || id === null || id === '')) return 'Missing "id".'
    if (!sourceLocale || !locales.includes(sourceLocale)) return 'Unknown "sourceLocale".'
    const unknown = targetLocales.filter((l) => !locales.includes(l))
    if (unknown.length > 0) return `Unknown target locale(s): ${unknown.join(', ')}.`
    if (targetLocales.filter((l) => l !== sourceLocale).length === 0) return 'Choose at least one target locale other than the source.'
    return { collection, global, id, sourceLocale, targetLocales }
  }

  const fileMessage = (req: PayloadRequest, err: FileGlueError | TranslationFileError): string =>
    err instanceof TranslationFileError
      ? translate(req, err.code === 'too_large' ? 'file_too_large' : err.code === 'missing_metadata' ? 'file_missing_metadata' : 'file_invalid_file')
      : translate(req, `file_${err.code}`, err.vars)

  return [
    {
      // Lets the admin panel show whether the plugin is usable before an editor clicks.
      handler: async (req) => {
        if (!req.user) return error(401, translate(req, 'notLoggedIn'))
        const apiKey = resolveApiKey(options)
        reporting.inBackground('onRequest', req, apiKey)
        const locales = localeCodes(req)
        const url = siteUrl(req.payload.config.serverURL, req)
        const version = pluginVersion()
        const status: StatusResponse = {
          apiKeyConfigured: apiKey !== '',
          canTranslate: await canTranslate(req),
          keyCheck: publicCheck(await reporting.lastCheck(req.payload)),
          languages: languageStatus(locales, options, await loadSettings(req.payload)),
          locales,
          releaseUrl: releaseUrl(version),
          reports: { enabled: reporting.enabled, pingUrl: reporting.enabled && url ? reporting.callbackUrl(req.payload, url) : null },
          sdkVersion: SDK_VERSION,
          settingsUrl: `${req.payload.config.routes?.admin ?? '/admin'}/globals/${SETTINGS_SLUG}`,
          version,
        }
        return Response.json(status)
      },
      method: 'get',
      path: `${ENDPOINT_BASE}/status`,
    },
    {
      handler: async (req) => {
        if (!req.user) return error(401, translate(req, 'notLoggedIn'))
        if (!(await canTranslate(req))) return error(403, translate(req, 'notAllowed'))
        if (resolveApiKey(options) === '') return error(500, translate(req, 'apiKeyMissing'))

        const locales = localeCodes(req)
        if (locales.length === 0) return error(400, translate(req, 'localizationDisabled'))

        const body = (await readBody(req)) as Partial<TranslateRequestBody> | null
        const checked = checkItemRequest(body, locales)
        if (typeof checked === 'string') return error(400, checked)
        const { collection, global, id, sourceLocale, targetLocales } = checked

        reporting.inBackground('onRequest', req, resolveApiKey(options))
        try {
          const results = await translateDocument({
            client: createClient(options),
            collection,
            global,
            id,
            options,
            payload: req.payload,
            req,
            sourceLocale,
            targetLocales,
          })
          const rejected = results.find((r) => !r.ok && r.code === 'authentication_failure')
          if (rejected && !rejected.ok) reporting.inBackground('authenticationFailed', req, resolveApiKey(options), rejected.status ?? 401)
          const payload: TranslateResponse = { results }
          return Response.json(payload, { status: results.some((r) => r.ok) ? 200 : 502 })
        } catch (err) {
          // Source document not found / not readable by this user, unknown slug, ...
          const status = (err as { status?: number }).status ?? 400
          return error(status, err instanceof Error ? err.message : String(err))
        }
      },
      method: 'post',
      path: `${ENDPOINT_BASE}/translate`,
    },
    {
      // "Export for translation": the item's segments as an XLIFF 1.2 or HTML file (no API call, no API key needed).
      handler: async (req) => {
        if (!req.user) return error(401, translate(req, 'notLoggedIn'))
        if (!(await canTranslate(req))) return error(403, translate(req, 'notAllowed'))
        const locales = localeCodes(req)
        if (locales.length === 0) return error(400, translate(req, 'localizationDisabled'))
        const body = (await readBody(req)) as Partial<FileExportRequestBody> | null
        const checked = checkItemRequest(body, locales)
        if (typeof checked === 'string') return error(400, checked)
        const format: FileFormat = body?.format === 'html' ? 'html' : 'xliff'
        try {
          const file = await exportItem({ ...checked, format, options, payload: req.payload, req })
          return new Response(file.body, {
            headers: {
              'Cache-Control': 'no-store',
              'Content-Disposition': `attachment; filename="${file.filename}"`,
              'Content-Type': file.contentType,
            },
            status: 200,
          })
        } catch (err) {
          if (err instanceof FileGlueError) return error(422, fileMessage(req, err))
          const status = (err as { status?: number }).status ?? 400
          return error(status, err instanceof Error ? err.message : String(err))
        }
      },
      method: 'post',
      path: `${ENDPOINT_BASE}/export`,
    },
    {
      // "Import translation": the raw file as the request body (at most 10 MB), `?includeChanged=1` to also
      // write texts whose source changed since the export. Parsed in memory, never stored.
      handler: async (req) => {
        if (!req.user) return error(401, translate(req, 'notLoggedIn'))
        if (!(await canTranslate(req))) return error(403, translate(req, 'notAllowed'))
        const locales = localeCodes(req)
        if (locales.length === 0) return error(400, translate(req, 'localizationDisabled'))
        const includeChanged = ['1', 'true'].includes(req.searchParams?.get('includeChanged') ?? '')
        try {
          const content = await readUpload(req as unknown as Request)
          const jobs = await importFile({
            content,
            includeChanged,
            locales,
            message: (err) => fileMessage(req, err),
            options,
            payload: req.payload,
            req,
          })
          const response: FileImportResponse = { jobs }
          return Response.json(response)
        } catch (err) {
          if (err instanceof FileGlueError || err instanceof TranslationFileError) {
            const tooLarge = err.code === 'too_large'
            return error(tooLarge ? 413 : 422, fileMessage(req, err))
          }
          return error(400, err instanceof Error ? err.message : String(err))
        }
      },
      method: 'post',
      path: `${ENDPOINT_BASE}/import`,
    },
    {
      // "Check again" on the Supertext panel: checks the API key now (cost-free GET features).
      handler: async (req) => {
        if (!req.user) return error(401, translate(req, 'notLoggedIn'))
        if (!(await canTranslate(req))) return error(403, translate(req, 'notAllowed'))
        const result = await reporting.run('testConnection', req, resolveApiKey(options))
        const check = result?.check ?? (await createClient(options).checkApiKey())
        return Response.json({ keyCheck: publicCheck(check) })
      },
      method: 'post',
      path: `${ENDPOINT_BASE}/check-key`,
    },
    {
      // Public: the Supertext Commando Center checks that the site is reachable. No login,
      // no data; 404 while version reports are off.
      handler: (req) => {
        const answer = reporting.ping(req.searchParams?.get('challenge'))
        return new Response(answer.body, { headers: answer.headers, status: answer.status })
      },
      method: 'get',
      path: `${ENDPOINT_BASE}/ping`,
    },
  ]
}
