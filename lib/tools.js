/**
 * Model-facing tools.
 *
 * Definitions are plain JSON-Schema declarations, so the package imports
 * nothing from the harness runtime. The transcript tools share one extraction
 * core, write the full transcript to a disk bundle, and return one bounded part
 * at a time so long videos never have to fit in a single tool result.
 *
 * @module dsh-bilibili-pro/tools
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  asrInstallOptions,
  cleanupTemporaryRuntime,
  estimatedModelMb,
  findExistingRuntime,
  hasFasterWhisper,
  installRuntime,
  needsSetupResult,
  removeRuntime,
  runtimeStatus,
  transcribeAudio,
} from './asr.js'
import { pickLowestAudio, transcribeWithBcut } from './bcut.js'
import { clearCookieFile, cookieHeader, loadCredentials } from './cookies.js'
import {
  assessSegments,
  fetchAccount,
  fetchAiConclusion,
  fetchAudioStream,
  fetchCollectionVideos,
  fetchHotComments,
  fetchSubtitleBody,
  fetchSubtitleTracks,
  fetchUserCollections,
  fetchUserVideos,
  fetchVideoInfo,
  fetchVideoStream,
  pickCompanionTrack,
  pickTrack,
  resolveBvid,
  selectPage,
} from './api.js'
import { downloadAudio, resolveFfmpeg } from './audio.js'
import {
  captureFrames,
  detectScenePeaks,
  detectScenePeaksInWindow,
  findSharpestTime,
  nearestSubtitleText,
  normalizeRequestedTimestamps,
  renderFramesMarkdown,
  runBestEffort,
  selectKeyframeTimestamps,
} from './frames.js'
import { loginStateFile, pollQrLogin, startQrLogin } from './login.js'
import { bundleDirFor, readTranscriptBundle, writeTranscriptBundle } from './store.js'
import { ensureVideo, partFileTag } from './video.js'
import { describeFramesWithVision } from './vision.js'
import {
  buildIndex,
  buildManifestMarkdown,
  buildPartMarkdown,
  buildTranscriptMarkdown,
  cursorFor,
  extensionFor,
  formatClock,
  formatDuration,
  groupSegments,
  mergeBilingual,
  momentUrl,
  packParts,
  parseCursor,
  partForTime,
  searchSegments,
  toAss,
  toLrc,
  toPlainText,
  toSrt,
  transcriptGaps,
} from './transcript.js'
import { assessMatch } from './validate.js'

/** Default number of subtitle attempts before giving up. */
const DEFAULT_RETRIES = 6

/** Default first backoff in milliseconds. */
const DEFAULT_RETRY_BASE_MS = 8000

/** Extra backoff added per attempt. */
const RETRY_STEP_MS = 3000

/** Fewest segments a usable transcript must have. */
const MIN_SEGMENTS = 20

/** Default fraction of the video a transcript must cover. */
const DEFAULT_MIN_COVERAGE = 0.6

/** Guidance shown whenever the plugin needs a signed-in session. */
const LOGIN_HINT =
  'Bilibili hides AI subtitles from signed-out clients. Run bilibili_login with action "start", ' +
  'show the returned QR image to the user, then run action "poll" once they have scanned it.'

/** Render one canonical value as pretty JSON text. */
const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

/** Render a Markdown payload as text. */
const renderMarkdown = (_args, value) => [{ type: 'text', text: typeof value?.markdown === 'string' ? value.markdown : JSON.stringify(value, null, 2) }]

/** Render a one-line status summary. */
const renderStatus = (_args, value) => [{ type: 'text', text: value?.markdown ?? JSON.stringify(value, null, 2) }]

/** Render the frame list as the compact Markdown the tool returns. */
const renderFrames = (_args, value) => [
  { type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value, null, 2) },
]

/**
 * Build one registry-ready tool declaration.
 * @param options - name, description, parameters, renderer, and body.
 * @returns the plain tool definition the DSH tool registry accepts.
 */
function defineTool({ name, description, properties, required = [], render = renderJson, execute }) {
  return {
    name,
    description,
    parameters: { type: 'object', properties, ...(required.length > 0 ? { required } : {}) },
    output: { schema: {}, render },
    execute,
  }
}

/**
 * Read one optional non-empty string argument.
 * @param args - raw tool arguments.
 * @param key - property name.
 * @returns the value, or undefined.
 */
function optionalString(args, key) {
  const value = args?.[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} must be a non-empty string`)
  return value
}

/**
 * Read one optional free-form string argument, treating an empty string as
 * absent. Vision settings use it so an explicit empty value falls back to the
 * plugin configuration instead of failing.
 * @param args - raw tool arguments.
 * @param key - property name.
 * @returns the trimmed value, or undefined.
 */
function optionalText(args, key) {
  const value = args?.[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${key} must be a string`)
  const text = value.trim()
  return text.length > 0 ? text : undefined
}

/**
 * Read one optional integer argument.
 * @param args - raw tool arguments.
 * @param key - property name.
 * @param fallback - value used when absent.
 * @param bounds - inclusive minimum and maximum.
 * @returns the clamped value.
 */
function optionalInteger(args, key, fallback, bounds) {
  const value = args?.[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${key} must be an integer`)
  return Math.min(Math.max(value, bounds[0]), bounds[1])
}

/**
 * Read one optional number argument.
 * @param args - raw tool arguments.
 * @param key - property name.
 * @param fallback - value used when absent.
 * @returns the value.
 */
function optionalNumber(args, key, fallback) {
  const value = args?.[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || Number.isNaN(value)) throw new Error(`${key} must be a number`)
  return value
}

/**
 * Read one optional boolean argument.
 * @param args - raw tool arguments.
 * @param key - property name.
 * @param fallback - value used when absent.
 * @returns the value.
 */
function optionalBoolean(args, key, fallback) {
  const value = args?.[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`)
  return value
}

/** Clamp a number into an inclusive range. */
function clampNumber(value, min, max) {
  return Math.min(Math.max(Number(value), min), max)
}

/** Round a timestamp to one decimal, matching the frame plan's precision. */
function roundTime(seconds) {
  return Math.round(Number(seconds) * 10) / 10
}

/**
 * Wait without ignoring cancellation.
 * @param ms - milliseconds to wait.
 * @param signal - caller cancellation.
 * @returns a promise that settles on timeout or abort.
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Write a transcript payload in the requested format.
 * @param options - format, resolved path, and transcript data.
 * @returns the written path.
 */
function writeTranscript(options) {
  const { format, target, video, page, track, stats, segments, markdown } = options
  const payload =
    format === 'json'
      ? `${JSON.stringify({ video, page, track, stats, segments }, null, 2)}\n`
      : format === 'srt'
        ? toSrt(segments)
        : format === 'ass'
          ? toAss(segments)
          : format === 'lrc'
            ? toLrc(segments)
            : format === 'text'
              ? toPlainText(segments)
              : markdown
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, payload.endsWith('\n') ? payload : `${payload}\n`, 'utf8')
  return target
}

/** The public video shape returned by every transcript tool. */
function summarizeVideo(video) {
  return {
    bvid: video.bvid,
    title: video.title,
    owner: video.owner,
    duration: video.duration,
    url: video.url,
    description: video.description,
  }
}

/** Resolve packing options from a tool argument and the plugin defaults. */
function packingOptions(defaults, maxChars) {
  return {
    maxChars: maxChars ?? defaults.partChars ?? 6000,
    maxSeconds: defaults.partSeconds ?? 600,
  }
}

/**
 * Resolve the `page`/`part`/`cursor`/`max_chars` arguments shared by
 * `bilibili_subtitles` and `bilibili_transcribe`.
 *
 * All checks run before any network work: a cursor and an explicit packing that
 * disagree would otherwise silently renumber parts, and a transcription would
 * waste minutes before failing.
 *
 * @param options - tool args and resolved defaults.
 * @returns `{ parsedCursor, requestedPage, maxChars, defaultMaxChars }`.
 */
function resolvePackingArguments({ args, defaults }) {
  const defaultMaxChars = defaults.partChars ?? 6000
  const cursorArg = optionalString(args, 'cursor')
  const parsedCursor = cursorArg ? parseCursor(cursorArg) : undefined
  const requestedPage = optionalInteger(args, 'page', undefined, [1, 10_000])
  if (parsedCursor && requestedPage !== undefined && parsedCursor.page !== requestedPage) {
    throw new Error(`cursor page ${parsedCursor.page} does not match page ${requestedPage}`)
  }
  const explicitMaxChars =
    args?.max_chars === undefined || args?.max_chars === null
      ? undefined
      : optionalInteger(args, 'max_chars', defaultMaxChars, [2000, 12_000])
  if (explicitMaxChars !== undefined && parsedCursor?.maxChars !== undefined && explicitMaxChars !== parsedCursor.maxChars) {
    throw new Error(
      `cursor was packed at ${parsedCursor.maxChars} chars; pass max_chars: ${parsedCursor.maxChars} or omit max_chars`,
    )
  }
  if (
    parsedCursor &&
    parsedCursor.maxChars === undefined &&
    explicitMaxChars !== undefined &&
    explicitMaxChars !== defaultMaxChars
  ) {
    throw new Error(`cursor is canonical at ${defaultMaxChars} chars; pass max_chars: ${defaultMaxChars} or omit max_chars`)
  }
  return {
    parsedCursor,
    requestedPage,
    maxChars: explicitMaxChars ?? parsedCursor?.maxChars ?? defaultMaxChars,
    defaultMaxChars,
  }
}

/** Convert a validation assessment into the manifest-friendly object. */
function validationFor(assessment) {
  return {
    verdict: assessment.verdict,
    accepted: assessment.accepted,
    count: assessment.count,
    coveredSeconds: assessment.coveredSeconds,
    coverage: assessment.coverage,
    keywordHits: assessment.keywordHits,
    matchedKeywords: assessment.matchedKeywords,
    reasons: assessment.reasons,
  }
}

/** Resolve `out_dir` (or the plugin default) through the harness filesystem. */
async function resolveOutDir({ args, exec, defaults }) {
  return exec.resolvePath(optionalString(args, 'out_dir') ?? defaults.outDir ?? 'bili-out')
}

/** Rebuild canonical parts when the bundle's part files are unavailable. */
function partsFromBundle(bundle) {
  const manifestParts = bundle.manifest?.parts ?? []
  if (Array.isArray(bundle.parts) && bundle.parts.length === manifestParts.length && bundle.parts.length > 0) {
    return bundle.parts
  }
  return packParts(bundle.transcript?.segments ?? [], {
    maxChars: bundle.manifest?.packing?.maxChars ?? 6000,
    maxSeconds: bundle.manifest?.packing?.maxSeconds ?? 600,
  })
}

