/**
 * Unit tests for the Phase 1 transcript primitives.
 *
 * Every test is offline and uses only Node standard library modules.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildIndex,
  buildManifestMarkdown,
  buildPartMarkdown,
  buildTranscriptManifest,
  cursorFor,
  extensionFor,
  formatClock,
  groupSegments,
  joinSegments,
  packParts,
  parseCursor,
  partForTime,
  searchSegments,
  toLrc,
  toPlainText,
  toSrt,
  transcriptGaps,
} from '../../lib/transcript.js'

/** Concatenate every part's segments, in order, exactly as stored. */
function reconstruct(parts) {
  return parts.flatMap((part) => part.segments.map((segment) => segment.text)).join('')
}

/** Raw concatenation of the source segment texts, without join separators. */
function rawText(segments) {
  return segments.map((segment) => segment.text).join('')
}

/** Deterministic two-hour-ish transcript with 2-4 s segments and long lines. */
function syntheticTranscript({ durationSeconds = 7200, baseTextLength = 42 } = {}) {
  const segments = []
  let from = 0
  let index = 0
  while (from < durationSeconds) {
    const to = Math.min(durationSeconds, from + 2 + (index % 3))
    const size = baseTextLength - (index % 5)
    const fill = '内容'.repeat(Math.ceil(size / 2)).slice(0, size)
    segments.push({ from, to, text: `第${index}句${fill}` })
    from = to
    index += 1
  }
  return segments
}

test('packParts returns [] for empty input', () => {
  assert.deepEqual(packParts([]), [])
  assert.deepEqual(packParts(undefined), [])
})

test('packParts keeps every part within maxChars and reconstructs text exactly', () => {
  const segments = syntheticTranscript()
  const snapshot = JSON.stringify(segments)
  const maxChars = 6000
  const maxSeconds = 600
  const parts = packParts(segments, { maxChars, maxSeconds })
  assert.ok(parts.length >= 10, `expected at least 10 parts, got ${parts.length}`)
  for (const [index, part] of parts.entries()) {
    assert.equal(part.part, index + 1, 'part numbering must be 1..N')
    assert.ok(part.chars <= maxChars, `part ${part.part} has ${part.chars} chars`)
    assert.ok(part.to - part.from <= maxSeconds + 35, `part ${part.part} spans ${part.to - part.from}s`)
    const segmentChars = part.segments.reduce((sum, segment) => sum + segment.text.length, 0)
    const blockChars = part.blocks.reduce((sum, block) => sum + block.text.length, 0)
    assert.equal(part.chars, segmentChars)
    assert.equal(part.chars, blockChars)
  }
  for (let index = 1; index < parts.length; index++) {
    assert.ok(parts[index].from >= parts[index - 1].from, 'from must be monotonic')
    assert.ok(parts[index].to >= parts[index - 1].to, 'to must be monotonic')
  }
  assert.equal(reconstruct(parts), rawText(segments))
  assert.equal(JSON.stringify(segments), snapshot, 'input must not be mutated')
})

test('packParts splits a single oversized segment without losing text', () => {
  const segments = [{ from: 0, to: 10, text: '长'.repeat(15_000) }]
  const parts = packParts(segments, { maxChars: 2000 })
  assert.equal(parts.length, 8)
  for (const part of parts) assert.ok(part.chars <= 2000)
  assert.equal(parts.map((part) => part.chars).reduce((sum, chars) => sum + chars, 0), 15_000)
  assert.equal(reconstruct(parts), segments[0].text)
  for (const part of parts) {
    assert.equal(part.from, 0)
    assert.equal(part.to, 10)
  }
})

test('packParts has no block larger than maxChars after splitting', () => {
  const segments = Array.from({ length: 40 }, (_, index) => ({
    from: index * 2,
    to: index * 2 + 2,
    text: '句子'.repeat(40),
  }))
  const parts = packParts(segments, { maxChars: 500, maxSeconds: 10_000 })
  for (const part of parts) {
    for (const block of part.blocks) assert.ok(block.text.length <= 500)
    assert.ok(part.chars <= 500)
  }
  assert.equal(reconstruct(parts), rawText(segments))
})

