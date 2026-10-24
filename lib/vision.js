/**
 * Optional vision descriptions for captured frames.
 *
 * Text-only models cannot look at a JPEG, so when the user has a local vision
 * service (Ollama, llama.cpp) or any OpenAI-compatible endpoint, this module
 * turns one frame into a short factual description plus a citation hint. It is
 * deliberately optional: the default provider is `none`, no endpoint is
 * guessed, and a vision failure never reaches the capture pipeline.
 *
 * The endpoint is always user-configured. Nothing here uploads a frame to a
 * third party that the caller did not name, calls the main model, or logs the
 * image bytes or API key.
 *
 * @module dsh-bilibili-pro/vision
 */

import { readFile } from 'node:fs/promises'

/** Default per-request vision budget; a local CPU model can be slow. */
const DEFAULT_VISION_TIMEOUT_MS = 120000

/** Upper bound on described frames per call, even if a caller asks for more. */
const MAX_VISION_FRAMES = 20

/** Smallest useful cap: one request still produces one description. */
const MIN_VISION_FRAMES = 1

/** Ollama's local OpenAI-compatible base. */
const OLLAMA_DEFAULT_URL = 'http://localhost:11434/v1'

/** llama.cpp's local OpenAI-compatible base. */
const LLAMA_CPP_DEFAULT_URL = 'http://localhost:8080/v1'

/** Inline JPEG payload prefix for the chat message. */
const JPEG_DATA_PREFIX = 'data:image/jpeg;base64,'

/** Recommended small vision models per tier (Ollama tag / llama-server alias). */
const VISION_TIERS = {
  low: 'qwen3-vl:2b',
  small: 'qwen3-vl:2b',
  medium: 'qwen3-vl:4b',
  high: 'qwen3-vl:8b',
  large: 'qwen3-vl:8b',
}

/** Bundled default prompt: understand the frame's content, not OCR it. */
export const DEFAULT_VISION_PROMPT =
  '你是视频画面分析助手。用中文客观描述这张视频截图所展示的内容，重点提供语音文稿中缺失的视觉信息：' +
  '① 画面主体（人物/场景/产品/界面）；② 正在进行的操作、演示或对比；③ 与视频主题相关的关键细节。' +
  '画面中的文字只需转述与理解内容相关的要点（如标题、关键数字、图表结论），不要逐字转录。' +
  '要求 2-3 句话，只描述事实，不评价、不推测画面之外的内容。' +
  '若画面只是主持人口播、无信息量，回复「纯口播画面，无补充信息」。' +
  '最后单独一行输出「配图建议：适合」或「配图建议：不适合」' +
  '（适合=画面清晰、信息明确、能帮助读者理解视频内容；不适合=纯口播、模糊、无信息量）。'

/** MiniCPM-V family prompt: same task, denser detail on charts and demos. */
const VISION_PROMPT_MINICPMV =
  '你是视频画面分析助手。请理解并描述这张视频截图的内容：画面里发生了什么、展示了什么，' +
  '与视频主题相关的关键细节要提到；若画面中有图表或演示，说明它传达的结论。' +
  '画面中的文字只需转述要点（标题、关键数字），不要逐字转录。' +
  '用中文、2-3 句话、只描述事实。' +
  '若画面只是主持人口播、无信息量，回复「纯口播画面，无补充信息」。' +
  '最后单独一行输出「配图建议：适合」或「配图建议：不适合」' +
  '（适合=画面清晰、信息明确、能帮助读者理解视频内容；不适合=纯口播、模糊、无信息量）。'

/** moondream2 is weak at Chinese; an English prompt keeps instruction following. */
const VISION_PROMPT_MOONDREAM =
  'Describe the content of this video frame: what is happening, what is being shown or demonstrated, ' +
  'and any key details relevant to the topic. Mention visible text only as brief key points ' +
  '(e.g., a headline or a key number); do not transcribe everything. ' +
  'Answer in 2-3 sentences, facts only. ' +
  "If the frame is just a person talking with no visual information, reply 'talking head, no visual info'. " +
  "End with a separate line: 'citation: suitable' or 'citation: unsuitable' " +
  '(suitable = the frame is clear and helps readers understand the video; ' +
  'unsuitable = talking head, blurry, or uninformative).'

/** Short prompt for small models, tuned against Qwen3-VL-2B: facts + citation tail. */
export const VISION_PROMPT_SHORT =
  '看这张视频截图，用中文描述画面内容：画面里有什么、在发生什么。' +
  '只描述事实，不超过 2 句话，不确定的细节不要写。' +
  '若画面只是主持人口播，回复「纯口播画面」。' +
  '最后单独一行输出「配图建议：适合」或「配图建议：不适合」' +
  '（适合=画面清晰、有信息量、能帮读者理解视频内容；不适合=纯口播、模糊、无信息量）。'