/** Write one selected part to an explicit `out` path. */
async function writePartOutput({ args, exec, format, part, video, page }) {
  const out = optionalString(args, 'out')
  if (!out) return ''
  const target = await exec.resolvePath(out)
  const payload =
    format === 'json'
      ? `${JSON.stringify({ video, page, part }, null, 2)}`
      : format === 'text'
        ? toPlainText(part.segments)
        : format === 'srt'
          ? toSrt(part.segments)
          : part.markdown
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, payload.endsWith('\n') ? payload : `${payload}\n`, 'utf8')
  return target
}

/**
 * Pack and persist the full transcript, returning the on-disk manifest.
 * @param options - tool args, exec, defaults, collected data, segments,
 *   maxChars and the bundle `source` (default "subtitle"; the Bcut path passes
 *   "asr").
 * @returns `{ outDir, files, manifest, baseDir, parts, index, gaps, packing }`.
 */
async function persistTranscript({ args, exec, defaults, collected, segments, maxChars, source = 'subtitle' }) {
  const packing = packingOptions(defaults, maxChars)
  const parts = packParts(segments, packing)
  if (parts.length === 0) throw new Error('the subtitle track produced an empty transcript; nothing to page')
  const index = buildIndex(segments, { chunkSeconds: defaults.indexChunkSeconds ?? 300 })
  const gaps = transcriptGaps(segments, { minGapSeconds: defaults.gapSeconds ?? 10 })
  const outDir = await resolveOutDir({ args, exec, defaults })
  const written = writeTranscriptBundle({
    outDir,
    bvid: collected.video.bvid,
    page: collected.entry,
    video: summarizeVideo(collected.video),
    track: collected.track,
    validation: collected.validation,
    source,
    segments,
    parts,
    index,
    gaps,
    packing,
  })
  return { outDir, ...written, index, gaps, packing }
}

/**
 * Load a page's bundle, extracting and writing it first when it is missing.
 * @param options - tool args, exec and defaults.
 * @returns the loaded bundle plus `outDir`, `bvid` and `pageNumber`.
 */
async function ensureTranscriptBundle({ args, exec, defaults }) {
  const rawUrl = optionalString(args, 'url')
  const direct = /BV[0-9A-Za-z]{10}/.exec(rawUrl)?.[0]
  const bvid = direct ?? (await resolveBvid(rawUrl, { timeoutMs: defaults.timeoutMs, signal: exec.signal }))
  const cursorArg = optionalString(args, 'cursor')
  const parsedCursor = cursorArg ? parseCursor(cursorArg) : undefined
  const requestedPage = optionalInteger(args, 'page', undefined, [1, 10_000])
  if (parsedCursor && requestedPage !== undefined && parsedCursor.page !== requestedPage) {
    throw new Error(`cursor page ${parsedCursor.page} does not match page ${requestedPage}`)
  }
  const pageNumber = requestedPage ?? parsedCursor?.page ?? 1
  const outDir = await resolveOutDir({ args, exec, defaults })
  const existing = readTranscriptBundle({ outDir, bvid, page: pageNumber })
  if (existing && existing.transcript?.segments?.length > 0 && existing.manifest?.parts?.length > 0) {
    return { ...existing, outDir, bvid, pageNumber }
  }
  const collected = await collectSubtitleData({ args: { ...args, page: pageNumber }, exec, defaults })
  await persistTranscript({ args, exec, defaults, collected, segments: collected.segments })
  const bundle = readTranscriptBundle({ outDir, bvid: collected.video.bvid, page: collected.entry.page })
  if (!bundle) throw new Error('wrote the transcript bundle but could not read it back')
  return { ...bundle, outDir, bvid: collected.video.bvid, pageNumber: collected.entry.page }
}

/**
 * Build the login tool.
 * @param defaults - resolved plugin configuration.
 * @returns the tool definition.
 */
function loginTool(defaults) {
  return defineTool({
    name: 'bilibili_login',
    description:
      'Sign in to Bilibili for this machine. Action "start" returns a fresh login QR image to show the ' +
      'user (Bilibili hides AI subtitles from signed-out clients); action "poll" waits for the scan and ' +
      'stores the session cookies; "status" reports the stored account; "logout" deletes the cookies.',
    properties: {
      action: {
        type: 'string',
        enum: ['start', 'poll', 'status', 'logout'],
        description: 'start: issue a QR code. poll: wait for the scan. status: report the saved account. logout: delete it.',
      },
      qrcode_key: { type: 'string', description: 'Key from a previous "start"; defaults to the last issued code.' },
      timeout_sec: { type: 'integer', description: 'Polling budget for "poll". Defaults to 150 seconds.' },
      out: { type: 'string', description: 'Where to write the QR PNG; relative paths resolve against the workspace.' },
    },
    required: ['action'],
    render: renderStatus,
    execute: async (args, exec) => {
      const action = optionalString(args, 'action') ?? 'start'
      const credentials = loadCredentials(defaults)
      if (action === 'start') {
        const out = await exec.resolvePath(optionalString(args, 'out') ?? 'bilibili-login/bilibili-qr.png')
        const started = await startQrLogin({ outPath: out, timeoutMs: defaults.timeoutMs, signal: exec.signal })
        return {
          status: 'waiting-scan',
          qrPath: started.qrPath,
          qrcodeKey: started.qrcodeKey,
          expiresInSec: started.expiresInSec,
          markdown:
            `已生成登录二维码：\`${started.qrPath}\`（约 ${started.expiresInSec} 秒内有效）。\n` +
            '请用 B站手机 App →「我的」→ 右上角「扫一扫」扫码并在手机上确认，然后调用 bilibili_login { action: "poll" }。',
        }
      }
      if (action === 'poll') {
        let key = optionalString(args, 'qrcode_key')
        if (!key) {
          try {
            key = JSON.parse(readFileSync(loginStateFile(), 'utf8')).qrcodeKey
          } catch {
            // The caller may still pass the key explicitly.
          }
        }
        if (!key) throw new Error('no pending QR login; run bilibili_login { action: "start" } first')
        const result = await pollQrLogin({
          qrcodeKey: key,
          timeoutSec: optionalInteger(args, 'timeout_sec', 150, [5, 600]),
          cookieFile: defaults.cookieFile || undefined,
          timeoutMs: defaults.timeoutMs,
          signal: exec.signal,
        })
        const markdown =
          result.status === 'success'
            ? `登录成功${result.user ? `：${result.user.name}（mid ${result.user.mid}）` : ''}。Cookie 已保存到 \`${result.cookieFile}\`。`
            : `登录未完成：${result.status} — ${result.message ?? ''}`
        return { ...result, markdown }
      }
      if (action === 'status') {
        if (!credentials.cookies.SESSDATA) {
          return { loggedIn: false, cookieFile: credentials.file, markdown: `未登录，且 ${credentials.file} 中没有 SESSDATA。` }
        }
        const account = await fetchAccount({
          cookie: cookieHeader(credentials.cookies),
          timeoutMs: defaults.timeoutMs,
          signal: exec.signal,
        })
        const markdown = account.loggedIn
          ? `已登录：${account.name}（mid ${account.mid}），凭据来自 ${credentials.source}（${credentials.file}）。`
          : `Cookie 已过期或无效（来源 ${credentials.source}，${credentials.file}）。`
        return { ...account, source: credentials.source, cookieFile: credentials.file, savedAt: credentials.savedAt, markdown }
      }
      const removed = clearCookieFile(credentials.file)
      return { removed, cookieFile: credentials.file, markdown: removed ? `已删除 ${credentials.file}。` : '没有可删除的凭据文件。' }
    },
  })
}

/**
 * Build the video-info tool.
 * @param defaults - resolved plugin configuration.
 * @returns the tool definition.
 */
