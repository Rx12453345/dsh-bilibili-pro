/**
 * The two-pass guidance is model-facing text, so it is tested as a contract:
 * it must describe both passes with the tools that actually exist, and it must
 * not promise the Phase 3/5 features that are not built yet.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TWO_PASS_SYSTEM_PROMPT } from '../../lib/prompts.js'
import * as plugin from '../../index.js'

test('the prompt covers both passes and reads the transcript first', () => {
  assert.match(TWO_PASS_SYSTEM_PROMPT, /第一段/)
  assert.match(TWO_PASS_SYSTEM_PROMPT, /第二段/)
  assert.match(TWO_PASS_SYSTEM_PROMPT, /bilibili_subtitles/)
  assert.match(TWO_PASS_SYSTEM_PROMPT, /bilibili_transcript_part/)
  assert.match(TWO_PASS_SYSTEM_PROMPT, /bilibili_transcript_search/)
  assert.ok(TWO_PASS_SYSTEM_PROMPT.indexOf('bilibili_subtitles') < TWO_PASS_SYSTEM_PROMPT.indexOf('bilibili_frames'))
})

test('the prompt names the five information gaps', () => {
  for (const gap of ['指代悬空', '结论先行', '操作无口述', '无声演示', '视觉对比']) {
    assert.match(TWO_PASS_SYSTEM_PROMPT, new RegExp(gap))
  }
})

test('the prompt lists [建议抓帧] moments and calls bilibili_frames with timestamps', () => {
  assert.match(TWO_PASS_SYSTEM_PROMPT, /\[建议抓帧\] mm:ss 理由/)
  assert.match(TWO_PASS_SYSTEM_PROMPT, /bilibili_frames\(url, timestamps: \[/)
  assert.match(TWO_PASS_SYSTEM_PROMPT, /max_frames: 6/)
})

test('the prompt covers multi-page, login and a missing ffmpeg', () => {
  assert.match(TWO_PASS_SYSTEM_PROMPT, /page: N/)
  assert.match(TWO_PASS_SYSTEM_PROMPT, /bilibili_login/)
  assert.match(TWO_PASS_SYSTEM_PROMPT, /action=start/)
  assert.match(TWO_PASS_SYSTEM_PROMPT, /action=poll/)
  assert.match(TWO_PASS_SYSTEM_PROMPT, /ffmpeg/i)
  assert.match(TWO_PASS_SYSTEM_PROMPT, /ffmpegPath/)
})

test('the prompt warns about no-subtitle videos longer than 10 minutes before Bcut', () => {
  assert.match(TWO_PASS_SYSTEM_PROMPT, /video\.duration/)
  assert.match(TWO_PASS_SYSTEM_PROMPT, /page\.duration/)
  assert.match(TWO_PASS_SYSTEM_PROMPT, /600 秒/)
  assert.match(TWO_PASS_SYSTEM_PROMPT, /先主动告诉用户/)
  assert.match(TWO_PASS_SYSTEM_PROMPT, /10 分钟/)
})

test('the prompt does not promise unimplemented features', () => {
  assert.ok(!TWO_PASS_SYSTEM_PROMPT.includes('bilibili_extract'))
  assert.ok(!/vision/i.test(TWO_PASS_SYSTEM_PROMPT))
  assert.ok(!/description/i.test(TWO_PASS_SYSTEM_PROMPT))
  assert.ok(!/citation_hint/i.test(TWO_PASS_SYSTEM_PROMPT))
  assert.ok(!/bilibili_doctor/.test(TWO_PASS_SYSTEM_PROMPT))
})

test('the plugin keeps the prompt service optional and still validates its frame config', () => {
  assert.equal(plugin.name, 'bilibili-pro')
  // systemPrompt is injected optionally inside apply(); adding it to the hard
  // inject array would stop the whole plugin from loading without that service.
  assert.deepEqual(plugin.inject, ['skills', 'tools'])
  assert.equal(typeof plugin.apply, 'function')

  const config = plugin.Config({})
  assert.equal(config.maxFrames, 6)
  assert.equal(config.quality, 64)
  assert.equal(config.downloadVideo, true)
  assert.equal(config.keepVideo, false)
  assert.equal(config.maxVideoMinutes, 60)
  assert.equal(config.maxDownloadMb, 1500)
  assert.equal(config.detectScenes, true)
  assert.equal(config.sceneThreshold, 0.4)
  assert.equal(config.sharpFrames, true)
  assert.equal(config.sceneAlignSeconds, 4)
})

test('apply publishes the two-pass section through optional injection', () => {
  // A plain mock stands in for the two host services; this deliberately does not
  // instantiate the Cordis app.
  const sections = []
  const tools = []
  let injected = []
  const ctx = {
    skills: { register: () => {} },
    tools: { register: (tool) => tools.push(tool.name) },
    inject: (services, callback) => {
      injected = services
      callback({
        effect: (execute) => execute(),
        systemPrompt: { section: (section) => sections.push(section) },
      })
    },
  }

  plugin.apply(ctx, plugin.Config({}))

  assert.deepEqual(injected, ['systemPrompt'])
  assert.equal(tools.length, 9)
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'tool:bilibili_frames')
  assert.equal(sections[0].order, 160)
  assert.equal(sections[0].text, TWO_PASS_SYSTEM_PROMPT)
})
