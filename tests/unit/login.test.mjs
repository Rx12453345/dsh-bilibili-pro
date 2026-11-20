/**
 * Login-tool regression tests: no network.
 *
 * The installed plugin once required the caller to pass `qrcode_key` back to
 * `poll`, even though the rendered `start` result does not expose it. The fix
 * reads the last QR state file; these tests pin that behavior and the explicit
 * override path. They also pin the success write path: the cookies land in the
 * file `resolveCookieFile` selected (honouring `BILIBILI_COOKIE_FILE`) with
 * `source: "qrcode"`, not in the `$DSH_HOME` default file.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginStateFile, pollQrLogin } from '../../lib/login.js'
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

/**
 * Fetch stub for a completed sign-in: the poll succeeds with two `Set-Cookie`
 * values and the following nav call reports the same account as signed in.
 * Cookies are appended one by one (never comma-joined), because that is what
 * the real headers do and what `collectSetCookies` reads back.
 */
function signedInFetch(calls) {
  return async (url) => {
    const text = String(url)
    calls.push(text)
    if (text.includes('/x/passport-login/web/qrcode/poll')) {
      const headers = new Headers({ 'content-type': 'application/json' })
      headers.append('set-cookie', 'SESSDATA=sess-value; Path=/; Domain=.bilibili.com; HttpOnly')
      headers.append('set-cookie', 'bili_jct=csrf-value; Path=/; Domain=.bilibili.com')
      return new Response(JSON.stringify({ code: 0, data: { code: 0, message: '登录成功' } }), {
        status: 200,
        headers,
      })
    }
    if (text.includes('/x/web-interface/nav')) {
      return new Response(
        JSON.stringify({ code: 0, data: { isLogin: true, mid: 424242, uname: 'tester' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    throw new Error(`unexpected fetch: ${text}`)
  }
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

test('poll writes the success cookies to the resolved file and records source qrcode', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bili-login-'))
  const cookieFile = join(home, 'selected-cookies.json')
  const originalHome = process.env.DSH_HOME
  const originalCookieFile = process.env.BILIBILI_COOKIE_FILE
  const originalFetch = globalThis.fetch
  const requested = []
  process.env.DSH_HOME = home
  delete process.env.BILIBILI_COOKIE_FILE
  globalThis.fetch = signedInFetch(requested)
  t.after(() => {
    globalThis.fetch = originalFetch
    if (originalHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalHome
    if (originalCookieFile === undefined) delete process.env.BILIBILI_COOKIE_FILE
    else process.env.BILIBILI_COOKIE_FILE = originalCookieFile
    rmSync(home, { recursive: true, force: true })
  })

  const result = await pollQrLogin({ qrcodeKey: 'success-key', timeoutSec: 5, cookieFile })

  assert.equal(result.status, 'success')
  assert.equal(result.cookieFile, cookieFile)
  assert.equal(result.user?.mid, 424242)
  assert.equal(existsSync(cookieFile), true)
  const record = JSON.parse(readFileSync(cookieFile, 'utf8'))
  assert.equal(record.source, 'qrcode')
  assert.equal(record.cookies.SESSDATA, 'sess-value')
  assert.equal(record.cookies.bili_jct, 'csrf-value')
  assert.equal(existsSync(join(home, 'bilibili-cookies.json')), false)
  assert.equal(requested.length, 2)
  assert.match(requested[0], /qrcode_key=success-key/)
  assert.match(requested[1], /\/x\/web-interface\/nav/)
})

test('the login poll tool writes BILIBILI_COOKIE_FILE, not the DSH_HOME default', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bili-login-'))
  const envFile = join(home, 'env-selected-cookies.json')
  const originalHome = process.env.DSH_HOME
  const originalCookieFile = process.env.BILIBILI_COOKIE_FILE
  const originalFetch = globalThis.fetch
  const requested = []
  process.env.DSH_HOME = home
  process.env.BILIBILI_COOKIE_FILE = envFile
  globalThis.fetch = signedInFetch(requested)
  t.after(() => {
    globalThis.fetch = originalFetch
    if (originalHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalHome
    if (originalCookieFile === undefined) delete process.env.BILIBILI_COOKIE_FILE
    else process.env.BILIBILI_COOKIE_FILE = originalCookieFile
    rmSync(home, { recursive: true, force: true })
  })

  const tool = loginTool()
  const result = await tool.execute(
    { action: 'poll', qrcode_key: 'tool-key', timeout_sec: 5 },
    { signal: undefined },
  )

  assert.equal(result.status, 'success')
  assert.equal(result.cookieFile, envFile)
  assert.equal(result.user?.mid, 424242)
  assert.equal(existsSync(envFile), true)
  const record = JSON.parse(readFileSync(envFile, 'utf8'))
  assert.equal(record.source, 'qrcode')
  assert.equal(record.cookies.SESSDATA, 'sess-value')
  assert.equal(existsSync(join(home, 'bilibili-cookies.json')), false)
  assert.match(requested[0], /qrcode_key=tool-key/)
})
