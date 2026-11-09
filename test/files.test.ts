import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { buildConfig, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { formatReference, MAX_UPLOAD_BYTES, parseReference, readUpload } from '../src/files.js'
import { supertextTranslation } from '../src/index.js'
import type { FileImportJob, SupertextTranslationOptions } from '../src/types.js'
import { TranslationFiles } from '../src/vendor/supertext-sdk/index.js'

const options: SupertextTranslationOptions = {
  apiKey: 'test-key',
  collections: ['pages'],
  globals: ['header'],
  languageMap: { fr: 'fr-FR' },
}

let payload: Payload

const text = (t: string, format = 0) => ({ detail: 0, format, mode: 'normal', style: '', text: t, type: 'text', version: 1 })
const lexical = (...children: object[]) => ({
  root: {
    children: [{ children, direction: 'ltr', format: '', indent: 0, type: 'paragraph', version: 1 }],
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
          { localized: true, name: 'subtitle', type: 'text' },
          { name: 'code', type: 'text' },
          { localized: true, name: 'body', type: 'richText' },
          { fields: [{ localized: true, name: 'label', type: 'text' }], name: 'links', type: 'array' },
        ],
        slug: 'pages',
        versions: { drafts: true },
      },
      { fields: [{ localized: true, name: 'title', type: 'text' }], slug: 'other' },
    ],
    db: sqliteAdapter({ client: { url: ':memory:' } }),
    editor: lexicalEditor(),
    globals: [{ fields: [{ localized: true, name: 'tagline', type: 'text' }], slug: 'header' }],
    localization: { defaultLocale: 'en', locales: ['en', 'fr', 'de-CH', 'de-LI'] },
    plugins: [supertextTranslation(options)],
    secret: 'test-secret',
    telemetry: false,
  })
  payload = await getPayload({ config })
}, 60_000)

afterAll(async () => {
  await payload?.destroy()
})

const endpoint = (path: string) => payload.config.endpoints.find((e) => e.path === path)!
const user = { id: 1 }

async function exportFile(body: Record<string, unknown>) {
  const res = await endpoint('/supertext/export').handler({ headers: new Headers(), json: async () => body, payload, user } as never)
  return { body: await res.text(), headers: res.headers, status: res.status }
}

async function importFile(content: string, includeChanged = false, headers: Record<string, string> = {}) {
  const res = await endpoint('/supertext/import').handler({
    body: new Blob([content]).stream(),
    headers: new Headers(headers),
    payload,
    searchParams: new URLSearchParams(includeChanged ? 'includeChanged=1' : ''),
    user,
  } as never)
  return { body: (await res.json()) as { error?: string; jobs?: FileImportJob[] }, status: res.status }
}

/** Translates every unit of an XLIFF file: `<target>` = fn(source content), inline codes kept. */
const translateXliff = (xliff: string, fn: (source: string, id: string) => string | null) =>
  xliff.replace(/<trans-unit id="([^"]+)"([^>]*)>\s*<source>([\s\S]*?)<\/source>/g, (all, id: string, attrs: string, source: string) => {
    const target = fn(source, id)
    return target === null ? all : `<trans-unit id="${id}"${attrs}>\n        <source>${source}</source><target>${target}</target>`
  })

const readPage = (id: number | string, locale: string) =>
  payload.findByID({ collection: 'pages', draft: true, fallbackLocale: false as never, id, locale: locale as never })

async function createPage(data: Record<string, unknown> = {}) {
  return payload.create({
    collection: 'pages',
    data: {
      body: lexical(text('Hello '), text('bold', 1), text(' world')) as never,
      code: 'P-1',
      links: [{ label: 'Home' }],
      title: 'Home page',
      ...data,
    },
    locale: 'en',
  })
}

describe('references', () => {
  it('round-trip collection and global references', () => {
    const page = { collection: 'pages', id: '12', kind: 'collection', sourceLocale: 'en', targetLocale: 'de-CH' } as const
    expect(formatReference(page)).toBe('collection:pages:12:en:de-CH')
    expect(parseReference(formatReference(page))).toEqual(page)
    const header = { global: 'header', kind: 'global', sourceLocale: 'en', targetLocale: 'fr' } as const
    expect(parseReference(formatReference(header))).toEqual(header)
    const odd = { collection: 'pages', id: 'a:b', kind: 'collection', sourceLocale: 'en', targetLocale: 'fr' } as const
    expect(parseReference(formatReference(odd))).toEqual(odd)
  })

  it.each(['', 'page:12', 'collection:pages:12:en', 'global::en:fr', 'collection:pages:%E0:en:fr'])('refuses %j', (ref) => {
    expect(parseReference(ref)).toBeNull()
  })
})

