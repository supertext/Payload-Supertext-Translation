'use client'

import { Button, useConfig, useTranslation } from '@payloadcms/ui'
import { Fragment, useEffect, useState, type ReactNode } from 'react'

import type { SupertextI18nKey, supertextTranslations } from '../translations.js'
import type { KeyCheckStatus, StatusResponse } from '../types.js'

const SIGNUP_URL = 'https://www.supertext.com/person/en/account/signin'
const API_KEY_URL = 'https://www.supertext.com/en/integrations/api'

/**
 * Supertext panel on the admin dashboard: plugin version, the latest API key check (with
 * "Check again"), how each locale is sent to Supertext (with a link to the *Supertext settings*,
 * where the language mapping is chosen), and the version-report setting. The other settings are
 * code (plugin options, environment variables), so this panel only shows them.
 */
export function SupertextStatus() {
  const { config } = useConfig()
  const { i18n, t } = useTranslation<(typeof supertextTranslations)['en'], SupertextI18nKey>()
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [checking, setChecking] = useState(false)

  const api = `${config.serverURL ?? ''}${config.routes.api}`

  useEffect(() => {
    let cancelled = false
    fetch(`${api}/supertext/status`, { credentials: 'include' })
      .then((r) => (r.ok ? (r.json() as Promise<StatusResponse>) : null))
      .then((s) => !cancelled && setStatus(s))
      .catch(() => !cancelled && setStatus(null))
    return () => {
      cancelled = true
    }
  }, [api])

  if (!status || !status.canTranslate) return null

  const checkAgain = async () => {
    setChecking(true)
    try {
      const res = await fetch(`${api}/supertext/check-key`, { credentials: 'include', method: 'POST' })
      const data = (await res.json().catch(() => null)) as { keyCheck?: KeyCheckStatus | null } | null
      if (data && 'keyCheck' in data) setStatus((s) => (s ? { ...s, keyCheck: data.keyCheck ?? null } : s))
    } finally {
      setChecking(false)
    }
  }

  const check = status.keyCheck
  const muted = { color: 'var(--theme-elevation-500)' } as const

  return (
    <section
      aria-labelledby="supertext-status-title"
      className="supertext-status"
      style={{
        border: '1px solid var(--theme-elevation-150)',
        borderRadius: 'var(--style-radius-m, 4px)',
        margin: 'calc(var(--base) * 2) 0',
        maxWidth: 760,
        padding: 'calc(var(--base) * 1.5)',
      }}
    >
      <h2 id="supertext-status-title" style={{ margin: '0 0 4px' }}>
        {t('supertext:statusTitle')}
      </h2>
      <p style={{ ...muted, margin: '0 0 16px' }}>
        {status.releaseUrl ? (
          <a href={status.releaseUrl} rel="noopener" target="_blank">
            {t('supertext:statusVersion', { version: status.version })}
          </a>
        ) : (
          t('supertext:statusVersion', { version: status.version ?? '?' })
        )}
        {' · SDK '}
        {status.sdkVersion}
      </p>

      <h3 style={{ margin: '0 0 4px' }}>{t('supertext:statusApiKey')}</h3>
      {check ? (
        <>
          <p
            data-status={check.status}
            style={{ color: check.status === 'ok' ? 'var(--theme-success-500, #1a7f37)' : 'var(--theme-error-500, #c62828)', margin: 0 }}
          >
            {withLinks(t(`supertext:keycheck_${check.status}` as SupertextI18nKey, { status: check.httpStatus ?? '' }))}
          </p>
          <p style={{ ...muted, fontSize: 13, margin: '4px 0 0' }}>
            {t('supertext:checkedAt', { time: formatTime(check.checkedAt, i18n.language) })}
          </p>
        </>
      ) : (
        <p style={{ margin: 0 }}>{status.apiKeyConfigured ? t('supertext:notChecked') : withLinks(t('supertext:keycheck_missing'))}</p>
      )}
      <div style={{ margin: '8px 0 16px' }}>
        <Button buttonStyle="secondary" disabled={checking} margin={false} onClick={checkAgain} size="small">
          {checking ? t('supertext:checking') : t('supertext:checkAgain')}
        </Button>
      </div>

      <h3 style={{ margin: '0 0 4px' }}>{t('supertext:statusLanguages')}</h3>
      <table style={{ borderCollapse: 'collapse', margin: '0 0 16px' }}>
        <thead>
          <tr>
            <th style={cell}>{t('supertext:statusLocale')}</th>
            <th style={cell}>{t('supertext:statusCode')}</th>
          </tr>
        </thead>
        <tbody>
          {status.languages.map((l) => (
            <tr data-locale={l.locale} key={l.locale}>
              <td style={cell}>
                <code>{l.locale}</code>
              </td>
              <td style={cell}>
                {l.supertext ? (
                  <>
                    <code>{l.supertext}</code>
                    {l.origin && <span style={muted}> · {t(ORIGIN[l.origin])}</span>}
                  </>
                ) : (
                  <span style={{ color: 'var(--theme-warning-500, #b26b00)' }}>{t('supertext:notMapped')}</span>
                )}
                {l.politeness !== 'default' && <span style={muted}> ({l.politeness})</span>}
                {!l.politenessSupported && (
                  <div style={{ color: 'var(--theme-warning-500, #b26b00)', fontSize: 13 }}>{t('supertext:noPoliteness')}</div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ margin: '-8px 0 16px' }}>
        <a href={status.settingsUrl}>{t('supertext:settingsLink')}</a>
      </p>

      <h3 style={{ margin: '0 0 4px' }}>{t('supertext:reportsLabel')}</h3>
      <p style={{ margin: 0 }}>{status.reports.enabled ? t('supertext:reportsOn') : t('supertext:reportsOff')}</p>
      <p style={{ ...muted, fontSize: 13, margin: '4px 0 0' }}>{t('supertext:reportsHelp')}</p>
      {status.reports.pingUrl && (
        <p style={{ ...muted, fontSize: 13, margin: '4px 0 0' }}>{t('supertext:pingUrl', { url: status.reports.pingUrl })}</p>
      )}
    </section>
  )
}

const ORIGIN = {
  automatic: 'supertext:originAutomatic',
  option: 'supertext:originOption',
  settings: 'supertext:originSettings',
} as const

const cell = {
  borderBottom: '1px solid var(--theme-elevation-100)',
  padding: '4px 16px 4px 0',
  textAlign: 'left',
  verticalAlign: 'top',
} as const

const formatTime = (iso: string, language: string): string => {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  try {
    return date.toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return date.toISOString()
  }
}

/** Links "supertext.com → Integrations → API" to the API key page and "supertext.com" to the sign-in page (new tab). */
export function withLinks(text: string): ReactNode {
  const parts = text.split(/(supertext\.com → Integrations → API|supertext\.com)/)
  return parts.map((part, i) => {
    if (part === 'supertext.com → Integrations → API' || part === 'supertext.com') {
      return (
        <a href={part === 'supertext.com' ? SIGNUP_URL : API_KEY_URL} key={i} rel="noopener" target="_blank">
          {part}
        </a>
      )
    }
    return <Fragment key={i}>{part}</Fragment>
  })
}
