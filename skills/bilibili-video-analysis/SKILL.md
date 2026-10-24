---
name: bilibili-video-analysis
description: "Analyze a Bilibili video from its validated AI/CC subtitle track, or from Bilibili's Bcut (必剪) ASR when the video has no track (with an optional, user-approved faster-whisper runtime for audio Bcut rejects), with a lossless paged and searchable transcript and picture-driven frame capture through bilibili_frames, plus optional vision descriptions and citation hints when a local or OpenAI-compatible endpoint is configured. Annotates proper nouns and background that a reader cannot understand out of context. Use when the user shares a bilibili.com, b23.tv, or BV link and asks for a summary, notes, key points, a transcript, highlights, frames, or a written/HTML report; also use when only the subtitle text is wanted, when the transcript must be searched, or when a channel or series must be summarized in batch. Not for other video sites."
metadata:
  author: dsh-zcode-plugins
  version: "0.2.3"
---

# B站视频汇总

把一条 B站视频变成一份可阅读、可点击跳转、**自带背景注释**的 HTML 汇总文档。字幕优先走官方字幕服务；没有字幕就逐级降级。

## 工具

| 工具 | 用途 |
| --- | --- |
| `bilibili_subtitles` | 抽取官方 AI/CC 字幕（protobuf 服务 + 播放器 URL 重签），三级校验后才返回；默认落盘完整文稿并返回 manifest + 第 1 段；支持 `part`/`cursor`/`index_only`/`legacy_full`、`bilingual` 双语合并，输出 md/txt/srt/ass/lrc/json |
| `bilibili_transcript_part` | 按 `part` 或 `cursor` 读取文稿的一段（无需重新抓字幕）；可用 `max_chars` 重新切分，返回的 cursor 会带上 packing |
| `bilibili_transcript_search` | 在文稿里做纯子串检索，返回时间、part 编号与上下文 |
| `bilibili_frames` | 按显式 `timestamps` 定向抓帧，或自动场景变化 + 均匀补帧；返回帧图绝对路径与最近字幕；可选 `vision` 返回画面描述与 `citation_hint` |
| `bilibili_video_info` | 元信息、字幕轨道清单、B站 AI 总结；**视频无字幕时默认附带评论区长评**（降级来源） |
| `bilibili_transcribe` | 无字幕兜底：默认 B站必剪（Bcut）ASR，无需登录/本地模型；落盘同款分段 bundle（`source: "asr"`），默认返回 manifest + 第 1 段；实测只接受约 10 分钟以内的音频。Bcut 失败时复用已安装的 faster-whisper 运行时，没有则返回 `needs_asr_runtime` |
| `bilibili_asr_setup` | 可选 faster-whisper 运行时：`status` / `install` / `remove`，`mode: persistent \| temporary`；只有被调用时才安装，长期运行时删除需 `confirm: true` |
| `bilibili_series` | 列 UP 的最近投稿 / 合集系列 / 合集内视频，用于批量任务 |
| `bilibili_login` | 扫码登录，Cookie 存到 `$DSH_HOME/bilibili-cookies.json` |

## 取内容：按顺序降级，不要跳步

1. **先探路**：`bilibili_video_info({ url })`，看 `tracks` 与 `aiSummary`。
2. **有字幕轨道** → `bilibili_subtitles({ url })`（自动落盘到 `bili-out/<bvid>/`，默认只返回 manifest + 第 1 段）
   - 未登录会明确报错：`bilibili_login { action: "start" }` → 用 `![登录二维码](<qrPath>)` 展示 → 用户扫码 → `{ action: "poll" }` → 重试。
   - 工具做**三级校验**：标题关键词命中 + 时长覆盖率 + 时长异常检测，返回 `strong / weak / fail`。
     - `strong`：命中关键词且覆盖 ≥ 50%，可直接使用。
     - `weak`：覆盖率 ≥ 70% 但关键词零命中（标题党或纯英文标题常见），可用，但要在文档里标注"弱校验"。
     - `fail`：段数不足、覆盖 < 50% 或 > 200%（多半是别的视频的字幕/被限流截断）→ **绝不采信**，继续降级或稍后重试。