test('packParts keeps every segment exactly once, in order, across non-overlapping parts', () => {
  const segments = Array.from({ length: 240 }, (_, index) => ({
    from: index * 2,
    to: index * 2 + 2,
    text: index % 3 === 0 ? `word${index}` : `中文第${index}句`,
  }))
  const parts = packParts(segments, { maxChars: 300, maxSeconds: 10_000 })
  assert.ok(parts.length > 1, 'the fixture must need more than one part')
  const recovered = parts.flatMap((part) => part.segments.map((segment) => segment.text))
  assert.deepEqual(recovered, segments.map((segment) => segment.text), 'each segment exactly once, in order')
  assert.equal(reconstruct(parts), rawText(segments), 'raw text stays lossless without separators')
  for (const [index, part] of parts.entries()) {
    assert.equal(part.part, index + 1, 'part numbering must be 1..N')
    assert.ok(part.chars <= 300, `part ${part.part} has ${part.chars} chars`)
    assert.equal(part.chars, part.segments.reduce((sum, segment) => sum + segment.text.length, 0))
    assert.ok(part.blocks.reduce((sum, block) => sum + block.text.length, 0) <= 300, 'block text respects maxChars')
    for (const block of part.blocks) {
      assert.ok(block.from >= part.from && block.to <= part.to, 'every block stays inside its part')
    }
    if (index > 0) {
      assert.ok(part.from >= parts[index - 1].from, 'from must be monotonic')
      assert.ok(part.to >= parts[index - 1].to, 'to must be monotonic')
    }
  }
})

test('packParts splits an oversized English segment without invented spaces', () => {
  const text = 'abcdefghij'.repeat(1500)
  const segments = [{ from: 0, to: 10, text }]
  const parts = packParts(segments, { maxChars: 6000 })
  assert.equal(parts.length, 3)
  const pieces = parts.flatMap((part) => part.segments)
  assert.deepEqual(pieces.map((piece) => piece.text.length), [6000, 6000, 3000])
  assert.equal(reconstruct(parts), text, 'the slices of one segment concatenate verbatim')
  for (const piece of pieces) {
    assert.equal(piece.text.startsWith(' '), false, 'no space at the start of a slice')
    assert.equal(piece.text.endsWith(' '), false, 'no space at the end of a slice')
  }
  for (const part of parts) {
    for (const block of part.blocks) {
      assert.equal(block.text, block.text.trim(), 'a split must not introduce boundary whitespace')
    }
  }
})

test('packParts maps ASCII blocks back by segment count, not by character length', () => {
  // Pure ASCII words: joinSegments inserts one space at every boundary, so a
  // block text is longer than the raw texts it covers. The old character walk
  // (sum segment lengths until it reaches block.text.length) then swallows the
  // following segments and every later range shifts. CJK-only fixtures cannot
  // catch that, because there the two lengths agree.
  const segments = Array.from({ length: 200 }, (_, index) => ({
    from: index * 2,
    to: index * 2 + 2,
    text: `word${index}`,
  }))
  const parts = packParts(segments, { maxChars: 300, maxSeconds: 10_000 })
  assert.ok(parts.length > 1, 'the fixture must need more than one part')
  assert.deepEqual(
    parts.flatMap((part) => part.segments.map((segment) => segment.text)),
    segments.map((segment) => segment.text),
    'each source segment exactly once, in order',
  )
  for (const part of parts) {
    assert.ok(part.blocks.length > 0, `part ${part.part} must have blocks`)
    // Blocks already end and start on ASCII word characters, so the block
    // boundaries get the same single space as the segment boundaries.
    assert.equal(
      part.blocks.map((block) => block.text).join(' '),
      joinSegments(part.segments.map((segment) => segment.text)),
      `part ${part.part} block texts must reassemble its own segments`,
    )
    assert.equal(
      part.chars,
      part.segments.reduce((sum, segment) => sum + segment.text.length, 0),
      `part ${part.part} chars counts raw segment text only`,
    )
    assert.ok(part.chars <= 300, `part ${part.part} exceeds maxChars`)
  }
})

