import { describe, expect, it } from 'vitest'

import { politenessForTarget, sourceCode, targetCode, targetCodeOrNull } from '../src/languages.js'
import { createClient, resolveReviewUrl } from '../src/endpoints.js'
import { REVIEW_URL, SupertextClient, SupertextError } from '../src/supertext/client.js'
import { pluginVersion } from '../src/versions.js'
import { fakeSupertext } from './fakeSupertext.js'

const noSleep = async () => {}
const client = (fake: ReturnType<typeof fakeSupertext>, extra: Partial<ConstructorParameters<typeof SupertextClient>[0]> = {}) =>
  new SupertextClient({ apiKey: 'test-key', baseUrl: 'https://api.test/v1', fetch: fake.fetch, sleep: noSleep, ...extra })

describe('SupertextClient', () => {
  it('runs upload → poll → download → delete', async () => {
    const fake = fakeSupertext({ statuses: ['translating', 'translating', 'done'] })
    const html = await client(fake).translateHtml({
      html: '<p data-st-id="0">Hallo</p>',
      politeness: 'more',
      sourceLang: 'de',
      targetLang: 'fr-CH',
    })

    expect(html).toContain('[fr-CH] Hallo')
    expect(fake.calls.map((c) => `${c.method} ${c.url.replace('https://api.test/v1/', '')}`)).toEqual([
      'POST translate/ai/file',
      'GET translate/ai/file/f1/status',
      'GET translate/ai/file/f1/status',
      'GET translate/ai/file/f1/status',
      'GET translate/ai/file/f1/translation',
      'DELETE translate/ai/file/f1',
    ])
    const form = fake.calls[0]?.form as FormData
    expect(form.get('target_lang')).toBe('fr-CH')
    expect(form.get('source_lang')).toBe('de')
    expect(form.get('politeness')).toBe('more')
    // Must be exactly text/html — a charset suffix is rejected with 415.
    expect((form.get('file') as File).type).toBe('text/html')
    expect((form.get('file') as File).name).toBe('content.html')
  })

  it('omits optional fields when not needed', async () => {
    const fake = fakeSupertext()
    await client(fake).translateHtml({ html: '<p data-st-id="0">x</p>', targetLang: 'en-US' })
    const form = fake.calls[0]?.form as FormData
    expect(form.has('source_lang')).toBe(false)
    expect(form.has('politeness')).toBe(false)
  })

  it.each([
    ['error', 'translation_error'],
    ['limit_exceeded', 'quota_exceeded'],
    ['deleted', 'file_deleted'],
  ])('maps status %s and still deletes the file', async (status, code) => {
    const fake = fakeSupertext({ statuses: [status] })
    await expect(client(fake).translateHtml({ html: 'x', targetLang: 'en-US' })).rejects.toMatchObject({ code })
    expect(fake.calls.at(-1)?.method).toBe('DELETE')
  })

  it('times out', async () => {
    const fake = fakeSupertext({ statuses: ['translating'] })
    let now = 0
    const realNow = Date.now
    Date.now = () => now
    try {
      const c = client(fake, { pollIntervalMs: 1000, sleep: async (ms) => void (now += ms), timeoutMs: 5000 })
      await expect(c.translateHtml({ html: 'x', targetLang: 'en-US' })).rejects.toMatchObject({ code: 'timeout' })
    } finally {
      Date.now = realNow
    }
  })

  it.each([
    [401, 'authentication_failure'],
    [413, 'payload_too_large'],
    [429, 'too_many_requests'],
    [503, 'service_unavailable'],
    [418, 'unexpected_status'],
  ])('maps HTTP %i', async (status, code) => {
    const fake = fakeSupertext({ failStatus: status })
    const err = await client(fake).translateHtml({ html: 'x', targetLang: 'en-US' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SupertextError)
    expect(err).toMatchObject({ code, status })
  })

  it('refuses to call without an API key', async () => {
    const fake = fakeSupertext()
    await expect(client(fake, { apiKey: '' }).validateApiKey()).rejects.toMatchObject({ code: 'missing_api_key' })
    expect(fake.calls).toHaveLength(0)
  })
})

describe('Translation review', () => {
  it('sends review locales to the review service (all four calls, same key), the others directly', async () => {
    const fake = fakeSupertext()
    const direct = client(fake, { reviewUrl: 'https://review.test/v1/' })
    expect(direct.forReview(false)).toBe(direct)
    const review = direct.forReview(true)
    expect(review).not.toBe(direct)
    expect(direct.forReview(true)).toBe(review)

    expect(await review.translateHtml({ html: '<p data-st-id="0">Hallo</p>', targetLang: 'fr-CH' })).toContain('[fr-CH] Hallo')
    expect(fake.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://review.test/v1/translate/ai/file',
      'GET https://review.test/v1/translate/ai/file/f1/status',
      'GET https://review.test/v1/translate/ai/file/f1/translation',
      'DELETE https://review.test/v1/translate/ai/file/f1',
    ])

    fake.calls.length = 0
    await direct.translateHtml({ html: '<p data-st-id="0">Hallo</p>', targetLang: 'de-CH' })
    await direct.validateApiKey()
    expect(fake.calls.every((c) => c.url.startsWith('https://api.test/v1/'))).toBe(true)
  })

  it('is off without a review URL or with the API URL itself', () => {
    const fake = fakeSupertext()
    for (const reviewUrl of [undefined, '', '  ', 'https://api.test/v1/']) {
      const c = client(fake, { reviewUrl })
      expect(c.forReview(true), String(reviewUrl)).toBe(c)
    }
  })

  it('defaults to Supertext’s review service; SUPERTEXT_REVIEW_URL and the option change it, empty turns it off', async () => {
    const before = process.env.SUPERTEXT_REVIEW_URL
    try {
      delete process.env.SUPERTEXT_REVIEW_URL
      expect(resolveReviewUrl({})).toBe(REVIEW_URL)
      expect(REVIEW_URL).toBe('https://localizationreview-production.up.railway.app/v1/')
      process.env.SUPERTEXT_REVIEW_URL = 'http://localhost:3000/v1/'
      expect(resolveReviewUrl({})).toBe('http://localhost:3000/v1/')
      expect(resolveReviewUrl({ reviewUrl: '' })).toBe('')
      process.env.SUPERTEXT_REVIEW_URL = ''
      const c = createClient({ apiKey: 'test-key' })
      expect(c.forReview(true)).toBe(c)
    } finally {
      if (before === undefined) delete process.env.SUPERTEXT_REVIEW_URL
      else process.env.SUPERTEXT_REVIEW_URL = before
    }
  })

  it('names the plugin and its version in the User-Agent', async () => {
    let agent = ''
    const fake = fakeSupertext()
    const fetchSpy = (async (input: RequestInfo | URL, init?: RequestInit) => {
      agent = new Headers(init?.headers).get('User-Agent') ?? ''
      return fake.fetch(input, init)
    }) as typeof fetch
    await client(fake, { fetch: fetchSpy }).validateApiKey()
    expect(pluginVersion()).toMatch(/^\d+\.\d+\.\d+/)
    expect(agent).toContain(`Payload-Supertext-Translation/${pluginVersion()}`)
  })
})

