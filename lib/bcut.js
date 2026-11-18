/**
 * Bilibili Bcut (必剪) ASR.
 *
 * The Bcut editor's own service is a small anonymous HTTP API. A transcription
 * is a pipeline of fixed steps: create an upload resource, upload the audio in
 * `per_size` parts, complete the upload, create a task that points at the
 * uploaded resource, then poll for the result. No login, no model download and
 * no local runtime are involved.
 *
 * Three operational facts drive this module:
 *
 * - The task endpoint no longer accepts a signed audio URL: the service does
 *   not fetch remote audio itself. The caller downloads the DASH fMP4 audio
 *   first (`lib/video.js` `downloadStream`, which carries the browser UA and
 *   the video-site Referer) and hands this module a local file path.
 * - The audio is uploaded as-is as `m4a`; a DASH fMP4 needs no transcoding, so
 *   ffmpeg is not part of this path.
 * - The upload path does not reject a stream for its bitrate. The caller still
 *   prefers the lowest-bandwidth candidate only to keep the temporary upload
 *   small, so {@link pickLowestAudio} remains the selector.
 *
 * The upload URLs, the resource keys and the task id are credentials for the
 * duration of a transcription. They are never included in an error message or
 * a tool result. No Bilibili cookie is ever sent to the Bcut endpoints.
 *
 * @module dsh-bilibili-pro/bcut
 */

import { open, stat } from 'node:fs/promises'

/** Bcut rubick-interface endpoint base. */
export const BCUT_API_BASE = 'https://member.bilibili.com/x/bcut/rubick-interface'

/** Model id the Bilibili player uses for Chinese speech. */
export const BCUT_MODEL_ID = '8'

/**
 * User agent the service accepts. Bcut's own clients all claim to be the
 * Bilibili app; a browser UA works for some endpoints but not all.
 */
export const BCUT_USER_AGENT = 'Bilibili/1.0.0 (https://www.bilibili.com/)'

/** Default overall polling/upload budget in milliseconds. */
const DEFAULT_TIMEOUT_MS = 600_000

/** Default delay between result polls in milliseconds. */
const DEFAULT_POLL_MS = 5_000

/** Per-request timeout for the resource create/complete calls. */
const CREATE_TIMEOUT_MS = 60_000

/** Per-request timeout for one part upload; a large part may be slow. */
const UPLOAD_TIMEOUT_MS = 120_000

/** Per-request timeout for the task create and result calls. */
const TASK_TIMEOUT_MS = 30_000

/** Return a request signal that also times out, without requiring Node's fetch helpers. */
function requestSignal(callerSignal, timeoutMs) {
  const timeout = AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)))
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

/** Build the headers every Bcut request shares. */
function bcutHeaders(extra = {}) {
  return {
    'User-Agent': BCUT_USER_AGENT,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    ...extra,
  }
}

/**
 * Accept a string or an object upload target.
 * @param entry - one `upload_urls[]` element.
 * @returns the URL string, or undefined.
 */
function uploadUrlOf(entry) {
  if (typeof entry === 'string') return entry.length > 0 ? entry : undefined
  if (entry && typeof entry === 'object') {
    const value = entry.upload_url ?? entry.uploadUrl ?? entry.url
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }
  return undefined
}

/**
 * Read exactly `length` bytes from a file handle.
 * @param handle - opened file handle.
 * @param offset - byte offset.
 * @param length - byte count.
 * @returns the bytes, shorter only if the file shrank underneath us.
 */
async function readPart(handle, offset, length) {
  const buffer = Buffer.allocUnsafe(length)
  let filled = 0
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled)
    if (bytesRead === 0) break
    filled += bytesRead
  }
  return filled === length ? buffer : buffer.subarray(0, filled)
}

/**
 * Parse a JSON response body, keeping the endpoint label in the error.
 * @param response - fetch response.
 * @param label - operation name used in the error message.
 * @returns the parsed body.
 */
async function readJson(response, label) {
  try {
    return await response.json()
  } catch {
    throw new Error(`${label}: the service returned a non-JSON response`)
  }
}

