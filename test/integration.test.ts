import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { buildConfig, getPayload, type Payload } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { STATUS_PANEL_PATH, supertextTranslation, TRANSLATE_BUTTON_PATH } from '../src/index.js'
import { SupertextClient } from '../src/supertext/client.js'
import { translateDocument } from '../src/translate.js'
import type { SupertextTranslationOptions } from '../src/types.js'
import { fakeSupertext } from './fakeSupertext.js'

const options: SupertextTranslationOptions = {
  apiKey: 'test-key',
  collections: ['pages'],
  globals: ['header'],
  // fr would default to fr-FR anyway; de-LI has no Supertext language and no default, on purpose.
  languageMap: { fr: 'fr-FR' },
  politeness: { 'de-CH': 'more' },
}

let payload: Payload

const lexical = (t: string) => ({
  root: {
    children: [
      {
        children: [{ detail: 0, format: 0, mode: 'normal', style: '', text: t, type: 'text', version: 1 }],
        direction: 'ltr',
        format: '',
        indent: 0,
        type: 'paragraph',
        version: 1,
      },
    ],
    direction: 'ltr',
    format: '',
    indent: 0,
    type: 'root',
    version: 1,
  },
})

beforeAll(async () => {
  const config = await buildConfig({
    collections: [
      {
        fields: [
          { localized: true, name: 'title', required: true, type: 'text' },
          { localized: true, name: 'slug', type: 'text' },
          { name: 'code', type: 'text' },
          { localized: true, name: 'body', type: 'richText' },
          { fields: [{ localized: true, name: 'label', type: 'text' }], name: 'links', type: 'array' },
          { fields: [{ name: 'q', type: 'text' }], localized: true, name: 'faq', type: 'array' },
          {
            blocks: [{ fields: [{ localized: true, name: 'heading', type: 'text' }], slug: 'hero' }],
            name: 'layout',
            type: 'blocks',
          },
        ],
        slug: 'pages',
        versions: { drafts: true },
      },
    ],
    db: sqliteAdapter({ client: { url: ':memory:' } }),
    editor: lexicalEditor(),
    globals: [{ fields: [{ localized: true, name: 'tagline', type: 'text' }], slug: 'header' }],
    localization: { defaultLocale: 'en', locales: ['en', 'de-CH', 'fr', 'de-LI'] },
    plugins: [supertextTranslation(options)],
    secret: 'test-secret',
    telemetry: false,
  })
  payload = await getPayload({ config })
}, 60_000)

afterAll(async () => {
  await payload?.destroy()
})

const client = (fake: ReturnType<typeof fakeSupertext>) =>
  new SupertextClient({ apiKey: 'test-key', fetch: fake.fetch, sleep: async () => {} })

