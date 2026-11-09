#!/usr/bin/env node
/**
 * Regenerates docs/images from the local demo (fresh database) whose plugin talks
 * to stand-in.mjs. See docs/DEVELOPER.md -> Docs screenshots.
 *
 *   BASE_URL (default http://localhost:3000 - use localhost, not 127.0.0.1, with `next dev`),
 *   start the demo with SUPERTEXT_REPORT_URL pointing at the stand-in (never the live center),
 *   DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD
 */
import { chromium } from 'playwright'

const B = process.env.BASE_URL || 'http://localhost:3000'
const EMAIL = process.env.DEMO_ADMIN_EMAIL || 'anna.muster@example.com'
const PASSWORD = process.env.DEMO_ADMIN_PASSWORD || 'Docs12345!'
const OUT = new URL('../../docs/images', import.meta.url).pathname

const browser = await chromium.launch()
const page = await (await browser.newContext({ viewport: { width: 1400, height: 940 } })).newPage()
// Dates change with every run (Last Modified, Created, the key check's time): show fixed ones,
// so the images only change when the UI does.
const freezeDates = () =>
  page.evaluate(() => {
    const long = /\b(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}(st|nd|rd|th) \d{4}, \d{1,2}:\d{2} [AP]M\b/g
    const short = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}, \d{1,2}:\d{2}\s?[AP]M\b/g
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.nodeValue.replace(long, 'October 5th 2026, 10:58 AM').replace(short, 'Oct 13, 2026, 11:47 PM')
      if (text !== node.nodeValue) node.nodeValue = text
    }
  })
const shot = async (name, clip) => {
  await freezeDates()
  await page.screenshot({ path: `${OUT}/${name}.png`, ...(clip ? { clip } : {}) })
}
const pad = (r, p = 8) => ({ x: Math.max(0, r.x - p), y: Math.max(0, r.y - p), width: r.width + 2 * p, height: r.height + 2 * p })
// Hide the Next.js dev-mode badge and toasts' entry animation.
const tidy = () => page.addStyleTag({ content: 'nextjs-portal{display:none!important} a[href$="/admin/account"] img{visibility:hidden} *{animation-duration:0s!important;transition-duration:0s!important}' })

await page.goto(`${B}/admin/login`)
await page.fill('input[name=email]', EMAIL)
await page.fill('input[name=password]', PASSWORD)
await page.click('button[type=submit]')
await page.waitForURL(/\/admin\/?$/, { timeout: 60000 })

// --- Installation guide: the Supertext panel on the dashboard -----------------
await page.goto(`${B}/admin`)
const panel = page.locator('section.supertext-status')
await panel.getByText('API key checked').waitFor({ timeout: 60000 })
await tidy()
// Show the live demo's ping URL, not the local one.
await panel.evaluate((el) => {
  const local = /https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/
  for (const p of el.querySelectorAll('p')) {
    if (local.test(p.textContent)) p.textContent = p.textContent.replace(local, 'https://payload-production-cfd2.up.railway.app')
  }
})
await panel.scrollIntoViewIfNeeded()
await page.waitForTimeout(500)
await shot('status-panel', pad(await panel.boundingBox()))

// The seeded home page
const res = await page.request.get(`${B}/api/pages?where[slug][equals]=home&locale=en&limit=1`)
const id = (await res.json()).docs[0].id
const open = async (locale) => {
  await page.goto(`${B}/admin/collections/pages/${id}?locale=${locale}`)
  await page.getByRole('button', { name: /^Translate$/ }).waitFor({ timeout: 60000 })
  await tidy()
  await page.waitForTimeout(1000)
}

// --- User guide -------------------------------------------------------------
await open('en')
await shot('edit-view')

await page.getByRole('button', { name: /^Translate$/ }).click()
const popover = page.getByText('Translate with Supertext').locator('xpath=..')
await popover.waitFor()
await page.getByRole('checkbox', { name: /Deutsch/ }).check()
await page.waitForTimeout(300)
await shot('translate-menu', pad(await popover.boundingBox()))

await page.getByRole('button', { name: /^Translate into/ }).click()
const toast = page.getByText(/^Translated into /).first()
await toast.waitFor({ timeout: 120000 })
await page.waitForTimeout(800)
const t = await toast.boundingBox()
await shot('translated-toast', { x: t.x - 60, y: t.y - 40, width: t.width + 140, height: t.height + 80 })

await open('de-CH')
await shot('translated-de')
await page.getByRole('button', { name: 'Body' }).click().catch(() => page.getByText('Body', { exact: true }).first().click())
await page.waitForTimeout(1200)
await shot('translated-de-body')

// --- Installation guide: the configured languages -----------------------------
await page.getByText('Locale:', { exact: false }).first().click({ force: true })
await page.waitForTimeout(600)
await shot('locales', { x: 700, y: 0, width: 700, height: 300 })

// --- Installation guide: the language mapping (Supertext settings) ------------
await page.goto(`${B}/admin/globals/supertext-settings`)
const mapping = page.locator('.field-type.group-field').first()
await mapping.getByText('Language mapping').first().waitFor({ timeout: 60000 })
await tidy()
await page.waitForTimeout(800)
await shot('settings-languages', pad(await mapping.boundingBox()))
// The combo box opened: Supertext's languages, "Name (code)".
await mapping.locator('.react-select').nth(1).click()
await page.waitForTimeout(500)
const menu = page.locator('.rs__menu').first()
const m = await menu.boundingBox()
const box = await mapping.boundingBox()
await shot('settings-languages-open', pad({ x: box.x, y: box.y, width: box.width, height: m.y + m.height - box.y }))
await page.keyboard.press('Escape')

await browser.close()
console.log(`Screenshots written to ${OUT}`)
