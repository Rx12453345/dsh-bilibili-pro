# dsh-bilibili-pro

English | [中文](README.zh.md)

> dsh-bilibili-pro 0.2.3: validated AI/CC subtitles with a lossless, disk-backed
> transcript pagination layer (`parts`, cursor, time index, gaps) plus keyword
> search, picture-driven frame capture with optional vision descriptions, and a
> no-subtitle ASR chain: **Bcut (必剪) first**, with an **optional** on-demand
> faster-whisper fallback. No faster-whisper package, virtualenv or model is
> bundled. Attribution for both upstream packages is in `NOTICE` and
> `THIRD_PARTY_NOTICES.md`.

Bilibili video understanding for DeepSeek Harness: sign in once by QR code, pull a video's **AI/CC subtitle track**, and summarize it into a **self-contained HTML report**. When a video has no subtitle track, the plugin transcribes it with Bilibili's own Bcut ASR (no local model); if Bcut cannot handle the audio, an optional faster-whisper runtime can be installed on demand, persistently or just for one video.

Bilibili hides AI subtitles from signed-out clients, so the plugin signs in through the official passport QR flow and stores the cookie jar locally. The login code is rendered by the plugin itself and never sent to a third-party image service.

## What it adds

| Tool | Purpose |
| --- | --- |
| `bilibili_subtitles` | Extract the AI/CC subtitle track as a timestamped transcript; validates before returning, supports bilingual merge, and renders Markdown, text, SRT, ASS, LRC, or JSON |
| `bilibili_transcript_part` | Read one bounded part of the saved transcript by `part` or `cursor` (no re-fetch); `max_chars` repacks at another size and the returned cursor carries that packing |
| `bilibili_transcript_search` | Literal keyword search over the saved transcript, returning the time, part number, and surrounding context of each hit |
| `bilibili_video_info` | Metadata (title, UP, duration, description, stats, parts), the subtitle tracks the platform lists, Bilibili's own AI summary, and — when a video has no track — the comment section's long, well-liked "课代表" comments as a fallback source |
| `bilibili_transcribe` | No-subtitle fallback: Bcut (必剪) ASR first — no local model, no sign-in, lowest-bitrate audio candidate. `provider: auto` falls back to an already-installed faster-whisper runtime; with none installed it returns `status: "needs_asr_runtime"` instead of writing an empty bundle |
| `bilibili_asr_setup` | The optional faster-whisper runtime: `status` / `install` / `remove`, `mode: persistent \| temporary`. Installs only when called; persistent removal needs `confirm: true` |
| `bilibili_frames` | Capture JPEG frames at explicit moments or at automatic scene-change/even-interval points, with the nearest subtitle line and optional vision descriptions |
| `bilibili_series` | List one UP's recent uploads, their collections (合集/系列), or the videos inside one collection, to plan batch work |
| `bilibili_login` | QR sign-in (`start` / `poll` / `status` / `logout`) |