/**
 * Select the lowest-bitrate audio candidate.
 *
 * The upload path does not reject a higher-bitrate stream; the lowest candidate
 * is chosen only to keep the temporary upload volume down. When no candidate
 * advertises a usable `bandwidth`, the one with the smallest numeric `id` wins
 * (DASH audio ids grow with quality), not whichever happened to be listed last.
 *
 * @param candidates - `{ url, bandwidth, id }` entries from `fetchAudioStream`,
 *   or one stream object when the list is absent.
 * @returns the chosen candidate, or undefined when there is nothing to upload.
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
  if (chosen) return chosen
  // No usable bandwidth anywhere: fall back to the lowest stream id.
  let fallback = list[0]
  let fallbackId = Number.POSITIVE_INFINITY
  for (const candidate of list) {
    const id = Number(candidate.id)
    if (Number.isFinite(id) && id >= 0 && id < fallbackId) {
      fallback = candidate
      fallbackId = id
    }
  }
  return fallback
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
 * Transcribe one local audio file through Bcut.
 *
 * The file is read one `per_size` part at a time, so a long recording never has
 * to fit in memory. Every request has its own timeout and the whole pipeline
 * stays inside the caller's `timeoutMs` budget.
 *
 * @param options - `audioFile` (required local path), caller `signal`, overall
 *   `timeoutMs` (default 600000), `pollMs` (default 5000) and an injectable
 *   `fetchImpl`.
 * @returns `{ language, segments, provider, note }` from
 *   {@link parseBcutUtterances}.
 */
