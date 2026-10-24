/**
 * Tool-flow integration test: no network.
 *
 * Stubs global fetch with the three responses the subtitle path needs — video
 * metadata, the WBI nav keys, and the protobuf subtitle-track list — then runs
 * the real tools against a temporary output directory.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { createBilibiliTools } from '../../lib/tools.js'

const BVID = 'BV1xx411c7mD'
const SUBTITLE_URL = '//aisubtitle.hdslb.com/bfs/subtitle/test.json?auth_key=1'
const UNIQUE = '唯一关键词'

/** Encode one protobuf varint. */
function varint(value) {
  const bytes = []
  let remaining = value
  while (remaining > 0x7f) {
    bytes.push((remaining & 0x7f) | 0x80)
    remaining >>>= 7
  }
  bytes.push(remaining)
  return Buffer.from(bytes)
}

/** Encode one protobuf length-delimited string field. */
function stringField(field, text) {
  const data = Buffer.from(text, 'utf8')
  return Buffer.concat([varint((field << 3) | 2), varint(data.length), data])
}

/** Encode one protobuf varint field. */
function intField(field, value) {
  return Buffer.concat([varint((field << 3) | 0), varint(value)])
}

/** A minimal `/x/v2/subtitle/web/view` response with one usable track. */
function trackPayload() {
  return Buffer.concat([
    intField(1, 7),
    stringField(2, 'track-7'),
    stringField(3, 'ai-zh'),
    stringField(4, '中文（AI生成）'),
    stringField(5, SUBTITLE_URL),
  ])
}

/** The 25-line transcript body the stubbed subtitle CDN returns. */
function subtitleBody() {
  const body = []
  for (let index = 0; index < 25; index++) {
    const generic = '量子计算与测试视频内容讲解。'.repeat(12)
    body.push({
      from: index * 12,
      to: index * 12 + 12,
      content: index === 20 ? `${UNIQUE} ${generic}` : generic,
    })
  }
  return body
}

/** JSON response helper. */
function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