function infoTool(defaults) {
  return defineTool({
    name: 'bilibili_video_info',
    description:
      'Read one Bilibili video\'s metadata (title, UP, duration, description, stats, parts), the subtitle ' +
      'tracks the platform lists for it, and Bilibili\'s own AI summary when one exists. Works signed out; ' +
      'the AI summary needs the stored sign-in. Use it to check whether a video has a subtitle track at all ' +
      'before falling back to local transcription.',
    properties: {
      url: { type: 'string', description: 'Bilibili video URL, BV id, or av id.' },
      page: { type: 'integer', description: 'One-based part number for a multi-part video.' },
      include_ai_summary: { type: 'boolean', description: 'Fetch Bilibili\'s AI summary too. Defaults to true.' },
      include_comments: {
        type: 'boolean',
        description:
          'Fetch the comment section\'s long, well-liked comments as a fallback source. Defaults to true when the ' +
          'video has no subtitle track, false otherwise.',
      },
    },
    required: ['url'],
    render: renderStatus,
    execute: async (args, exec) => {
      const credentials = loadCredentials(defaults)
      const cookie = cookieHeader(credentials.cookies)
      const bvid = await resolveBvid(optionalString(args, 'url'), { timeoutMs: defaults.timeoutMs, signal: exec.signal })
      const video = await fetchVideoInfo({ bvid, cookie, timeoutMs: defaults.timeoutMs, signal: exec.signal })
      const { entry, cid } = selectPage(video, optionalInteger(args, 'page', undefined, [1, 10_000]))
      const trackList = await fetchSubtitleTracks({
        bvid,
        aid: video.aid,
        cid,
        cookie,
        language: defaults.language,
        timeoutMs: defaults.timeoutMs,
        signal: exec.signal,
      }).catch((error) => ({ tracks: [], error: String(error.message ?? error) }))
      let aiSummary
      if (args?.include_ai_summary !== false && credentials.cookies.SESSDATA) {
        aiSummary = await fetchAiConclusion({
          bvid,
          cid,
          upMid: video.owner?.mid,
          cookie,
          timeoutMs: defaults.timeoutMs,
          signal: exec.signal,
        }).catch((error) => ({ available: false, error: String(error.message ?? error) }))
      }
      const tracks = trackList.tracks ?? []
      const wantComments = args?.include_comments === true || (args?.include_comments !== false && tracks.length === 0)
      const commentDigest = wantComments
        ? await fetchHotComments({
            aid: video.aid,
            cookie,
            referer: `${video.url}/`,
            timeoutMs: defaults.timeoutMs,
            signal: exec.signal,
          }).catch((error) => ({ scanned: 0, comments: [], error: String(error.message ?? error) }))
        : undefined
      const markdown = [
        `# ${video.title}`,
        '',
        `- 视频：${video.url}`,
        `- UP 主：${video.owner?.name ?? '未知'}`,
        `- 时长：${formatDuration(video.duration)}（${video.duration}s）`,
        video.pages?.length > 1 ? `- 分P：共 ${video.pages.length} 集，当前第 ${entry.page} 集（cid ${cid}）` : undefined,
        `- 字幕轨道：${tracks.length ? tracks.map((track) => `${track.lan}（${track.lan_doc}）`).join('、') : '无（可回退 bilibili_transcribe 的 B站必剪 ASR）'}`,
        '',
        '## 简介',
        '',
        video.description || '（无简介）',
        '',
        aiSummary?.available
          ? `## B站 AI 总结\n\n${aiSummary.summary || '（无摘要文本）'}\n\n${(aiSummary.outline ?? [])
              .map((section) => `### ${section.title}\n\n${section.points.map((point) => `- ${point.content}`).join('\n')}`)
              .join('\n\n')}`
          : '## B站 AI 总结\n\n（该视频没有 B站 AI 总结）',
        commentDigest?.comments?.length
          ? `## 评论区长评（降级来源，共扫描 ${commentDigest.scanned} 条）\n\n${commentDigest.comments
              .map((comment) => `### ${comment.author} · ${comment.likes} 赞\n\n${comment.text}`)
              .join('\n\n')}`
          : undefined,
      ]
        .filter((line) => line !== undefined)
        .join('\n')
      return {
        video,
        page: entry,
        cid,
        signedIn: Boolean(credentials.cookies.SESSDATA),
        tracks,
        subtitleRoute: trackList.route,
        aiSummary,
        comments: commentDigest,
        markdown,
      }
    },
  })
}

/**
 * Resolve, fetch, validate and optionally merge one subtitle track.
 *
 * This is the single extraction core shared by `bilibili_subtitles`,
 * `bilibili_transcript_part` and `bilibili_transcript_search`. The retry and
 * three-level validation behavior is unchanged from the summary package.
 *
 * @param options - tool args, exec and resolved defaults.
 * @returns credentials, video, page entry, track, segments, stats, assessment,
 *   attempts and warning.
 */
async function collectSubtitleData({ args, exec, defaults }) {
  const credentials = loadCredentials(defaults)
  if (!credentials.cookies.SESSDATA) throw new Error(`not signed in. ${LOGIN_HINT}`)
  const cookie = cookieHeader(credentials.cookies)
  const url = optionalString(args, 'url')
  const lang = optionalString(args, 'lang') ?? defaults.language
  const strict = args?.strict !== false
  const retries = optionalInteger(args, 'retries', defaults.retries ?? DEFAULT_RETRIES, [1, 20])
  const minCoverage = optionalNumber(args, 'min_coverage', DEFAULT_MIN_COVERAGE)
  const minSegments = optionalInteger(args, 'min_segments', MIN_SEGMENTS, [1, 10_000])

  const bvid = await resolveBvid(url, { timeoutMs: defaults.timeoutMs, signal: exec.signal })
  const video = await fetchVideoInfo({ bvid, cookie, timeoutMs: defaults.timeoutMs, signal: exec.signal })
  const { entry, cid } = selectPage(video, optionalInteger(args, 'page', undefined, [1, 10_000]))
  const duration = entry.duration || video.duration
  const attempts = []
  let accepted
  let rejected
  let sawTrack = false
  for (let attempt = 1; attempt <= retries; attempt++) {
    const listed = await fetchSubtitleTracks({
      bvid,
      aid: video.aid,
      cid,
      cookie,
      language: lang,
      timeoutMs: defaults.timeoutMs,
      signal: exec.signal,
    })
    const track = pickTrack(listed.tracks, lang)
    if (track) {
      sawTrack = true
      const segments = await fetchSubtitleBody({
        url: track.subtitle_url,
        timeoutMs: defaults.timeoutMs,
        signal: exec.signal,
        referer: `${video.url}/`,
      }).catch(() => [])
      const stats = assessSegments(segments, duration)
      const assessment = assessMatch({
        title: video.title,
        segments,
        duration,
        minSegments,
        minCoverage,
      })
      attempts.push({ attempt, route: listed.route, lan: track.lan, verdict: assessment.verdict, ...stats })
      const candidate = { track, tracks: listed.tracks, segments, stats, assessment, route: listed.route, attempts: attempt }
      if (assessment.accepted) {
        accepted = candidate
        break
      }
      if (!rejected || stats.count > rejected.stats.count) rejected = candidate
    } else {
      attempts.push({ attempt, route: listed.route, tracks: 0, verdict: 'no-track' })
    }
    if (attempt < retries) {
      await sleep((defaults.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_MS) + attempt * RETRY_STEP_MS, exec.signal)
    }
  }
  const trackAttempts = attempts.filter((item) => item.lan)
  const emptyBody = sawTrack && trackAttempts.length > 0 && trackAttempts.every((item) => (item.count ?? 0) === 0)
  if (emptyBody) {
    throw new Error(
      `subtitle track exists for ${video.title} but its subtitle body is empty after ${retries} tries ` +
        `(${trackAttempts.map((item) => `#${item.attempt} ${item.lan}`).join('；')}); refusing to write an empty transcript. ` +
        'Bilibili may be rate-limiting the subtitle CDN body — retry later.',
    )
  }
  const chosen = accepted ?? (strict ? undefined : rejected)
  if (!chosen) {
    const detail = attempts
      .map((item) =>
        item.lan
          ? `#${item.attempt} ${item.lan} ${item.count}段/${Math.round(item.coverage * 100)}%/${item.verdict}`
          : `#${item.attempt} 无轨道`,
      )
      .join('；')
    throw new Error(
      sawTrack
        ? `subtitle tracks exist for ${video.title} but every attempt failed validation after ${retries} tries ` +
          `(${detail}). Bilibili is rate-limiting, or the returned track belongs to another video. Retry later.`
        : `${video.title}（${video.url}）没有可用的字幕轨道：B站 未给该视频生成 AI 字幕，也没有上传 CC 字幕。` +
          `尝试记录：${detail}。可回退：bilibili_video_info（看 B站 AI 总结与评论区长评），或 bilibili_transcribe（B站必剪 ASR，适合约 10 分钟以内的视频）。`,
    )
  }
  if (!Array.isArray(chosen.segments) || chosen.segments.length === 0) {
    throw new Error(`subtitle extraction for ${video.title} returned zero segments; refusing to write an empty transcript`)
  }

  const stats = { ...chosen.stats, validated: Boolean(accepted), assessment: chosen.assessment }
  const track = {
    lan: chosen.track.lan,
    lan_doc: chosen.track.lan_doc,
    ai: String(chosen.track.lan).startsWith('ai'),
    route: chosen.route,
  }
  let segments = chosen.segments
  let secondary
  const bilingual = args?.bilingual
  if (bilingual) {
    const companion = pickCompanionTrack(chosen.tracks ?? [], chosen.track, typeof bilingual === 'string' ? bilingual : undefined)
    if (companion) {
      const companionSegments = await fetchSubtitleBody({
        url: companion.subtitle_url,
        timeoutMs: defaults.timeoutMs,
        signal: exec.signal,
        referer: `${video.url}/`,
      }).catch(() => [])
      if (companionSegments.length > 0) {
        segments = mergeBilingual(chosen.segments, companionSegments)
        secondary = { lan: companion.lan, lan_doc: companion.lan_doc, segments: companionSegments.length }
      }
    }
  }
  const built = buildTranscriptMarkdown({ video, page: entry.page, track: chosen.track, segments, stats })
  return {
    credentials,
    video,
    entry,
    cid,
    track,
    secondary,
    segments,
    stats: { ...stats, attempts: chosen.attempts, attemptLog: attempts },
    assessment: chosen.assessment,
    validation: validationFor(chosen.assessment),
    attempts,
    warning: accepted
      ? chosen.assessment.verdict === 'weak'
        ? `validation is weak (${chosen.assessment.reasons.join('；') || 'no title keyword hit'}); verify before quoting`
        : undefined
      : 'transcript did not pass validation; treat it as unverified',
    markdown: built.markdown,
  }
}

/**
 * Build the subtitle tool.
 * @param defaults - resolved plugin configuration.
 * @returns the tool definition.
 */