test('packParts joins two different source segments with one space in an oversized block', () => {
  // Every segment fits maxChars alone, but the whole block does not, so
  // packParts enters the oversized path. The first two segments still fit in
  // one unit (83 <= 100) and meet at a segment boundary, which is the case the
  // continuation slices cannot cover: they must gain exactly one separator.
  const first = 'alpha '.repeat(7).trim()
  const second = 'bravo '.repeat(7).trim()
  const third = 'charlie '.repeat(5).trim()
  const segments = [
    { from: 0, to: 2, text: first },
    { from: 2, to: 4, text: second },
    { from: 4, to: 6, text: third },
  ]
  const parts = packParts(segments, { maxChars: 100, maxSeconds: 10_000 })
  assert.equal(parts.length, 2, 'the merged unit and the remaining segment must split')
  assert.ok(parts.every((part) => part.chars <= 100))
  const merged = parts[0]
  assert.equal(merged.segments.length, 2, 'the unit must cover two source segments')
  assert.deepEqual(merged.segments.map((segment) => segment.text), [first, second])
  assert.equal(merged.blocks.length, 1)
  assert.equal(merged.blocks[0].text, `${first} ${second}`, 'exactly one space between the segments')
  assert.equal(merged.blocks[0].text.length, first.length + second.length + 1)
  assert.doesNotMatch(merged.blocks[0].text, / {2}/)
  assert.equal(rawText(segments).includes(`${first} ${second}`), false, 'the source texts carry no separator')
  assert.equal(merged.chars, first.length + second.length)
  assert.equal(parts[1].chars, third.length)
  assert.equal(reconstruct(parts), rawText(segments), 'the parts stay losslessly reconstructible')
})

test('packParts flushes an oversized block at a segment boundary without boundary spaces', () => {
  const first = 'alpha '.repeat(12).trim()
  const second = 'bravo '.repeat(12).trim()
  const segments = [
    { from: 0, to: 2, text: first },
    { from: 2, to: 4, text: second },
  ]
  assert.ok(first.length > 60 && second.length > 60)
  const parts = packParts(segments, { maxChars: 100, maxSeconds: 10_000 })
  assert.equal(parts.length, 2, 'the second segment does not fit and forces a flush')
  assert.deepEqual(parts.map((part) => part.segments.map((segment) => segment.text)), [[first], [second]])
  assert.equal(reconstruct(parts), rawText(segments), 'the flush is lossless')
  for (const part of parts) {
    assert.equal(part.chars, part.segments[0].text.length)
    for (const block of part.blocks) {
      assert.equal(block.text, part.segments[0].text)
      assert.equal(block.text.startsWith(' '), false, 'a flushed unit must not start with a space')
      assert.equal(block.text.endsWith(' '), false, 'a flushed unit must not end with a space')
    }
  }
})

test('packParts drops empty-text segments consistently and keeps the rest lossless', () => {
  const segments = [
    { from: 0, to: 1, text: '' },
    { from: 1, to: 2, text: 'hello' },
    { from: 3, to: 4, text: '' },
    { from: 5, to: 6, text: 'world' },
  ]
  const parts = packParts(segments, { maxChars: 1000 })
  assert.equal(parts.length, 1)
  assert.deepEqual(parts[0].segments.map((segment) => segment.text), ['hello', 'world'])
  assert.equal(parts[0].chars, 10)
  assert.equal(parts[0].blocks[0].text, 'hello world')
  assert.equal(reconstruct(parts), 'helloworld')
  assert.deepEqual(packParts([{ from: 0, to: 1, text: '' }]), [])
})

