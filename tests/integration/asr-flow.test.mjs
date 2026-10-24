/**
 * Bcut ASR integration test: no network.
 *
 * Stubs video metadata, the WBI nav keys, playurl (three DASH audio candidates
 * from high to low) and the Bcut create/result endpoints, then runs the real
 * tools against a temporary output directory. The assertion that matters most:
 * the lowest-bandwidth candidate — not the top one — is submitted to Bcut.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { BCUT_API_BASE } from '../../lib/bcut.js'
import { createBilibiliTools } from '../../lib/tools.js'

const BVID = 'BV1xx411c7mD'
const UNIQUE = '唯一必剪关键词'
const CREATE_URL = `${BCUT_API_BASE}/task`
const AUDIO = {
  high: 'https://cdn.example.com/audio-212k.m4s?token=high-secret',
  mid: 'https://cdn.example.com/audio-113k.m4s?token=mid-secret',
  low: 'https://cdn.example.com/audio-65k.m4s?token=low-secret',
}

/** JSON response helper. */
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

/** 130 x 5 s utterances; the unique keyword sits in the first part. */
function utterances() {
  const list = []
  for (let index = 0; index < 130; index++) {
    const generic = '必剪语音识别结果用于测试分段与检索。'.repeat(2)
    list.push({
      start_time: index * 5000,
      end_time: index * 5000 + 4800,
      transcript: index === 45 ? `${UNIQUE} ${generic}` : generic,
    })
  }
  return list
}

/** Install the fetch stub; returns the state the test can inspect and change. */
function stubAsrFetch() {
  const state = { submitted: [], createCalls: 0, polls: 0 }
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url)
    if (href.startsWith('https://api.bilibili.com/x/web-interface/view')) {
      return jsonResponse({
        code: 0,
        data: {
          bvid: BVID,
          aid: 42,
          cid: 123,
          title: '无字幕 必剪 ASR 测试视频',
          desc: '测试简介',
          pic: 'https://i0.hdslb.com/cover.jpg',
          duration: 300,
          pubdate: 1_700_000_000,
          owner: { mid: 1, name: 'UP' },
          stat: { view: 10, danmaku: 1, reply: 0, like: 2, coin: 0, favorite: 0, share: 0 },
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
            audio: [
              { baseUrl: AUDIO.high, bandwidth: 212_000, codecs: 'mp4a.40.2', id: 30280 },
              { baseUrl: AUDIO.mid, bandwidth: 113_000, codecs: 'mp4a.40.2', id: 30232 },
              { baseUrl: AUDIO.low, bandwidth: 65_000, codecs: 'mp4a.40.2', id: 30216 },
            ],
          },
        },
      })
    }
    if (href === CREATE_URL) {
      state.createCalls += 1
      state.submitted.push(JSON.parse(init.body).resource)
      return jsonResponse({ code: 0, data: { task_id: `task-${state.createCalls}` } })
    }
    if (href.startsWith(`${BCUT_API_BASE}/task/result`)) {
      state.polls += 1
      // One processing state on the first poll of the first task, then success.
      if (state.createCalls === 1 && state.polls === 1) {
        return jsonResponse({ code: 0, data: { state: 1 } })
      }
      return jsonResponse({ code: 0, data: { state: 4, result: JSON.stringify({ utterances: utterances() }) } })
    }
    throw new Error(`unexpected fetch: ${href}`)
  }
  return state
}

/** Build the tools with inert defaults for a temporary out dir. */
function toolsFor(tmp) {
  return createBilibiliTools({
    resolvePath: async (target) => (isAbsolute(target) ? target : resolve(tmp, target)),
    defaults: {
      sessdata: 'test-sessdata',
      outDir: 'out',
      partChars: 2000,
      partSeconds: 600,
      indexChunkSeconds: 300,
      gapSeconds: 10,
      timeoutMs: 5000,
      retries: 1,
      bcutTimeoutMs: 5000,
      bcutPollMs: 1,
    },
  })
}