describe('with a real Payload instance', () => {
  it('registers the endpoints and the admin control', () => {
    const paths = payload.config.endpoints.map((e) => `${e.method} ${e.path}`)
    expect(paths).toContain('post /supertext/translate')
    expect(paths).toContain('get /supertext/status')
    expect(paths).toContain('get /supertext/ping')
    expect(paths).toContain('post /supertext/check-key')
    expect(JSON.stringify(payload.config.admin.components?.afterDashboard)).toContain(STATUS_PANEL_PATH)
    const pages = payload.collections.pages?.config
    expect(JSON.stringify(pages?.admin.components?.edit?.beforeDocumentControls)).toContain(TRANSLATE_BUTTON_PATH)
  })

  it('translates a collection document into several locales and keeps shared data intact', async () => {
    const page = await payload.create({
      collection: 'pages',
      data: {
        _status: 'published',
        body: lexical('Hello world') as never,
        code: 'P-1',
        faq: [{ q: 'Why?' }],
        layout: [{ blockType: 'hero', heading: 'Welcome' }],
        links: [{ label: 'Home' }],
        slug: 'home',
        title: 'Home page',
      },
      locale: 'en',
    })

    const fake = fakeSupertext()
    const results = await translateDocument({
      client: client(fake),
      collection: 'pages',
      id: page.id,
      options,
      payload,
      sourceLocale: 'en',
      targetLocales: ['de-CH', 'fr', 'en'],
    })

    expect(results).toEqual([
      { locale: 'de-CH', missing: [], ok: true, segments: 5 },
      { locale: 'fr', missing: [], ok: true, segments: 5 },
    ])
    const uploads = fake.calls.filter((c) => c.method === 'POST')
    expect(uploads.map((c) => c.form?.get('source_lang'))).toEqual(['en', 'en'])

    const fr = await payload.findByID({ collection: 'pages', draft: true, fallbackLocale: false as never, id: page.id, locale: 'fr' })
    expect(fr.title).toBe('[fr-FR] Home page')
    expect(fr.slug).toBeFalsy() // skipped by default
    expect(JSON.stringify(fr.body)).toContain('[fr-FR] Hello world')
    expect(fr.links?.[0]?.label).toBe('[fr-FR] Home')
    expect(fr.faq?.[0]?.q).toBe('[fr-FR] Why?')
    expect(fr.layout?.[0]?.heading).toBe('[fr-FR] Welcome')
    expect(fr.code).toBe('P-1')

    const de = await payload.findByID({ collection: 'pages', draft: true, fallbackLocale: false as never, id: page.id, locale: 'de-CH' })
    expect(de.title).toBe('[de-CH] Home page')

    // Source locale untouched; shared array row kept its id.
    const en = await payload.findByID({ collection: 'pages', draft: true, id: page.id, locale: 'en' })
    expect(en.title).toBe('Home page')
    expect(en.links?.[0]?.label).toBe('Home')
    expect(en.links?.[0]?.id).toBe(page.links?.[0]?.id)
    expect(en.faq?.[0]?.q).toBe('Why?')
  })

  it('saves into drafts so the published version stays until review', async () => {
    const page = await payload.create({
      collection: 'pages',
      data: { _status: 'published', title: 'Published' },
      locale: 'en',
    })
    await translateDocument({
      client: client(fakeSupertext()),
      collection: 'pages',
      id: page.id,
      options,
      payload,
      sourceLocale: 'en',
      targetLocales: ['fr'],
    })
    const published = await payload.findByID({ collection: 'pages', draft: false, fallbackLocale: false as never, id: page.id, locale: 'fr' })
    const draft = await payload.findByID({ collection: 'pages', draft: true, fallbackLocale: false as never, id: page.id, locale: 'fr' })
    expect(published.title).toBeFalsy()
    expect(draft.title).toBe('[fr-FR] Published')
  })

  it('translates globals', async () => {
    await payload.updateGlobal({ data: { tagline: 'Swiss quality' }, locale: 'en', slug: 'header' })
    const results = await translateDocument({
      client: client(fakeSupertext()),
      global: 'header',
      options,
      payload,
      sourceLocale: 'en',
      targetLocales: ['fr'],
    })
    expect(results[0]).toMatchObject({ ok: true, segments: 1 })
    const header = await payload.findGlobal({ fallbackLocale: false as never, locale: 'fr', slug: 'header' })
    expect(header.tagline).toBe('[fr-FR] Swiss quality')
  })

  it('reports a failing locale without throwing', async () => {
    const page = await payload.create({ collection: 'pages', data: { title: 'X' }, locale: 'en' })
    const results = await translateDocument({
      client: client(fakeSupertext({ statuses: ['limit_exceeded'] })),
      collection: 'pages',
      id: page.id,
      options,
      payload,
      sourceLocale: 'en',
      targetLocales: ['fr'],
    })
    expect(results[0]).toMatchObject({ code: 'quota_exceeded', locale: 'fr', ok: false })
  })

  it('sends nothing for a locale without a Supertext language', async () => {
    const page = await payload.create({ collection: 'pages', data: { title: 'Unmapped' }, locale: 'en' })
    const fake = fakeSupertext()
    const results = await translateDocument({
      client: client(fake),
      collection: 'pages',
      id: page.id,
      options,
      payload,
      sourceLocale: 'en',
      targetLocales: ['de-LI'],
    })
    expect(results[0]).toMatchObject({ code: 'unsupported_language', locale: 'de-LI', ok: false })
    expect((results[0] as { error: string }).error).toContain('The language de-LI has no Supertext language yet')
    expect(fake.calls).toHaveLength(0)
  })

  it('sends the formal tone where the target offers it', async () => {
    const page = await payload.create({ collection: 'pages', data: { title: 'Formal' }, locale: 'en' })
    const fake = fakeSupertext()
    await translateDocument({
      client: client(fake),
      collection: 'pages',
      id: page.id,
      options,
      payload,
      sourceLocale: 'en',
      targetLocales: ['de-CH'],
    })
    expect(fake.calls[0]?.form?.get('politeness')).toBe('more')
    expect(fake.calls[0]?.form?.get('target_lang')).toBe('de-CH')
  })

  describe('Supertext settings (one combo box per locale)', () => {
    afterAll(async () => {
      await payload.updateGlobal({ data: { languages: { l_de_CH_review: false, l_de_LI: null, l_en: null, l_fr: null } } as never, slug: 'supertext-settings' as never })
    })

    it('has a select per locale with the SDK targets, preselecting the suggestion', () => {
      const global = payload.config.globals.find((g) => g.slug === 'supertext-settings')!
      const group = global.fields[0] as { fields: { fields: Record<string, any>[] }[] }
      const selects = group.fields.map((row) => row.fields[0]!)
      expect(selects.map((f) => f.name)).toEqual(['l_en', 'l_de_CH', 'l_fr', 'l_de_LI'])
      expect(selects.map((f) => f.defaultValue)).toEqual(['en-US', 'de-CH', 'fr-FR', undefined])
      expect(selects[0]!.options.map((o: { value: string }) => o.value)).toContain('gsw-u-sd-chzh')
      expect(selects[0]!.options.find((o: { value: string }) => o.value === 'de-CH').label.de).toBe('Schweizer Hochdeutsch (de-CH)')
      // fr is set by the languageMap option: read-only and says so.
      expect(selects[2]!.admin.readOnly).toBe(true)
    })

    it('uses the saved mapping, lets the option win and refuses unknown codes', async () => {
      await payload.updateGlobal({ data: { languages: { l_de_LI: 'de-CH', l_fr: 'fr-CH' } } as never, slug: 'supertext-settings' as never })
      await expect(
        payload.updateGlobal({ data: { languages: { l_en: 'en-XX' } } as never, slug: 'supertext-settings' as never }),
      ).rejects.toThrow()
      const page = await payload.create({ collection: 'pages', data: { title: 'Mapped' }, locale: 'en' })
      const fake = fakeSupertext()
      const results = await translateDocument({
        client: client(fake),
        collection: 'pages',
        id: page.id,
        options,
        payload,
        sourceLocale: 'en',
        targetLocales: ['de-LI', 'fr'],
      })
      expect(results.map((r) => r.ok)).toEqual([true, true])
      const targets = fake.calls.filter((c) => c.method === 'POST').map((c) => c.form?.get('target_lang'))
      expect(targets.sort()).toEqual(['de-CH', 'fr-FR'])
    })

    it('has a Translation review checkbox per locale, off by default, and sends review locales to the review service', async () => {
      const global = payload.config.globals.find((g) => g.slug === 'supertext-settings')!
      const group = global.fields[0] as { fields: { fields: Record<string, any>[] }[] }
      const checkboxes = group.fields.map((row) => row.fields[2]!)
      expect(checkboxes.map((f) => [f.name, f.type, f.defaultValue])).toEqual([
        ['l_en_review', 'checkbox', false],
        ['l_de_CH_review', 'checkbox', false],
        ['l_fr_review', 'checkbox', false],
        ['l_de_LI_review', 'checkbox', false],
      ])
      expect(checkboxes[1]!.label.de).toBe('Übersetzungsprüfung')

      await payload.updateGlobal({ data: { languages: { l_de_CH_review: true } } as never, slug: 'supertext-settings' as never })
      const page = await payload.create({ collection: 'pages', data: { title: 'Reviewed' }, locale: 'en' })
      const fake = fakeSupertext()
      const results = await translateDocument({
        client: new SupertextClient({ apiKey: 'test-key', fetch: fake.fetch, reviewUrl: 'https://review.test/v1/', sleep: async () => {} }),
        collection: 'pages',
        id: page.id,
        options,
        payload,
        sourceLocale: 'en',
        targetLocales: ['de-CH', 'fr'],
      })
      expect(results.map((r) => r.ok)).toEqual([true, true])
      const byTarget = (lang: string) => {
        const id = fake.calls.findIndex((c) => c.method === 'POST' && c.form?.get('target_lang') === lang)
        const fileId = `f${fake.calls.slice(0, id + 1).filter((c) => c.method === 'POST').length}`
        return fake.calls.filter((c, i) => i === id || c.url.includes(`/${fileId}`)).map((c) => `${c.method} ${c.url}`)
      }
      expect(byTarget('de-CH')).toEqual([
        'POST https://review.test/v1/translate/ai/file',
        expect.stringMatching(/^GET https:\/\/review\.test\/v1\/translate\/ai\/file\/f\d\/status$/),
        expect.stringMatching(/^GET https:\/\/review\.test\/v1\/translate\/ai\/file\/f\d\/translation$/),
        expect.stringMatching(/^DELETE https:\/\/review\.test\/v1\/translate\/ai\/file\/f\d$/),
      ])
      expect(byTarget('fr-FR').every((c) => c.includes(' https://api.supertext.com/v1/'))).toBe(true)
      expect(byTarget('fr-FR')).toHaveLength(4)
      const saved = await payload.findGlobal({ slug: 'supertext-settings' as never })
      expect((saved as { languages: Record<string, unknown> }).languages.l_fr_review).toBe(false)
    })

    it('is only for logged-in users', async () => {
      await expect(
        payload.findGlobal({ overrideAccess: false, slug: 'supertext-settings' as never, user: null } as never),
      ).rejects.toThrow()
    })
  })

  describe('POST /api/supertext/translate', () => {
    const call = async (body: unknown, user: unknown = { id: 1 }) => {
      const endpoint = payload.config.endpoints.find((e) => e.path === '/supertext/translate')!
      const res = await endpoint.handler({ headers: new Headers({ host: 'cms.example.ch' }), json: async () => body, payload, user } as never)
      return { body: (await res.json()) as Record<string, unknown>, status: res.status }
    }

    it('requires a logged-in user', async () => {
      expect((await call({}, null)).status).toBe(401)
    })

    it.each([
      [{ sourceLocale: 'en', targetLocales: ['fr'] }, 'exactly one'],
      [{ collection: 'users', id: 1, sourceLocale: 'en', targetLocales: ['fr'] }, 'not enabled'],
      [{ collection: 'pages', sourceLocale: 'en', targetLocales: ['fr'] }, 'Missing "id"'],
      [{ collection: 'pages', id: 1, sourceLocale: 'xx', targetLocales: ['fr'] }, 'sourceLocale'],
      [{ collection: 'pages', id: 1, sourceLocale: 'en', targetLocales: ['it'] }, 'Unknown target'],
      [{ collection: 'pages', id: 1, sourceLocale: 'en', targetLocales: ['en'] }, 'at least one'],
    ])('rejects %j', async (body, message) => {
      const res = await call(body)
      expect(res.status).toBe(400)
      expect(String(res.body.error)).toContain(message)
    })

    it('translates through the endpoint with the configured key', async () => {
      const page = await payload.create({ collection: 'pages', data: { title: 'Via endpoint' }, locale: 'en' })
      const fake = fakeSupertext()
      vi.stubGlobal('fetch', fake.fetch)
      try {
        const res = await call({ collection: 'pages', id: page.id, sourceLocale: 'en', targetLocales: ['de-CH'] })
        expect(res.status).toBe(200)
        expect(res.body.results).toEqual([{ locale: 'de-CH', missing: [], ok: true, segments: 1 }])
        expect(fake.calls.find((c) => c.method === 'POST')?.url).toBe('https://api.supertext.com/v1/translate/ai/file')
      } finally {
        vi.unstubAllGlobals()
      }
    })
  })

  describe('Commando Center: status, key check, reports and ping', () => {
    const endpoint = (method: string, path: string) =>
      payload.config.endpoints.find((e) => e.method === method && e.path === path)!
    const request = (extra: Record<string, unknown> = {}) =>
      ({ headers: new Headers({ host: 'cms.example.ch', 'x-forwarded-proto': 'https' }), payload, user: { id: 1 }, ...extra }) as never

    beforeAll(async () => {
      await payload.kv.delete('supertext-reporter')
    })
    afterEach(() => {
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
    })

    it('answers the ping without login, exactly as the SDK says', async () => {
      const ping = endpoint('get', '/supertext/ping')
      const ok = await ping.handler({ payload, searchParams: new URLSearchParams('challenge=abcdefghijklmnop'), user: null } as never)
      expect(ok.status).toBe(200)
      expect(ok.headers.get('cache-control')).toBe('no-store')
      expect(await ok.json()).toEqual({ challenge: 'abcdefghijklmnop', ok: true, plugin: 'Payload-Supertext-Translation' })
      const bad = await ping.handler({ payload, searchParams: new URLSearchParams('challenge=<script>'), user: null } as never)
      expect(bad.status).toBe(400)
      vi.stubEnv('SUPERTEXT_VERSION_REPORTS', '0')
      const off = await ping.handler({ payload, searchParams: new URLSearchParams('challenge=abcdefghijklmnop'), user: null } as never)
      expect(off.status).toBe(404)
    })

    it('reports the installation once from the status endpoint and shows the key check', async () => {
      const fake = fakeSupertext()
      vi.stubGlobal('fetch', fake.fetch)
      vi.stubEnv('SUPERTEXT_REPORT_URL', 'https://center.test/api/v1/report')
      const status = endpoint('get', '/supertext/status')

      const first = await status.handler(request())
      const body = (await first.json()) as Record<string, any>
      expect(body.languages).toEqual([
        { locale: 'en', origin: 'automatic', politeness: 'default', politenessSupported: true, supertext: 'en-US' }, // the SDK default
        { locale: 'de-CH', origin: 'automatic', politeness: 'more', politenessSupported: true, supertext: 'de-CH' },
        { locale: 'fr', origin: 'option', politeness: 'default', politenessSupported: true, supertext: 'fr-FR' },
        { locale: 'de-LI', origin: null, politeness: 'default', politenessSupported: true, supertext: null },
      ])
      expect(body.settingsUrl).toBe('/admin/globals/supertext-settings')
      expect(body.version).toMatch(/^\d+\.\d+\.\d+/)
      expect(body.reports).toEqual({ enabled: true, pingUrl: 'https://cms.example.ch/api/supertext/ping' })

      await vi.waitFor(() => expect(fake.reports).toHaveLength(1))
      const report = fake.reports[0]!
      expect(report).toMatchObject({
        api_key_check: { http_status: 200, status: 'ok' },
        api_key_configured: true,
        callback: { url: 'https://cms.example.ch/api/supertext/ping' },
        event: 'installed',
        plugin: { name: 'Payload-Supertext-Translation', version: body.version },
        schema: 1,
        site_url: 'https://cms.example.ch',
        system: { name: 'Payload' },
      })
      expect((report.system as { version?: string }).version).toMatch(/^3\./)
      expect(JSON.stringify(report)).not.toContain('test-key')
      const stored = await payload.kv.get<Record<string, unknown>>('supertext-reporter')
      expect(stored).toMatchObject({ reportedKeyStatus: 'ok' })
      expect(JSON.stringify(stored)).not.toContain('test-key')

      // Same versions, same key: nothing more to report; the check is shown.
      const second = (await (await status.handler(request())).json()) as Record<string, any>
      expect(second.keyCheck).toMatchObject({ httpStatus: 200, status: 'ok' })
      expect(second.keyCheck).not.toHaveProperty('fingerprint')
      await new Promise((r) => setTimeout(r, 50))
      expect(fake.reports).toHaveLength(1)
    })

    it('reports a rejected key after a 401 from a translation', async () => {
      const page = await payload.create({ collection: 'pages', data: { title: 'Key' }, locale: 'en' })
      const fake = fakeSupertext({ failStatus: 401 })
      vi.stubGlobal('fetch', fake.fetch)
      vi.stubEnv('SUPERTEXT_REPORT_URL', 'https://center.test/api/v1/report')
      const res = await endpoint('post', '/supertext/translate').handler(
        request({ json: async () => ({ collection: 'pages', id: page.id, sourceLocale: 'en', targetLocales: ['de-CH'] }) }),
      )
      expect(res.status).toBe(502)
      await vi.waitFor(() => expect(fake.reports.map((r) => r.event)).toContain('api_key_check'))
      expect(fake.reports.at(-1)).toMatchObject({ api_key_check: { http_status: 401, status: 'invalid' } })
    })

    it('checks the key again on request', async () => {
      const fake = fakeSupertext()
      vi.stubGlobal('fetch', fake.fetch)
      vi.stubEnv('SUPERTEXT_REPORT_URL', 'https://center.test/api/v1/report')
      const res = await endpoint('post', '/supertext/check-key').handler(request())
      expect(await res.json()).toMatchObject({ keyCheck: { status: 'ok' } })
      expect(fake.calls.map((c) => `${c.method} ${c.url}`)).toContain('GET https://api.supertext.com/v1/features')
      expect(fake.reports.at(-1)).toMatchObject({ api_key_check: { status: 'ok' }, event: 'api_key_check' })
      expect((await endpoint('post', '/supertext/check-key').handler({ ...(request() as object), user: null } as never)).status).toBe(401)
    })

    it('sends nothing with reports off, but still checks the key', async () => {
      const fake = fakeSupertext()
      vi.stubGlobal('fetch', fake.fetch)
      vi.stubEnv('SUPERTEXT_REPORT_URL', 'https://center.test/api/v1/report')
      vi.stubEnv('SUPERTEXT_VERSION_REPORTS', '0')
      const res = await endpoint('post', '/supertext/check-key').handler(request())
      expect(await res.json()).toMatchObject({ keyCheck: { status: 'ok' } })
      const status = (await (await endpoint('get', '/supertext/status').handler(request())).json()) as Record<string, any>
      expect(status.reports).toEqual({ enabled: false, pingUrl: null })
      await new Promise((r) => setTimeout(r, 50))
      expect(fake.reports).toHaveLength(0)
    })
  })
})