![A generated summary report](https://raw.githubusercontent.com/Adamaik/dsh-zcode-plugins/main/packages/bilibili-summary/docs/preview.png)

*A real report: info card, one-line summary, key points, and a clickable timeline that jumps back into the player.*

Plus the `bilibili-video-analysis` skill, which turns a transcript into a Chinese HTML report using a bundled template (info card → one-line summary → key points → clickable timeline → glossary → **background annotations** → quotes → action list → collapsible full script).

## Install

This package is not published to npm. Install it from the repository:

```sh
git clone https://github.com/Rx12453345/dsh-bilibili-pro.git
cd dsh-bilibili-pro
npm install
mkdir -p dist
npm pack --pack-destination dist
dsh plugin --profile <profile> add ./dist/dsh-bilibili-pro-0.2.3.tgz
```

Keep `dist/` after installing: the profile records the tarball path.

On the desktop app, **Settings → Plugins → install from a local tarball** can be used instead of the CLI command. Keep FFmpeg on `PATH` for frame capture and local audio conversion.

## Sign in

Ask the agent to summarize a Bilibili link; when the subtitle call reports that it is not signed in, it runs:

```
bilibili_login { action: "start" }   # returns a QR PNG path to show you
bilibili_login { action: "poll" }    # waits for the scan, saves the cookies
```

Scan with the Bilibili mobile app (「我的」→「扫一扫」). The cookies land in `$DSH_HOME/bilibili-cookies.json` (mode `0600`). Alternatively, skip the QR flow and put a session cookie in `$DSH_HOME/.env`:

```
BILIBILI_SESSDATA=your_sessdata_value
```

`bilibili_login { action: "status" }` reports which account is stored; `{ action: "logout" }` deletes the file.

## How the subtitles are actually fetched

The obvious-looking route is the wrong one. `x/player/v2` still carries a `subtitle.subtitles` field, but under load it answers with an unrelated or truncated body — summarizing it silently would put someone else's words in your report.

The route the web player itself uses is `x/v2/subtitle/web/view`, which answers in **protobuf**, and the paths it returns are **not fetchable as-is**:

1. `x/web-interface/view` maps the BV id to `aid`/`cid`.
2. `x/v2/subtitle/web/view?oid=<cid>&pid=<aid>&type=1&…`, WBI-signed, returns protobuf. The plugin walks the wire format directly (no generated schema, so new fields do not break it) and pulls out `lan`, `lan_doc`, and `subtitle_url`.
3. Each `//subtitle.bilibili.com/<path>` is XOR-decoded and rewritten to `//aisubtitle.hdslb.com/<path>?auth_key=…`, exactly as the player's own `F`/`U` helpers do. Those two key pairs are transcribed from `bfs/static/player/main/core.*.js`, and a unit test pins the transform so a wrong character cannot slip through again.
4. The resulting JSON's `body[]` becomes the transcript.

Because the service can still answer with a short body under rate limiting, `bilibili_subtitles` validates before returning and retries with growing backoff, re-requesting the track each time.

## What "validated" means

Coverage alone cannot tell a real transcript from a convincing fake — the legacy route returned a complete, correctly sized transcript of a *different* video. The plugin therefore scores three signals and reports a verdict:

| Verdict | Condition | What to do |
| --- | --- | --- |
| `strong` | a title keyword appears in the transcript and coverage ≥ 50 % | use it |
| `weak` | coverage ≥ 70 % but no title keyword matched (common with clickbait titles or an English title over Chinese speech) | use it, but say the match is weak |
| `fail` | too few segments, coverage < 50 %, or coverage > 200 % (a transcript longer than the video is someone else's) | refuse it and fall back |

Keyword matching covers CJK fragments (2–4 characters) and Latin tokens (3+ characters, stop-words removed), so `implement-spec`, `React`, or `海绵宝宝` all count.

## Fallback chain

1. `bilibili_subtitles` — the real track.
2. `bilibili_video_info` — Bilibili's own AI summary, plus the video description.
3. `bilibili_video_info` with `comments` — long (≥ 200 chars), well-liked (≥ 3) comments; the "课代表" summary a viewer wrote by hand. Fetched automatically when the video has no track at all.
4. `bilibili_transcribe` — Bcut (必剪) ASR: anonymous, model-free, and the default for no-subtitle videos. Bcut accepts only roughly 10 minutes of audio, so a longer no-subtitle video is rejected (poll state 3).
5. Optional local fallback: if Bcut fails, `bilibili_transcribe` reuses an already-installed faster-whisper runtime. With none installed it returns `status: "needs_asr_runtime"` with the two install choices below — it never downloads on its own.

Human-uploaded (CC) tracks are preferred over machine-generated ones for the same language, and every step that used a fallback marks the source in the report.

## Bilingual tracks and formats

`bilibili_subtitles` can merge a second track under each line — the way bilingual subtitle tools work:

```
bilibili_subtitles({ url: "BV1TXHY6aETi", lang: "ai-zh", bilingual: "ai-en", format: "srt", out: "bilingual.srt" })
```

Output formats: `markdown`, `text`, `srt`, `ass`, `lrc`, `json`.

## Background annotations in the report

A transcript is full of names that mean nothing without context. The skill requires the report to annotate them: people and teams, products and libraries, organisations, jargon and abbreviations, and the events being referenced. Each note is one or two sentences — what it is, and why the video mentions it — with a source link whenever the fact came from a web search, and an explicit `（未能核实）` when it could not be confirmed. Each marker shows the note **on hover** (a CSS-only popup, so it works offline and in any viewer), and clicking the number jumps to the full list at the end for reading straight through or printing. The popup and the appendix are generated from the same text, so they cannot drift apart.

## No-subtitle videos: Bcut, then optional faster-whisper

Videos whose subtitles are burned into the picture have no track to extract. `bilibili_transcribe` handles them:

1. resolve the audio through `x/player/wbi/playurl` and pick the **lowest-bitrate** DASH candidate (Bcut accepts the low one when it rejects 212 kbps);
2. submit it to Bcut (必剪). On success the result is shaped exactly like a subtitle track, marked as machine transcription (`source: "asr"`, `track.route: "bcut"`).

Bcut rejects audio longer than roughly 10 minutes. For those videos the assistant can offer an **optional** faster-whisper fallback, with two explicit choices:

- **persistent** — `bilibili_asr_setup { action: "install", mode: "persistent" }` creates `$DSH_HOME/bilibili-asr/{venv,models}`; the venv and downloaded model are kept and reused by every later video.
- **temporary** — `bilibili_asr_setup { action: "install", mode: "temporary", out_dir: "..." }` creates `<out_dir>/.asr-runtime`; after the transcript bundle is written the venv and model are deleted. A temp state file under `$DSH_HOME/bilibili-asr` lets a later call find it even from another `out_dir`.

Neither mode is ever started automatically. If Bcut fails and no runtime exists, `bilibili_transcribe` returns `status: "needs_asr_runtime"` with `bcut_error`, both options, and an estimated model size instead of writing an empty bundle. `install` creates the virtualenv and pip-installs faster-whisper but **does not download the model**; the first local transcription does (`small` ≈ 500 MB, `medium` ≈ 1.5 GB). The plugin bundles no faster-whisper package, venv, or model — GitHub "install and use" still means Bcut works immediately, and faster-whisper is an opt-in extra. Point `asrPython` at an existing interpreter with faster-whisper to skip the install entirely; `bilibili_asr_setup { action: "status" }` probes it and reports whether a runtime is already usable.

The installer pins PyAV below 19 (`faster-whisper` + `av<19`) for now: PyAV 19 removed the `av.open(..., metadata_errors=...)` argument that faster-whisper 1.2.1 still passes, so an unpinned install would fail as soon as the model opens the audio. When transcribing locally, the audio is downloaded by Node (with the Bilibili referer and a size cap) and converted by ffmpeg from that local file — not by ffmpeg opening the remote URL — because ffmpeg's own TLS stack may reject the local proxy CA.

Real verification on a 9-minute no-subtitle video (`BV1hhHi65EnQ`): Bcut returned 159 utterances / 5,682 chars; the optional `faster-whisper` `small` model returned 103 segments / 5,464 chars in 107 seconds on CPU, with `source: "asr"` and the same paged bundle. Both results were readable through `bilibili_transcript_part` and `bilibili_transcript_search`. The model/venv are not shipped; they live only in the chosen runtime directory.

## Configure

Every field is optional. Row config in a profile patch layer:

```yaml
- id: bilibili-pro
  name: 'dsh-bilibili-pro'
  config:
    cookieFile: ~/.dsh/bilibili-cookies.json
    sessdata: ''
    language: ai-zh
    retries: 6
    retryBaseDelayMs: 8000
    timeoutMs: 20000
    ffmpegPath: ''
    bcutTimeoutMs: 600000
    bcutPollMs: 5000
    asrPython: ''
    asrVenv: ''
    asrModel: small
    asrModelDir: ''
    asrLanguage: auto
```

| Field | Default | Meaning |
| --- | --- | --- |
| `cookieFile` | `$DSH_HOME/bilibili-cookies.json` | Where the session is stored |
| `sessdata` | `''` | Explicit `SESSDATA`; overrides the file |
| `language` | `ai-zh` | Preferred subtitle track |
| `retries` | `6` | Subtitle attempts before giving up |
| `retryBaseDelayMs` | `8000` | First backoff; each attempt adds 3 s |
| `timeoutMs` | `20000` | Per-request timeout |
| `ffmpegPath` | autodetect | ffmpeg binary for the optional local fallback |
| `bcutTimeoutMs` | `600000` | Overall Bcut polling budget |
| `bcutPollMs` | `5000` | Bcut result poll interval |
| `asrPython` | `''` | Existing Python with faster-whisper; skips the install |
| `asrVenv` | `$DSH_HOME/bilibili-asr/venv` | Persistent fallback virtualenv |
| `asrModel` | `small` | faster-whisper model for the optional fallback |
| `asrModelDir` | `$DSH_HOME/bilibili-asr/models` | Model cache |
| `asrLanguage` | `auto` | Spoken language for the optional fallback |

`BILIBILI_SESSDATA` and `BILIBILI_COOKIE_FILE` in the environment or `$DSH_HOME/.env` work too. `BILIBILI_ASR_PYTHON` (or `PYTHON`) points the optional fallback at an interpreter without editing the config.

## Usage

```
bilibili_video_info({ url: "https://www.bilibili.com/video/BV1puH46qE5x/" })
bilibili_subtitles({ url: "BV1c3HL6qEyq", out: "bilibili/BV1c3HL6qEyq/transcript.md" })
bilibili_subtitles({ url: "BV1TXHY6aETi", lang: "ai-zh", bilingual: "ai-en", format: "srt", out: "bilibili/BV1TXHY6aETi/bilingual.srt" })
bilibili_transcribe({ url: "BV1puH46qE5x" })                         # Bcut, no local install
bilibili_transcribe({ url: "BV1puH46qE5x", provider: "faster-whisper" })  # only with an installed runtime
bilibili_asr_setup({ action: "status" })                               # both runtimes, no side effects
bilibili_asr_setup({ action: "install", mode: "temporary", out_dir: "bili-out" })
bilibili_asr_setup({ action: "remove", mode: "temporary" })
bilibili_series({ url: "https://space.bilibili.com/588699709", kind: "collections" })
```

`bilibili_subtitles` returns the video record, the chosen track, validation/coverage stats, the on-disk manifest, and one bounded `part` plus `next_cursor` by default; pass `legacy_full: true` for the old full `timeline`/`transcript`/`segments` shape. `bilibili_transcript_part` and `bilibili_transcript_search` read the saved bundle (following a repacked cursor restores its packing). `bilibili_transcribe` uses the same paged bundle, so the same part/search tools work on ASR results; its `source` is `asr` and `asr.provider` is `bcut` or `faster-whisper`.

## Limitations

- Chinese-first: the default track is `ai-zh`; other languages work through `lang`.
- Bcut is a Bilibili service with a practical limit of roughly 10 minutes of audio; longer no-subtitle videos need the optional local fallback (or another source such as Bilibili's AI summary / comment section).
- The optional faster-whisper fallback is not bundled: it downloads a model on first local use, and transcription quality tracks the chosen model; `small` is a speed/accuracy compromise. Bcut output usually has no punctuation; faster-whisper adds punctuation but both can mis-hear homophones.
- Bilibili rate-limits aggressively; a failed extraction is usually temporary.
- Multi-part videos are summarized one part at a time through the `page` argument.

## Upstream and attribution

This is an **independent package**, not a GitHub fork of a single upstream repository.
It is derived from `dsh-bilibili-summary` 0.1.3, which lives inside the
[`Adamaik/dsh-zcode-plugins`](https://github.com/Adamaik/dsh-zcode-plugins) monorepo at
`packages/bilibili-summary`. It also draws design from
[`CZX2244/dsh-bilibili`](https://github.com/CZX2244/dsh-bilibili) 0.7.5. GitHub forks are
repository-level, so a standalone plugin cannot carry a “forked from a subdirectory” badge;
the lineage is recorded in [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
