import type { Field, GlobalConfig, Payload, PayloadRequest } from 'payload'

import { suggestTargetCode, SUPERTEXT_TARGETS, targetCodeOrNull } from './languages.js'
import type { Politeness } from './supertext/client.js'
import type { SupertextTranslationOptions } from './types.js'

/**
 * The Supertext settings global (`supertext-settings`): one combo box (Payload's own select
 * field) per configured Payload locale with Supertext's target codes, preselected with the SDK's
 * suggestion (`Languages.suggestTarget`), plus a formal/informal select shown only where the
 * chosen target offers it, and a *Translation review* checkbox (off by default: translations into
 * that locale go through Supertext's review service, `SupertextClient.forReview`). The
 * `languageMap`, `politeness` and `review` plugin options override it per locale (for automated
 * setups); those fields are read-only and say so.
 */
export const SETTINGS_SLUG = 'supertext-settings'

/** Interface languages the plugin brings strings for (the field labels are built for these). */
const UI = ['en', 'de', 'fr', 'it'] as const
type Ui = (typeof UI)[number]
type Labels = Record<Ui, string>

const each = (fn: (lang: Ui) => string): Labels =>
  Object.fromEntries(UI.map((lang) => [lang, fn(lang)])) as Labels

/** A target's name in an interface language (Intl's display names; the SDK's English name where Intl has none). */
export function targetName(code: string, english: string, lang: string): string {
  if (code.includes('-u-')) return english
  try {
    const name = new Intl.DisplayNames([lang], { fallback: 'none', type: 'language' }).of(code)
    return name && name !== code ? name : english
  } catch {
    return english
  }
}

/** The select options: every Supertext target as "Name (code)", the name in each interface language. */
export function targetSelectOptions(): { label: Labels; value: string }[] {
  return SUPERTEXT_TARGETS.map(({ code, name }) => ({ label: each((lang) => `${targetName(code, name, lang)} (${code})`), value: code }))
}

const TEXT = {
  description: {
    de: 'Wählen Sie für jede Sprache von Payload die Supertext-Sprache, in die übersetzt wird. Dieselbe Zuordnung gilt, wenn die Sprache die Ausgangssprache ist (Supertext erhält dann nur die Sprache, z. B. de). Vorausgewählt ist der Vorschlag von Supertext; Sprachen ohne Vorschlag müssen Sie zuordnen.',
    en: 'Choose the Supertext language each Payload locale is translated into. The same mapping is used when the locale is the source (Supertext then gets only the language, e.g. de). Supertext’s suggestion is preselected; locales without a suggestion must be mapped.',
    fr: 'Choisissez pour chaque langue Payload la langue Supertext dans laquelle elle est traduite. La même association s’applique lorsque la langue est la langue source (Supertext ne reçoit alors que la langue, p. ex. de). La suggestion de Supertext est présélectionnée ; les langues sans suggestion doivent être associées.',
    it: 'Scelga per ogni lingua di Payload la lingua Supertext in cui viene tradotta. La stessa associazione vale quando la lingua è quella di partenza (Supertext riceve allora solo la lingua, ad es. de). Il suggerimento di Supertext è preselezionato; le lingue senza suggerimento vanno associate.',
  },
  global: { de: 'Supertext-Einstellungen', en: 'Supertext settings', fr: 'Paramètres Supertext', it: 'Impostazioni Supertext' },
  languages: { de: 'Sprachzuordnung', en: 'Language mapping', fr: 'Association des langues', it: 'Associazione delle lingue' },
  mapOverride: {
    de: 'Durch die Option languageMap in payload.config festgelegt: {code}. Diese Einstellung hat Vorrang.',
    en: 'Set by the languageMap option in payload.config: {code}. That setting wins.',
    fr: 'Défini par l’option languageMap dans payload.config : {code}. Ce réglage l’emporte.',
    it: 'Impostato dall’opzione languageMap in payload.config: {code}. Questa impostazione ha la precedenza.',
  },
  politeness: { de: 'Anrede', en: 'Tone', fr: 'Ton', it: 'Registro' },
  politenessOverride: {
    de: 'Durch die Option politeness in payload.config festgelegt: {value}.',
    en: 'Set by the politeness option in payload.config: {value}.',
    fr: 'Défini par l’option politeness dans payload.config : {value}.',
    it: 'Impostato dall’opzione politeness in payload.config: {value}.',
  },
  review: { de: 'Übersetzungsprüfung', en: 'Translation review', fr: 'Révision des traductions', it: 'Revisione delle traduzioni' },
  reviewHelp: {
    de: 'Übersetzungen in diese Sprache laufen über den Prüfdienst von Supertext, damit Prüferinnen und Prüfer sie mit der Erweiterung Supertext Localization Review direkt auf der Website kontrollieren und korrigieren können. Ihre Korrekturen werden beim nächsten Übersetzen des Dokuments übernommen.',
    en: 'Translations into this language go through Supertext’s review service, so reviewers can check and correct them on the website with the Supertext Localization Review extension. Their corrections are used the next time the document is translated.',
    fr: 'Les traductions vers cette langue passent par le service de révision de Supertext, afin que les réviseurs puissent les vérifier et les corriger directement sur le site avec l’extension Supertext Localization Review. Leurs corrections sont reprises lors de la prochaine traduction du document.',
    it: 'Le traduzioni in questa lingua passano dal servizio di revisione di Supertext, così i revisori possono controllarle e correggerle direttamente sul sito con l’estensione Supertext Localization Review. Le loro correzioni vengono riprese alla prossima traduzione del documento.',
  },
  reviewOverride: {
    de: 'Durch die Option review in payload.config festgelegt. Diese Einstellung hat Vorrang.',
    en: 'Set by the review option in payload.config. That setting wins.',
    fr: 'Défini par l’option review dans payload.config. Ce réglage l’emporte.',
    it: 'Impostato dall’opzione review in payload.config. Questa impostazione ha la precedenza.',
  },
  politeness_default: { de: 'Standard', en: 'Default', fr: 'Par défaut', it: 'Predefinito' },
  politeness_less: { de: 'Informell (du)', en: 'Informal', fr: 'Informel (tu)', it: 'Informale (tu)' },
  politeness_more: { de: 'Formell (Sie)', en: 'Formal', fr: 'Formel (vous)', it: 'Formale (Lei)' },
} satisfies Record<string, Labels>

