/**
 * Transcript shaping: subtitles in, readable notes out.
 *
 * Bilibili AI subtitles arrive as short, punctuation-free lines, so the raw
 * segment list is a poor summary input and an even worse HTML timeline. The
 * helpers here merge segments into blocks, attach player timestamps, and emit
 * Markdown, plain text, or SRT.
 *
 * @module dsh-bilibili-summary/transcript
 */

/** Format seconds as `mm:ss`, or `h:mm:ss` past an hour. */
export function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  const pad = (value) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`
}

/** Format seconds as a short human duration, for example `14 分 34 秒`. */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  if (minutes === 0) return `${rest} 秒`
  return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`
}

/**
 * Deep link to a moment in the video player.
 * @param bvid - video id.
 * @param seconds - start time in seconds.
 * @param page - one-based part number, omitted for single-part videos.
 * @returns the player URL.
 */
export function momentUrl(bvid, seconds, page) {
  const suffix = page && page > 1 ? `&p=${page}` : ''
  return `https://www.bilibili.com/video/${bvid}?t=${Math.max(0, Math.floor(Number(seconds) || 0))}${suffix}`
}

/**
 * Merge short subtitle lines into readable blocks.
 * @param segments - normalized `{ from, to, text }` segments.
 * @param options - target block duration and character budget.
 * @returns one entry per block, each with its own bounds and joined text.
 */
export function groupSegments(segments, options = {}) {
  const targetSeconds = options.targetSeconds ?? 35
  const maxChars = options.maxChars ?? 220
  const blocks = []
  let current
  for (const segment of segments ?? []) {
    if (!current) {
      current = { from: segment.from, to: segment.to, parts: [segment.text] }
      continue
    }
    const projectedChars = current.parts.join('').length + segment.text.length
    const projectedSeconds = segment.to - current.from
    if (projectedSeconds > targetSeconds || projectedChars > maxChars) {
      blocks.push(current)
      current = { from: segment.from, to: segment.to, parts: [segment.text] }
    } else {
      current.to = segment.to
      current.parts.push(segment.text)
    }
  }
  if (current) blocks.push(current)
  return blocks.map((block) => ({
    from: Number(block.from.toFixed(2)),
    to: Number(block.to.toFixed(2)),
    text: block.parts.join(''),
  }))
}

/**
 * Join segments into continuously readable prose.
 * @param segments - normalized segments.
 * @returns the transcript without timestamps.
 */
export function toPlainText(segments) {
  return (segments ?? []).map((segment) => segment.text).join('')
}

/**
 * Render a standard SRT file.
 * @param segments - normalized segments.
 * @returns SRT text.
 */
export function toSrt(segments) {
  const stamp = (seconds) => {
    const ms = Math.max(0, Math.round((Number(seconds) || 0) * 1000))
    const hours = String(Math.floor(ms / 3_600_000)).padStart(2, '0')
    const minutes = String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0')
    const secs = String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')
    return `${hours}:${minutes}:${secs},${String(ms % 1000).padStart(3, '0')}`
  }
  return (segments ?? [])
    .map((segment, index) => `${index + 1}\n${stamp(segment.from)} --> ${stamp(segment.to)}\n${segment.text}\n`)
    .join('\n')
}

/**
 * Render an LRC file (one cue per segment).
 * @param segments - normalized segments.
 * @returns LRC text.
 */
export function toLrc(segments) {
  return (segments ?? [])
    .map((segment) => {
      const total = Math.max(0, Number(segment.from) || 0)
      const minutes = String(Math.floor(total / 60)).padStart(2, '0')
      const seconds = String(Math.floor(total % 60)).padStart(2, '0')
      const hundredths = String(Math.round((total % 1) * 100)).padStart(2, '0')
      return `[${minutes}:${seconds}.${hundredths}]${segment.text}`
    })
    .join('\n')
}

/**
 * Render a minimal ASS subtitle file.
 * @param segments - normalized segments.
 * @param options - optional style overrides.
 * @returns ASS text.
 */