test('Bcut transcription submits the lowest audio candidate and writes a paged asr bundle', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-bili-pro-asr-'))
  const originalFetch = globalThis.fetch
  const state = stubAsrFetch()
  try {
    const tools = toolsFor(tmp)
    const tool = (name) => tools.find((entry) => entry.name === name)
    const exec = { signal: undefined, agent: { session: { header: { cwd: tmp } } } }
    const transcribe = tool('bilibili_transcribe')
    const partTool = tool('bilibili_transcript_part')
    const searchTool = tool('bilibili_transcript_search')

    const result = await transcribe.execute({ url: BVID, out_dir: 'out-asr' }, exec)
    assert.equal(state.createCalls, 1)
    assert.deepEqual(state.submitted, [AUDIO.low], 'Bcut must receive the lowest-bandwidth candidate')
    assert.equal(result.source, 'asr')
    assert.deepEqual(result.asr, { provider: 'bcut' })
    assert.equal(result.manifest.source, 'asr')
    assert.equal(result.manifest.track.lan, 'asr-zh')
    assert.equal(result.manifest.track.route, 'bcut')
    assert.equal(result.manifest.track.ai, true)
    assert.equal(result.validation.verdict, 'asr')
    assert.equal(result.validation.accepted, true)
    assert.equal(result.validation.count, 130)
    assert.ok(result.manifest.stats.parts >= 2, `expected several parts, got ${result.manifest.stats.parts}`)
    assert.equal(result.part.part, 1)
    assert.equal(result.next_cursor, '1-2')
    assert.equal(result.remaining_parts, result.manifest.stats.parts - 1)
    assert.equal(result.segments, undefined, 'the default result must not include every segment')
    assert.equal(result.transcript, undefined)
    assert.ok(result.markdown.includes('## 分段'))
    assert.ok(result.markdown.includes('B站必剪 ASR'))
    assert.ok(!JSON.stringify(result).includes('cdn.example.com'), 'the signed audio URL must never be returned')

    const files = result.manifest.files
    assert.ok(files.transcript_json.startsWith(tmp))
    assert.ok(existsSync(files.transcript_json))
    assert.ok(existsSync(files.transcript_md))
    assert.ok(existsSync(files.parts_index))
    assert.ok(existsSync(result.manifest.parts[0].file))
    const transcript = JSON.parse(readFileSync(files.transcript_json, 'utf8'))
    assert.equal(transcript.source, 'asr')
    assert.equal(JSON.parse(readFileSync(files.parts_index, 'utf8')).source, 'asr')

    const second = await partTool.execute({ url: BVID, cursor: result.next_cursor, out_dir: 'out-asr' }, exec)
    assert.equal(second.source, 'asr')
    assert.equal(second.part.part, 2)
    assert.equal(second.total_parts, result.manifest.stats.parts)
    assert.ok(second.file.endsWith('part-002.md'))

    const found = await searchTool.execute({ url: BVID, query: UNIQUE, out_dir: 'out-asr' }, exec)
    assert.equal(found.total_matches, 1)
    assert.equal(found.matches.length, 1)
    assert.ok(found.matches[0].part >= 1)
    assert.deepEqual(found.parts_hint, [found.matches[0].part])

    // A non-default packing is carried in the cursor and restores the same part.
    const paged = await transcribe.execute({ url: BVID, max_chars: 4000, out_dir: 'out-paged' }, exec)
    assert.match(paged.next_cursor, /^1-2@4000$/)
    const pagedSecond = await partTool.execute({ url: BVID, cursor: paged.next_cursor, out_dir: 'out-paged' }, exec)
    assert.equal(pagedSecond.part.part, 2)
    assert.equal(pagedSecond.packing.maxChars, 4000)
    assert.equal(pagedSecond.source, 'asr')

    // "out" writes the selected part in the requested format.
    const partOut = await transcribe.execute(
      { url: BVID, format: 'srt', out: 'part-one.srt', out_dir: 'out-srt' },
      exec,
    )
    assert.match(readFileSync(partOut.file, 'utf8'), /^1\n00:00:00,000 --> 00:00:04,800\n/)

    const indexOnly = await transcribe.execute({ url: BVID, index_only: true, out_dir: 'out-index' }, exec)
    assert.equal(indexOnly.part, null)
    assert.equal(indexOnly.next_cursor, null)
    assert.equal(indexOnly.remaining_parts, indexOnly.manifest.stats.parts)
    assert.equal(indexOnly.segments, undefined)
    assert.ok(Array.isArray(indexOnly.index) && indexOnly.index.length > 0)
    assert.ok(indexOnly.markdown.includes('时间索引'))

    const legacy = await transcribe.execute({ url: BVID, legacy_full: true, out_dir: 'out-legacy' }, exec)
    assert.equal(legacy.segments.length, 130)
    assert.equal(legacy.transcript, utterances().map((utterance) => utterance.transcript).join(''))
    assert.ok(Array.isArray(legacy.timeline) && legacy.timeline.length > 0)
    assert.ok(legacy.timeline.every((block) => block.url.includes('?t=')))
    assert.ok(legacy.manifest.stats.parts >= 2)
  } finally {
    globalThis.fetch = originalFetch
    rmSync(tmp, { recursive: true, force: true })
  }
})
