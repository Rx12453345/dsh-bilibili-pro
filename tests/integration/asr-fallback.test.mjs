/**
 * Optional faster-whisper fallback integration test: no network, no install.
 *
 * Bcut is stubbed at the HTTP boundary. These tests cover the decision points
 * that matter: a Bcut failure with no runtime must return a structured
 * `needs_asr_runtime` result and write no bundle, a Bcut success must stay on
 * Bcut, `provider: "faster-whisper"` must skip Bcut, and runtime status/remove
 * honour the temporary/persistent confirmation rules.
 *
 * Nothing pip-installs, creates a virtualenv or downloads a model here; the
 * real temporary install is a documented manual check.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { readRuntimeState, runtimePaths, venvPython, writeRuntimeState } from '../../lib/asr.js'
import { BCUT_API_BASE } from '../../lib/bcut.js'
import { createBilibiliTools } from '../../lib/tools.js'

const BVID = 'BV1xx411c7mD'
const CREATE_URL = `${BCUT_API_BASE}/task`

/** JSON response helper. */
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * Install a fetch stub.
 * @param mode - "reject" (Bcut state 3), "success" (state 4) or "unexpected"
 *   (a Bcut create must never be issued).
 * @returns counters the assertions can inspect.
 */
function stubAsrFetch(mode) {
  const state = { createCalls: 0, polls: 0 }
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url)
    if (href.startsWith('https://api.bilibili.com/x/web-interface/view')) {
      return jsonResponse({
        code: 0,
        data: {
          bvid: BVID,
          aid: 42,
          cid: 123,
          title: '无字幕 兜底 ASR 测试视频',
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
            audio: [{ baseUrl: 'https://cdn.example.com/audio-65k.m4s?token=secret', bandwidth: 65_000, codecs: 'mp4a.40.2', id: 30216 }],
          },
        },
      })
    }
    if (href === CREATE_URL) {
      state.createCalls += 1
      if (mode === 'unexpected') throw new Error('Bcut must not be called for provider=faster-whisper')
      return jsonResponse({ code: 0, data: { task_id: `task-${state.createCalls}` } })
    }
    if (href.startsWith(`${BCUT_API_BASE}/task/result`)) {
      state.polls += 1
      if (mode === 'success') {
        return jsonResponse({
          code: 0,
          data: {
            state: 4,
            result: JSON.stringify({
              utterances: [{ start_time: 0, end_time: 2000, transcript: '必剪语音识别结果' }],
            }),
          },
        })
      }
      return jsonResponse({ code: 0, data: { state: 3, remark: '音频过长' } })
    }
    throw new Error(`unexpected fetch: ${href}`)
  }
  return state
}

/** Build the tools with isolated ASR state under a temporary workspace. */
function toolsFor(tmp, extra = {}) {
  const asrBaseDir = join(tmp, 'dsh-home', 'bilibili-asr')
  const tools = createBilibiliTools({
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
      asrBaseDir,
      // Keep the test hermetic: do not probe the machine's Python interpreters.
      asrSearchSystem: false,
      asrModel: 'small',
      asrLanguage: 'auto',
      ...extra,
    },
  })
  return { tools, asrBaseDir }
}

/** Inert exec with a workspace cwd. */
function execFor(tmp) {
  return { signal: undefined, agent: { session: { header: { cwd: tmp } } } }
}

