import { Languages, SupertextError } from './vendor/supertext-sdk/v1/index.js'
import type { TargetLanguage } from './vendor/supertext-sdk/v1/index.js'
import type { Politeness } from './supertext/client.js'

/**
 * Payload locale codes → Supertext codes, with the Supertext SDK's rules (the same in every
 * Supertext plugin): the mapping wins (the `languageMap` option, else the Supertext settings'
 * combo box); otherwise a locale that equals a Supertext code apart from case and `_`/`-` is used
 * (`de-CH`, `fr_ch`, `es`); otherwise the SDK's default where one is obvious (`de` → `de-DE`,
 * `en` → `en-US`, `zh` → `zh-Hans`, `es-ES` → `es`); anything else (`en-IE`, `de-LI`, `gsw`)
 * throws `SupertextError('unsupported_language')` and nothing is sent. Sources are bare
 * (`de-CH` → `de`).
 */
export const SUPERTEXT_TARGETS: readonly TargetLanguage[] = Languages.targetOptions()

/** What the settings' combo box preselects: exact match, else the SDK default, else null ("— choose —"). */
export const suggestTargetCode = (locale: string): string | null => Languages.suggestTarget(locale)

export function targetCode(locale: string, map: Record<string, string> = {}): string {
  return Languages.target(locale, map)
}

/** The target code, or null when the locale has no Supertext language (status panel). */
export function targetCodeOrNull(locale: string, map: Record<string, string> = {}): string | null {
  try {
    return Languages.target(locale, map)
  } catch {
    return null
  }
}

/**
 * The source code: the SDK's `Languages.source()` with the same `languageMap`, which sends a
 * mapped value in its source form (`{ de: 'de-CH' }` → `de`), so one map serves both
 * directions; else the locale's language (`de-CH` → `de`).
 */
export function sourceCode(locale: string, map: Record<string, string> = {}): string {
  return Languages.source(locale, map)
}

export function politenessFor(locale: string, map: Record<string, Politeness> = {}): Politeness {
  return map[locale] ?? 'default'
}

/** Whether Supertext offers formal/informal for a target code (null: not in the SDK's list). */
export const supportsPoliteness = (target: string): boolean | null => Languages.supportsPoliteness(target)

/**
 * The politeness to send for a target. A formal/informal setting for a target that has none is
 * an `unsupported_feature` error (nothing is sent), so the setting is never dropped silently.
 */
export function politenessForTarget(locale: string, target: string, map: Record<string, Politeness> = {}): Politeness {
  const politeness = politenessFor(locale, map)
  if (politeness !== 'default' && supportsPoliteness(target) === false) {
    throw new SupertextError('unsupported_feature', { feature: 'politeness', targetLang: target })
  }
  return politeness
}
