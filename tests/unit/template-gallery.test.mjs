/**
 * Static checks for the optional HTML frame gallery.
 *
 * The visual layout still needs a human look; these tests only pin the
 * suitable-only contract and the reusable template slot.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const template = readFileSync(
  new URL('../../skills/bilibili-video-analysis/reference/template.html', import.meta.url),
  'utf8',
)
const skill = readFileSync(new URL('../../skills/bilibili-video-analysis/SKILL.md', import.meta.url), 'utf8')

test('the template ships an optional, caption-ready frame gallery', () => {
  assert.match(template, /id="frames"/)
  assert.match(template, /<div class="frames">\s*\{\{FRAME_FIGURES\}\}\s*<\/div>/)
  assert.match(template, /\.shot figcaption/)
  assert.match(template, /object-fit: contain/, 'frames must not crop the evidence')
  // The rule stays in a source comment; the delivered hint must read naturally.
  assert.match(template, /citation_hint "suitable"; 1–2 per section/)
  const hint = template.match(/<section class="card" id="frames">[\s\S]*?<p class="hint">([\s\S]*?)<\/p>/)?.[1] ?? ''
  assert.match(hint, /回看原片/)
  assert.doesNotMatch(hint, /citation_hint|1–2 张|删掉本节/)
})

test('the skill permits only suitable, existing frames at 1–2 per section', () => {
  assert.match(skill, /只放 `citation_hint: "suitable"` 且 `has_image: true` 的帧/)
  assert.match(skill, /每节 1–2 张/)
  assert.match(skill, /不要做全片截图墙/)
  assert.match(skill, /删除 `#frames` 整节/)
  assert.match(skill, /frames\/<file>\.jpg/)
  assert.match(skill, /\{\{FRAME_LINK\}\}/)
  assert.match(skill, /\?p=<PAGE>&t=<秒>/)
  assert.doesNotMatch(skill, /\{\{VIDEO_URL\}\}\?t=/)
  assert.match(skill, /不联网/)
  assert.match(skill, /frames\/cover\.jpg/)
  assert.match(skill, /不要热链 B站图片或封面/)
})
