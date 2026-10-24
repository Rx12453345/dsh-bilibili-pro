/**
 * Offline tests for the video stream selector and the bounded downloader.
 *
 * No network, no cookie, no ffmpeg: the download cases use `data:` URLs, which
 * Node's fetch accepts like any other scheme.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { selectVideoStream } from '../../lib/api.js'
import { BilibiliError } from '../../lib/http.js'
import {
  VIDEO_CACHE_TTL_MS,
  downloadStream,
  ensureVideo,
  findCachedVideo,
  guessStreamExt,
  partFileTag,
  videoFileName,
} from '../../lib/video.js'

/** Dimensions per quality id, mirroring Bilibili's usual ladder. */
const DIMENSIONS = {
  16: { width: 360, height: 360 },
  32: { width: 640, height: 360 },
  64: { width: 1280, height: 720 },
  80: { width: 1920, height: 1080 },
}

/** Build a DASH playurl payload for the given quality ids. */
function dashPayload(ids) {
  return {
    code: 0,
    data: {
      dash: {
        video: ids.map((id) => ({
          id,
          baseUrl: `https://upos.example/${id}.m4s`,
          codecs: `avc1.6400${id}`,
          bandwidth: id * 1000,
          ...(DIMENSIONS[id] ?? { width: id * 20, height: id * 11 }),
        })),
      },
    },
  }
}

/** A small `data:` URL with a known body, used by the download tests. */
const DATA_URL = `data:application/octet-stream;base64,${Buffer.from('hello video stream').toString('base64')}`

/** Create a throwaway directory and clean it up when the test ends. */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-video-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('selectVideoStream picks the exact requested DASH quality', () => {
  const chosen = selectVideoStream(dashPayload([32, 64, 80]), 64)
  assert.equal(chosen.quality, 64)
  assert.equal(chosen.url, 'https://upos.example/64.m4s')
  assert.equal(chosen.codec, 'avc1.640064')
  assert.equal(chosen.width, 1280)
  assert.equal(chosen.height, 720)
  assert.equal(chosen.candidates.length, 3)
})

test('selectVideoStream drops to the closest lower quality', () => {
  const chosen = selectVideoStream(dashPayload([16, 32, 80]), 64)
  assert.equal(chosen.quality, 32)
  assert.equal(chosen.url, 'https://upos.example/32.m4s')
})

test('selectVideoStream falls back to the lowest stream when every quality is higher', () => {
  const chosen = selectVideoStream(dashPayload([80]), 64)
  assert.equal(chosen.quality, 80)
  assert.equal(chosen.url, 'https://upos.example/80.m4s')
})

test('selectVideoStream falls back to a progressive durl stream', () => {
  const chosen = selectVideoStream(
    { code: 0, data: { quality: 32, durl: [{ url: 'https://upos.example/durl.flv', length: 1000 }] } },
    64,
  )
  assert.equal(chosen.codec, 'durl')
  assert.equal(chosen.quality, 32)
  assert.equal(chosen.url, 'https://upos.example/durl.flv')
  assert.equal(chosen.candidates.length, 1)
  // No quality in the payload: report 0 rather than inventing one.
  assert.equal(selectVideoStream({ code: 0, data: { durl: [{ url: 'https://upos.example/a.flv' }] } }).quality, 0)
})

test('selectVideoStream accepts base_url aliases', () => {
  const chosen = selectVideoStream(
    {
      code: 0,
      data: {
        dash: {
          video: [{ id: 32, base_url: 'https://upos.example/alias.m4s', codecs: 'avc1.640020', bandwidth: 700 }],
        },
      },
    },
    64,
  )
  assert.equal(chosen.url, 'https://upos.example/alias.m4s')
  assert.equal(chosen.quality, 32)
  assert.equal(chosen.bandwidth, 700)
})

test('selectVideoStream rejects a payload with no playable stream', () => {
  assert.throws(
    () => selectVideoStream({ code: -404, data: { dash: { video: [] }, durl: [] } }, 64),
    (error) => {
      assert.ok(error instanceof BilibiliError)
      assert.equal(error.code, -404)
      assert.match(error.detail, /region-locked, paid, or unavailable/)
      return true
    },
  )
})

test('guessStreamExt maps hls, mp4, fmp4 and flv links', () => {
  assert.equal(guessStreamExt('https://upos.example/x.m3u8?token=1'), '.m3u8')
  assert.equal(guessStreamExt('https://upos.example/x.mp4?token=1'), '.mp4')
  assert.equal(guessStreamExt('https://upos.example/x.m4s'), '.mp4')
  assert.equal(guessStreamExt('https://upos.example/x.flv?token=1'), '.flv')
  assert.equal(guessStreamExt('https://upos.example/stream'), '.flv')
})

test('partFileTag and videoFileName keep single-page names stable', () => {
  assert.equal(partFileTag(1, 1), '')
  assert.equal(partFileTag(3, 4), 'p4')
  assert.equal(videoFileName('', '.mp4'), 'video.mp4')
  assert.equal(videoFileName('p4', '.mp4'), 'video_p4.mp4')
  assert.equal(videoFileName('p4', ''), 'video_p4')
})

