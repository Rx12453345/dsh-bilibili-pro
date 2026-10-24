/**
 * Bcut ASR unit tests: candidate selection, utterance parsing, create/poll
 * state handling and the timeout path. No network is used.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BCUT_API_BASE, parseBcutUtterances, pickLowestAudio, transcribeWithBcut } from '../../lib/bcut.js'

const AUDIO = 'https://cdn.example.com/signed-audio.m4s?token=secret'
const CREATE_URL = `${BCUT_API_BASE}/task`

/** JSON response helper for the stubbed fetch. */
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

test('pickLowestAudio picks the smallest positive bandwidth', () => {
  const candidates = [
    { url: 'https://cdn.example.com/high.m4s', bandwidth: 212_000 },
    { url: 'https://cdn.example.com/mid.m4s', bandwidth: 113_000 },
    { url: 'https://cdn.example.com/low.m4s', bandwidth: 65_000 },
  ]
  assert.equal(pickLowestAudio(candidates).url, 'https://cdn.example.com/low.m4s')
})

test('pickLowestAudio handles one candidate, the bare-stream shape and an empty list', () => {
  const single = { url: 'https://cdn.example.com/only.m4s', bandwidth: 65_000 }
  assert.equal(pickLowestAudio([single]), single)
  assert.equal(pickLowestAudio(single), single)
  assert.equal(pickLowestAudio([]), undefined)
  assert.equal(pickLowestAudio(undefined), undefined)
  // Missing/non-positive bandwidth falls back to the last DASH entry.
  const unknown = [{ url: 'https://cdn.example.com/a.m4s', bandwidth: 0 }, { url: 'https://cdn.example.com/b.m4s' }]
  assert.equal(pickLowestAudio(unknown).url, 'https://cdn.example.com/b.m4s')
  // Entries without a URL are unusable and dropped.
  assert.equal(pickLowestAudio([{ bandwidth: 1 }, single]).url, single.url)
})

test('parseBcutUtterances maps milliseconds to seconds and drops empty text', () => {
  const parsed = parseBcutUtterances({
    utterances: [
      { start_time: 0, end_time: 1520, transcript: ' 第一句 ' },
      { start_time: 1520, end_time: 3000, transcript: '   ' },
      { start_time: 3000, end_time: 4321.6, transcript: '第二句' },
    ],
  })
  assert.equal(parsed.provider, 'bcut')
  assert.equal(parsed.language, 'zh')
  assert.deepEqual(parsed.segments, [
    { from: 0, to: 1.52, text: '第一句' },
    { from: 3, to: 4.32, text: '第二句' },
  ])
  assert.ok(typeof parsed.note === 'string' && parsed.note.length > 0)
})

test('parseBcutUtterances accepts the JSON string Bcut actually returns', () => {
  const result = JSON.stringify({
    utterances: [{ start_time: 120_000, end_time: 125_000, transcript: '字符串结果' }],
  })
  assert.deepEqual(parseBcutUtterances(result).segments, [{ from: 120, to: 125, text: '字符串结果' }])
})

test('parseBcutUtterances tolerates a missing utterance list and rejects malformed JSON', () => {
  assert.deepEqual(parseBcutUtterances({}).segments, [])
  assert.deepEqual(parseBcutUtterances(undefined).segments, [])
  assert.throws(() => parseBcutUtterances('{not json'), /malformed transcription result/)
})

test('transcribeWithBcut creates a task with model_id 8 and polls state 1 then state 4', async () => {
  const calls = []
  let polls = 0
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    if (String(url) === CREATE_URL) {
      return jsonResponse({ code: 0, data: { task_id: 'task-123' } })
    }
    if (String(url).includes('/task/result')) {
      polls += 1
      if (polls === 1) return jsonResponse({ code: 0, data: { state: 1 } })
      return jsonResponse({
        code: 0,
        data: {
          state: 4,
          result: JSON.stringify({
            utterances: [{ start_time: 0, end_time: 2000, transcript: '必剪结果' }],
          }),
        },
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }

  const result = await transcribeWithBcut({ audioUrl: AUDIO, fetchImpl, pollMs: 1, timeoutMs: 1000 })
  assert.deepEqual(result.segments, [{ from: 0, to: 2, text: '必剪结果' }])
  assert.equal(result.provider, 'bcut')
  assert.equal(polls, 2)

  const create = calls.find((call) => call.url === CREATE_URL)
  assert.equal(create.init.method, 'POST')
  assert.deepEqual(JSON.parse(create.init.body), { resource: AUDIO, model_id: '8' })
  assert.match(create.init.headers['Content-Type'], /application\/json/)
  assert.equal(create.init.headers.Authorization, undefined)
  assert.ok(calls.some((call) => call.url.includes('/task/result?model_id=8&task_id=task-123')))
})

test('transcribeWithBcut reports a state 3 rejection without leaking the audio URL', async () => {
  const fetchImpl = async (url) => {
    if (String(url) === CREATE_URL) return jsonResponse({ code: 0, data: { task_id: 'task-err' } })
    return jsonResponse({ code: 0, data: { state: 3, remark: '音频过长' } })
  }
  await assert.rejects(transcribeWithBcut({ audioUrl: AUDIO, fetchImpl, pollMs: 1, timeoutMs: 1000 }), (error) => {
    assert.match(error.message, /state 3/)
    assert.match(error.message, /音频过长/)
    assert.match(error.message, /10 minutes/)
    assert.ok(!error.message.includes('token=secret'))
    return true
  })
})

test('transcribeWithBcut surfaces create failures clearly', async () => {
  await assert.rejects(
    transcribeWithBcut({
      audioUrl: AUDIO,
      fetchImpl: async () => jsonResponse({ code: -400, message: 'bad audio' }),
      pollMs: 1,
      timeoutMs: 1000,
    }),
    /Bcut ASR task create failed: bad audio/,
  )
  await assert.rejects(
    transcribeWithBcut({
      audioUrl: AUDIO,
      fetchImpl: async () => jsonResponse({}, 500),
      pollMs: 1,
      timeoutMs: 1000,
    }),
    /Bcut ASR task create failed \(HTTP 500\)/,
  )
  await assert.rejects(
    transcribeWithBcut({
      audioUrl: AUDIO,
      fetchImpl: async () => jsonResponse({ code: 0, data: {} }),
      pollMs: 1,
      timeoutMs: 1000,
    }),
    /returned no task id/,
  )
})

test('transcribeWithBcut times out clearly while the task stays in state 1', async () => {
  const fetchImpl = async (url) => {
    if (String(url) === CREATE_URL) return jsonResponse({ code: 0, data: { task_id: 'task-slow' } })
    return jsonResponse({ code: 0, data: { state: 1 } })
  }
  await assert.rejects(transcribeWithBcut({ audioUrl: AUDIO, fetchImpl, pollMs: 5, timeoutMs: 40 }), (error) => {
    assert.match(error.message, /timed out after 40 ms/)
    assert.ok(!error.message.includes('token=secret'))
    return true
  })
})