3. **无字幕** → `bilibili_transcribe({ url })`：默认走 B站必剪（Bcut）ASR，不需要登录、不下载音频、不用本地模型；它写的是和字幕工具同款的 `bili-out/<bvid>/` 分段 bundle（`source: "asr"`），默认返回 manifest + 第 1 段，之后照样用 `bilibili_transcript_part` / `bilibili_transcript_search`。**实测 Bcut 只接受约 10 分钟以内的音频**，更长的视频会被拒绝（poll 到 `state 3`）；被拒绝时不要反复重试。
   - **如果 `bilibili_video_info.video.duration`（多P看 `page.duration`）超过 600 秒，在调用 Bcut 前主动告诉用户**：这超过 Bcut 的约 10 分钟上限，长视频可能被拒绝；有本地 faster-whisper 会继续，否则会返回安装选项。不要让用户干等，也不要在转写卡住后才解释。
4. **Bcut 失败且返回 `status: "needs_asr_runtime"`** → 插件没有内置 faster-whisper 或模型，也**绝不自动安装**。把 `bcut_error` 和两种选择原样转达用户（模型首次本地转写需下载，`small` 约 500 MB）：
   - `persistent`：长期安装到 DSH home，venv+模型保留，之后所有视频复用；
   - `temporary`：只为当前视频安装在 `out_dir/.asr-runtime`，转写完成后自动删除。
   等用户明确选择后，调用 `bilibili_asr_setup({ action: "install", mode: "persistent" | "temporary", out_dir? })`，再重试 `bilibili_transcribe({ url })`。用户不想安装时，用 `bilibili_video_info` 的 `aiSummary`（标注"依据 B站 AI 总结"）或 `comments` 评论区长评（标注"依据评论区长评"）写出文档，并说明完整转写需要其他方案。
5. **写 HTML**：读 `reference/template.html`，填充后写到 `bilibili/<bvid>/<slug>.html`；交付时用 `present` 给出文件卡片。
   - 如果启用了 vision，并且有 `citation_hint: "suitable"` 的帧，按“画面画廊”一节插入 1–2 张；没有合适画面就删除模板里的 `#frames` 整节。

批量任务：`bilibili_series` 列出视频后，对其中每条重复第 1–5 步；一次只汇总用户点名的那几集，不要默默扩大范围。

## 长文稿（分段 / 检索）

`bilibili_subtitles` 不再一次性返回全文。它会把完整文稿写到 `bili-out/<BVID>/`：

- `transcript.json` / `transcript.md`：归一化 segments 与完整时间轴；
- `parts/index.json`：manifest（`parts`、`index`、`gaps`、`files`）；
- `parts/part-001.md` / `part-001.json`：逐段文件。

返回值的 `manifest.parts` 是轻量索引，`part` 是当前段的正文，`next_cursor` 指向下一段。普通 cursor 是 `<page>-<part>`，按配置的默认 packing（`partChars`，默认 6000）解释；当本次落盘或重切的 packing 与默认不同时，cursor 变成 `<page>-<part>@<maxChars>`，把 packing 一起带在 cursor 里。

读长文稿的顺序：

1. 先看 `manifest`：`stats`（字数/段数/分段数/缺口数）、`parts` 预览、`index`（约每 5 分钟一条）、`gaps`（字幕断档；阈值由配置 `gapSeconds` 决定，默认 ≥ 10 秒）。
2. 用 `bilibili_transcript_part({ url, part: N })` 或 `{ url, cursor: next_cursor }` 逐段读，不要要求一次返回全文。cursor 自带 page：分P视频只传 cursor 即可；若同时传 `page`，必须与 cursor 里的 page 一致，否则会报错。
3. 用 `bilibili_transcript_search({ url, query })` 定位关键词，再读对应 part。
4. 需要全文时直接 `read` 磁盘上的 `transcript.md` / `transcript.json`（分块读），不要依赖工具结果。
5. `gaps` 只是“这里字幕可能不完整”的候选信号，不是画面内容；两段式抓帧会优先参考它。

`bilibili_subtitles` 的 `max_chars`（2000–12000）控制分段大小；给出与落盘时不同的 `max_chars` 会重新切分，编号以本次 `packing` 为准。这时返回的 `next_cursor` 会带上 `@<maxChars>`（若该 packing 与配置默认不同），下一次只传这个 cursor 就沿用同一 packing，能拿到同一套 part 2。不要把“普通 `<page>-<part>` cursor”（按配置默认 packing 解释）和不同的 `max_chars` 混用：part 编号会变，工具会明确报错。`bilibili_subtitles` 也接受同样的 cursor，并按 cursor 里的 page 与 packing 工作。