const fill = (labels: Labels, values: Record<string, string>): Labels =>
  each((lang) => labels[lang].replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m))

type LocaleConfig = { code: string; label?: unknown }

/** The configured Payload locales with their labels. */
export function configLocales(localization: unknown): LocaleConfig[] {
  const config = localization as { locales?: unknown[] } | false | undefined
  const locales: unknown[] = (config && config.locales) || []
  return locales.map((l) => (typeof l === 'string' ? { code: l } : (l as LocaleConfig)))
}

/** Field name of a locale's select: letters, digits and `_` only, unique (`de-CH` → `de_CH`). */
export function fieldKeys(locales: string[]): Map<string, string> {
  const keys = new Map<string, string>()
  const used = new Set<string>()
  for (const locale of locales) {
    const base = `l_${locale.replace(/[^A-Za-z0-9]/g, '_')}`
    let key = base
    for (let n = 2; used.has(key); n++) key = `${base}_${n}`
    used.add(key)
    keys.set(locale, key)
  }
  return keys
}

const localeLabel = (locale: LocaleConfig): Labels => {
  const label = locale.label
  return each((lang) => {
    const text =
      typeof label === 'string' ? label : label && typeof label === 'object' ? ((label as Record<string, string>)[lang] ?? (label as Record<string, string>).en) : undefined
    return text && text !== locale.code ? `${text} (${locale.code})` : locale.code
  })
}

const supportsTone = new Map(SUPERTEXT_TARGETS.map((t) => [t.code, t.politeness]))