test('findCachedVideo reuses a fresh file', async (t) => {
  const dir = tempDir(t)
  const target = join(dir, 'video.mp4')
  writeFileSync(target, 'fresh video')
  assert.equal(await findCachedVideo(dir, ''), target)
  assert.equal(existsSync(target), true)
  // A single-page lookup must not adopt another part's file.
  assert.equal(await findCachedVideo(dir, 'p4'), null)
})

test('findCachedVideo removes a file older than the cache TTL', async (t) => {
  const dir = tempDir(t)
  const target = join(dir, 'video.mp4')
  writeFileSync(target, 'stale video')
  const old = new Date(Date.now() - 25 * 3600 * 1000)
  utimesSync(target, old, old)
  assert.equal(VIDEO_CACHE_TTL_MS, 24 * 3600 * 1000)
  assert.equal(await findCachedVideo(dir, ''), null)
  assert.equal(existsSync(target), false)
})

test('downloadStream writes atomically from a data URL', async (t) => {
  const dir = tempDir(t)
  const dest = join(dir, 'video.mp4')
  const result = await downloadStream({ url: DATA_URL, dest })
  assert.equal(result.path, dest)
  assert.equal(result.bytes, Buffer.byteLength('hello video stream'))
  assert.equal(readFileSync(dest, 'utf8'), 'hello video stream')
  assert.equal(existsSync(`${dest}.part`), false)
})

test('downloadStream removes the .part file when the cap is exceeded', async (t) => {
  const dir = tempDir(t)
  const dest = join(dir, 'video.mp4')
  await assert.rejects(downloadStream({ url: DATA_URL, dest, maxBytes: 4 }), /exceeded/)
  assert.equal(existsSync(dest), false)
  assert.equal(existsSync(`${dest}.part`), false)
})

test('downloadStream aborts on cancellation and removes the partial file', async (t) => {
  const dir = tempDir(t)
  const dest = join(dir, 'video.mp4')
  // A crashed earlier run may have left this behind; cancellation must clean it.
  writeFileSync(`${dest}.part`, 'stale partial')
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(downloadStream({ url: DATA_URL, dest, signal: controller.signal }))
  assert.equal(existsSync(dest), false)
  assert.equal(existsSync(`${dest}.part`), false)
})

test('findCachedVideo ignores a leftover .part download', async (t) => {
  const dir = tempDir(t)
  const partial = join(dir, 'video.mp4.part')
  writeFileSync(partial, 'truncated download')
  assert.equal(await findCachedVideo(dir, ''), null)
  // ensureVideo must download a complete file instead of reusing the residue.
  const result = await ensureVideo({ outDir: dir, url: DATA_URL, pageTag: '' })
  assert.equal(result.reused, false)
  assert.equal(result.path, join(dir, 'video.flv'))
  assert.equal(readFileSync(result.path, 'utf8'), 'hello video stream')
  assert.notEqual(result.path, partial)
})

test('downloadStream rejects a declared content-length above the cap', async (t) => {
  const dir = tempDir(t)
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(8 * 1024 * 1024),
    })
    // Flush the headers; the client must reject on the declaration alone.
    response.write(Buffer.alloc(1024))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  })
  const { port } = server.address()
  const dest = join(dir, 'video.mp4')
  await assert.rejects(
    downloadStream({ url: `http://127.0.0.1:${port}/video.mp4`, dest, maxBytes: 1024 * 1024 }),
    /too large/,
  )
  assert.equal(existsSync(dest), false)
  assert.equal(existsSync(`${dest}.part`), false)
})

test('downloadStream cancels the response when the in-flight cap trips', async (t) => {
  const dir = tempDir(t)
  let markClosed
  const closed = new Promise((resolve) => {
    markClosed = resolve
  })
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' })
    const ticker = setInterval(() => {
      if (response.destroyed || response.writableEnded) return
      response.write(Buffer.alloc(64 * 1024))
    }, 5)
    response.on('error', () => {})
    response.on('close', () => {
      clearInterval(ticker)
      markClosed()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  })
  const { port } = server.address()
  const dest = join(dir, 'video.mp4')
  await assert.rejects(
    downloadStream({ url: `http://127.0.0.1:${port}/video.mp4`, dest, maxBytes: 32 * 1024 }),
    /exceeded/,
  )
  let timer
  try {
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('response was not cancelled')), 3000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
  assert.equal(existsSync(`${dest}.part`), false)
})

test('ensureVideo reuses a fresh cache entry without downloading', async (t) => {
  const dir = tempDir(t)
  const target = join(dir, 'video.mp4')
  writeFileSync(target, 'cached-video')
  const result = await ensureVideo({ outDir: dir, url: 'https://upos.example/ignored.m4s', pageTag: '' })
  assert.equal(result.reused, true)
  assert.equal(result.path, target)
  assert.equal(result.bytes, Buffer.byteLength('cached-video'))
})

test('ensureVideo downloads into a page-tagged cache name', async (t) => {
  const dir = tempDir(t)
  const result = await ensureVideo({ outDir: dir, url: DATA_URL, pageTag: partFileTag(3, 4) })
  assert.equal(result.reused, false)
  assert.equal(result.path, join(dir, 'video_p4.flv'))
  assert.equal(readFileSync(result.path, 'utf8'), 'hello video stream')
})
