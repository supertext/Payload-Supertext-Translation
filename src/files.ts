import type { Payload, PayloadRequest } from 'payload'

import { sourceCode, targetCodeOrNull } from './languages.js'
import { PLUGIN_NAME } from './reporting.js'
import type { Segment } from './segments.js'
import { effectiveSettings, loadSettings } from './settings.js'
import { loadItem, type ItemArgs } from './translate.js'
import type { FileImportJob, SupertextTranslationOptions } from './types.js'
import {
  TranslationFileError,
  TranslationFiles,
  type FileJob,
  type FileSegment,
  type ImportedSegment,
} from './vendor/supertext-sdk/index.js'

/**
 * Translation files (Supertext SDK `TranslationFiles`): *Export for translation* writes one
 * item's segments as XLIFF 1.2 or HTML, *Import translation* reads a translated file back and
 * writes it with the same collector and save as API translations (`loadItem` in translate.ts).
 *
 * Reference format (the job's `reference`, the XLIFF `original`):
 *   `collection:<slug>:<id>:<sourceLocale>:<targetLocale>` or `global:<slug>:<sourceLocale>:<targetLocale>`,
 * each part URI-encoded. It names the item, the locale its segments were collected from and the
 * Payload target locale, so an import finds all three again.
 */

/** Uploads larger than this are refused before they are read. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

export type FileFormat = 'xliff' | 'html'

export type ItemReference =
  | { kind: 'collection'; collection: string; id: string; sourceLocale: string; targetLocale: string }
  | { kind: 'global'; global: string; sourceLocale: string; targetLocale: string }

/** Glue errors, shown with the plugin's own strings (`file_<code>`). */
export class FileGlueError extends Error {
  constructor(
    readonly code: 'nothing' | 'other_system' | 'not_found' | 'no_language' | 'not_allowed' | 'too_large',
    readonly vars: Record<string, string> = {},
  ) {
    super(code)
  }
}

const enc = encodeURIComponent

export function formatReference(ref: ItemReference): string {
  return ref.kind === 'collection'
    ? ['collection', ref.collection, String(ref.id), ref.sourceLocale, ref.targetLocale].map(enc).join(':')
    : ['global', ref.global, ref.sourceLocale, ref.targetLocale].map(enc).join(':')
}

/** The reference back, or null when it isn't one of ours. */
export function parseReference(reference: string): ItemReference | null {
  let parts: string[]
  try {
    parts = reference.split(':').map(decodeURIComponent)
  } catch {
    return null
  }
  if (parts.some((p) => p === '')) return null
  if (parts[0] === 'collection' && parts.length === 5) {
    const [, collection, id, sourceLocale, targetLocale] = parts as [string, string, string, string, string]
    return { collection, id, kind: 'collection', sourceLocale, targetLocale }
  }
  if (parts[0] === 'global' && parts.length === 4) {
    const [, global, sourceLocale, targetLocale] = parts as [string, string, string, string]
    return { global, kind: 'global', sourceLocale, targetLocale }
  }
  return null
}

/** The collector's segments as file segments: the segment path is the key, rich text goes as HTML. */
export function fileSegments(segments: Segment[]): FileSegment[] {
  return segments.map((seg) => (seg.html !== undefined ? { html: true, key: seg.path, text: seg.html } : { key: seg.path, text: seg.text }))
}

/** A Supertext code from the mapping, else the Payload code with `_` → `-` (a file may go to any translator). */
const sourceOrCode = (locale: string, map: Record<string, string>): string => {
  try {
    return sourceCode(locale, map)
  } catch {
    return locale.replace(/_/g, '-')
  }
}
const targetOrCode = (locale: string, map: Record<string, string>): string =>
  targetCodeOrNull(locale, map) ?? locale.replace(/_/g, '-')

const fileSafe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '_')

export type ExportArgs = ItemArgs & {
  format: FileFormat
  sourceLocale: string
  targetLocales: string[]
}

