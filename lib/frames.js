/**
 * Frame capture: picture-driven timestamps, scene/sharpness refinement, and
 * per-moment JPEG extraction.
 *
 * Selection is deliberately picture-driven. The old package's automatic plan
 * never guesses from subtitle keywords: a two-pass agent decides which moments
 * matter, and this module only supplies scene-change peaks plus an even-interval
 * fallback. Everything here runs without pipes because the confined Windows
 * sandbox forbids capturing a child's output.
 *
 * @module dsh-bilibili-pro/frames
 */

import { spawn } from 'node:child_process'
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveFfmpeg } from './audio.js'
import { BROWSER_UA } from './http.js'
import { formatClock, momentUrl } from './transcript.js'
import { partFileTag } from './video.js'

/** Minimum distance between two automatic timestamps, in seconds. */
const MIN_GAP_SECONDS = 5

/**
 * Run one optional refinement step with a bounded retry.
 *
 * The Windows sandbox intermittently fails an ffmpeg child at DLL init
 * (`0xC0000142`, decimal `3221225794`); that surfaces as an `EFMPEG` exit. A
 * second attempt usually succeeds. Only that specific init failure is retried;
 * a genuine decode error is not decoded twice. After the final failure the step
 * is skipped and the reason is appended to `notes`; the caller keeps the
 * original timestamps, so the frames themselves are still captured.
 *
 * @param options - label, task, notes sink, cancellation signal, attempt count,
 *   and an optional retry predicate.
 * @returns the task result, or null when the step was skipped.
 */
export async function runBestEffort(options = {}) {
  const { label, task, notes, signal } = options
  const attempts = Math.max(1, Number(options.attempts) || 2)
  const retryable =
    options.retryable ??
    ((error) => error?.code === 'EFMPEG' && /3221225794|0xC0000142/i.test(String(error?.message ?? '')))
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await task()
    } catch (error) {
      if (signal?.aborted) throw error
      lastError = error
      if (attempt >= attempts || !retryable(error)) break
    }
  }
  notes?.push(`${label} skipped: ${String(lastError?.message ?? lastError).slice(0, 160)}`)
  return null
}

/**
 * Requested moments are the caller's explicit intent, so only near-duplicates
 * are collapsed. The automatic plan's five-second spacing would drop two
 * deliberately different moments that happen to be three seconds apart.
 */
const REQUESTED_DEDUPE_SECONDS = 1

/** Videos longer than this use the sampled scene pass (one frame per 60). */
const SCENE_DETECT_MAX_SECONDS = 1200

/** Sensitive threshold used inside a small alignment window. */
const SCENE_ALIGN_THRESHOLD = 0.15

/** Half-window for sharp-frame refinement, in seconds. */
const SHARP_HALF_WINDOW = 1.5

/** Sampled scene pass decodes one frame out of every this many. */
const SCENE_SAMPLED_STEP_FRAMES = 60

/** Default per-frame ffmpeg budget. */
const DEFAULT_FRAME_TIMEOUT_MS = 20000

/** Fixed moment-URL referer used when a caller names none. */
const DEFAULT_REFERER = 'https://www.bilibili.com/'

/** Monotonic suffix so concurrent runs never share a temporary log name. */
let logCounter = 0

/**
 * Normalize one picture-driven candidate.
 * @param candidate - a scene peak or other picture-driven candidate.
 * @param duration - video length in seconds.
 * @returns a normalized candidate, or null when out of range.
 */
function normalizeCandidate(candidate, duration) {
  const time = Number(candidate?.time)
  if (!Number.isFinite(time) || time < 0 || time >= Math.max(duration, 1)) return null
  return { time, reason: candidate?.reason ?? 'candidate', text: candidate?.text ?? '' }
}

/** Whether a time is within the dedupe window of any existing entry. */
function nearAny(list, time) {
  return list.some((item) => Math.abs(item.time - time) <= MIN_GAP_SECONDS)
}

/** Push one candidate unless it is invalid, too close, or over the cap. */
function pushUnique(list, item, duration, cap) {
  const candidate = normalizeCandidate(item, duration)
  if (!candidate || list.length >= cap || nearAny(list, candidate.time)) return false
  list.push(candidate)
  return true
}

