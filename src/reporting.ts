/**
 * Version reports to the Supertext Commando Center, the automatic API key check and the
 * callback ping (Commando-Center-Supertext-Translation → docs/DEVELOPER.md → Report protocol).
 * The protocol is Supertext Plugin Health's (`InstallationReporter`, `pingResponse`; copied into
 * src/vendor/supertext-plugin-health), the key check the Supertext SDK's (`checkApiKey()`,
 * `apiKeyFingerprint`). This file only gives them what Payload knows: the site URL, the Payload and plugin versions, and a place to keep the
 * reporter's state (Payload's key-value store, `payload.kv`, key `supertext-reporter`).
 *
 * The plugin's settings are code (plugin options and environment variables), so there is no
 * "settings saved": the key check runs when the key changed (fingerprint), on "Check again"
 * on the Supertext panel and after a 401/403 from Supertext.
 */
import type { Payload, PayloadRequest } from 'payload'

import {
  InstallationReporter,
  pingResponse,
  reporterState,
  reportsEnabled,
} from './vendor/supertext-plugin-health/index.js'
import type { KeyCheck, PingResponse, ReporterOptions, ReporterResult, ReporterState } from './vendor/supertext-plugin-health/index.js'
import { apiKeyFingerprint, SupertextClient } from './vendor/supertext-sdk/v1/index.js'
import type { SupertextClientOptions } from './vendor/supertext-sdk/v1/index.js'
import { SDK_VERSION } from './vendor/supertext-sdk/version.js'
import { payloadVersion, PLUGIN_NAME, pluginVersion, userAgent } from './versions.js'

export { PLUGIN_NAME }
/** Key of the reporter's state in Payload's key-value store. */
export const STATE_KEY = 'supertext-reporter'
/** The ping endpoint, below Payload's API route (`/api/supertext/ping`). */
export const PING_PATH = '/supertext/ping'

export { SDK_VERSION }

/** Whether version reports are on: `SUPERTEXT_VERSION_REPORTS` wins over the `versionReports` option (default on). */
export function versionReportsEnabled(option?: boolean, env: string | undefined = process.env.SUPERTEXT_VERSION_REPORTS): boolean {
  return reportsEnabled(option ?? null, env ?? null)
}

const absolute = (value: unknown): string | null => {
  const text = typeof value === 'string' ? value.trim() : ''
  return /^https?:\/\/[^/]/i.test(text) ? text.replace(/\/+$/, '') : null
}

const first = (value: string | null | undefined) => value?.split(',')[0]?.trim() || null

/** The site's base URL: Payload's `serverURL`, else the host the request was sent to (proxy headers first). */
export function siteUrl(serverURL: string | undefined, req?: Pick<PayloadRequest, 'headers'> & { url?: string }): string | null {
  const configured = absolute(serverURL)
  if (configured) return configured
  const headers = req?.headers
  let fromUrl: URL | null = null
  try {
    fromUrl = req?.url ? new URL(req.url) : null
  } catch {
    fromUrl = null
  }
  const host = first(headers?.get('x-forwarded-host')) ?? first(headers?.get('host')) ?? fromUrl?.host ?? null
  if (!host || !/^[A-Za-z0-9.\-[\]:]+$/.test(host)) return null
  const proto = first(headers?.get('x-forwarded-proto')) ?? fromUrl?.protocol.replace(':', '') ?? 'http'
  return `${proto === 'https' ? 'https' : 'http'}://${host}`
}

/** Reads and writes the reporter's state; falls back to memory where Payload has no key-value store. */
export class StateStore {
  #memory: unknown = null

  constructor(private readonly payload: Payload) {}