export type ExportedFile = { body: string; contentType: string; filename: string }

/** Builds the file for one item: XLIFF with one job per target, or HTML for exactly one target. */
export async function exportItem(args: ExportArgs): Promise<ExportedFile> {
  const { collection, format, global, id, options, payload, sourceLocale } = args
  const targets = [...new Set(args.targetLocales)].filter((l) => l !== sourceLocale)
  if (targets.length === 0) throw new Error('Choose at least one target locale other than the source.')
  if (format === 'html' && targets.length !== 1) throw new Error('An HTML file holds exactly one target locale.')

  const item = await loadItem(args)
  const segments = fileSegments(item.collect().segments)
  if (segments.every((s) => s.text.trim() === '')) throw new FileGlueError('nothing')

  const { languageMap } = effectiveSettings(await loadSettings(payload), options)
  const jobs: FileJob[] = targets.map((targetLocale) => ({
    plugin: PLUGIN_NAME,
    reference: formatReference(
      collection
        ? { collection, id: String(id), kind: 'collection', sourceLocale, targetLocale }
        : { global: global as string, kind: 'global', sourceLocale, targetLocale },
    ),
    segments,
    sourceLanguage: sourceOrCode(sourceLocale, languageMap),
    targetLanguage: targetOrCode(targetLocale, languageMap),
  }))

  const itemId = fileSafe(collection ? `${collection}-${id}` : (global as string))
  const suffix = targets.length === 1 ? `-${fileSafe(targets[0] as string)}` : ''
  return format === 'html'
    ? { body: TranslationFiles.exportHtml(jobs[0]!), contentType: 'text/html; charset=utf-8', filename: `payload-${itemId}${suffix}.html` }
    : { body: TranslationFiles.exportXliff(jobs), contentType: 'application/x-xliff+xml', filename: `payload-${itemId}${suffix}.xlf` }
}

/** Reads an upload into a string, refusing more than `MAX_UPLOAD_BYTES` before and while reading. */
export async function readUpload(req: Pick<Request, 'headers'> & { body?: ReadableStream<Uint8Array> | null }): Promise<string> {
  const length = Number(req.headers.get('content-length') ?? '0')
  if (length > MAX_UPLOAD_BYTES) throw new FileGlueError('too_large')
  if (!req.body) return ''
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_UPLOAD_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new FileGlueError('too_large')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    bytes.set(c, offset)
    offset += c.byteLength
  }
  return new TextDecoder('utf-8').decode(bytes)
}

export type ImportArgs = {
  content: string
  /** Also write `source_changed` results (off by default). */
  includeChanged: boolean
  options: SupertextTranslationOptions
  payload: Payload
  req?: PayloadRequest
  /** The Payload locales of the site. */
  locales: string[]
  /** Error text for a glue error (the endpoint passes the editor's language). */
  message: (err: FileGlueError) => string
}

/**
 * Reads a translated file and writes each job back. `TranslationFileError`s from `read` are
 * thrown (the whole file is unusable); problems with one job end up in that job's summary.
 */