/**
 * Automatic capture plan for single-call usage: scene candidates first, then
 * even-interval backfill.
 *
 * @param segments - ignored; kept for API compatibility. Semantic selection is
 *   the agent's job, not a keyword scan.
 * @param duration - video duration in seconds.
 * @param maxFrames - upper bound on returned timestamps.
 * @param extraCandidates - scene-change peaks and similar picture signals.
 * @returns sorted `{ time, reason, text }` plan.
 */
export function selectKeyframeTimestamps(segments, duration, maxFrames, extraCandidates = []) {
  void segments
  const cap = Number.isInteger(maxFrames) && maxFrames > 0 ? maxFrames : 6
  const validDuration = Number.isFinite(duration) && duration > 0 ? duration : 0

  const out = []
  for (const candidate of Array.isArray(extraCandidates) ? extraCandidates : []) {
    pushUnique(out, candidate, validDuration, cap)
  }
  if (validDuration > 0 && out.length < cap) {
    const step = Math.max(Math.floor(validDuration / (cap + 1)), 10)
    let filled = false
    for (let index = 1; index <= cap && out.length < cap; index++) {
      const time = step * index
      if (time >= validDuration) break
      if (pushUnique(out, { time, reason: 'even interval', text: '' }, validDuration, cap)) filled = true
    }
    // A video shorter than the ten-second floor would otherwise get no
    // automatic frame at all; seed its midpoint instead.
    if (!filled && out.length === 0) {
      pushUnique(out, { time: validDuration / 2, reason: 'even interval', text: '' }, validDuration, cap)
    }
  }
  out.sort((left, right) => left.time - right.time)
  return out.slice(0, cap)
}

/**
 * Parse ffmpeg `showinfo` output into scene-change times.
 *
 * @param text - the stderr log.
 * @param offset - seconds added to every parsed time (for a seeked pass).
 * @param options - `dedupe: false` keeps every peak instead of the five-second
 *   full-pass collapse.
 * @returns ascending times.
 */
export function parseShowinfoTimes(text, offset = 0, options = {}) {
  const base = Number(offset) || 0
  const dedupe = options?.dedupe !== false
  const times = []
  for (const line of String(text ?? '').split('\n')) {
    const match = /pts_time:([\d.]+)/.exec(line)
    if (!match) continue
    const time = Number.parseFloat(match[1])
    if (!Number.isFinite(time)) continue
    const shifted = base + time
    const previous = times[times.length - 1]
    if (!dedupe || previous === undefined || shifted - previous > MIN_GAP_SECONDS) times.push(shifted)
  }
  return times
}

/**
 * Parse `blurdetect,metadata=print` output into `{ time, blur }` entries.
 *
 * @param text - the stderr log.
 * @param startOffset - seconds added to every parsed time.
 * @returns entries in log order.
 */
export function parseBlurMetadata(text, startOffset = 0) {
  const offset = Number(startOffset) || 0
  const entries = []
  let current = null
  for (const line of String(text ?? '').split('\n')) {
    const timeMatch = /pts_time:([\d.]+)/.exec(line)
    if (timeMatch) {
      current = Number.parseFloat(timeMatch[1])
      continue
    }
    const blurMatch = /lavfi\.blur=([\d.]+)/.exec(line)
    if (blurMatch && current !== null) {
      entries.push({ time: offset + current, blur: Number.parseFloat(blurMatch[1]) })
      current = null
    }
  }
  return entries
}

/**
 * Pick the peak nearest to a center time.
 * @param peaks - candidate peaks with a `time` member.
 * @param centerTime - target moment in seconds.
 * @returns the closest peak, or null when the list is empty.
 */
export function pickNearestPeak(peaks, centerTime) {
  const center = Number(centerTime)
  if (!Number.isFinite(center) || !Array.isArray(peaks) || peaks.length === 0) return null
  let best = null
  let bestDistance = Infinity
  for (const peak of peaks) {
    const distance = Math.abs(Number(peak?.time) - center)
    if (Number.isFinite(distance) && distance < bestDistance) {
      bestDistance = distance
      best = peak
    }
  }
  return best
}

/**
 * Nearest subtitle line around a time, accepting both segment spellings.
 * @param time - moment in seconds.
 * @param segments - `{ from, to, text }` or `{ start, end, text }` entries.
 * @returns the caption text, or an empty string.
 */