export function toAss(segments, options = {}) {
  const font = options.font ?? 'Microsoft YaHei'
  const fontSize = options.fontSize ?? 48
  const stamp = (seconds) => {
    const cs = Math.max(0, Math.round((Number(seconds) || 0) * 100))
    const hours = Math.floor(cs / 360_000)
    const minutes = String(Math.floor((cs % 360_000) / 6000)).padStart(2, '0')
    const secs = String(Math.floor((cs % 6000) / 100)).padStart(2, '0')
    return `${hours}:${minutes}:${secs}.${String(cs % 100).padStart(2, '0')}`
  }
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'PlayResX: 1920',
    'PlayResY: 1080',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${font},${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,1,2,40,40,60,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n')
  const events = (segments ?? [])
    .map((segment) => `Dialogue: 0,${stamp(segment.from)},${stamp(segment.to)},Default,,0,0,0,,${String(segment.text).replace(/\n/g, '\\N')}`)
    .join('\n')
  return `${header}\n${events}\n`
}

/**
 * Merge a second track into the first, aligning by greatest time overlap.
 *
 * Mirrors what bilingual subtitle tools do: the primary language keeps its own
 * segmentation and each line gains the secondary text underneath it.
 *
 * @param primary - segments of the main language.
 * @param secondary - segments of the second language.
 * @returns primary segments with both languages in `text` and `secondary`.
 */
export function mergeBilingual(primary, secondary) {
  const other = [...(secondary ?? [])].sort((left, right) => left.from - right.from)
  const merged = []
  let cursor = 0
  for (const segment of primary ?? []) {
    while (cursor < other.length && other[cursor].to <= segment.from) cursor += 1
    const candidates = []
    for (let index = cursor; index < other.length && other[index].from < segment.to; index++) {
      const overlap = Math.min(segment.to, other[index].to) - Math.max(segment.from, other[index].from)
      if (overlap > 0) candidates.push({ overlap, text: other[index].text })
    }
    candidates.sort((left, right) => right.overlap - left.overlap)
    const secondaryText = candidates[0]?.text ?? ''
    merged.push({
      from: segment.from,
      to: segment.to,
      text: secondaryText ? `${segment.text}\n${secondaryText}` : segment.text,
      secondary: secondaryText || undefined,
    })
  }
  return merged
}

/**
 * Build the Markdown the model reads and the user keeps.
 * @param context - video, page, chosen track, segments, and coverage stats.
 * @returns a Markdown document with a timestamped script.
 */
export function buildTranscriptMarkdown(context) {
  const { video, track, segments, stats, page } = context
  const blocks = groupSegments(segments)
  const pageNote = page && page > 1 ? `（第 ${page} 集）` : ''
  const trackNote = track ? `${track.lan} · ${track.lan_doc ?? ''}`.trim() : '未知'
  const lines = [
    `# ${video.title}${pageNote}`,
    '',
    `- 视频：${video.url}${page && page > 1 ? `?p=${page}` : ''}`,
    `- UP 主：${video.owner?.name ?? '未知'}`,
    `- 时长：${formatDuration(video.duration)}（${video.duration}s）`,
    `- 字幕轨道：${trackNote}`,
    `- 字幕规模：${stats.count} 段 → ${blocks.length} 个语义块，覆盖 ${formatClock(stats.coveredSeconds)} / ${formatClock(video.duration)}（${Math.round(stats.coverage * 100)}%）`,
    '',
    '## 时间轴文稿',
    '',
  ]
  for (const block of blocks) {
    lines.push(`- [${formatClock(block.from)}](${momentUrl(video.bvid, block.from, page)}) ${block.text}`)
  }
  return { markdown: lines.join('\n'), blocks }
}

/**
 * Pick the file extension for a requested transcript format.
 * @param format - one of `markdown`, `text`, `srt`, `json`.
 * @returns the extension including the dot.
 */
export function extensionFor(format) {
  switch (format) {
    case 'json':
      return '.json'
    case 'srt':
      return '.srt'
    case 'ass':
      return '.ass'
    case 'lrc':
      return '.lrc'
    case 'text':
      return '.txt'
    default:
      return '.md'
  }
}

/**
 * Round a time to two decimals, the resolution used throughout the manifest.
 * @param value - raw seconds.
 * @returns the rounded number.
 */
function roundSeconds(value) {
  return Number((Number(value) || 0).toFixed(2))
}

/**
 * Normalize a page argument that may be an entry object or a bare number.
 * @param value - page entry, page number, or nothing.
 * @returns a one-based page number.
 */
function pageNumber(value) {
  if (value && typeof value === 'object') return Number(value.page) || 1
  return Number(value) || 1
}

/**
 * Split one oversized segment's text into maxChars slices, keeping its bounds.
 * @param segment - normalized segment.
 * @param maxChars - largest slice allowed.
 * @returns one or more non-empty segment-like records.
 */
function splitSegment(segment, maxChars) {
  const text = String(segment?.text ?? '')
  if (text.length <= maxChars) return [{ from: segment.from, to: segment.to, text }]
  const pieces = []
  for (let offset = 0; offset < text.length; offset += maxChars) {
    pieces.push({ from: segment.from, to: segment.to, text: text.slice(offset, offset + maxChars) })
  }
  return pieces
}

/**
 * Map each grouped block back to the contiguous segment range it covers.
 *
 * `groupSegments` preserves order and concatenates text verbatim, so walking a
 * single cursor over the character count recovers the ranges without an
 * O(n²) filter per block.
 *
 * @param segments - normalized segments.
 * @param blocks - output of {@link groupSegments}.
 * @returns `[start, end)` index pairs.
 */
function blockRanges(segments, blocks) {
  const ranges = []
  let cursor = 0
  for (const block of blocks) {
    const start = cursor
    let chars = 0
    while (cursor < segments.length && chars < block.text.length) {
      chars += String(segments[cursor]?.text ?? '').length
      cursor += 1
    }
    ranges.push([start, cursor])
  }
  return ranges
}

/**
 * Report the silent stretches between adjacent subtitle segments.
 *
 * A gap is a candidate signal that the subtitle track is incomplete, not proof
 * that the video shows something at that moment.
 *
 * @param segments - normalized segments.
 * @param options - minimum gap and maximum number of entries.
 * @returns `{ from, to, seconds }` gaps in time order.
 */
export function transcriptGaps(segments, options = {}) {
  const minGapSeconds = options.minGapSeconds ?? 10
  const maxGaps = options.maxGaps ?? 50
  const gaps = []
  const list = segments ?? []
  for (let index = 1; index < list.length; index++) {
    const gap = Number(list[index].from) - Number(list[index - 1].to)
    if (!Number.isFinite(gap) || gap < 0 || gap < minGapSeconds) continue
    gaps.push({
      from: roundSeconds(list[index - 1].to),
      to: roundSeconds(list[index].from),
      seconds: roundSeconds(gap),
    })
    if (gaps.length >= maxGaps) break
  }
  return gaps
}

/**
 * Build a sparse time index: the first segment of each chunk.
 * @param segments - normalized segments.
 * @param options - chunk size in seconds and entry cap.
 * @returns `{ time, text }` entries at roughly chunkSeconds intervals.
 */
export function buildIndex(segments, options = {}) {
  const chunkSeconds = Number(options.chunkSeconds) > 0 ? Number(options.chunkSeconds) : 300
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 120))
  const buckets = new Set()
  const index = []
  for (const segment of segments ?? []) {
    const from = Number(segment.from)
    if (!Number.isFinite(from)) continue
    const bucket = Math.floor(from / chunkSeconds)
    if (buckets.has(bucket)) continue
    buckets.add(bucket)
    index.push({ time: roundSeconds(from), text: String(segment.text ?? '').slice(0, 80) })
    if (index.length >= maxEntries) break
  }
  return index
}