export async function importFile(args: ImportArgs): Promise<FileImportJob[]> {
  const { content, includeChanged, locales, options, payload, req } = args
  const files = TranslationFiles.read(content)
  const allowedCollections = new Set(options.collections ?? [])
  const allowedGlobals = new Set(options.globals ?? [])
  const out: FileImportJob[] = []

  for (const file of files) {
    const ref = parseReference(file.reference)
    const base: FileImportJob = {
      item: ref ? (ref.kind === 'collection' ? `${ref.collection} ${ref.id}` : ref.global) : file.reference,
      targetLocale: ref?.targetLocale ?? file.targetLanguage,
    }
    try {
      if (file.plugin !== PLUGIN_NAME) throw new FileGlueError('other_system', { plugin: file.plugin })
      if (!ref) throw new FileGlueError('not_found')
      if (ref.kind === 'collection' ? !allowedCollections.has(ref.collection) : !allowedGlobals.has(ref.global)) {
        throw new FileGlueError('not_found')
      }
      for (const locale of [ref.targetLocale, ref.sourceLocale]) {
        if (!locales.includes(locale)) throw new FileGlueError('no_language', { language: locale })
      }

      const itemArgs: ItemArgs = ref.kind === 'collection'
        ? { collection: ref.collection, id: ref.id, options, payload, req }
        : { global: ref.global, options, payload, req }
      const item = await loadItem({ ...itemArgs, sourceLocale: ref.sourceLocale }).catch((err) => {
        throw statusOf(err) === 403 ? new FileGlueError('not_allowed') : new FileGlueError('not_found')
      })

      const { segments, updateData } = item.collect()
      const results = TranslationFiles.importTranslations(file, fileSegments(segments))
      const byKey = new Map<string, ImportedSegment>(results.map((r) => [r.key, r]))
      const target = await item.read(ref.targetLocale).catch(() => ({}) as Record<string, unknown>)

      const counts = { imported: 0, invalid: 0, missing: 0, sourceChanged: 0, untranslated: 0 }
      for (const seg of segments) {
        const r = byKey.get(seg.path)
        const write = r && (r.status === 'ok' || (r.status === 'source_changed' && includeChanged)) && r.text !== null
        if (write && applyText(seg, r.text as string)) {
          counts.imported++
          continue
        }
        if (write) counts.invalid++
        else if (r?.status === 'source_changed') counts.sourceChanged++
        else if (r?.status === 'untranslated') counts.untranslated++
        else if (r?.status === 'invalid_markup') counts.invalid++
        else if (r?.status === 'missing') counts.missing++
        // Not imported: keep what the target locale has there (else the source, as API translation does).
        keepTarget(seg, target)
      }

      if (counts.imported > 0) {
        await item.save(ref.targetLocale, updateData).catch((err) => {
          throw statusOf(err) === 403 ? new FileGlueError('not_allowed') : err
        })
      }
      out.push({ ...base, ...counts })
    } catch (err) {
      if (!(err instanceof FileGlueError)) payload.logger.error({ err }, `[supertext] import of ${file.reference} failed`)
      out.push({ ...base, error: err instanceof FileGlueError ? args.message(err) : err instanceof Error ? err.message : String(err) })
    }
  }
  return out
}

const statusOf = (err: unknown): number | undefined => (err as { status?: number } | null)?.status

/** Writes an imported translation into the segment's place in the update data. */
function applyText(seg: Segment, text: string): boolean {
  if (seg.apply) return seg.apply(text)
  ;(seg.holder as Record<number | string, unknown>)[seg.key] = seg.lead + text + seg.trail
  return true
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** Puts the target locale's current value back where a segment wasn't imported, if it has one there. */
function keepTarget(seg: Segment, target: Record<string, unknown>): void {
  const parts = seg.path.split('.')
  if (seg.apply) {
    // Rich text: `<field path>.root.<child index>...`, the indices walk Lexical `children`.
    const root = parts.lastIndexOf('root')
    let node: unknown = get(target, parts.slice(0, root + 1))
    for (const i of parts.slice(root + 1)) node = isObject(node) && Array.isArray(node.children) ? node.children[Number(i)] : undefined
    if (isObject(node) && Array.isArray(node.children)) {
      ;(seg.holder as Record<string, unknown>).children = structuredClone(node.children)
    }
    return
  }
  const value = get(target, parts)
  if (typeof value === 'string' && value !== '') (seg.holder as Record<number | string, unknown>)[seg.key] = value
}

function get(data: unknown, parts: string[]): unknown {
  let v = data
  for (const p of parts) v = isObject(v) ? (v as Record<string, unknown>)[p] : undefined
  return v
}

export { TranslationFileError }
