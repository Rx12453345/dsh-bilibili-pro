/**
 * Bilibili credential storage.
 *
 * A signed-in `SESSDATA` is what unlocks the AI subtitle track. This module
 * resolves credentials from, in order: an explicit value, the process
 * environment, `$DSH_HOME/.env`, then the cookie file the QR sign-in writes.
 * The file holds the whole cookie jar, so `bili_jct`, `DedeUserID`, `buvid3`
 * and friends survive too.
 *
 * The stored jar is returned even when it has no session cookie: anonymous
 * device ids (`buvid3`/`buvid4`) improve survival under Bilibili's risk
 * control, and callers decide for themselves whether a signed-in session is
 * required. {@link ensureDeviceId} fills in those device ids when the file has
 * none.
 *
 * @module dsh-bilibili-pro/cookies
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { BROWSER_UA } from './http.js'

/** Cookie names kept from a sign-in response; anything else is dropped. */
export const KEPT_COOKIES = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid', 'buvid3', 'buvid4']

/** Endpoint that issues the anonymous device ids. */
export const DEVICE_ID_API = 'https://api.bilibili.com/x/frontend/finger/spi'

/** Per-file cache of the in-flight device-id lookup. */
const deviceIdCache = new Map()

/**
 * Resolve the DSH home directory.
 * @returns the configured home, or `~/.dsh`.
 */
export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/**
 * Default credential location.
 * @returns the absolute cookie-file path.
 */
export function defaultCookieFile() {
  return join(dshHome(), 'bilibili-cookies.json')
}

/**
 * Read one `KEY=value` entry from `$DSH_HOME/.env`.
 * @param key - variable name.
 * @returns the trimmed value, or undefined when absent.
 */
export function readDshEnv(key) {
  let text
  try {
    text = readFileSync(join(dshHome(), '.env'), 'utf8')
  } catch {
    return undefined
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (match && match[1] === key) return match[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return undefined
}

/**
 * Resolve the cookie file every credential reader and writer must share.
 *
 * An explicit option wins, then `process.env.BILIBILI_COOKIE_FILE`, then
 * `$DSH_HOME/.env`, then the default location. Reading and writing through the
 * same resolver is what keeps a QR login from writing the default file while
 * requests read an environment-selected one.
 *
 * @param options - optional `cookieFile` override.
 * @returns the absolute cookie-file path.
 */
export function resolveCookieFile(options = {}) {
  const explicit = typeof options?.cookieFile === 'string' ? options.cookieFile.trim() : ''
  if (explicit) return explicit
  const fromProcess = typeof process.env.BILIBILI_COOKIE_FILE === 'string' ? process.env.BILIBILI_COOKIE_FILE.trim() : ''
  if (fromProcess) return fromProcess
  return readDshEnv('BILIBILI_COOKIE_FILE') || defaultCookieFile()
}

/**
 * Render a cookie map as one `Cookie` header value.
 * @param cookies - cookie name/value pairs.
 * @returns the header value, or an empty string.
 */
export function cookieHeader(cookies) {
  return Object.entries(cookies ?? {})
    .filter(([, value]) => typeof value === 'string' && value.length > 0)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

/**
 * Keep only the cookies this plugin cares about.
 * @param cookies - raw cookie map.
 * @returns the filtered map.
 */
export function pickCookies(cookies) {
  const kept = {}
  for (const name of KEPT_COOKIES) {
    const value = cookies?.[name]
    if (typeof value === 'string' && value.length > 0) kept[name] = value
  }
  for (const [name, value] of Object.entries(cookies ?? {})) {
    if (name.startsWith('buvid') && !kept[name]) kept[name] = value
  }
  return kept
}

/**
 * Read the stored credential record.
 * @param file - cookie-file path.
 * @returns the parsed record, or undefined when missing or malformed.
 */
export function readCookieFile(file = defaultCookieFile()) {
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return undefined
    const cookies = typeof parsed.cookies === 'object' && parsed.cookies !== null ? parsed.cookies : {}
    return { savedAt: parsed.savedAt, source: parsed.source, user: parsed.user, cookies: pickCookies(cookies) }
  } catch {
    return undefined
  }
}

/**
 * Resolve the credential a request should use.
 *
 * A stored record is returned as-is; a session cookie is no longer a
 * precondition. `loggedIn` reports whether the jar carries one, so each caller
 * can decide whether it needs a signed-in session.
 *
 * @param options - explicit `sessdata` and `cookieFile` overrides.
 * @returns the cookie map, where it came from, and whether a session exists.
 */
export function loadCredentials(options = {}) {
  const file = resolveCookieFile(options)
  const explicit = options.sessdata || process.env.BILIBILI_SESSDATA || readDshEnv('BILIBILI_SESSDATA')
  const stored = readCookieFile(file)
  if (explicit) {
    const cookies = { ...(stored?.cookies ?? {}), SESSDATA: explicit }
    return {
      cookies,
      source: 'config',
      file,
      user: stored?.user,
      savedAt: stored?.savedAt,
      loggedIn: true,
    }
  }
  if (stored) {
    return {
      cookies: stored.cookies,
      source: stored.source ?? 'file',
      file,
      user: stored.user,
      savedAt: stored.savedAt,
      loggedIn: Boolean(stored.cookies.SESSDATA),
    }
  }
  return { cookies: {}, source: 'none', file, loggedIn: false }
}

/**
 * Persist a signed-in cookie jar.
 *
 * The options shape is validated instead of guessed: a call like
 * `saveCookieFile(somePath, cookies)` used to silently write an empty jar to
 * the default file. The two-argument form is supported as an explicit manual
 * import, but every other shape must name its `cookies` map and its `source`.
 *
 * @param options - `{ cookies, source, file?, user? }`, or a `(file, cookies)`
 *   pair as a manual import.
 * @returns the written path and record.
 */
export function saveCookieFile(options, legacyCookies) {
  let candidate = options
  if (typeof options === 'string' && arguments.length >= 2) {
    candidate = { file: options, cookies: legacyCookies, source: 'manual' }
  }
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new TypeError('saveCookieFile needs an options object with a cookies map')
  }
  if (candidate.cookies === null || typeof candidate.cookies !== 'object' || Array.isArray(candidate.cookies)) {
    throw new TypeError('saveCookieFile needs options.cookies to be a cookie map')
  }
  const source = candidate.source
  if (typeof source !== 'string' || source.length === 0) {
    throw new TypeError(
      'saveCookieFile needs an explicit source (for example "qrcode" or "manual"); it is not guessed',
    )
  }
  const file = candidate.file || resolveCookieFile(candidate)
  mkdirSync(dirname(file), { recursive: true })
  const record = {
    savedAt: new Date().toISOString(),
    source,
    user: candidate.user,
    cookies: pickCookies(candidate.cookies),
  }
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  try {
    chmodSync(file, 0o600)
  } catch {
    // Permission tightening is best-effort; the file still works.
  }
  return { file, record }
}

/**
 * Fetch the anonymous device ids Bilibili hands to a fresh web client.
 *
 * The lookup is cached per cookie-file path as an in-flight promise, so a
 * process issues at most one request. It never sends the stored cookie jar and
 * never throws: a network failure returns undefined and the caller keeps its
 * existing credentials.
 *
 * @param file - cookie-file path, used as the cache key.
 * @param options - `fetchImpl`, `signal`, `timeoutMs`.
 * @returns `{ buvid3? , buvid4? }`, or undefined.
 */
function fetchDeviceIds(file, options) {
  const cached = deviceIdCache.get(file)
  if (cached) return cached
  const promise = (async () => {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') return undefined
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 10_000
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = options.signal
      ? typeof AbortSignal.any === 'function'
        ? AbortSignal.any([options.signal, timeout])
        : options.signal
      : timeout
    try {
      const response = await fetchImpl(DEVICE_ID_API, {
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          Referer: 'https://www.bilibili.com/',
        },
        signal,
      })
      if (!response?.ok) return undefined
      const payload = await response.json()
      if (payload?.code !== 0) return undefined
      const buvid3 = typeof payload?.data?.b_3 === 'string' ? payload.data.b_3.trim() : ''
      const buvid4 = typeof payload?.data?.b_4 === 'string' ? payload.data.b_4.trim() : ''
      if (!buvid3 && !buvid4) return undefined
      return { ...(buvid3 ? { buvid3 } : {}), ...(buvid4 ? { buvid4 } : {}) }
    } catch {
      return undefined
    }
  })()
  deviceIdCache.set(file, promise)
  // Do not cache a failed lookup: a later tool call may retry it. Successful
  // promises stay cached for the lifetime of the process.
  promise.then((ids) => {
    if (!ids) deviceIdCache.delete(file)
  })
  return promise
}