describe('POST /api/supertext/export', () => {
  it('exports XLIFF with the collector keys and the mapped languages', async () => {
    const page = await createPage()
    const res = await exportFile({ collection: 'pages', format: 'xliff', id: page.id, sourceLocale: 'en', targetLocales: ['fr', 'de-LI'] })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/x-xliff+xml')
    expect(res.headers.get('Content-Disposition')).toBe(`attachment; filename="payload-pages-${page.id}.xlf"`)
    const files = TranslationFiles.read(res.body)
    expect(files.map((f) => [f.plugin, f.reference, f.sourceLanguage, f.targetLanguage])).toEqual([
      ['Payload-Supertext-Translation', `collection:pages:${page.id}:en:fr`, 'en', 'fr-FR'],
      // No Supertext language for de-LI: the Payload code, so the file can still go to a translator.
      ['Payload-Supertext-Translation', `collection:pages:${page.id}:en:de-LI`, 'en', 'de-LI'],
    ])
    expect(files[0]!.units.map((u) => u.key)).toEqual(['title', 'body.root.0', 'links.0.label'])
    expect(res.body).toContain('<bpt id="1">')
  })

  it('exports HTML for exactly one target', async () => {
    const page = await createPage()
    const res = await exportFile({ collection: 'pages', format: 'html', id: page.id, sourceLocale: 'en', targetLocales: ['de-CH'] })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('Content-Disposition')).toBe(`attachment; filename="payload-pages-${page.id}-de-CH.html"`)
    expect(res.body).toContain('<meta name="supertext:target-language" content="de-CH">')

    const two = await exportFile({ collection: 'pages', format: 'html', id: page.id, sourceLocale: 'en', targetLocales: ['de-CH', 'fr'] })
    expect(two.status).toBe(400)
  })

  it('exports a global and says when there is nothing to translate', async () => {
    const empty = await exportFile({ format: 'xliff', global: 'header', sourceLocale: 'en', targetLocales: ['fr'] })
    expect(empty.status).toBe(422)
    expect(JSON.parse(empty.body).error).toBe('Nothing to translate.')

    await payload.updateGlobal({ data: { tagline: 'Fresh cheese' }, locale: 'en', slug: 'header' })
    const res = await exportFile({ format: 'xliff', global: 'header', sourceLocale: 'en', targetLocales: ['fr'] })
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="payload-header-fr.xlf"')
    expect(TranslationFiles.read(res.body)[0]!.reference).toBe('global:header:en:fr')
  })

  it('requires a user and an enabled collection', async () => {
    const res = await endpoint('/supertext/export').handler({ headers: new Headers(), json: async () => ({}), payload, user: null } as never)
    expect(res.status).toBe(401)
    expect((await exportFile({ collection: 'other', format: 'xliff', id: 1, sourceLocale: 'en', targetLocales: ['fr'] })).status).toBe(400)
  })
})