function subtitlesTool(defaults) {
  return defineTool({
    name: 'bilibili_subtitles',
    description:
      'Extract a Bilibili video\'s AI or creator-uploaded subtitle track through the platform\'s own subtitle ' +
      'service and write the full transcript to a disk bundle. By default returns a manifest (parts, time index, ' +
      'gaps, files) plus one bounded part; walk the rest with bilibili_transcript_part or search with ' +
      'bilibili_transcript_search. Requires the stored sign-in. The service can answer with a truncated body ' +
      'under rate limiting, so the tool validates segment count and duration coverage and retries with growing ' +
      'backoff. When a video simply has no track, it says so plainly — call bilibili_transcribe for those.',
    properties: {
      url: { type: 'string', description: 'Bilibili video URL, BV id, or av id.' },
      page: { type: 'integer', description: 'One-based part number for a multi-part video.' },
      lang: { type: 'string', description: 'Preferred track language, for example ai-zh or zh-CN. Defaults to ai-zh.' },
      format: {
        type: 'string',
        enum: ['markdown', 'text', 'srt', 'ass', 'lrc', 'json'],
        description: 'Payload written to "out". Defaults to markdown.',
      },
      bilingual: {
        type: ['boolean', 'string'],
        description:
          'Also fetch a second track and merge it under each line (bilingual subtitles). Pass true to pick the ' +
          'best companion automatically, or a language code such as ai-en to name it.',
      },
      out: {
        type: 'string',
        description: 'Optional file to write the full transcript to; relative paths resolve against the workspace.',
      },
      strict: {
        type: 'boolean',
        description: 'Fail instead of returning a transcript that did not pass validation. Defaults to true.',
      },
      min_coverage: { type: 'number', description: 'Fraction of the video the transcript must cover. Defaults to 0.6.' },
      retries: { type: 'integer', description: 'Attempts before giving up. Defaults to 6.' },
      min_segments: { type: 'integer', description: 'Fewest segments a valid transcript may have. Defaults to 20.' },
      part: { type: 'integer', description: 'Part body to return (1-based). Defaults to 1.' },
      cursor: {
        type: 'string',
        description:
          'Opaque cursor from a previous result: "<page>-<part>" means the configured default packing, "<page>-<part>@<maxChars>" carries a non-default packing. Overrides part and supplies the page.',
      },
      max_chars: {
        type: 'integer',
        description: 'Characters per part, 2000-12000. Defaults to the configured partChars (6000).',
      },
      index_only: { type: 'boolean', description: 'Return only the manifest and time index, without a part body. Defaults to false.' },
      legacy_full: {
        type: 'boolean',
        description: 'Return the old full transcript shape (segments, timeline, markdown) plus manifest. May be truncated by the harness; prefer parts.',
      },
      out_dir: { type: 'string', description: 'Bundle root; defaults to bili-out. Relative paths resolve against the workspace.' },
    },
    required: ['url'],
    render: renderMarkdown,
    execute: async (args, exec) => {
      const format = optionalString(args, 'format') ?? 'markdown'
      const { parsedCursor, requestedPage, maxChars, defaultMaxChars } = resolvePackingArguments({ args, defaults })
      const collected = await collectSubtitleData({ args: { ...args, page: requestedPage ?? parsedCursor?.page }, exec, defaults })
      const persisted = await persistTranscript({
        args,
        exec,
        defaults,
        collected,
        segments: collected.segments,
        maxChars,
      })
      const video = summarizeVideo(collected.video)
      const entry = collected.entry
      const track = collected.track
      const manifest = persisted.manifest
      const totalParts = persisted.parts.length
      const out = optionalString(args, 'out')
      const file = out
        ? writeTranscript({
            format,
            target: await exec.resolvePath(out),
            video: collected.video,
            page: entry,
            track,
            stats: collected.stats,
            segments: collected.segments,
            markdown: collected.markdown,
          })
        : ''
      const base = {
        video,
        page: entry,
        track,
        secondary: collected.secondary,
        validation: collected.validation,
        stats: collected.stats,
        manifest,
        files: persisted.files,
        source: 'subtitle',
        warning: collected.warning,
        file,
      }
      if (args?.legacy_full === true) {
        return {
          ...base,
          timeline: groupSegments(collected.segments).map((block) => ({
            ...block,
            url: momentUrl(collected.video.bvid, block.from, entry.page),
          })),
          transcript: toPlainText(collected.segments),
          segments: collected.segments,
          markdown: collected.markdown,
        }
      }
      const indexOnly = args?.index_only === true
      let selected = null
      if (!indexOnly) {
        const rawPart = args?.part
        if (rawPart !== undefined && rawPart !== null && (!Number.isInteger(rawPart) || rawPart < 1)) {
          throw new Error('part must be a positive integer')
        }
        let partNumber = optionalInteger(args, 'part', undefined, [1, 10_000]) ?? 1
        if (parsedCursor) {
          if (parsedCursor.page !== (entry.page ?? 1)) {
            throw new Error(`cursor page ${parsedCursor.page} does not match page ${entry.page ?? 1}`)
          }
          partNumber = parsedCursor.part
        }
        if (partNumber > totalParts) {
          throw new Error(`part ${partNumber} is out of range; this transcript has ${totalParts} part(s)`)
        }
        const part = persisted.parts[partNumber - 1]
        selected = {
          part: part.part,
          from: part.from,
          to: part.to,
          chars: part.chars,
          markdown: buildPartMarkdown({ video, page: entry, part, totalParts, track }),
          segments: part.segments,
        }
      }
      const nextCursor =
        selected && selected.part < totalParts
          ? cursorFor(entry.page ?? 1, selected.part + 1, maxChars !== defaultMaxChars ? maxChars : undefined)
          : null
      const remaining = selected ? totalParts - selected.part : totalParts
      const markdown = buildManifestMarkdown({
        video,
        page: entry,
        track,
        validation: collected.validation,
        stats: manifest.stats,
        parts: persisted.parts,
        index: persisted.index,
        gaps: persisted.gaps,
        files: persisted.files,
        packing: persisted.packing,
        minGapSeconds: defaults.gapSeconds ?? 10,
        currentPart: selected ? persisted.parts[selected.part - 1] : null,
      })
      return { ...base, part: selected, next_cursor: nextCursor, remaining_parts: remaining, markdown }
    },
  })
}

/**
 * Build the transcript-part tool.
 * @param defaults - resolved plugin configuration.
 * @returns the tool definition.
 */
function transcriptPartTool(defaults) {
  return defineTool({
    name: 'bilibili_transcript_part',
    description:
      'Read one part of a Bilibili transcript from its disk bundle (or extract and write the bundle first when ' +
      'it is missing). Use this to walk a long transcript without loading it all: pass part, or the cursor from ' +
      'a previous result. Pass max_chars to repack at a different size without losing text; the returned ' +
      'next_cursor carries that packing, so following it restores the same part numbering.',
    properties: {
      url: { type: 'string', description: 'Bilibili video URL, BV id, or av id.' },
      page: { type: 'integer', description: 'One-based part number for a multi-part video. Defaults to 1.' },
      part: { type: 'integer', description: 'Part number to read (1-based). Defaults to 1.' },
      cursor: {
        type: 'string',
        description:
          'Opaque cursor from a previous result: "<page>-<part>" means the configured default packing, "<page>-<part>@<maxChars>" carries a non-default packing. Overrides part and supplies the page.',
      },
      max_chars: {
        type: 'integer',
        description: 'Repack at this many characters per part (2000-12000). Omit to use the bundle packing.',
      },
      format: {
        type: 'string',
        enum: ['markdown', 'text', 'json'],
        description: 'Payload written to "out". Defaults to markdown.',
      },
      out: { type: 'string', description: 'Optional file to write the selected part to.' },
      out_dir: { type: 'string', description: 'Bundle root; defaults to bili-out.' },
    },
    required: ['url'],
    render: renderMarkdown,
    execute: async (args, exec) => {
      const bundle = await ensureTranscriptBundle({ args, exec, defaults })
      const manifest = bundle.manifest
      const pageNumber = Number(bundle.transcript?.page?.page ?? bundle.meta?.page?.page ?? 1)
      const pageEntry = bundle.transcript?.page ?? bundle.meta?.page ?? { page: pageNumber }
      const segments = bundle.transcript.segments
      const canonical = partsFromBundle(bundle)
      const canonicalPacking = manifest.packing ?? { maxChars: 6000, maxSeconds: 600 }
      const defaultMaxChars = defaults.partChars ?? 6000
      const cursorArg = optionalString(args, 'cursor')
      const parsedCursor = cursorArg ? parseCursor(cursorArg) : undefined
      if (parsedCursor && parsedCursor.page !== pageNumber) {
        throw new Error(`cursor page ${parsedCursor.page} does not match page ${pageNumber}`)
      }
      const rawPart = args?.part
      if (rawPart !== undefined && rawPart !== null && (!Number.isInteger(rawPart) || rawPart < 1)) {
        throw new Error('part must be a positive integer')
      }
      const explicitMaxChars =
        args?.max_chars === undefined || args?.max_chars === null
          ? undefined
          : optionalInteger(args, 'max_chars', defaultMaxChars, [2000, 12_000])
      if (explicitMaxChars !== undefined && parsedCursor?.maxChars !== undefined && explicitMaxChars !== parsedCursor.maxChars) {
        throw new Error(
          `cursor was packed at ${parsedCursor.maxChars} chars; pass max_chars: ${parsedCursor.maxChars} or omit max_chars`,
        )
      }
      if (
        parsedCursor &&
        parsedCursor.maxChars === undefined &&
        explicitMaxChars !== undefined &&
        explicitMaxChars !== defaultMaxChars
      ) {
        throw new Error(`cursor is canonical at ${defaultMaxChars} chars; pass max_chars: ${defaultMaxChars} or omit max_chars`)
      }
      // A plain cursor means the configured default packing; without a cursor,
      // parts are read with the packing the bundle was written at.
      const effectiveMaxChars = explicitMaxChars ?? parsedCursor?.maxChars ?? (parsedCursor ? defaultMaxChars : canonicalPacking.maxChars)
      let parts = canonical
      let packing = canonicalPacking
      let useFiles = true
      if (effectiveMaxChars !== canonicalPacking.maxChars) {
        parts = packParts(segments, { maxChars: effectiveMaxChars, maxSeconds: canonicalPacking.maxSeconds })
        packing = { maxChars: effectiveMaxChars, maxSeconds: canonicalPacking.maxSeconds }
        useFiles = false
      }
      const totalParts = parts.length
      if (totalParts === 0) throw new Error('the transcript bundle contains no parts')
      let partNumber = optionalInteger(args, 'part', undefined, [1, 10_000]) ?? 1
      if (parsedCursor) partNumber = parsedCursor.part
      if (partNumber > totalParts) {
        throw new Error(`part ${partNumber} is out of range; this transcript has ${totalParts} part(s)`)
      }
      const raw = parts[partNumber - 1]
      const markdown =
        typeof raw.markdown === 'string' && raw.markdown.length > 0
          ? raw.markdown
          : buildPartMarkdown({ video: bundle.meta.video, page: pageEntry, part: raw, totalParts, track: bundle.meta.track })
      const part = { part: raw.part, from: raw.from, to: raw.to, chars: raw.chars, markdown, segments: raw.segments }
      const video = bundle.meta.video
      const index = Array.isArray(manifest.index)
        ? manifest.index
        : buildIndex(bundle.transcript.segments ?? [], {
            chunkSeconds: defaults.indexChunkSeconds ?? 300,
            maxEntries: 60,
          })
      const canonicalFile = useFiles ? (manifest.parts.find((entry) => entry.part === partNumber)?.file ?? '') : ''
      const nextCursor =
        partNumber < totalParts
          ? cursorFor(pageNumber, partNumber + 1, packing.maxChars !== defaultMaxChars ? packing.maxChars : undefined)
          : null
      const outFile = await writePartOutput({
        args,
        exec,
        format: optionalString(args, 'format') ?? 'markdown',
        part,
        video,
        page: pageEntry,
      })
      const navigation =
        partNumber < totalParts
          ? `下一段：part ${partNumber + 1}，cursor ${nextCursor}（共 ${totalParts} 段）`
          : `已到最后一段（共 ${totalParts} 段）。`
      return {
        video,
        page: pageEntry,
        part,
        total_parts: totalParts,
        from: part.from,
        to: part.to,
        chars: part.chars,
        index,
        next_cursor: nextCursor,
        remaining_parts: totalParts - partNumber,
        packing,
        file: outFile || canonicalFile,
        source: bundle.meta.source ?? bundle.transcript.source ?? 'subtitle',
        markdown: `${markdown}\n\n${navigation}`,
      }
    },
  })
}

/**
 * Build the transcript-search tool.
 * @param defaults - resolved plugin configuration.
 * @returns the tool definition.
 */
