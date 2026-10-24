/**
 * Video stream download and cache for frame capture.
 *
 * Frame capture reads a local file when the video can be downloaded and the
 * remote playurl URL otherwise; this module owns the local path. Downloads are
 * bounded twice: the declared content length is checked before the read, and an
 * in-flight byte counter stops a chunked response that lies about its size. The
 * body is written to `<dest>.part` and renamed only after the last chunk, so an
 * interrupted download never looks like a finished one.
 *
 * Nothing here spawns a process, so it has no pipe surface to trip the confined
 * Windows sandbox.
 *
 * @module dsh-bilibili-pro/video
 */

import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { BROWSER_UA } from './http.js'

/** How long a downloaded video stays reusable, in milliseconds. */
export const VIDEO_CACHE_TTL_MS = 24 * 3600 * 1000

/** Download cap used when the caller names none. */
const DEFAULT_MAX_BYTES = 1500 * 1024 * 1024

/** Whole-download budget used when the caller names none. */
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Guess a file extension from a playurl direct link.
 * @param url - stream URL.
 * @returns `.m3u8`, `.mp4`, or the `.flv` default.
 */
export function guessStreamExt(url) {
  const text = String(url ?? '')
  if (/\.m3u8(\?|$)/i.test(text)) return '.m3u8'
  if (/\.mp4(\?|$)/i.test(text)) return '.mp4'
  // Fragmented MP4: the init segment plus media segments are one fetchable file.
  if (/\.m4s(\?|$)/i.test(text)) return '.mp4'
  if (/\.flv(\?|$)/i.test(text)) return '.flv'
  return '.flv'
}

/**
 * Build the per-page cache tag.
 * @param pageCount - pages in the video.
 * @param page - selected one-based page.
 * @returns '' for a single-page video, otherwise `p<page>`.
 */
export function partFileTag(pageCount, page) {
  if (!(Number(pageCount) > 1)) return ''
  const number = Number(page)
  return Number.isFinite(number) && number > 0 ? `p${number}` : 'p1'
}

/**
 * Build a cached video's file name.
 * @param pageTag - output of {@link partFileTag}.
 * @param ext - extension, with or without a leading dot; '' yields the cache prefix.
 * @returns `video<ext>` or `video_<pageTag><ext>`.
 */
export function videoFileName(pageTag, ext) {
  const tag = String(pageTag ?? '')
  const raw = String(ext ?? '.mp4')
  const suffix = raw === '' ? '' : raw.startsWith('.') ? raw : `.${raw}`
  return `video${tag ? `_${tag}` : ''}${suffix}`
}

/**
 * Find a fresh cached video, removing stale copies on the way.
 *
 * Only `video[_pN].<ext>` names for the requested page are considered: without
 * that check a single-page lookup would also match another part's
 * `video_p4.mp4` and silently capture the wrong part.
 *
 * @param outDir - bundle directory.
 * @param pageTag - output of {@link partFileTag}.
 * @param options - optional `ttlMs` override.
 * @returns the cached path, or null.
 */
export async function findCachedVideo(outDir, pageTag = '', options = {}) {
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : VIDEO_CACHE_TTL_MS
  let names
  try {
    names = await readdir(outDir)
  } catch {
    return null
  }
  const prefix = videoFileName(pageTag, '')
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    // Accept only finished video files. This keeps the downloader's fresh
    // `<dest>.part` from being mistaken for a cache hit after an interrupted
    // run, and rejects directories and unrelated suffixes as well.
    if (!/^\.(?:mp4|m3u8|flv)$/i.test(name.slice(prefix.length))) continue
    const path = join(outDir, name)
    try {
      const info = await stat(path)
      if (!info.isFile()) continue
      if (Date.now() - info.mtimeMs < ttlMs) return path
      await rm(path, { force: true })
    } catch {
      // The file vanished between readdir and stat; keep looking.
    }
  }
  return null
}

/**
 * Download one stream to `dest` atomically.
 *
 * @param options - url, dest, maxBytes, headers, referer, cookie, timeoutMs, signal.
 * @returns the written path and byte count.
 */
export async function downloadStream(options) {
  if (typeof options?.url !== 'string' || options.url.length === 0) {
    throw new Error('downloadStream needs a stream URL')
  }
  if (typeof options?.dest !== 'string' || options.dest.length === 0) {
    throw new Error('downloadStream needs a destination path')
  }
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : DEFAULT_MAX_BYTES
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_DOWNLOAD_TIMEOUT_MS
  const partPath = `${options.dest}.part`
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const headers = {
    'User-Agent': BROWSER_UA,
    Accept: '*/*',
    ...(options.referer ? { Referer: options.referer } : {}),
    ...(options.cookie ? { Cookie: options.cookie } : {}),
    ...(options.headers ?? {}),
  }
  await mkdir(dirname(options.dest), { recursive: true })
  // Drop a `.part` left behind by a crashed run before any network work.
  await rm(partPath, { force: true }).catch(() => {})
  let response
  try {
    response = await fetch(options.url, { headers, redirect: 'follow', signal })
  } catch (error) {
    if (options.signal?.aborted) throw error
    throw new Error(`video download request failed: ${error?.message ?? error}`)
  }
  if (!response.ok || !response.body) {
    if (response.body) await response.body.cancel().catch(() => {})
    throw new Error(`video download failed: HTTP ${response.status}`)
  }
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body.cancel().catch(() => {})
    throw new Error(
      `video is too large (${Math.round(declared / 1048576)} MB > ${Math.round(maxBytes / 1048576)} MB cap)`,
    )
  }
  let handle = await open(partPath, 'w').catch(async (error) => {
    await response.body.cancel().catch(() => {})
    throw error
  })
  let total = 0
  let reader
  try {
    reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        throw new Error(`video download exceeded the ${Math.round(maxBytes / 1048576)} MB cap`)
      }
      await handle.write(Buffer.from(value))
    }
    await handle.close()
    handle = undefined
    await rename(partPath, options.dest)
    return { path: options.dest, bytes: total }
  } catch (error) {
    // Release the body before removing the temp file: abandoning a locked
    // ReadableStream leaves its socket open in a long-lived process.
    if (reader) await reader.cancel().catch(() => {})
    if (handle) await handle.close().catch(() => {})
    await rm(partPath, { force: true }).catch(() => {})
    throw error instanceof Error ? error : new Error(String(error))
  }
}

/**
 * Ensure a local copy of the video exists: reuse a fresh cache entry, otherwise
 * download the stream to `<outDir>/video[_pN].<ext>`.
 *
 * Deletion policy belongs to the caller (`keep_video`), so this never removes a
 * file it returns.
 *
 * @param options - outDir, url, pageTag, maxBytes, ttlMs, headers, timeoutMs, signal.
 * @returns path, byte size, and whether the cache was reused.
 */
export async function ensureVideo(options) {
  if (typeof options?.outDir !== 'string' || options.outDir.length === 0) {
    throw new Error('ensureVideo needs an output directory')
  }
  const pageTag = String(options.pageTag ?? '')
  const cached = await findCachedVideo(options.outDir, pageTag, { ttlMs: options.ttlMs })
  if (cached) {
    const info = await stat(cached).catch(() => null)
    return { path: cached, bytes: info?.size ?? 0, reused: true }
  }
  const dest = join(options.outDir, videoFileName(pageTag, guessStreamExt(options.url)))
  const downloaded = await downloadStream({ ...options, dest })
  return { path: downloaded.path, bytes: downloaded.bytes, reused: false }
}
