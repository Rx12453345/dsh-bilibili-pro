/**
 * Login-tool regression tests: no network.
 *
 * The installed plugin once required the caller to pass `qrcode_key` back to
 * `poll`, even though the rendered `start` result does not expose it. The fix
 * reads the last QR state file; these tests pin that behavior and the explicit
 * override path.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginStateFile } from '../../lib/login.js'
import { createBilibiliTools } from '../../lib/tools.js'

/** Build the login tool with the minimal config. */
function loginTool() {
  const tools = createBilibiliTools({
    defaults: { outDir: 'bili-out', timeoutMs: 5000 },
    resolvePath: async (target) => target,
  })
  return tools.find((tool) => tool.name === 'bilibili_login')
}

/** A passport poll response, always "expired" so the test never waits. */
function expiredResponse() {
  return new Response(JSON.stringify({ data: { code: 86038, message: '二维码已过期' } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

test('poll reads the last QR state and lets an explicit key win', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bili-login-'))
  const originalHome = process.env.DSH_HOME
  const originalFetch = globalThis.fetch
  const requested = []
  process.env.DSH_HOME = home
  globalThis.fetch = async (url) => {
    requested.push(String(url))
    return expiredResponse()
  }
  t.after(() => {
    globalThis.fetch = originalFetch
    if (originalHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalHome
    rmSync(home, { recursive: true, force: true })
  })

  const tool = loginTool()
  writeFileSync(loginStateFile(), `${JSON.stringify({ qrcodeKey: 'state-key' })}\n`, 'utf8')

  // No qrcode_key in the call: the state file supplies it.
  const fromState = await tool.execute({ action: 'poll', timeout_sec: 5 }, { signal: undefined })
  assert.equal(fromState.status, 'expired')
  assert.equal(requested.length, 1)
  assert.match(requested[0], /qrcode_key=state-key/)

  // An explicit key overrides the state file.
  requested.length = 0
  const explicit = await tool.execute(
    { action: 'poll', qrcode_key: 'explicit-key', timeout_sec: 5 },
    { signal: undefined },
  )
  assert.equal(explicit.status, 'expired')
  assert.equal(requested.length, 1)
  assert.match(requested[0], /qrcode_key=explicit-key/)

  // With neither source, the error tells the caller what to do next.
  rmSync(loginStateFile(), { force: true })
  requested.length = 0
  await assert.rejects(
    tool.execute({ action: 'poll', timeout_sec: 5 }, { signal: undefined }),
    /no pending QR login; run bilibili_login \{ action: "start" \} first/,
  )
  assert.equal(requested.length, 0)
})