export function nearestSubtitleText(time, segments) {
  const target = Number(time)
  if (!Number.isFinite(target) || !Array.isArray(segments)) return ''
  const bounds = (segment) => ({
    start: Number(segment?.from ?? segment?.start),
    end: Number(segment?.to ?? segment?.end),
  })
  // Prefer the line that actually covers the moment: with contiguous subtitle
  // tracks the previous line's +2s window often extends into the next line.
  for (const segment of segments) {
    const { start, end } = bounds(segment)
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    if (segment.text && target >= start && target <= end) return segment.text
  }
  // Otherwise take the nearest line within the two-second caption window.
  let best = ''
  let bestDistance = Infinity
  for (const segment of segments) {
    const { start, end } = bounds(segment)
    if (!Number.isFinite(start) || !Number.isFinite(end) || !segment.text) continue
    const distance = target < start ? start - target : target > end ? target - end : 0
    if (distance <= 2 && distance < bestDistance) {
      best = segment.text
      bestDistance = distance
    }
  }
  return best
}

/**
 * Parse a tool timestamp: a number, `mm:ss`, or `h:mm:ss`.
 * @param value - one requested moment.
 * @returns seconds, or NaN when unusable.
 */
export function parseTimestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN
  if (typeof value !== 'string') return Number.NaN
  const text = value.trim()
  if (text.length === 0) return Number.NaN
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text)
    return Number.isFinite(seconds) ? seconds : Number.NaN
  }
  const parts = text.split(':')
  if (parts.length < 2 || parts.length > 3) return Number.NaN
  if (!parts.every((part) => /^\d+(?:\.\d+)?$/.test(part))) return Number.NaN
  const numbers = parts.map(Number)
  const seconds =
    numbers.length === 3 ? numbers[0] * 3600 + numbers[1] * 60 + numbers[2] : numbers[0] * 60 + numbers[1]
  return Number.isFinite(seconds) ? seconds : Number.NaN
}

/**
 * Normalize the tool's explicit `timestamps` argument.
 *
 * Every moment keeps its original value as `requested_time`; later scene and
 * sharpness refinement rewrites only `time`, so the drift stays visible.
 *
 * @param timestamps - numbers or timestamp strings.
 * @param duration - video duration in seconds.
 * @param maxFrames - cap, clamped to 1-20.
 * @param segments - transcript segments for captions.
 * @returns the plan, or null when no usable moment remains.
 */
export function normalizeRequestedTimestamps(timestamps, duration, maxFrames, segments) {
  if (!Array.isArray(timestamps) || timestamps.length === 0) return null
  const limit = Math.max(duration, 1)
  const valid = timestamps
    .map((value) => parseTimestamp(value))
    .filter((time) => Number.isFinite(time) && time >= 0 && time < limit)
  const sorted = valid.slice().sort((left, right) => left - right)
  const deduped = []
  for (const time of sorted) {
    if (!deduped.some((existing) => Math.abs(existing - time) <= REQUESTED_DEDUPE_SECONDS)) deduped.push(time)
  }
  const cap = Math.max(1, Math.min(Number(maxFrames) || 6, 20))
  const list = deduped.slice(0, cap)
  if (list.length === 0) return null
  return list.map((time) => ({
    time,
    requested_time: time,
    reason: 'requested timestamp',
    text: nearestSubtitleText(time, segments),
  }))
}

/**
 * Frame file name: `frame_001.jpg`, or `frame_p4_001.jpg` for a later part.
 * @param pageTag - output of {@link partFileTag}.
 * @param index - one-based frame number.
 * @returns the file name.
 */
export function frameFileName(pageTag, index) {
  const tag = String(pageTag ?? '')
  return `frame_${tag ? `${tag}_` : ''}${String(index).padStart(3, '0')}.jpg`
}

/**
 * Strip a trailing citation suggestion from a description for display.
 *
 * The structured `citation_hint` already carries that suggestion, so repeating
 * the raw tail would duplicate it and leave an unindented line inside the
 * Markdown bullet.
 *
 * @param text - raw vision description.
 * @returns the description without a trailing citation line.
 */