function transcriptSearchTool(defaults) {
  return defineTool({
    name: 'bilibili_transcript_search',
    description:
      'Search a Bilibili transcript bundle for a literal keyword (never a regular expression) and return the ' +
      'time, canonical part number, and surrounding context of every hit. Use it to find where a video mentions ' +
      'something without reading every part. Extracts and writes the bundle first when it is missing.',
    properties: {
      url: { type: 'string', description: 'Bilibili video URL, BV id, or av id.' },
      page: { type: 'integer', description: 'One-based part number for a multi-part video. Defaults to 1.' },
      query: { type: 'string', description: 'Literal text to find (case-insensitive by default).' },
      case_sensitive: { type: 'boolean', description: 'Match case exactly. Defaults to false.' },
      max_matches: { type: 'integer', description: 'Maximum returned matches, 1-100. Defaults to 20.' },
      context_chars: { type: 'integer', description: 'Context characters before/after each hit, 0-500. Defaults to 80.' },
      out_dir: { type: 'string', description: 'Bundle root; defaults to bili-out.' },
    },
    required: ['url', 'query'],
    render: renderMarkdown,
    execute: async (args, exec) => {
      const bundle = await ensureTranscriptBundle({ args, exec, defaults })
      const query = optionalString(args, 'query')
      const parts = partsFromBundle(bundle)
      const result = searchSegments(bundle.transcript.segments, query, {
        caseSensitive: args?.case_sensitive === true,
        maxMatches: optionalInteger(args, 'max_matches', 20, [1, 100]),
        contextChars: optionalInteger(args, 'context_chars', 80, [0, 500]),
      })
      const matches = result.matches.map((match) => ({
        part: partForTime(parts, match.time)?.part ?? 0,
        time: match.time,
        text: match.text,
        before: match.before,
        after: match.after,
      }))
      const partsHint = [...new Set(matches.map((match) => match.part).filter((part) => part > 0))].sort((left, right) => left - right)
      const lines = [`# 文稿检索：${query}`, '', `- 命中 ${result.totalMatches} 处，返回 ${matches.length} 处`]
      if (matches.length === 0) lines.push('- 没有命中')
      let size = lines.join('\n').length
      for (const match of matches) {
        const line = `- P${match.part} ${formatClock(match.time)} … ${match.before}【${query}】${match.after}`
        if (size + line.length > 8000) {
          lines.push('- … 其余命中已截断，缩小关键词或增大 max_matches（上限 100）')
          break
        }
        lines.push(line)
        size += line.length
      }
      return {
        video: bundle.meta.video,
        page: bundle.transcript?.page ?? bundle.meta?.page,
        query,
        total_matches: result.totalMatches,
        truncated: result.truncated,
        matches,
        parts_hint: partsHint,
        markdown: lines.join('\n'),
      }
    },
  })
}

/**
 * Persist a machine transcription and shape the paged tool result.
 *
 * Shared by the Bcut and faster-whisper paths so cursor, packing and part
 * selection rules stay identical. Both keep `source: "asr"` in the bundle and
 * name the actual provider in `asr`.
 *
 * @param options - tool args, exec, defaults, video/page, segments, packing,
 *   track and the `asr` metadata.
 * @returns the tool result (manifest plus one bounded part by default).
 */
async function persistAsrResult({ args, exec, defaults, video, entry, segments, maxChars, track, asr, reasons }) {
  const format = optionalString(args, 'format') ?? 'markdown'
  const duration = entry.duration || video.duration
  const assessed = assessSegments(segments, duration)
  const validation = {
    verdict: 'asr',
    accepted: true,
    count: assessed.count,
    coveredSeconds: assessed.coveredSeconds,
    coverage: assessed.coverage,
    keywordHits: 0,
    matchedKeywords: [],
    reasons,
  }
  const persisted = await persistTranscript({
    args,
    exec,
    defaults,
    collected: { video, entry, track, validation },
    segments,
    maxChars,
    source: 'asr',
  })
  const summary = summarizeVideo(video)
  const manifest = persisted.manifest
  const totalParts = persisted.parts.length
  const renderManifest = (currentPart) =>
    buildManifestMarkdown({
      video: summary,
      page: entry,
      track,
      validation,
      stats: manifest.stats,
      parts: persisted.parts,
      index: persisted.index,
      gaps: persisted.gaps,
      files: persisted.files,
      packing: persisted.packing,
      minGapSeconds: defaults.gapSeconds ?? 10,
      currentPart,
    })
  const base = {
    video: summary,
    page: entry,
    track,
    validation,
    stats: assessed,
    manifest,
    files: persisted.files,
    source: 'asr',
    asr,
  }

  if (args?.legacy_full === true) {
    const built = buildTranscriptMarkdown({ video, page: entry.page, track, segments, stats: assessed })
    const out = optionalString(args, 'out')
    const file = out
      ? writeTranscript({
          format,
          target: await exec.resolvePath(out),
          video,
          page: entry,
          track,
          stats: assessed,
          segments,
          markdown: built.markdown,
        })
      : ''
    return {
      ...base,
      timeline: groupSegments(segments).map((block) => ({
        ...block,
        url: momentUrl(video.bvid, block.from, entry.page),
      })),
      transcript: toPlainText(segments),
      segments,
      file,
      markdown: built.markdown,
    }
  }

  if (args?.index_only === true) {
    return {
      ...base,
      part: null,
      total_parts: totalParts,
      next_cursor: null,
      remaining_parts: totalParts,
      index: persisted.index,
      packing: persisted.packing,
      file: '',
      markdown: renderManifest(null),
    }
  }

  // Reuse the transcript-part tool for part selection, cursor and packing
  // rules instead of duplicating them. Passing the BV id keeps it from
  // re-resolving the URL (and re-extracting) on the way in.
  const selected = await transcriptPartTool(defaults).execute({ ...args, url: video.bvid }, exec)
  return {
    ...base,
    part: selected.part,
    total_parts: selected.total_parts,
    next_cursor: selected.next_cursor,
    remaining_parts: selected.remaining_parts,
    index: selected.index,
    packing: selected.packing,
    file: selected.file,
    markdown: renderManifest(selected.part),
  }
}

/**
 * Build the no-subtitle transcription tool.
 *
 * Bcut (必剪) is the default: anonymous, fast and model-free. When it rejects
 * the audio, `provider: "auto"` tries an already-installed faster-whisper
 * runtime and otherwise returns a structured needs-setup result that offers
 * persistent and temporary installation. Nothing is installed or downloaded
 * by this tool; installation is only ever `bilibili_asr_setup` after the user
 * chooses.
 *
 * @param defaults - resolved plugin configuration.
 * @returns the tool definition.
 */
function transcribeTool(defaults) {
  return defineTool({
    name: 'bilibili_transcribe',
    description:
      'Fallback for a Bilibili video that has no subtitle track. By default it transcribes the audio with ' +
      'Bilibili\'s own Bcut (必剪) ASR, which needs no local model and no sign-in; it submits the ' +
      'lowest-bitrate audio candidate and writes the same paged transcript bundle as bilibili_subtitles ' +
      'with source "asr". When Bcut cannot handle the audio (it accepts only roughly ten minutes), ' +
      'provider "auto" tries an already-installed faster-whisper runtime; if none is installed it returns ' +
      'status "needs_asr_runtime" with persistent/temporary setup choices instead of downloading anything. ' +
      'The plugin never bundles or installs faster-whisper or a model by itself: ask the user which mode ' +
      'they want, call bilibili_asr_setup, then retry. The result is a manifest plus one bounded part by ' +
      'default; walk the rest with bilibili_transcript_part or search with bilibili_transcript_search.',
    properties: {
      url: { type: 'string', description: 'Bilibili video URL, BV id, or av id.' },
      page: { type: 'integer', description: 'One-based part number for a multi-part video.' },
      provider: {
        type: 'string',
        enum: ['auto', 'bcut', 'faster-whisper'],
        description:
          'ASR provider. auto (default): Bcut first, then an installed faster-whisper runtime. bcut: Bcut only. ' +
          'faster-whisper: skip Bcut and use an installed runtime (needs bilibili_asr_setup first).',
      },
      model: {
        type: 'string',
        description: 'faster-whisper model for the optional local fallback (default small). Ignored by Bcut.',
      },
      language: {
        type: 'string',
        description: 'Spoken language for the local fallback; "auto" detects it. Ignored by Bcut.',
      },
      part: { type: 'integer', description: 'Part body to return (1-based). Defaults to 1.' },
      cursor: {
        type: 'string',
        description:
          'Opaque cursor from a previous result: "<page>-<part>" means the configured default packing, "<page>-<part>@<maxChars>" carries a non-default packing. Overrides part and supplies the page.',
      },
      max_chars: {
        type: 'integer',
        description: 'Characters per part, 2000-12000. Defaults to the configured partChars (6000).',
      },
      index_only: { type: 'boolean', description: 'Return only the manifest and time index, without a part body. Defaults to false.' },
      legacy_full: {
        type: 'boolean',
        description: 'Return the old full transcript shape (segments, timeline, markdown) plus manifest. May be truncated by the harness; prefer parts.',
      },
      format: {
        type: 'string',
        enum: ['markdown', 'text', 'srt', 'json'],
        description: 'Payload written to "out". Defaults to markdown.',
      },
      out: {
        type: 'string',
        description: 'Optional file to write the selected part (or the full transcript with legacy_full) to.',
      },
      out_dir: { type: 'string', description: 'Bundle root; defaults to bili-out. Relative paths resolve against the workspace.' },
    },
    required: ['url'],
    render: renderMarkdown,
    execute: async (args, exec) => {
      const credentials = loadCredentials(defaults)
      const cookie = cookieHeader(credentials.cookies)
      const provider = optionalString(args, 'provider') ?? 'auto'
      if (!['auto', 'bcut', 'faster-whisper'].includes(provider)) {
        throw new Error(`unknown ASR provider "${provider}"`)
      }
      const model = optionalString(args, 'model') ?? defaults.asrModel ?? 'small'
      const language = optionalText(args, 'language') ?? defaults.asrLanguage ?? 'auto'
      // Resolve the cursor and packing before spending a transcription on it, so
      // a contradictory cursor fails fast instead of after minutes of ASR. The
      // rules are the same ones bilibili_subtitles uses.
      const { parsedCursor, requestedPage, maxChars } = resolvePackingArguments({ args, defaults })

      const bvid = await resolveBvid(optionalString(args, 'url'), { timeoutMs: defaults.timeoutMs, signal: exec.signal })
      const video = await fetchVideoInfo({ bvid, cookie, timeoutMs: defaults.timeoutMs, signal: exec.signal })
      const { entry, cid } = selectPage(video, requestedPage ?? parsedCursor?.page)
      const outDir = await resolveOutDir({ args, exec, defaults })
      const stream = await fetchAudioStream({
        bvid,
        aid: video.aid,
        cid,
        cookie,
        timeoutMs: defaults.timeoutMs,
        signal: exec.signal,
      })
      // The lowest-bandwidth DASH candidate is the one Bcut accepts; the top
      // candidate is routinely rejected for a 9-minute video.
      const audio = pickLowestAudio(stream?.candidates ?? [stream])
      if (!audio?.url) throw new Error('Bilibili returned no audio stream to transcribe')

      let bcutError = ''
      let bcutSegments
      if (provider !== 'faster-whisper') {
        // Only the Bcut call (and its empty-result check) is classified as a
        // Bcut failure. A persistence/part-validation error afterwards must
        // surface as itself, not trigger needs_asr_runtime or a second
        // transcription.
        try {
          const bcut = await transcribeWithBcut({
            audioUrl: audio.url,
            signal: exec.signal,
            timeoutMs: defaults.bcutTimeoutMs ?? 600_000,
            pollMs: defaults.bcutPollMs ?? 5_000,
          })
          const segments = bcut.segments ?? []
          if (segments.length === 0) {
            throw new Error('Bcut returned no speech segments; refusing to write an empty transcript')
          }
          bcutSegments = segments
        } catch (error) {
          // An explicit `provider: "bcut"` means "do not silently pick another
          // provider"; cancellation also propagates untouched.
          if (provider === 'bcut' || exec.signal?.aborted) throw error
          bcutError = String(error?.message ?? error)
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 400)
        }
        if (bcutSegments) {
          return await persistAsrResult({
            args,
            exec,
            defaults,
            video,
            entry,
            segments: bcutSegments,
            maxChars,
            track: { lan: 'asr-zh', lan_doc: 'B站必剪 ASR', ai: true, route: 'bcut' },
            asr: { provider: 'bcut' },
            reasons: ['machine transcription via Bcut'],
          })
        }
      }

      // The fallback only uses a runtime that already exists. It never starts an
      // install or a model download on its own.
      const runtime = await findExistingRuntime({ outDir, defaults, signal: exec.signal })
      if (!runtime) {
        return needsSetupResult({
          bcutError: bcutError || 'faster-whisper was requested but no local runtime is installed',
          model,
          provider: provider === 'faster-whisper' ? 'faster-whisper' : 'bcut',
        })
      }

      mkdirSync(outDir, { recursive: true })
      const audioDir = mkdtempSync(join(outDir, '.asr-run-'))
      const audioPath = join(audioDir, 'audio.wav')
      let temporaryCleaned = false
      const cleanupTemporary = () => {
        if (temporaryCleaned || runtime.mode !== 'temporary') return undefined
        temporaryCleaned = true
        return cleanupTemporaryRuntime({ outDir, defaults })
      }

      try {
        await downloadAudio({
          url: audio.url,
          referer: `https://www.bilibili.com/video/${bvid}/`,
          outPath: audioPath,
          ffmpegPath: resolveFfmpeg(defaults.ffmpegPath),
          timeoutMs: defaults.asrDownloadTimeoutMs ?? 600_000,
          signal: exec.signal,
        })
        const local = await transcribeAudio({
          python: runtime.python,
          audioPath,
          outPath: join(audioDir, 'transcript.json'),
          model,
          modelDir: runtime.modelDir,
          language,
          signal: exec.signal,
          timeoutMs: defaults.asrTimeoutMs ?? 30 * 60 * 1000,
        })
        const segments = local.segments ?? []
        if (segments.length === 0) {
          throw new Error('faster-whisper returned no speech segments; refusing to write an empty transcript')
        }
        const result = await persistAsrResult({
          args,
          exec,
          defaults,
          video,
          entry,
          segments,
          maxChars,
          track: { lan: 'asr-zh', lan_doc: `faster-whisper (${model})`, ai: true, route: 'faster-whisper' },
          asr: {
            provider: 'faster-whisper',
            model,
            language: local.language ?? language,
            runtime: runtime.mode,
            temporary: runtime.mode === 'temporary',
          },
          reasons: ['machine transcription via faster-whisper', `local model: ${model}`],
        })
        // The bundle is fully written and read back before its runtime is
        // removed, so a temporary install never costs the transcript.
        const cleaned = cleanupTemporary()
        if (cleaned?.removed) {
          result.note =
            '临时 ASR 运行时（venv 与模型）已在本视频转写后删除；需要重复使用时请选择 persistent 安装。'
        }
        return result
      } finally {
        try {
          rmSync(audioDir, { recursive: true, force: true })
        } catch {}
        cleanupTemporary()
      }
    },
  })
}