/** The global with one row per locale; built from the Payload config's locales. */
export function settingsGlobal(localization: unknown, options: SupertextTranslationOptions): GlobalConfig {
  const locales = configLocales(localization)
  const keys = fieldKeys(locales.map((l) => l.code))
  const targets = targetSelectOptions()
  const toneOptions = (['default', 'more', 'less'] as const).map((value) => ({ label: TEXT[`politeness_${value}`], value }))
  const check = options.settingsAccess ?? options.access
  const allowed = async ({ req }: { req: PayloadRequest }) => Boolean(req.user) && (check ? await check({ req }) : true)

  const rows: Field[] = locales.map((locale) => {
    const key = keys.get(locale.code)!
    const mapped = options.languageMap?.[locale.code]
    const tone = options.politeness?.[locale.code]
    const suggested = suggestTargetCode(locale.code)
    const codeField: Field = {
      admin: {
        ...(mapped ? { description: fill(TEXT.mapOverride, { code: mapped }), readOnly: true } : {}),
        isClearable: true,
        // Empty: Payload's own placeholder ("Select a value", in the admin language).
        width: '50%',
      },
      ...(suggested ? { defaultValue: suggested } : {}),
      enumName: `enum_st_${key}`,
      label: localeLabel(locale),
      name: key,
      options: targets,
      type: 'select',
    }
    const toneField: Field = {
      admin: {
        // Only where the chosen (or suggested) target offers formal/informal.
        condition: (_data, sibling) => supportsTone.get(mapped ?? (sibling as Record<string, string | undefined>)?.[key] ?? suggested ?? '') === true,
        ...(tone ? { description: fill(TEXT.politenessOverride, { value: tone }), readOnly: true } : {}),
        width: '25%',
      },
      defaultValue: 'default',
      enumName: `enum_st_${key}_tone`,
      label: TEXT.politeness,
      name: `${key}_tone`,
      options: toneOptions,
      type: 'select',
    }
    const reviewOption = options.review?.[locale.code]
    const reviewField: Field = {
      admin: {
        description: reviewOption === undefined ? TEXT.reviewHelp : TEXT.reviewOverride,
        ...(reviewOption === undefined ? {} : { readOnly: true }),
      },
      defaultValue: false,
      label: TEXT.review,
      name: `${key}_review`,
      type: 'checkbox',
    }
    return { fields: [codeField, toneField, reviewField], type: 'row' }
  })

  return {
    access: { read: allowed, readVersions: () => false, update: allowed },
    admin: { group: 'Supertext', hidden: options.disabled === true },
    fields: [
      {
        admin: { description: TEXT.description },
        fields: rows.length > 0 ? rows : [{ admin: { hidden: true }, name: 'none', type: 'text' }],
        label: TEXT.languages,
        name: 'languages',
        type: 'group',
      },
    ],
    label: TEXT.global,
    slug: SETTINGS_SLUG,
  }
}

export type SavedSettings = {
  /** Locale → Supertext code chosen in the settings. */
  languageMap: Record<string, string>
  /** Locale → politeness chosen in the settings. */
  politeness: Record<string, Politeness>
  /** Locale → *Translation review* on (only `true` entries). */
  review: Record<string, boolean>
}

/** Reads the saved settings global; an empty result when it isn't there or can't be read. */
export async function loadSettings(payload: Payload): Promise<SavedSettings> {
  const result: SavedSettings = { languageMap: {}, politeness: {}, review: {} }
  try {
    if (!payload.config.globals.some((g) => g.slug === SETTINGS_SLUG)) return result
    const doc = (await payload.findGlobal({ depth: 0, overrideAccess: true, slug: SETTINGS_SLUG as never })) as {
      languages?: Record<string, unknown>
    }
    const saved = doc?.languages ?? {}
    const locales = configLocales(payload.config.localization).map((l) => l.code)
    for (const [locale, key] of fieldKeys(locales)) {
      const code = saved[key]
      if (typeof code === 'string' && code !== '' && supportsTone.has(code)) result.languageMap[locale] = code
      const tone = saved[`${key}_tone`]
      if (tone === 'more' || tone === 'less') result.politeness[locale] = tone
      if (saved[`${key}_review`] === true) result.review[locale] = true
    }
  } catch (err) {
    payload.logger.debug(`[supertext] settings not read: ${err instanceof Error ? err.message : String(err)}`)
  }
  return result
}

/**
 * Saved settings with the plugin options on top: the option wins per locale. A saved tone is
 * dropped where the locale's target offers no formal/informal choice (the screen hides the field
 * then, but keeps its old value).
 */
export function effectiveSettings(saved: SavedSettings, options: SupertextTranslationOptions): SavedSettings {
  const languageMap = { ...saved.languageMap, ...options.languageMap }
  const politeness: Record<string, Politeness> = {}
  for (const [locale, tone] of Object.entries(saved.politeness)) {
    const target = targetCodeOrNull(locale, languageMap)
    if (target && supportsTone.get(target) === true) politeness[locale] = tone
  }
  return { languageMap, politeness: { ...politeness, ...options.politeness }, review: { ...saved.review, ...options.review } }
}
