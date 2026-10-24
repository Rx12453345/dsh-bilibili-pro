/**
 * Bilibili Bcut (必剪) ASR.
 *
 * Bilibili's player exposes the same machine transcription the Bcut editor
 * offers as a small anonymous HTTP API: submit a DASH audio URL, then poll for
 * the result. No login, no model download and no local runtime are involved.
 *
 * Two operational facts drive this module:
 *
 * - Bcut only accepts roughly ten minutes of audio. Longer audio is rejected
 *   with `state: 3` (sometimes with an empty `remark`), so callers must surface
 *   that rejection instead of silently falling back to a local model.
 * - It is picky about the bitrate. A 9-minute stream can be rejected at
 *   ~212 kbps and accepted at ~65 kbps, so the caller submits the lowest
 *   bandwidth DASH candidate, which {@link pickLowestAudio} selects.
 *
 * The signed audio URL and the task id are credentials for the duration of a
 * transcription. They are never included in an error message or a tool result.
 *
 * @module dsh-bilibili-pro/bcut
 */

/** Bcut rubick-interface endpoint base. */
export const BCUT_API_BASE = 'https://member.bilibili.com/x/bcut/rubick-interface'

/** Model id the Bilibili player uses for Chinese speech. */
export const BCUT_MODEL_ID = '8'

/** Browser user agent the service accepts. */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36'

/** Default overall polling budget in milliseconds. */
const DEFAULT_TIMEOUT_MS = 600_000

/** Default delay between result polls in milliseconds. */
const DEFAULT_POLL_MS = 5_000

/** Per-request timeout for the create and poll calls. */
const REQUEST_TIMEOUT_MS = 30_000

/** Return a request signal that also times out, without requiring Node's fetch helpers. */
function requestSignal(callerSignal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (!callerSignal) return timeout
  // AbortSignal.any exists on the supported Node versions (>= 20.3).
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([callerSignal, timeout]) : callerSignal
}

/** Sleep without swallowing cancellation. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Format a millisecond timestamp as seconds rounded to two decimals. */
function toSeconds(milliseconds) {
  const value = Number(milliseconds)
  if (!Number.isFinite(value)) return undefined
  return Number((value / 1000).toFixed(2))
}

/**
 * Select the lowest-bitrate audio candidate.
 *
 * Bcut rejects higher-bitrate candidates for long-ish audio even though they
 * are the "better" stream, so the caller must submit the smallest positive
 * `bandwidth`. A candidate without a usable bandwidth falls back to the last
 * entry of the list, which DASH lists from high to low.
 *
 * @param candidates - `{ url, bandwidth }` entries from `fetchAudioStream`, or
 *   one stream object when the list is absent.
 * @returns the chosen candidate, or undefined when there is nothing to submit.
 */
export function pickLowestAudio(candidates) {
  const list = (Array.isArray(candidates) ? candidates : candidates ? [candidates] : []).filter(
    (candidate) => candidate && typeof candidate.url === 'string' && candidate.url.length > 0,
  )
  if (list.length === 0) return undefined
  let chosen
  let chosenBandwidth = Number.POSITIVE_INFINITY
  for (const candidate of list) {
    const bandwidth = Number(candidate.bandwidth)
    if (Number.isFinite(bandwidth) && bandwidth > 0 && bandwidth < chosenBandwidth) {
      chosen = candidate
      chosenBandwidth = bandwidth
    }
  }
  return chosen ?? list[list.length - 1]
}

/**
 * Normalize Bcut's utterance payload into transcript segments.
 *
 * `data.result` arrives as a JSON **string** whose `utterances[]` carry
 * millisecond `start_time`/`end_time` and a `transcript` text field. A missing
 * or empty utterance list is not an error here; the tool refuses to persist an
 * empty transcript instead.
 *
 * @param result - `data.result` as a JSON string or an already-parsed object.
 * @returns `{ language, segments, provider, note }` with `{ from, to, text }`
 *   segments in seconds and playback order.
 */
