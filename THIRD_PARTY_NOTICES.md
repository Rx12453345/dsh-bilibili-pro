# Third-party notices

`dsh-bilibili-pro` is a modified fork of two MIT-licensed packages. Both
upstream copyright notices and license grants are preserved: the original
`dsh-bilibili-summary` MIT text is in `LICENSE`, and the `dsh-bilibili` MIT
text is reproduced below.

## Upstream: dsh-bilibili-summary 0.1.3

- Copyright (c) 2026 dsh-zcode-plugins contributors
- License: MIT (see `LICENSE`)
- Source: https://github.com/Adamaik/dsh-zcode-plugins
  (`packages/bilibili-summary`)

Used as the base package: subtitle acquisition (protobuf route, XOR URL
rewrite, WBI signing), three-level validation, bilingual merge, QR login,
audio fallback with faster-whisper, series listing, and the HTML report skill.

## Upstream: dsh-bilibili 0.7.5

- Copyright (c) 2026 CZX2244
- License: MIT
- Source: https://github.com/CZX2244/dsh-bilibili

```text
MIT License

Copyright (c) 2026 CZX2244

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Portions of the design (automatically selected keyframes, targeted timestamp
capture, scene alignment and sharp-frame selection, vision descriptions,
two-pass prompts, Bcut ASR fallback, and multi-part page selection) are derived
from this package. Danmaku, all-pages batch extraction, and the old environment
checker are not ported. The transcript pagination/search layer and the
`bilibili-video-analysis` skill come from the `dsh-bilibili-summary` base.

## Bundled or external third-party code

- `qrcode-generator` (MIT, Copyright (c) Kazuhiko Arase) renders the sign-in
  QR modules. It is the only bundled dependency.
- `faster-whisper` (MIT, SYSTRAN) is installed into a private virtualenv only
  when the user chooses the optional local fallback (`bilibili_asr_setup`); it
  and its model are not bundled with this package.
- ffmpeg (LGPL-2.1-or-later or GPL depending on the build) is used as an
  external binary for audio extraction; it is not bundled.
- Bilibili web APIs are accessed under Bilibili's terms of use; the plugin
  is not affiliated with or endorsed by Bilibili.

Everything else is Node standard library plus the bundled Python script.
