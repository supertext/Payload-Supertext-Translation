import type { Field, Payload, PayloadRequest } from 'payload'

import { collectSegments } from './collect.js'
import { errorMessage } from './i18n.js'
import { politenessForTarget, sourceCode, targetCode } from './languages.js'
import { applyTranslations, buildHtml, parseHtml } from './segments.js'
import { effectiveSettings, loadSettings } from './settings.js'
import { SupertextClient, SupertextError } from './supertext/client.js'
import type { LocaleResult, SupertextTranslationOptions } from './types.js'

export type TranslateDocumentArgs = ItemArgs & {
  client: SupertextClient
  sourceLocale: string
  targetLocales: string[]
}

export type ItemArgs = {
  options: SupertextTranslationOptions
  payload: Payload
  /** Request of the editor; used for access control. Omit for system calls (overrideAccess). */
  req?: PayloadRequest
  collection?: string
  global?: string
  id?: number | string
}

export type LoadedItem = {
  /** Draft saves for collections/globals with drafts (unless `saveAsDraft: false`). */
  draft: boolean
  /** Fresh walk of the source: segments plus a clone to write translations into. */
  collect: () => ReturnType<typeof collectSegments>
  /** The item in another locale, without fallback (undefined values where it has none). */
  read: (locale: string) => Promise<Record<string, unknown>>
  /** Saves data into a locale; saves are serialized (see below). */
  save: (locale: string, data: Record<string, unknown>) => Promise<unknown>
}

/**
 * Loads a document (or global) in `sourceLocale` with the editor's access rights and returns
 * how to collect its segments and save into a target locale. Shared by API translation and
 * translation files, so both write back the same way.
 */
export async function loadItem(args: ItemArgs & { sourceLocale: string }): Promise<LoadedItem> {
  const { collection, global, id, options, payload, req, sourceLocale } = args
  const access = req ? { overrideAccess: false, req, user: req.user } : { overrideAccess: true }

  const entity = collection
    ? payload.collections[collection as keyof typeof payload.collections]?.config
    : payload.globals.config.find((g) => g.slug === global)
  if (!entity) throw new Error(`Unknown ${collection ? 'collection' : 'global'} "${collection ?? global}".`)
  if (collection && (id === undefined || id === '')) throw new Error('A document id is required.')

  const hasDrafts = Boolean((entity as { versions?: { drafts?: unknown } }).versions?.drafts)
  const draft = hasDrafts && options.saveAsDraft !== false

  const read = async (locale: string) =>
    (collection
      ? await payload.findByID({
          ...access,
          collection: collection as never,
          depth: 0,
          draft: hasDrafts,
          fallbackLocale: false as never,
          id: id as number | string,
          locale: locale as never,
        })
      : await payload.findGlobal({
          ...access,
          depth: 0,
          draft: hasDrafts,
          fallbackLocale: false as never,
          locale: locale as never,
          slug: global as never,
        })) as Record<string, unknown>

  const source = await read(sourceLocale)

  // Supertext calls run in parallel, but saves are serialized: concurrent updates of
  // the same document race on its version history (a draft save copies the latest
  // version, so two parallel locale saves lose one of them).
  let saveQueue: Promise<unknown> = Promise.resolve()
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = saveQueue.then(fn, fn)
    saveQueue = run.catch(() => undefined)
    return run
  }

  const blocksBySlug = Object.fromEntries((payload.config.blocks ?? []).map((b) => [b.slug, b]))
  const fields = entity.fields as Field[]

  return {
    collect: () => collectSegments(fields, source, { blocksBySlug, skipFieldNames: options.skipFieldNames ?? ['slug'] }),
    draft,
    read,
    save: (locale, data) =>
      serialized(() =>
        collection
          ? payload.update({
              ...access,
              collection: collection as never,
              data: data as never,
              depth: 0,
              draft,
              id: id as number | string,
              locale: locale as never,
            })
          : payload.updateGlobal({
              ...access,
              data: data as never,
              depth: 0,
              draft,
              locale: locale as never,
              slug: global as never,
            }),
      ),
  }
}

/**
 * Translates one document (or global) from `sourceLocale` into each target locale and
 * saves the result. Targets run in parallel; one failing locale does not stop others.
 */
export async function translateDocument(args: TranslateDocumentArgs): Promise<LocaleResult[]> {
  const { client, collection, global, id, payload, req, sourceLocale } = args
  const targets = [...new Set(args.targetLocales)].filter((l) => l !== sourceLocale)
  const item = await loadItem(args)

  // The mapping: the plugin options win, then the Supertext settings (combo boxes).
  const settings = effectiveSettings(await loadSettings(payload), args.options)

  return Promise.all(
    targets.map(async (locale): Promise<LocaleResult> => {
      try {
        // Fresh walk per target: each needs its own clone to write into.
        const { segments, updateData } = item.collect()
        if (segments.length === 0) return { locale, missing: [], ok: true, segments: 0 }

        // Locales without mapping and default, and a tone the target lacks, fail here, before anything is sent.
        const targetLang = targetCode(locale, settings.languageMap)
        // Locales with *Translation review* on go through the review service (same key, same protocol).
        const html = await client.forReview(settings.review[locale] === true).translateHtml({
          html: buildHtml(segments),
          politeness: politenessForTarget(locale, targetLang, settings.politeness),
          sourceLang: sourceCode(sourceLocale, settings.languageMap),
          targetLang,
        })
        const missing = applyTranslations(segments, parseHtml(html))

        await item.save(locale, updateData)

        if (missing.length > 0) {
          payload.logger.warn(
            `[supertext] ${collection ?? global} ${id ?? ''} → ${locale}: ${missing.length} segment(s) came back empty and kept the source text: ${missing.join(', ')}`,
          )
        }
        return { locale, missing, ok: true, segments: segments.length }
      } catch (err) {
        payload.logger.error({ err }, `[supertext] ${collection ?? global} ${id ?? ''} → ${locale} failed`)
        return {
          code: err instanceof SupertextError ? err.code : undefined,
          error: errorMessage(req, err),
          locale,
          ok: false,
          ...(err instanceof SupertextError && err.status !== undefined ? { status: err.status } : {}),
        }
      }
    }),
  )
}