describe('language codes', () => {
  it('sends a bare source language', () => {
    expect(sourceCode('en')).toBe('en')
  })
  it('strips the region from a regional source', () => {
    expect(sourceCode('de-CH')).toBe('de')
    expect(sourceCode('pt_BR')).toBe('pt')
    expect(sourceCode('EN-us')).toBe('en')
  })
  it('uses a locale that is a Supertext code, apart from case and underscores', () => {
    expect(targetCode('de-CH')).toBe('de-CH')
    expect(targetCode('de_ch')).toBe('de-CH')
    expect(targetCode('fr-ch')).toBe('fr-CH')
    expect(targetCode('zh-hant')).toBe('zh-Hant')
    expect(targetCode('es')).toBe('es')
    expect(targetCode('NL')).toBe('nl')
  })
  it('uses the SDK default where one is obvious', () => {
    expect(targetCode('de')).toBe('de-DE')
    expect(targetCode('en')).toBe('en-US')
    expect(targetCode('fr')).toBe('fr-FR')
    expect(targetCode('zh')).toBe('zh-Hans')
    expect(targetCode('zh-TW')).toBe('zh-Hant')
    expect(targetCode('es-ES')).toBe('es')
  })
  it('guesses nothing else: locales without mapping and default are an unsupported_language error', () => {
    for (const locale of ['en-IE', 'de-LI', 'gsw', 'sr-RS', 'xx']) {
      expect(() => targetCode(locale), locale).toThrow(SupertextError)
      expect(targetCodeOrNull(locale), locale).toBeNull()
    }
    const err = (() => {
      try {
        targetCode('de-LI')
      } catch (e) {
        return e
      }
    })()
    expect(err).toMatchObject({ code: 'unsupported_language', targetLang: 'de-LI' })
  })
  it('lets the mapping win', () => {
    expect(targetCode('de', { de: 'de-CH' })).toBe('de-CH')
    expect(targetCode('ch', { ch: 'de-CH' })).toBe('de-CH')
    expect(targetCode('zh', { zh: 'zh-Hans' })).toBe('zh-Hans')
    // One map serves both directions: as a source, the mapped code's language is sent.
    expect(sourceCode('ch', { ch: 'de-CH' })).toBe('de')
    expect(sourceCode('de', { de: 'de-CH' })).toBe('de')
    expect(sourceCode('no', { no: 'nb' })).toBe('nb')
    expect(targetCode('en', { en: 'en-US' })).toBe('en-US')
    expect(sourceCode('en', { en: 'en-US' })).toBe('en')
  })
  it('refuses a tone the target lacks, before sending', () => {
    expect(politenessForTarget('de-CH', 'de-CH', { 'de-CH': 'more' })).toBe('more')
    expect(politenessForTarget('en-US', 'en-US', {})).toBe('default')
    expect(() => politenessForTarget('en-US', 'en-US', { 'en-US': 'less' })).toThrow(
      expect.objectContaining({ code: 'unsupported_feature', feature: 'politeness' }),
    )
  })
})