无字幕视频走 `bilibili_transcribe` 时写的是同一种 bundle：`meta.source` 与 `manifest.source` 为 `asr`，默认轨道是 `asr-zh · B站必剪 ASR`（`track.ai: true`、`track.route: "bcut"`），使用本地兜底时 `track.route: "faster-whisper"`、`lan_doc` 为 `faster-whisper (<model>)`；`validation.verdict` 为 `asr`（机器转写，不做标题关键词校验）。参数与字幕工具一致：`url`、`page`、`part`/`cursor`/`max_chars`/`index_only`/`legacy_full`、`format`/`out`/`out_dir`，另有 `provider`（`auto`/`bcut`/`faster-whisper`）与本地兜底的 `model`/`language`；返回 `manifest` + `part`、`next_cursor`、`source: "asr"`、`asr.provider`（`bcut` 或 `faster-whisper`，本地时还带 `model`/`language`/`runtime`/`temporary`）。`bilibili_transcript_part`、`bilibili_transcript_search` 与抓帧字幕照常可用；需要全文时读 `transcript.md` / `transcript.json`。

## 可选本地 ASR 运行时（faster-whisper）

插件**不打包** faster-whisper、venv 或模型；Bcut 是默认，本地转写只在 Bcut 失败且运行时**已经存在**时使用。`bilibili_transcribe` 返回 `status: "needs_asr_runtime"` 时：

- `bilibili_asr_setup({ action: "status" })`：报告长期（`$DSH_HOME/bilibili-asr`）与临时（`<out_dir>/.asr-runtime`）运行时是否存在、python、模型目录与占用，并探测配置的 `asrPython` 是否已可用；无副作用。
- `bilibili_asr_setup({ action: "install", mode: "persistent" })`：长期安装，venv 与模型保留。适合会反复分析长视频的用户。
- `bilibili_asr_setup({ action: "install", mode: "temporary", out_dir: "..." })`：临时安装，转写完成后自动删除 venv 与模型。适合只处理一个视频。
- `bilibili_asr_setup({ action: "remove", mode: "temporary" })` 随时可删；删除 `persistent` 必须显式传 `confirm: true`。
- `install` 只创建 venv 并安装 faster-whisper，**不下载模型**；第一次本地转写才下载（`small` 约 500 MB，`medium` 更大）。先询问用户选哪种模式，得到答复后再安装；不要自行调用 `install`。
- 已有带 faster-whisper 的 Python 时，可由配置 `asrPython` 或环境变量 `BILIBILI_ASR_PYTHON`/`PYTHON` 指定，跳过安装。

## 抓帧 / 两段式

抓帧是**提示词驱动的两段式**，不是一上来就自动抓一堆图：

1. **第一段：读文稿**。`bilibili_subtitles({ url })` 拿 manifest + 第 1 段，按上一节的分段/检索方式读完相关段落，不要只看 manifest 就下结论。
2. **找信息缺口**。重点找五类“离开画面就不完整”的位置：① 指代悬空（「这个/如图所示/看这里」但没说指什么）；② 结论先行（只给评价、没念数据）；③ 操作无口述（「点这里/选这个」但没说界面选项）；④ 无声演示（相邻语句间隔数秒）；⑤ 视觉对比（「对比一下这两款」但没展开差异）。`manifest.gaps` 的字幕断档附近优先列为候选；纯口播不需要抓帧。
3. **列出抓帧点**。在回复末尾用固定格式写：`[建议抓帧] mm:ss 理由`，例如 `[建议抓帧] 03:20 此处说“如图所示”但文稿无图`。
4. **第二段：定向抓帧**。`bilibili_frames({ url, timestamps: ["03:20", "12:05"], max_frames: 6 })`。`timestamps` 接受秒数、`mm:ss`、`h:mm:ss`；**显式传入会跳过自动选帧**，只抓这些时刻。不传 `timestamps` 时才是自动模式（场景变化峰值 + 均匀补帧）。帧不够再调一次，不要一次抓 20 张。
5. **看帧 / 可选视觉描述**。结果里每帧带绝对 `path`，需要看图时对 `path` 调用 `read_image`。设置 `vision` 后，**被描述的帧（前 `vision_max_frames` 帧）**还会带 `description`（画面描述）、`citation_hint`（`suitable` / `unsuitable` / `""`）和 `vision_error`；超过上限的图片帧保持原有字段。文本模型据此写图注，**只引用 `citation_hint: "suitable"` 的帧，每节至多 1–2 张**，`unsuitable` 或空提示的帧不要配图。视觉是**可选**的：默认 `vision: "none"`，没有画面描述时不要编造内容；`vision_error` 只表示这一帧或整次视觉调用失败，帧图本身仍可用 `read_image` 查看。