function descriptionWithoutCitation(text) {
  return String(text ?? '')
    .replace(/配图建议\s*[:：]?\s*(适合|不适合)\s*$/u, '')
    .replace(/citation\s*[:：]?\s*(suitable|unsuitable)\s*$/iu, '')
    .trim()
}

/**
 * Render the compact Markdown frame list returned to the model.
 * @param result - the tool result (`video`, `page`, `mode`, `strategy`, `note`, `frames`).
 * @returns Markdown text.
 */
export function renderFramesMarkdown(result) {
  const frames = Array.isArray(result?.frames) ? result.frames : []
  const lines = [`## 关键帧（${result?.strategy ?? 'frames'}）`, '']
  if (result?.mode) lines.push(`- 模式：${result.mode}`)
  if (result?.note) lines.push(`- 说明：${result.note}`)
  if (frames.length === 0) lines.push('- 没有抓到帧')
  lines.push('')
  frames.forEach((frame, index) => {
    const label = formatClock(frame?.time)
    const link = momentUrl(result?.video?.bvid, frame?.time, result?.page?.page)
    const bits = [`${index + 1}. [${label}](${link})`]
    if (frame?.requested_time !== null && frame?.requested_time !== undefined) {
      const drift = Math.abs(Number(frame.time) - Number(frame.requested_time))
      if (Number.isFinite(drift) && drift >= 0.5) bits.push(`原始请求 ${formatClock(frame.requested_time)}`)
    }
    if (frame?.reason) bits.push(frame.reason)
    lines.push(`- ${bits.join(' | ')}`)
    if (frame?.subtitle_text) lines.push(`  - 字幕：${frame.subtitle_text}`)
    if (frame?.has_image && frame?.path) lines.push(`  - 图片：\`${frame.path}\``)
    else lines.push(`  - 无图片：${frame?.error ?? 'ffmpeg failed'}`)
    if (frame?.description) {
      const description = descriptionWithoutCitation(frame.description)
      const descriptionLines = description
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
      if (descriptionLines.length > 0) {
        lines.push(`  - 画面描述：${descriptionLines[0]}`)
        for (const extra of descriptionLines.slice(1)) lines.push(`    ${extra}`)
      }
    }
    if (frame?.citation_hint) {
      lines.push(`  - 配图建议：${frame.citation_hint === 'suitable' ? '适合' : '不适合'}`)
    }
    if (frame?.vision_error) lines.push(`  - 视觉失败：${frame.vision_error}`)
  })
  lines.push('', '需要看图时，对图片路径调用 read_image。')
  return lines.join('\n')
}

/** An abort-shaped error, so callers can distinguish cancellation. */
function abortedError() {
  const error = new Error('aborted')
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}

/** A clear error for a missing ffmpeg binary. */
function ffmpegMissingError(ffmpegPath) {
  const error = new Error(
    `ffmpeg is not available (${ffmpegPath}); install FFmpeg or set ffmpegPath to its full path`,
  )
  error.code = 'ENOENT'
  return error
}

/**
 * Spawn one child and wait for it without ever reading its output.
 *
 * When `options.stdio` is a descriptor array the child's stderr goes to that
 * file; otherwise all three streams are ignored. No pipe is created either way,
 * which is what the confined sandbox requires.
 *
 * @param command - executable.
 * @param args - argument array.
 * @param options - stdio override, timeout and cancellation.
 * @returns a promise that settles on exit or abort.
 */
function runChild(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(abortedError())
      return
    }
    const stdio = options.stdio ?? 'ignore'
    let child
    try {
      // Deliberately no `windowsHide`: under this Windows sandbox that option
      // makes ffmpeg fail at DLL init (0xC0000142), while a spawn whose streams
      // are ignored works.
      child = spawn(command, args, { stdio })
    } catch (error) {
      reject(error)
      return
    }
    let settled = false
    let timer
    const finish = (error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    const onAbort = () => {
      child.kill('SIGKILL')
      finish(abortedError())
    }
    timer =
      Number(options.timeoutMs) > 0
        ? setTimeout(() => {
            child.kill('SIGKILL')
            const error = new Error(`ffmpeg timed out after ${options.timeoutMs} ms`)
            error.code = 'ETIMEDOUT'
            finish(error)
          }, Number(options.timeoutMs))
        : undefined
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (error) => finish(error))
    child.on('close', (code, signalName) => {
      if (code === 0) {
        finish()
        return
      }
      if (options.signal?.aborted) {
        finish(abortedError())
        return
      }
      const error = new Error(`ffmpeg exited with code ${code}${signalName ? ` (${signalName})` : ''}`)
      error.code = 'EFMPEG'
      finish(error)
    })
  })
}

