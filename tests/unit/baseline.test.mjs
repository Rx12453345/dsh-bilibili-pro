/**
 * Baseline tests for the renamed fork.
 *
 * These pin the pure helpers that Phase 0 must not disturb: transcript
 * formatting, the three-level validation, and the subtitle URL rewrite.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extensionFor,
  formatClock,
  groupSegments,
  toLrc,
  toPlainText,
  toSrt,
} from '../../lib/transcript.js'
import { assessMatch } from '../../lib/validate.js'
import { rebuildSubtitleUrl } from '../../lib/subtitle-url.js'

test('formatClock handles minutes and hours', () => {
  assert.equal(formatClock(0), '00:00')
  assert.equal(formatClock(61), '01:01')
  assert.equal(formatClock(3661), '1:01:01')
})

test('groupSegments merges short lines into one block', () => {
  const segments = [
    { from: 0, to: 10, text: '你好，' },
    { from: 10, to: 20, text: '世界' },
  ]
  const blocks = groupSegments(segments)
  assert.equal(blocks.length, 1)
  assert.deepEqual(blocks[0], { from: 0, to: 20, text: '你好，世界' })
})

test('groupSegments starts a new block at the duration budget', () => {
  const segments = [
    { from: 0, to: 20, text: 'a' },
    { from: 20, to: 40, text: 'b' },
    { from: 40, to: 41, text: 'c' },
  ]
  const blocks = groupSegments(segments, { targetSeconds: 25 })
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].text, 'a')
  assert.equal(blocks[1].text, 'bc')
})

test('toPlainText joins every segment without timestamps', () => {
  assert.equal(
    toPlainText([
      { from: 0, to: 1, text: '你' },
      { from: 1, to: 2, text: '好' },
    ]),
    '你好',
  )
})

test('toSrt renders one cue per segment', () => {
  const srt = toSrt([
    { from: 0, to: 1.5, text: '第一句' },
    { from: 1.5, to: 3.25, text: '第二句' },
  ])
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:01,500\n第一句\n/)
  assert.match(srt, /2\n00:00:01,500 --> 00:00:03,250\n第二句\n/)
})

test('toLrc renders LRC cue lines', () => {
  const lrc = toLrc([{ from: 65.25, to: 66, text: '歌词' }])
  assert.equal(lrc, '[01:05.25]歌词')
})

test('extensionFor maps every supported format', () => {
  assert.equal(extensionFor('markdown'), '.md')
  assert.equal(extensionFor('text'), '.txt')
  assert.equal(extensionFor('srt'), '.srt')
  assert.equal(extensionFor('ass'), '.ass')
  assert.equal(extensionFor('lrc'), '.lrc')
  assert.equal(extensionFor('json'), '.json')
  assert.equal(extensionFor('unknown'), '.md')
})

test('assessMatch accepts a title-matching, well-covered transcript', () => {
  const segments = Array.from({ length: 20 }, (_, index) => ({
    from: index * 4,
    to: index * 4 + 4,
    text: 'TypeScript 入门教程 内容',
  }))
  const result = assessMatch({ title: 'TypeScript 入门教程', segments, duration: 90 })
  assert.equal(result.verdict, 'strong')
  assert.equal(result.accepted, true)
  assert.ok(result.keywordHits > 0)
})

test('assessMatch accepts a well-covered transcript without keyword hits as weak', () => {
  const segments = Array.from({ length: 100 }, (_, index) => ({
    from: index * 1,
    to: index * 1 + 1,
    text: '这里完全没有标题里的词',
  }))
  const result = assessMatch({ title: 'Alpha Beta Gamma', segments, duration: 100 })
  assert.equal(result.verdict, 'weak')
  assert.equal(result.accepted, true)
  assert.equal(result.keywordHits, 0)
})

test('assessMatch rejects a too-short transcript', () => {
  const result = assessMatch({
    title: 'TypeScript 入门教程',
    segments: [{ from: 0, to: 30, text: 'TypeScript 入门教程' }],
    duration: 100,
  })
  assert.equal(result.verdict, 'fail')
  assert.equal(result.accepted, false)
})

test('rebuildSubtitleUrl leaves an already-final CDN URL alone', () => {
  const finalUrl = '//aisubtitle.hdslb.com/bfs/subtitle/abc123.json?auth_key=1'
  assert.equal(rebuildSubtitleUrl(finalUrl), finalUrl)
})

test('rebuildSubtitleUrl returns undefined for an unknown host or empty input', () => {
  assert.equal(rebuildSubtitleUrl('https://example.com/subtitle.json'), undefined)
  assert.equal(rebuildSubtitleUrl(''), undefined)
  assert.equal(rebuildSubtitleUrl(undefined), undefined)
})
