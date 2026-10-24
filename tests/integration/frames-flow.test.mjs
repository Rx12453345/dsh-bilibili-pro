/**
 * Frame-capture integration tests: real ffmpeg, generated fixture, no network.
 *
 * A six-second two-color video (red 3s + blue 3s) is produced locally with
 * ffmpeg. The full tool test stubs every HTTP call — metadata, WBI keys,
 * playurl, and the CDN download — so only the fixture bytes are ever decoded.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { captureFrames, detectScenePeaks } from '../../lib/frames.js'
import { writeTranscriptBundle } from '../../lib/store.js'
import { createBilibiliTools } from '../../lib/tools.js'
import { packParts } from '../../lib/transcript.js'

const BVID = 'BV1xx411c7mD'
const FIXTURE_SECONDS = 6

const ffmpegProbe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' })
const skip = ffmpegProbe.status === 0 ? false : 'ffmpeg is not available; skipping frame-capture integration tests'

/** Create a throwaway directory and clean it up when the test ends. */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-frames-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * Render the red-to-blue fixture with ffmpeg.
 * @param dir - directory to write into.
 * @returns the fixture path.
 */
function makeFixture(dir) {
  const target = join(dir, 'fixture.mp4')
  const result = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=320x240:d=3',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=320x240:d=3',
      '-filter_complex',
      '[0:v][1:v]concat=n=2:v=1:a=0',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-t',
      String(FIXTURE_SECONDS),
      target,
    ],
    { stdio: 'ignore', timeout: 120_000 },
  )
  assert.equal(result.status, 0, 'ffmpeg could not render the two-color fixture')
  assert.ok(existsSync(target), 'the fixture was not written')
  return target
}

/** JSON response helper. */
function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

test('detectScenePeaks finds the cut near 3s and captureFrames writes a JPEG', { skip }, async (t) => {
  const dir = tempDir(t)
  const fixture = makeFixture(dir)
  const outDir = join(dir, 'frames')

  const peaks = await detectScenePeaks({
    videoPath: fixture,
    outDir,
    threshold: 0.4,
    ffmpegPath: 'ffmpeg',
    timeoutMs: 60_000,
  })
  assert.ok(peaks.length > 0, 'the red-to-blue cut must produce at least one scene peak')
  const cut = peaks.find((peak) => Math.abs(peak.time - 3) <= 0.5)
  assert.ok(cut, `expected a scene peak near 3s, got ${JSON.stringify(peaks)}`)
  assert.equal(cut.reason, 'scene change')

  const captured = await captureFrames({
    videoPath: fixture,
    timestamps: [{ time: cut.time, requested_time: cut.time, reason: 'scene change', text: '' }],
    outDir,
    ffmpegPath: 'ffmpeg',
    timeoutMs: 60_000,
  })
  assert.equal(captured.length, 1)
  assert.ok(captured[0].path, `capture failed: ${captured[0].error}`)
  assert.ok(isAbsolute(captured[0].path))
  assert.ok(existsSync(captured[0].path))
  const jpeg = readFileSync(captured[0].path)
  assert.ok(jpeg.length > 100, 'the JPEG looks empty')
  assert.equal(jpeg[0], 0xff, 'a JPEG starts with SOI 0xFF')
  assert.equal(jpeg[1], 0xd8, 'a JPEG starts with SOI 0xD8')
})