/**
 * Run ffmpeg with stderr redirected to a file, then read and delete that file.
 * @param ffmpegPath - binary path.
 * @param args - argument array.
 * @param outDir - directory for the temporary log.
 * @param label - log-name prefix.
 * @param options - timeout and cancellation.
 * @returns the captured stderr text.
 */
async function runFfmpegToLog(ffmpegPath, args, outDir, label, options = {}) {
  logCounter += 1
  const logPath = join(outDir, `${label}-${process.pid}-${Date.now()}-${logCounter}.log`)
  await mkdir(outDir, { recursive: true })
  const handle = await open(logPath, 'w')
  let failure
  try {
    await runChild(ffmpegPath, args, { ...options, stdio: ['ignore', 'ignore', handle.fd] })
  } catch (error) {
    failure = error
  } finally {
    await handle.close().catch(() => {})
  }
  let text = ''
  try {
    text = await readFile(logPath, 'utf8')
  } catch {
    // The log is best-effort; an unreadable file leaves `text` empty.
  }
  await rm(logPath, { force: true }).catch(() => {})
  if (failure) {
    if (text.trim()) failure.message = `${failure.message}: ${text.trim().slice(-300)}`
    throw failure
  }
  return text
}

/**
 * Detect scene-change peaks in a local video file.
 *
 * The full pass decodes the video once; videos longer than 20 minutes use the
 * sampled pass. Failures are thrown for the caller to treat as best-effort.
 *
 * @param options - videoPath, outDir, threshold, sampled, duration, ffmpegPath,
 *   timeoutMs and signal.
 * @returns `{ time, reason, text }` peaks, closer than five seconds collapsed.
 */
export async function detectScenePeaks(options) {
  const ffmpegPath = options?.ffmpegPath || resolveFfmpeg()
  const threshold = Number.isFinite(Number(options?.threshold)) ? Number(options.threshold) : 0.4
  const sampled = options?.sampled ?? Number(options?.duration) > SCENE_DETECT_MAX_SECONDS
  const filter = sampled
    ? `select='not(mod(n,${SCENE_SAMPLED_STEP_FRAMES}))',select='gt(scene,${threshold})',showinfo`
    : `select='gt(scene,${threshold})',showinfo`
  const text = await runFfmpegToLog(
    ffmpegPath,
    ['-hide_banner', '-i', options.videoPath, '-vf', filter, '-an', '-f', 'null', '-'],
    options.outDir,
    'scene-detect',
    { timeoutMs: options.timeoutMs, signal: options.signal },
  )
  return parseShowinfoTimes(text).map((time) => ({ time, reason: 'scene change', text: '' }))
}

/**
 * Find the scene peak nearest a requested moment inside a small window.
 * @param options - videoPath, centerTime, halfWindow (default 4), outDir,
 *   ffmpegPath, timeoutMs and signal.
 * @returns the nearest peak, or null when none was found.
 */
export async function detectScenePeaksInWindow(options) {
  const ffmpegPath = options?.ffmpegPath || resolveFfmpeg()
  const center = Number(options?.centerTime)
  const halfWindow = Number.isFinite(Number(options?.halfWindow)) ? Number(options.halfWindow) : 4
  const start = Math.max(0, center - halfWindow)
  const threshold = Number.isFinite(Number(options?.threshold)) ? Number(options.threshold) : SCENE_ALIGN_THRESHOLD
  const text = await runFfmpegToLog(
    ffmpegPath,
    [
      '-hide_banner',
      '-ss',
      String(start),
      '-t',
      String(halfWindow * 2),
      '-i',
      options.videoPath,
      '-vf',
      `select='gt(scene,${threshold})',showinfo`,
      '-an',
      '-f',
      'null',
      '-',
    ],
    options.outDir,
    'scene-window',
    { timeoutMs: options.timeoutMs, signal: options.signal },
  )
  // After -ss the output timeline restarts at zero, so shift by the seek start.
  // A short alignment window keeps every peak: collapsing them here could drop
  // the one actually nearest the requested moment.
  const peaks = parseShowinfoTimes(text, start, { dedupe: false }).map((time) => ({
    time,
    reason: 'scene change',
    text: '',
  }))
  return pickNearestPeak(peaks, center)
}