  async load(): Promise<ReporterState> {
    const kv = this.payload.kv
    return reporterState(kv ? await kv.get(STATE_KEY) : this.#memory)
  }

  async save(state: ReporterState): Promise<void> {
    const value = JSON.parse(JSON.stringify(state)) as object
    if (this.payload.kv) await this.payload.kv.set(STATE_KEY, value)
    else this.#memory = value
  }
}

export type ReportingOptions = {
  /** The `versionReports` plugin option. */
  versionReports?: boolean
  /** Base URL for the key check (the plugin's `apiUrl`/`environment`). */
  apiBaseUrl: string
  /** Tests: options passed to Plugin Health's reporter (fetch, report URL, clock) and the SDK client of the key check. */
  reporterOverrides?: Partial<ReporterOptions> & { clientOptions?: SupertextClientOptions }
}

type Action = 'onRequest' | 'testConnection' | 'authenticationFailed'

/**
 * The plugin's side of the Commando Center, one per plugin instance. Calls run one at a time,
 * so two requests don't report twice. Nothing here ever throws into a request.
 */
export class Reporting {
  #queue: Promise<unknown> = Promise.resolve()
  #stores = new WeakMap<Payload, StateStore>()

  constructor(private readonly options: ReportingOptions) {}

  get enabled(): boolean {
    return versionReportsEnabled(this.options.versionReports)
  }

  store(payload: Payload): StateStore {
    let store = this.#stores.get(payload)
    if (!store) this.#stores.set(payload, (store = new StateStore(payload)))
    return store
  }

  /** The ping route's answer (404 while reports are off). */
  ping(challenge: unknown): PingResponse {
    return pingResponse(typeof challenge === 'string' ? challenge : null, { enabled: this.enabled, plugin: PLUGIN_NAME })
  }

  /** The absolute ping URL for a site URL. */
  callbackUrl(payload: Payload, url: string): string {
    return `${url}${payload.config.routes?.api ?? '/api'}${PING_PATH}`
  }

  reporter(payload: Payload, url: string): InstallationReporter {
    const { clientOptions: overrideClientOptions, ...overrides } = this.options.reporterOverrides ?? {}
    const clientOptions: SupertextClientOptions = {
      baseUrl: this.options.apiBaseUrl,
      userAgent: userAgent(),
      ...(overrides.now ? { now: overrides.now } : {}),
      ...overrideClientOptions,
    }
    return new InstallationReporter({
      callbackUrl: this.callbackUrl(payload, url),
      enabled: this.enabled,
      keyChecker: { check: (apiKey) => new SupertextClient(apiKey, clientOptions).checkApiKey(), fingerprint: apiKeyFingerprint },
      plugin: { name: PLUGIN_NAME, version: pluginVersion() ?? '0.0.0' },
      siteUrl: url,
      sdkVersion: SDK_VERSION,
      system: { name: 'Payload', version: payloadVersion() },
      ...overrides,
    })
  }

  /** Runs one reporter action with the stored state and stores the result. Never throws. */
  run(action: Action, req: PayloadRequest, apiKey: string, httpStatus?: number): Promise<ReporterResult | null> {
    const task = this.#queue.then(async () => {
      const { payload } = req
      try {
        const url = siteUrl(payload.config.serverURL, req)
        if (!url) return null
        const reporter = this.reporter(payload, url)
        const store = this.store(payload)
        const state = await store.load()
        const result =
          action === 'authenticationFailed'
            ? await reporter.authenticationFailed(state, apiKey, httpStatus ?? 401)
            : action === 'testConnection'
              ? await reporter.testConnection(state, apiKey)
              : await reporter.onRequest(state, apiKey)
        await store.save(result.state)
        if (result.event) payload.logger.debug(`[supertext] version report ${result.event}: ${result.sent ? 'sent' : 'not sent'}`)
        return result
      } catch (err) {
        try {
          payload.logger.debug(`[supertext] version report skipped: ${err instanceof Error ? err.message : String(err)}`)
        } catch {
          // no logger: nothing to do
        }
        return null
      }
    })
    this.#queue = task
    return task
  }

  /** For back-end requests: runs in the background, so the request doesn't wait for Supertext or the center. */
  inBackground(action: Action, req: PayloadRequest, apiKey: string, httpStatus?: number): void {
    void this.run(action, req, apiKey, httpStatus)
  }

  /** The latest stored key check (for the status panel), or null. */
  async lastCheck(payload: Payload): Promise<KeyCheck | null> {
    try {
      return (await this.store(payload).load()).keyCheck
    } catch {
      return null
    }
  }

  /** Waits for the reports started so far (tests). */
  async idle(): Promise<void> {
    await this.#queue.catch(() => undefined)
  }
}