`vision` 端点由用户配置，不要在结果或文档里回显 `vision_api_key`：

- `ollama` 默认 `http://localhost:11434/v1`；`llama-cpp` 默认 `http://localhost:8080/v1`。
- `openai-compatible` 必须显式给出 `vision_base_url`（例如本地或自建 OpenAI 兼容服务）。
- `vision_model` 可用档位 `low`/`medium`/`high`（对应 `qwen3-vl:2b`/`4b`/`8b`）或显式模型名。
- 整次视觉调用失败时工具仍返回抓到的帧，`note` 与每帧的 `vision_error` 说明原因。

`bilibili_frames` 参数（只有 `url` 必填）：

- `url`、`page`（多分P，默认选中P）、`timestamps`、`max_frames`（默认 6）
- `quality`（16/32/64/80，默认 64）、`download_video`（默认 true）、`keep_video`（默认 false）
- `max_video_minutes`（默认 60）、`max_download_mb`（默认 1500）
- `detect_scenes` / `scene_threshold`（默认 0.4）/ `sharp_frames` / `scene_align_seconds`（默认 4）/ `out_dir`
- `vision`（`none`/`ollama`/`llama-cpp`/`openai-compatible`，默认 `none`）、`vision_base_url`、`vision_model`（`low`/`medium`/`high` 或显式模型名）、`vision_api_key`、`vision_prompt`、`vision_max_frames`（默认 6，1–20）

结果字段：

- `video`（`bvid/title/owner/duration/url`）、`page`（`page/cid/part/duration`）
- `mode`：`local`（下载后本地抓帧、可做场景对齐/清晰帧细化）或 `remote`（直接对远程流按帧 seek）
- `strategy`：`requested timestamps` / `scene-change peaks + even backfill` / `even-interval backfill`
- `frames[]`：`time`、`requested_time`（原始请求；自动模式为 null）、`reason`、`subtitle_text`（最近字幕）、`has_image`、`path`（绝对路径或 null）、`error`；启用 vision 时，被描述的帧（前 `vision_max_frames` 帧）另有 `description`、`vision_error`（成功为 null）、`citation_hint`（`suitable`/`unsuitable`/`""`），超过上限的图片帧保持这些基础字段
- `text`：紧凑 Markdown 列表（时间戳链接、最近字幕、图片路径；启用 vision 时含画面描述与配图建议），可直接引用
- `note`：降级/清理说明，例如未下载、无字幕 bundle、细化失败、本地视频已删除

没有字幕 bundle 时抓帧照常进行，只是 `subtitle_text` 为空并在 `note` 说明。没有 ffmpeg 时工具返回结构化错误（错误信息带配置的 `ffmpegPath`），不会伪造帧；安装 FFmpeg 或设置 `ffmpegPath` 后重试。

### 画面画廊（可选）

- **只放 `citation_hint: "suitable"` 且 `has_image: true` 的帧**。`unsuitable`、空提示、`has_image: false` 或整次 vision 失败的帧都不要放进报告；没有合适的帧就删除 `#frames` 整节，不要用自动抓帧凑数。
- **每节 1–2 张**，优先选能补足指代悬空（“这个/如图所示”）、视觉对比、操作界面的画面；不要做全片截图墙。
- 把选中的 JPEG 复制到报告同目录的 `frames/`，用相对路径 `frames/<file>.jpg`；封面也复制为 `frames/cover.jpg` 并把 `{{COVER}}` 指向它。报告不联网，不要热链 B站图片或封面。
- 模板里 `#frames` 一节的结构：

  ```html
  <figure class="shot">
    <a href="{{FRAME_LINK}}" target="_blank" rel="noreferrer">
      <img src="frames/{{FRAME_FILE}}" alt="{{CAPTION}}" loading="lazy">
    </a>
    <figcaption><a class="at" href="{{FRAME_LINK}}">{{TIME}}</a>{{CAPTION}}</figcaption>
  </figure>
  ```

  `{{TIME}}` 用 `mm:ss`，`{{CAPTION}}` 用该帧的 `description` 或字幕，不要编造画面内容。
  `{{FRAME_LINK}}` 用完整观看链接：单P为 `https://www.bilibili.com/video/<BVID>?t=<秒>`，
  多分P必须保留页码 `?p=<PAGE>&t=<秒>`，不要丢掉 `p`。