/**
 * Pack a transcript into lossless, bounded parts.
 *
 * Short lines are merged with {@link groupSegments} first, then blocks are
 * packed in order. A block larger than `maxChars` is split at segment
 * boundaries; a single segment larger than `maxChars` is split inside its text.
 * Concatenating every part's `segments[].text` reproduces the original text
 * exactly.
 *
 * @param segments - normalized segments.
 * @param options - `maxChars` (default 6000) and `maxSeconds` (default 600).
 * @returns `{ part, from, to, chars, blocks, segments }` parts numbered from 1.
 */
export function packParts(segments, options = {}) {
  const source = Array.isArray(segments) ? segments : []
  if (source.length === 0) return []
  const maxChars = Math.max(1, Math.floor(Number(options.maxChars) || 6000))
  const maxSeconds = Number(options.maxSeconds) > 0 ? Number(options.maxSeconds) : 600
  const blocks = groupSegments(source, { targetSeconds: 35, maxChars: 220 })
  const ranges = blockRanges(source, blocks)
  const units = []
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]
    const [start, end] = ranges[index]
    const blockSegments = source.slice(start, end)
    if (block.text.length <= maxChars) {
      if (block.text.length > 0) {
        units.push({ from: roundSeconds(block.from), to: roundSeconds(block.to), text: block.text, segments: blockSegments })
      }
      continue
    }
    let current
    const flush = () => {
      if (!current) return
      units.push(current)
      current = undefined
    }
    for (const segment of blockSegments) {
      for (const piece of splitSegment(segment, maxChars)) {
        if (piece.text.length === 0) continue
        if (current && current.text.length + piece.text.length > maxChars) flush()
        if (!current) current = { from: roundSeconds(piece.from), to: roundSeconds(piece.to), text: '', segments: [] }
        current.to = roundSeconds(piece.to)
        current.text += piece.text
        current.segments.push(piece)
      }
    }
    flush()
  }

  const parts = []
  let current
  const flush = () => {
    if (!current) return
    const chars = current.segments.reduce((sum, segment) => sum + String(segment.text ?? '').length, 0)
    parts.push({
      part: parts.length + 1,
      from: current.from,
      to: current.to,
      chars,
      blocks: current.blocks,
      segments: current.segments,
    })
    current = undefined
  }
  for (const unit of units) {
    if (unit.text.length === 0) continue
    const projectedChars = (current?.chars ?? 0) + unit.text.length
    const projectedSeconds = current ? unit.to - current.from : 0
    if (current && (projectedChars > maxChars || projectedSeconds > maxSeconds)) flush()
    if (!current) current = { from: unit.from, to: unit.to, chars: 0, blocks: [], segments: [] }
    current.to = unit.to
    current.chars += unit.text.length
    current.blocks.push({ from: unit.from, to: unit.to, text: unit.text })
    current.segments.push(...unit.segments)
  }
  flush()
  return parts
}

