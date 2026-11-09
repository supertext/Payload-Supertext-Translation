'use client'

import {
  Button,
  toast,
  useConfig,
  useDocumentInfo,
  useFormModified,
  useLocale,
  useTranslation,
} from '@payloadcms/ui'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { SupertextI18nKey, supertextTranslations } from '../translations.js'
import type { FileImportJob, FileImportResponse, LocaleResult, StatusResponse, TranslateResponse } from '../types.js'

type Status = Pick<StatusResponse, 'apiKeyConfigured' | 'canTranslate' | 'locales'> & Partial<Pick<StatusResponse, 'languages'>>

type Mode = 'translate' | 'export' | 'import'

/** Same limit as the import endpoint, checked before the file is sent. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

/**
 * "Translate with Supertext" control in the document header. Translates the saved
 * version of the document in the current locale into the locales the editor picks,
 * exports it as an XLIFF or HTML file for translation elsewhere, or imports such a file.
 */
export function TranslateButton() {
  const { config } = useConfig()
  const { collectionSlug, globalSlug, id } = useDocumentInfo()
  const locale = useLocale()
  const modified = useFormModified()
  const { i18n, t } = useTranslation<(typeof supertextTranslations)['en'], SupertextI18nKey>()

  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [mode, setMode] = useState<Mode>('translate')
  const [format, setFormat] = useState<'xliff' | 'html'>('xliff')
  const [file, setFile] = useState<File | null>(null)
  const [includeChanged, setIncludeChanged] = useState(false)
  const [summary, setSummary] = useState<FileImportJob[] | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const api = `${config.serverURL ?? ''}${config.routes.api}`
  const localization = config.localization
  const sourceLocale = locale?.code ?? (localization ? localization.defaultLocale : '')

  const targets = useMemo(() => {
    if (!localization) return []
    return localization.locales
      .map((l) =>
        typeof l === 'string' ? { code: l, label: l } : { code: l.code, label: labelOf(l.label, l.code, i18n.language) },
      )
      .filter((l) => l.code !== sourceLocale)
  }, [localization, sourceLocale, i18n.language])

  useEffect(() => {
    let cancelled = false
    fetch(`${api}/supertext/status`, { credentials: 'include' })
      .then((r) => (r.ok ? (r.json() as Promise<Status>) : null))
      .then((s) => !cancelled && setStatus(s))
      .catch(() => !cancelled && setStatus(null))
    return () => {
      cancelled = true
    }
  }, [api])

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  if (!localization || targets.length === 0) return null
  if (status && !status.canTranslate) return null

  const unsaved = Boolean(collectionSlug) && !id
  const disabledReason = unsaved
    ? t('supertext:saveFirst')
    : mode === 'translate' && status && !status.apiKeyConfigured
      ? t('supertext:noApiKey')
      : modified
        ? t('supertext:unsavedChanges')
        : null

  // Locales without a Supertext language can't be chosen (the panel on the dashboard says how to map them).
  const unmapped = new Set((status?.languages ?? []).filter((l) => l.supertext === null).map((l) => l.locale))
  // Files may go to any translator: unmapped locales can be exported (with their Payload code).
  const blocked = (code: string) => mode === 'translate' && unmapped.has(code)
  const available = targets.filter((l) => !blocked(l.code))

  const toggle = (code: string) =>
    setSelected((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]))

  const run = async () => {
    setBusy(true)
    try {
      const res = await fetch(`${api}/supertext/translate`, {
        body: JSON.stringify({
          collection: collectionSlug,
          global: globalSlug,
          id,
          sourceLocale,
          targetLocales: selected,
        }),
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
      const data = (await res.json().catch(() => null)) as (TranslateResponse & { error?: string }) | null
      if (!data?.results) {
        toast.error(data?.error ?? t('supertext:failedHttp', { status: res.status }))
        return
      }
      reportResults(data.results, targets, t)
      if (data.results.every((r) => r.ok)) {
        setOpen(false)
        setSelected([])
      }
    } catch (err) {
      toast.error(t('supertext:serverUnreachable', { detail: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(false)
    }
  }

  const exportFile = async () => {
    setBusy(true)
    try {
      const res = await fetch(`${api}/supertext/export`, {
        body: JSON.stringify({ collection: collectionSlug, format, global: globalSlug, id, sourceLocale, targetLocales: selected }),
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null
        toast.error(data?.error ?? t('supertext:failedHttp', { status: res.status }))
        return
      }
      const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'supertext.xlf'
      const url = URL.createObjectURL(await res.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (err) {
      toast.error(t('supertext:serverUnreachable', { detail: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(false)
    }
  }

  const importFile = async () => {
    if (!file) return
    if (file.size > MAX_UPLOAD_BYTES) {
      toast.error(t('supertext:file_too_large'))
      return
    }
    setBusy(true)
    setSummary(null)
    try {
      const res = await fetch(`${api}/supertext/import${includeChanged ? '?includeChanged=1' : ''}`, {
        body: file,
        credentials: 'include',
        headers: { 'Content-Type': 'application/octet-stream' },
        method: 'POST',
      })
      const data = (await res.json().catch(() => null)) as (FileImportResponse & { error?: string }) | null
      if (!data?.jobs) {
        toast.error(data?.error ?? t('supertext:failedHttp', { status: res.status }))
        return
      }
      setSummary(data.jobs)
    } catch (err) {
      toast.error(t('supertext:serverUnreachable', { detail: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(false)
    }
  }

  const htmlInvalid = mode === 'export' && format === 'html' && selected.length !== 1
  const name = (code: string) => targets.find((l) => l.code === code)?.label ?? code

  return (
    <div ref={panelRef} style={{ position: 'relative' }}>
      <Button
        buttonStyle="secondary"
        disabled={busy}
        margin={false}
        onClick={() => setOpen((o) => !o)}
        size="medium"
        tooltip={disabledReason ?? undefined}
      >
        {busy ? t('supertext:translating') : t('supertext:translate')}
      </Button>
      {open && (
        <div
          role="dialog"
          aria-label={t('supertext:dialogTitle')}
          style={{
            background: 'var(--theme-elevation-0)',
            border: '1px solid var(--theme-elevation-150)',
            borderRadius: 'var(--style-radius-m, 4px)',
            boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
            minWidth: 260,
            padding: 16,
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 8px)',
            zIndex: 50,
          }}
        >
          <strong style={{ display: 'block', marginBottom: 8 }}>{t('supertext:dialogTitle')}</strong>
          <div role="tablist" style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
            {(['translate', 'export', 'import'] as const).map((m) => (
              <button
                aria-selected={mode === m}
                disabled={busy}
                key={m}
                onClick={() => setMode(m)}
                role="tab"
                style={{ ...linkStyle, fontWeight: mode === m ? 700 : 400, textDecoration: mode === m ? 'underline' : 'none' }}
                type="button"
              >
                {t(m === 'translate' ? 'supertext:translate' : m === 'export' ? 'supertext:exportTab' : 'supertext:importTab')}
              </button>
            ))}
          </div>
          {mode !== 'import' && (
          <>
          <p style={{ color: 'var(--theme-elevation-500)', fontSize: 13, margin: '0 0 12px' }}>
            {withBold(t('supertext:fromInto', { locale: MARK }), sourceLocale)}
          </p>
          {targets.map((target) => (
            <label key={target.code} style={{ alignItems: 'center', display: 'flex', gap: 8, marginBottom: 6 }}>
              <input
                checked={selected.includes(target.code)}
                disabled={busy || blocked(target.code)}
                onChange={() => toggle(target.code)}
                type="checkbox"
              />
              {target.label} <span style={{ color: 'var(--theme-elevation-500)' }}>({target.code})</span>
              {blocked(target.code) && (
                <span style={{ color: 'var(--theme-warning-500, #b26b00)', fontSize: 13 }}>
                  {t('supertext:noSupertextLanguage')}
                </span>
              )}
            </label>
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button type="button" disabled={busy} onClick={() => setSelected(available.map((t) => t.code))} style={linkStyle}>
              {t('supertext:all')}
            </button>
            <button type="button" disabled={busy} onClick={() => setSelected([])} style={linkStyle}>
              {t('supertext:none')}
            </button>
          </div>
          {disabledReason && (
            <p style={{ color: 'var(--theme-warning-500, #b26b00)', fontSize: 13, margin: '12px 0 0' }}>
              {disabledReason}
            </p>
          )}
          </>
          )}
          {mode === 'translate' && (
          <div style={{ marginTop: 12 }}>
            <Button
              buttonStyle="primary"
              disabled={busy || selected.length === 0 || unsaved || (status ? !status.apiKeyConfigured : false)}
              margin={false}
              onClick={run}
              size="medium"
            >
              {busy ? t('supertext:translatingLong') : t('supertext:translateInto', { count: selected.length || '…' })}
            </Button>
          </div>
          )}
          {mode === 'export' && (
            <div style={{ marginTop: 12 }}>
              <strong style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>{t('supertext:fileFormat')}</strong>
              {(['xliff', 'html'] as const).map((f) => (
                <label key={f} style={{ alignItems: 'center', display: 'flex', gap: 8, marginBottom: 4 }}>
                  <input checked={format === f} disabled={busy} name="supertext-format" onChange={() => setFormat(f)} type="radio" />
                  {t(f === 'xliff' ? 'supertext:formatXliff' : 'supertext:formatHtml')}
                </label>
              ))}
              {htmlInvalid && (
                <p style={{ color: 'var(--theme-warning-500, #b26b00)', fontSize: 13, margin: '4px 0 0' }}>{t('supertext:htmlOneLanguage')}</p>
              )}
              <div style={{ marginTop: 12 }}>
                <Button
                  buttonStyle="primary"
                  disabled={busy || selected.length === 0 || unsaved || htmlInvalid}
                  margin={false}
                  onClick={exportFile}
                  size="medium"
                >
                  {t('supertext:downloadFile')}
                </Button>
              </div>
            </div>
          )}
          {mode === 'import' && (
            <div>
              <label style={{ display: 'block', fontSize: 13, marginBottom: 8 }}>
                <strong style={{ display: 'block', marginBottom: 4 }}>{t('supertext:fileField')}</strong>
                <input
                  accept=".xlf,.xliff,.html,.htm,application/x-xliff+xml,text/html"
                  disabled={busy}
                  onChange={(e) => {
                    setFile(e.target.files?.[0] ?? null)
                    setSummary(null)
                  }}
                  type="file"
                />
              </label>
              <label style={{ alignItems: 'flex-start', display: 'flex', fontSize: 13, gap: 8, maxWidth: 320 }}>
                <input checked={includeChanged} disabled={busy} onChange={(e) => setIncludeChanged(e.target.checked)} type="checkbox" />
                {t('supertext:includeChanged')}
              </label>
              <div style={{ marginTop: 12 }}>
                <Button buttonStyle="primary" disabled={busy || !file} margin={false} onClick={importFile} size="medium">
                  {busy ? t('supertext:importing') : t('supertext:importTab')}
                </Button>
              </div>
              {summary && (
                <ul aria-live="polite" style={{ fontSize: 13, listStyle: 'none', margin: '12px 0 0', maxWidth: 360, padding: 0 }}>
                  {summary.map((job, i) => (
                    <li key={i} style={{ marginBottom: 8 }}>
                      <strong>
                        {job.item} → {name(job.targetLocale)}
                      </strong>
                      {job.error ? (
                        <div style={{ color: 'var(--theme-error-500, #b00020)' }}>{job.error}</div>
                      ) : (
                        <div>
                          <div>{t('supertext:summaryOk', { count: job.imported ?? 0 })}</div>
                          {(job.sourceChanged ?? 0) > 0 && <div>{t('supertext:summaryChanged', { count: job.sourceChanged })}</div>}
                          {(job.untranslated ?? 0) > 0 && <div>{t('supertext:summaryUntranslated', { count: job.untranslated })}</div>}
                          {(job.invalid ?? 0) > 0 && <div>{t('supertext:summaryInvalid', { count: job.invalid })}</div>}
                          {(job.missing ?? 0) > 0 && <div>{t('supertext:summaryMissing', { count: job.missing })}</div>}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const linkStyle = {
  background: 'none',
  border: 'none',
  color: 'var(--theme-elevation-800)',
  cursor: 'pointer',
  padding: 0,
  textDecoration: 'underline',
} as const

type T = (key: SupertextI18nKey, vars?: Record<string, unknown>) => string

/** Placeholder for the source locale, replaced by a bold element after translation. */
const MARK = '\u0000'

function withBold(text: string, value: string) {
  const [before, after = ''] = text.split(MARK)
  return (
    <>
      {before}
      <b>{value}</b>
      {after}
    </>
  )
}

/** Locale label in the admin language (labels may be `{ en: 'German', de: 'Deutsch' }`). */
function labelOf(label: unknown, fallback: string, language: string): string {
  if (typeof label === 'string') return label
  if (label && typeof label === 'object') {
    const labels = label as Record<string, unknown>
    const value = labels[language] ?? Object.values(labels)[0]
    if (typeof value === 'string') return value
  }
  return fallback
}

function reportResults(results: LocaleResult[], targets: { code: string; label: string }[], t: T) {
  const name = (code: string) => targets.find((t) => t.code === code)?.label ?? code
  const ok = results.filter((r) => r.ok)
  const failed = results.filter((r): r is Extract<LocaleResult, { ok: false }> => !r.ok)
  if (ok.length > 0) {
    const partial = ok.filter((r) => r.ok && r.missing.length > 0)
    toast.success(
      t('supertext:translatedInto', { locales: ok.map((r) => name(r.locale)).join(', ') }) +
        (partial.length > 0 ? ` ${t('supertext:partlyEmpty')}` : ''),
    )
  }
  for (const f of failed) toast.error(`${name(f.locale)}: ${f.error}`)
}
