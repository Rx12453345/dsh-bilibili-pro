/**
 * Optional faster-whisper runtime unit tests: cross-platform venv paths,
 * persistent/temporary state, status without side effects, the needs-setup
 * result and cleanup. No install, no model download and no child process runs.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  asrInstallOptions,
  cleanupTemporaryRuntime,
  estimatedModelMb,
  fasterWhisperInstallArgs,
  findExistingRuntime,
  needsSetupResult,
  readRuntimeState,
  removeRuntime,
  resolveAsrRuntime,
  runCommand,
  runtimePaths,
  runtimeStatePath,
  runtimeStatus,
  venvPip,
  venvPython,
  writeRuntimeState,
} from '../../lib/asr.js'

/** A throwaway DSH-home-style base plus inert defaults. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bili-asr-unit-'))
  const defaults = { asrBaseDir: join(root, 'dsh-home', 'bilibili-asr'), asrSearchSystem: false }
  return { root, defaults }
}

/** Create a fake virtualenv interpreter so state checks see it. */
function fakeVenv(venvDir) {
  const python = venvPython(venvDir)
  mkdirSync(dirname(python), { recursive: true })
  writeFileSync(python, '')
  return python
}

test('venvPython/venvPip use Scripts on win32 and bin elsewhere', () => {
  for (const venv of ['/tmp/venv', '/tmp/venv/']) {
    assert.equal(venvPython(venv, 'win32'), join(venv, 'Scripts', 'python.exe'))
    assert.equal(venvPip(venv, 'win32'), join(venv, 'Scripts', 'pip.exe'))
    assert.equal(venvPython(venv, 'linux'), join(venv, 'bin', 'python'))
    assert.equal(venvPip(venv, 'linux'), join(venv, 'bin', 'pip'))
    assert.equal(venvPython(venv, 'darwin'), join(venv, 'bin', 'python'))
  }
  // The default follows the host platform.
  assert.equal(venvPython('/tmp/venv'), process.platform === 'win32' ? join('/tmp/venv', 'Scripts', 'python.exe') : join('/tmp/venv', 'bin', 'python'))
})