/**
 * Render one part as Markdown with clickable timestamps.
 * @param context - video, page, part, totalParts, and track.
 * @returns the part body.
 */
export function buildPartMarkdown(context) {
  const { video, part, totalParts, track } = context
  const page = pageNumber(context.page)
  const lines = [
    `## 第 ${part.part}/${totalParts} 段 · ${formatClock(part.from)}–${formatClock(part.to)}（${part.chars} 字）`,
    '',
    `- 视频：[${video?.title ?? 'B站视频'}](${momentUrl(video?.bvid, part.from, page)})`,
  ]
  if (track?.lan) lines.push(`- 字幕轨道：${track.lan}${track.lan_doc ? ` · ${track.lan_doc}` : ''}`)
  lines.push('')
  for (const block of part.blocks ?? []) {
    lines.push(`- [${formatClock(block.from)}](${momentUrl(video?.bvid, block.from, page)}) ${block.text}`)
  }
  return lines.join('\n')
}

/**
 * Encode a `{page, part}` pair as the opaque cursor used by the tools.
 *
 * The optional `maxChars` suffix makes the cursor packing-aware: a part number
 * only means something relative to the packing it was produced with. A plain
 * `${page}-${part}` cursor is still canonical (bundle packing).
 *
 * @param page - one-based page number.
 * @param part - one-based part number.
 * @param maxChars - packing that produced `part`, when it is not the bundle packing.
 * @returns `${page}-${part}` or `${page}-${part}@${maxChars}`.
 */
export function cursorFor(page, part, maxChars) {
  const pageValue = Number(page)
  const partValue = Number(part)
  if (!Number.isInteger(pageValue) || pageValue < 1 || !Number.isInteger(partValue) || partValue < 1) {
    throw new Error(`cursorFor expects positive integers, got page=${page} part=${part}`)
  }
  const base = `${pageValue}-${partValue}`
  if (maxChars === undefined || maxChars === null) return base
  const maxCharsValue = Number(maxChars)
  if (!Number.isInteger(maxCharsValue) || maxCharsValue < 1) {
    throw new Error(`cursorFor expects a positive maxChars, got ${maxChars}`)
  }
  return `${base}@${maxCharsValue}`
}

