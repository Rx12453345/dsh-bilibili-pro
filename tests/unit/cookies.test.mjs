/**
 * Credential-storage unit tests: cookie-file resolution, the device-id gate,
 * and the `saveCookieFile` fail-fast contract. Every test isolates `DSH_HOME`
 * in its own temporary directory and restores the environment with `t.after`,
 * so the file can run alongside the rest of the suite.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEVICE_ID_API,
  ensureDeviceId,
  loadCredentials,
  resolveCookieFile,
  saveCookieFile,
} from '../../lib/cookies.js'

/**
 * Point the process at a throwaway DSH home and restore the environment after
 * the test. Env mutations are the only shared state, so every test gets its own
 * home and its own credential file.
 *
 * @param t - node:test context.
 * @returns the temporary DSH home path.
 */
function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bili-cookies-'))
  const previous = {
    home: process.env.DSH_HOME,
    cookieFile: process.env.BILIBILI_COOKIE_FILE,
    sessdata: process.env.BILIBILI_SESSDATA,
  }
  process.env.DSH_HOME = home
  delete process.env.BILIBILI_COOKIE_FILE
  delete process.env.BILIBILI_SESSDATA
  t.after(() => {
    rmSync(home, { recursive: true, force: true })
    const restore = (name, value) => {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    restore('DSH_HOME', previous.home)
    restore('BILIBILI_COOKIE_FILE', previous.cookieFile)
    restore('BILIBILI_SESSDATA', previous.sessdata)
  })
  return home
}

/** JSON response helper for the SPI stubs. */
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

/** Write one stored credential record. */
function writeRecord(file, record) {
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
}

test('resolveCookieFile prefers the explicit path, then process.env, then .env, then the default', (t) => {
  const home = tempHome(t)
  const dotenvPath = join(home, 'from-dotenv.json')
  writeFileSync(join(home, '.env'), `BILIBILI_COOKIE_FILE=${dotenvPath}\n`, 'utf8')
  const explicit = join(home, 'explicit.json')

  assert.equal(resolveCookieFile({ cookieFile: explicit }), explicit)
  assert.equal(resolveCookieFile({}), dotenvPath)

  process.env.BILIBILI_COOKIE_FILE = join(home, 'from-env.json')
  assert.equal(resolveCookieFile({}), join(home, 'from-env.json'))
  assert.equal(resolveCookieFile({ cookieFile: explicit }), explicit, 'an explicit option still wins')

  delete process.env.BILIBILI_COOKIE_FILE
  rmSync(join(home, '.env'))
  assert.equal(resolveCookieFile({}), join(home, 'bilibili-cookies.json'))
})

test('loadCredentials keeps a buvid-only jar and reports loggedIn separately', (t) => {
  const home = tempHome(t)
  const file = join(home, 'cookies.json')
  writeRecord(file, {
    savedAt: '2026-01-01T00:00:00.000Z',
    source: 'test',
    user: { mid: 1, name: 'UP' },
    cookies: { buvid3: 'B3' },
  })

  const credentials = loadCredentials({ cookieFile: file })
  assert.deepEqual(credentials.cookies, { buvid3: 'B3' })
  assert.equal(credentials.source, 'test')
  assert.equal(credentials.file, file)
  assert.deepEqual(credentials.user, { mid: 1, name: 'UP' })
  assert.equal(credentials.loggedIn, false)
})

test('loadCredentials merges an explicit sessdata into the stored jar', (t) => {
  const home = tempHome(t)
  const file = join(home, 'cookies.json')
  writeRecord(file, { source: 'test', cookies: { buvid3: 'B3' } })

  const credentials = loadCredentials({ cookieFile: file, sessdata: 'ENV-SESS' })
  assert.deepEqual(credentials.cookies, { buvid3: 'B3', SESSDATA: 'ENV-SESS' })
  assert.equal(credentials.source, 'config')
  assert.equal(credentials.loggedIn, true)
})

test('saveCookieFile rejects every ambiguous call shape with a TypeError', (t) => {
  const home = tempHome(t)
  const file = join(home, 'cookies.json')
  const defaultFile = join(home, 'bilibili-cookies.json')

  assert.throws(() => saveCookieFile(), TypeError)
  assert.throws(() => saveCookieFile(null), TypeError)
  assert.throws(() => saveCookieFile('not-an-options-object'), TypeError)
  assert.throws(() => saveCookieFile({ file, cookies: null, source: 'qrcode' }), TypeError)
  assert.throws(() => saveCookieFile({ file, cookies: 'SESSDATA=x', source: 'qrcode' }), TypeError)
  assert.throws(() => saveCookieFile({ file, source: 'qrcode' }), TypeError)
  assert.throws(() => saveCookieFile({ file, cookies: { SESSDATA: 'S' } }), /explicit source/)

  assert.equal(existsSync(file), false, 'a rejected call must not write anything')
  assert.equal(existsSync(defaultFile), false, 'a rejected call must not fall back to the default path')
})

test('saveCookieFile supports (file, cookies) as an explicit manual import', (t) => {
  const home = tempHome(t)
  const alt = join(home, 'alt.json')
  const saved = saveCookieFile(alt, { SESSDATA: 'S', buvid3: 'B3' })

  assert.equal(saved.file, alt)
  assert.equal(saved.record.source, 'manual')
  assert.deepEqual(saved.record.cookies, { SESSDATA: 'S', buvid3: 'B3' })
  assert.ok(existsSync(alt))
  assert.equal(existsSync(join(home, 'bilibili-cookies.json')), false, 'the default file must stay untouched')
})