/**
 * Find the sharpest frame time inside a window around a target moment.
 * @param options - videoPath, centerTime, halfWindow (default 1.5), outDir,
 *   ffmpegPath, timeoutMs and signal.
 * @returns the time of the minimum `lavfi.blur`, or null when there is none.
 */
export async function findSharpestTime(options) {
  const ffmpegPath = options?.ffmpegPath || resolveFfmpeg()
  const center = Number(options?.centerTime)
  const halfWindow = Number.isFinite(Number(options?.halfWindow)) ? Number(options.halfWindow) : SHARP_HALF_WINDOW
  const start = Math.max(0, center - halfWindow)
  const text = await runFfmpegToLog(
    ffmpegPath,
    [
      '-hide_banner',
      '-ss',
      String(start),
      '-t',
      String(halfWindow * 2),
      '-i',
      options.videoPath,
      '-vf',
      'blurdetect,metadata=print:key=lavfi.blur',
      '-an',
      '-f',
      'null',
      '-',
    ],
    options.outDir,
    'sharpness',
    { timeoutMs: options.timeoutMs, signal: options.signal },
  )
  const entries = parseBlurMetadata(text, start)
  if (entries.length === 0) return null
  entries.sort((left, right) => left.blur - right.blur)
  return entries[0].time
}

/**
 * Capture one JPEG per planned timestamp, locally or from the remote stream.
 *
 * Each frame is isolated: a failed frame records its error and the rest still
 * run. Cancellation and a missing ffmpeg binary are not isolated — they are
 * rethrown so the caller never reports a result that pretends frames exist.
 *
 * @param options - videoPath (local mode) or streamUrl (remote mode), referer,
 *   timestamps, outDir, pageTag, ffmpegPath, timeoutMs and signal.
 * @returns the plan entries plus `path`/`error` per frame.
 */
export async function captureFrames(options) {
  const ffmpegPath = options?.ffmpegPath || resolveFfmpeg()
  const timestamps = Array.isArray(options?.timestamps) ? options.timestamps : []
  const outDir = options?.outDir
  const pageTag = options?.pageTag ?? ''
  const remote = !options?.videoPath
  if (remote && (typeof options?.streamUrl !== 'string' || options.streamUrl.length === 0)) {
    return timestamps.map((entry) => ({ ...entry, path: null, error: 'no stream url' }))
  }
  await mkdir(outDir, { recursive: true })
  const results = []
  const headers = `Referer: ${options?.referer || DEFAULT_REFERER}\r\nUser-Agent: ${BROWSER_UA}\r\n`
  for (let index = 0; index < timestamps.length; index++) {
    const entry = timestamps[index]
    const outPath = join(outDir, frameFileName(pageTag, index + 1))
    const args = remote
      ? [
          '-y',
          '-headers',
          headers,
          '-ss',
          String(entry.time),
          '-i',
          options.streamUrl,
          '-frames:v',
          '1',
          '-q:v',
          '2',
          '-an',
          outPath,
        ]
      : ['-y', '-ss', String(entry.time), '-i', options.videoPath, '-frames:v', '1', '-q:v', '2', '-an', outPath]
    try {
      await runChild(ffmpegPath, args, { timeoutMs: options.timeoutMs ?? DEFAULT_FRAME_TIMEOUT_MS, signal: options.signal })
      let exists = false
      try {
        exists = (await stat(outPath)).isFile()
      } catch {
        exists = false
      }
      results.push({ ...entry, path: exists ? outPath : null, error: exists ? null : 'output file missing' })
    } catch (error) {
      if (options?.signal?.aborted) throw error
      if (error?.code === 'ENOENT') throw ffmpegMissingError(ffmpegPath)
      results.push({
        ...entry,
        path: null,
        error: `ffmpeg: ${String(error?.message ?? error).slice(-200)}`,
      })
    }
  }
  return results
}

export { partFileTag }
