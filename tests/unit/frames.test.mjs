/**
 * Offline unit tests for the pure frame-planning helpers.
 *
 * No video, no ffmpeg, no network: every function under test is in-memory.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  frameFileName,
  nearestSubtitleText,
  normalizeRequestedTimestamps,
  parseBlurMetadata,
  parseShowinfoTimes,
  parseTimestamp,
  partFileTag,
  pickNearestPeak,
  renderFramesMarkdown,
  runBestEffort,
  selectKeyframeTimestamps,
} from '../../lib/frames.js'

test('selectKeyframeTimestamps puts scene candidates first, dedupes within 5s and caps', () => {
  const plan = selectKeyframeTimestamps(
    [],
    100,
    4,
    [
      { time: 10, reason: 'scene change' },
      { time: 10.5, reason: 'duplicate' },
      { time: 40, reason: 'scene change' },
    ],
  )
  assert.equal(plan.length, 4, 'the cap is a hard limit')
  assert.deepEqual(
    plan.map((entry) => entry.time),
    [10, 20, 40, 60],
  )
  assert.equal(plan[0].reason, 'scene change')
  assert.equal(plan[1].reason, 'even interval')
  assert.equal(plan[2].reason, 'scene change')
})

test('selectKeyframeTimestamps backfills at even intervals inside the duration', () => {
  const plan = selectKeyframeTimestamps([], 30, 6, [])
  assert.deepEqual(
    plan.map((entry) => entry.time),
    [10, 20],
    'a 30s video backfills at 10s and never reaches or exceeds the duration',
  )
  assert.ok(plan.every((entry) => entry.reason === 'even interval'))
  assert.deepEqual(
    selectKeyframeTimestamps([], 6, 6, []).map((entry) => entry.time),
    [3],
    'a video shorter than the ten-second floor still gets one midpoint frame',
  )
  assert.deepEqual(selectKeyframeTimestamps([], 0, 6, []), [], 'no duration means no automatic plan')
})

test('selectKeyframeTimestamps ignores out-of-range candidates and fills the cap', () => {
  const plan = selectKeyframeTimestamps(
    [],
    20,
    3,
    [{ time: -1 }, { time: 25 }, { time: 4 }, { time: 10 }, { time: 16 }],
  )
  assert.equal(plan.length, 3)
  assert.deepEqual(
    plan.map((entry) => entry.time),
    [4, 10, 16],
  )
})

test('parseShowinfoTimes parses pts_time lines, applies an offset and dedupes within 5s', () => {
  const log = [
    '[Parsed_showinfo_1 @ 000] n:0 pts:125000 pts_time:12.5 duration:1',
    '[Parsed_showinfo_1 @ 000] n:1 pts:130000 pts_time:13.0 duration:1',
    '[Parsed_showinfo_1 @ 000] n:2 pts:302000 pts_time:30.2 duration:1',
    'bench: utime=0.1s',
  ].join('\n')
  assert.deepEqual(parseShowinfoTimes(log), [12.5, 30.2])
  assert.deepEqual(parseShowinfoTimes(log, 100), [112.5, 130.2])
  assert.deepEqual(parseShowinfoTimes(log, 100, { dedupe: false }), [112.5, 113, 130.2])
  assert.deepEqual(parseShowinfoTimes('', 10), [])
})

test('parseBlurMetadata pairs pts_time with lavfi.blur and offsets the start', () => {
  const log = [
    '[Parsed_metadata_1 @ 000] pts_time:1.2',
    '[Parsed_metadata_1 @ 000] lavfi.blur=0.5',
    '[Parsed_metadata_1 @ 000] pts_time:2.4',
    '[Parsed_metadata_1 @ 000] lavfi.blur=0.1',
    '[Parsed_metadata_1 @ 000] lavfi.blur=0.9',
  ].join('\n')
  assert.deepEqual(parseBlurMetadata(log), [
    { time: 1.2, blur: 0.5 },
    { time: 2.4, blur: 0.1 },
  ])
  assert.deepEqual(parseBlurMetadata(log, 10), [
    { time: 11.2, blur: 0.5 },
    { time: 12.4, blur: 0.1 },
  ])
})

test('pickNearestPeak returns the closest peak or null', () => {
  const peaks = [{ time: 1 }, { time: 4.5 }, { time: 9 }]
  assert.equal(pickNearestPeak(peaks, 4)?.time, 4.5)
  assert.equal(pickNearestPeak(peaks, 20)?.time, 9)
  assert.equal(pickNearestPeak([], 4), null)
  assert.equal(pickNearestPeak(peaks, Number.NaN), null)
})

test('nearestSubtitleText accepts both from/to and start/end segments', () => {
  const segments = [
    { from: 0, to: 2, text: '开场' },
    { start: 10, end: 12, text: '结尾' },
  ]
  assert.equal(nearestSubtitleText(1, segments), '开场')
  assert.equal(nearestSubtitleText(3.5, segments), '开场', 'the caption window is two seconds')
  assert.equal(nearestSubtitleText(11.5, segments), '结尾')
  assert.equal(nearestSubtitleText(5, segments), '')
  assert.equal(nearestSubtitleText(1, undefined), '')

  // A later segment that covers the moment must win over the previous
  // segment's overlapping two-second window.
  const contiguous = [
    { from: 0, to: 2, text: '上一句' },
    { from: 2.5, to: 5, text: '覆盖这一秒' },
  ]
  assert.equal(nearestSubtitleText(4, contiguous), '覆盖这一秒')
})

test('parseTimestamp accepts numbers, mm:ss and h:mm:ss', () => {
  assert.equal(parseTimestamp(12.5), 12.5)
  assert.equal(parseTimestamp('200.4'), 200.4)
  assert.equal(parseTimestamp('03:20'), 200)
  assert.equal(parseTimestamp('1:02:03.5'), 3723.5)
  assert.ok(Number.isNaN(parseTimestamp('abc')))
  assert.ok(Number.isNaN(parseTimestamp('')))
  assert.ok(Number.isNaN(parseTimestamp('1:xx')))
  assert.ok(Number.isNaN(parseTimestamp(true)))
})

test('normalizeRequestedTimestamps preserves requested_time, dedupes and caps', () => {
  const segments = [{ from: 0, to: 2, text: '开场' }]
  const plan = normalizeRequestedTimestamps(['0:01', 10, 10.5, 101, -1, '1:00'], 100, 3, segments)
  assert.deepEqual(
    plan.map((entry) => entry.requested_time),
    [1, 10, 60],
  )
  assert.deepEqual(
    plan.map((entry) => entry.time),
    [1, 10, 60],
  )
  assert.equal(plan[0].reason, 'requested timestamp')
  assert.equal(plan[0].text, '开场')
  assert.equal(plan[1].text, '')

  const capped = normalizeRequestedTimestamps([0, 10, 20, 30, 40], 100, 2, [])
  assert.deepEqual(
    capped.map((entry) => entry.requested_time),
    [0, 10],
  )
  assert.equal(normalizeRequestedTimestamps([], 100, 6, []), null)
  assert.equal(normalizeRequestedTimestamps([200], 100, 6, []), null)
  assert.equal(normalizeRequestedTimestamps(undefined, 100, 6, []), null)

  // Explicit requests are the caller's intent: two moments three seconds apart
  // must both survive, while a near-duplicate is collapsed.
  const distinct = normalizeRequestedTimestamps(['0:01', 4], 100, 6, [])
  assert.deepEqual(
    distinct.map((entry) => entry.requested_time),
    [1, 4],
  )
  const nearDuplicate = normalizeRequestedTimestamps([10, 10.5], 100, 6, [])
  assert.deepEqual(
    nearDuplicate.map((entry) => entry.requested_time),
    [10],
  )
})

test('frameFileName and partFileTag isolate multi-part frames', () => {
  assert.equal(frameFileName('', 1), 'frame_001.jpg')
  assert.equal(frameFileName('', 12), 'frame_012.jpg')
  assert.equal(frameFileName('p4', 1), 'frame_p4_001.jpg')
  assert.equal(partFileTag(1, 1), '')
  assert.equal(partFileTag(3, 4), 'p4')
})

test('renderFramesMarkdown renders timestamp links, captions, paths and failures', () => {
  const text = renderFramesMarkdown({
    video: { bvid: 'BV1xx411c7mD' },
    page: { page: 1 },
    mode: 'local',
    strategy: 'requested timestamps',
    note: 'downloaded 1 MB',
    frames: [
      {
        time: 200.4,
        requested_time: 200,
        reason: 'requested timestamp',
        subtitle_text: '这是字幕',
        has_image: true,
        path: 'D:/out/frame_001.jpg',
        error: null,
      },
      {
        time: 5,
        requested_time: null,
        reason: 'even interval',
        subtitle_text: '',
        has_image: false,
        path: null,
        error: 'ffmpeg: boom',
      },
    ],
  })
  assert.ok(text.includes('[03:20](https://www.bilibili.com/video/BV1xx411c7mD?t=200)'))
  assert.ok(text.includes('这是字幕'))
  assert.ok(text.includes('D:/out/frame_001.jpg'))
  assert.ok(text.includes('ffmpeg: boom'))
  assert.ok(text.includes('read_image'))
  assert.ok(text.includes('local'))
})

test('runBestEffort retries an EFMPEG failure and records a skipped note', async () => {
  const notes = []
  let calls = 0
  const result = await runBestEffort({
    label: 'sharp-frame refinement',
    notes,
    task: async () => {
      calls += 1
      const error = new Error('ffmpeg exited with code 3221225794')
      error.code = 'EFMPEG'
      throw error
    },
  })
  assert.equal(result, null)
  assert.equal(calls, 2, 'an EFMPEG failure gets one retry')
  assert.deepEqual(notes, ['sharp-frame refinement skipped: ffmpeg exited with code 3221225794'])
  assert.ok(!notes[0].includes('failed'))
})

test('runBestEffort returns a successful second attempt after an EFMPEG init failure', async () => {
  const notes = []
  let calls = 0
  const result = await runBestEffort({
    label: 'sharp-frame refinement',
    notes,
    task: async () => {
      calls += 1
      if (calls === 1) {
        const error = new Error('ffmpeg exited with code 3221225794')
        error.code = 'EFMPEG'
        throw error
      }
      return 7.25
    },
  })
  assert.equal(result, 7.25)
  assert.equal(calls, 2)
  assert.deepEqual(notes, [])
})

test('runBestEffort does not retry a generic EFMPEG decode failure', async () => {
  const notes = []
  let calls = 0
  const result = await runBestEffort({
    label: 'scene alignment',
    notes,
    task: async () => {
      calls += 1
      const error = new Error('ffmpeg exited with code 1')
      error.code = 'EFMPEG'
      throw error
    },
  })
  assert.equal(result, null)
  assert.equal(calls, 1, 'a real decode failure must not decode twice')
  assert.deepEqual(notes, ['scene alignment skipped: ffmpeg exited with code 1'])
})

test('runBestEffort does not retry a non-EFMPEG failure', async () => {
  const notes = []
  let calls = 0
  const result = await runBestEffort({
    label: 'scene alignment',
    notes,
    task: async () => {
      calls += 1
      const error = new Error('ffmpeg timed out after 1000 ms')
      error.code = 'ETIMEDOUT'
      throw error
    },
  })
  assert.equal(result, null)
  assert.equal(calls, 1)
  assert.deepEqual(notes, ['scene alignment skipped: ffmpeg timed out after 1000 ms'])
})

test('runBestEffort returns a successful first attempt without a note', async () => {
  const notes = []
  let calls = 0
  const result = await runBestEffort({
    label: 'scene detection',
    notes,
    task: async () => {
      calls += 1
      return [{ time: 3 }]
    },
  })
  assert.deepEqual(result, [{ time: 3 }])
  assert.equal(calls, 1)
  assert.deepEqual(notes, [])
})

test('runBestEffort rethrows cancellation instead of recording a skip', async () => {
  const controller = new AbortController()
  controller.abort()
  const notes = []
  await assert.rejects(
    runBestEffort({
      label: 'sharp-frame refinement',
      notes,
      signal: controller.signal,
      task: async () => {
        throw new Error('aborted')
      },
    }),
    /aborted/,
  )
  assert.deepEqual(notes, [])
})
