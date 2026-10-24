/**
 * Unit tests for the disk-backed transcript bundle.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildIndex,
  packParts,
  toPlainText,
  transcriptGaps,
} from '../../lib/transcript.js'
import { bundleDirFor, readTranscriptBundle, writeTranscriptBundle } from '../../lib/store.js'

/** A small but realistic bundle fixture. */
function fixture() {
  const segments = Array.from({ length: 400 }, (_, index) => ({
    from: index * 3,
    to: index * 3 + 2.5,
    text: `第${index}句 内容`,
  }))
  const video = {
    bvid: 'BV1xx411c7mD',
    title: '测试视频',
    duration: 1200,
    url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    owner: { mid: 1, name: 'UP' },
  }
  const page = { page: 1, cid: 123, part: 'P1', duration: 1200 }
  const track = { lan: 'ai-zh', lan_doc: '中文（AI生成）', ai: true }
  const validation = { verdict: 'strong', accepted: true, coverage: 0.99, count: segments.length, reasons: [] }
  return {
    segments,
    video,
    page,
    track,
    validation,
    parts: packParts(segments, { maxChars: 2000, maxSeconds: 600 }),
    index: buildIndex(segments, { chunkSeconds: 300 }),
    gaps: transcriptGaps(segments),
    packing: { maxChars: 2000, maxSeconds: 600 },
  }
}

test('writeTranscriptBundle writes the documented layout and reads back losslessly', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-bili-pro-'))
  try {
    const data = fixture()
    const outDir = join(tmp, 'bili-out')
    const written = writeTranscriptBundle({
      ...data,
      outDir,
      bvid: data.video.bvid,
      source: 'subtitle',
    })
    assert.equal(written.baseDir, join(outDir, data.video.bvid))
    for (const file of [
      'meta.json',
      'transcript.json',
      'transcript.md',
      'parts/index.json',
      'parts/part-001.md',
      'parts/part-001.json',
    ]) {
      assert.ok(existsSync(join(written.baseDir, file)), `${file} must exist`)
    }
    for (const file of Object.values(written.files)) {
      assert.ok(file.startsWith(written.baseDir), `${file} must stay inside the bundle`)
    }
    const transcriptJson = JSON.parse(readFileSync(written.files.transcript_json, 'utf8'))
    assert.equal(transcriptJson.text, toPlainText(data.segments))
    assert.equal(transcriptJson.segments.length, data.segments.length)

    const read = readTranscriptBundle({ outDir, bvid: data.video.bvid, page: 1 })
    assert.ok(read)
    assert.equal(read.baseDir, written.baseDir)
    assert.equal(read.manifest.parts.length, data.parts.length)
    assert.equal(read.manifest.stats.chars, toPlainText(data.segments).length)
    assert.equal(read.manifest.stats.parts, data.parts.length)
    assert.equal(read.transcript.text, toPlainText(data.segments))
    assert.equal(read.parts.length, data.parts.length)
    assert.equal(read.parts[0].segments[0].text, data.segments[0].text)
    assert.equal(read.meta.files.transcript_json, written.files.transcript_json)
    assert.ok(read.meta.generated_at)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('readTranscriptBundle returns undefined for a missing or corrupt bundle', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-bili-pro-'))
  try {
    const data = fixture()
    const outDir = join(tmp, 'bili-out')
    const written = writeTranscriptBundle({ ...data, outDir, bvid: data.video.bvid })
    assert.equal(readTranscriptBundle({ outDir, bvid: 'BV1xx411c7mX', page: 1 }), undefined)

    writeFileSync(written.files.transcript_json, '{ not json', 'utf8')
    assert.equal(readTranscriptBundle({ outDir, bvid: data.video.bvid, page: 1 }), undefined)

    unlinkSync(written.files.meta_json)
    assert.equal(readTranscriptBundle({ outDir, bvid: data.video.bvid, page: 1 }), undefined)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('bundle paths reject traversal and page zero', () => {
  const out = join(tmpdir(), 'dsh-bili-store-root')
  assert.throws(() => bundleDirFor(out, '../escape', 1), /invalid bvid/)
  assert.throws(() => bundleDirFor(out, 'BV1xx411c7mD', 0), /invalid page/)
  assert.throws(() => bundleDirFor(out, 'BV1xx411c7mD', 'nope'), /invalid page/)
  assert.equal(bundleDirFor(out, 'BV1xx411c7mD', 1), join(out, 'BV1xx411c7mD'))
  assert.equal(bundleDirFor(out, 'BV1xx411c7mD', 3), join(out, 'BV1xx411c7mD', 'p3'))
})

test('writeTranscriptBundle removes stale part files after a larger repack', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-bili-pro-'))
  try {
    const data = fixture()
    const outDir = join(tmp, 'bili-out')
    const writeAt = (maxChars) =>
      writeTranscriptBundle({
        ...data,
        outDir,
        bvid: data.video.bvid,
        parts: packParts(data.segments, { maxChars, maxSeconds: 10_000 }),
        packing: { maxChars, maxSeconds: 10_000 },
      })
    const smallParts = packParts(data.segments, { maxChars: 2000, maxSeconds: 10_000 }).length
    const bigParts = packParts(data.segments, { maxChars: 6000, maxSeconds: 10_000 }).length
    assert.ok(smallParts > bigParts, 'fixture must lose parts when the packing grows')
    writeAt(2000)
    const second = writeAt(6000)
    const partsDir = join(bundleDirFor(outDir, data.video.bvid, 1), 'parts')
    for (let number = bigParts + 1; number <= smallParts; number++) {
      const name = `part-${String(number).padStart(3, '0')}`
      assert.equal(existsSync(join(partsDir, `${name}.md`)), false, `${name}.md must be removed`)
      assert.equal(existsSync(join(partsDir, `${name}.json`)), false, `${name}.json must be removed`)
    }
    assert.ok(existsSync(second.parts.at(-1).file), 'the new last part must still be written')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('writeTranscriptBundle ends text files with a newline', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-bili-pro-'))
  try {
    const data = fixture()
    const written = writeTranscriptBundle({ ...data, outDir: tmp, bvid: data.video.bvid })
    for (const file of [written.files.transcript_md, written.parts[0].file, written.files.meta_json]) {
      assert.ok(readFileSync(file, 'utf8').endsWith('\n'), `${file} must end with a newline`)
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