test('runtimePaths keeps persistent state in the ASR base and temporary state under it', () => {
  const { root, defaults } = fixture()
  try {
    const persistent = runtimePaths('persistent', { defaults })
    assert.equal(persistent.baseDir, defaults.asrBaseDir)
    assert.equal(persistent.venvDir, join(defaults.asrBaseDir, 'venv'))
    assert.equal(persistent.modelDir, join(defaults.asrBaseDir, 'models'))
    assert.equal(persistent.statePath, join(defaults.asrBaseDir, 'runtime.json'))
    assert.equal(runtimeStatePath('persistent', { defaults }), persistent.statePath)

    const outDir = join(root, 'bili-out')
    const temporary = runtimePaths('temporary', { outDir, defaults })
    assert.equal(temporary.baseDir, join(outDir, '.asr-runtime'))
    assert.equal(temporary.venvDir, join(outDir, '.asr-runtime', 'venv'))
    assert.equal(temporary.modelDir, join(outDir, '.asr-runtime', 'models'))
    // A later transcription with another out_dir can still find it.
    assert.equal(temporary.statePath, join(defaults.asrBaseDir, 'temp-runtime.json'))

    assert.throws(() => runtimePaths('temporary', { defaults }), /needs an out_dir/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runtimeStatus reports no runtime and creates nothing', () => {
  const { root, defaults } = fixture()
  try {
    const status = runtimeStatus({ mode: 'persistent', defaults })
    assert.equal(status.mode, 'persistent')
    assert.equal(status.installed, false)
    assert.equal(status.modelCached, false)
    assert.equal(status.estimatedModelMb, 500)
    assert.equal(status.size_mb, 0)
    assert.equal(status.statePath, join(defaults.asrBaseDir, 'runtime.json'))
    assert.equal(existsSync(defaults.asrBaseDir), false, 'status must not create directories')

    const configured = runtimeStatus({
      mode: 'persistent',
      defaults: { ...defaults, asrPython: '/no/such/python' },
    })
    assert.equal(configured.configuredPython, '/no/such/python', 'status must surface a configured interpreter')
    assert.equal(configured.installed, false, 'status must not claim a configured interpreter is installed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('temporary state round-trips and status reports it without probing an install', () => {
  const { root, defaults } = fixture()
  try {
    const outDir = join(root, 'bili-out')
    const paths = runtimePaths('temporary', { outDir, defaults })
    const python = fakeVenv(paths.venvDir)
    const state = {
      mode: 'temporary',
      baseDir: paths.baseDir,
      python,
      venvDir: paths.venvDir,
      modelDir: paths.modelDir,
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    writeRuntimeState(paths.statePath, state)
    assert.deepEqual(readRuntimeState(paths.statePath), state)

    const status = runtimeStatus({ mode: 'temporary', outDir, defaults })
    assert.equal(status.installed, true)
    assert.equal(status.temporary, true)
    assert.equal(status.python, python)
    assert.equal(status.baseDir, paths.baseDir)
    assert.equal(runtimeStatus({ mode: 'persistent', defaults }).installed, false)

    // A different out_dir still resolves the base the state recorded.
    const fromOtherOutDir = runtimeStatus({ mode: 'temporary', outDir: join(root, 'other-out'), defaults })
    assert.equal(fromOtherOutDir.installed, true)
    assert.equal(fromOtherOutDir.baseDir, paths.baseDir)
    assert.equal(fromOtherOutDir.venvDir, paths.venvDir)
    assert.equal(fromOtherOutDir.modelDir, paths.modelDir)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('findExistingRuntime finds nothing when no state exists and never installs', async () => {
  const { root, defaults } = fixture()
  try {
    const runtime = await findExistingRuntime({ outDir: join(root, 'bili-out'), defaults })
    assert.equal(runtime, undefined)
    assert.equal(existsSync(join(defaults.asrBaseDir, 'venv')), false)
    assert.equal(existsSync(defaults.asrBaseDir), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveAsrRuntime refuses to bootstrap without explicit setup', async () => {
  const { root, defaults } = fixture()
  try {
    await assert.rejects(
      resolveAsrRuntime({ outDir: join(root, 'bili-out'), defaults }),
      /never installs automatically/,
    )
    assert.equal(existsSync(join(defaults.asrBaseDir, 'venv')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cleanupTemporaryRuntime removes the venv, models and temp state', () => {
  const { root, defaults } = fixture()
  try {
    const outDir = join(root, 'bili-out')
    const paths = runtimePaths('temporary', { outDir, defaults })
    const python = fakeVenv(paths.venvDir)
    mkdirSync(paths.modelDir, { recursive: true })
    writeFileSync(join(paths.modelDir, 'model.bin'), 'x')
    writeRuntimeState(paths.statePath, {
      mode: 'temporary',
      baseDir: paths.baseDir,
      python,
      venvDir: paths.venvDir,
      modelDir: paths.modelDir,
    })

    const cleaned = cleanupTemporaryRuntime({ outDir, defaults })
    assert.equal(cleaned.removed, true)
    assert.ok(cleaned.removedPaths.includes(paths.baseDir))
    assert.ok(cleaned.removedPaths.includes(paths.statePath))
    assert.equal(existsSync(paths.baseDir), false)
    assert.equal(existsSync(paths.statePath), false)

    const again = cleanupTemporaryRuntime({ outDir, defaults })
    assert.equal(again.removed, false)
    assert.deepEqual(again.removedPaths, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('removeRuntime deletes a temporary runtime but needs confirm for the persistent one', () => {
  const { root, defaults } = fixture()
  try {
    const outDir = join(root, 'bili-out')
    const temporary = runtimePaths('temporary', { outDir, defaults })
    fakeVenv(temporary.venvDir)
    writeRuntimeState(temporary.statePath, {
      mode: 'temporary',
      baseDir: temporary.baseDir,
      python: venvPython(temporary.venvDir),
      venvDir: temporary.venvDir,
      modelDir: temporary.modelDir,
    })
    const removedTemp = removeRuntime({ mode: 'temporary', outDir, defaults })
    assert.ok(removedTemp.removed.includes(temporary.baseDir))
    assert.equal(existsSync(temporary.baseDir), false)
    assert.equal(existsSync(temporary.statePath), false)

    const persistent = runtimePaths('persistent', { defaults })
    fakeVenv(persistent.venvDir)
    writeRuntimeState(persistent.statePath, { mode: 'persistent', python: venvPython(persistent.venvDir) })
    assert.throws(() => removeRuntime({ mode: 'persistent', defaults }), /confirm: true/)
    assert.equal(existsSync(persistent.baseDir), true, 'an unconfirmed removal must not delete anything')

    const removedPersistent = removeRuntime({ mode: 'persistent', defaults, confirm: true })
    assert.ok(removedPersistent.removed.includes(persistent.baseDir))
    assert.equal(existsSync(persistent.baseDir), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('needsSetupResult offers both install modes and writes no bundle', () => {
  const result = needsSetupResult({
    bcutError: 'Bcut ASR rejected the audio (state 3): 音频过长',
    model: 'small',
  })
  assert.equal(result.status, 'needs_asr_runtime')
  assert.equal(result.provider, 'bcut')
  assert.match(result.bcut_error, /state 3/)
  assert.match(result.bcut_error, /音频过长/)
  assert.deepEqual(result.options.map((option) => option.mode), ['persistent', 'temporary'])
  assert.deepEqual(result.options.map((option) => option.estimated_model_mb), [500, 500])
  assert.ok(result.options.every((option) => option.label.length > 0 && option.description.length > 0))
  assert.equal(result.estimated_model_mb, 500)
  assert.match(result.next, /bilibili_asr_setup/)
  assert.match(result.markdown, /长期安装/)
  assert.match(result.markdown, /临时/)
  assert.equal(result.manifest, undefined)
  assert.equal(result.files, undefined)
  assert.equal(result.part, undefined)
})

test('needsSetupResult does not blame Bcut when it was skipped', () => {
  const result = needsSetupResult({
    bcutError: 'faster-whisper was requested but no local runtime is installed',
    model: 'small',
    provider: 'faster-whisper',
  })
  assert.equal(result.status, 'needs_asr_runtime')
  assert.equal(result.provider, 'faster-whisper')
  assert.match(result.markdown, /本地 faster-whisper 不可用/)
  assert.doesNotMatch(result.markdown, /Bcut 转写失败/)
  assert.deepEqual(result.options.map((option) => option.mode), ['persistent', 'temporary'])
})

test('runCommand rejects an already-aborted signal instead of spawning', async () => {
  const controller = new AbortController()
  controller.abort()
  const started = Date.now()
  await assert.rejects(
    runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { signal: controller.signal }),
    (error) => error.name === 'AbortError' || /aborted/.test(error.message),
  )
  assert.ok(Date.now() - started < 1000, 'an aborted call must not run the child')
})

test('model estimates and install options stay in sync', () => {
  assert.equal(estimatedModelMb('small'), 500)
  assert.equal(estimatedModelMb('tiny'), 75)
  assert.ok(estimatedModelMb('medium') > estimatedModelMb('small'))
  assert.equal(estimatedModelMb('unknown-model'), 500, 'unknown names fall back to the small estimate')
  const options = asrInstallOptions('small')
  assert.equal(options.length, 2)
  assert.equal(options[0].mode, 'persistent')
  assert.equal(options[1].mode, 'temporary')
  assert.equal(options[0].estimated_model_mb, 500)
})

test('fasterWhisperInstallArgs pins PyAV below 19', () => {
  const args = fasterWhisperInstallArgs()
  assert.deepEqual(args.slice(0, 5), ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check'])
  assert.ok(args.includes('faster-whisper'), 'the installer must still install faster-whisper')
  assert.ok(args.includes('av<19'), 'PyAV 19 removed av.open(metadata_errors=...), so it must be pinned')
  assert.equal(args.filter((arg) => arg === 'faster-whisper').length, 1)
  assert.equal(args.filter((arg) => arg === 'av<19').length, 1)
  assert.ok(args.every((arg) => typeof arg === 'string' && arg.length > 0))
  // Pure: a second call returns a fresh list, not shared mutable state.
  const again = fasterWhisperInstallArgs()
  assert.notEqual(again, args)
  assert.deepEqual(again, args)
})
