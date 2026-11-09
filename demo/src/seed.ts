import type { Payload } from 'payload'

/** Minimal Lexical editor state from paragraphs; `**x**` marks bold, `[t](url)` a link. */
function richText(...paragraphs: string[]) {
  const textNode = (text: string, format = 0) => ({
    detail: 0, format, mode: 'normal', style: '', text, type: 'text', version: 1,
  })
  const parse = (p: string) =>
    p.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/).filter(Boolean).map((part) => {
      const bold = part.match(/^\*\*(.+)\*\*$/)
      if (bold) return textNode(bold[1] as string, 1)
      const link = part.match(/^\[(.+)\]\((.+)\)$/)
      if (link) {
        return {
          children: [textNode(link[1] as string)],
          direction: 'ltr', fields: { linkType: 'custom', newTab: true, url: link[2] },
          format: '', indent: 0, type: 'link', version: 3,
        }
      }
      return textNode(part)
    })
  return {
    root: {
      children: paragraphs.map((p) => ({
        children: parse(p), direction: 'ltr' as const, format: '' as const, indent: 0, textFormat: 0, type: 'paragraph', version: 1,
      })),
      direction: 'ltr' as const, format: '' as const, indent: 0, type: 'root', version: 1,
    },
  }
}

/**
 * Demo accounts from environment variables (see "Demo accounts rule" in CLAUDE.md).
 * Created on every start if missing; existing accounts are never changed.
 * Payload's demo has no roles, so the editor account has the same access as the admin.
 */
const ACCOUNTS = [
  { email: ['DEMO_ADMIN_EMAIL', 'PAYLOAD_ADMIN_EMAIL'], password: ['DEMO_ADMIN_PASSWORD', 'PAYLOAD_ADMIN_PASSWORD'], label: 'DEMO_ADMIN' },
  { email: ['DEMO_EDITOR_EMAIL'], password: ['DEMO_EDITOR_PASSWORD'], label: 'DEMO_EDITOR' },
] as const

const env = (names: readonly string[]) => names.map((name) => process.env[name]?.trim()).find(Boolean) ?? ''

async function ensureAccounts(payload: Payload): Promise<void> {
  for (const account of ACCOUNTS) {
    const email = env(account.email).toLowerCase()
    const password = env(account.password)
    if (!email || !password) continue
    const { totalDocs } = await payload.count({ collection: 'users', where: { email: { equals: email } } })
    if (totalDocs > 0) {
      payload.logger.info(`[demo] ${account.label} account already exists, leaving it unchanged`)
      continue
    }
    try {
      await payload.create({ collection: 'users', data: { email, password } })
      payload.logger.info(`[demo] created ${account.label} account`)
    } catch (error) {
      payload.logger.warn(`[demo] could not create ${account.label} account: ${(error as Error).message}`)
    }
  }
}

/**
 * Runs on every start: demo accounts (above), and English sample content (plus the
 * formal tone for German in the Supertext settings) when there are no pages yet. Without any DEMO_* account variables, Payload shows its
 * "create first user" screen instead.
 */
export async function seed(payload: Payload): Promise<void> {
  await ensureAccounts(payload)

  const { totalDocs: pages } = await payload.count({ collection: 'pages' })
  if (pages > 0) return

  // First start: German formal (Sie) in the Supertext settings; the other combo boxes keep their suggestion.
  await payload.updateGlobal({ data: { languages: { 'l_de_CH_tone': 'more' } }, slug: 'supertext-settings' })

  await payload.create({
    collection: 'pages',
    data: {
      _status: 'published',
      body: richText(
        'Supertext combines **AI translation** with Swiss language experts. This page was written in English — use the **Translate** button above to create the German, French and Italian versions.',
        'Formatting and [links](https://www.supertext.com) survive translation, and the slug stays the same in every language.',
      ),
      internalNote: 'Demo page — this field is not localized.',
      layout: [
        {
          blockType: 'hero',
          heading: 'Content that speaks every language',
          subheading: 'Translate your Payload pages into German, French and Italian in seconds.',
        },
        {
          blockType: 'faq',
          items: [
            { answer: 'Only fields marked as localized. Images, numbers and relations stay untouched.', question: 'What gets translated?' },
            { answer: 'Into a draft, so an editor can review it before publishing.', question: 'Where does the translation go?' },
          ],
        },
        {
          blockType: 'cta',
          buttonLabel: 'Talk to us',
          buttonUrl: 'https://www.supertext.com/en/contact',
          text: richText('Need a **human review** on top? Supertext linguists can check every translation.'),
        },
      ],
      meta: { description: 'Demo of the Supertext translation plugin for Payload CMS.', title: 'Supertext × Payload demo' },
      slug: 'home',
      title: 'Welcome to the Supertext demo',
    },
    locale: 'en',
  })

  await payload.create({
    collection: 'pages',
    data: {
      _status: 'published',
      body: richText(
        'We are a Swiss language company. Our team combines technology with linguists who know your market.',
        'Every translation can be **reviewed** and edited before it goes live.',
      ),
      slug: 'about',
      title: 'About us',
    },
    locale: 'en',
  })

  await payload.updateGlobal({
    data: {
      nav: [
        { href: '/home', label: 'Home' },
        { href: '/about', label: 'About us' },
      ],
      tagline: 'Swiss quality, in every language',
    },
    locale: 'en',
    slug: 'header',
  })

  payload.logger.info('[demo] seeded sample pages')
}
