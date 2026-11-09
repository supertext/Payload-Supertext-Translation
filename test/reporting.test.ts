import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { languageStatus } from '../src/endpoints.js'
import { PLUGIN_NAME, Reporting, SDK_VERSION, siteUrl, StateStore, versionReportsEnabled } from '../src/reporting.js'
import { apiKeyFingerprint } from '../src/vendor/supertext-sdk/v1/index.js'
import { pluginVersion, releaseUrl } from '../src/versions.js'
import { fakeSupertext } from './fakeSupertext.js'

const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as { version: string; repository: { url: string } }

const fakePayload = (kv?: unknown) =>
  ({
    config: { routes: { api: '/api' }, serverURL: '' },
    kv,
    logger: { debug: () => {} },
  }) as never

const memoryKv = () => {
  const map = new Map<string, unknown>()
  return {
    map,
    get: async (key: string) => map.get(key) ?? null,
    set: async (key: string, value: unknown) => void map.set(key, value),
  }
}

const req = (payload: unknown, headers: Record<string, string> = { host: 'cms.example.ch' }) =>
  ({ headers: new Headers(headers), payload }) as never

describe('reporting glue', () => {
  it('uses the GitHub repository name and the version from package.json', () => {
    expect(pkg.repository.url).toContain(`/${PLUGIN_NAME}.git`)
    expect(pluginVersion()).toBe(pkg.version)
    expect(releaseUrl('1.2.3')).toBe('https://github.com/Supertext/Payload-Supertext-Translation/releases/tag/v1.2.3')
    expect(releaseUrl('1.2.3-beta')).toBeNull()
    expect(releaseUrl(null)).toBeNull()
  })

  it('turns reports off with the option or SUPERTEXT_VERSION_REPORTS (the environment wins)', () => {
    expect(versionReportsEnabled(undefined, undefined)).toBe(true)
    expect(versionReportsEnabled(false, undefined)).toBe(false)
    expect(versionReportsEnabled(true, '0')).toBe(false)
    expect(versionReportsEnabled(false, 'on')).toBe(true)
  })

  it('takes the site URL from serverURL, else from the request (proxy headers first)', () => {
    expect(siteUrl('https://cms.example.ch/', undefined)).toBe('https://cms.example.ch')
    expect(siteUrl('', { headers: new Headers({ host: 'a.example.ch' }) })).toBe('http://a.example.ch')
    expect(
      siteUrl(undefined, { headers: new Headers({ host: 'internal:3000', 'x-forwarded-host': 'b.example.ch', 'x-forwarded-proto': 'https' }) }),
    ).toBe('https://b.example.ch')
    expect(siteUrl(undefined, { headers: new Headers(), url: 'https://c.example.ch/api/supertext/status' })).toBe('https://c.example.ch')
    expect(siteUrl(undefined, { headers: new Headers({ host: 'bad host/<x>' }) })).toBeNull()
  })

  it('keeps the state in Payload’s key-value store, or in memory without one', async () => {
    const kv = memoryKv()
    const store = new StateStore(fakePayload(kv))
    expect(await store.load()).toEqual({ keyCheck: null, lastFailureAt: null, reportedKeyStatus: null, reportedVersions: null })
    await store.save({ keyCheck: null, lastFailureAt: null, reportedKeyStatus: 'ok', reportedVersions: '1|2|3' })
    expect(kv.map.get('supertext-reporter')).toMatchObject({ reportedVersions: '1|2|3' })

    const memory = new StateStore(fakePayload(undefined))
    await memory.save({ keyCheck: null, lastFailureAt: null, reportedKeyStatus: null, reportedVersions: 'x' })
    expect((await memory.load()).reportedVersions).toBe('x')
  })

  it('reports installed, then nothing, then upgraded, and never with the key', async () => {
    const fake = fakeSupertext()
    const kv = memoryKv()
    const payload = fakePayload(kv)
    let version = '3.90.0'
    const make = () =>
      new Reporting({
        apiBaseUrl: 'https://api.test/v1/',
        reporterOverrides: {
          clientOptions: { baseUrl: 'https://api.test/v1/', fetch: fake.fetch, sleep: async () => {} },
          fetch: fake.fetch,
          reportUrl: 'https://center.test/api/v1/report',
          system: { name: 'Payload', version },
        },
      })
    expect((await make().run('onRequest', req(payload), 'test-key'))?.event).toBe('installed')
    expect((await make().run('onRequest', req(payload), 'test-key'))?.event).toBeNull()
    version = '3.91.0'
    expect((await make().run('onRequest', req(payload), 'test-key'))?.event).toBe('upgraded')
    expect(fake.reports.map((r) => r.event)).toEqual(['installed', 'upgraded'])
    expect(fake.reports[0]).toMatchObject({ callback: { url: 'http://cms.example.ch/api/supertext/ping' }, sdk_version: SDK_VERSION, site_url: 'http://cms.example.ch' })
    expect(JSON.stringify(fake.reports)).not.toContain('test-key')
    expect(JSON.stringify([...kv.map.values()])).not.toContain('test-key')
  })

  it('keeps the state the SDK 0.2 reporter stored: no new installed report', async () => {
    const fake = fakeSupertext()
    const kv = memoryKv()
    const reporting = new Reporting({
      apiBaseUrl: 'https://api.test/v1/',
      reporterOverrides: { clientOptions: { fetch: fake.fetch }, fetch: fake.fetch, reportUrl: 'https://center.test/api/v1/report' },
    })
    const versions = reporting.reporter(fakePayload(kv), 'http://cms.example.ch').versions
    const keyCheck = { checkedAt: '2026-10-01T08:00:00Z', errorCode: null, fingerprint: apiKeyFingerprint('test-key'), httpStatus: 200, status: 'ok' }
    const old = { keyCheck, lastFailureAt: null, reportedKeyStatus: 'ok', reportedVersions: versions }
    kv.map.set('supertext-reporter', old)
    expect(await reporting.run('onRequest', req(fakePayload(kv)), 'test-key')).toMatchObject({ event: null, sent: false })
    expect(fake.reports).toHaveLength(0)
    expect(kv.map.get('supertext-reporter')).toEqual(old)
  })

  it('backs off after a failed report and never throws', async () => {
    const fake = fakeSupertext({ centerStatus: 503 })
    const kv = memoryKv()
    const reporting = new Reporting({
      apiBaseUrl: 'https://api.test/v1/',
      reporterOverrides: { clientOptions: { fetch: fake.fetch }, fetch: fake.fetch, reportUrl: 'https://center.test/api/v1/report' },
    })
    expect(await reporting.run('onRequest', req(fakePayload(kv)), 'test-key')).toMatchObject({ event: 'installed', sent: false })
    expect(await reporting.run('onRequest', req(fakePayload(kv)), 'test-key')).toMatchObject({ event: null, sent: false })
    expect(fake.reports).toHaveLength(1)

    const broken = { get: async () => Promise.reject(new Error('db down')), set: async () => {} }
    expect(await reporting.run('onRequest', req(fakePayload(broken)), 'test-key')).toBeNull()
    expect(await reporting.lastCheck(fakePayload(broken))).toBeNull()
    expect(await reporting.run('onRequest', req(fakePayload(kv), {}), 'test-key')).toBeNull() // no site URL
  })

  it('answers the ping only while reports are on', () => {
    expect(new Reporting({ apiBaseUrl: '', versionReports: true }).ping('abcdefghijklmnop')).toMatchObject({ status: 200 })
    expect(new Reporting({ apiBaseUrl: '', versionReports: false }).ping('abcdefghijklmnop')).toMatchObject({ status: 404 })
    expect(new Reporting({ apiBaseUrl: '', versionReports: true }).ping(undefined)).toMatchObject({ status: 400 })
  })
})

describe('languageStatus', () => {
  it('shows where each code comes from, locales without one and a tone the target lacks', () => {
    expect(
      languageStatus(
        ['de-CH', 'en-US', 'de', 'zh', 'it', 'de-LI'],
        { languageMap: { zh: 'zh-Hant' }, politeness: { 'de-CH': 'more', 'en-US': 'less' } },
        { languageMap: { it: 'it-CH', zh: 'zh-Hans' }, politeness: { it: 'less' }, review: {} },
      ),
    ).toEqual([
      { locale: 'de-CH', origin: 'automatic', politeness: 'more', politenessSupported: true, supertext: 'de-CH' },
      { locale: 'en-US', origin: 'automatic', politeness: 'less', politenessSupported: false, supertext: 'en-US' },
      { locale: 'de', origin: 'automatic', politeness: 'default', politenessSupported: true, supertext: 'de-DE' },
      { locale: 'zh', origin: 'option', politeness: 'default', politenessSupported: true, supertext: 'zh-Hant' },
      { locale: 'it', origin: 'settings', politeness: 'less', politenessSupported: true, supertext: 'it-CH' },
      { locale: 'de-LI', origin: null, politeness: 'default', politenessSupported: true, supertext: null },
    ])
  })
})
