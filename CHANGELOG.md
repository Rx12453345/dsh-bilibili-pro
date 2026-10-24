# Changelog

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