describe('POST /api/supertext/import', () => {
  it('writes translated XLIFF back like an API translation (draft, structure kept)', async () => {
    const page = await createPage()
    const { body } = await exportFile({ collection: 'pages', format: 'xliff', id: page.id, sourceLocale: 'en', targetLocales: ['fr', 'de-CH'] })
    const res = await importFile(translateXliff(body, (source) => `[t] ${source}`))
    expect(res.status).toBe(200)
    expect(res.body.jobs).toEqual([
      { imported: 3, invalid: 0, item: `pages ${page.id}`, missing: 0, sourceChanged: 0, targetLocale: 'fr', untranslated: 0 },
      { imported: 3, invalid: 0, item: `pages ${page.id}`, missing: 0, sourceChanged: 0, targetLocale: 'de-CH', untranslated: 0 },
    ])
    const fr = await readPage(page.id, 'fr')
    expect(fr.title).toBe('[t] Home page')
    expect(fr.links?.[0]?.label).toBe('[t] Home')
    const body0 = (fr.body as any).root.children[0].children
    expect(body0.map((n: any) => [n.text, n.format])).toEqual([['[t] Hello ', 0], ['bold', 1], [' world', 0]])
    expect(fr.code).toBe('P-1')
    expect((await readPage(page.id, 'de-CH')).title).toBe('[t] Home page')
    expect((await readPage(page.id, 'en')).title).toBe('Home page')
  })

  it('writes texts whose source changed only with the option', async () => {
    const page = await createPage()
    const { body } = await exportFile({ collection: 'pages', format: 'xliff', id: page.id, sourceLocale: 'en', targetLocales: ['fr'] })
    const translated = translateXliff(body, (source) => `FR ${source}`)
    await payload.update({ collection: 'pages', data: { title: 'Home page, new' }, id: page.id, locale: 'en' })

    const skipped = await importFile(translated)
    expect(skipped.body.jobs?.[0]).toMatchObject({ imported: 2, sourceChanged: 1 })
    // fr had no title yet: like an API translation, the untranslated place gets the source text.
    expect((await readPage(page.id, 'fr')).title).toBe('Home page, new')

    const included = await importFile(translated, true)
    expect(included.body.jobs?.[0]).toMatchObject({ imported: 3, sourceChanged: 0 })
    expect((await readPage(page.id, 'fr')).title).toBe('FR Home page')
  })

  it("doesn't write untranslated, invalid or missing segments and keeps the target's own text", async () => {
    const page = await createPage({ subtitle: 'Fresh daily' })
    await payload.update({ collection: 'pages', data: { subtitle: 'Frais', title: 'Accueil' }, draft: true, id: page.id, locale: 'fr' })
    const { body } = await exportFile({ collection: 'pages', format: 'xliff', id: page.id, sourceLocale: 'en', targetLocales: ['fr'] })
    const file = translateXliff(body, (source, id) =>
      id === 'title' ? null : id === 'body.root.0' ? 'Bonjour <bpt id="9">&lt;i&gt;</bpt>x<ept id="9">&lt;/i&gt;</ept>' : `FR ${source}`,
    ).replace(/<trans-unit id="subtitle"[\s\S]*?<\/trans-unit>/, '')
    const res = await importFile(file)
    expect(res.body.jobs?.[0]).toMatchObject({ imported: 1, invalid: 1, missing: 1, sourceChanged: 0, untranslated: 1 })
    const fr = await readPage(page.id, 'fr')
    expect(fr.title).toBe('Accueil')
    expect(fr.subtitle).toBe('Frais')
    expect(fr.links?.[0]?.label).toBe('FR Home')
  })

  it('imports an HTML file; markup the source lacks is refused', async () => {
    const page = await createPage()
    const { body } = await exportFile({ collection: 'pages', format: 'html', id: page.id, sourceLocale: 'en', targetLocales: ['de-CH'] })
    const translated = body.replace('>Home page<', '>Startseite<').replace('Hello <b data-n="0">bold</b> world', 'Hallo <b data-n="0">fett</b> Welt')
    const res = await importFile(translated)
    expect(res.body.jobs?.[0]).toMatchObject({ imported: 3, invalid: 0, targetLocale: 'de-CH' })
    const de = await readPage(page.id, 'de-CH')
    expect(de.title).toBe('Startseite')
    expect(JSON.stringify(de.body)).toContain('fett')

    const script = await importFile(body.replace('Hello <b data-n="0">bold</b> world', 'Hallo <script>alert(1)</script> Welt'))
    expect(script.body.jobs?.[0]).toMatchObject({ imported: 2, invalid: 1 })
    expect(JSON.stringify((await readPage(page.id, 'de-CH')).body)).not.toContain('alert')
  })

  it('refuses files of other systems, unknown items and missing locales', async () => {
    const page = await createPage()
    const job = (plugin: string, reference: string) => ({
      plugin,
      reference,
      segments: [{ key: 'title', text: 'Home page' }],
      sourceLanguage: 'en',
      targetLanguage: 'fr-FR',
    })
    const file = translateXliff(
      TranslationFiles.exportXliff([
        job('Strapi-Supertext-Translation', 'x'),
        job('Payload-Supertext-Translation', 'page:12'),
        job('Payload-Supertext-Translation', 'collection:pages:999999:en:fr'),
        job('Payload-Supertext-Translation', `collection:pages:${page.id}:en:it`),
        job('Payload-Supertext-Translation', `collection:other:${page.id}:en:fr`),
        job('Payload-Supertext-Translation', `collection:pages:${page.id}:en:fr`),
      ]),
      (s) => `FR ${s}`,
    )
    const res = await importFile(file)
    expect(res.body.jobs?.map((j) => j.error ?? `imported ${j.imported}`)).toEqual([
      'This file belongs to another system (Strapi-Supertext-Translation).',
      'The document this file was exported from no longer exists.',
      'The document this file was exported from no longer exists.',
      'The site has no language it.',
      'The document this file was exported from no longer exists.',
      'imported 1',
    ])
  })

  it('reports unreadable files and refuses uploads over 10 MB', async () => {
    expect(await importFile('hello')).toEqual({ body: { error: "This file isn't a valid XLIFF or HTML translation file." }, status: 422 })
    expect((await importFile('<!DOCTYPE html><html><head></head><body></body></html>')).body.error).toContain('header was removed')
    const big = await importFile('<xliff/>', false, { 'content-length': String(MAX_UPLOAD_BYTES + 1) })
    expect(big).toEqual({ body: { error: 'The file is too large (at most 10 MB).' }, status: 413 })
    await expect(readUpload({ body: new Blob([new Uint8Array(MAX_UPLOAD_BYTES + 1)]).stream(), headers: new Headers() })).rejects.toThrow('too_large')
    const res = await endpoint('/supertext/import').handler({ headers: new Headers(), payload, user: null } as never)
    expect(res.status).toBe(401)
  })
})
