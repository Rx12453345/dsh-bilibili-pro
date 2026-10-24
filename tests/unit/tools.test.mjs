/**
 * Registry-level tool tests: no network, no harness runtime.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { createBilibiliTools, defaultTranscriptPath } from '../../lib/tools.js'

/** Build the tool list with inert defaults. */
function tools() {
  return createBilibiliTools({
    defaults: { outDir: 'bili-out', partChars: 6000, partSeconds: 600, indexChunkSeconds: 300, gapSeconds: 10 },
    resolvePath: async (target) => target,
  })
}

test('the registry exposes the nine expected tools', () => {
  const names = tools().map((tool) => tool.name).sort()
  assert.deepEqual(names, [
    'bilibili_asr_setup',
    'bilibili_frames',
    'bilibili_login',
    'bilibili_series',
    'bilibili_subtitles',
    'bilibili_transcribe',
    'bilibili_transcript_part',
    'bilibili_transcript_search',
    'bilibili_video_info',
  ])
})

test('bilibili_frames exposes its capture parameters', () => {
  const frames = tools().find((tool) => tool.name === 'bilibili_frames')
  assert.ok(frames)
  for (const key of [
    'url',
    'page',
    'timestamps',
    'max_frames',
    'quality',
    'download_video',
    'keep_video',
    'detect_scenes',
    'scene_threshold',
    'sharp_frames',
    'scene_align_seconds',
    'vision',
    'vision_base_url',
    'vision_model',
    'vision_api_key',
    'vision_prompt',
    'vision_max_frames',
    'out_dir',
  ]) {
    assert.ok(frames.parameters.properties[key], `missing ${key}`)
  }
  assert.deepEqual(frames.parameters.required, ['url'])
  assert.equal(typeof frames.description, 'string')
  assert.ok(frames.description.length > 20)
  assert.equal(typeof frames.execute, 'function')
  assert.equal(typeof frames.output.render, 'function')
})

test('bilibili_subtitles exposes the pagination parameters', () => {
  const subtitles = tools().find((tool) => tool.name === 'bilibili_subtitles')
  assert.ok(subtitles)
  for (const key of ['url', 'page', 'part', 'cursor', 'max_chars', 'index_only', 'legacy_full', 'out_dir', 'format', 'bilingual']) {
    assert.ok(subtitles.parameters.properties[key], `missing ${key}`)
  }
  assert.deepEqual(subtitles.parameters.required, ['url'])
  assert.equal(typeof subtitles.execute, 'function')
  assert.equal(typeof subtitles.output.render, 'function')
})

test('bilibili_transcribe exposes the Bcut paged-transcript parameters', () => {
  const transcribe = tools().find((tool) => tool.name === 'bilibili_transcribe')
  assert.ok(transcribe)
  for (const key of [
    'url',
    'page',
    'provider',
    'model',
    'language',
    'part',
    'cursor',
    'max_chars',
    'index_only',
    'legacy_full',
    'format',
    'out',
    'out_dir',
  ]) {
    assert.ok(transcribe.parameters.properties[key], `missing ${key}`)
  }
  assert.deepEqual(transcribe.parameters.required, ['url'])
  assert.deepEqual(transcribe.parameters.properties.provider.enum, ['auto', 'bcut', 'faster-whisper'])
  // model/language only configure the optional local fallback; Bcut ignores them.
  assert.equal(typeof transcribe.parameters.properties.model.description, 'string')
  assert.equal(typeof transcribe.parameters.properties.language.description, 'string')
  assert.equal(transcribe.parameters.properties.keep_audio, undefined)
  assert.match(transcribe.description, /Bcut/)
  assert.match(transcribe.description, /ten minutes/)
  assert.match(transcribe.description, /bilibili_asr_setup/)
})

test('bilibili_asr_setup exposes the runtime actions and modes', () => {
  const setup = tools().find((tool) => tool.name === 'bilibili_asr_setup')
  assert.ok(setup)
  for (const key of ['action', 'mode', 'out_dir', 'confirm']) {
    assert.ok(setup.parameters.properties[key], `missing ${key}`)
  }
  assert.deepEqual(setup.parameters.required, ['action'])
  assert.deepEqual(setup.parameters.properties.action.enum, ['status', 'install', 'remove'])
  assert.deepEqual(setup.parameters.properties.mode.enum, ['persistent', 'temporary'])
  assert.equal(typeof setup.description, 'string')
  assert.match(setup.description, /faster-whisper/)
  assert.match(setup.description, /confirm: true/)
})

test('transcript part/search tools have their required arguments', () => {
  const part = tools().find((tool) => tool.name === 'bilibili_transcript_part')
  const search = tools().find((tool) => tool.name === 'bilibili_transcript_search')
  assert.ok(part)
  assert.ok(search)
  assert.deepEqual(part.parameters.required, ['url'])
  assert.ok(part.parameters.properties.max_chars)
  assert.ok(part.parameters.properties.cursor)
  assert.deepEqual(search.parameters.required, ['url', 'query'])
  assert.ok(search.parameters.properties.context_chars)
  assert.ok(search.parameters.properties.max_matches)
})

test('every tool schema is plain JSON and carries a description', () => {
  for (const tool of tools()) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 20, `${tool.name} needs a real description`)
    assert.equal(tool.parameters.type, 'object')
    assert.doesNotThrow(() => JSON.stringify(tool.parameters))
    assert.equal(typeof tool.output.schema, 'object')
  }
})

test('defaultTranscriptPath stays compatible', () => {
  assert.equal(defaultTranscriptPath('BV1xx411c7mD'), join('bilibili', 'BV1xx411c7mD', 'transcript.md'))
  assert.equal(defaultTranscriptPath('BV1xx411c7mD', 'json'), join('bilibili', 'BV1xx411c7mD', 'transcript.json'))
})