test('stats.chars counts content characters without the inserted separators', () => {
  const segments = [
    { from: 0, to: 2, text: 'hello' },
    { from: 2, to: 4, text: 'world' },
  ]
  const parts = packParts(segments, { maxChars: 1000 })
  const manifest = buildTranscriptManifest({
    video: { bvid: 'BV1xx411c7mD', title: '测试', duration: 4, url: 'https://www.bilibili.com/video/BV1xx411c7mD' },
    page: { page: 1 },
    track: { lan: 'ai-zh' },
    segments,
    parts,
    index: [],
    gaps: [],
    files: {},
    packing: { maxChars: 1000, maxSeconds: 600 },
  })
  assert.equal(manifest.stats.chars, 10)
  assert.equal(rawText(segments).length, 10)
  assert.equal(toPlainText(segments), 'hello world')
  assert.equal(toPlainText(segments).length, 11, 'the inserted space is not a content character')
  assert.equal(parts[0].chars, 10)
  assert.equal(parts[0].blocks[0].text, 'hello world')
  assert.equal(parts[0].blocks[0].text.length, 11)
})

test('joinSegments applies the ASCII word boundary rule', () => {
  assert.equal(joinSegments(['hello', 'world']), 'hello world')
  assert.equal(joinSegments(['videos', 'And']), 'videos And')
  assert.equal(joinSegments(['end.', 'Next']), 'end. Next')
  assert.equal(joinSegments(['你好', '世界']), '你好世界')
  assert.equal(joinSegments(['中文', 'English']), '中文English')
  assert.equal(joinSegments(['English', '中文']), 'English中文')
})

test('joinSegments covers every closing punctuation mark and mixed digit boundaries', () => {
  for (const punctuation of ['.', ',', ';', ':', '!', '?', '%', ')', ']', '}', "'", '"']) {
    assert.equal(joinSegments([`end${punctuation}`, 'Next']), `end${punctuation} Next`, punctuation)
  }
  assert.equal(joinSegments(['100', 'items']), '100 items')
  assert.equal(joinSegments(['100%', 'faster']), '100% faster')
  assert.equal(joinSegments(['end.', '中文']), 'end.中文', 'punctuation + CJK stays verbatim')
  assert.equal(joinSegments(['a', '-', 'b']), 'a-b')
  assert.equal(joinSegments(['hello', '  world']), 'hello  world', 'existing whitespace is untouched')
})

test('joinSegments never separates empty pieces or pieces touching whitespace', () => {
  assert.equal(joinSegments([]), '')
  assert.equal(joinSegments(['']), '')
  assert.equal(joinSegments(['', 'world']), 'world')
  assert.equal(joinSegments(['hello', '']), 'hello')
  assert.equal(joinSegments(['', '', '']), '')
  assert.equal(joinSegments(['', 'hello', '', 'world', '']), 'hello world')
  assert.equal(joinSegments(['hello', ' world']), 'hello world')
  assert.equal(joinSegments(['hello ', 'world']), 'hello world')
  assert.equal(joinSegments(['hello ', ' world']), 'hello  world')
  assert.equal(joinSegments(['hello', undefined, 'world']), 'hello world')
})

test('joinSegments tolerates a non-array argument', () => {
  assert.equal(joinSegments(undefined), '')
  assert.equal(joinSegments('not a list'), '')
})

test('toPlainText reproduces the Bcut mixed-language bug fixture with one space', () => {
  const segments = [
    { from: 6.3, to: 10.8, text: "I didn't draw a single frame of that five days for music videos" },
    { from: 10.86, to: 14, text: 'And i never opened a video editor' },
    { from: 14, to: 18, text: '这就是全部内容' },
    { from: 18, to: 20, text: '没有任何剪辑' },
  ]
  const text = toPlainText(segments)
  assert.match(text, /music videos And i never opened a video editor/)
  assert.ok(text.endsWith('editor这就是全部内容没有任何剪辑'))
  assert.doesNotMatch(text, /videosAnd/)
})

test('groupSegments records count and joins Latin lines while leaving CJK alone', () => {
  const segments = [
    { from: 0, to: 2, text: 'hello' },
    { from: 2, to: 4, text: 'world' },
    { from: 4, to: 6, text: '你好' },
    { from: 6, to: 8, text: '世界' },
    { from: 8, to: 10, text: 'end.' },
    { from: 10, to: 12, text: 'Next' },
  ]
  const blocks = groupSegments(segments, { targetSeconds: 100, maxChars: 1000 })
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].text, 'hello world你好世界end. Next')
  assert.equal(blocks[0].count, 6)
})

