#!/usr/bin/env node
/**
 * End-to-end test against the REAL Supertext API: a fresh demo (nothing translated yet)
 * with a real SUPERTEXT_API_KEY. The editor opens every page and the Header global in the
 * admin, clicks Translate, picks every other locale and translates; then Payload's REST API
 * is checked: every document has its fields in each target locale, the text is really in
 * the target language (de-CH without "ß"), bold text and links survived, nothing of the
 * HTML protocol is left, the translation is a draft (the published version is unchanged),
 * and translating again updates the same documents and rows instead of duplicating them.
 * See "End-to-end tests" in docs/DEVELOPER.md.
 *
 *   BASE_URL=http://127.0.0.1:3001 EDITOR_EMAIL=… EDITOR_PASSWORD=… node test/e2e/live.mjs
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const B = (process.env.BASE_URL ?? 'http://127.0.0.1:3001').replace(/\/$/, '')
const SOURCE = process.env.SOURCE_LOCALE ?? 'en'
const need = (name) => process.env[name] || (() => { throw new Error(`Set ${name}`) })()
const artifacts = fileURLToPath(new URL('./artifacts/', import.meta.url))
mkdirSync(artifacts, { recursive: true })

const failures = []
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  return ok
}
const note = (text) => console.log(`note ${text}`)

// Common words, to tell the target languages apart. Lower case, whole words.
const STOPWORDS = {
  en: ['the', 'and', 'is', 'are', 'with', 'for', 'you', 'your', 'our', 'of', 'to', 'we', 'who', 'what'],
  de: ['der', 'die', 'das', 'und', 'ist', 'sind', 'mit', 'für', 'sie', 'ihre', 'ihr', 'unser', 'unsere', 'wir', 'eine', 'ein', 'den', 'zu', 'von', 'was'],
  fr: ['le', 'les', 'et', 'est', 'sont', 'avec', 'pour', 'vous', 'votre', 'vos', 'notre', 'nos', 'nous', 'des', 'une', 'un', 'du', 'de', 'qui', 'que'],
  it: ['il', 'lo', 'gli', 'e', 'è', 'sono', 'con', 'per', 'lei', 'sua', 'suo', 'nostro', 'nostra', 'noi', 'una', 'un', 'del', 'della', 'di', 'che', 'chi'],
}
const words = (text) => text.toLowerCase().match(/[\p{L}]+/gu) ?? []
const score = (text, lang) => words(text).filter((w) => STOPWORDS[lang].includes(w)).length

const LEFTOVERS = ['data-st-id', 'data-st-ph', 'st-ph-', 'data-n=']
// Keys that are never translated (non-localized, technical or URLs).
const SKIP = new Set(['id', 'blockType', 'blockName', 'slug', '_status', 'createdAt', 'updatedAt', 'globalType', 'internalNote', 'href', 'buttonUrl', 'url'])

/** Lexical editor state → plain text and what must survive (bold, italics, links, paragraphs). */
function lexical(state) {
  const out = { text: '', bold: 0, italic: 0, links: [], blocks: 0 }
  const walk = (node) => {
    if (node.type === 'text') {
      out.text += node.text
      if (node.format & 1) out.bold++
      if (node.format & 2) out.italic++
    }
    if (node.type === 'link' || node.type === 'autolink') out.links.push(node.fields?.url ?? '')
    if (['paragraph', 'heading', 'listitem', 'quote'].includes(node.type)) out.blocks++
    for (const child of node.children ?? []) walk(child)
    if (['paragraph', 'heading', 'listitem', 'quote'].includes(node.type)) out.text += '\n'
  }
  walk(state.root)
  return out
}