/**
 * Decode a cursor produced by {@link cursorFor}.
 * @param cursor - `${page}-${part}` or `${page}-${part}@${maxChars}`.
 * @returns `{ page, part }` plus `maxChars` when the cursor carries a packing.
 */
export function parseCursor(cursor) {
  const match = /^(\d+)-(\d+)(?:@(\d+))?$/.exec(String(cursor ?? ''))
  if (!match) throw new Error(`invalid cursor "${cursor}"; expected "<page>-<part>" or "<page>-<part>@<maxChars>"`)
  const page = Number(match[1])
  const part = Number(match[2])
  if (page < 1 || part < 1) throw new Error(`invalid cursor "${cursor}"; page and part must be positive`)
  const parsed = { page, part }
  if (match[3] !== undefined) {
    const maxChars = Number(match[3])
    if (maxChars < 1) throw new Error(`invalid cursor "${cursor}"; maxChars must be positive`)
    parsed.maxChars = maxChars
  }
  return parsed
}

/**
 * Find the part that contains a moment.
 * @param parts - packed parts.
 * @param time - seconds.
 * @returns the matching part, or undefined.
 */
export function partForTime(parts, time) {
  const value = Number(time)
  if (!Number.isFinite(value)) return undefined
  const list = parts ?? []
  for (let index = 0; index < list.length; index++) {
    const part = list[index]
    const last = index === list.length - 1
    if (value >= part.from && (last ? value <= part.to : value < part.to)) return part
  }
  return undefined
}

/**
 * Plain substring search over normalized segments (never a regular expression).
 * @param segments - normalized segments.
 * @param query - literal text to find.
 * @param options - caseSensitive, contextChars (0-500), maxMatches (1-100).
 * @returns `{ matches, totalMatches, truncated }`.
 */
export function searchSegments(segments, query, options = {}) {
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new Error('query must be a non-empty string')
  }
  const caseSensitive = options.caseSensitive === true
  const contextChars = Math.min(500, Math.max(0, Math.floor(options.contextChars ?? 80)))
  const maxMatches = Math.min(100, Math.max(1, Math.floor(options.maxMatches ?? 20)))
  const needle = caseSensitive ? query : query.toLowerCase()
  const matches = []
  let totalMatches = 0
  for (const segment of segments ?? []) {
    const text = String(segment?.text ?? '')
    const haystack = caseSensitive ? text : text.toLowerCase()
    let index = haystack.indexOf(needle)
    while (index !== -1) {
      totalMatches += 1
      if (matches.length < maxMatches) {
        matches.push({
          time: roundSeconds(segment.from),
          text: text.length > 240 ? text.slice(0, 240) : text,
          before: text.slice(Math.max(0, index - contextChars), index),
          after: text.slice(index + needle.length, index + needle.length + contextChars),
        })
      }
      index = haystack.indexOf(needle, index + Math.max(1, needle.length))
    }
  }
  return { matches, totalMatches, truncated: totalMatches > matches.length }
}

/**
 * Build the manifest object that is written to `parts/index.json`.
 * @param context - video, page, track, validation, full parts, time index, gaps, files and packing.
 * @returns the lossless manifest.
 */
export function buildTranscriptManifest(context) {
  const segments = context.segments ?? []
  const parts = context.parts ?? []
  const chars = segments.length
    ? segments.reduce((sum, segment) => sum + String(segment.text ?? '').length, 0)
    : parts.reduce((sum, part) => sum + (part.chars ?? 0), 0)
  const segmentCount = segments.length
    ? segments.length
    : parts.reduce((sum, part) => sum + (part.segments?.length ?? 0), 0)
  const last = segments.length > 0 ? segments[segments.length - 1] : parts[parts.length - 1]
  const coveredSeconds = last ? roundSeconds(last.to) : 0
  const duration = Number(context.video?.duration) > 0 ? Number(context.video.duration) : 0
  return {
    video: context.video,
    page: context.page,
    track: context.track ?? null,
    validation: context.validation ?? null,
    source: context.source ?? 'subtitle',
    stats: {
      chars,
      segments: segmentCount,
      parts: parts.length,
      gaps: (context.gaps ?? []).length,
      coveredSeconds,
      coverage: duration > 0 ? Number((coveredSeconds / duration).toFixed(3)) : 0,
    },
    parts: parts.map((part) => ({
      part: part.part,
      from: part.from,
      to: part.to,
      chars: part.chars,
      preview: String(part.blocks?.[0]?.text ?? part.segments?.[0]?.text ?? '').slice(0, 60),
      file: part.file ?? '',
    })),
    index: context.index ?? [],
    gaps: context.gaps ?? [],
    files: context.files ?? {},
    packing: {
      maxChars: context.packing?.maxChars ?? 6000,
      maxSeconds: context.packing?.maxSeconds ?? 600,
    },
  }
}

