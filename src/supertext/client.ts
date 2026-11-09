/**
 * The plugin's access to the Supertext AI file translation API (v1), built on the
 * shared Supertext SDK (src/vendor/supertext-sdk, compiled with the plugin).
 * The SDK does the protocol:
 *   1. POST   translate/ai/file                     multipart upload of an HTML file → { file_id }
 *   2. GET    translate/ai/file/{id}/status         poll until `done`
 *   3. GET    translate/ai/file/{id}/translation    download the translated HTML
 *   4. DELETE translate/ai/file/{id}                cleanup, also after errors
 * plus the `Authorization: Supertext-Auth-Key <key>` header (a pasted prefix is stripped) and
 * HTTP 429 retries. Language codes are sent as given: resolve them with `src/languages.ts` first.
 *
 * Locales with *Translation review* on use `forReview(true)`: a second SDK client with the same
 * key and settings whose base URL is Supertext's review service (`REVIEW_URL`, the translation
 * proxy of Supertext Localization Review, same API v1).
 *
 * No Payload imports here (tested on its own).
 */
import { LIVE_BASE_URL, SupertextClient as SdkClient, SupertextError } from '../vendor/supertext-sdk/v1/index.js'
import type { ApiKeyCheck, ErrorCode, FetchLike, Politeness } from '../vendor/supertext-sdk/v1/index.js'
import { userAgent } from '../versions.js'

export { SupertextError }
export type { ApiKeyCheck, Politeness }
export type SupertextErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

export const SUPERTEXT_ENVIRONMENTS = {
  live: LIVE_BASE_URL,
  staging: 'https://api.staging.supertext.com/v1/',
  testing: 'https://api.testing.supertext.com/v1/',
} as const

export type SupertextEnvironment = keyof typeof SUPERTEXT_ENVIRONMENTS

/**
 * Supertext's review service (translation proxy of Supertext Localization Review). It speaks the
 * same API and forwards to the live Supertext API with the plugin's key, keeping every translation
 * so reviewers can correct them on the website. Used for locales with *Translation review* on.
 */
export const REVIEW_URL = 'https://localizationreview-production.up.railway.app/v1/'

export type SupertextClientOptions = {
  apiKey: string
  /** Base URL with trailing slash. Defaults to the live API. */
  baseUrl?: string
  /** Custom fetch (tests, proxies). Defaults to global fetch. */
  fetch?: typeof fetch
  /** Delay between status polls. Default 2000 ms. */
  pollIntervalMs?: number
  /** Give up waiting after this long. Default 180000 ms. */
  timeoutMs?: number
  /** Per-request HTTP timeout. Default 30000 ms. */
  requestTimeoutMs?: number
  /** Sleep implementation (tests). */
  sleep?: (ms: number) => Promise<void>
  /**
   * Base URL of the review service for `forReview(true)`. Empty or omitted (or the same as
   * `baseUrl`): no review client, `forReview()` always returns this client.
   */
  reviewUrl?: string
}

export type TranslateFileArgs = {
  html: string
  /** A Supertext target code (`de-CH`, `es`), sent as given. */
  targetLang: string
  /** A Supertext source code (`en`), sent as given; omit for auto-detection. */
  sourceLang?: string
  politeness?: Politeness
}

const trimSlash = (url: string) => url.trim().replace(/\/+$/, '')

export class SupertextClient {
  private readonly sdk: SdkClient
  private readonly options: SupertextClientOptions
  private reviewClient: SupertextClient | null = null

  constructor(options: SupertextClientOptions) {
    this.options = options
    const pollIntervalMs = Math.max(100, options.pollIntervalMs ?? 2000)
    this.sdk = new SdkClient(options.apiKey, {
      baseUrl: options.baseUrl ?? SUPERTEXT_ENVIRONMENTS.live,
      pollIntervalMs,
      timeoutMs: Math.max(pollIntervalMs, options.timeoutMs ?? 180_000),
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      // The plugin's version too, so Supertext and the review service see which release calls.
      userAgent: userAgent(),
      ...(options.fetch ? { fetch: options.fetch as FetchLike } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
    })
  }

  /**
   * The client for a target locale: the review service when its *Translation review* is on (same
   * key, same protocol; created once), else this one. Without a review URL, always this one.
   * A job is collected by the client that submitted it (`translateHtml` is one round trip).
   */
  forReview(review: boolean): SupertextClient {
    const reviewUrl = this.options.reviewUrl?.trim() ?? ''
    if (!review || reviewUrl === '' || trimSlash(reviewUrl) === trimSlash(this.options.baseUrl ?? SUPERTEXT_ENVIRONMENTS.live)) return this
    return (this.reviewClient ??= new SupertextClient({ ...this.options, baseUrl: reviewUrl, reviewUrl: '' }))
  }

  /** Full round trip: upload, wait, download, delete. Returns the translated HTML. */
  translateHtml({ html, targetLang, sourceLang, politeness }: TranslateFileArgs): Promise<string> {
    return this.sdk.translateHtml(html, targetLang, { sourceLang: sourceLang ?? null, politeness: politeness ?? 'default' })
  }

  /** Cost-free check that the API key is accepted (`GET features`). Throws a `SupertextError`. */
  validateApiKey(): Promise<void> {
    return this.sdk.validateApiKey()
  }

  /** The same check as a result (`ok`, `invalid`, `missing`, `unreachable`, `error`); never throws. */
  checkApiKey(): Promise<ApiKeyCheck> {
    return this.sdk.checkApiKey()
  }
}
