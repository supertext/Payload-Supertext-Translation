import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_NAME = 'payload-supertext-translation'
/** The plugin's GitHub repository name (the center reads its releases from there). */
export const PLUGIN_NAME = 'Payload-Supertext-Translation'

const readVersion = (file: string, name: string): string | null => {
  try {
    if (!existsSync(file)) return null
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: unknown; version?: unknown }
    return pkg.name === name && typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

/** Looks for `<name>`'s package.json in `start` and its parents. */
function searchUp(start: string, name: string): string | null {
  for (let dir = start, i = 0; i < 8; i++) {
    const version = readVersion(join(dir, 'package.json'), name)
    if (version) return version
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** `<name>`'s package.json next to the running app (`<cwd>/node_modules/<name>`, or resolved from there). */
function fromApp(name: string): string | null {
  const direct = readVersion(join(process.cwd(), 'node_modules', name, 'package.json'), name)
  if (direct) return direct
  try {
    const entry = createRequire(join(process.cwd(), 'package.json')).resolve(name)
    return searchUp(dirname(entry), name)
  } catch {
    return null
  }
}

const cache = new Map<string, string | null>()

const cached = (name: string, find: () => string | null): string | null => {
  if (!cache.has(name)) {
    let version: string | null = null
    try {
      version = find()
    } catch {
      version = null
    }
    cache.set(name, version)
  }
  return cache.get(name) ?? null
}

/**
 * The plugin's version, read at runtime from its own package.json (its only official
 * source): `../package.json` next to src/ (tests) or dist/ (installed; bundlers inline it),
 * else searched upwards, else from the app's node_modules. Null if it can't be found.
 */
export function pluginVersion(): string | null {
  return cached(PACKAGE_NAME, () => {
    // Bundlers (webpack, Turbopack) resolve `createRequire(import.meta.url)` and inline the JSON.
    try {
      const pkg = createRequire(import.meta.url)('../package.json') as { name?: unknown; version?: unknown }
      if (pkg?.name === PACKAGE_NAME && typeof pkg.version === 'string') return pkg.version
    } catch {
      // not resolvable from here: search the file system
    }
    let here: string | null = null
    try {
      here = dirname(fileURLToPath(import.meta.url))
    } catch {
      here = null
    }
    return (here ? searchUp(here, PACKAGE_NAME) : null) ?? fromApp(PACKAGE_NAME)
  })
}

/** User-Agent of the plugin's requests to Supertext: `Payload-Supertext-Translation/<version>`. */
export function userAgent(): string {
  return `${PLUGIN_NAME}/${pluginVersion() ?? '0.0.0'}`
}

/** The installed Payload version (its package.json in the app), or null. */
export function payloadVersion(): string | null {
  return cached('payload', () => fromApp('payload'))
}

/** GitHub release page of a version, or null when it isn't a plain X.Y.Z version. */
export function releaseUrl(version: string | null): string | null {
  return version && /^\d+\.\d+\.\d+$/.test(version)
    ? `https://github.com/Supertext/Payload-Supertext-Translation/releases/tag/v${version}`
    : null
}