test('migrated tools return manifest + one part, page, repack and search offline', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-bili-pro-tools-'))
  const originalFetch = globalThis.fetch
  const body = subtitleBody()
  const expectedText = body.map((entry) => entry.content).join('')
  globalThis.fetch = async (url) => {
    const href = String(url)
    if (href.startsWith('https://api.bilibili.com/x/web-interface/view')) {
      return jsonResponse({
        code: 0,
        data: {
          bvid: BVID,
          aid: 42,
          cid: 123,
          title: '量子计算 测试视频',
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
    if (href.startsWith('https://api.bilibili.com/x/v2/subtitle/web/view')) {
      return new Response(trackPayload(), { status: 200, headers: { 'content-type': 'application/octet-stream' } })
    }
    if (href.startsWith('https://aisubtitle.hdslb.com/')) {
      return jsonResponse({ body })
    }
    throw new Error(`unexpected fetch: ${href}`)
  }

  try {
    const resolvePath = async (target) => (isAbsolute(target) ? target : resolve(tmp, target))
    const tools = createBilibiliTools({
      resolvePath,
      defaults: {
        sessdata: 'test-sessdata',
        outDir: 'out',
        partChars: 2000,
        partSeconds: 600,
        indexChunkSeconds: 300,
        gapSeconds: 10,
        timeoutMs: 5000,
        retries: 1,
      },
    })
    const tool = (name) => tools.find((entry) => entry.name === name)
    const exec = { signal: undefined, agent: { session: { header: { cwd: tmp } } } }
    const subtitles = tool('bilibili_subtitles')
    const partTool = tool('bilibili_transcript_part')
    const searchTool = tool('bilibili_transcript_search')

    const first = await subtitles.execute({ url: BVID }, exec)
    assert.equal(first.video.bvid, BVID)
    assert.equal(first.page.page, 1)
    assert.equal(first.part.part, 1)
    assert.ok(first.manifest.stats.parts >= 2, `expected several parts, got ${first.manifest.stats.parts}`)
    assert.equal(first.next_cursor, '1-2')
    assert.equal(first.remaining_parts, first.manifest.stats.parts - 1)
    assert.equal(first.segments, undefined, 'default result must not include the full segments array')
    assert.equal(first.transcript, undefined, 'default result must not include the full transcript')
    assert.ok(first.part.segments.length > 0)
    assert.ok(first.markdown.includes('## 分段'))
    assert.ok(first.manifest.files.transcript_json.startsWith(tmp))
    assert.ok(existsSync(first.manifest.files.transcript_json))
    assert.ok(existsSync(first.manifest.files.transcript_md))
    assert.ok(existsSync(first.manifest.files.parts_index))
    assert.ok(existsSync(first.manifest.parts[0].file))

    const second = await partTool.execute({ url: BVID, part: 2 }, exec)
    assert.equal(second.total_parts, first.manifest.stats.parts)
    assert.equal(second.part.part, 2)
    assert.equal(second.next_cursor, `1-${second.part.part + 1}`)
    assert.ok(second.markdown.includes('下一段'))
    assert.ok(second.file.endsWith('part-002.md'))

    const found = await searchTool.execute({ url: BVID, query: UNIQUE }, exec)
    assert.equal(found.total_matches, 1)
    assert.equal(found.matches.length, 1)
    assert.equal(found.matches[0].time, 240)
    assert.equal(found.matches[0].part, 2)
    assert.deepEqual(found.parts_hint, [2])
    assert.ok(found.markdown.includes(UNIQUE))

    const repacked = await partTool.execute({ url: BVID, part: 1, max_chars: 3000 }, exec)
    assert.equal(repacked.packing.maxChars, 3000)
    assert.equal(repacked.file, '')
    assert.equal(repacked.next_cursor, '1-2@3000', 'a repacked cursor must carry its packing')
    const viaRepackedCursor = await partTool.execute({ url: BVID, cursor: repacked.next_cursor }, exec)
    assert.equal(viaRepackedCursor.packing.maxChars, 3000, 'the cursor alone must restore the repack')
    assert.equal(viaRepackedCursor.part.part, 2)
    const explicitRepackedSecond = await partTool.execute({ url: BVID, part: 2, max_chars: 3000 }, exec)
    assert.deepEqual(
      viaRepackedCursor.part.segments,
      explicitRepackedSecond.part.segments,
      'following a repacked cursor must return the same part the explicit call returns',
    )
    assert.equal(viaRepackedCursor.part.chars, explicitRepackedSecond.part.chars)
    await assert.rejects(
      partTool.execute({ url: BVID, cursor: '1-2@3000', max_chars: 2000 }, exec),
      /cursor was packed at 3000 chars/,
    )
    await assert.rejects(
      partTool.execute({ url: BVID, cursor: '1-2', max_chars: 3000 }, exec),
      /cursor is canonical at 2000 chars/,
    )
    await assert.rejects(
      subtitles.execute({ url: BVID, cursor: '1-2', max_chars: 3000 }, exec),
      /cursor is canonical at 2000 chars/,
    )
    const subtitlesRepack = await subtitles.execute({ url: BVID, max_chars: 3000, out_dir: 'out-sub-repack' }, exec)
    assert.equal(subtitlesRepack.next_cursor, '1-2@3000')
    const subtitlesFollow = await subtitles.execute({ url: BVID, cursor: subtitlesRepack.next_cursor, out_dir: 'out-sub-repack' }, exec)
    assert.equal(subtitlesFollow.manifest.packing.maxChars, 3000, 'the subtitles cursor must restore its packing')
    assert.deepEqual(
      subtitlesFollow.part.segments,
      explicitRepackedSecond.part.segments,
      'bilibili_subtitles must follow a repacked cursor to the same part',
    )
    const chunks = []
    for (let part = 1; part <= repacked.total_parts; part++) {
      const page = await partTool.execute({ url: BVID, part, max_chars: 3000 }, exec)
      chunks.push(...page.part.segments.map((segment) => segment.text))
    }
    assert.equal(chunks.join(''), expectedText, 'repacking at 3000 chars must not lose text')

    const legacy = await subtitles.execute({ url: BVID, legacy_full: true, out_dir: 'out-legacy' }, exec)
    assert.equal(legacy.segments.length, 25)
    assert.equal(legacy.transcript, expectedText)
    assert.ok(legacy.manifest.stats.parts >= 2)

    const indexOnly = await subtitles.execute({ url: BVID, index_only: true, out_dir: 'out-index' }, exec)
    assert.equal(indexOnly.part, null)
    assert.equal(indexOnly.next_cursor, null)
    assert.equal(indexOnly.remaining_parts, indexOnly.manifest.stats.parts)
    assert.equal(indexOnly.segments, undefined)
    assert.ok(indexOnly.markdown.includes('时间索引'))

    const out = await partTool.execute({ url: BVID, part: 1, format: 'json', out: 'part-one.json' }, exec)
    const written = JSON.parse(readFileSync(out.file, 'utf8'))
    assert.equal(written.part.part, 1)
    assert.ok(Array.isArray(written.part.segments))
  } finally {
    globalThis.fetch = originalFetch
    rmSync(tmp, { recursive: true, force: true })
  }
})

/** Stub the metadata/nav/track/body endpoints; `pages` and `body` are caller-supplied. */
function stubSubtitleFetch({ pages = [], body = subtitleBody() } = {}) {
  globalThis.fetch = async (url) => {
    const href = String(url)
    if (href.startsWith('https://api.bilibili.com/x/web-interface/view')) {
      return jsonResponse({
        code: 0,
        data: {
          bvid: BVID,
          aid: 42,
          cid: 123,
          title: '量子计算 测试视频',
          desc: '测试简介',
          pic: 'https://i0.hdslb.com/cover.jpg',
          duration: 300,
          pubdate: 1_700_000_000,
          owner: { mid: 1, name: 'UP' },
          stat: { view: 10, danmaku: 1, reply: 0, like: 2, coin: 0, favorite: 0, share: 0 },
          pages,
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
    if (href.startsWith('https://api.bilibili.com/x/v2/subtitle/web/view')) {
      return new Response(trackPayload(), { status: 200, headers: { 'content-type': 'application/octet-stream' } })
    }
    if (href.startsWith('https://aisubtitle.hdslb.com/')) {
      return jsonResponse({ body })
    }
    throw new Error(`unexpected fetch: ${href}`)
  }
}

/** Build the tools with inert defaults for a temporary out dir. */
function toolsFor(tmp, overrides = {}) {
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
      ...overrides,
    },
  })
}

test('page>1 transcripts accept a cursor alone, page+cursor, and reject a mismatch', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-bili-pro-page-'))
  const originalFetch = globalThis.fetch
  stubSubtitleFetch({
    pages: [
      { page: 1, cid: 123, part: 'P1', duration: 300 },
      { page: 2, cid: 456, part: 'P2', duration: 300 },
    ],
  })
  try {
    const tools = toolsFor(tmp)
    const exec = { signal: undefined, agent: { session: { header: { cwd: tmp } } } }
    const subtitles = tools.find((entry) => entry.name === 'bilibili_subtitles')
    const partTool = tools.find((entry) => entry.name === 'bilibili_transcript_part')

    const page2 = await subtitles.execute({ url: BVID, page: 2 }, exec)
    assert.equal(page2.page.page, 2)
    assert.ok(page2.next_cursor, 'page 2 must offer a cursor')
    assert.match(page2.next_cursor, /^2-\d+$/)

    const viaCursor = await partTool.execute({ url: BVID, cursor: page2.next_cursor }, exec)
    assert.equal(viaCursor.page.page, 2, 'a cursor alone must select the page encoded in it')
    assert.equal(viaCursor.part.part, Number(page2.next_cursor.split('-')[1]))

    const subtitlesViaCursor = await subtitles.execute({ url: BVID, cursor: page2.next_cursor }, exec)
    assert.equal(subtitlesViaCursor.page.page, 2, 'bilibili_subtitles must derive the page from the cursor too')
    assert.equal(subtitlesViaCursor.part.part, viaCursor.part.part)

    const withPage = await partTool.execute({ url: BVID, page: 2, cursor: '2-1' }, exec)
    assert.equal(withPage.page.page, 2)
    assert.equal(withPage.part.part, 1)

    await assert.rejects(
      partTool.execute({ url: BVID, page: 1, cursor: page2.next_cursor }, exec),
      /cursor page 2 does not match page 1/,
    )
  } finally {
    globalThis.fetch = originalFetch
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('the rendered gap line uses the configured gapSeconds, not a hardcoded 10 seconds', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-bili-pro-gap-'))
  const originalFetch = globalThis.fetch
  // Shift everything from segment 9 on by 20 s: a 20 s gap that a 30 s threshold ignores.
  const body = subtitleBody().map((entry, index) =>
    index >= 9 ? { ...entry, from: entry.from + 20, to: entry.to + 20 } : entry,
  )
  stubSubtitleFetch({ body })
  try {
    const tools = toolsFor(tmp, { gapSeconds: 30 })
    const exec = { signal: undefined, agent: { session: { header: { cwd: tmp } } } }
    const subtitles = tools.find((entry) => entry.name === 'bilibili_subtitles')
    const result = await subtitles.execute({ url: BVID }, exec)
    assert.equal(result.manifest.gaps.length, 0, 'a 20 s gap must not be reported at a 30 s threshold')
    assert.ok(result.markdown.includes('无 ≥30 秒断档'), 'the render must state the real threshold')
    assert.ok(!result.markdown.includes('无 ≥10 秒断档'))
  } finally {
    globalThis.fetch = originalFetch
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('a plain cursor means the configured default packing in both transcript tools', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-bili-pro-canonical-'))
  const originalFetch = globalThis.fetch
  stubSubtitleFetch()
  try {
    const tools = toolsFor(tmp, { partChars: 6000 })
    const exec = { signal: undefined, agent: { session: { header: { cwd: tmp } } } }
    const subtitles = tools.find((entry) => entry.name === 'bilibili_subtitles')
    const partTool = tools.find((entry) => entry.name === 'bilibili_transcript_part')

    const repacked = await subtitles.execute({ url: BVID, max_chars: 2000 }, exec)
    assert.equal(repacked.manifest.packing.maxChars, 2000)
    assert.equal(repacked.next_cursor, '1-2@2000', 'a non-default packing must be carried in the cursor')

    // The part tool reads the on-disk 2000 packing; because it differs from the
    // configured default (6000) its cursor must carry @2000 rather than go plain.
    const fromPart = await partTool.execute({ url: BVID }, exec)
    assert.equal(fromPart.packing.maxChars, 2000)
    assert.equal(fromPart.next_cursor, '1-2@2000', 'a plain cursor would silently mean 6000')
    const partSecond = await partTool.execute({ url: BVID, cursor: fromPart.next_cursor }, exec)

    const followed = await subtitles.execute({ url: BVID, cursor: fromPart.next_cursor }, exec)
    assert.equal(followed.manifest.packing.maxChars, 2000)
    assert.deepEqual(
      followed.part.segments,
      partSecond.part.segments,
      'bilibili_subtitles must resolve the cursor at the packing it carries',
    )
    await assert.rejects(
      subtitles.execute({ url: BVID, cursor: fromPart.next_cursor, max_chars: 6000 }, exec),
      /cursor was packed at 2000 chars/,
    )

    // A plain cursor is explicitly the configured default, so max_chars=6000 is not a conflict.
    const plainAtDefault = await subtitles.execute({ url: BVID, cursor: '1-1', max_chars: 6000 }, exec)
    assert.equal(plainAtDefault.manifest.packing.maxChars, 6000)
    await assert.rejects(
      partTool.execute({ url: BVID, cursor: '1-1', max_chars: 2000 }, exec),
      /cursor is canonical at 6000 chars/,
    )
  } finally {
    globalThis.fetch = originalFetch
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('a track whose subtitle body is empty reports that clearly and writes no bundle', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-bili-pro-empty-'))
  const originalFetch = globalThis.fetch
  stubSubtitleFetch({ body: [] })
  try {
    const tools = toolsFor(tmp)
    const exec = { signal: undefined, agent: { session: { header: { cwd: tmp } } } }
    const subtitles = tools.find((entry) => entry.name === 'bilibili_subtitles')
    await assert.rejects(
      subtitles.execute({ url: BVID }, exec),
      /track exists .* subtitle body is empty/,
    )
    await assert.rejects(
      subtitles.execute({ url: BVID, strict: false }, exec),
      /track exists .* subtitle body is empty/,
      'strict:false must not fall back to the generic zero-segments message',
    )
    assert.equal(existsSync(join(tmp, 'out', BVID)), false, 'an empty body must not write a bundle')
  } finally {
    globalThis.fetch = originalFetch
    rmSync(tmp, { recursive: true, force: true })
  }
})