test('Bcut failure without a runtime returns needs_asr_runtime and writes no bundle', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-bili-asr-fallback-'))
  const originalFetch = globalThis.fetch
  const stub = stubAsrFetch('reject')
  try {
    const { tools, asrBaseDir } = toolsFor(tmp)
    const transcribe = tools.find((tool) => tool.name === 'bilibili_transcribe')
    const result = await transcribe.execute({ url: BVID, out_dir: 'out' }, execFor(tmp))

    assert.equal(result.status, 'needs_asr_runtime')
    assert.equal(result.provider, 'bcut')
    assert.match(result.bcut_error, /state 3/)
    assert.match(result.bcut_error, /音频过长/)
    assert.match(result.bcut_error, /10 minutes|another provider|rejected/)
    assert.deepEqual(result.options.map((option) => option.mode), ['persistent', 'temporary'])
    assert.equal(result.estimated_model_mb, 500)
    assert.ok(result.options.every((option) => typeof option.label === 'string' && option.label.length > 0))
    assert.match(result.next, /bilibili_asr_setup/)
    assert.match(result.markdown, /bilibili_asr_setup/)
    assert.ok(!JSON.stringify(result).includes('cdn.example.com'), 'the signed audio URL must never be returned')

    // No bundle and no runtime are created, and no model is downloaded.
    assert.equal(result.manifest, undefined)
    assert.equal(result.part, undefined)
    assert.equal(result.files, undefined)
    assert.equal(existsSync(join(tmp, 'out', BVID)), false)
    assert.equal(existsSync(asrBaseDir), false)
    assert.equal(stub.createCalls, 1, 'auto must try Bcut exactly once before giving up')
  } finally {
    globalThis.fetch = originalFetch
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('Bcut success stays on Bcut even when no local runtime exists', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-bili-asr-fallback-'))
  const originalFetch = globalThis.fetch
  const stub = stubAsrFetch('success')
  try {
    const { tools, asrBaseDir } = toolsFor(tmp)
    const transcribe = tools.find((tool) => tool.name === 'bilibili_transcribe')
    const result = await transcribe.execute({ url: BVID, out_dir: 'out' }, execFor(tmp))

    assert.equal(stub.createCalls, 1)
    assert.equal(result.status, undefined)
    assert.equal(result.source, 'asr')
    assert.deepEqual(result.asr, { provider: 'bcut' })
    assert.equal(result.manifest.source, 'asr')
    assert.equal(result.manifest.track.route, 'bcut')
    assert.equal(result.validation.verdict, 'asr')
    assert.equal(result.part.part, 1)
    assert.ok(existsSync(result.manifest.files.transcript_json))
    assert.ok(existsSync(join(tmp, 'out', BVID)), 'the Bcut bundle must be written')
    assert.equal(existsSync(join(tmp, 'out', '.asr-runtime')), false)
    assert.equal(existsSync(asrBaseDir), false, 'Bcut success must not touch a local runtime')
  } finally {
    globalThis.fetch = originalFetch
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('a post-Bcut part error is not misreported as a Bcut failure', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-bili-asr-fallback-'))
  const originalFetch = globalThis.fetch
  const stub = stubAsrFetch('success')
  try {
    const { tools, asrBaseDir } = toolsFor(tmp)
    const transcribe = tools.find((tool) => tool.name === 'bilibili_transcribe')
    // Bcut succeeds, then transcriptPartTool rejects part 99. The error must
    // surface instead of being swallowed as "Bcut failed" (which previously
    // returned needs_asr_runtime or started a second local transcription).
    await assert.rejects(
      transcribe.execute({ url: BVID, part: 99, out_dir: 'out-err' }, execFor(tmp)),
      /part 99 is out of range/,
    )
    assert.equal(stub.createCalls, 1, 'must not retry Bcut or fall back to local ASR')
    assert.equal(existsSync(join(tmp, 'out-err', '.asr-runtime')), false)
    assert.equal(existsSync(asrBaseDir), false, 'a persistence error must not create a runtime')
  } finally {
    globalThis.fetch = originalFetch
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('provider=faster-whisper skips Bcut and returns the needs-setup result', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-bili-asr-fallback-'))
  const originalFetch = globalThis.fetch
  const stub = stubAsrFetch('unexpected')
  try {
    const { tools, asrBaseDir } = toolsFor(tmp)
    const transcribe = tools.find((tool) => tool.name === 'bilibili_transcribe')
    const result = await transcribe.execute(
      { url: BVID, provider: 'faster-whisper', out_dir: 'out' },
      execFor(tmp),
    )
    assert.equal(stub.createCalls, 0, 'provider=faster-whisper must not call Bcut')
    assert.equal(result.status, 'needs_asr_runtime')
    assert.equal(result.provider, 'faster-whisper', 'the result must not claim Bcut was attempted')
    assert.match(result.bcut_error, /faster-whisper/)
    assert.doesNotMatch(result.markdown, /Bcut 转写失败/, 'Bcut was skipped, so it did not fail')
    assert.deepEqual(result.options.map((option) => option.mode), ['persistent', 'temporary'])
    assert.equal(existsSync(join(tmp, 'out', BVID)), false)
    assert.equal(existsSync(asrBaseDir), false)
  } finally {
    globalThis.fetch = originalFetch
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('bilibili_asr_setup status reports a temporary runtime and remove deletes it', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-bili-asr-fallback-'))
  try {
    const { tools, asrBaseDir } = toolsFor(tmp)
    const setup = tools.find((tool) => tool.name === 'bilibili_asr_setup')
    const outDir = join(tmp, 'out')
    const paths = runtimePaths('temporary', { outDir, defaults: { asrBaseDir } })
    const python = venvPython(paths.venvDir)
    mkdirSync(dirname(python), { recursive: true })
    writeFileSync(python, '')
    mkdirSync(paths.modelDir, { recursive: true })
    writeFileSync(join(paths.modelDir, 'model.bin'), Buffer.alloc(64 * 1024))
    writeRuntimeState(paths.statePath, {
      mode: 'temporary',
      baseDir: paths.baseDir,
      python,
      venvDir: paths.venvDir,
      modelDir: paths.modelDir,
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    const status = await setup.execute({ action: 'status', mode: 'temporary', out_dir: 'out' }, execFor(tmp))
    assert.equal(status.action, 'status')
    assert.equal(status.temporary.installed, true)
    assert.equal(status.temporary.mode, 'temporary')
    assert.equal(status.temporary.baseDir, paths.baseDir)
    assert.equal(status.persistent.installed, false)
    assert.equal(status.estimated_model_mb, 500)
    assert.deepEqual(status.options.map((option) => option.mode), ['persistent', 'temporary'])
    assert.match(status.markdown, /faster-whisper/)
    assert.equal(readRuntimeState(paths.statePath).mode, 'temporary')

    // The temp state names the base it was installed under, so status with a
    // different out_dir must report that base, not a nonexistent sibling.
    const otherStatus = await setup.execute(
      { action: 'status', mode: 'temporary', out_dir: 'other-out' },
      execFor(tmp),
    )
    assert.equal(otherStatus.temporary.installed, true)
    assert.equal(otherStatus.temporary.baseDir, paths.baseDir)
    assert.equal(otherStatus.temporary.venvDir, paths.venvDir)
    assert.equal(otherStatus.temporary.modelCached, true)
    assert.ok(otherStatus.temporary.size_mb > 0)

    const removed = await setup.execute({ action: 'remove', mode: 'temporary', out_dir: 'out' }, execFor(tmp))
    assert.equal(removed.action, 'remove')
    assert.ok(removed.removed.includes(paths.baseDir))
    assert.equal(existsSync(paths.baseDir), false)
    assert.equal(existsSync(paths.statePath), false)
    assert.equal(removed.remaining.installed, false)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('asr_setup status surfaces a configured asrPython and its readiness', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-bili-asr-fallback-'))
  try {
    const configured = join(tmp, 'no-such-python')
    const { tools } = toolsFor(tmp, { asrPython: configured })
    const setup = tools.find((tool) => tool.name === 'bilibili_asr_setup')
    const status = await setup.execute({ action: 'status' }, execFor(tmp))
    assert.equal(status.configured.python, configured)
    assert.equal(status.configured.installed, false)
    assert.equal(status.ready, false)
    assert.match(status.markdown, /asrPython/)
    assert.match(status.markdown, /已配置解释器/)
    assert.match(status.next, /Ask the user/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('removing the persistent runtime without confirm is refused, with confirm it is deleted', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-bili-asr-fallback-'))
  try {
    const { tools, asrBaseDir } = toolsFor(tmp)
    const setup = tools.find((tool) => tool.name === 'bilibili_asr_setup')
    const paths = runtimePaths('persistent', { defaults: { asrBaseDir } })
    const python = venvPython(paths.venvDir)
    mkdirSync(dirname(python), { recursive: true })
    writeFileSync(python, '')
    mkdirSync(paths.modelDir, { recursive: true })
    writeRuntimeState(paths.statePath, { mode: 'persistent', python, venvDir: paths.venvDir, modelDir: paths.modelDir })

    await assert.rejects(
      setup.execute({ action: 'remove', mode: 'persistent' }, execFor(tmp)),
      /confirm: true/,
    )
    assert.equal(existsSync(paths.baseDir), true, 'the refused removal must not delete the runtime')

    const removed = await setup.execute({ action: 'remove', mode: 'persistent', confirm: true }, execFor(tmp))
    assert.ok(removed.removed.includes(paths.baseDir))
    assert.equal(existsSync(paths.baseDir), false)
    assert.equal(removed.remaining.installed, false)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
