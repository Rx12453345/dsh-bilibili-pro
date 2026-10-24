/**
 * Vision integration tests: a stubbed OpenAI-compatible endpoint, no network.
 *
 * The frames are tiny JPEG markers written to a temp directory; the vision
 * endpoint never decodes them, it only receives the base64 payload. Every test
 * restores `globalThis.fetch` in `finally` so the rest of the suite stays
 * offline.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeFramesWithVision } from '../../lib/vision.js'

const VISION_BASE = 'http://vision.test/v1'
const DATA_PREFIX = 'data:image/jpeg;base64,'
const API_KEY = 'test-vision-key'
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9])

/** Create a throwaway directory and clean it up when the test ends. */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vision-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Write one tiny JPEG-ish frame and return its path. */
function writeFrame(dir, name) {
  const path = join(dir, name)
  writeFileSync(path, JPEG)
  return path
}

/** A successful chat/completions response carrying one assistant message. */
function chatResponse(text) {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** Install a fetch stub, returning the recorded calls and a restore function. */
function installFetch(handler) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init, calls.length)
  }
  return {
    calls,
    restore() {
      globalThis.fetch = original
    },
  }
}

test('describeFramesWithVision describes frames and parses Chinese citation hints', async (t) => {
  const dir = tempDir(t)
  const first = writeFrame(dir, 'frame_001.jpg')
  const second = writeFrame(dir, 'frame_002.jpg')
  const third = writeFrame(dir, 'frame_003.jpg')
  const frames = [
    { time: 10, has_image: true, path: first },
    { time: 20, has_image: true, path: second },
    { time: 30, has_image: false, path: null },
    { time: 40, has_image: true, path: third },
  ]
  const stub = installFetch((_url, _init, count) => {
    if (count === 1) return chatResponse('画面是一张幻灯片，展示了架构图。配图建议：适合')
    if (count === 2) return chatResponse('纯口播画面，无补充信息。配图建议：不适合')
    return chatResponse('talking head, no visual info. citation: unsuitable')
  })
  try {
    const results = await describeFramesWithVision(frames, {
      provider: 'openai-compatible',
      baseUrl: VISION_BASE,
      model: 'medium',
      maxFrames: 6,
    })
    assert.equal(results.length, 3, 'non-image frames must be skipped')
    assert.deepEqual(results[0], {
      time: 10,
      description: '画面是一张幻灯片，展示了架构图。配图建议：适合',
      vision_error: null,
      citation_hint: 'suitable',
    })
    assert.deepEqual(results[1], {
      time: 20,
      description: '纯口播画面，无补充信息。配图建议：不适合',
      vision_error: null,
      citation_hint: 'unsuitable',
    })
    assert.deepEqual(results[2], {
      time: 40,
      description: 'talking head, no visual info. citation: unsuitable',
      vision_error: null,
      citation_hint: 'unsuitable',
    })
    assert.equal(stub.calls.length, 3)
    for (const call of stub.calls) {
      assert.equal(call.url, `${VISION_BASE}/chat/completions`)
      assert.equal(call.init.method, 'POST')
      assert.equal(call.init.headers.Authorization, undefined, 'no key configured means no auth header')
      const body = JSON.parse(call.init.body)
      assert.equal(body.model, 'qwen3-vl:4b')
      assert.equal(
        body.messages[0].content[1].image_url.url,
        `${DATA_PREFIX}${JPEG.toString('base64')}`,
        'the payload must be the frame bytes as a JPEG data URL',
      )
    }
  } finally {
    stub.restore()
  }
})

test('a zero maxFrames clamps to one request instead of posting and discarding', async (t) => {
  const dir = tempDir(t)
  const frames = [1, 2].map((index) => ({
    time: index,
    has_image: true,
    path: writeFrame(dir, `zero_${index}.jpg`),
  }))
  const stub = installFetch(() => chatResponse('只描述一帧。'))
  try {
    const results = await describeFramesWithVision(frames, {
      provider: 'openai-compatible',
      baseUrl: VISION_BASE,
      maxFrames: 0,
    })
    assert.equal(stub.calls.length, 1)
    assert.equal(results.length, 1)
    assert.equal(results[0].description, '只描述一帧。')
  } finally {
    stub.restore()
  }
})

