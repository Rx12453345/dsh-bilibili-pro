/**
 * Audio fallback: pull a video's DASH audio stream down to a WAV file.
 *
 * Only used when a video has no subtitle track at all. The remote stream is
 * fetched by Node (`downloadStream`), because ffmpeg's own TLS stack cannot
 * trust the local proxy CA in the confined environment; ffmpeg then converts
 * the local file to the 16 kHz mono PCM the ASR runtime wants.
 *
 * @module dsh-bilibili-summary/audio
 */

import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { runCommand } from './asr.js'
import { downloadStream } from './video.js'

/** Absolute locations tried for the ffmpeg binary. */
const FFMPEG_CANDIDATES = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']

/** Executable name on the current platform. */
const FFMPEG_NAME = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'

/** Audio download cap used when the caller names none. */
const DEFAULT_AUDIO_MAX_BYTES = 200 * 1024 * 1024

/** Audio download budget used when the caller names none. */
const DEFAULT_AUDIO_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Find an ffmpeg binary.
 * @param configured - explicit path from configuration.
 * @returns the path to use.
 */
export function resolveFfmpeg(configured) {
  if (configured) return configured
  for (const candidate of FFMPEG_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, FFMPEG_NAME)
    if (existsSync(candidate)) return candidate
  }
  return FFMPEG_NAME
}

/**
 * Download one audio stream into a 16 kHz mono WAV.
 *
 * `downloadStream` uses Node fetch (which trusts the local proxy CA), sends the
 * Bilibili referer/UA, enforces content-length and in-flight byte caps, and
 * writes atomically through `<dest>.part`. ffmpeg then reads only the local
 * temporary source; no header is handed to ffmpeg and no remote URL is opened
 * by it. The temporary source is always removed.
 *
 * The child writes through file descriptors (no pipes), because the DSH
 * Windows sandbox forbids capturing a child's stdout/stderr through pipes.
 *
 * @param options - stream URL, referer, output path, and process settings.
 * @returns the written file's path and size.
 */
export async function downloadAudio(options) {
  mkdirSync(dirname(options.outPath), { recursive: true })
  const sourcePath = `${options.outPath}.source`
  try {
    try {
      await downloadStream({
        url: options.url,
        dest: sourcePath,
        referer: options.referer,
        maxBytes: options.maxBytes ?? DEFAULT_AUDIO_MAX_BYTES,
        timeoutMs: options.timeoutMs ?? DEFAULT_AUDIO_TIMEOUT_MS,
        signal: options.signal,
      })
    } catch (error) {
      const detail = String(error?.message ?? error)
      throw new Error(`audio download failed: ${detail}`)
    }
    const { code, stderr } = await runCommand(
      options.ffmpegPath ?? resolveFfmpeg(),
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        sourcePath,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'pcm_s16le',
        options.outPath,
      ],
      { signal: options.signal, timeoutMs: options.timeoutMs },
    )
    if (code !== 0 || !existsSync(options.outPath)) {
      throw new Error(`ffmpeg could not decode the audio stream (exit ${code}): ${stderr.trim().slice(0, 300)}`)
    }
    return { path: options.outPath, bytes: statSync(options.outPath).size }
  } finally {
    try {
      rmSync(sourcePath, { force: true })
    } catch {}
  }
}