export function parseBcutUtterances(result) {
  let parsed = result
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      throw new Error('Bcut returned a malformed transcription result (invalid JSON)')
    }
  }
  if (parsed !== undefined && parsed !== null && typeof parsed !== 'object') {
    throw new Error('Bcut returned a malformed transcription result (not an object)')
  }
  const utterances = Array.isArray(parsed?.utterances) ? parsed.utterances : []
  const segments = []
  for (const utterance of utterances) {
    const from = toSeconds(utterance?.start_time)
    const to = toSeconds(utterance?.end_time)
    const text = String(utterance?.transcript ?? '').trim()
    if (from === undefined || to === undefined || text.length === 0) continue
    segments.push({ from, to, text })
  }
  return {
    language: 'zh',
    segments,
    provider: 'bcut',
    note:
      'transcribed on demand via Bilibili Bcut ASR (必剪); the video has no subtitle track, ' +
      'so the text may contain recognition errors',
  }
}

/**
 * Transcribe one audio URL through Bcut.
 *
 * @param options - `audioUrl` (required), caller `signal`, overall `timeoutMs`
 *   (default 600000), `pollMs` (default 5000) and an injectable `fetchImpl`.
 * @returns `{ language, segments, provider, note }` from
 *   {@link parseBcutUtterances}.
 */
export async function transcribeWithBcut(options = {}) {
  const { audioUrl, signal } = options
  if (typeof audioUrl !== 'string' || audioUrl.length === 0) {
    throw new Error('Bcut ASR needs a non-empty audio URL')
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('Bcut ASR needs a fetch implementation')
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS
  const pollMs = Number(options.pollMs) > 0 ? Number(options.pollMs) : DEFAULT_POLL_MS
  const deadline = Date.now() + timeoutMs
  const maxPolls = Math.max(1, Math.ceil(timeoutMs / pollMs))

  let create
  try {
    const response = await fetchImpl(`${BCUT_API_BASE}/task`, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      },
      body: JSON.stringify({ resource: audioUrl, model_id: BCUT_MODEL_ID }),
      signal: requestSignal(signal, REQUEST_TIMEOUT_MS),
    })
    if (!response?.ok) throw new Error(`Bcut ASR task create failed (HTTP ${response?.status ?? 'unknown'})`)
    create = await response.json()
  } catch (error) {
    if (signal?.aborted) throw error
    const message = String(error?.message ?? error)
    if (message.startsWith('Bcut ASR task create failed')) throw error
    throw new Error(`Bcut ASR task create failed: ${message.slice(0, 200)}`)
  }
  if (create?.code !== 0) {
    const detail = String(create?.message ?? '').trim()
    throw new Error(`Bcut ASR task create failed: ${detail || `code ${create?.code ?? 'unknown'}`}`)
  }
  const taskId = create?.data?.task_id
  if (!taskId) throw new Error('Bcut ASR task create returned no task id')

  for (let attempt = 0; attempt < maxPolls; attempt++) {
    if (attempt > 0) {
      if (Date.now() >= deadline) break
      await sleep(pollMs, signal)
    }
    if (Date.now() >= deadline) break
    let payload
    try {
      const response = await fetchImpl(
        `${BCUT_API_BASE}/task/result?model_id=${BCUT_MODEL_ID}&task_id=${encodeURIComponent(String(taskId))}`,
        {
          headers: { 'User-Agent': USER_AGENT, 'Cache-Control': 'no-cache' },
          signal: requestSignal(signal, REQUEST_TIMEOUT_MS),
        },
      )
      // A transient poll failure (HTTP 5xx, malformed body) is retried until the
      // deadline; only an explicit state 3 is fatal.
      if (!response?.ok) continue
      payload = await response.json()
    } catch (error) {
      if (signal?.aborted) throw error
      continue
    }
    const state = payload?.data?.state
    if (state === 3) {
      const remark = String(payload?.data?.remark ?? '').trim()
      throw new Error(
        `Bcut ASR rejected the audio (state 3)${remark ? `: ${remark}` : ''}. ` +
          'Bcut accepts only roughly 10 minutes of audio, so a longer video needs another provider.',
      )
    }
    if (state === 4) {
      return parseBcutUtterances(payload?.data?.result)
    }
    // state 1 (processing) and any unknown state keep polling.
  }
  throw new Error(`Bcut ASR timed out after ${timeoutMs} ms waiting for the transcription result`)
}