/**
 * Build the on-demand faster-whisper runtime tool.
 *
 * The ninth tool exists because the fallback must be a user decision: it
 * reports status without side effects, installs only when called with an
 * explicit mode, and removes a temporary runtime freely while requiring
 * `confirm: true` for the persistent one.
 *
 * @param defaults - resolved plugin configuration.
 * @returns the tool definition.
 */
function asrSetupTool(defaults) {
  return defineTool({
    name: 'bilibili_asr_setup',
    description:
      'Set up or report the optional faster-whisper fallback for videos Bcut cannot transcribe. The plugin ' +
      'ships no faster-whisper package, virtualenv or model. action "status" reports the persistent runtime ' +
      'under DSH home and the temporary runtime under out_dir/.asr-runtime without side effects. action ' +
      '"install" creates a venv and pip-installs faster-whisper for the chosen mode, but never downloads the ' +
      'model (the first local transcription does). action "remove" deletes a temporary runtime freely and a ' +
      'persistent one only with confirm: true. Always ask the user which mode they want first.',
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'install', 'remove'],
        description: 'status: report both runtimes. install: create the runtime. remove: delete it.',
      },
      mode: {
        type: 'string',
        enum: ['persistent', 'temporary'],
        description:
          'persistent (default): install once under DSH home and reuse. temporary: install under ' +
          'out_dir/.asr-runtime for this video, deleted after the analysis.',
      },
      out_dir: {
        type: 'string',
        description: 'Workspace-relative base for mode "temporary"; defaults to the configured bundle root.',
      },
      confirm: {
        type: 'boolean',
        description: 'Required as true to remove the persistent runtime (it deletes the venv and model cache).',
      },
    },
    required: ['action'],
    render: renderMarkdown,
    execute: async (args, exec) => {
      const action = optionalString(args, 'action') ?? 'status'
      const mode = optionalString(args, 'mode') ?? 'persistent'
      if (!['persistent', 'temporary'].includes(mode)) throw new Error(`unknown ASR runtime mode "${mode}"`)
      const model = defaults.asrModel ?? 'small'
      const estimate = estimatedModelMb(model)
      const outDir = await resolveOutDir({ args, exec, defaults })
      const persistent = runtimeStatus({ mode: 'persistent', defaults })
      const temporary = runtimeStatus({ mode: 'temporary', outDir, defaults })
      const options = asrInstallOptions(model).map((option) => ({
        ...option,
        installed: option.mode === 'persistent' ? persistent.installed : temporary.installed,
      }))
      const installHint =
        `安装前必须先询问用户选择 persistent 还是 temporary，然后调用 ` +
        `bilibili_asr_setup({ action: "install", mode: "persistent" | "temporary" })。`

      if (action === 'status') {
        // A configured asrPython is what findExistingRuntime uses; probe it so
        // status never tells the model to install a runtime it already has.
        const configuredPython = persistent.configuredPython
        const configuredInstalled = configuredPython
          ? await hasFasterWhisper(configuredPython, { signal: exec.signal })
          : false
        const ready = persistent.installed || temporary.installed || configuredInstalled
        const line = (runtime) =>
          `- ${runtime.mode === 'persistent' ? '长期运行时（$DSH_HOME/bilibili-asr）' : `临时运行时（${runtime.baseDir}）`}：` +
          `${runtime.installed ? '已安装' : '未安装'}` +
          `${runtime.installed ? `；python：${runtime.python}；模型缓存：${runtime.modelCached ? '有' : '无'}；占用约 ${runtime.size_mb} MB` : ''}`
        const configuredLine = configuredPython
          ? `- 已配置解释器（asrPython / BILIBILI_ASR_PYTHON / PYTHON）：${configuredPython}（${configuredInstalled ? '可用' : '未安装 faster-whisper'}）`
          : '- 已配置解释器（asrPython / BILIBILI_ASR_PYTHON / PYTHON）：未配置'
        const markdown = [
          '## faster-whisper 兜底运行时',
          '',
          '插件**不内置** faster-whisper、虚拟环境或模型；Bcut 仍是默认，只有 Bcut 失败或显式要求时才用本地转写。',
          '',
          line(persistent),
          line(temporary),
          configuredLine,
          `- 当前可用：${ready ? '已有可用的本地运行时，Bcut 失败时会自动复用' : '暂无；Bcut 失败时 bilibili_transcribe 会返回 needs_asr_runtime'}`,
          `- 模型 \`${model}\`：首次本地转写时下载，约 ${estimate} MB（不会在 install 时下载）。`,
          '',
          ...options.map((option, index) => `${index + 1}. **${option.label}**（mode: \`${option.mode}\`）— ${option.description}`),
          '',
          installHint,
        ].join('\n')
        return {
          action,
          model,
          estimated_model_mb: estimate,
          ready,
          configured: { python: configuredPython, installed: configuredInstalled },
          persistent,
          temporary,
          options,
          markdown,
          next: ready
            ? 'A local runtime is available; retry bilibili_transcribe (provider auto or faster-whisper).'
            : 'Ask the user which mode to use; do not install before they choose.',
        }
      }

      if (action === 'install') {
        const installed = await installRuntime({ mode, outDir, defaults, signal: exec.signal })
        const markdown = [
          `## faster-whisper 已安装（${mode === 'persistent' ? '长期' : '临时'}）`,
          '',
          `- python：${installed.python}`,
          `- venv：${installed.venvDir}`,
          `- 模型目录：${installed.modelDir}`,
          `- 模型：\`${model}\`（尚未下载，约 ${estimate} MB；首次本地转写时下载）`,
          '',
          mode === 'persistent'
            ? '长期安装会保留 venv 与模型，之后的视频直接复用。'
            : '临时安装只用于当前视频，转写完成后自动删除 venv 与模型。',
          `现在可以重试 bilibili_transcribe，provider 使用 auto 或 faster-whisper。`,
        ].join('\n')
        return {
          action,
          ...installed,
          estimated_model_mb: installed.estimatedModelMb ?? estimate,
          markdown,
        }
      }

      if (action === 'remove') {
        const removed = removeRuntime({
          mode,
          outDir,
          defaults,
          confirm: optionalBoolean(args, 'confirm', false),
        })
        const markdown = [
          `## faster-whisper 运行时已移除（${mode === 'persistent' ? '长期' : '临时'}）`,
          '',
          removed.removed.length > 0
            ? removed.removed.map((target) => `- 已删除：${target}`).join('\n')
            : '- 没有找到需要删除的运行时。',
          '',
          `- 剩余长期运行时：${removed.remaining.installed ? '已安装' : '未安装'}`,
        ].join('\n')
        return { action, ...removed, markdown }
      }

      throw new Error(`unknown bilibili_asr_setup action "${action}"`)
    },
  })
}

/**
 * Build the frame-capture tool.
 *
 * Explicit timestamps skip automatic selection and are normalized first; without
 * them the plan is picture-driven (scene peaks when a local decode is possible,
 * then even-interval backfill). Local capture reuses the bounded video cache,
 * and a downloaded video is removed unless `keep_video` asks to keep it.
 *
 * @param defaults - resolved plugin configuration.
 * @returns the tool definition.
 */
