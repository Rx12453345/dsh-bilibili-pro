# dsh-bilibili-pro

[English](README.md) | 中文

> dsh-bilibili-pro 0.2.3：在 `dsh-bilibili-summary` 0.1.3 的底座上新增无损落盘文稿
> 分段（`parts`、cursor、时间索引、缺口）与关键词检索、提示词驱动的定向抓帧与可选
> 视觉描述，以及无字幕视频的 ASR 链：**优先 B站必剪（Bcut）**，并提供**可选的**
> 按需 faster-whisper 兜底。插件**不内置** faster-whisper、虚拟环境或模型。两个
> 上游包的归属说明见 `NOTICE` 与 `THIRD_PARTY_NOTICES.md`。

给 DeepSeek Harness 的 B站 视频理解插件：扫码登录一次，抽取视频的 **AI/CC 字幕轨道**，汇总成一份 **自包含的 HTML 文档**；视频没有字幕时，默认走 B站必剪（Bcut）ASR，不下载本地模型；Bcut 处理不了的音频，可在用户选择后安装可选的 faster-whisper 运行时（长期保留或只用于当前视频）。

B站 对未登录用户隐藏 AI 字幕，插件走官方扫码登录流程并把 Cookie 存在本地；二维码由插件自己渲染成 PNG，**不会**发往任何第三方图床。

## 提供什么

| 工具 | 作用 |
| --- | --- |
| `bilibili_subtitles` | 抽取官方 AI/CC 字幕为带时间轴的文稿；**校验通过才返回**，支持双语合并，输出 Markdown / 文本 / SRT / ASS / LRC / JSON |
| `bilibili_transcript_part` | 按 `part` 或 `cursor` 读取已落盘文稿中的一段（无需重新抓字幕）；`max_chars` 可按另一尺寸重切，返回的 cursor 会带上该 packing |
| `bilibili_transcript_search` | 在已落盘文稿里做纯子串检索，返回每处命中的时间、part 编号与上下文 |
| `bilibili_video_info` | 视频元信息、字幕轨道列表、B站 AI 总结；**视频无字幕时自动附带评论区长评**（降级来源） |
| `bilibili_transcribe` | 无字幕兜底：默认走 B站必剪（Bcut）ASR，无需登录、本地模型或音频下载，提交最低码率音轨；`provider: auto` 在 Bcut 失败时复用已安装的 faster-whisper 运行时，若没有则返回 `status: "needs_asr_runtime"`，不写空 bundle |
| `bilibili_asr_setup` | 可选 faster-whisper 运行时的 `status` / `install` / `remove`，`mode: persistent \| temporary`；只有被调用时才安装，删除长期运行时需要 `confirm: true` |
| `bilibili_frames` | 按显式时间点或自动场景变化/均匀补帧抓取 JPEG，附最近字幕；可选视觉描述 |
| `bilibili_series` | 列 UP 的最近投稿 / 合集系列 / 合集内视频，用于批量任务 |
| `bilibili_login` | 扫码登录（`start` / `poll` / `status` / `logout`） |