test('groupSegments counts the separator when enforcing maxChars', () => {
  const segments = [
    { from: 0, to: 1, text: 'abcde' },
    { from: 1, to: 2, text: 'fghij' },
  ]
  assert.equal(groupSegments(segments, { maxChars: 11, targetSeconds: 100 }).length, 1)
  assert.equal(groupSegments(segments, { maxChars: 10, targetSeconds: 100 }).length, 2, 'the inserted space makes 11 chars')
  const cjk = [
    { from: 0, to: 1, text: '一二三四五' },
    { from: 1, to: 2, text: '六七八九十' },
  ]
  assert.equal(groupSegments(cjk, { maxChars: 10, targetSeconds: 100 }).length, 1, 'CJK has no inserted space')
})

test('transcriptGaps reports only gaps at or above the threshold', () => {
  const segments = [
    { from: 0, to: 10, text: 'a' },
    { from: 36, to: 40, text: 'b' },
    { from: 45, to: 50, text: 'c' },
  ]
  const gaps = transcriptGaps(segments, { minGapSeconds: 10 })
  assert.equal(gaps.length, 1)
  assert.deepEqual(gaps[0], { from: 10, to: 36, seconds: 26 })
})

test('transcriptGaps ignores non-finite and negative gaps and caps the count', () => {
  const segments = [
    { from: 0, to: 20, text: 'a' },
    { from: 10, to: 30, text: 'b' },
    { from: 60, to: 70, text: 'c' },
    { from: 100, to: 110, text: 'd' },
  ]
  assert.deepEqual(transcriptGaps(segments, { minGapSeconds: 10, maxGaps: 1 }), [{ from: 30, to: 60, seconds: 30 }])
  assert.deepEqual(transcriptGaps([{ from: 0, to: NaN, text: 'a' }, { from: 50, to: 60, text: 'b' }]), [])
})

test('buildIndex keeps the first segment of every five-minute bucket', () => {
  const segments = []
  for (let index = 0; index < 40; index++) {
    segments.push({ from: index * 60, to: index * 60 + 30, text: `第${index}分钟${'字'.repeat(90)}` })
  }
  const index = buildIndex(segments, { chunkSeconds: 300, maxEntries: 20 })
  assert.equal(index.length, 8)
  assert.deepEqual(index[0], { time: 0, text: '第0分钟' + '字'.repeat(76) })
  assert.equal(index[0].text.length, 80)
  assert.equal(index[1].time, 300)
  assert.equal(buildIndex(segments, { chunkSeconds: 300, maxEntries: 3 }).length, 3)
})

test('searchSegments is case-insensitive by default and honours caseSensitive', () => {
  const segments = [{ from: 100, to: 104, text: 'Hello TypeScript 世界' }]
  const insensitive = searchSegments(segments, 'typescript')
  assert.equal(insensitive.totalMatches, 1)
  assert.equal(insensitive.matches[0].time, 100)
  assert.equal(insensitive.matches[0].before, 'Hello ')
  assert.equal(insensitive.matches[0].after, ' 世界')
  assert.equal(searchSegments(segments, 'typescript', { caseSensitive: true }).totalMatches, 0)
  assert.equal(searchSegments(segments, 'TypeScript', { caseSensitive: true }).totalMatches, 1)
})

test('searchSegments caps matches, reports truncation, and trims context', () => {
  const segments = [{ from: 10, to: 12, text: 'x x x x x' }]
  const result = searchSegments(segments, 'x', { maxMatches: 2 })
  assert.equal(result.matches.length, 2)
  assert.equal(result.totalMatches, 5)
  assert.equal(result.truncated, true)
  const narrow = searchSegments([{ from: 0, to: 1, text: 'abcdefghij' }], 'f', { contextChars: 2 })
  assert.equal(narrow.matches[0].before, 'de')
  assert.equal(narrow.matches[0].after, 'gh')
})

test('searchSegments is literal, not a regular expression', () => {
  assert.equal(searchSegments([{ from: 0, to: 1, text: 'abc' }], '.*').totalMatches, 0)
  assert.equal(searchSegments([{ from: 0, to: 1, text: 'a.*b' }], '.*').totalMatches, 1)
})

