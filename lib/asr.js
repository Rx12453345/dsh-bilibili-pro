/**
 * Optional local ASR fallback (faster-whisper).
 *
 * Bcut is the fast default for a video with no subtitle track. This module is
 * the fallback for the cases Bcut cannot handle (notably audio longer than its
 * ~10 minute limit): it transcribes a downloaded WAV with faster-whisper.
 *
 * Three rules shape the implementation:
 *
 * - **Nothing is bundled and nothing installs by itself.** The plugin ships the
 *   Python script only; faster-whisper, the virtualenv and the model are
 *   created on demand by `bilibili_asr_setup` after the user picks persistent or
 *   temporary mode. A normal transcription never pip-installs or downloads a
 *   model.
 * - **No child pipes.** The DSH Windows sandbox forbids capturing a child's
 *   stdout/stderr through pipes, so every command redirects to files under a
 *   throwaway directory and the files are read afterwards.
 * - **Cross-platform Python.** A usable interpreter is discovered from the
 *   configured path, the environment, PATH (`python`/`python3`) and the Windows
 *   `py -3` launcher, and is verified with an actual `import faster_whisper`
 *   before it is trusted. The Windows Store `python` stub therefore cannot win.
 *
 * Layout:
 *
 * ```
 * $DSH_HOME/bilibili-asr/          persistent base
 *   runtime.json                   state: { mode, python, venvDir, modelDir, createdAt }
 *   venv/                          bin/python (POSIX) or Scripts/python.exe (Windows)
 *   models/                        faster-whisper download cache
 *   temp-runtime.json              temporary state, shared across out_dir values
 * <outDir>/.asr-runtime/           temporary base
 *   venv/
 *   models/
 * ```
 *
 * @module dsh-bilibili-pro/asr
 */

import { spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHome } from './cookies.js'

/** Bundled transcription script. */
export const TRANSCRIBE_SCRIPT = fileURLToPath(new URL('../python/transcribe.py', import.meta.url))

/** Model used when the caller passes none. */
export const DEFAULT_ASR_MODEL = 'small'

/**
 * Python packages the setup installer pip-installs.
 *
 * PyAV 19 removed the `metadata_errors` argument to `av.open` that
 * faster-whisper 1.2.1 still passes, so a bare install currently produces a
 * runtime that fails as soon as it opens the audio. Pin PyAV below 19 until a
 * faster-whisper release carries the fix.
 */
export const ASR_INSTALL_PACKAGES = Object.freeze(['faster-whisper', 'av<19'])

/**
 * Args for `python -m pip install ...`, with the PyAV compatibility pin.
 *
 * Pure and exported so the package list can be asserted without spawning pip.
 *
 * @returns the argument list, not including the interpreter.
 */
export function fasterWhisperInstallArgs() {
  return ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', ...ASR_INSTALL_PACKAGES]
}

/** Rough download sizes in MB, documented to the user before they choose. */
export const MODEL_SIZES_MB = Object.freeze({ tiny: 75, base: 145, small: 500, medium: 1500, large: 3000 })

/**
 * Normalize a Python reference into `{ command, prefixArgs }`.
 *
 * A bare string is an executable; a Windows `py -3` candidate carries the
 * launcher flag in `prefixArgs`.
 *
 * @param python - path/name string, or an already-normalized candidate object.
 * @returns the candidate, or undefined when unusable.
 */
function candidateOf(python) {
  if (!python) return undefined
  if (typeof python === 'string') {
    const command = python.trim()
    return command.length > 0 ? { command, prefixArgs: [] } : undefined
  }
  if (typeof python === 'object' && typeof python.command === 'string' && python.command.length > 0) {
    return {
      command: python.command,
      prefixArgs: Array.isArray(python.prefixArgs) ? python.prefixArgs.map(String) : [],
    }
  }
  return undefined
}

/** True when a command is a path rather than a PATH lookup name. */
function isPathLike(command) {
  return command.includes('/') || command.includes('\\')
}

/** Stable identity for a candidate, used to deduplicate probes. */
function candidateKey(candidate) {
  return `${candidate.command}\u0000${candidate.prefixArgs.join('\u0000')}`
}

/**
 * Run one command with file-backed stdout/stderr (never pipes).
 *
 * The child writes into a fresh temporary directory; the directory is read
 * after the process closes and then removed. Cancellation kills the child;
 * `timeoutMs` kills it and reports `timedOut: true`.
 *
 * @param command - executable.
 * @param args - argument list.
 * @param options - `signal`, `timeoutMs` and a working `cwd`.
 * @returns `{ code, stdout, stderr, timedOut }`; rejects only when the process
 *   could not be started at all.
 */