/**
 * Resolve a vision model name: a tier keyword maps to the recommended small
 * model, an explicit model name passes through unchanged.
 *
 * @param model - tier keyword or explicit model name.
 * @returns the model name, or undefined when none was supplied.
 */
export function resolveVisionModel(model) {
  const text = String(model ?? '').trim()
  if (!text) return undefined
  return VISION_TIERS[text.toLowerCase()] ?? text
}

/**
 * Resolve the OpenAI-compatible base URL for a provider.
 *
 * An explicit `baseUrl` always wins. Ollama and llama.cpp have local defaults;
 * a generic `openai-compatible` endpoint must be named explicitly, so it
 * resolves to an empty string and the caller records a clear configuration
 * error instead of contacting an unknown host.
 *
 * @param provider - `none` | `ollama` | `llama-cpp` | `openai-compatible`.
 * @param baseUrl - explicit base URL, with or without a trailing slash.
 * @returns the base URL, or an empty string when none can be inferred.
 */
export function resolveVisionBaseUrl(provider, baseUrl) {
  const explicit = String(baseUrl ?? '')
    .trim()
    .replace(/\/+$/, '')
  if (explicit) return explicit
  const name = String(provider ?? '')
    .trim()
    .toLowerCase()
  if (name === 'ollama') return OLLAMA_DEFAULT_URL
  if (name === 'llama-cpp') return LLAMA_CPP_DEFAULT_URL
  return ''
}

/**
 * Classify a model name into a prompt tier.
 *
 * Tier-only names win outright; otherwise the parameter count in the model
 * name decides (2B/3B and smaller are low, 8B and larger are high).
 *
 * @param model - model name or tier keyword.
 * @returns `low` | `medium` | `high`.
 */
function visionTier(model) {
  const lower = String(model ?? '')
    .trim()
    .toLowerCase()
  if (lower === 'low' || lower === 'small') return 'low'
  if (lower === 'high' || lower === 'large') return 'high'
  if (/(?<!\d)(?:0\.5|1|1\.5|2|3)b|small|tiny/i.test(lower)) return 'low'
  if (/(?<!\d)8b|32b|72b|235b/i.test(lower)) return 'high'
  return 'medium'
}

/**
 * Pick the vision prompt for a model.
 *
 * User overrides win in this order: exact model key, tier key, global prompt.
 * Otherwise a bundled family/tier prompt is used.
 *
 * @param model - model name or tier keyword.
 * @param userPrompt - global prompt override.
 * @param promptByModel - per-model or per-tier prompt overrides.
 * @returns the prompt text.
 */
export function resolveVisionPrompt(model, userPrompt, promptByModel) {
  const name = String(model ?? '').trim()
  const byModel = promptByModel && typeof promptByModel === 'object' ? promptByModel : {}
  const globalPrompt = String(userPrompt ?? '').trim()

  if (name) {
    const exact = byModel[name] ?? byModel[name.toLowerCase()]
    if (exact && String(exact).trim()) return String(exact).trim()
  }

  const tier = visionTier(name)
  const tierOverride = byModel[tier]
  if (tierOverride && String(tierOverride).trim()) return String(tierOverride).trim()
  if (globalPrompt) return globalPrompt

  const lower = name.toLowerCase()
  if (lower.startsWith('moondream')) return VISION_PROMPT_MOONDREAM
  if (lower.startsWith('minicpm')) return VISION_PROMPT_MINICPMV
  // Qwen and any low-tier model get the short prompt; the rest gets the dense
  // content-understanding default unless the caller overrides it.
  if (lower.includes('qwen') || tier === 'low') return VISION_PROMPT_SHORT
  return DEFAULT_VISION_PROMPT
}

/**
 * Extract the per-frame citation hint from a description.
 *
 * @param text - the model's answer.
 * @returns `suitable`, `unsuitable`, or an empty string when no hint was given.
 */
export function parseCitationHint(text) {
  const value = String(text ?? '')
  const chinese = /配图建议\s*[:：]?\s*(适合|不适合)/.exec(value)
  if (chinese) return chinese[1] === '适合' ? 'suitable' : 'unsuitable'
  const english = /citation\s*[:：]?\s*(suitable|unsuitable)/i.exec(value)
  if (english) return english[1].toLowerCase()
  return ''
}

/**
 * Build an OpenAI-compatible chat/completions request with the frame inlined
 * as a base64 JPEG data URL.
 *
 * The image bytes and key stay out of logs: the caller only receives the
 * request object, and the key travels in one auth header.
 *
 * @param imageBytes - raw JPEG bytes.
 * @param opts - `model`, `prompt` and `apiKey`.
 * @returns `{ headers, body }`.
 */