test('saveCookieFile writes the resolved default path when only cookies and source are given', (t) => {
  const home = tempHome(t)
  const saved = saveCookieFile({ cookies: { SESSDATA: 'S' }, source: 'qrcode' })
  assert.equal(saved.file, join(home, 'bilibili-cookies.json'))
  assert.equal(JSON.parse(readFileSync(saved.file, 'utf8')).source, 'qrcode')
})

test('ensureDeviceId merges the SPI ids without overwriting the session cookie or record metadata', async (t) => {
  const home = tempHome(t)
  const file = join(home, 'cookies.json')
  writeRecord(file, {
    savedAt: '2026-01-01T00:00:00.000Z',
    source: 'qrcode',
    user: { mid: 7, name: 'User' },
    cookies: { SESSDATA: 'SESSION', bili_jct: 'JCT', buvid3: 'OLD3' },
  })
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers ?? {} })
    return jsonResponse({ code: 0, data: { b_3: 'NEW3', b_4: 'NEW4' } })
  }

  const credentials = await ensureDeviceId({ cookieFile: file, fetchImpl })
  assert.equal(credentials.cookies.SESSDATA, 'SESSION')
  assert.equal(credentials.cookies.bili_jct, 'JCT')
  assert.equal(credentials.cookies.buvid3, 'OLD3', 'an existing buvid3 must not be replaced')
  assert.equal(credentials.cookies.buvid4, 'NEW4')
  assert.equal(credentials.loggedIn, true)

  const record = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(record.savedAt, '2026-01-01T00:00:00.000Z')
  assert.equal(record.source, 'qrcode')
  assert.deepEqual(record.user, { mid: 7, name: 'User' })
  assert.equal(record.cookies.SESSDATA, 'SESSION')
  assert.equal(record.cookies.buvid3, 'OLD3')
  assert.equal(record.cookies.buvid4, 'NEW4')

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, DEVICE_ID_API)
  assert.equal(calls[0].headers.Cookie, undefined)
  assert.equal(calls[0].headers.cookie, undefined, 'the SPI request must not carry the session cookie')
})

test('ensureDeviceId makes no request when both device ids are already stored', async (t) => {
  const home = tempHome(t)
  const file = join(home, 'cookies.json')
  writeRecord(file, { source: 'qrcode', cookies: { SESSDATA: 'S', buvid3: 'B3', buvid4: 'B4' } })

  const credentials = await ensureDeviceId({
    cookieFile: file,
    fetchImpl: () => {
      throw new Error('the SPI endpoint must not be called')
    },
  })
  assert.deepEqual(credentials.cookies, { SESSDATA: 'S', buvid3: 'B3', buvid4: 'B4' })
  assert.equal(credentials.loggedIn, true)
})

test('ensureDeviceId returns the original credentials when the SPI request fails', async (t) => {
  const home = tempHome(t)
  const file = join(home, 'cookies.json')
  writeRecord(file, { source: 'qrcode', cookies: { buvid3: 'OLD3' } })

  const original = JSON.parse(readFileSync(file, 'utf8'))
  for (const fetchImpl of [
    async () => {
      throw new Error('network down')
    },
    async () => new Response('oops', { status: 500 }),
    async () => jsonResponse({ code: -101, message: 'not logged in' }),
    async () => jsonResponse({ code: 0, data: {} }),
  ]) {
    const credentials = await ensureDeviceId({ cookieFile: file, fetchImpl })
    assert.deepEqual(credentials.cookies, { buvid3: 'OLD3' })
    assert.equal(credentials.loggedIn, false)
  }
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), original, 'a failed lookup must not rewrite the file')
})

test('ensureDeviceId writes device ids into a jar that had no record', async (t) => {
  const home = tempHome(t)
  const file = join(home, 'fresh-cookies.json')
  const credentials = await ensureDeviceId({
    cookieFile: file,
    fetchImpl: async () => jsonResponse({ code: 0, data: { b_3: 'B3', b_4: 'B4' } }),
  })
  assert.deepEqual(credentials.cookies, { buvid3: 'B3', buvid4: 'B4' })
  assert.equal(credentials.loggedIn, false)
  const record = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(record.source, 'device')
  assert.deepEqual(record.cookies, { buvid3: 'B3', buvid4: 'B4' })
})

test('ensureDeviceId does not copy an explicit sessdata option into the cookie file', async (t) => {
  const home = tempHome(t)
  const file = join(home, 'cookies.json')
  const credentials = await ensureDeviceId({
    cookieFile: file,
    sessdata: 'CONFIG-SESSION',
    fetchImpl: async () => jsonResponse({ code: 0, data: { b_3: 'B3', b_4: 'B4' } }),
  })
  assert.equal(credentials.cookies.SESSDATA, 'CONFIG-SESSION')
  assert.equal(credentials.loggedIn, true)
  assert.equal(credentials.source, 'config')
  const record = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(record.cookies.SESSDATA, undefined, 'a configured session must not become a persisted one')
  assert.deepEqual(record.cookies, { buvid3: 'B3', buvid4: 'B4' })
})
