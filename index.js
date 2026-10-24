/**
 * Bilibili video analysis for DeepSeek Harness.
 *
 * This bundle registers one skill and the Bilibili tools: a QR sign-in that
 * stores the session cookies, a metadata reader that also surfaces Bilibili's
 * own AI summary, the subtitle extractor, and the transcript paging/search
 * helpers. The extractor is deliberately defensive: the player route
 * rate-limits by returning empty, unrelated, or truncated bodies, so it
 * validates coverage and retries instead of handing the model someone else's
 * transcript.
 *
 * Long transcripts are written to disk and read back one part at a time, so a
 * two-hour video never has to fit in a single tool result. The skill on top
 * turns a transcript into a self-contained HTML report.
 *
 * @module dsh-bilibili-pro
 */

import { readFileSync } from 'node:fs'
import { resolve as resolveNodePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import { TWO_PASS_SYSTEM_PROMPT } from './lib/prompts.js'
import { createBilibiliTools } from './lib/tools.js'

/** Cordis plugin name. */
export const name = 'bilibili-pro'

/** Services required for registration; the filesystem service is read lazily when present. */
export const inject = ['skills', 'tools']

/** Plugin configuration. Every field has a default, so an empty config is valid. */
export const Config = Schema.object({
  sessdata: Schema.string().default(''),
  cookieFile: Schema.string().default(''),
  language: Schema.string().default('ai-zh'),
  retries: Schema.natural().default(6),
  retryBaseDelayMs: Schema.natural().default(8000),
  timeoutMs: Schema.natural().default(20000),
  outDir: Schema.string().default('bili-out'),
  partChars: Schema.natural().default(6000),
  partSeconds: Schema.natural().default(600),
  indexChunkSeconds: Schema.natural().default(300),
  gapSeconds: Schema.natural().default(10),
  ffmpegPath: Schema.string().default(''),
  maxFrames: Schema.natural().default(6),
  quality: Schema.natural().default(64),
  downloadVideo: Schema.boolean().default(true),
  keepVideo: Schema.boolean().default(false),
  maxVideoMinutes: Schema.natural().default(60),
  maxDownloadMb: Schema.natural().default(1500),
  detectScenes: Schema.boolean().default(true),
  sceneThreshold: Schema.number().default(0.4),
  sharpFrames: Schema.boolean().default(true),
  sceneAlignSeconds: Schema.number().default(4),
  frameTimeoutMs: Schema.natural().default(20000),
  videoCacheHours: Schema.natural().default(24),
  visionProvider: Schema.string().default('none'),
  visionBaseUrl: Schema.string().default(''),
  visionModel: Schema.string().default('medium'),
  visionApiKey: Schema.string().default(''),
  visionPrompt: Schema.string().default(''),
  visionPromptByModel: Schema.dict(Schema.string()).default({}),
  visionMaxFrames: Schema.natural().default(6),
  visionTimeoutMs: Schema.natural().default(120000),
  bcutTimeoutMs: Schema.natural().default(600000),
  bcutPollMs: Schema.natural().default(5000),
  // Optional faster-whisper fallback. Bcut is the default; these fields are only
  // used when a runtime already exists (or after bilibili_asr_setup installs it).
  // Nothing here installs or downloads by itself.
  asrPython: Schema.string().default(''),
  asrVenv: Schema.string().default(''),
  asrModel: Schema.string().default('small'),
  asrModelDir: Schema.string().default(''),
  asrLanguage: Schema.string().default('auto'),
})

/** Skill directory shipped by this package. */
const SKILL_DIR = new URL('./skills/bilibili-video-analysis/', import.meta.url)

/** Routing description for the bundled skill. */
const DESCRIPTION =
  'Analyze a Bilibili video from its validated AI/CC subtitle track, or from Bilibili\'s own Bcut (必剪) ' +
  'ASR when the video has no track, with a paged and searchable transcript and picture-driven frame ' +
  'capture through bilibili_frames at requested moments or scene changes; an optional faster-whisper ' +
  'runtime (installed on demand with bilibili_asr_setup, never bundled) covers audio Bcut rejects, and ' +
  'optional vision descriptions and citation hints are available when a local Ollama/llama.cpp or ' +
  'OpenAI-compatible endpoint is configured. Use when the user shares a bilibili.com or b23.tv video ' +
  'link and asks for a summary, notes, transcript, highlights, frames, or a written report; also use to ' +
  'pull or search just the subtitle text. Not for other video sites.'

/**
 * Strip one leading YAML frontmatter block.
 * @param text - raw SKILL.md content.
 * @returns the instruction body without frontmatter.
 */
function skillBody(text) {
  if (!text.startsWith('---')) return text
  const end = text.indexOf('\n---', 3)
  if (end === -1) return text
  const bodyStart = text.indexOf('\n', end + 1)
  return bodyStart === -1 ? '' : text.slice(bodyStart + 1)
}

/**
 * Register the skill and the Bilibili tools.
 * @param ctx - Cordis context.
 * @param config - validated plugin configuration.
 */
export function apply(ctx, config = {}) {
  ctx.skills.register({
    name: 'bilibili-video-analysis',
    description: DESCRIPTION,
    content: skillBody(readFileSync(new URL('SKILL.md', SKILL_DIR), 'utf8')),
    resourceBase: { kind: 'directory', path: fileURLToPath(SKILL_DIR) },
    provider: 'bilibili-pro',
    source: 'bundled',
  })
  const resolveOutput = async (target, exec) => {
    const cwd = exec?.agent?.session?.header?.cwd
    const fs = ctx.get ? ctx.get('fs') : ctx.fs
    if (!fs) return resolveNodePath(cwd ?? process.cwd(), target)
    const options = { ...(cwd ? { cwd } : {}), ...(exec?.signal ? { signal: exec.signal } : {}) }
    return fs.processPath(await fs.resolve(target, options))
  }
  const defaults = {
    sessdata: config.sessdata ?? '',
    cookieFile: config.cookieFile ?? '',
    language: config.language ?? 'ai-zh',
    retries: config.retries ?? 6,
    retryBaseDelayMs: config.retryBaseDelayMs ?? 8000,
    timeoutMs: config.timeoutMs ?? 20000,
    outDir: config.outDir ?? 'bili-out',
    partChars: config.partChars ?? 6000,
    partSeconds: config.partSeconds ?? 600,
    indexChunkSeconds: config.indexChunkSeconds ?? 300,
    gapSeconds: config.gapSeconds ?? 10,
    ffmpegPath: config.ffmpegPath ?? '',
    maxFrames: config.maxFrames ?? 6,
    quality: config.quality ?? 64,
    downloadVideo: config.downloadVideo ?? true,
    keepVideo: config.keepVideo ?? false,
    maxVideoMinutes: config.maxVideoMinutes ?? 60,
    maxDownloadMb: config.maxDownloadMb ?? 1500,
    detectScenes: config.detectScenes ?? true,
    sceneThreshold: config.sceneThreshold ?? 0.4,
    sharpFrames: config.sharpFrames ?? true,
    sceneAlignSeconds: config.sceneAlignSeconds ?? 4,
    frameTimeoutMs: config.frameTimeoutMs ?? 20000,
    videoCacheHours: config.videoCacheHours ?? 24,
    visionProvider: config.visionProvider ?? 'none',
    visionBaseUrl: config.visionBaseUrl ?? '',
    visionModel: config.visionModel ?? 'medium',
    visionApiKey: config.visionApiKey ?? '',
    visionPrompt: config.visionPrompt ?? '',
    visionPromptByModel: config.visionPromptByModel ?? {},
    visionMaxFrames: config.visionMaxFrames ?? 6,
    visionTimeoutMs: config.visionTimeoutMs ?? 120000,
    bcutTimeoutMs: config.bcutTimeoutMs ?? 600000,
    bcutPollMs: config.bcutPollMs ?? 5000,
    asrPython: config.asrPython ?? '',
    asrVenv: config.asrVenv ?? '',
    asrModel: config.asrModel ?? 'small',
    asrModelDir: config.asrModelDir ?? '',
    asrLanguage: config.asrLanguage ?? 'auto',
  }
  for (const tool of createBilibiliTools({ resolvePath: resolveOutput, defaults })) ctx.tools.register(tool)

  // Publish the compact two-pass guidance through optional injection: the
  // plugin still loads when the harness has no prompt service. The workflow
  // plugin uses the same pattern, and `systemPrompt.section` returns its own
  // disposer, which `effect` ties to this plugin's lifetime.
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(
      () =>
        promptCtx.systemPrompt.section({
          name: 'tool:bilibili_frames',
          order: 160,
          text: TWO_PASS_SYSTEM_PROMPT,
        }),
      'dsh-bilibili-pro: two-pass frame guidance',
    )
  })
}
