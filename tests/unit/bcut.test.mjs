/**
 * Bcut ASR unit tests: candidate selection, utterance parsing, and the
 * six-step download-upload pipeline (resource create, per_size part uploads,
 * resource complete, task create, result poll). No network is used; the audio
 * is a real temporary file so the chunk reader is exercised.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BCUT_API_BASE, parseBcutUtterances, pickLowestAudio, transcribeWithBcut } from '../../lib/bcut.js'

const CREATE_URL = `${BCUT_API_BASE}/resource/create`
const COMPLETE_URL = `${BCUT_API_BASE}/resource/create/complete`
const TASK_URL = `${BCUT_API_BASE}/task`
const DOWNLOAD_URL = 'https://bcut.example.com/resource.m4a?token=download-secret'

/** JSON response helper for the stubbed fetch. */
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

/** A successful but empty ETag-carrying upload response. */
function uploadResponse(etag) {
  return new Response('', { status: 200, headers: etag ? { etag } : {} })
}

/** Create a real temporary audio file with the given bytes. */
async function withAudio(bytes, run) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bcut-'))
  const file = join(dir, 'audio.m4a')
  writeFileSync(file, bytes)
  try {
    return await run(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Build a fetch stub for the whole pipeline.
 *
 * @param options - perSize, uploadUrls, etags, pollStates, and failure switches.
 * @returns `{ fetchImpl, calls }`; every call records url/method/body/headers.
 */
function protocolStub(options = {}) {
  const {
    perSize = 4,
    uploadUrls = ['https://upload.example.com/part-0?token=upload-secret', 'https://upload.example.com/part-1?token=upload-secret'],
    etags = ['"etag-1"', '"etag-2"'],
    pollStates = [4],
    remark = '',
    createFailure,
    uploadFailureAt,
    missingEtagAt,
    completeFailure,
    createCompleteFailure,
    taskFailure,
    taskId = 'task-123',
    malformedPoll = [],
  } = options
  const calls = []
  let polls = 0
  const fetchImpl = async (url, init = {}) => {
    const href = String(url)
    const method = init.method ?? 'GET'
    calls.push({ url: href, method, body: init.body, headers: init.headers ?? {} })
    if (href === CREATE_URL) {
      if (createFailure === 'http') return new Response('nope', { status: 500 })
      if (createFailure === 'code') return jsonResponse({ code: -400, message: 'bad audio' })
      if (createFailure === 'incomplete') {
        return jsonResponse({ code: 0, data: { per_size: perSize, in_boss_key: '', resource_id: '', upload_id: '', upload_urls: [] } })
      }
      return jsonResponse({
        code: 0,
        data: {
          upload_urls: uploadUrls,
          per_size: perSize,
          in_boss_key: 'boss-key',
          resource_id: 'resource-id',
          upload_id: 'upload-id',
        },
      })
    }
    if (href.startsWith('https://upload.example.com/')) {
      const index = Number(/part-(\d+)/.exec(new URL(href).pathname)?.[1] ?? 0)
      if (index === uploadFailureAt) return new Response('nope', { status: 500 })
      if (index === missingEtagAt) return uploadResponse(undefined)
      return uploadResponse(etags[index])
    }
    if (href === COMPLETE_URL) {
      if (completeFailure === 'http') return new Response('nope', { status: 500 })
      if (completeFailure === 'code') return jsonResponse({ code: -500, message: 'complete rejected' })
      if (createCompleteFailure === 'no-url') return jsonResponse({ code: 0, data: {} })
      return jsonResponse({ code: 0, data: { download_url: DOWNLOAD_URL } })
    }
    if (href === TASK_URL) {
      if (taskFailure === 'http') return new Response('nope', { status: 500 })
      if (taskFailure === 'code') return jsonResponse({ code: -600, message: 'task rejected' })
      if (taskFailure === 'no-id') return jsonResponse({ code: 0, data: {} })
      return jsonResponse({ code: 0, data: { task_id: taskId } })
    }
    if (href.startsWith(`${BCUT_API_BASE}/task/result`)) {
      const index = polls
      polls += 1
      if (malformedPoll.includes(index)) return new Response('not json', { status: 200 })
      const state = pollStates[Math.min(index, pollStates.length - 1)]
      if (state === 3) return jsonResponse({ code: 0, data: { state: 3, remark } })
      if (state === 4) {
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
      return jsonResponse({ code: 0, data: { state } })
    }
    throw new Error(`unexpected fetch: ${href}`)
  }
  return { fetchImpl, calls }
}

/** Run the pipeline against a stub and a real file. */
function runBcut(bytes, stub, overrides = {}) {
  return withAudio(bytes, (audioFile) =>
    transcribeWithBcut({
      audioFile,
      fetchImpl: stub.fetchImpl,
      pollMs: 1,
      timeoutMs: 2000,
      ...overrides,
    }),
  )
}

test('pickLowestAudio picks the smallest positive bandwidth', () => {
  const candidates = [
    { url: 'https://cdn.example.com/high.m4s', bandwidth: 212_000, id: 30280 },
    { url: 'https://cdn.example.com/mid.m4s', bandwidth: 113_000, id: 30232 },
    { url: 'https://cdn.example.com/low.m4s', bandwidth: 65_000, id: 30216 },
  ]
  assert.equal(pickLowestAudio(candidates).url, 'https://cdn.example.com/low.m4s')
})

test('pickLowestAudio handles one candidate, the bare-stream shape and an empty list', () => {
  const single = { url: 'https://cdn.example.com/only.m4s', bandwidth: 65_000, id: 30216 }
  assert.equal(pickLowestAudio([single]), single)
  assert.equal(pickLowestAudio(single), single)
  assert.equal(pickLowestAudio([]), undefined)
  assert.equal(pickLowestAudio(undefined), undefined)
  // Entries without a URL are unusable and dropped.
  assert.equal(pickLowestAudio([{ bandwidth: 1 }, single]).url, single.url)
})

test('pickLowestAudio falls back to ascending stream id when no bandwidth is usable', () => {
  const unknown = [
    { url: 'https://cdn.example.com/a.m4s', bandwidth: 0, id: 30232 },
    { url: 'https://cdn.example.com/b.m4s', id: 30216 },
    { url: 'https://cdn.example.com/c.m4s', bandwidth: 0, id: 30280 },
  ]
  assert.equal(pickLowestAudio(unknown).url, 'https://cdn.example.com/b.m4s')
  // Without any ids the list order is not a guarantee either; keep the first
  // entry rather than assuming the last one is the lowest.
  const noIds = [
    { url: 'https://cdn.example.com/first.m4s' },
    { url: 'https://cdn.example.com/second.m4s' },
  ]
  assert.equal(pickLowestAudio(noIds).url, 'https://cdn.example.com/first.m4s')
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

test('transcribeWithBcut runs the six steps in order and polls state 1 then 4', async () => {
  // Eight bytes with per_size 4 gives exactly two full parts; the second upload
  // target is an object to prove both shapes are accepted.
  const stub = protocolStub({
    perSize: 4,
    uploadUrls: [
      'https://upload.example.com/part-0?token=upload-secret',
      { upload_url: 'https://upload.example.com/part-1?token=upload-secret' },
    ],
    pollStates: [1, 4],
  })
  const result = await runBcut('abcdefgh', stub)

  assert.deepEqual(result.segments, [{ from: 0, to: 2, text: '必剪结果' }])
  assert.equal(result.provider, 'bcut')

  const kinds = stub.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)
  assert.deepEqual(kinds, [
    'POST /x/bcut/rubick-interface/resource/create',
    'PUT /part-0',
    'PUT /part-1',
    'POST /x/bcut/rubick-interface/resource/create/complete',
    'POST /x/bcut/rubick-interface/task',
    'GET /x/bcut/rubick-interface/task/result',
    'GET /x/bcut/rubick-interface/task/result',
  ])

  const create = stub.calls[0]
  assert.deepEqual(JSON.parse(create.body), {
    type: 2,
    name: 'audio.m4a',
    size: 8,
    ResourceFileType: 'm4a',
    model_id: '8',
  })
  assert.match(create.headers['User-Agent'], /^Bilibili\//)
  assert.equal(create.headers.Cookie, undefined)
  assert.equal(create.headers.Authorization, undefined)

  assert.equal(Buffer.from(stub.calls[1].body).toString(), 'abcd')
  assert.equal(Buffer.from(stub.calls[2].body).toString(), 'efgh')
  for (const upload of [stub.calls[1], stub.calls[2]]) {
    assert.equal(upload.headers['Content-Type'], 'application/octet-stream')
    assert.match(upload.headers['User-Agent'], /^Bilibili\//)
    assert.equal(upload.headers.Cookie, undefined)
  }

  const complete = stub.calls[3]
  assert.deepEqual(JSON.parse(complete.body), {
    InBossKey: 'boss-key',
    ResourceId: 'resource-id',
    Etags: '"etag-1","etag-2"',
    UploadId: 'upload-id',
    model_id: '8',
  })

  const task = stub.calls[4]
  assert.deepEqual(JSON.parse(task.body), { resource: DOWNLOAD_URL, model_id: '8' })

  const poll = stub.calls[5]
  assert.match(poll.url, /\/task\/result\?model_id=8&task_id=task-123$/)

  const serialized = JSON.stringify(result)
  assert.ok(!serialized.includes('upload-secret'))
  assert.ok(!serialized.includes('download-secret'))
  assert.ok(!serialized.includes('upload.example.com'))
})

test('transcribeWithBcut reads per_size from the response and uploads one exact part', async () => {
  // per_size equals the whole file: one part, not the hard-coded 5 MiB.
  const stub = protocolStub({ perSize: 4, uploadUrls: ['https://upload.example.com/part-0?token=upload-secret'] })
  await runBcut('abcd', stub)
  const uploads = stub.calls.filter((call) => call.method === 'PUT')
  assert.equal(uploads.length, 1)
  assert.equal(Buffer.from(uploads[0].body).toString(), 'abcd')
  const complete = stub.calls.find((call) => call.url === COMPLETE_URL)
  assert.equal(JSON.parse(complete.body).Etags, '"etag-1"')
})

test('transcribeWithBcut splits a multi-part file by the advertised per_size', async () => {
  const stub = protocolStub({
    perSize: 4,
    uploadUrls: [
      'https://upload.example.com/part-0?token=upload-secret',
      'https://upload.example.com/part-1?token=upload-secret',
      'https://upload.example.com/part-2?token=upload-secret',
    ],
    etags: ['"e0"', '"e1"', '"e2"'],
  })
  await runBcut('abcdefghij', stub)
  const bodies = stub.calls.filter((call) => call.method === 'PUT').map((call) => Buffer.from(call.body).toString())
  assert.deepEqual(bodies, ['abcd', 'efgh', 'ij'])
  const complete = stub.calls.find((call) => call.url === COMPLETE_URL)
  assert.equal(JSON.parse(complete.body).Etags, '"e0","e1","e2"')
})

test('transcribeWithBcut rejects a zero-byte audio file before any request', async () => {
  const stub = protocolStub()
  await assert.rejects(runBcut(Buffer.alloc(0), stub), /non-empty audio file/)
  assert.equal(stub.calls.length, 0)
})

test('transcribeWithBcut rejects a missing audio file', async () => {
  await assert.rejects(
    transcribeWithBcut({ audioFile: join(tmpdir(), 'definitely-missing-bcut-audio.m4a'), fetchImpl: async () => jsonResponse({}) }),
    /cannot read the local audio file/,
  )
})

test('transcribeWithBcut surfaces resource-create failures clearly', async () => {
  await assert.rejects(runBcut('abcd', protocolStub({ createFailure: 'http' })), /resource create failed \(HTTP 500\)/)
  await assert.rejects(runBcut('abcd', protocolStub({ createFailure: 'code' })), /resource create failed: bad audio/)
  await assert.rejects(runBcut('abcd', protocolStub({ createFailure: 'incomplete' })), /incomplete upload resource/)
  await assert.rejects(
    runBcut('abcde', protocolStub({ perSize: 4, uploadUrls: ['https://upload.example.com/part-0?token=upload-secret'] })),
    /1 upload target\(s\) for 2 part\(s\)/,
  )
})

test('transcribeWithBcut locates a failed part without leaking its URL', async () => {
  const stub = protocolStub({ perSize: 4, uploadFailureAt: 1 })
  await assert.rejects(runBcut('abcdefgh', stub), (error) => {
    assert.match(error.message, /part 2\/2, HTTP 500/)
    assert.ok(!error.message.includes('upload-secret'))
    assert.ok(!error.message.includes('upload.example.com'))
    return true
  })
})

test('transcribeWithBcut rejects an upload response without an ETag', async () => {
  const stub = protocolStub({ perSize: 4, missingEtagAt: 0 })
  await assert.rejects(runBcut('abcd', stub), (error) => {
    assert.match(error.message, /part 1\/1, the service returned no ETag/)
    assert.ok(!error.message.includes('upload.example.com'))
    return true
  })
})

test('transcribeWithBcut surfaces resource-complete failures clearly', async () => {
  await assert.rejects(runBcut('abcd', protocolStub({ completeFailure: 'http' })), /resource complete failed \(HTTP 500\)/)
  await assert.rejects(runBcut('abcd', protocolStub({ completeFailure: 'code' })), /resource complete failed: complete rejected/)
  await assert.rejects(runBcut('abcd', protocolStub({ createCompleteFailure: 'no-url' })), /returned no download URL/)
})

test('transcribeWithBcut surfaces task-create failures clearly', async () => {
  await assert.rejects(runBcut('abcd', protocolStub({ taskFailure: 'http' })), /task create failed \(HTTP 500\)/)
  await assert.rejects(runBcut('abcd', protocolStub({ taskFailure: 'code' })), /task create failed: task rejected/)
  await assert.rejects(runBcut('abcd', protocolStub({ taskFailure: 'no-id' })), /returned no task id/)
})

test('transcribeWithBcut reports a state 3 rejection with an empty remark as a bare fact', async () => {
  const stub = protocolStub({ pollStates: [3], remark: '' })
  await assert.rejects(runBcut('abcd', stub), (error) => {
    assert.equal(error.message, 'Bcut ASR rejected the audio (state 3)')
    assert.doesNotMatch(error.message, /10 minutes|another provider|roughly/i)
    assert.ok(!error.message.includes('download-secret'))
    return true
  })
})

test('transcribeWithBcut appends a non-empty state 3 remark', async () => {
  await assert.rejects(runBcut('abcd', protocolStub({ pollStates: [3], remark: '音频过长' })), (error) => {
    assert.match(error.message, /^Bcut ASR rejected the audio \(state 3\): 音频过长$/)
    return true
  })
})

test('transcribeWithBcut retries a transient poll failure until state 4', async () => {
  const stub = protocolStub({ pollStates: [1, 4], malformedPoll: [1] })
  const result = await runBcut('abcd', stub)
  assert.equal(result.segments.length, 1)
  assert.equal(stub.calls.filter((call) => call.url.includes('/task/result')).length, 3)
})

test('transcribeWithBcut times out clearly while the task stays in state 1', async () => {
  const stub = protocolStub({ pollStates: [1] })
  await assert.rejects(runBcut('abcd', stub, { timeoutMs: 40, pollMs: 5 }), /timed out after 40 ms/)
})