describe('API key', () => {
  it('accepts the key with or without the Supertext-Auth-Key prefix', async () => {
    // The fake accepts exactly "Authorization: Supertext-Auth-Key test-key".
    const fake = fakeSupertext()
    await client(fake, { apiKey: ' Supertext-Auth-Key test-key ' }).validateApiKey()
    await client(fake, { apiKey: 'test-key' }).validateApiKey()
    expect(fake.calls).toHaveLength(2)
  })
})

describe('rate limiting', () => {
  it('retries after HTTP 429 and then succeeds', async () => {
    const fake = fakeSupertext({ rateLimited: 2 })
    const waits: number[] = []
    const html = await client(fake, { sleep: async (ms) => void waits.push(ms) }).translateHtml({
      html: '<p data-st-id="0">Hallo</p>',
      targetLang: 'en-US',
    })
    expect(html).toContain('[en-US] Hallo')
    expect(waits).toHaveLength(2)
  })

  it('gives up after a few retries', async () => {
    const fake = fakeSupertext({ rateLimited: 99 })
    await expect(client(fake).translateHtml({ html: '<p data-st-id="0">Hallo</p>', targetLang: 'en-US' })).rejects.toMatchObject({
      code: 'too_many_requests',
    })
  })

  it('honours Retry-After', async () => {
    const { retryDelayMs } = await import('../src/vendor/supertext-sdk/v1/index.js')
    expect(retryDelayMs(0, '3')).toBe(3000)
    expect(retryDelayMs(1, null)).toBeGreaterThanOrEqual(2000)
  })
})
