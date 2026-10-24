/**
 * Vision helper unit tests: pure functions, no network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_VISION_PROMPT,
  VISION_PROMPT_SHORT,
  buildVisionRequest,
  describeFramesWithVision,
  parseChatCompletion,
  parseCitationHint,
  resolveVisionBaseUrl,
  resolveVisionModel,
  resolveVisionPrompt,
} from '../../lib/vision.js'
import * as plugin from '../../index.js'

const OLLAMA_BASE = 'http://localhost:11434/v1'
const LLAMA_CPP_BASE = 'http://localhost:8080/v1'
const EXPLICIT_BASE = 'http://explicit.vision:9000/v1'
const JPEG_PREFIX = 'data:image/jpeg;base64,'

test('resolveVisionModel maps the three tiers and passes explicit names through', () => {
  assert.equal(resolveVisionModel('low'), 'qwen3-vl:2b')
  assert.equal(resolveVisionModel('small'), 'qwen3-vl:2b')
  assert.equal(resolveVisionModel('medium'), 'qwen3-vl:4b')
  assert.equal(resolveVisionModel('high'), 'qwen3-vl:8b')
  assert.equal(resolveVisionModel('large'), 'qwen3-vl:8b')
  assert.equal(resolveVisionModel('  MEDIUM  '), 'qwen3-vl:4b')
  assert.equal(resolveVisionModel('qwen2.5-vl:7b'), 'qwen2.5-vl:7b')
  assert.equal(resolveVisionModel('moondream2'), 'moondream2')
  assert.equal(resolveVisionModel(''), undefined)
  assert.equal(resolveVisionModel(undefined), undefined)
})

test('resolveVisionBaseUrl prefers an explicit URL and defaults per provider', () => {
  assert.equal(resolveVisionBaseUrl('ollama'), OLLAMA_BASE)
  assert.equal(resolveVisionBaseUrl('llama-cpp'), LLAMA_CPP_BASE)
  assert.equal(resolveVisionBaseUrl('openai-compatible'), '')
  assert.equal(resolveVisionBaseUrl('none'), '')
  assert.equal(resolveVisionBaseUrl(undefined), '')
  assert.equal(resolveVisionBaseUrl('openai-compatible', '  '), '')
  assert.equal(resolveVisionBaseUrl('openai-compatible', `${EXPLICIT_BASE}///`), EXPLICIT_BASE)
  assert.equal(resolveVisionBaseUrl('ollama', EXPLICIT_BASE), EXPLICIT_BASE, 'an explicit URL beats the default')
})

test('resolveVisionPrompt prefers exact, then tier, then global overrides', () => {
  const promptByModel = {
    'qwen3-vl:4b': 'exact model prompt',
    high: 'high tier prompt',
    'moondream2': 'exact moondream prompt',
  }
  assert.equal(resolveVisionPrompt('qwen3-vl:4b', 'global prompt', promptByModel), 'exact model prompt')
  assert.equal(resolveVisionPrompt('qwen3-vl:8b', 'global prompt', promptByModel), 'high tier prompt')
  assert.equal(resolveVisionPrompt('qwen3-vl:4b', 'global prompt'), 'global prompt')
  assert.equal(resolveVisionPrompt('qwen3-vl:4b', '', promptByModel), 'exact model prompt')
})

test('resolveVisionPrompt falls back to bundled family and tier prompts', () => {
  const moondream = resolveVisionPrompt('moondream2')
  assert.match(moondream, /citation: suitable/)
  assert.match(moondream, /2-3 sentences/)

  const minicpm = resolveVisionPrompt('minicpm-v:8b')
  assert.match(minicpm, /图表/)
  assert.match(minicpm, /配图建议：适合/)

  const qwen = resolveVisionPrompt('qwen3-vl:8b')
  assert.equal(qwen, VISION_PROMPT_SHORT)
  assert.equal(resolveVisionPrompt('low'), VISION_PROMPT_SHORT)
  assert.equal(resolveVisionPrompt(''), DEFAULT_VISION_PROMPT)
  assert.match(DEFAULT_VISION_PROMPT, /2-3 句话/)
  assert.match(DEFAULT_VISION_PROMPT, /配图建议：适合/)
})

test('parseCitationHint reads Chinese and English tails and tolerates absence', () => {
  assert.equal(parseCitationHint('画面清晰。配图建议：适合'), 'suitable')
  assert.equal(parseCitationHint('纯口播。配图建议: 不适合'), 'unsuitable')
  assert.equal(parseCitationHint('配图建议 适合'), 'suitable')
  assert.equal(parseCitationHint('citation: suitable'), 'suitable')
  assert.equal(parseCitationHint('CITATION：UNSUITABLE'), 'unsuitable')
  assert.equal(parseCitationHint('no hint here'), '')
  assert.equal(parseCitationHint(undefined), '')
})

test('buildVisionRequest embeds a base64 JPEG payload and only sends a key when configured', () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
  const encoded = bytes.toString('base64')

  const plain = buildVisionRequest(bytes, { model: 'medium' })
  assert.equal(plain.headers.Authorization, undefined)
  assert.equal(plain.body.model, 'qwen3-vl:4b')
  assert.equal(buildVisionRequest(bytes, {}).body.model, 'qwen3-vl:4b', 'an empty model defaults to medium')
  assert.equal(plain.body.max_tokens, 300)
  assert.equal(plain.body.messages[0].role, 'user')
  assert.equal(plain.body.messages[0].content[0].text, DEFAULT_VISION_PROMPT)
  assert.equal(plain.body.messages[0].content[1].image_url.url, `${JPEG_PREFIX}${encoded}`)
  assert.ok(JSON.stringify(plain.body).includes(encoded), 'the request must carry the image bytes')

  const key = 'sk-unit-test-key'
  const withKey = buildVisionRequest(bytes, { model: 'high', prompt: 'custom', apiKey: key })
  const expected = ['Bearer', key].join(' ')
  assert.equal(withKey.headers.Authorization, expected)
  assert.equal(withKey.body.model, 'qwen3-vl:8b')
  assert.equal(withKey.body.messages[0].content[0].text, 'custom')
  assert.ok(!JSON.stringify(withKey.body).includes(key), 'the key must never enter the request body')
})

test('parseChatCompletion accepts a normal response and rejects malformed ones', () => {
  assert.equal(parseChatCompletion({ choices: [{ message: { content: '  画面内容  ' } }] }), '画面内容')
  assert.equal(parseChatCompletion({}), '')
  assert.equal(parseChatCompletion(null), '')
  assert.equal(parseChatCompletion({ choices: [] }), '')
  assert.equal(parseChatCompletion({ choices: [{ message: { content: 42 } }] }), '')
})

test('describeFramesWithVision requires a configured endpoint', async () => {
  await assert.rejects(
    describeFramesWithVision([], { provider: 'openai-compatible' }),
    /vision endpoint not configured/,
  )
})

test('the plugin config exposes vision defaults with none as the provider', () => {
  const config = plugin.Config({})
  assert.equal(config.visionProvider, 'none')
  assert.equal(config.visionBaseUrl, '')
  assert.equal(config.visionModel, 'medium')
  assert.equal(config.visionApiKey, '')
  assert.equal(config.visionPrompt, '')
  assert.deepEqual(config.visionPromptByModel, {})
  assert.equal(config.visionMaxFrames, 6)
  assert.equal(config.visionTimeoutMs, 120000)
})
