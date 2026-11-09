#!/usr/bin/env node
/**
 * Records the install and configuration movie (a narrated MP4 that isn't committed) with the shared
 * Supertext movie kit (movie/movie-kit.mjs): the install steps from docs/INSTALLATION.md in a terminal
 * (npm install, the plugin in payload.config.ts, import map, migration, SUPERTEXT_API_KEY), then, as the
 * demo's administrator, the Supertext panel on the dashboard (key check), Supertext → Supertext settings
 * (language mapping) and the Translate button on a page. Run it against a demo whose plugin talks to
 * stand-in.mjs. See docs/DEVELOPER.md -> Demo movie.
 *
 *   BASE_URL=http://localhost:3000 DEMO_ADMIN_EMAIL=… DEMO_ADMIN_PASSWORD=… npm run movie:install
 *
 * MOVIE_OUT: where the MP4 goes (default test/docs/movie/out/Payload-Supertext-Translation-install.mp4, git-ignored).
 * CHROMIUM_PATH: a Chromium to use instead of Playwright's own.
 */
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MovieKit } from './movie/movie-kit.mjs'

const B = process.env.BASE_URL || 'http://localhost:3000'
const need = (name) => process.env[name] || (() => { throw new Error(`Set ${name}`) })()
const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const mp4 = process.env.MOVIE_OUT || here('movie/out/Payload-Supertext-Translation-install.mp4')
const workDir = mkdtempSync(join(tmpdir(), 'payload-install-movie-'))

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, locale: 'en-US' })
page.setDefaultTimeout(120_000)
// Hide the Next.js dev badge and the account avatar (Gravatar); show the live demo's address instead of a local one.
await page.addInitScript(() => {
  const local = /https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/g
  const fix = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (local.test(n.textContent)) n.textContent = n.textContent.replace(local, 'https://payload-production-cfd2.up.railway.app')
      local.lastIndex = 0
    }
  }
  const add = () => {
    const s = document.createElement('style')
    s.textContent = 'nextjs-portal{display:none!important} a[href$="/admin/account"] img{visibility:hidden}'
    document.head.appendChild(s)
    new MutationObserver(() => document.body && fix(document.body)).observe(document, { subtree: true, childList: true, characterData: true })
  }
  if (document.head) add()
  else document.addEventListener('DOMContentLoaded', add)
})

// Sign in as the administrator (not recorded).
await page.goto(`${B}/admin/login`)
await page.fill('input[name=email]', need('DEMO_ADMIN_EMAIL'))
await page.fill('input[name=password]', need('DEMO_ADMIN_PASSWORD'))
await page.click('button[type=submit]')
await page.waitForURL(/\/admin\/?$/)
const res = await page.request.get(`${B}/api/pages?where[slug][equals]=home&locale=en&limit=1`)
const id = (await res.json()).docs[0].id

const kit = await MovieKit.start(page, { workDir, assets: here('movie/assets'), voiceCache: here('movie/voice') })

// 1. Install (docs/INSTALLATION.md → Install).
await kit.say('In your Payload project, install the plugin from GitHub with npm.', {
  caption: 'Install the plugin with <b>npm</b>',
  during: () => kit.terminal({
    title: 'my-site',
    lines: [
      { cmd: 'npm install github:Supertext/Payload-Supertext-Translation' },
      { out: 'added 9 packages, and audited 412 packages in 11s', wait: 400 },
      { out: 'found 0 vulnerabilities' },
    ],
  }),
})
await kit.say('Add supertextTranslation to the plugins in payload.config.ts, with the collections and globals to translate. The languages are your Payload locales.', {
  caption: 'Add the plugin to <b>payload.config.ts</b>',
  during: () => kit.terminal({
    title: 'my-site',
    lines: [
      { cmd: 'cat src/payload.config.ts' },
      { out: "import { supertextTranslation } from 'payload-supertext-translation'" },
      { out: 'export default buildConfig({' },
      { out: '  localization: {' },
      { out: "    defaultLocale: 'en', locales: ['en', 'de-CH', 'fr-CH', 'it-CH']," },
      { out: '  },' },
      { out: '  plugins: [supertextTranslation({' },
      { out: "    collections: ['pages', 'posts']," },
      { out: "    globals: ['header', 'footer']," },
      { out: '  })],' },
      { out: '})' },
    ],
  }),
})
await kit.say('Regenerate the import map, and create a migration for the Supertext settings.', {
  caption: 'Regenerate the <b>import map</b>, create a <b>migration</b>',
  during: () => kit.terminal({
    title: 'my-site',
    lines: [
      { cmd: 'npx payload generate:importmap' },
      { out: 'Generating import map' },
      { out: 'Writing import map to src/app/(payload)/admin/importMap.js' },
      { cmd: 'npx payload migrate:create supertext_settings' },
      { out: 'INFO: Migration created at src/migrations/20261108_143012_supertext_settings.ts' },
    ],
  }),
})
await kit.say('Set your Supertext API key as SUPERTEXT_API_KEY, and restart Payload.', {
  caption: 'Set <b>SUPERTEXT_API_KEY</b> and restart Payload',
  during: () => kit.terminal({
    title: 'my-site',
    lines: [
      { cmd: "echo 'SUPERTEXT_API_KEY=st-demo-0000-0000-0000' >> .env" },
      { cmd: 'npm run dev' },
      { out: '▲ Next.js 16.4.3', wait: 300 },
      { out: '✓ Ready in 2.4s' },
    ],
  }),
})