test('searchSegments caps match text at 240 chars and rejects an empty query', () => {
  const result = searchSegments([{ from: 0, to: 1, text: 'a'.repeat(500) }], 'a')
  assert.equal(result.matches[0].text.length, 240)
  assert.throws(() => searchSegments([], ''), /query must be a non-empty string/)
  assert.throws(() => searchSegments([], '   '), /query must be a non-empty string/)
})

test('cursorFor and parseCursor round-trip and reject bad input', () => {
  assert.equal(cursorFor(1, 2), '1-2')
  assert.deepEqual(parseCursor('1-2'), { page: 1, part: 2 })
  assert.deepEqual(parseCursor(cursorFor(12, 34)), { page: 12, part: 34 })
  assert.throws(() => parseCursor('12'), /invalid cursor/)
  assert.throws(() => parseCursor('0-1'), /invalid cursor/)
  assert.throws(() => parseCursor('a-b'), /invalid cursor/)
  assert.throws(() => parseCursor(undefined), /invalid cursor/)
})

test('cursorFor and parseCursor carry an optional non-canonical packing', () => {
  assert.equal(cursorFor(2, 7, 3000), '2-7@3000')
  assert.deepEqual(parseCursor('2-7@3000'), { page: 2, part: 7, maxChars: 3000 })
  assert.equal(parseCursor('2-7').maxChars, undefined, 'a plain cursor stays canonical')
  assert.throws(() => parseCursor('2-7@0'), /invalid cursor/)
  assert.throws(() => parseCursor('2-7@abc'), /invalid cursor/)
  assert.throws(() => cursorFor(1, 2, 0), /positive maxChars/)
})

test('partForTime finds the containing part', () => {
  const parts = packParts(syntheticTranscript({ durationSeconds: 300 }), { maxChars: 500 })
  for (const part of parts) {
    assert.equal(partForTime(parts, part.from)?.part, part.part)
    assert.equal(partForTime(parts, (part.from + part.to) / 2)?.part, part.part)
  }
  assert.equal(partForTime(parts, 10_000), undefined)
  assert.equal(partForTime(parts, NaN), undefined)
})

test('buildPartMarkdown renders the header, video link and block lines', () => {
  const part = {
    part: 2,
    from: 300,
    to: 600,
    chars: 12,
    blocks: [
      { from: 301, to: 320, text: '第一块' },
      { from: 321, to: 340, text: '第二块' },
    ],
    segments: [],
  }
  const markdown = buildPartMarkdown({
    video: { bvid: 'BV1xx411c7mD', title: '测试视频' },
    page: 1,
    part,
    totalParts: 5,
    track: { lan: 'ai-zh', lan_doc: '中文（AI生成）' },
  })
  assert.match(markdown, /^## 第 2\/5 段 · 05:00–10:00（12 字）/)
  assert.match(markdown, /https:\/\/www\.bilibili\.com\/video\/BV1xx411c7mD\?t=300/)
  assert.match(markdown, /\[05:01\]\([^)]*\?t=301\) 第一块/)
  assert.match(markdown, /第二块/)
})