function framesTool(defaults) {
  return defineTool({
    name: 'bilibili_frames',
    description:
      'Capture JPEG frames from a Bilibili video at explicit moments (seconds, mm:ss or h:mm:ss) or at ' +
      'automatic scene-change/even-interval points. Downloads the video once when it is short enough and ' +
      'captures locally, otherwise seeks the remote stream per frame. Every frame carries its nearest ' +
      'subtitle line and an absolute image path to hand to read_image. Set vision to an Ollama, ' +
      'llama.cpp or OpenAI-compatible endpoint to add a factual description and a citation hint; ' +
      'vision defaults to none, and a failed vision call never discards the captured frames.',
    properties: {
      url: { type: 'string', description: 'Bilibili video URL, BV id, or av id.' },
      page: { type: 'integer', description: 'One-based part number for a multi-part video.' },
      timestamps: {
        type: 'array',
        items: { type: ['number', 'string'] },
        description:
          'Explicit moments as seconds or mm:ss / h:mm:ss. When present, automatic selection is skipped.',
      },
      max_frames: { type: 'integer', description: 'Most frames to return, 1-20. Defaults to 6.' },
      quality: {
        type: 'integer',
        description: 'Stream quality: 16=360p, 32=480p, 64=720p, 80=1080p. Defaults to the config (64).',
      },
      download_video: {
        type: 'boolean',
        description: 'Download once and capture locally, faster and repeatable. Defaults to true.',
      },
      keep_video: {
        type: 'boolean',
        description: 'Keep the downloaded video after capture. Defaults to false (24h cache otherwise).',
      },
      max_video_minutes: {
        type: 'integer',
        description: 'Videos longer than this use per-frame remote capture. Defaults to 60.',
      },
      max_download_mb: { type: 'integer', description: 'Download size cap in MB. Defaults to 1500.' },
      detect_scenes: {
        type: 'boolean',
        description: 'Use scene-change peaks for auto selection and alignment. Defaults to true.',
      },
      scene_threshold: { type: 'number', description: 'Scene-change sensitivity, 0-1. Defaults to 0.4.' },
      sharp_frames: {
        type: 'boolean',
        description: 'Pick the sharpest frame within 1.5 s via blurdetect. Defaults to true.',
      },
      scene_align_seconds: {
        type: 'number',
        description: 'Align a requested moment to a scene peak within this many seconds. Defaults to 4.',
      },
      vision: {
        type: 'string',
        enum: ['none', 'ollama', 'llama-cpp', 'openai-compatible'],
        description:
          'Optional frame-description provider. ollama and llama-cpp use their local defaults; ' +
          'openai-compatible needs vision_base_url. Defaults to none.',
      },
      vision_base_url: {
        type: 'string',
        description: 'OpenAI-compatible base URL, e.g. http://host:port/v1. Required for openai-compatible.',
      },
      vision_model: {
        type: 'string',
        description: 'low/small=qwen3-vl:2b, medium=qwen3-vl:4b, high/large=qwen3-vl:8b, or an explicit model name.',
      },
      vision_api_key: {
        type: 'string',
        description: 'Optional bearer token for the vision endpoint. It is never returned in the result.',
      },
      vision_prompt: { type: 'string', description: 'Override the bundled vision prompt.' },
      vision_max_frames: {
        type: 'integer',
        description: 'Most frames to describe per call, 1-20. Defaults to the config (6).',
      },
      out_dir: {
        type: 'string',
        description: 'Bundle root; defaults to bili-out. Relative paths resolve against the workspace.',
      },
    },
    required: ['url'],
    render: renderFrames,
    execute: async (args, exec) => {
      const credentials = loadCredentials(defaults)
      const cookie = cookieHeader(credentials.cookies)
      const rawUrl = optionalString(args, 'url')
      const bvid = await resolveBvid(rawUrl, { timeoutMs: defaults.timeoutMs, signal: exec.signal })
      const video = await fetchVideoInfo({ bvid, cookie, timeoutMs: defaults.timeoutMs, signal: exec.signal })
      const { entry, cid } = selectPage(video, optionalInteger(args, 'page', undefined, [1, 10_000]))
      const duration = Number(entry.duration || video.duration || 0)
      const quality = optionalInteger(args, 'quality', defaults.quality ?? 64, [1, 200])
      const maxFrames = optionalInteger(args, 'max_frames', defaults.maxFrames ?? 6, [1, 20])
      const maxVideoMinutes = optionalInteger(args, 'max_video_minutes', defaults.maxVideoMinutes ?? 60, [1, 100_000])
      const maxDownloadMb = optionalInteger(args, 'max_download_mb', defaults.maxDownloadMb ?? 1500, [1, 100_000])
      const downloadVideo = optionalBoolean(args, 'download_video', defaults.downloadVideo ?? true)
      const keepVideo = optionalBoolean(args, 'keep_video', defaults.keepVideo ?? false)
      const detectScenes = optionalBoolean(args, 'detect_scenes', defaults.detectScenes ?? true)
      const sceneThreshold = clampNumber(optionalNumber(args, 'scene_threshold', defaults.sceneThreshold ?? 0.4), 0, 1)
      const sharpFrames = optionalBoolean(args, 'sharp_frames', defaults.sharpFrames ?? true)
      const sceneAlignSeconds = clampNumber(
        optionalNumber(args, 'scene_align_seconds', defaults.sceneAlignSeconds ?? 4),
        0,
        30,
      )
      const frameTimeoutMs = defaults.frameTimeoutMs ?? 20_000
      // A full scene decode reads the whole file, so it needs a much larger
      // budget than a single-frame seek.
      const sceneTimeoutMs = Math.max(frameTimeoutMs, 180_000)
      const ffmpegPath = resolveFfmpeg(defaults.ffmpegPath)
      const outDir = await resolveOutDir({ args, exec, defaults })
      const bundleDir = bundleDirFor(outDir, video.bvid, entry.page)
      mkdirSync(bundleDir, { recursive: true })

      const notes = []
      // Frames are useful without captions: a missing bundle is a note, not a failure.
      const bundle = readTranscriptBundle({ outDir, bvid: video.bvid, page: entry.page })
      const segments = bundle?.transcript?.segments ?? []
      if (segments.length === 0) notes.push('no transcript bundle: frames carry no subtitle captions')

      // Validate explicit moments before any download: a typo should fail fast,
      // and a supplied list that yields no usable moment must not silently fall
      // back to unrelated automatic frames.
      const rawTimestamps = args?.timestamps
      const suppliedTimestamps = Array.isArray(rawTimestamps) && rawTimestamps.length > 0
      const requestedPlan = normalizeRequestedTimestamps(rawTimestamps, duration, maxFrames, segments)
      if (suppliedTimestamps && !requestedPlan) {
        throw new Error('none of the supplied timestamps is usable; pass seconds or mm:ss within the video duration')
      }

      const pageTag = partFileTag(video.pages?.length ?? 1, entry.page)
      let stream
      let streamError
      try {
        stream = await fetchVideoStream({
          bvid,
          aid: video.aid,
          cid,
          quality,
          cookie,
          timeoutMs: defaults.timeoutMs,
          signal: exec.signal,
        })
      } catch (error) {
        if (exec.signal?.aborted) throw error
        streamError = error
      }

      const withinCap = duration > 0 && duration <= maxVideoMinutes * 60
      let mode = 'remote'
      let localPath
      if (downloadVideo && withinCap) {
        try {
          const downloaded = await ensureVideo({
            outDir: bundleDir,
            url: stream?.url,
            pageTag,
            maxBytes: maxDownloadMb * 1024 * 1024,
            ttlMs: (defaults.videoCacheHours ?? 24) * 3600 * 1000,
            referer: `${video.url}/`,
            cookie,
            signal: exec.signal,
          })
          localPath = downloaded.path
          mode = 'local'
        } catch (error) {
          if (exec.signal?.aborted) throw error
          if (!stream?.url) throw streamError ?? error
          notes.push(`video download failed (${String(error?.message ?? error).slice(0, 160)}); capturing remotely`)
        }
      }
      if (mode !== 'local' && !stream?.url) {
        if (streamError) throw streamError
        throw new Error('no playable video stream is available for frame capture')
      }
      if (mode === 'remote') {
        if (!downloadVideo) notes.push('video download disabled; capturing from the remote stream')
        else if (!withinCap) notes.push(`video longer than max_video_minutes (${maxVideoMinutes} min); capturing remotely`)
      }

      /** Run a best-effort refinement pass; cancellation still propagates. */
      const bestEffort = (label, task) =>
        runBestEffort({ label, task, notes, signal: exec.signal, attempts: 2 })

      let plan
      let strategy
      let scenePeaks = []
      if (requestedPlan) {
        plan = requestedPlan
        strategy = 'requested timestamps'
      } else {
        plan = selectKeyframeTimestamps(segments, duration, maxFrames, [])
        if (mode === 'local' && detectScenes && plan.length < maxFrames) {
          const peaks = await bestEffort('scene detection', () =>
            detectScenePeaks({
              videoPath: localPath,
              outDir: bundleDir,
              threshold: sceneThreshold,
              duration,
              ffmpegPath,
              timeoutMs: sceneTimeoutMs,
              signal: exec.signal,
            }),
          )
          if (peaks?.length) {
            scenePeaks = peaks
            plan = selectKeyframeTimestamps(segments, duration, maxFrames, scenePeaks)
          }
        }
        strategy = scenePeaks.length > 0 ? 'scene-change peaks + even backfill' : 'even-interval backfill'
      }

      // Refinement needs a local decode: align requested moments to a nearby
      // scene peak, then move each frame to the sharpest moment in its window.
      if (mode === 'local' && plan.length > 0) {
        if (requestedPlan && detectScenes && sceneAlignSeconds > 0) {
          const aligned = []
          for (const item of plan) {
            const peak = await bestEffort('scene alignment', () =>
              detectScenePeaksInWindow({
                videoPath: localPath,
                centerTime: item.time,
                halfWindow: sceneAlignSeconds,
                outDir: bundleDir,
                ffmpegPath,
                timeoutMs: frameTimeoutMs,
                signal: exec.signal,
              }),
            )
            if (peak && Math.abs(peak.time - item.time) <= sceneAlignSeconds) {
              aligned.push({ ...item, time: roundTime(peak.time), reason: `${item.reason} (scene-aligned)` })
            } else {
              aligned.push(item)
            }
          }
          plan = aligned
        }
        if (sharpFrames) {
          const sharpPlan = []
          for (const item of plan) {
            const sharpTime = await bestEffort('sharp-frame refinement', () =>
              findSharpestTime({
                videoPath: localPath,
                centerTime: item.time,
                halfWindow: 1.5,
                outDir: bundleDir,
                ffmpegPath,
                timeoutMs: frameTimeoutMs,
                signal: exec.signal,
              }),
            )
            if (sharpTime !== null && Math.abs(sharpTime - item.time) <= 1.5) {
              const moved = Math.abs(sharpTime - item.time) >= 0.1
              sharpPlan.push({
                ...item,
                time: roundTime(sharpTime),
                reason: moved ? `${item.reason} (sharpest)` : item.reason,
              })
            } else {
              sharpPlan.push(item)
            }
          }
          plan = sharpPlan
        }
      }

      // Refinement can move two requested moments onto the same cut. If any two
      // refined times collide, put the whole colliding plan back on the original
      // requests (they were deduped to more than one second apart); automatic
      // plans just drop the later duplicate with a note.
      const anyCollision = plan.some((item, index) =>
        plan.some((other, otherIndex) => otherIndex !== index && Math.abs(other.time - item.time) < 0.5),
      )
      let distinctPlan = plan
      if (anyCollision && requestedPlan) {
        distinctPlan = plan.map((item) => {
          const collision = plan.some((other) => other !== item && Math.abs(other.time - item.time) < 0.5)
          return collision
            ? { ...item, time: roundTime(item.requested_time), reason: `${item.reason} (kept requested moment)` }
            : item
        })
        notes.push('refinement collided; kept the requested moments')
      }
      const keptPlan = []
      for (const item of distinctPlan) {
        if (keptPlan.some((other) => Math.abs(other.time - item.time) < 0.5)) {
          notes.push(`dropped a duplicate refined frame at ${formatClock(item.time)}`)
          continue
        }
        keptPlan.push(item)
      }
      plan = keptPlan

      // Captions follow the final frame time, for automatic plans too.
      plan = plan.map((item) => ({ ...item, text: nearestSubtitleText(item.time, segments) }))

      const captured = await captureFrames({
        videoPath: mode === 'local' ? localPath : undefined,
        streamUrl: stream?.url,
        referer: `${video.url}/`,
        timestamps: plan,
        outDir: bundleDir,
        pageTag,
        ffmpegPath,
        timeoutMs: frameTimeoutMs,
        signal: exec.signal,
      })

      const frames = captured.map((frame) => ({
        time: frame.time,
        requested_time: frame.requested_time ?? null,
        reason: frame.reason ?? 'candidate',
        subtitle_text: frame.text ?? '',
        has_image: Boolean(frame.path),
        path: frame.path ?? null,
        error: frame.error ?? null,
      }))

      // Vision is optional and independent of capture. `none` keeps the Phase 2
      // result shape untouched; an enabled provider annotates image frames, and
      // a whole-call failure (for example a missing base URL) becomes a note
      // plus a per-frame vision_error instead of a lost capture result.
      const visionProvider = (
        optionalText(args, 'vision') ?? String(defaults.visionProvider ?? 'none')
      )
        .trim()
        .toLowerCase()
      if (visionProvider && visionProvider !== 'none') {
        const imageFrames = frames.filter((frame) => frame.has_image && frame.path)
        if (imageFrames.length > 0) {
          // Schemastery accepts 0 for a natural field, but a 0-frame cap would
          // post images and discard the answers; clamp the config fallback too.
          const configuredMax = Number(defaults.visionMaxFrames ?? 6)
          const fallbackMax = Math.min(Math.max(Number.isFinite(configuredMax) ? configuredMax : 6, 1), 20)
          const visionOptions = {
            provider: visionProvider,
            baseUrl: optionalText(args, 'vision_base_url') ?? defaults.visionBaseUrl ?? '',
            model: optionalText(args, 'vision_model') ?? defaults.visionModel ?? 'medium',
            apiKey: optionalText(args, 'vision_api_key') ?? defaults.visionApiKey ?? '',
            prompt: optionalText(args, 'vision_prompt') ?? defaults.visionPrompt ?? '',
            promptByModel: defaults.visionPromptByModel ?? {},
            maxFrames: optionalInteger(args, 'vision_max_frames', fallbackMax, [1, 20]),
            timeoutMs: defaults.visionTimeoutMs ?? 120000,
          }
          try {
            const described = await describeFramesWithVision(frames, visionOptions, exec.signal)
            // describeFramesWithVision returns entries in the same order as the
            // image frames it selected, so merge by the returned length; this
            // stays correct even if a future cap path differs from the request.
            const targets = imageFrames.slice(0, described.length)
            described.forEach((entry, index) => {
              const frame = targets[index]
              if (!frame) return
              frame.description = entry.description
              frame.vision_error = entry.vision_error
              frame.citation_hint = entry.citation_hint
            })
          } catch (error) {
            if (exec.signal?.aborted) throw error
            const reason = String(error?.message ?? error).slice(-200)
            for (const frame of imageFrames) {
              frame.description = ''
              frame.vision_error = reason
              frame.citation_hint = ''
            }
            notes.push(`vision descriptions failed: ${reason}`)
          }
        }
      }

      if (mode === 'local' && !keepVideo) {
        rmSync(localPath, { force: true })
        notes.push('local video removed (keep_video:false)')
      }

      const summaryVideo = {
        bvid: video.bvid,
        title: video.title,
        owner: video.owner,
        duration: video.duration,
        url: video.url,
      }
      const summaryPage = {
        page: entry.page,
        cid,
        part: entry.part,
        duration: entry.duration ?? duration,
      }
      const note = notes.join(' | ')
      return {
        video: summaryVideo,
        page: summaryPage,
        mode,
        strategy,
        note,
        frames,
        text: renderFramesMarkdown({
          video: summaryVideo,
          page: summaryPage,
          mode,
          strategy,
          note,
          frames,
        }),
      }
    },
  })
}