export function runCommand(command, args = [], options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (options.signal?.aborted) {
      const error = new Error('aborted')
      error.name = 'AbortError'
      rejectPromise(error)
      return
    }
    let dir
    try {
      dir = mkdtempSync(join(tmpdir(), 'dsh-bilibili-asr-run-'))
    } catch (error) {
      rejectPromise(new Error(`could not create a temporary directory for ${command}: ${error.message}`))
      return
    }
    const stdoutPath = join(dir, 'stdout.log')
    const stderrPath = join(dir, 'stderr.log')
    let stdoutFd
    let stderrFd
    try {
      stdoutFd = openSync(stdoutPath, 'a')
      stderrFd = openSync(stderrPath, 'a')
    } catch (error) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {}
      rejectPromise(new Error(`could not open output files for ${command}: ${error.message}`))
      return
    }

    let child
    let settled = false
    let timedOut = false
    let timer
    const onAbort = () => child?.kill('SIGKILL')
    const finish = (code, spawnError) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      let stdout = ''
      let stderr = ''
      try {
        stdout = readFileSync(stdoutPath, 'utf8')
      } catch {}
      try {
        stderr = readFileSync(stderrPath, 'utf8')
      } catch {}
      try {
        closeSync(stdoutFd)
      } catch {}
      try {
        closeSync(stderrFd)
      } catch {}
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {}
      if (spawnError) {
        rejectPromise(new Error(`failed to run ${command}: ${spawnError.message}`))
        return
      }
      resolvePromise({ code, stdout, stderr, timedOut })
    }

    if (options.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true
        child?.kill('SIGKILL')
      }, options.timeoutMs)
      timer.unref?.()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        stdio: ['ignore', stdoutFd, stderrFd],
        windowsHide: true,
      })
    } catch (error) {
      finish(null, error)
      return
    }
    // A cancellation can land between the listener registration and spawn.
    if (options.signal?.aborted) child.kill('SIGKILL')
    child.on('error', (error) => finish(null, error))
    child.on('close', (code) => finish(code))
  })
}

/**
 * Interpreter candidates, in the documented order: configured, environment,
 * PATH (`python`/`python3`), the Windows `py -3` launcher, then the usual
 * macOS/Linux absolute paths.
 *
 * @param defaults - resolved plugin configuration (`asrPython`).
 * @returns ordered, deduplicated candidates.
 */