test('bilibili_frames downloads once, captures requested moments locally and drops the video', { skip }, async (t) => {
  const dir = tempDir(t)
  const fixture = readFileSync(makeFixture(dir))
  const cookieFile = join(dir, 'cookies.json')
  writeFileSync(cookieFile, JSON.stringify({ cookies: { buvid3: 'dummy-buvid3' }, source: 'test' }), 'utf8')
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const href = String(url)
    if (href.startsWith('https://api.bilibili.com/x/web-interface/view')) {
      return jsonResponse({
        code: 0,
        data: {
          bvid: BVID,
          aid: 42,
          cid: 123,
          title: '抓帧测试视频',
          desc: 'fixture',
          pic: '',
          duration: FIXTURE_SECONDS,
          pubdate: 1_700_000_000,
          owner: { mid: 1, name: 'UP' },
          stat: {},
          pages: [],
        },
      })
    }
    if (href.startsWith('https://api.bilibili.com/x/web-interface/nav')) {
      return jsonResponse({
        code: 0,
        data: {
          isLogin: true,
          wbi_img: {
            img_url: 'https://i0.hdslb.com/bfs/wbi/0123456789abcdef0123456789abcdef.png',
            sub_url: 'https://i0.hdslb.com/bfs/wbi/fedcba9876543210fedcba9876543210.png',
          },
        },
      })
    }
    if (href.startsWith('https://api.bilibili.com/x/player/wbi/playurl')) {
      return jsonResponse({
        code: 0,
        data: {
          dash: {
            video: [
              {
                id: 64,
                baseUrl: 'https://cdn.example/video.m4s',
                codecs: 'avc1.640020',
                bandwidth: 1_000_000,
                width: 320,
                height: 240,
              },
            ],
          },
        },
      })
    }
    if (href.startsWith('https://cdn.example/')) {
      return new Response(fixture, {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': String(fixture.length) },
      })
    }
    throw new Error(`unexpected fetch: ${href}`)
  }

  try {
    const tools = createBilibiliTools({
      resolvePath: async (target) => (isAbsolute(target) ? target : resolve(dir, target)),
      defaults: {
        sessdata: 'dummy-sessdata',
        cookieFile,
        outDir: 'out',
        timeoutMs: 5000,
        maxFrames: 6,
        quality: 64,
        downloadVideo: true,
        keepVideo: false,
        maxVideoMinutes: 60,
        maxDownloadMb: 1500,
        detectScenes: true,
        sceneThreshold: 0.4,
        sharpFrames: true,
        sceneAlignSeconds: 4,
        frameTimeoutMs: 20_000,
        videoCacheHours: 24,
      },
    })
    const tool = tools.find((entry) => entry.name === 'bilibili_frames')
    assert.ok(tool, 'bilibili_frames must be registered')
    const exec = { signal: undefined, agent: { session: { header: { cwd: dir } } } }
    const result = await tool.execute({ url: BVID, timestamps: ['0:01', 4] }, exec)

    assert.equal(result.mode, 'local')
    assert.equal(result.strategy, 'requested timestamps')
    assert.equal(result.frames.length, 2)
    assert.deepEqual(
      result.frames.map((frame) => frame.requested_time),
      [1, 4],
      'requested_time must survive scene and sharpness refinement',
    )
    for (const frame of result.frames) {
      assert.equal(frame.has_image, true, `frame at ${frame.time} failed: ${frame.error}`)
      assert.ok(isAbsolute(frame.path), 'frame paths must be absolute')
      assert.ok(existsSync(frame.path), `frame file is missing: ${frame.path}`)
      assert.ok(readFileSync(frame.path).length > 100)
    }
    // Refinement must not collapse two deliberately different requests onto one
    // cut: the frames have to stay distinct moments (and distinct images).
    const frameTimes = result.frames.map((frame) => frame.time)
    assert.equal(new Set(frameTimes).size, 2, `expected two distinct frame times, got ${JSON.stringify(frameTimes)}`)
    const hashes = result.frames.map((frame) =>
      createHash('sha256').update(readFileSync(frame.path)).digest('hex'),
    )
    assert.equal(new Set(hashes).size, 2, 'the two requested frames must not be byte-identical images')

    assert.equal(existsSync(join(dir, 'out', BVID, 'video.mp4')), false, 'keep_video:false must remove the video')
    assert.equal(result.page.page, 1)
    assert.equal(result.page.cid, 123)
    assert.equal(result.video.bvid, BVID)
    assert.ok(result.text.includes('关键帧'))
    assert.ok(result.text.includes('frame_001.jpg'))

    // Supplied-but-unusable timestamps must fail rather than silently becoming
    // automatic frames.
    await assert.rejects(
      tool.execute({ url: BVID, timestamps: [45, 60] }, exec),
      /none of the supplied timestamps is usable/,
    )

    // Automatic plans must carry the nearest subtitle line too.
    const segments = [{ from: 2, to: 5, text: '自动字幕' }]
    writeTranscriptBundle({
      outDir: join(dir, 'out'),
      bvid: BVID,
      page: { page: 1, cid: 123, part: 'P1', duration: FIXTURE_SECONDS },
      video: {
        bvid: BVID,
        title: '抓帧测试视频',
        owner: { mid: 1, name: 'UP' },
        duration: FIXTURE_SECONDS,
        url: `https://www.bilibili.com/video/${BVID}`,
      },
      track: { lan: 'ai-zh', lan_doc: '中文（AI生成）', ai: true, route: 'test' },
      validation: null,
      source: 'subtitle',
      segments,
      parts: packParts(segments, { maxChars: 6000, maxSeconds: 600 }),
      index: [],
      gaps: [],
      packing: { maxChars: 6000, maxSeconds: 600 },
    })
    const automatic = await tool.execute({ url: BVID }, exec)
    assert.equal(automatic.mode, 'local')
    assert.ok(automatic.frames.length >= 1, 'a six-second video must still get an automatic frame')
    assert.equal(
      automatic.frames[0].subtitle_text,
      '自动字幕',
      'automatic frames must attach the nearest subtitle line',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('bilibili_frames adds vision fields only when enabled and keeps frames when vision fails', { skip }, async (t) => {
  const dir = tempDir(t)
  const fixture = readFileSync(makeFixture(dir))
  const cookieFile = join(dir, 'cookies.json')
  writeFileSync(cookieFile, JSON.stringify({ cookies: { buvid3: 'dummy-buvid3' }, source: 'test' }), 'utf8')
  const visionBase = 'http://vision.test/v1'
  const visionRequests = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const href = String(url)
    if (href.startsWith('https://api.bilibili.com/x/web-interface/view')) {
      return jsonResponse({
        code: 0,
        data: {
          bvid: BVID,
          aid: 42,
          cid: 123,
          title: '抓帧视觉测试',
          desc: 'fixture',
          pic: '',
          duration: FIXTURE_SECONDS,
          pubdate: 1_700_000_000,
          owner: { mid: 1, name: 'UP' },
          stat: {},
          pages: [],
        },
      })
    }
    if (href.startsWith('https://api.bilibili.com/x/web-interface/nav')) {
      return jsonResponse({
        code: 0,
        data: {
          isLogin: true,
          wbi_img: {
            img_url: 'https://i0.hdslb.com/bfs/wbi/0123456789abcdef0123456789abcdef.png',
            sub_url: 'https://i0.hdslb.com/bfs/wbi/fedcba9876543210fedcba9876543210.png',
          },
        },
      })
    }
    if (href.startsWith('https://api.bilibili.com/x/player/wbi/playurl')) {
      return jsonResponse({
        code: 0,
        data: {
          dash: {
            video: [
              {
                id: 64,
                baseUrl: 'https://cdn.example/video.m4s',
                codecs: 'avc1.640020',
                bandwidth: 1_000_000,
                width: 320,
                height: 240,
              },
            ],
          },
        },
      })
    }
    if (href.startsWith('https://cdn.example/')) {
      return new Response(fixture, {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': String(fixture.length) },
      })
    }
    if (href.startsWith(visionBase)) {
      visionRequests.push({ href, headers: init.headers, body: JSON.parse(init.body) })
      return jsonResponse({
        choices: [{ message: { content: '画面是红色测试图，展示了测试内容。\n配图建议：适合' } }],
      })
    }
    throw new Error(`unexpected fetch: ${href}`)
  }

  try {
    const baseDefaults = {
      sessdata: 'dummy-sessdata',
      cookieFile,
      outDir: 'out',
      timeoutMs: 5000,
      maxFrames: 6,
      quality: 64,
      downloadVideo: true,
      keepVideo: false,
      maxVideoMinutes: 60,
      maxDownloadMb: 1500,
      detectScenes: true,
      sceneThreshold: 0.4,
      sharpFrames: true,
      sceneAlignSeconds: 4,
      frameTimeoutMs: 20_000,
      videoCacheHours: 24,
      visionProvider: 'none',
      visionBaseUrl: '',
      visionModel: 'medium',
      visionApiKey: '',
      visionPrompt: '',
      visionPromptByModel: {},
      visionMaxFrames: 6,
      visionTimeoutMs: 5000,
    }
    const makeTools = (overrides = {}) =>
      createBilibiliTools({
        resolvePath: async (target) => (isAbsolute(target) ? target : resolve(dir, target)),
        defaults: { ...baseDefaults, ...overrides },
      })
    const tool = makeTools().find((entry) => entry.name === 'bilibili_frames')
    assert.ok(tool, 'bilibili_frames must be registered')
    const exec = { signal: undefined, agent: { session: { header: { cwd: dir } } } }

    // Disabled by default: the Phase 2 result shape must not grow empty fields.
    const plain = await tool.execute({ url: BVID, timestamps: ['0:01', 4] }, exec)
    assert.equal(plain.frames.length, 2)
    for (const frame of plain.frames) {
      assert.equal(Object.hasOwn(frame, 'description'), false, 'disabled vision must not add description')
      assert.equal(Object.hasOwn(frame, 'vision_error'), false, 'disabled vision must not add vision_error')
      assert.equal(Object.hasOwn(frame, 'citation_hint'), false, 'disabled vision must not add citation_hint')
    }
    assert.equal(visionRequests.length, 0)
    assert.ok(!plain.text.includes('画面描述'))

    // Enabled per call: descriptions, hints and text are attached to image frames.
    const described = await tool.execute(
      {
        url: BVID,
        timestamps: ['0:01', 4],
        vision: 'openai-compatible',
        vision_base_url: visionBase,
        vision_model: 'medium',
        vision_api_key: 'test-key',
        vision_max_frames: 2,
      },
      exec,
    )
    assert.equal(described.frames.length, 2)
    assert.equal(visionRequests.length, 2)
    for (const frame of described.frames) {
      assert.equal(frame.description, '画面是红色测试图，展示了测试内容。\n配图建议：适合')
      assert.equal(frame.vision_error, null)
      assert.equal(frame.citation_hint, 'suitable')
    }
    assert.ok(described.text.includes('画面描述：画面是红色测试图，展示了测试内容。'))
    assert.ok(described.text.includes('配图建议：适合'))
    assert.equal(described.text.split('画面描述：').length - 1, 2, 'both described frames render a description line')
    assert.ok(!described.text.includes('\n配图建议：'), 'the raw citation tail must not leak into the bullet')
    assert.ok(!JSON.stringify(described).includes('test-key'), 'the API key must never appear in the result')
    assert.equal(visionRequests[0].body.model, 'qwen3-vl:4b')

    // A whole vision call can fail (here: no base URL) without losing the capture.
    const failed = await tool.execute(
      { url: BVID, timestamps: ['0:01', 4], vision: 'openai-compatible' },
      exec,
    )
    assert.equal(failed.frames.length, 2)
    assert.equal(visionRequests.length, 2, 'a missing endpoint must not be posted to')
    for (const frame of failed.frames) {
      assert.match(frame.vision_error, /vision endpoint not configured/)
      assert.equal(frame.description, '')
      assert.equal(frame.citation_hint, '')
      assert.ok(existsSync(frame.path), 'captured frames must survive a vision failure')
    }
    assert.match(failed.note, /vision descriptions failed/)
    assert.ok(failed.text.includes('视觉失败'))

    // A zero config cap is clamped to one described frame, not six uploads
    // whose answers are then discarded by the merge.
    visionRequests.length = 0
    const cappedTool = makeTools({
      visionProvider: 'openai-compatible',
      visionBaseUrl: visionBase,
      visionMaxFrames: 0,
    }).find((entry) => entry.name === 'bilibili_frames')
    const capped = await cappedTool.execute({ url: BVID, timestamps: ['0:01', 4] }, exec)
    assert.equal(capped.frames.length, 2)
    assert.equal(visionRequests.length, 1, 'visionMaxFrames:0 must clamp to one request')
    assert.equal(capped.frames[0].description, '画面是红色测试图，展示了测试内容。\n配图建议：适合')
    assert.equal(capped.frames[0].citation_hint, 'suitable')
    assert.equal(
      Object.hasOwn(capped.frames[1], 'description'),
      false,
      'frames beyond the vision cap keep the Phase 2 shape',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
