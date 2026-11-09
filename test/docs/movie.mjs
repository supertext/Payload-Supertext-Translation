#!/usr/bin/env node
/**
 * Records the README's demo movie (docs/images/demo.gif, plus a narrated MP4 that isn't committed)
 * from a fresh demo whose plugin talks to stand-in.mjs, signed in with the editor account. Uses the
 * shared Supertext movie kit (movie/movie-kit.mjs). See docs/DEVELOPER.md -> Demo movie.
 *
 *   BASE_URL=http://localhost:3000 DEMO_EDITOR_EMAIL=… DEMO_EDITOR_PASSWORD=… npm run movie
 *
 * MOVIE_OUT: where the MP4 goes (default test/docs/movie/out/Payload-Supertext-Translation.mp4, git-ignored).
 * CHROMIUM_PATH: a Chromium to use instead of Playwright's own.
 */
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MovieKit } from './movie/movie-kit.mjs'

const B = process.env.BASE_URL || 'http://localhost:3000'
const need = (name) => process.env[name] || (() => { throw new Error(`Set ${name}`) })()
const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const mp4 = process.env.MOVIE_OUT || here('movie/out/Payload-Supertext-Translation.mp4')
const gif = here('../../docs/images/demo.gif')
const workDir = mkdtempSync(join(tmpdir(), 'payload-movie-'))

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, locale: 'en-US' })
page.setDefaultTimeout(120_000)
// Hide the Next.js dev badge and the account avatar (Gravatar), as the screenshot script does.
await page.addInitScript(() => {
  const add = () => {
    const s = document.createElement('style')
    s.textContent = 'nextjs-portal{display:none!important} a[href$="/admin/account"] img{visibility:hidden}'
    document.head.appendChild(s)
  }
  if (document.head) add()
  else document.addEventListener('DOMContentLoaded', add)
})

// Sign in as the editor (not recorded).
await page.goto(`${B}/admin/login`)
await page.fill('input[name=email]', need('DEMO_EDITOR_EMAIL'))
await page.fill('input[name=password]', need('DEMO_EDITOR_PASSWORD'))
await page.click('button[type=submit]')
await page.waitForURL(/\/admin\/?$/)

const res = await page.request.get(`${B}/api/pages?where[slug][equals]=home&locale=en&limit=1`)
const id = (await res.json()).docs[0].id
await page.goto(`${B}/admin/collections/pages/${id}?locale=en`)
const translate = page.getByRole('button', { name: /^Translate$/ })
await translate.waitFor()
await page.waitForTimeout(1500)

const kit = await MovieKit.start(page, { workDir, assets: here('movie/assets'), voiceCache: here('movie/voice') })

// 1. The page in English.
await kit.say("Here's a page in Payload, written in English.", {
  caption: 'A page in English',
  during: () => kit.moveTo(page.locator('input[name=title]').first()),
})

// 2. The Translate control: German and French.
await kit.say('Click Translate, then tick German and French.', {
  caption: 'Click <b>Translate</b>, tick <b>Deutsch</b> and <b>Français</b>',
  during: async () => {
    await kit.click(translate)
    await kit.click(page.getByRole('checkbox', { name: /Deutsch/ }))
    await kit.click(page.getByRole('checkbox', { name: /Français/ }))
  },
})
const go = page.getByRole('button', { name: /^Translate into/ })
await kit.say('Then click Translate into 2.', { caption: 'Click <b>Translate into 2</b>', during: () => kit.click(go) })

// 3. Waiting (cut).
await kit.say('Supertext translates the content.', { caption: 'Supertext translates the content…' })
kit.pause()
const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'Translated into' }).first()
await toast.waitFor({ timeout: 180_000 })
// The real mouse rests on the toast, so it stays while the next line is made and said.
const tb = await toast.boundingBox()
await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2)
await page.waitForTimeout(300)
kit.resume()
await kit.say('A few seconds later, German and French are done.', {
  caption: 'Translated into German and French',
  during: () => kit.moveTo(toast),
})

// 4. The German version, as an editor checks it.
await kit.say('To check the German version, switch the locale to German.', {
  caption: 'Switch the <b>Locale</b> to <b>Deutsch (Schweiz)</b>',
  during: async () => {
    await kit.click(page.locator('.localizer-button:visible').first())
    await page.waitForTimeout(300)
    await kit.click(page.locator('button.popup-button-list__button').filter({ hasText: 'Deutsch (Schweiz)' }).first())
  },
})
// Loading the German version is cut.
kit.pause()
await page.waitForURL(/locale=de-CH/)
await page.waitForFunction(() => document.querySelector('input[name=title]')?.value === 'Willkommen in der Supertext-Demo')
await page.waitForTimeout(800)
kit.resume()
await kit.say('The German version is ready, saved as a draft. Review it and publish it as usual.', {
  caption: 'The German draft is ready – review and publish it',
  during: () => kit.moveTo(page.locator('input[name=title]').first()),
})
await kit.caption('')

await kit.finish(mp4, { system: 'Payload CMS', repo: 'Payload-Supertext-Translation', gif })
await browser.close()
rmSync(workDir, { recursive: true, force: true })
console.log(`Saved ${mp4} and ${gif} (${(statSync(gif).size / 1e6).toFixed(2)} MB)`)
