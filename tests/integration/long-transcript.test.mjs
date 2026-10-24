/**
 * Long-transcript integration test: ~100k characters, two hours, no network.
 *
 * Proves the paging layer is lossless, the bundle round-trips, search maps a
 * hit back to its part, and a part stays inside the tool budget.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildIndex,
  buildManifestMarkdown,
  packParts,
  partForTime,
  searchSegments,
  toPlainText,
  transcriptGaps,
} from '../../lib/transcript.js'
import { readTranscriptBundle, writeTranscriptBundle } from '../../lib/store.js'

const DURATION = 7200
const KEYWORD = '量子计算'
const GAP_SECONDS = 30

/**
 * Two-hour fixture: 2-4 s segments, ~40 chars each, a known keyword around
 * 30:00, and a 30 s subtitle gap at about 60:00.
 */
function buildFixture() {
  const segments = []
  let from = 0
  let index = 0
  let keywordTime
  let gapInserted = false
  while (from < DURATION) {
    const to = Math.min(DURATION, from + 2 + (index % 3))
    let text = `第${index}句` + '视频内容讲解与演示，画面和口播同步推进。'.repeat(2).slice(0, 36)
    if (keywordTime === undefined && from >= 1795) {
      text = `第${index}句 ${KEYWORD} 的关键在于纠错与保真度`
      keywordTime = from
    }
    segments.push({ from, to, text })
    from = to
    index += 1
    if (!gapInserted && from >= 3600) {
      from += GAP_SECONDS
      gapInserted = true
    }
  }
  return { segments, keywordTime }
}

test('two-hour transcript pages losslessly, round-trips on disk, and searches back', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-bili-pro-'))
  try {
    const { segments, keywordTime } = buildFixture()
    const text = toPlainText(segments)
    assert.ok(text.length > 90_000, `fixture text should be about 100k chars, got ${text.length}`)
    assert.ok(keywordTime !== undefined)

    const maxChars = 3000
    const parts = packParts(segments, { maxChars, maxSeconds: 600 })
    assert.ok(parts.length >= 10, `expected at least 10 parts, got ${parts.length}`)
    for (const part of parts) {
      assert.ok(part.chars <= maxChars)
      assert.ok(part.from >= 0 && part.to <= DURATION, `part ${part.part} must stay inside the video`)
    }
    assert.equal(
      parts.flatMap((part) => part.segments.map((segment) => segment.text)).join(''),
      text,
      'concatenating every part must reproduce the transcript exactly',
    )

    const gaps = transcriptGaps(segments, { minGapSeconds: 10 })
    const bigGap = gaps.find((gap) => gap.seconds >= GAP_SECONDS - 1 && gap.seconds <= GAP_SECONDS + 1)
    assert.ok(bigGap, `expected a ~${GAP_SECONDS}s gap, got ${JSON.stringify(gaps)}`)

    const index = buildIndex(segments, { chunkSeconds: 300 })
    assert.ok(index.length >= 24, `expected ~24 five-minute entries, got ${index.length}`)
    for (let item = 1; item < index.length; item++) {
      const delta = index[item].time - index[item - 1].time
      assert.ok(delta >= 240 && delta <= 360, `index step ${delta}s at entry ${item}`)
    }

    const video = {
      bvid: 'BV1xx411c7mD',
      title: '两小时测试视频',
      duration: DURATION,
      url: 'https://www.bilibili.com/video/BV1xx411c7mD',
      owner: { mid: 1, name: 'UP' },
    }
    const page = { page: 1, cid: 456, part: 'P1', duration: DURATION }
    const track = { lan: 'ai-zh', lan_doc: '中文（AI生成）', ai: true }
    const validation = {
      verdict: 'strong',
      accepted: true,
      coverage: Number((segments[segments.length - 1].to / DURATION).toFixed(3)),
      count: segments.length,
      reasons: [],
    }
    const written = writeTranscriptBundle({
      outDir: tmp,
      bvid: video.bvid,
      page,
      video,
      track,
      validation,
      source: 'subtitle',
      segments,
      parts,
      index,
      gaps,
      packing: { maxChars, maxSeconds: 600 },
    })

    const read = readTranscriptBundle({ outDir: tmp, bvid: video.bvid, page: 1 })
    assert.ok(read)
    assert.equal(read.manifest.stats.chars, text.length)
    assert.equal(read.manifest.stats.segments, segments.length)
    assert.equal(read.manifest.stats.parts, parts.length)
    assert.equal(read.manifest.stats.gaps, gaps.length)
    assert.equal(read.manifest.gaps.length, gaps.length)
    assert.equal(read.transcript.text, text)
    assert.equal(read.parts.length, parts.length)

    const result = searchSegments(segments, KEYWORD)
    assert.ok(result.totalMatches >= 1)
    const match = result.matches[0]
    assert.equal(match.time, keywordTime)
    const hitPart = partForTime(read.parts, match.time)
    assert.ok(hitPart, 'the keyword must fall inside a canonical part')
    assert.ok(hitPart.segments.some((segment) => segment.text.includes(KEYWORD)))
    const canonical = read.manifest.parts.find((entry) => entry.part === hitPart.part)
    assert.ok(canonical, 'the hit part must appear in the manifest')
    assert.ok(canonical.from <= match.time && match.time <= canonical.to)

    for (const part of read.parts) {
      const size = JSON.stringify(part).length
      assert.ok(size < 12_000, `part ${part.part} JSON is ${size} chars`)
    }

    const markdown = buildManifestMarkdown({ ...read.manifest, currentPart: hitPart })
    assert.ok(markdown.length < 12_000, `manifest render is ${markdown.length} chars`)
    assert.match(markdown, /## 分段/)
    assert.match(markdown, /量子计算/)

    const partFile = read.parts[0].json_file ?? written.parts[0].json_file
    const stored = JSON.parse(readFileSync(partFile, 'utf8'))
    assert.equal(stored.segments.length, read.parts[0].segments.length)
    assert.ok(stored.markdown.includes('## 第 1/'))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
