# Changelog

## 0.2.5

- The README version banners now read 0.2.5, and the install command uses the tarball name `npm pack` writes instead of a version hard-coded in the docs.
- The Bcut fallback wording in the system prompt, the `bilibili_transcribe` description and both READMEs now names every failure that falls back (audio download, part upload, or poll `state 3`), not only a rejected poll.
- New login tests cover the QR success path: `pollQrLogin` writes the file `resolveCookieFile` selected with `source: "qrcode"`, and the `bilibili_login` poll tool honours `BILIBILI_COOKIE_FILE` instead of the `$DSH_HOME` default.

## 0.2.4

- Bcut ASR now downloads the DASH audio and uploads it in `per_size` parts instead of POSTing the signed audio URL. The old submit form was rejected with poll `state 3` after about two seconds; the upload path returned 74 segments for a 191 s video in 3.3 s, 738 for 30 min in 11 s, and 1,547 for 66 min in 30.3 s. The 10-minute limit was never real and is removed from the docs.
- A progressive `durl` stream (video+audio) has no DASH audio track to upload: the tool reports that explicitly and suggests `provider: "faster-whisper"` instead of pretending to succeed.
- `BILIBILI_COOKIE_FILE` now governs reads, QR-login writes and device-id persistence (previously only `$DSH_HOME/.env` was consulted for reads, so a login write and a request read could use different files).
- A stored jar with only `buvid3`/`buvid4` is no longer discarded; `loadCredentials` returns it and reports `loggedIn` separately. Missing anonymous device ids are fetched from the SPI endpoint and merged into the jar, best-effort and without sending the session cookie.
- `saveCookieFile` validates its options and requires an explicit source; the old `(path, cookies)` mistake can no longer silently overwrite the default file with an empty jar.
- Login guidance and the `bilibili_login` description are path-based; `bilibili_series` and `bilibili_frames` document their sign-in requirements.
- `pickLowestAudio` falls back to ascending stream `id` when no candidate advertises a usable bandwidth.

## 0.2.3

- Retry only the Windows ffmpeg DLL-init failure (`0xC0000142` / `3221225794`) once.
- Report a final refinement failure as `skipped`, not `failed`; frames are still captured.
- Do not retry a genuine ffmpeg decode failure.

## 0.2.2

- Reader-facing frame-gallery hint; suitable-only frames and local `frames/` images.
- Multi-part frame links preserve `?p=<PAGE>&t=<seconds>`.
- Warn before Bcut when the video is longer than 600 seconds.
- Copy the cover locally as `frames/cover.jpg` for a network-free report.

## 0.2.1

- Login `poll` reads the last QR state file when `qrcode_key` is omitted.
- Regression tests for the login fallback.
- Version bump so a same-profile reinstall actually replaces 0.2.0.

## 0.2.0

- Fork of `dsh-bilibili-summary` 0.1.3 with the `bilibili-video-analysis` skill.
- Long-transcript parts, cursors, time index, gaps, and literal search.
- Picture-driven local/remote frame capture with scene alignment and sharpness refinement.
- Optional vision descriptions and citation hints.
- Bcut no-subtitle ASR with paged output; optional faster-whisper fallback.
- QR login, bilingual subtitle merge, Bilibili AI summary, comments fallback, series listing.