/**
 * Ensure the credential jar carries the anonymous device ids.
 *
 * The SPI ids are merged into the stored jar and written back with `0600`,
 * preserving the record's `savedAt`/`source`/`user` and every cookie already
 * there (including `SESSDATA`). Persisting is best-effort; a failure still
 * returns the credentials with the ids attached for the current process.
 *
 * @param options - `cookieFile`, `sessdata`, `fetchImpl`, `signal`, `timeoutMs`.
 * @returns the credentials record from {@link loadCredentials}.
 */
export async function ensureDeviceId(options = {}) {
  const credentials = loadCredentials(options)
  if (credentials.cookies.buvid3 && credentials.cookies.buvid4) return credentials
  const ids = await fetchDeviceIds(resolveCookieFile(options), options)
  if (!ids) return credentials
  const cookies = { ...credentials.cookies }
  let changed = false
  if (!cookies.buvid3 && ids.buvid3) {
    cookies.buvid3 = ids.buvid3
    changed = true
  }
  if (!cookies.buvid4 && ids.buvid4) {
    cookies.buvid4 = ids.buvid4
    changed = true
  }
  if (!changed) return credentials
  const file = credentials.file
  const stored = readCookieFile(file)
  // Persist the on-disk jar plus the device ids. An explicit `sessdata` option
  // is a request credential supplied by the caller (environment or config); it
  // is never copied into the cookie file here, so a configured session does not
  // silently become a persisted one.
  const jar = { ...(stored?.cookies ?? {}) }
  if (!jar.buvid3 && ids.buvid3) jar.buvid3 = ids.buvid3
  if (!jar.buvid4 && ids.buvid4) jar.buvid4 = ids.buvid4
  const merged = { ...credentials.cookies }
  if (!merged.buvid3 && ids.buvid3) merged.buvid3 = ids.buvid3
  if (!merged.buvid4 && ids.buvid4) merged.buvid4 = ids.buvid4
  const record = {
    savedAt: stored?.savedAt ?? new Date().toISOString(),
    source: stored?.source ?? 'device',
    user: stored?.user,
    cookies: pickCookies(jar),
  }
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    try {
      chmodSync(file, 0o600)
    } catch {
      // Best-effort on platforms without POSIX modes.
    }
  } catch {
    // A read-only home must not turn into a failed tool call.
  }
  return {
    ...credentials,
    cookies: pickCookies(merged),
    savedAt: record.savedAt,
    source: credentials.source === 'none' ? record.source : credentials.source,
  }
}

/**
 * Delete the stored credential.
 * @param file - cookie-file path.
 * @returns true when a file was removed.
 */
export function clearCookieFile(file = defaultCookieFile()) {
  if (!existsSync(file)) return false
  rmSync(file, { force: true })
  return true
}