## 文档要求

- 语言：中文；术语、命令、代码保留原文。
- 结构（模板已备好槽位）：信息卡 → 一句话总结 → 核心要点（3–6 条）→ 时间轴（8–15 个节点，可点击跳转 `?t=秒`）→ **关键画面（可选，仅 suitable，1–2 张/节）** → 关键概念 → **背景注释**（角标悬停即显 + 文末完整清单）→ 金句（原文摘录，标时间）→ 行动清单 → 完整文稿（`<details>` 折叠）。
- 时间轴节点必须带真实时间戳与 `?t=` 链接；不要编造时间点。
- **必须区分来源**：官方字幕 / B站 AI 总结 / 评论区长评 / B站必剪 ASR / 本地 faster-whisper（后两者 `source: "asr"`，再看 `asr.provider`），写进信息卡与页脚。本插件的 faster-whisper 是**可选安装**，不要在文档里说它随插件自带。
- 多分P视频：标题与链接标明第几集（`&p=N`），只汇总所请求的那一集。
- 样式：自包含报告（内联 CSS、无外部资源、无 CDN、不联网；选中的 JPEG 可用报告同目录的相对路径）；浅色/深色都清晰；长文稿折叠；打印友好。

## 背景注释（本技能的重点）

视频里大量名词**离开上下文就读不懂**：人名与团队、产品与工具、公司与组织、行业黑话与缩写、当时的事件或梗。必须主动注释，而不是假设读者知道。

- **挑什么**：正文里出现、但普通读者（不了解这个圈子）看不懂的名称。典型是：人名/ID（作者、嘉宾、被点名的人）、产品与库（框架、CLI、SaaS）、组织（公司、社区、会议）、专有流程或缩写、被引用的文章/视频/事件、以及只有圈内人懂的梗。
- **写什么**：每条 1–2 句——① 它是什么（身份/所属/领域）；② **在这条视频里为什么被提到**。不要写百科长传；不要复述视频内容。
- **怎么保证准确**：文稿里没有的信息用 `web_search` 核实（尤其是人名、产品、外链）；仍然无法确认时写「（未能核实）」，**绝不编造**。给出可点的来源链接。
- **标注方式**：正文首次出现处插入**可悬停角标**——鼠标移上去立即展开注释浮层，点击数字跳到文末注释区。角标内联的文本必须与文末注释区**逐字一致**。数量以"确有需要"为准，通常 5–15 条；没有需要注释的内容就写「本视频无需额外背景注释」。
- 角标必须用这个结构（编号、`title`、`#note-N`、浮层文本一一对应）：

  ```html
  <sup class="note-ref" tabindex="0" title="Matt Pocock：英国 TypeScript 教育者、AI Hero 创始人；本视频主讲人。"><a href="#note-1">1</a><span class="note-pop"><b>Matt Pocock</b>：英国 TypeScript 教育者、AI Hero 创始人；本视频主讲人。<span class="src">来源：<a href="https://www.totaltypescript.com/" target="_blank" rel="noreferrer">totaltypescript.com</a></span></span></sup>
  ```

  - 浮层里可以放可点链接；`title` 只放纯文本，作为没有 CSS 时的兜底。
  - 先写完整的注释清单，再把同一条文本原样复制进角标，避免两处措辞不一致。
  - 角标不要写进标题，也不要连续堆叠（同一句最多两个）。
  - 时间轴节点里的角标要放在正文里（`<div>` 内），不要放进 `<time>` 链接，否则会挡点击。
- 术语与注释分工：**关键概念**解释视频里的方法论（spec、task graph、blast radius）；**背景注释**解释视频外的世界（人物、产品、组织、事件）。

## 规则

- 不虚构视频里没有的内容；播放量、点赞数等只取 API 原值。
- 引用的时间戳必须来自工具返回的 `part`（默认）或 `manifest`；只有 `legacy_full: true` 才返回 `timeline`。
- 校验 `fail` 的文稿、或明显不属于本视频的内容，一律不得写入文档。
- 登录二维码是时效凭据：只在回复里展示，不要写进交付文档或任何文件。
- 不确定的信息宁可标注"未能核实"，也不要写得像事实。