export function buildVisionRequest(imageBytes, opts) {
  const prompt = String(opts?.prompt ?? '').trim() || DEFAULT_VISION_PROMPT
  const model = resolveVisionModel(opts?.model) ?? resolveVisionModel('medium') ?? 'qwen3-vl:4b'
  const headers = { 'Content-Type': 'application/json' }
  if (opts?.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`
  const encoded = Buffer.from(imageBytes).toString('base64')
  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: { url: `${JPEG_DATA_PREFIX}${encoded}` },
          },
        ],
      },
    ],
    max_tokens: 300,
  }
  return { headers, body }
}

/**
 * Parse an OpenAI-compatible chat/completions response into plain text.
 *
 * @param json - parsed response body.
 * @returns the trimmed assistant message, or an empty string when malformed.
 */
export function parseChatCompletion(json) {
  const content = json?.choices?.[0]?.message?.content
  return typeof content === 'string' ? content.trim() : ''
}

/** An abort-shaped error, so callers can distinguish cancellation. */
function abortedError() {
  const error = new Error('aborted')
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}

/**
 * Combine the caller's signal with a per-request timeout.
 * @param signal - caller cancellation, if any.
 * @param timeoutMs - per-request budget.
 * @returns a signal that aborts on either event.
 */
function requestSignal(signal, timeoutMs) {
  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_VISION_TIMEOUT_MS
  const timeout = AbortSignal.timeout(budget)
  if (!signal) return timeout
  return AbortSignal.any([signal, timeout])
}

/**
 * Describe captured frames one at a time with the configured vision endpoint.
 *
 * Only frames that already have an image are considered, capped at
 * `maxFrames` (1-20). One frame's failure is recorded as `vision_error` and the
 * loop continues; a caller abort rethrows. The base URL is required: an
 * unconfigured endpoint throws, and the tool turns that into a note while still
 * returning the captured frames.
 *
 * @param frames - captured frames with `time`, `has_image` and `path`.
 * @param opts - provider, baseUrl, model, apiKey, prompt, promptByModel,
 *   maxFrames and timeoutMs.
 * @param signal - caller cancellation.
 * @returns `{ time, description, vision_error, citation_hint }` per described frame.
 */
export async function describeFramesWithVision(frames, opts = {}, signal) {
  const baseUrl = resolveVisionBaseUrl(opts.provider, opts.baseUrl)
  if (!baseUrl) {
    throw new Error('vision endpoint not configured (set visionBaseUrl or pass vision_base_url)')
  }

  const requested =
    opts.maxFrames === undefined || opts.maxFrames === null ? 6 : Number(opts.maxFrames)
  const cap = Math.min(
    Math.max(Number.isFinite(requested) ? requested : 6, MIN_VISION_FRAMES),
    MAX_VISION_FRAMES,
  )
  // Resolve once so an empty or tier-only model picks the documented medium
  // default for both the prompt family and the request body.
  const model = resolveVisionModel(opts.model) ?? resolveVisionModel('medium') ?? 'qwen3-vl:4b'
  const prompt = resolveVisionPrompt(model, opts.prompt, opts.promptByModel)
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_VISION_TIMEOUT_MS
  const target = (Array.isArray(frames) ? frames : [])
    .filter((frame) => frame && frame.has_image && typeof frame.path === 'string' && frame.path.length > 0)
    .slice(0, cap)

  const results = []
  for (const frame of target) {
    if (signal?.aborted) throw abortedError()

    let imageBytes
    try {
      imageBytes = await readFile(frame.path)
    } catch (error) {
      const message = `frame file unreadable: ${String(error?.message ?? error)}`
      results.push({
        time: frame.time,
        description: '',
        vision_error: message.slice(-200),
        citation_hint: '',
      })
      continue
    }

    const { headers, body } = buildVisionRequest(imageBytes, {
      model,
      prompt,
      apiKey: opts.apiKey,
    })
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: requestSignal(signal, timeoutMs),
      })
      if (!response.ok) throw new Error(`vision HTTP ${response.status}`)
      const description = parseChatCompletion(await response.json())
      results.push({
        time: frame.time,
        description,
        vision_error: description ? null : 'empty vision response',
        citation_hint: parseCitationHint(description),
      })
    } catch (error) {
      // A caller cancellation is not a per-frame failure: it must propagate so
      // the capture pipeline stops instead of reporting a partial result.
      if (signal?.aborted) throw error
      results.push({
        time: frame.time,
        description: '',
        vision_error: String(error?.message ?? error).slice(-160),
        citation_hint: '',
      })
    }
  }
  return results
}