/** Translatable fields of a document: path → { rich, value }. Non-localized rows keep their index. */
function fieldsOf(doc) {
  const out = new Map()
  const walk = (value, path) => {
    if (value === null || value === undefined) return
    if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${path}[${i}]`))
    if (typeof value === 'object') {
      if (value.root && typeof value.root === 'object') return out.set(path, { rich: true, value })
      for (const [k, v] of Object.entries(value)) if (!SKIP.has(k)) walk(v, path ? `${path}.${k}` : k)
      return
    }
    if (typeof value === 'string' && value.trim()) out.set(path, { rich: false, value })
  }
  walk(doc, '')
  return out
}
const plainOf = (f) => (f.rich ? lexical(f.value).text : f.value)
/** Row ids of all (non-localized) arrays and blocks, to see whether rows were duplicated or replaced. */
function rowIds(doc) {
  const ids = []
  const walk = (value) => {
    if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === 'object' && !value.root) {
      if (typeof value.id === 'string') ids.push(value.id)
      Object.values(value).forEach(walk)
    }
  }
  walk(doc.layout ?? doc.nav ?? [])
  return ids.join(',')
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, locale: 'en-US' })
const page = await context.newPage()
page.setDefaultTimeout(60_000)
const api = async (path) => {
  const res = await page.request.get(`${B}/api/${path}`)
  if (!res.ok()) throw new Error(`GET /api/${path}: HTTP ${res.status()}`)
  return res.json()
}

// --- Log in as the editor ----------------------------------------------------------------
await page.goto(`${B}/admin/login`)
await page.fill('input[name=email]', need('EDITOR_EMAIL'))
await page.fill('input[name=password]', need('EDITOR_PASSWORD'))
await page.click('button[type=submit]')
const loggedIn = await page.waitForURL(/\/admin\/?$/, { timeout: 60_000 }).then(() => true, () => false)
if (!check('editor can log in (DEMO_EDITOR_*)', loggedIn)) {
  await page.screenshot({ path: `${artifacts}login.png` })
  await browser.close()
  process.exit(1)
}

// --- Setup -------------------------------------------------------------------------------
const status = await api('supertext/status')
check('API key configured in the demo', status.apiKeyConfigured)
check('editor may translate', status.canTranslate)
const targets = status.locales.filter((l) => l !== SOURCE)
for (const l of status.languages.filter((x) => x.locale !== SOURCE)) {
  check(`${l.locale} is mapped to a Supertext language`, Boolean(l.supertext), String(l.supertext))
}
const q = (locale, draft = true) => `locale=${encodeURIComponent(locale)}&fallback-locale=none&depth=0${draft ? '&draft=true' : ''}`
const sourcePages = (await api(`pages?${q(SOURCE)}&limit=100&sort=createdAt`)).docs
const items = [
  ...sourcePages.map((p) => ({ label: `page "${p.title}"`, url: `${B}/admin/collections/pages/${p.id}`, get: (locale, draft) => api(`pages/${p.id}?${q(locale, draft)}`), drafts: true })),
  { label: 'global Header', url: `${B}/admin/globals/header`, get: (locale) => api(`globals/header?${q(locale)}`), drafts: false },
]
const source = new Map()
for (const item of items) source.set(item, await item.get(SOURCE, true))
console.log(`Source (${SOURCE}): ${sourcePages.length} pages and the Header global; targets: ${targets.join(', ')}`)
check('demo has sample pages', sourcePages.length > 0)
check('demo has target locales', targets.length > 0)
let fresh = true
for (const item of items) for (const locale of targets) {
  const fields = fieldsOf(await item.get(locale, true))
  if (fields.size) fresh = false
}
check('fresh demo (nothing translated yet)', fresh)

// --- Translate through the admin ----------------------------------------------------------
async function translateInAdmin(run, item, index) {
  const tag = `${run}: ${item.label}`
  await page.goto(`${item.url}?locale=${SOURCE}`)
  const button = page.getByRole('button', { name: /^Translate$/ })
  await button.waitFor()
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
  await button.click()
  const dialog = page.getByRole('dialog', { name: 'Translate with Supertext' })
  await dialog.waitFor()
  for (const locale of targets) {
    const box = dialog.locator('label', { hasText: `(${locale})` }).locator('input[type=checkbox]')
    const usable = (await box.count()) === 1 && !(await box.isDisabled())
    check(`${tag}: ${locale} can be chosen`, usable)
    if (usable) await box.check()
  }
  const go = dialog.getByRole('button', { name: /^Translate into/ })
  if (!check(`${tag}: Translate button enabled`, await go.isEnabled(), (await dialog.innerText()).replace(/\s+/g, ' '))) return
  const started = Date.now()
  await go.click()
  const toasts = page.locator('[data-sonner-toast]')
  await toasts.first().waitFor({ timeout: 900_000 })
  await page.waitForTimeout(1000)
  await page.screenshot({ path: `${artifacts}${run}-${index}.png`, fullPage: true })
  const shown = []
  for (const t of await toasts.all()) {
    const type = (await t.getAttribute('data-type')) ?? ((await t.getAttribute('class')) ?? '').match(/toast-(\w+)/)?.[1] ?? '?'
    shown.push({ type, text: (await t.innerText()).replace(/\s+/g, ' ').trim() })
  }
  console.log(`${tag}: ${Math.round((Date.now() - started) / 1000)} s`)
  const errors = shown.filter((t) => t.type === 'error' || t.type === 'warning')
  check(`${tag}: no error message`, errors.length === 0, errors.map((e) => e.text).join(' | '))
  const success = shown.find((t) => t.type === 'success' && /Translated into/.test(t.text))
  check(`${tag}: success message`, Boolean(success), shown.map((t) => `${t.type}: ${t.text}`).join(' | '))
  if (success) check(`${tag}: no passage came back empty`, !/came back empty/.test(success.text), success.text)
}

let i = 0
for (const item of items) await translateInAdmin('first-run', item, i++)

// --- Check the result -----------------------------------------------------------------------
// Ratio of changed fields and the language are judged per locale over all documents: a small
// document (the Header: "Home", a slogan) can't tell the language on its own.
const first = new Map()
const perLocale = Object.fromEntries(targets.map((l) => [l, { fields: 0, changed: 0, text: '' }]))
for (const item of items) {
  const src = source.get(item)
  const srcFields = fieldsOf(src)
  for (const locale of targets) {
    const tag = `${item.label} (${locale})`
    const doc = await item.get(locale, true)
    first.set(`${item.label}|${locale}`, doc)
    const fields = fieldsOf(doc)
    const json = JSON.stringify(doc)
    const left = LEFTOVERS.filter((l) => json.includes(l))
    check(`${tag}: no protocol leftovers`, left.length === 0, left.join(', '))
    let changed = 0
    let text = ''
    for (const [path, s] of srcFields) {
      const t = fields.get(path)
      const value = t ? plainOf(t).trim() : ''
      if (!check(`${tag}: ${path} filled`, value !== '')) continue
      text += ` ${value}`
      if (value !== plainOf(s).trim()) changed++
      else note(`${tag}: ${path} unchanged ("${value}")`)
      if (!t.rich) {
        check(`${tag}: ${path} has no HTML tags`, !/<\/?(b|i|u|s|a|p|span|br)\b/i.test(value), value)
        continue
      }
      const a = lexical(s.value)
      const b = lexical(t.value)
      check(`${tag}: ${path} keeps its paragraphs`, a.blocks === b.blocks, `${b.blocks}/${a.blocks}`)
      if (a.bold) check(`${tag}: ${path} keeps its bold text`, a.bold === b.bold, `${b.bold}/${a.bold}`)
      if (a.italic) check(`${tag}: ${path} keeps its italics`, a.italic === b.italic, `${b.italic}/${a.italic}`)
      if (a.links.length) check(`${tag}: ${path} keeps its links`, a.links.join(' ') === b.links.join(' '), `${b.links.join(' ')} / ${a.links.join(' ')}`)
    }
    perLocale[locale].fields += srcFields.size
    perLocale[locale].changed += changed
    perLocale[locale].text += text
    for (const key of ['slug', 'internalNote']) {
      if (src[key] !== undefined) check(`${tag}: non-localized ${key} unchanged`, doc[key] === src[key], `${doc[key]}`)
    }
    if (/^de-ch$/i.test(locale)) check(`${tag}: Swiss German spelling (no "ß")`, !text.includes('ß'))
    if (item.drafts) {
      // The plugin saves translations as drafts: the published version has nothing in this locale yet.
      const published = await item.get(locale, false)
      check(`${tag}: translation is a draft, not published`, fieldsOf(published).size === 0, [...fieldsOf(published).keys()].join(', '))
    }
  }
}

for (const [locale, { fields, changed, text }] of Object.entries(perLocale)) {
  const lang = locale.split(/[-_]/)[0].toLowerCase()
  check(`${locale}: texts were changed by the translation`, fields > 0 && changed / fields >= 0.8, `${changed}/${fields} fields`)
  if (STOPWORDS[lang]) {
    const scores = Object.fromEntries(Object.keys(STOPWORDS).map((l) => [l, score(text, l)]))
    const best = Object.entries(scores).sort((x, y) => y[1] - x[1])[0][0]
    check(`${locale}: text is in the target language`, best === lang, JSON.stringify(scores))
  }
}

// --- Translating again updates in place ---------------------------------------------------
const pagesBefore = (await api('pages?limit=0')).totalDocs
for (const item of items) await translateInAdmin('second-run', item, i++)
check('translating again creates no new pages', (await api('pages?limit=0')).totalDocs === pagesBefore, `${pagesBefore} → ${(await api('pages?limit=0')).totalDocs}`)
for (const item of items) {
  for (const locale of targets) {
    const tag = `${item.label} (${locale})`
    const before = first.get(`${item.label}|${locale}`)
    const after = await item.get(locale, true)
    check(`${tag}: translating again updates the same document`, after.id === before.id || item.drafts === false, `${before.id} → ${after.id}`)
    check(`${tag}: translating again keeps the same rows (no duplicates)`, rowIds(after) === rowIds(before), `${rowIds(before)} → ${rowIds(after)}`)
    const a = [...fieldsOf(before).keys()].join(',')
    const b = [...fieldsOf(after).keys()].join(',')
    check(`${tag}: translating again keeps the same fields`, a === b, `${fieldsOf(before).size} → ${fieldsOf(after).size}`)
  }
}

await browser.close()

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log('\nAll end-to-end checks passed.')