export function systemPythonCandidates(defaults = {}) {
  const list = []
  const push = (candidate) => {
    const normalized = candidateOf(candidate)
    if (normalized) list.push(normalized)
  }
  push(defaults.asrPython)
  push(process.env.BILIBILI_ASR_PYTHON)
  push(process.env.PYTHON)
  if (process.platform === 'win32') {
    push({ command: 'python', prefixArgs: [] })
    push({ command: 'python3', prefixArgs: [] })
    push({ command: 'py', prefixArgs: ['-3'] })
  } else {
    push({ command: 'python3', prefixArgs: [] })
    push({ command: 'python', prefixArgs: [] })
    for (const path of ['/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3']) {
      push({ command: path, prefixArgs: [] })
    }
  }
  const seen = new Set()
  return list.filter((candidate) => {
    const key = candidateKey(candidate)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Probe whether an interpreter can import faster-whisper.
 *
 * @param python - interpreter path/name or candidate object.
 * @param options - `signal` and `timeoutMs`.
 * @returns true when the import succeeds.
 */
export async function hasFasterWhisper(python, options = {}) {
  const candidate = candidateOf(python)
  if (!candidate) return false
  if (isPathLike(candidate.command) && !existsSync(candidate.command)) return false
  try {
    const result = await runCommand(
      candidate.command,
      [...candidate.prefixArgs, '-c', 'import faster_whisper'],
      { signal: options.signal, timeoutMs: options.timeoutMs ?? 30_000 },
    )
    return result.code === 0
  } catch {
    return false
  }
}

/**
 * Find a base interpreter able to create a virtualenv.
 * @param options - `defaults`, `signal`, optional explicit `python`.
 * @returns the candidate.
 * @throws when no Python 3.9+ can be started.
 */
export async function findBasePython(options = {}) {
  const explicit = candidateOf(options.python)
  const candidates = explicit ? [explicit, ...systemPythonCandidates(options.defaults)] : systemPythonCandidates(options.defaults)
  const seen = new Set()
  for (const candidate of candidates) {
    const key = candidateKey(candidate)
    if (seen.has(key)) continue
    seen.add(key)
    if (isPathLike(candidate.command) && !existsSync(candidate.command)) continue
    try {
      const result = await runCommand(
        candidate.command,
        [
          ...candidate.prefixArgs,
          '-c',
          'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)',
        ],
        { signal: options.signal, timeoutMs: 30_000 },
      )
      if (result.code === 0) return candidate
    } catch {
      // A missing executable / Windows Store stub is simply not a candidate.
    }
  }
  throw new Error(
    'no usable Python 3.9+ was found to create the ASR virtualenv; install Python 3 or set asrPython in the plugin config',
  )
}

/**
 * Persistent ASR base directory.
 * @param defaults - resolved plugin configuration; `asrBaseDir` is an
 *   internal/test override, the DSH home is the production default.
 * @returns the absolute base directory.
 */
export function asrBaseDir(defaults = {}) {
  return defaults.asrBaseDir || join(dshHome(), 'bilibili-asr')
}

/**
 * Persistent virtualenv location.
 * @param defaults - resolved plugin configuration (`asrVenv`).
 * @returns the absolute path.
 */
export function defaultVenvDir(defaults = {}) {
  return defaults.asrVenv || join(asrBaseDir(defaults), 'venv')
}

/**
 * Persistent model cache location.
 * @param defaults - resolved plugin configuration (`asrModelDir`).
 * @returns the absolute path.
 */
export function defaultModelDir(defaults = {}) {
  return defaults.asrModelDir || join(asrBaseDir(defaults), 'models')
}

/**
 * Interpreter inside a virtualenv.
 * @param venvDir - virtualenv root.
 * @param platform - defaults to `process.platform`; tests may pass another.
 * @returns `.../Scripts/python.exe` on win32, `.../bin/python` elsewhere.
 */
export function venvPython(venvDir, platform = process.platform) {
  return platform === 'win32' ? join(venvDir, 'Scripts', 'python.exe') : join(venvDir, 'bin', 'python')
}

/**
 * Pip inside a virtualenv.
 * @param venvDir - virtualenv root.
 * @param platform - defaults to `process.platform`; tests may pass another.
 * @returns `.../Scripts/pip.exe` on win32, `.../bin/pip` elsewhere.
 */
export function venvPip(venvDir, platform = process.platform) {
  return platform === 'win32' ? join(venvDir, 'Scripts', 'pip.exe') : join(venvDir, 'bin', 'pip')
}

/**
 * Directories and state file for one runtime mode.
 *
 * The temporary state file always lives under the persistent ASR base (DSH
 * home by default), so a later transcription finds it even when `out_dir`
 * differs.
 *
 * @param mode - "persistent" or "temporary".
 * @param options - `outDir` (temporary only) and `defaults`.
 * @returns `{ mode, baseDir, venvDir, modelDir, statePath }`.
 */
export function runtimePaths(mode = 'persistent', options = {}) {
  const defaults = options.defaults ?? {}
  if (mode === 'temporary') {
    if (typeof options.outDir !== 'string' || options.outDir.length === 0) {
      throw new Error('a temporary ASR runtime needs an out_dir')
    }
    const baseDir = join(options.outDir, '.asr-runtime')
    return {
      mode,
      baseDir,
      venvDir: join(baseDir, 'venv'),
      modelDir: join(baseDir, 'models'),
      statePath: join(asrBaseDir(defaults), 'temp-runtime.json'),
    }
  }
  return {
    mode: 'persistent',
    baseDir: asrBaseDir(defaults),
    venvDir: defaultVenvDir(defaults),
    modelDir: defaultModelDir(defaults),
    statePath: join(asrBaseDir(defaults), 'runtime.json'),
  }
}

/**
 * State file path for one runtime mode.
 * @param mode - "persistent" or "temporary".
 * @param options - `outDir` and `defaults`.
 * @returns the absolute state path.
 */
export function runtimeStatePath(mode, options = {}) {
  return runtimePaths(mode, options).statePath
}

/**
 * Read a runtime state file.
 * @param statePath - absolute path.
 * @returns the parsed state, or undefined when absent/corrupt.
 */
export function readRuntimeState(statePath) {
  try {
    if (!statePath || !existsSync(statePath)) return undefined
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Write a runtime state file.
 * @param statePath - absolute path.
 * @param state - serializable runtime record.
 */
export function writeRuntimeState(statePath, state) {
  mkdirSync(dirname(statePath), { recursive: true })
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

/**
 * Remove a path without throwing.
 * @param target - file or directory.
 * @returns true when something was removed.
 */
function removePath(target) {
  if (!target) return false
  try {
    if (!existsSync(target)) return false
    rmSync(target, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/** True when `target` resolves inside `base`. */
function isInside(target, base) {
  const resolvedTarget = resolve(target)
  const resolvedBase = resolve(base)
  return resolvedTarget === resolvedBase || resolvedTarget.startsWith(`${resolvedBase}${sep}`)
}

/** True when a directory exists and has at least one entry. */
function hasEntries(dir) {
  try {
    return existsSync(dir) && readdirSync(dir).length > 0
  } catch {
    return false
  }
}

/**
 * Bounded directory size in bytes. Never throws and stops after a fixed number
 * of entries so a status call cannot walk an enormous model tree forever.
 * @param dir - directory.
 * @param budget - maximum entries inspected.
 * @returns size in bytes.
 */
function directoryBytes(dir, budget = 4000) {
  if (!dir || !existsSync(dir)) return 0
  let entries = 0
  let bytes = 0
  const stack = [dir]
  while (stack.length > 0 && entries < budget) {
    const current = stack.pop()
    let listed
    try {
      listed = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const item of listed) {
      if (entries >= budget) break
      entries += 1
      const target = join(current, item.name)
      try {
        if (item.isDirectory()) stack.push(target)
        else if (item.isFile()) bytes += statSync(target).size
      } catch {
        // A file can disappear between readdir and stat; ignore it.
      }
    }
  }
  return bytes
}

/**
 * Approximate size of a directory in MB (one decimal).
 * @param dir - directory.
 * @returns size in MB.
 */
export function directorySizeMb(dir) {
  return Math.round((directoryBytes(dir) / (1024 * 1024)) * 10) / 10
}

/**
 * Rough model download size.
 * @param model - faster-whisper model name.
 * @returns estimated MB.
 */
export function estimatedModelMb(model = DEFAULT_ASR_MODEL) {
  const key = String(model || DEFAULT_ASR_MODEL).toLowerCase()
  return MODEL_SIZES_MB[key] ?? MODEL_SIZES_MB[DEFAULT_ASR_MODEL]
}

/**
 * The two install choices, as structured options for the model/user.
 * @param model - faster-whisper model name.
 * @returns persistent and temporary option descriptors.
 */
export function asrInstallOptions(model = DEFAULT_ASR_MODEL) {
  const estimate = estimatedModelMb(model)
  return [
    {
      mode: 'persistent',
      label: '长期安装',
      description:
        '在 DSH home 下的 bilibili-asr 安装一次 faster-whisper；venv 与模型保留，之后的视频直接复用。' +
        `模型会在首次本地转写时下载（${model} 约 ${estimate} MB）。`,
      estimated_model_mb: estimate,
    },
    {
      mode: 'temporary',
      label: '分析完这个视频就删掉',
      description:
        '只为当前视频在 out_dir/.asr-runtime 临时安装；转写完成后自动删除 venv 与模型。' +
        `仍会下载一次模型（${model} 约 ${estimate} MB）。`,
      estimated_model_mb: estimate,
    },
  ]
}

/**
 * Inspect one runtime without side effects.
 *
 * A temporary state file records the base it was actually installed under, so
 * status follows that base even when called with another `out_dir`.
 *
 * @param options - `mode`, `outDir` and `defaults`.
 * @returns installed state, paths, approximate size and model estimate.
 */
export function runtimeStatus(options = {}) {
  const mode = options.mode === 'temporary' ? 'temporary' : 'persistent'
  const defaults = options.defaults ?? {}
  const configuredPython =
    defaults.asrPython || process.env.BILIBILI_ASR_PYTHON || process.env.PYTHON || ''
  let paths
  try {
    paths = runtimePaths(mode, { outDir: options.outDir, defaults })
  } catch {
    return {
      mode,
      installed: false,
      python: '',
      venvDir: '',
      modelDir: '',
      baseDir: '',
      statePath: '',
      modelCached: false,
      size_mb: 0,
      estimatedModelMb: estimatedModelMb(defaults.asrModel),
      configuredPython,
      temporary: mode === 'temporary',
    }
  }
  const state = readRuntimeState(paths.statePath)
  // Temporary state is authoritative for its directories: it may have been
  // installed from another out_dir.
  const usesStateDirs = mode === 'temporary' && typeof state?.baseDir === 'string' && state.baseDir.length > 0
  const baseDir = usesStateDirs ? state.baseDir : paths.baseDir
  const venvDir = usesStateDirs
    ? typeof state?.venvDir === 'string'
      ? state.venvDir
      : join(baseDir, 'venv')
    : paths.venvDir
  const modelDir = usesStateDirs
    ? typeof state?.modelDir === 'string'
      ? state.modelDir
      : join(baseDir, 'models')
    : paths.modelDir
  const venvPythonPath = venvPython(venvDir)
  const candidates = [state?.python, venvPythonPath]
    .filter((candidate) => typeof candidate === 'string' && candidate.length > 0)
    .filter((candidate, index, list) => list.indexOf(candidate) === index)
  const python = candidates.find((candidate) => existsSync(candidate)) ?? state?.python ?? venvPythonPath
  return {
    mode,
    installed: candidates.some((candidate) => existsSync(candidate)),
    python,
    venvDir,
    modelDir,
    baseDir,
    statePath: paths.statePath,
    modelCached: hasEntries(modelDir),
    size_mb: directorySizeMb(baseDir),
    estimatedModelMb: estimatedModelMb(defaults.asrModel),
    configuredPython,
    temporary: mode === 'temporary',
  }
}

/**
 * Build a runtime candidate record.
 * @param fields - mode, python, directories and source.
 * @returns the normalized runtime.
 */
function runtimeRecord(fields) {
  return {
    mode: fields.mode === 'temporary' ? 'temporary' : fields.mode === 'configured' ? 'configured' : 'persistent',
    temporary: fields.mode === 'temporary',
    python: fields.python,
    venvDir: fields.venvDir,
    modelDir: fields.modelDir,
    baseDir: fields.baseDir,
    statePath: fields.statePath,
    source: fields.source ?? fields.mode,
  }
}

/**
 * Find a usable runtime without installing anything.
 *
 * Order: configured `asrPython`, persistent state/venv, temporary state/base,
 * then environment/PATH interpreters when system search is enabled. Every
 * candidate must pass the `import faster_whisper` probe.
 *
 * @param options - `defaults`, `outDir`, `signal`, `searchSystem`.
 * @returns the first usable runtime, or undefined.
 */
export async function findExistingRuntime(options = {}) {
  const defaults = options.defaults ?? {}
  const signal = options.signal
  const searchSystem = options.searchSystem ?? defaults.asrSearchSystem !== false
  const candidates = []

  const configured = defaults.asrPython
  if (configured) {
    candidates.push(
      runtimeRecord({
        mode: 'configured',
        python: configured,
        modelDir: defaultModelDir(defaults),
        baseDir: asrBaseDir(defaults),
        source: 'configured',
      }),
    )
  }

  const persistent = runtimePaths('persistent', { defaults })
  const persistentState = readRuntimeState(persistent.statePath)
  if (persistentState?.python) {
    candidates.push(
      runtimeRecord({
        mode: 'persistent',
        python: persistentState.python,
        venvDir: persistentState.venvDir ?? persistent.venvDir,
        modelDir: persistentState.modelDir ?? persistent.modelDir,
        baseDir: persistent.baseDir,
        statePath: persistent.statePath,
        source: 'state',
      }),
    )
  }
  candidates.push(
    runtimeRecord({
      mode: 'persistent',
      python: venvPython(persistent.venvDir),
      venvDir: persistent.venvDir,
      modelDir: persistent.modelDir,
      baseDir: persistent.baseDir,
      statePath: persistent.statePath,
      source: 'venv',
    }),
  )

  if (options.outDir) {
    const temporary = runtimePaths('temporary', { outDir: options.outDir, defaults })
    const temporaryState = readRuntimeState(temporary.statePath)
    if (temporaryState?.python) {
      candidates.push(
        runtimeRecord({
          mode: 'temporary',
          python: temporaryState.python,
          venvDir: temporaryState.venvDir ?? temporary.venvDir,
          modelDir: temporaryState.modelDir ?? temporary.modelDir,
          baseDir: temporaryState.baseDir ?? temporary.baseDir,
          statePath: temporary.statePath,
          source: 'state',
        }),
      )
    }
    candidates.push(
      runtimeRecord({
        mode: 'temporary',
        python: venvPython(temporary.venvDir),
        venvDir: temporary.venvDir,
        modelDir: temporary.modelDir,
        baseDir: temporary.baseDir,
        statePath: temporary.statePath,
        source: 'venv',
      }),
    )
  }

  if (searchSystem) {
    for (const candidate of systemPythonCandidates(defaults)) {
      candidates.push(
        runtimeRecord({
          mode: 'configured',
          python: candidate,
          modelDir: defaultModelDir(defaults),
          baseDir: asrBaseDir(defaults),
          source: 'system',
        }),
      )
    }
  }

  const seen = new Set()
  for (const entry of candidates) {
    const candidate = candidateOf(entry.python)
    if (!candidate) continue
    if (isPathLike(candidate.command) && !existsSync(candidate.command)) continue
    const key = candidateKey(candidate)
    if (seen.has(key)) continue
    seen.add(key)
    if (await hasFasterWhisper(candidate, { signal })) {
      return { ...entry, python: isPathLike(candidate.command) ? candidate.command : entry.python }
    }
  }
  return undefined
}

/**
 * Resolve a usable runtime, optionally bootstrapping one.
 *
 * `bootstrap: true` is only passed by `bilibili_asr_setup`; a transcription
 * call never installs.
 *
 * @param options - `mode`, `outDir`, `defaults`, `bootstrap`, `signal`.
 * @returns the runtime.
 * @throws when nothing is installed and bootstrap was not requested.
 */
export async function resolveAsrRuntime(options = {}) {
  const defaults = options.defaults ?? {}
  const mode = options.mode === 'temporary' ? 'temporary' : 'persistent'
  const existing = await findExistingRuntime({
    outDir: options.outDir,
    defaults,
    signal: options.signal,
    searchSystem: options.searchSystem,
  })
  if (existing) return existing
  if (options.bootstrap !== true) {
    throw new Error(
      'no faster-whisper runtime found. Ask the user, then call bilibili_asr_setup ' +
        '(action: "install", mode: "persistent" or "temporary") before retrying; ' +
        'the plugin never installs automatically.',
    )
  }
  const installed = await installRuntime({
    mode,
    outDir: options.outDir,
    defaults,
    signal: options.signal,
  })
  return runtimeRecord({
    mode,
    python: installed.python,
    venvDir: installed.venvDir,
    modelDir: installed.modelDir,
    baseDir: installed.baseDir,
    statePath: installed.statePath,
    source: 'bootstrap',
  })
}

/**
 * Backwards-compatible wrapper around {@link resolveAsrRuntime}.
 * @param options - interpreter/venv/model options plus `bootstrap`.
 * @returns the interpreter and how it was obtained.
 */
export async function ensureAsrPython(options = {}) {
  const runtime = await resolveAsrRuntime({
    mode: options.mode,
    outDir: options.outDir,
    defaults: {
      ...(options.defaults ?? {}),
      ...(options.python ? { asrPython: options.python } : {}),
      ...(options.venvDir ? { asrVenv: options.venvDir } : {}),
    },
    bootstrap: options.bootstrap === true,
    signal: options.signal,
  })
  return {
    python: runtime.python,
    venvDir: runtime.venvDir,
    modelDir: runtime.modelDir,
    source: runtime.source ?? runtime.mode,
  }
}

/**
 * Build the runtime state record.
 * @param mode - persistent or temporary.
 * @param paths - from {@link runtimePaths}.
 * @param python - virtualenv interpreter.
 * @param model - configured model name.
 * @returns the state object written to disk.
 */
function stateRecord(mode, paths, python, model) {
  const state = {
    mode,
    ...(mode === 'temporary' ? { baseDir: paths.baseDir } : {}),
    python,
    venvDir: paths.venvDir,
    modelDir: paths.modelDir,
    model,
    createdAt: new Date().toISOString(),
  }
  return state
}

/**
 * Install faster-whisper into a fresh virtualenv.
 *
 * The model is **not** downloaded here: the first local transcription does
 * that. Any partial virtualenv/state is removed on failure.
 *
 * @param options - `mode`, `outDir`, `defaults`, `signal`, timeouts.
 * @returns installation record, including `modelPending` and the estimate.
 */
export async function installRuntime(options = {}) {
  const mode = options.mode === 'temporary' ? 'temporary' : 'persistent'
  const defaults = options.defaults ?? {}
  const model = defaults.asrModel ?? DEFAULT_ASR_MODEL
  const paths = runtimePaths(mode, { outDir: options.outDir, defaults })
  const venvPythonPath = venvPython(paths.venvDir)

  // Idempotent: an existing, importable virtualenv is reused instead of rebuilt.
  if (existsSync(venvPythonPath) && (await hasFasterWhisper(venvPythonPath, { signal: options.signal }))) {
    writeRuntimeState(paths.statePath, stateRecord(mode, paths, venvPythonPath, model))
    return {
      mode,
      installed: true,
      reused: true,
      python: venvPythonPath,
      venvDir: paths.venvDir,
      modelDir: paths.modelDir,
      baseDir: paths.baseDir,
      statePath: paths.statePath,
      model,
      modelPending: true,
      estimatedModelMb: estimatedModelMb(model),
      note: 'faster-whisper 运行时已存在；模型仍会在首次本地转写时下载。',
    }
  }

  const basePython = await findBasePython({
    defaults,
    python: options.python,
    signal: options.signal,
  })
  try {
    removePath(paths.venvDir)
    mkdirSync(dirname(paths.venvDir), { recursive: true })
    const created = await runCommand(
      basePython.command,
      [...basePython.prefixArgs, '-m', 'venv', paths.venvDir],
      { signal: options.signal, timeoutMs: options.venvTimeoutMs ?? 300_000 },
    )
    if (created.code !== 0) {
      throw new Error(
        `could not create the ASR virtualenv (exit ${created.code}): ${(created.stderr || created.stdout).trim().slice(0, 400)}`,
      )
    }
    if (!existsSync(venvPythonPath)) {
      throw new Error(`the ASR virtualenv has no interpreter at ${venvPythonPath}`)
    }
    // `python -m pip` works without relying on a pip shim being on PATH.
    const installed = await runCommand(venvPythonPath, fasterWhisperInstallArgs(), {
      signal: options.signal,
      timeoutMs: options.installTimeoutMs ?? 1_800_000,
    })
    if (installed.code !== 0) {
      throw new Error(
        `could not install faster-whisper (exit ${installed.code}): ${(installed.stderr || installed.stdout).trim().slice(0, 400)}`,
      )
    }
    if (!(await hasFasterWhisper(venvPythonPath, { signal: options.signal }))) {
      throw new Error('faster-whisper was installed but cannot be imported by the virtualenv')
    }
    mkdirSync(paths.modelDir, { recursive: true })
    const state = stateRecord(mode, paths, venvPythonPath, model)
    writeRuntimeState(paths.statePath, state)
    return {
      mode,
      installed: true,
      reused: false,
      python: venvPythonPath,
      venvDir: paths.venvDir,
      modelDir: paths.modelDir,
      baseDir: paths.baseDir,
      statePath: paths.statePath,
      model,
      modelPending: true,
      estimatedModelMb: estimatedModelMb(model),
      createdAt: state.createdAt,
      note:
        'faster-whisper 已安装，但未下载模型；第一次本地转写会下载 ' +
        `${model}（约 ${estimatedModelMb(model)} MB）。`,
    }
  } catch (error) {
    removePath(paths.venvDir)
    if (mode === 'temporary') removePath(paths.baseDir)
    removePath(paths.statePath)
    throw error instanceof Error ? error : new Error(String(error))
  }
}

/**
 * Remove a runtime.
 *
 * Temporary runtimes are always removable. The persistent runtime requires
 * `confirm: true`, because it deletes the virtualenv and the model cache.
 *
 * @param options - `mode`, `outDir`, `defaults`, `confirm`.
 * @returns `{ mode, removed, remaining }`.
 * @throws when persistent removal was not confirmed.
 */
export function removeRuntime(options = {}) {
  const mode = options.mode === 'temporary' ? 'temporary' : 'persistent'
  const defaults = options.defaults ?? {}
  if (mode === 'persistent' && options.confirm !== true) {
    throw new Error(
      'removing the persistent faster-whisper runtime requires confirm: true, ' +
        'because it deletes the virtualenv and the downloaded model cache',
    )
  }
  const paths = runtimePaths(mode, { outDir: options.outDir, defaults })
  const removed = []
  const removeOne = (target) => {
    if (removePath(target)) removed.push(target)
  }

  if (mode === 'temporary') {
    const state = readRuntimeState(paths.statePath)
    // The state names the base a previous transcription actually used; an
    // `out_dir` may differ from the one given now.
    removeOne(state?.baseDir ?? paths.baseDir)
    if (state?.baseDir && resolve(state.baseDir) !== resolve(paths.baseDir)) removeOne(paths.baseDir)
    removeOne(paths.statePath)
  } else {
    removeOne(paths.baseDir)
    // Custom asrVenv/asrModelDir may live outside the base directory.
    if (!isInside(paths.venvDir, paths.baseDir)) removeOne(paths.venvDir)
    if (!isInside(paths.modelDir, paths.baseDir)) removeOne(paths.modelDir)
    removeOne(paths.statePath)
  }
  return {
    mode,
    removed,
    remaining: runtimeStatus({ mode, outDir: options.outDir, defaults }),
  }
}

/**
 * Best-effort removal of a temporary runtime after one video.
 *
 * It never throws: the transcript bundle is already on disk by the time this
 * runs, and a leftover directory must not turn a successful transcription into
 * an error.
 *
 * @param options - `outDir` and `defaults`.
 * @returns `{ mode, removed, removedPaths, note? }`.
 */
export function cleanupTemporaryRuntime(options = {}) {
  const defaults = options.defaults ?? {}
  let paths
  try {
    paths = runtimePaths('temporary', { outDir: options.outDir, defaults })
  } catch {
    return { mode: 'temporary', removed: false, removedPaths: [] }
  }
  const state = readRuntimeState(paths.statePath)
  const removedPaths = []
  const bases = [...new Set([paths.baseDir, state?.baseDir].filter(Boolean))]
  for (const base of bases) {
    if (removePath(base)) removedPaths.push(base)
  }
  if (removePath(paths.statePath)) removedPaths.push(paths.statePath)
  return {
    mode: 'temporary',
    removed: removedPaths.length > 0,
    removedPaths,
    ...(removedPaths.length > 0 ? { note: '临时 ASR 运行时（venv 与模型）已删除' } : {}),
  }
}

/**
 * Build the structured result returned when no runtime is installed.
 *
 * It contains no bundle and triggers no download. When `provider` is
 * `faster-whisper`, Bcut was never attempted, so the wording names the missing
 * local runtime instead of blaming Bcut.
 *
 * @param options - `bcutError`, `model`, and the attempted `provider`.
 * @returns the `needs_asr_runtime` result.
 */
export function needsSetupResult(options = {}) {
  const model = options.model ?? DEFAULT_ASR_MODEL
  const estimate = estimatedModelMb(model)
  const attempted = options.provider === 'faster-whisper' ? 'faster-whisper' : 'bcut'
  const bcutError = String(options.bcutError ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400)
  const installOptions = asrInstallOptions(model)
  const reasonLine =
    attempted === 'bcut'
      ? `Bcut 转写失败：${bcutError || '未知原因'}`
      : `本地 faster-whisper 不可用：${bcutError || '未安装本地运行时'}`
  const markdown = [
    '## 需要本地 ASR 运行时',
    '',
    reasonLine,
    '',
    '当前没有可用的 faster-whisper 运行时。插件**不内置** faster-whisper、虚拟环境或模型，' +
      '需要用户选择一种安装方式：',
    '',
    ...installOptions.map((option, index) => `${index + 1}. **${option.label}**（mode: \`${option.mode}\`）— ${option.description}`),
    '',
    `模型 \`${model}\` 首次本地转写时下载，约 ${estimate} MB。`,
    '请先询问用户选择哪一种，再调用 `bilibili_asr_setup`（action: "install"，mode: 用户选择），' +
      '然后重试 `bilibili_transcribe`。',
  ].join('\n')
  return {
    status: 'needs_asr_runtime',
    bcut_error: bcutError,
    provider: attempted,
    options: installOptions,
    model,
    estimated_model_mb: estimate,
    next:
      'Ask the user which mode they want, then call bilibili_asr_setup with that mode and retry bilibili_transcribe.',
    markdown,
  }
}

/**
 * Transcribe a WAV file with faster-whisper.
 *
 * The output JSON is written by `python/transcribe.py`; this side reads it back
 * and normalizes the segment list. No pipes are used.
 *
 * @param options - `python` (required), `audioPath`, `model`, `modelDir`,
 *   `language`, `outPath`, `signal`, `timeoutMs`.
 * @returns detected language, probability, timestamped segments and script size.
 */
export async function transcribeAudio(options = {}) {
  const candidate = candidateOf(options.python)
  if (!candidate) throw new Error('faster-whisper transcription needs a Python interpreter')
  if (typeof options.audioPath !== 'string' || options.audioPath.length === 0) {
    throw new Error('faster-whisper transcription needs an audio file')
  }
  const outPath = options.outPath ?? `${options.audioPath}.json`
  const model = options.model ?? DEFAULT_ASR_MODEL
  const modelDir = options.modelDir ?? defaultModelDir(options.defaults)
  mkdirSync(modelDir, { recursive: true })
  mkdirSync(dirname(outPath), { recursive: true })

  const args = [...candidate.prefixArgs, TRANSCRIBE_SCRIPT, '--audio', options.audioPath, '--out', outPath, '--model', model]
  args.push('--model-dir', modelDir)
  if (options.language && options.language !== 'auto') args.push('--language', options.language)

  const result = await runCommand(candidate.command, args, {
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 30 * 60 * 1000,
  })
  if (result.code !== 0 || !existsSync(outPath)) {
    const detail = (result.stderr || result.stdout).trim().slice(0, 400)
    const suffix = result.timedOut ? ' (timed out)' : ''
    throw new Error(`faster-whisper failed${suffix} (exit ${result.code}): ${detail}`)
  }
  const parsed = JSON.parse(readFileSync(outPath, 'utf8'))
  const segments = (parsed.segments ?? []).filter((segment) => segment && segment.text)
  return {
    language: parsed.language,
    probability: parsed.probability,
    segments,
    scriptBytes: statSync(outPath).size,
    model,
  }
}
