/**
 * Disk-backed transcript bundles.
 *
 * The full transcript always lives on disk, so a long video never has to fit
 * in one tool result. Layout:
 *
 * ```
 * <outDir>/<BVID>/                    page 1
 *   meta.json
 *   transcript.json
 *   transcript.md
 *   parts/index.json
 *   parts/part-001.md
 *   parts/part-001.json
 * <outDir>/<BVID>/p<N>/               page N > 1
 *   ...
 * ```
 *
 * Synchronous fs calls keep the write path small and deterministic; these
 * files are written once per extraction, not on a hot path.
 *
 * @module dsh-bilibili-pro/store
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  buildPartMarkdown,
  buildTranscriptManifest,
  buildTranscriptMarkdown,
  toPlainText,
} from './transcript.js'

/** Default packing used when a caller does not pass one. */
const DEFAULT_PACKING = { maxChars: 6000, maxSeconds: 600 }

/**
 * Reject a bundle id that could escape the output directory.
 * @param bvid - validated BV id (fixtures may use a plain token).
 */
function assertBvid(bvid) {
  if (typeof bvid !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(bvid)) {
    throw new Error(`invalid bvid for the transcript bundle: ${JSON.stringify(bvid)}`)
  }
}

/**
 * Normalize a page argument that may be an entry object or a bare number.
 * @param page - page entry or number.
 * @returns a positive integer page number.
 */
function pageNumberOf(page) {
  const value = page && typeof page === 'object' ? Number(page.page) : Number(page)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`invalid page for the transcript bundle: ${JSON.stringify(page)}`)
  }
  return value
}

/** `part-001.md`-style file name. */
function partFileName(part, extension) {
  const value = Number(part)
  if (!Number.isInteger(value) || value < 1) throw new Error(`invalid part number: ${JSON.stringify(part)}`)
  return `part-${String(value).padStart(3, '0')}.${extension}`
}

/** Write one text file, always ending it with a newline. */
function writeText(target, text) {
  mkdirSync(dirname(target), { recursive: true })
  const body = String(text ?? '')
  writeFileSync(target, body.endsWith('\n') ? body : `${body}\n`, 'utf8')
}

/** Write one JSON file with a trailing newline. */
function writeJson(target, value) {
  writeText(target, `${JSON.stringify(value, null, 2)}\n`)
}

/** Read and parse one JSON file, or return undefined. */
function readJson(target) {
  try {
    if (!existsSync(target)) return undefined
    return JSON.parse(readFileSync(target, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Resolve the directory that holds one page's bundle.
 * @param outDir - output root (already resolved to an absolute path by the caller).
 * @param bvid - validated BV id.
 * @param page - page entry or number.
 * @returns absolute bundle directory.
 */
export function bundleDirFor(outDir, bvid, page) {
  assertBvid(bvid)
  const root = resolve(outDir)
  const pageNumber = pageNumberOf(page)
  return pageNumber > 1 ? join(root, bvid, `p${pageNumber}`) : join(root, bvid)
}

/**
 * Write a complete transcript bundle.
 *
 * @param options - outDir, bvid, page, video, track, validation, source,
 *   segments, parts, index, gaps and packing.
 * @returns `{ files, manifest, baseDir, parts }` with absolute paths.
 */
export function writeTranscriptBundle(options) {
  const {
    video,
    track,
    validation,
    segments = [],
    index = [],
    gaps = [],
    source = 'subtitle',
  } = options
  const page = options.page && typeof options.page === 'object' ? options.page : { page: pageNumberOf(options.page) }
  const pageNumber = pageNumberOf(page)
  const baseDir = bundleDirFor(options.outDir, options.bvid, pageNumber)
  const partsDir = join(baseDir, 'parts')
  mkdirSync(partsDir, { recursive: true })
  // A rewrite can produce fewer parts (a larger packing); drop stale part
  // files so `parts/` never advertises parts the new manifest does not list.
  for (const name of readdirSync(partsDir)) {
    if (/^part-\d+\.(md|json)$/.test(name)) rmSync(join(partsDir, name), { force: true })
  }
  const packing = {
    maxChars: options.packing?.maxChars ?? DEFAULT_PACKING.maxChars,
    maxSeconds: options.packing?.maxSeconds ?? DEFAULT_PACKING.maxSeconds,
  }
  const files = {
    meta_json: join(baseDir, 'meta.json'),
    transcript_json: join(baseDir, 'transcript.json'),
    transcript_md: join(baseDir, 'transcript.md'),
    parts_dir: partsDir,
    parts_index: join(partsDir, 'index.json'),
  }
  const parts = (options.parts ?? []).map((part) => ({
    ...part,
    file: join(partsDir, partFileName(part.part, 'md')),
    json_file: join(partsDir, partFileName(part.part, 'json')),
  }))
  const manifest = buildTranscriptManifest({
    video,
    page,
    track,
    validation,
    source,
    segments,
    parts,
    index,
    gaps,
    files,
    packing,
  })
  const stats = { ...manifest.stats, count: manifest.stats.segments }
  const transcriptMarkdown = buildTranscriptMarkdown({
    video,
    page: pageNumber,
    track,
    segments,
    stats,
  })
  const transcript = {
    video,
    page,
    track,
    stats: manifest.stats,
    source,
    text: toPlainText(segments),
    segments,
  }
  const meta = {
    video,
    page,
    track,
    validation: validation ?? null,
    stats: manifest.stats,
    source,
    generated_at: new Date().toISOString(),
    files,
  }

  writeJson(files.transcript_json, transcript)
  writeText(files.transcript_md, transcriptMarkdown.markdown)
  writeJson(files.meta_json, meta)
  writeJson(files.parts_index, manifest)
  for (const part of parts) {
    const markdown = buildPartMarkdown({ video, page, part, totalParts: parts.length, track })
    const body = {
      part: part.part,
      from: part.from,
      to: part.to,
      chars: part.chars,
      markdown,
      segments: part.segments,
    }
    writeText(part.file, markdown)
    writeJson(part.json_file, body)
  }
  return { files, manifest, baseDir, parts }
}

/**
 * Read one page's bundle back.
 * @param options - outDir, bvid and page.
 * @returns `{ meta, transcript, manifest, baseDir, parts }`, or undefined when
 *   a file is missing or corrupt.
 */
export function readTranscriptBundle(options) {
  let baseDir
  try {
    baseDir = bundleDirFor(options.outDir, options.bvid, options.page ?? 1)
  } catch {
    return undefined
  }
  const meta = readJson(join(baseDir, 'meta.json'))
  const transcript = readJson(join(baseDir, 'transcript.json'))
  const manifest = readJson(join(baseDir, 'parts', 'index.json'))
  if (!meta || !transcript || !manifest || !Array.isArray(manifest.parts)) return undefined
  if (!Array.isArray(transcript.segments)) return undefined
  if (!manifest.parts.every((entry) => Number.isInteger(entry.part) && entry.part >= 1)) return undefined
  const parts = []
  for (const entry of manifest.parts) {
    const loaded = readJson(join(baseDir, 'parts', partFileName(entry.part, 'json')))
    if (!loaded || !Array.isArray(loaded.segments)) {
      return { meta, transcript, manifest, baseDir, parts: [] }
    }
    parts.push(loaded)
  }
  return { meta, transcript, manifest, baseDir, parts }
}
