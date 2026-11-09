import type { Config, CustomComponent } from 'payload'

import { createEndpoints } from './endpoints.js'
import { withSupertextTranslations } from './i18n.js'
import { settingsGlobal } from './settings.js'
import type { SupertextTranslationOptions } from './types.js'

export { collectSegments, isOptedOut } from './collect.js'
export { createClient, ENDPOINT_BASE, resolveReviewUrl } from './endpoints.js'
export { exportItem, formatReference, importFile, MAX_UPLOAD_BYTES, parseReference } from './files.js'
export type { ExportedFile, FileFormat, ItemReference } from './files.js'
export { sourceCode, SUPERTEXT_TARGETS, targetCode } from './languages.js'
export { PING_PATH, PLUGIN_NAME, Reporting } from './reporting.js'
export { applyTranslations, buildHtml, parseHtml } from './segments.js'
export { loadSettings, SETTINGS_SLUG, settingsGlobal } from './settings.js'
export { REVIEW_URL, SUPERTEXT_ENVIRONMENTS, SupertextClient, SupertextError } from './supertext/client.js'
export type { Politeness, SupertextEnvironment, SupertextErrorCode } from './supertext/client.js'
export { translateDocument } from './translate.js'
export { SUPERTEXT_I18N_NAMESPACE, supertextTranslations } from './translations.js'
export type { SupertextTranslationKey } from './translations.js'
export type {
  FileExportRequestBody,
  FileImportJob,
  FileImportResponse,
  KeyCheckStatus,
  LanguageStatus,
  LocaleResult,
  StatusResponse,
  SupertextTranslationOptions,
  TranslateRequestBody,
  TranslateResponse,
} from './types.js'

/** Import-map path of the admin panel component (run `payload generate:importmap` after adding the plugin). */
export const TRANSLATE_BUTTON_PATH = 'payload-supertext-translation/client#TranslateButton'

/** Import-map path of the dashboard panel (version, API key check, languages, version reports). */
export const STATUS_PANEL_PATH = 'payload-supertext-translation/client#SupertextStatus'

const button: CustomComponent = { path: TRANSLATE_BUTTON_PATH }

/**
 * Payload 3 plugin: adds a "Translate with Supertext" control to the edit view of the
 * configured collections and globals, the `/api/supertext/*` endpoints behind it, and the
 * *Supertext settings* global (one language combo box per locale).
 *
 * ```ts
 * plugins: [supertextTranslation({ collections: ['pages', 'posts'], globals: ['header'] })]
 * ```
 */
export const supertextTranslation =
  (options: SupertextTranslationOptions = {}) =>
  (incoming: Config): Config => {
    // The settings global stays when disabled (hidden), so the database schema doesn't change.
    const settings = settingsGlobal(incoming.localization, options)
    if (options.disabled) return { ...incoming, globals: [...(incoming.globals ?? []), settings] }

    const collectionSlugs = new Set<string>(options.collections ?? [])
    const globalSlugs = new Set<string>(options.globals ?? [])

    const admin =
      options.dashboardPanel === false
        ? incoming.admin
        : {
            ...incoming.admin,
            components: {
              ...incoming.admin?.components,
              afterDashboard: [...(incoming.admin?.components?.afterDashboard ?? []), { path: STATUS_PANEL_PATH }],
            },
          }

    return {
      ...incoming,
      admin,
      collections: (incoming.collections ?? []).map((collection) =>
        collectionSlugs.has(collection.slug)
          ? {
              ...collection,
              admin: {
                ...collection.admin,
                components: {
                  ...collection.admin?.components,
                  edit: {
                    ...collection.admin?.components?.edit,
                    beforeDocumentControls: [
                      ...(collection.admin?.components?.edit?.beforeDocumentControls ?? []),
                      button,
                    ],
                  },
                },
              },
            }
          : collection,
      ),
      endpoints: [...(incoming.endpoints ?? []), ...createEndpoints(options)],
      i18n: withSupertextTranslations(incoming.i18n),
      globals: [
        ...(incoming.globals ?? []).map((global) =>
        globalSlugs.has(global.slug)
          ? {
              ...global,
              admin: {
                ...global.admin,
                components: {
                  ...global.admin?.components,
                  elements: {
                    ...global.admin?.components?.elements,
                    beforeDocumentControls: [
                      ...(global.admin?.components?.elements?.beforeDocumentControls ?? []),
                      button,
                    ],
                  },
                },
              },
            }
          : global,
        ),
        settings,
      ],
    }
  }

export default supertextTranslation