export async function transcribeWithBcut(options = {}) {
  const { audioFile, signal } = options
  if (typeof audioFile !== 'string' || audioFile.length === 0) {
    throw new Error('Bcut ASR needs a local audio file path')
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('Bcut ASR needs a fetch implementation')
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS
  const pollMs = Number(options.pollMs) > 0 ? Number(options.pollMs) : DEFAULT_POLL_MS
  const deadline = Date.now() + timeoutMs
  const maxPolls = Math.max(1, Math.ceil(timeoutMs / pollMs))

  let size
  try {
    const info = await stat(audioFile)
    size = info.size
  } catch {
    throw new Error('Bcut ASR cannot read the local audio file')
  }
  if (!(size > 0)) throw new Error('Bcut ASR needs a non-empty audio file')

  /**
   * Issue one request inside the overall budget.
   * @param url - endpoint or signed upload URL (never echoed in errors).
   * @param init - fetch init.
   * @param requestTimeoutMs - per-request budget.
   * @param label - operation name for the error message.
   * @returns the response.
   */
  const request = async (url, init, requestTimeoutMs, label) => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`Bcut ASR timed out after ${timeoutMs} ms`)
    try {
      return await fetchImpl(url, {
        ...init,
        signal: requestSignal(signal, Math.min(requestTimeoutMs, remaining)),
      })
    } catch (error) {
      if (signal?.aborted) throw error
      const message = String(error?.message ?? error)
      if (message.startsWith('Bcut ASR')) throw error
      throw new Error(`${label}: ${message.slice(0, 160)}`)
    }
  }

  const assertOk = (response, label) => {
    if (!response?.ok) throw new Error(`${label} (HTTP ${response?.status ?? 'unknown'})`)
  }

  // Step 1: declare the resource and learn the part size and upload targets.
  const create = await request(
    `${BCUT_API_BASE}/resource/create`,
    {
      method: 'POST',
      headers: bcutHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        type: 2,
        name: 'audio.m4a',
        size,
        ResourceFileType: 'm4a',
        model_id: BCUT_MODEL_ID,
      }),
    },
    CREATE_TIMEOUT_MS,
    'Bcut ASR resource create failed',
  )
  assertOk(create, 'Bcut ASR resource create failed')
  const created = await readJson(create, 'Bcut ASR resource create failed')
  if (created?.code !== 0) {
    const detail = String(created?.message ?? '').trim()
    throw new Error(`Bcut ASR resource create failed: ${detail || `code ${created?.code ?? 'unknown'}`}`)
  }
  const resource = created?.data ?? {}
  const perSize = Math.floor(Number(resource.per_size))
  if (!(perSize > 0)) throw new Error('Bcut ASR resource create returned no usable part size')
  const inBossKey = typeof resource.in_boss_key === 'string' ? resource.in_boss_key : ''
  const resourceId = typeof resource.resource_id === 'string' ? resource.resource_id : ''
  const uploadId = typeof resource.upload_id === 'string' ? resource.upload_id : ''
  const uploadUrls = Array.isArray(resource.upload_urls) ? resource.upload_urls.map(uploadUrlOf) : []
  if (!inBossKey || !resourceId || !uploadId || uploadUrls.length === 0) {
    throw new Error('Bcut ASR resource create returned an incomplete upload resource')
  }
  const partCount = Math.ceil(size / perSize)
  if (uploadUrls.length < partCount) {
    throw new Error(
      `Bcut ASR resource create returned ${uploadUrls.length} upload target(s) for ${partCount} part(s)`,
    )
  }

  // Step 2: stream the file out one part at a time and collect each ETag.
  const etags = []
  const handle = await open(audioFile, 'r')
  try {
    for (let index = 0; index < partCount; index++) {
      const offset = index * perSize
      const length = Math.min(perSize, size - offset)
      const label = `Bcut ASR audio upload failed (part ${index + 1}/${partCount}`
      let part
      try {
        part = await readPart(handle, offset, length)
      } catch {
        throw new Error(`${label}, could not read the audio file)`)
      }
      const response = await request(
        uploadUrls[index],
        {
          method: 'PUT',
          headers: bcutHeaders({ 'Content-Type': 'application/octet-stream' }),
          body: part,
        },
        UPLOAD_TIMEOUT_MS,
        label,
      )
      if (!response?.ok) throw new Error(`${label}, HTTP ${response?.status ?? 'unknown'})`)
      const etag = response.headers?.get?.('etag') ?? response.headers?.get?.('ETag')
      if (typeof etag !== 'string' || etag.length === 0) {
        throw new Error(`${label}, the service returned no ETag)`)
      }
      etags.push(etag)
    }
  } finally {
    await handle.close().catch(() => {})
  }

  // Step 3: tell the service the upload is complete and get the resource URL.
  const complete = await request(
    `${BCUT_API_BASE}/resource/create/complete`,
    {
      method: 'POST',
      headers: bcutHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        InBossKey: inBossKey,
        ResourceId: resourceId,
        Etags: etags.join(','),
        UploadId: uploadId,
        model_id: BCUT_MODEL_ID,
      }),
    },
    CREATE_TIMEOUT_MS,
    'Bcut ASR resource complete failed',
  )
  assertOk(complete, 'Bcut ASR resource complete failed')
  const completed = await readJson(complete, 'Bcut ASR resource complete failed')
  if (completed?.code !== 0) {
    const detail = String(completed?.message ?? '').trim()
    throw new Error(`Bcut ASR resource complete failed: ${detail || `code ${completed?.code ?? 'unknown'}`}`)
  }
  const downloadUrl = typeof completed?.data?.download_url === 'string' ? completed.data.download_url : ''
  if (!downloadUrl) throw new Error('Bcut ASR resource complete returned no download URL')

  // Step 4: create the transcription task for the uploaded resource.
  const taskCreate = await request(
    `${BCUT_API_BASE}/task`,
    {
      method: 'POST',
      headers: bcutHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ resource: downloadUrl, model_id: BCUT_MODEL_ID }),
    },
    TASK_TIMEOUT_MS,
    'Bcut ASR task create failed',
  )
  assertOk(taskCreate, 'Bcut ASR task create failed')
  const taskPayload = await readJson(taskCreate, 'Bcut ASR task create failed')
  if (taskPayload?.code !== 0) {
    const detail = String(taskPayload?.message ?? '').trim()
    throw new Error(`Bcut ASR task create failed: ${detail || `code ${taskPayload?.code ?? 'unknown'}`}`)
  }
  const taskId = taskPayload?.data?.task_id
  if (!taskId) throw new Error('Bcut ASR task create returned no task id')

  // Step 5: poll for the result. A transient failure (HTTP 5xx, malformed body)
  // is retried until the deadline; only an explicit state 3 is fatal.
  for (let attempt = 0; attempt < maxPolls; attempt++) {
    if (attempt > 0) {
      if (Date.now() >= deadline) break
      await sleep(pollMs, signal)
    }
    if (Date.now() >= deadline) break
    let payload
    try {
      const response = await request(
        `${BCUT_API_BASE}/task/result?model_id=${BCUT_MODEL_ID}&task_id=${encodeURIComponent(String(taskId))}`,
        { headers: bcutHeaders() },
        TASK_TIMEOUT_MS,
        'Bcut ASR task result failed',
      )
      if (!response?.ok) continue
      payload = await response.json()
    } catch (error) {
      if (signal?.aborted) throw error
      continue
    }
    const state = payload?.data?.state
    if (state === 3) {
      const remark = String(payload?.data?.remark ?? '').trim()
      throw new Error(`Bcut ASR rejected the audio (state 3)${remark ? `: ${remark}` : ''}`)
    }
    if (state === 4) {
      return parseBcutUtterances(payload?.data?.result)
    }
    // state 1 (processing) and any unknown state keep polling.
  }
  throw new Error(`Bcut ASR timed out after ${timeoutMs} ms waiting for the transcription result`)
}