await kit.say('Generate your API key at supertext.com, Integrations, API. No account yet? Create one at supertext.com.', {
  caption: 'API key: <b>supertext.com → Integrations → API</b>',
})

/** Opens a page without recording the loading. */
const open = async (path, ready) => {
  kit.pause()
  await page.goto(B + path)
  await ready()
  await page.waitForTimeout(1200)
  kit.resume()
}
const scrollTo = async (locator, block = 'center') => {
  await locator.evaluate((el, block) => el.scrollIntoView({ block, behavior: 'smooth' }), block)
  await page.waitForTimeout(900)
}

// 2. The Supertext panel on the dashboard: the key check.
const panel = page.locator('section.supertext-status')
await open('/admin', () => panel.getByText('API key checked').waitFor())
await kit.say('Sign in as an administrator. The Supertext panel on the dashboard shows the API key check.', {
  caption: 'The <b>Supertext</b> panel on the dashboard',
  during: async () => {
    await scrollTo(panel.getByText('API key', { exact: true }).first(), 'start')
    await kit.moveTo(panel.getByText('API key checked').first())
  },
})
await kit.say('Click Check again. The connection to Supertext works.', {
  caption: '<b>Check again</b>: the connection to Supertext works',
  during: async () => {
    await kit.click(panel.getByRole('button', { name: 'Check again' }))
    await panel.getByText('API key checked').waitFor()
    await kit.moveTo(panel.getByText('API key checked').first())
  },
})

// 3. Supertext settings: the language mapping.
await kit.say('Then open Supertext settings, under Supertext in the menu.', {
  caption: '<b>Supertext → Supertext settings</b>',
  during: async () => {
    await scrollTo(page.locator('body'), 'start')
    await kit.click(page.locator('.nav-toggler, button[aria-label*="navigation" i]').filter({ visible: true }).first())
    await page.waitForTimeout(500)
    await kit.click(page.locator('nav a[href$="/admin/globals/supertext-settings"]').filter({ visible: true }).first())
  },
})
kit.pause()
await page.getByText('Language mapping').first().waitFor()
await page.waitForTimeout(800)
kit.resume()
const mapping = page.locator('.field-type.group-field').first()
const german = mapping.locator('.react-select').nth(1)
await kit.say('Each Payload locale gets a Supertext language. For German, choose Swiss High German.', {
  caption: 'German → <b>Swiss High German (de-CH)</b>',
  during: async () => {
    await kit.click(german)
    await page.waitForTimeout(300)
    await page.keyboard.type('Swiss High', { delay: 90 })
    await page.waitForTimeout(500)
    await kit.click(page.locator('.rs__option').filter({ hasText: 'Swiss High German (de-CH)' }).first())
  },
})
await kit.say('Translation review can be ticked for each language. Leave it off for now.', {
  caption: '<b>Translation review</b>: optional, per language',
  during: () => kit.moveTo(mapping.getByText('Translation review', { exact: true }).nth(1)),
})
await kit.say('Click Save.', {
  caption: 'Click <b>Save</b>',
  during: async () => {
    await kit.click(page.getByRole('button', { name: 'Save', exact: true }).first())
  },
})
kit.pause()
const saved = page.locator('[data-sonner-toast]').filter({ hasNotText: 'Submitting' }).first()
await saved.waitFor()
const sb = await saved.boundingBox()
await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2) // keeps the toast while the next line is made
await page.waitForTimeout(300)
kit.resume()
await kit.say('Saved. The next translation uses the new mapping.', { caption: 'Saved: the next translation uses it', during: () => kit.moveTo(saved) })

// 4. Where editors find it.
await open(`/admin/collections/pages/${id}?locale=en`, () => page.getByRole('button', { name: /^Translate$/ }).waitFor())
await kit.say('Done. Editors now find Translate next to Save and Publish, on every collection and global you listed.', {
  caption: 'Editors find <b>Translate</b> next to Save and Publish',
  during: () => kit.moveTo(page.getByRole('button', { name: /^Translate$/ })),
})
await kit.caption('')

await kit.finish(mp4, { system: 'Payload CMS', repo: 'Payload-Supertext-Translation', kind: 'install' })
await browser.close()
rmSync(workDir, { recursive: true, force: true })
console.log(`Saved ${mp4}`)