/** Shorten an absolute path for the bounded Markdown render. */
function shortPath(file) {
  return String(file ?? '').split(/[\\/]/).pop() ?? ''
}

/**
 * Render the bounded human-readable manifest plus the current part.
 *
 * Caps: 40 parts, 60 index entries, 20 gaps. The JSON manifest keeps the full
 * data; this render exists to fit one tool result.
 *
 * @param context - manifest fields plus `currentPart` and the configured
 *   `minGapSeconds` threshold.
 * @returns Markdown text.
 */
export function buildManifestMarkdown(context) {
  const { video, page, track, validation, stats, parts, index, gaps } = context
  const minGapSeconds = Number(context.minGapSeconds ?? 10)
  const pageValue = pageNumber(page)
  const lines = [`# ${video?.title ?? 'B站视频'} · 文稿索引`, '']
  lines.push(`- 视频：${video?.url ?? ''}${pageValue > 1 ? `?p=${pageValue}` : ''}`)
  if (page?.part) lines.push(`- 分P：第 ${pageValue} 集 · ${page.part}`)
  lines.push(`- 字幕轨道：${track ? `${track.lan} · ${track.lan_doc ?? ''}`.trim() : '未知'}`)
  if (validation) {
    lines.push(
      `- 校验：${validation.verdict ?? 'unknown'}（覆盖 ${Math.round((validation.coverage ?? 0) * 100)}%，` +
        `${validation.count ?? 0} 段）${validation.reasons?.length ? ` · ${validation.reasons.join('；')}` : ''}`,
    )
  }
  if (stats) {
    lines.push(`- 统计：${stats.chars} 字 · ${stats.segments} 段 · ${stats.parts} 个分段 · ${stats.gaps} 个缺口 · 覆盖 ${Math.round((stats.coverage ?? 0) * 100)}%`)
  }
  lines.push('', '## 分段')
  const listedParts = (parts ?? []).slice(0, 40)
  for (const part of listedParts) {
    lines.push(`- P${part.part} ${formatClock(part.from)}–${formatClock(part.to)} · ${part.chars} 字 · ${shortPath(part.file)}`)
  }
  if ((parts?.length ?? 0) > listedParts.length) lines.push(`- … 其余 ${parts.length - listedParts.length} 段见 manifest.parts`)
  lines.push('', '## 时间索引')
  for (const entry of (index ?? []).slice(0, 60)) {
    lines.push(`- ${formatClock(entry.time)} ${String(entry.text ?? '').slice(0, 40)}`)
  }
  lines.push('', '## 缺口（字幕断档）')
  const listedGaps = (gaps ?? []).slice(0, 20)
  if (listedGaps.length === 0) lines.push(`- 无 ≥${minGapSeconds} 秒断档`)
  for (const gap of listedGaps) {
    lines.push(`- ${formatClock(gap.from)}–${formatClock(gap.to)}（${gap.seconds} 秒）`)
  }
  lines.push('', '## 当前段')
  if (context.currentPart) {
    const current = context.currentPart
    if (typeof current.markdown === 'string' && current.markdown.length > 0) lines.push(current.markdown)
    else lines.push(buildPartMarkdown({ ...context, part: current, totalParts: (parts ?? []).length }))
  } else {
    lines.push('（未返回正文；用 bilibili_transcript_part({ url, part: N }) 或 cursor 按段读取。）')
  }
  return lines.join('\n')
}
