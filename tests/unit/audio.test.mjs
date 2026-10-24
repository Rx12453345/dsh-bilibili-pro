/**
 * Offline audio fallback test: downloadStream fetches a tiny WAV, ffmpeg
 * converts it locally, and the temporary `.source` file is always removed.
 *
 * No network and no Bilibili: `globalThis.fetch` is stubbed. The test skips
 * cleanly when ffmpeg is not installed.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCommand } from '../../lib/asr.js'
import { downloadAudio, resolveFfmpeg } from '../../lib/audio.js'

/**
 * Build a tiny valid 16-bit mono WAV, so the test needs no binary fixture.
 * @param options - sample rate and duration.
 * @returns the WAV bytes.
 */
function tinyWav({ sampleRate = 8000, seconds = 0.2 } = {}) {
  const sampleCount = Math.max(1, Math.round(sampleRate * seconds))
  const dataBytes = sampleCount * 2
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(1, 22) // mono
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28) // byte rate
  buffer.writeUInt16LE(2, 32) // block align
  buffer.writeUInt16LE(16, 34) // bits per sample
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataBytes, 40)
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 8000)
    buffer.writeInt16LE(sample, 44 + index * 2)
  }
  return buffer
}

/** True when an ffmpeg binary can be started. */
async function ffmpegAvailable() {
  try {
    const { code } = await runCommand(resolveFfmpeg(), ['-version'], { timeoutMs: 30_000 })
    return code === 0
  } catch {
    return false
  }
}

/** Install a fetch stub that serves the WAV (or an oversized response). */
function stubAudioFetch(wav, { declaredBytes } = {}) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers ?? {} })
    return new Response(wav, {
      status: 200,
      headers: {
        'content-type': 'audio/wav',
        'content-length': String(declaredBytes ?? wav.length),
      },
    })
  }
  return calls
}

const ffmpeg = await ffmpegAvailable()
const skip = ffmpeg ? false : 'ffmpeg is not available'

test('downloadAudio fetches the audio with Node then converts locally and removes .source', { skip }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-bili-audio-'))
  const originalFetch = globalThis.fetch
  const wav = tinyWav()
  const calls = stubAudioFetch(wav)
  try {
    const outPath = join(tmp, 'audio.wav')
    const result = await downloadAudio({
      url: 'https://example.test/audio.m4s',
      referer: 'https://www.bilibili.com/video/BV1xx411c7mD/',
      outPath,
      ffmpegPath: resolveFfmpeg(),
      timeoutMs: 60_000,
    })

    assert.equal(result.path, outPath)
    assert.ok(existsSync(outPath), 'the WAV must be written')
    assert.ok(result.bytes > 44, 'the WAV must contain PCM data')
    assert.equal(existsSync(`${outPath}.source`), false, 'the temporary download must be removed')
    assert.equal(existsSync(`${outPath}.source.part`), false, 'no partial download must remain')

    // Node fetched the remote stream with the Bilibili referer; ffmpeg only saw
    // a local path, so there is no remote URL or header in its command line.
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://example.test/audio.m4s')
    assert.equal(calls[0].headers.Referer, 'https://www.bilibili.com/video/BV1xx411c7mD/')
    assert.ok(calls[0].headers['User-Agent'])

    const converted = readFileSync(outPath)
    assert.equal(converted.subarray(0, 4).toString('ascii'), 'RIFF')
    assert.equal(converted.readUInt16LE(22), 1, 'mono')
    assert.equal(converted.readUInt32LE(24), 16_000, '16 kHz')
  } finally {
    globalThis.fetch = originalFetch
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('downloadAudio rejects a download above maxBytes and cleans up', { skip }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-bili-audio-'))
  const originalFetch = globalThis.fetch
  const wav = tinyWav()
  const calls = stubAudioFetch(wav, { declaredBytes: 5 * 1024 * 1024 })
  try {
    const outPath = join(tmp, 'audio.wav')
    await assert.rejects(
      downloadAudio({
        url: 'https://example.test/audio.m4s',
        referer: 'https://www.bilibili.com/video/BV1xx411c7mD/',
        outPath,
        ffmpegPath: resolveFfmpeg(),
        maxBytes: 1024 * 1024,
        timeoutMs: 60_000,
      }),
      /audio download failed: .*too large/i,
    )
    assert.equal(calls.length, 1)
    assert.equal(existsSync(outPath), false, 'no WAV may be produced for a rejected download')
    assert.equal(existsSync(`${outPath}.source`), false, 'the temporary source must not remain')
    assert.equal(existsSync(`${outPath}.source.part`), false, 'the partial download must not remain')
  } finally {
    globalThis.fetch = originalFetch
    rmSync(tmp, { recursive: true, force: true })
  }
})