![生成的汇总文档](https://raw.githubusercontent.com/Adamaik/dsh-zcode-plugins/main/packages/bilibili-summary/docs/preview.png)

*实际产物：信息卡、一句话总结、核心要点，以及可点击跳回原片的时间轴。*

外加 `bilibili-video-analysis` 技能：按内置模板产出中文 HTML 报告（信息卡 → 一句话总结 → 核心要点 → 可点击时间轴 → 关键概念 → **背景注释** → 金句 → 行动清单 → 可折叠全文）。

## 安装

本包**没有发布到 npm**，请从仓库安装：

```sh
git clone https://github.com/Rx12453345/dsh-bilibili-pro.git
cd dsh-bilibili-pro
npm install
mkdir -p dist
npm pack --pack-destination dist
dsh plugin --profile <profile> add ./dist/dsh-bilibili-pro-0.2.3.tgz
```

安装后请保留 `dist/`：profile 记录的是 tarball 路径。

桌面 App 也可以不用 CLI，直接在 **设置 → 插件 → 从本地 tarball 安装**。抓帧和本地音频转码需要
系统 `PATH` 上有 FFmpeg。

## 登录

直接让 agent 汇总一条 B站 链接即可。当取字幕提示未登录时，它会：

```
bilibili_login { action: "start" }   # 返回二维码 PNG 路径，展示给你扫
bilibili_login { action: "poll" }    # 等待扫码完成并保存 Cookie
```

用 B站 手机 App（「我的」→「扫一扫」）扫码确认。Cookie 写入 `$DSH_HOME/bilibili-cookies.json`（权限 `0600`）。也可以跳过扫码，在 `$DSH_HOME/.env` 里直接给：

```
BILIBILI_SESSDATA=你的_sessdata
```

`bilibili_login { action: "status" }` 查看当前账号；`{ action: "logout" }` 删除凭据。

## 字幕到底怎么取

看起来最像的那个接口其实是错的。`x/player/v2` 现在仍带 `subtitle.subtitles` 字段，但在限流状态下会返回**属于别的视频或被截断**的文稿——静默采用就会把别人的话写进你的报告。

网页播放器真正走的是 `x/v2/subtitle/web/view`，它返回 **protobuf**，而且给回的路径**不能直接下载**：

1. `x/web-interface/view` 把 BV 号换成 `aid`/`cid`；
2. `x/v2/subtitle/web/view?oid=<cid>&pid=<aid>&type=1&…`（WBI 签名）返回 protobuf。插件直接按 wire format 解析（不依赖生成式 schema，B站 加字段也不会挂），取出 `lan` / `lan_doc` / `subtitle_url`；
3. 每个 `//subtitle.bilibili.com/<path>` 要按播放器的 `F`/`U` 函数做 XOR 解码并改写成 `//aisubtitle.hdslb.com/<path>?auth_key=…`。这两组密钥是从 `bfs/static/player/main/core.*.js` 里逐字符抠出来的，并且有单测钉住这个变换，避免再出现抄错一个字符的情况；
4. 最终 JSON 的 `body[]` 就是字稿。

接口被限流时仍可能返回偏短的 body，所以 `bilibili_subtitles` **校验通过才返回**，并以递增退避重试，每轮重新取轨道。

## 「校验通过」是什么意思

只看覆盖率分不出真字幕和很像真的假字幕——旧接口就返回过**属于另一个视频、时长却完全对得上**的文稿。所以插件给三个信号打分并给出结论：

| 结论 | 条件 | 处理 |
| --- | --- | --- |
| `strong` | 标题关键词命中 + 覆盖率 ≥ 50% | 直接使用 |
| `weak` | 覆盖率 ≥ 70% 但关键词零命中（标题党、或中文标题配英文原声） | 可用，但需在文档里标注"弱校验" |
| `fail` | 段数不足 / 覆盖率 < 50% / 覆盖率 > 200%（字幕比视频还长，多半是别人的） | 拒绝，继续降级 |

关键词同时匹配中文 2–4 字片段与英文 3 字母以上词条（去停用词），所以 `implement-spec`、`React`、`海绵宝宝` 都能命中。

## 降级链

1. `bilibili_subtitles` —— 真正的字幕轨道。
2. `bilibili_video_info` —— B站 AI 总结 + 视频简介。
3. `bilibili_video_info` 的 `comments` —— 长（≥200 字）、高赞（≥3）的评论；观众手写的「课代表」总结，视频无字幕时自动抓取。
4. `bilibili_transcribe` —— B站必剪（Bcut）ASR：匿名、无需本地模型，是无字幕视频的默认方案。实测只接受约 10 分钟以内的音频，更长会被拒绝（poll state 3）。
5. 可选本地兜底：Bcut 失败后，`bilibili_transcribe` 会复用**已安装**的 faster-whisper 运行时；若没有，返回 `status: "needs_asr_runtime"` 与两种安装选择，**绝不自动下载**。

同语言下**优先 UP 上传的 CC 字幕**而非 AI 字幕；任何走了降级的来源都会在报告里标注。

## 双语与格式

`bilibili_subtitles` 可以把第二条轨道按时间重叠合并到每行下面：

```
bilibili_subtitles({ url: "BV1TXHY6aETi", lang: "ai-zh", bilingual: "ai-en", format: "srt", out: "bilingual.srt" })
```

支持格式：`markdown` / `text` / `srt` / `ass` / `lrc` / `json`。

## 报告里的背景注释

文稿里全是"离开上下文看不懂"的名字。技能要求报告必须注释：人物与团队、产品与库、组织、黑话与缩写、被引用的事件。每条 1–2 句——是什么 + 视频里为什么提到它；凡是用联网检索核实的都给出可点来源，无法核实的写「（未能核实）」。正文角标**鼠标移上去就展开注释浮层**（纯 CSS 实现，离线可用、任何浏览器都能看），点数字则跳到文末完整清单，方便通读与打印。浮层与清单由同一份文本生成，不会出现两处不一致。

## 无字幕视频：Bcut 优先，可选 faster-whisper

字幕被压制进画面的视频没有轨道可抽，用 `bilibili_transcribe`：

1. 通过 `x/player/wbi/playurl` 取音轨，并选**最低码率**的 DASH 候选（Bcut 会拒绝 212 kbps，却接受 65 kbps）；
2. 提交给 B站必剪（Bcut）。成功后输出形状与字幕轨道一致，并标注为机器转写（`source: "asr"`、`track.route: "bcut"`）。

Bcut 只接受约 10 分钟以内的音频。更长的无字幕视频可以由助手提供一个**可选**的 faster-whisper 兜底，两种方式由用户明确选择：

- **长期安装（persistent）** —— `bilibili_asr_setup { action: "install", mode: "persistent" }` 在 `$DSH_HOME/bilibili-asr/{venv,models}` 安装一次，venv 与模型保留，之后的视频直接复用。
- **临时安装（temporary）** —— `bilibili_asr_setup { action: "install", mode: "temporary", out_dir: "..." }` 安装在 `<out_dir>/.asr-runtime`；转写 bundle 写完后自动删除 venv 与模型。`$DSH_HOME/bilibili-asr` 下会保留一个临时状态文件，因此换一个 `out_dir` 也能找到它。

两种方式都**不会自动开始**。Bcut 失败且没有运行时，`bilibili_transcribe` 返回 `status: "needs_asr_runtime"`，包含 `bcut_error`、两种选项与模型大小估计，不写空 bundle。`install` 只创建 venv 并 pip 安装 faster-whisper，**不下载模型**；第一次本地转写才下载（`small` 约 500 MB，`medium` 约 1.5 GB）。插件不打包 faster-whisper 包、venv 或模型——GitHub 上“装上即用”指 Bcut 立即可用，faster-whisper 是可选增强。已有带 faster-whisper 的解释器时，把 `asrPython` 指过去即可跳过安装；`bilibili_asr_setup { action: "status" }` 会探测它并报告运行时是否已可用。

安装器目前把 PyAV 固定在 19 以下（`faster-whisper` + `av<19`）：PyAV 19 移除了 `av.open(..., metadata_errors=...)` 参数，而 faster-whisper 1.2.1 仍会传入它，不固定版本时模型一打开音频就会失败。本地转写时，音频先由 Node 下载（带 B站 Referer 与大小上限），再由 ffmpeg 从本地文件转换——而不是让 ffmpeg 直接打开远程地址——因为 ffmpeg 自身的 TLS 实现可能不信任本地代理 CA。

实测（9 分钟无字幕视频 `BV1hhHi65EnQ`）：Bcut 返回 159 句 / 5,682 字；可选 `faster-whisper` `small` 模型在 CPU 上 107 秒返回 103 句 / 5,464 字，`source: "asr"`，写的是同一套分页 bundle。两种结果都能用 `bilibili_transcript_part` 和 `bilibili_transcript_search` 正常读取。模型/venv 不随插件打包，只存在于所选运行时目录。

## 配置

所有字段都可选。在 profile 的 patch 层里配置：

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

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `cookieFile` | `$DSH_HOME/bilibili-cookies.json` | 凭据存放位置 |
| `sessdata` | `''` | 直接指定 `SESSDATA`，优先于文件 |
| `language` | `ai-zh` | 首选字幕轨道 |
| `retries` | `6` | 取字幕的最大尝试次数 |
| `retryBaseDelayMs` | `8000` | 首次退避；每轮再加 3 秒 |
| `timeoutMs` | `20000` | 单次请求超时 |
| `ffmpegPath` | 自动探测 | 可选本地兜底用的 ffmpeg |
| `bcutTimeoutMs` | `600000` | Bcut 轮询总预算 |
| `bcutPollMs` | `5000` | Bcut 结果轮询间隔 |
| `asrPython` | `''` | 已带 faster-whisper 的 Python；填写后跳过安装 |
| `asrVenv` | `$DSH_HOME/bilibili-asr/venv` | 长期兜底虚拟环境 |
| `asrModel` | `small` | 可选兜底的 faster-whisper 模型规格 |
| `asrModelDir` | `$DSH_HOME/bilibili-asr/models` | 模型缓存 |
| `asrLanguage` | `auto` | 可选兜底的转写语种 |

也支持环境变量或 `$DSH_HOME/.env` 中的 `BILIBILI_SESSDATA`、`BILIBILI_COOKIE_FILE`；`BILIBILI_ASR_PYTHON`（或 `PYTHON`）可把可选兜底指向一个解释器，无需改配置。

## 用法

```
bilibili_video_info({ url: "https://www.bilibili.com/video/BV1puH46qE5x/" })
bilibili_subtitles({ url: "BV1c3HL6qEyq", out: "bilibili/BV1c3HL6qEyq/transcript.md" })
bilibili_subtitles({ url: "BV1TXHY6aETi", lang: "ai-zh", bilingual: "ai-en", format: "srt", out: "bilibili/BV1TXHY6aETi/bilingual.srt" })
bilibili_transcribe({ url: "BV1puH46qE5x" })                              # Bcut，无需本地安装
bilibili_transcribe({ url: "BV1puH46qE5x", provider: "faster-whisper" })  # 仅在已安装运行时时使用
bilibili_asr_setup({ action: "status" })                                  # 查看两种运行时，无副作用
bilibili_asr_setup({ action: "install", mode: "temporary", out_dir: "bili-out" })
bilibili_asr_setup({ action: "remove", mode: "temporary" })
bilibili_series({ url: "https://space.bilibili.com/588699709", kind: "collections" })
```

`bilibili_subtitles` 默认返回：视频信息、所选轨道、校验/覆盖率统计、落盘 manifest，以及一个受长度限制的 `part` 和 `next_cursor`；需要旧的完整 `timeline`/`transcript`/`segments` 形状时传 `legacy_full: true`。`bilibili_transcript_part` 与 `bilibili_transcript_search` 读取已落盘文稿（跟随重切后的 cursor 会恢复同一 packing）。`bilibili_transcribe` 写的是同一套分段 bundle，因此 part/search 工具对 ASR 结果同样可用；其 `source` 为 `asr`，`asr.provider` 为 `bcut` 或 `faster-whisper`。

## 已知限制

- 以中文优先：默认轨道 `ai-zh`，其它语言用 `lang` 指定。
- Bcut 是 B站 的服务，实测约 10 分钟音频的上限；更长的无字幕视频需要可选本地兜底（或改用 B站 AI 总结 / 评论区长评）。
- 可选 faster-whisper 兜底不随插件打包：首次本地使用要下载模型，转写质量取决于模型规格；`small` 是速度与准确度的折中。Bcut 输出通常没有标点；faster-whisper 会带标点，但两者都可能出现同音错字。
- B站 限流较严，抽取失败通常是暂时的。
- 多分P视频按 `page` 参数一集一集处理。

## 上游与归属

这是一个**独立包**，不是某个单一上游仓库的 GitHub fork。它派生自
`dsh-bilibili-summary` 0.1.3，而后者位于
[`Adamaik/dsh-zcode-plugins`](https://github.com/Adamaik/dsh-zcode-plugins) monorepo 的
`packages/bilibili-summary`；设计上还参考了
[`CZX2244/dsh-bilibili`](https://github.com/CZX2244/dsh-bilibili) 0.7.5。GitHub 的 fork
是仓库级的，独立插件无法显示“forked from 某个子目录”的关系；完整归属写在
[NOTICE](NOTICE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 许可

MIT，见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