test('a 500 on one frame is isolated and the next frame still gets a description', async (t) => {
  const dir = tempDir(t)
  const frames = [
    { time: 5, has_image: true, path: writeFrame(dir, 'a.jpg') },
    { time: 15, has_image: true, path: writeFrame(dir, 'b.jpg') },
  ]
  const stub = installFetch((_url, _init, count) =>
    count === 1 ? new Response('upstream error', { status: 500 }) : chatResponse('第二帧内容。'),
  )
  try {
    const results = await describeFramesWithVision(frames, {
      provider: 'openai-compatible',
      baseUrl: VISION_BASE,
      model: 'low',
    })
    assert.equal(results.length, 2)
    assert.equal(results[0].description, '')
    assert.match(results[0].vision_error, /vision HTTP 500/)
    assert.equal(results[0].citation_hint, '')
    assert.equal(results[1].description, '第二帧内容。')
    assert.equal(results[1].vision_error, null)
    assert.equal(results[1].citation_hint, '')
  } finally {
    stub.restore()
  }
})

test('an unreadable frame is isolated and later frames are still described', async (t) => {
  const dir = tempDir(t)
  const frames = [
    { time: 1, has_image: true, path: join(dir, 'missing.jpg') },
    { time: 2, has_image: true, path: writeFrame(dir, 'present.jpg') },
  ]
  const stub = installFetch(() => chatResponse('可读帧。'))
  try {
    const results = await describeFramesWithVision(frames, {
      provider: 'openai-compatible',
      baseUrl: VISION_BASE,
    })
    assert.equal(results.length, 2)
    assert.match(results[0].vision_error, /frame file unreadable/)
    assert.equal(results[0].description, '')
    assert.equal(results[1].description, '可读帧。')
    assert.equal(stub.calls.length, 1, 'the unreadable frame must not be posted')
  } finally {
    stub.restore()
  }
})

test('visionMaxFrames caps requests and the key only travels in the auth header', async (t) => {
  const dir = tempDir(t)
  const frames = [1, 2, 3].map((index) => ({
    time: index * 10,
    has_image: true,
    path: writeFrame(dir, `frame_${index}.jpg`),
  }))
  const stub = installFetch(() => chatResponse('画面内容。配图建议：适合'))
  try {
    const results = await describeFramesWithVision(frames, {
      provider: 'openai-compatible',
      baseUrl: VISION_BASE,
      model: 'high',
      maxFrames: 1,
      apiKey: API_KEY,
    })
    assert.equal(results.length, 1)
    assert.equal(stub.calls.length, 1, 'maxFrames must cap the number of requests')
    assert.equal(stub.calls[0].init.headers.Authorization, ['Bearer', API_KEY].join(' '))
    assert.ok(!stub.calls[0].init.body.includes(API_KEY), 'the key must never be in the request body')
    assert.ok(!JSON.stringify(results).includes(API_KEY), 'the key must never be in the result')
    assert.equal(JSON.parse(stub.calls[0].init.body).model, 'qwen3-vl:8b')
  } finally {
    stub.restore()
  }

  const withoutKey = installFetch(() => chatResponse('无 key。'))
  try {
    await describeFramesWithVision(frames.slice(0, 1), {
      provider: 'openai-compatible',
      baseUrl: VISION_BASE,
    })
    assert.equal(withoutKey.calls[0].init.headers.Authorization, undefined)
  } finally {
    withoutKey.restore()
  }
})

test('a missing base URL is a clear configuration error', async () => {
  await assert.rejects(
    describeFramesWithVision([{ time: 1, has_image: true, path: '/nonexistent.jpg' }], {
      provider: 'openai-compatible',
    }),
    /vision endpoint not configured/,
  )
})

test('a caller abort rethrows instead of becoming a per-frame vision_error', async (t) => {
  const dir = tempDir(t)
  const controller = new AbortController()
  controller.abort()
  const stub = installFetch(() => chatResponse('should not be called'))
  try {
    await assert.rejects(
      describeFramesWithVision(
        [{ time: 1, has_image: true, path: writeFrame(dir, 'abort.jpg') }],
        { provider: 'ollama' },
        controller.signal,
      ),
      /aborted/,
    )
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
  }
})