/**
 * Drop `undefined` members so the result survives the registry's lossless JSON check.
 * @param value - tool result.
 * @returns the same shape without undefined entries.
 */
function toLossless(value) {
  if (Array.isArray(value)) return value.map(toLossless)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) out[key] = toLossless(entry)
    }
    return out
  }
  return value
}

/**
 * Build the listing tool used to plan batch work.
 *
 * @param defaults - resolved plugin configuration.
 * @returns the tool definition.
 */
function seriesTool(defaults) {
  return defineTool({
    name: 'bilibili_series',
    description:
      'List the videos that belong together on Bilibili: one UP\'s recent uploads, their collections ' +
      '(合集/系列), or the videos inside one collection. Use it to plan batch work — summarize several videos ' +
      'in a row — when the user asks about a channel, a series, or "all of these".',
    properties: {
      url: {
        type: 'string',
        description: 'A space URL (space.bilibili.com/<mid>), any video URL (its UP is used), or a bare mid.',
      },
      kind: {
        type: 'string',
        enum: ['uploads', 'collections', 'videos'],
        description: 'uploads: recent videos of the UP. collections: their 合集/系列 directory. videos: members of one collection.',
      },
      collection_id: { type: 'string', description: 'Collection id, required for kind "videos".' },
      collection_kind: {
        type: 'string',
        enum: ['season', 'series'],
        description: 'Which directory the collection id came from. Defaults to season (合集).',
      },
      limit: { type: 'integer', description: 'Maximum entries to return. Defaults to 30.' },
    },
    required: ['url'],
    render: renderStatus,
    execute: async (args, exec) => {
      const credentials = loadCredentials(defaults)
      const cookie = cookieHeader(credentials.cookies)
      const kind = optionalString(args, 'kind') ?? 'uploads'
      const limit = optionalInteger(args, 'limit', 30, [1, 50])
      const raw = optionalString(args, 'url')
      const spaceMatch = /space\.bilibili\.com\/(\d+)/.exec(raw)
      let mid = spaceMatch?.[1]
      if (!mid && /^\d+$/.test(raw.trim())) mid = raw.trim()
      if (!mid) {
        const bvid = await resolveBvid(raw, { timeoutMs: defaults.timeoutMs, signal: exec.signal })
        const video = await fetchVideoInfo({ bvid, cookie, timeoutMs: defaults.timeoutMs, signal: exec.signal })
        mid = String(video.owner?.mid ?? '')
      }
      if (!mid) throw new Error(`could not determine the UP mid from "${raw}"`)
      const common = { mid, cookie, limit, timeoutMs: defaults.timeoutMs, signal: exec.signal }
      if (kind === 'uploads') {
        const listed = await fetchUserVideos(common)
        const markdown = [`# UP ${mid} 的最近投稿（共 ${listed.total} 条）`, '', ...listed.videos.map((video, index) => `${index + 1}. [${video.title}](${video.url}) · ${formatDuration(video.duration)}`)].join('\n')
        return { kind, mid, total: listed.total, videos: listed.videos, markdown }
      }
      if (kind === 'collections') {
        const listed = await fetchUserCollections(common)
        const markdown = [`# UP ${mid} 的合集/系列`, '', ...listed.collections.map((item) => `- [${item.kind}] ${item.title} · ${item.count} 个视频 · id=${item.id}`)].join('\n')
        return { kind, mid, collections: listed.collections, markdown }
      }
      const id = optionalString(args, 'collection_id')
      if (!id) throw new Error('collection_id is required when kind is "videos"')
      const listed = await fetchCollectionVideos({
        ...common,
        id,
        kind: optionalString(args, 'collection_kind') ?? 'season',
      })
      const markdown = [`# 合集 ${id} 的视频`, '', ...listed.videos.map((video, index) => `${index + 1}. [${video.title}](${video.url}) · ${formatDuration(video.duration)}`)].join('\n')
      return { kind, mid, collectionId: id, videos: listed.videos, markdown }
    },
  })
}

/**
 * Build every tool this plugin registers.
 * @param options - harness path resolution and resolved configuration.
 * @returns registry-ready tool declarations.
 */
export function createBilibiliTools(options) {
  const defaults = options.defaults ?? {}
  const tools = [
    loginTool(defaults),
    infoTool(defaults),
    subtitlesTool(defaults),
    transcriptPartTool(defaults),
    transcriptSearchTool(defaults),
    transcribeTool(defaults),
    asrSetupTool(defaults),
    framesTool(defaults),
    seriesTool(defaults),
  ]
  return tools.map((tool) => ({
    ...tool,
    execute: async (args, exec) =>
      toLossless(await tool.execute(args, { ...exec, resolvePath: (target) => options.resolvePath(target, exec) })),
  }))
}

/**
 * Default output path for a transcript.
 * @param bvid - video id.
 * @param format - transcript format.
 * @returns a workspace-relative path.
 */
export function defaultTranscriptPath(bvid, format = 'markdown') {
  return join('bilibili', bvid, `transcript${extensionFor(format)}`)
}