test('buildTranscriptManifest reports consistent stats and lightweight parts', () => {
  const segments = syntheticTranscript({ durationSeconds: 700 })
  const parts = packParts(segments, { maxChars: 1000, maxSeconds: 300 })
  const manifest = buildTranscriptManifest({
    video: { bvid: 'BV1xx411c7mD', title: '测试', duration: 700, url: 'https://www.bilibili.com/video/BV1xx411c7mD' },
    page: { page: 1, cid: 42, part: 'P1' },
    track: { lan: 'ai-zh', lan_doc: '中文（AI生成）' },
    validation: { verdict: 'strong', coverage: 0.9, count: segments.length, reasons: [] },
    segments,
    parts,
    index: buildIndex(segments),
    gaps: transcriptGaps(segments),
    files: { transcript_json: '/tmp/transcript.json' },
    packing: { maxChars: 1000, maxSeconds: 300 },
  })
  assert.equal(manifest.stats.chars, rawText(segments).length)
  assert.equal(manifest.stats.chars, toPlainText(segments).length, 'this CJK fixture gains no separators')
  assert.equal(manifest.stats.segments, segments.length)
  assert.equal(manifest.stats.parts, parts.length)
  assert.equal(manifest.stats.gaps, manifest.gaps.length)
  assert.equal(manifest.stats.coveredSeconds, segments[segments.length - 1].to)
  assert.equal(manifest.packing.maxChars, 1000)
  assert.equal(manifest.parts.length, parts.length)
  assert.equal(manifest.parts[0].part, 1)
  assert.equal(manifest.parts[0].file, '')
  assert.ok(manifest.parts[0].preview.length <= 60)
  assert.doesNotThrow(() => JSON.stringify(manifest))
})

test('buildManifestMarkdown is bounded and contains every section', () => {
  const parts = Array.from({ length: 100 }, (_, index) => ({
    part: index + 1,
    from: index * 300,
    to: index * 300 + 280,
    chars: 100,
    file: `/out/bvid/parts/part-${String(index + 1).padStart(3, '0')}.md`,
    blocks: [{ from: index * 300, to: index * 300 + 280, text: '块' }],
    segments: [],
  }))
  const index = Array.from({ length: 100 }, (_, item) => ({ time: item * 72, text: '索引'.repeat(20) }))
  const gaps = Array.from({ length: 30 }, (_, item) => ({ from: item * 100, to: item * 100 + 15, seconds: 15 }))
  const currentPart = {
    part: 1,
    from: 0,
    to: 280,
    chars: 2000,
    blocks: Array.from({ length: 30 }, (_, item) => ({ from: item * 9, to: item * 9 + 8, text: '内容'.repeat(20) })),
    segments: [],
  }
  const markdown = buildManifestMarkdown({
    video: { bvid: 'BV1xx411c7mD', title: '测试', url: 'https://www.bilibili.com/video/BV1xx411c7mD', duration: 30_000 },
    page: { page: 1, part: 'P1' },
    track: { lan: 'ai-zh', lan_doc: '中文（AI生成）' },
    validation: { verdict: 'strong', coverage: 0.93, count: 812, reasons: [] },
    stats: { chars: 10_000, segments: 812, parts: 100, gaps: 30, coverage: 0.93 },
    parts,
    index,
    gaps,
    currentPart,
  })
  assert.ok(markdown.length < 12_000, `manifest markdown is ${markdown.length} chars`)
  assert.match(markdown, /## 分段/)
  assert.match(markdown, /## 时间索引/)
  assert.match(markdown, /## 缺口/)
  assert.match(markdown, /## 当前段/)
  assert.match(markdown, /第 1\/100 段/)
})

test('buildManifestMarkdown states the configured gap threshold when there are no gaps', () => {
  const context = {
    video: { title: '测试', url: 'https://www.bilibili.com/video/BV1xx411c7mD' },
    page: { page: 1 },
    track: { lan: 'ai-zh', lan_doc: '中文（AI生成）' },
    stats: { chars: 100, segments: 10, parts: 1, gaps: 0, coverage: 0.9 },
    parts: [{ part: 1, from: 0, to: 60, chars: 100, file: '' }],
    index: [],
    gaps: [],
  }
  assert.match(buildManifestMarkdown({ ...context, minGapSeconds: 30 }), /无 ≥30 秒断档/)
  assert.match(buildManifestMarkdown(context), /无 ≥10 秒断档/)
})

test('existing transcript helpers still behave', () => {
  assert.equal(formatClock(3661), '1:01:01')
  assert.equal(extensionFor('json'), '.json')
  assert.equal(toLrc([{ from: 1, to: 2, text: 'a' }]), '[00:01.00]a')
  assert.match(toSrt([{ from: 0, to: 1, text: 'a' }]), /00:00:00,000 --> 00:00:01,000/)
  assert.equal(groupSegments([{ from: 0, to: 1, text: 'ab' }])[0].text, 'ab')
})
