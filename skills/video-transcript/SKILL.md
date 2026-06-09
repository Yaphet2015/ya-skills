---
name: video-transcript
description: Use when the user provides a video URL or local media/caption file and wants the transcript/text稿, especially YouTube transcript extraction. Captions are used first; audio-only Whisper transcription is the fallback.
---

# Video Transcript Skill

Use this skill when the user asks for a video transcript, video-to-text, YouTube transcript, or a Markdown/text稿 from a video URL or local media file.

## Core Policy

1. **Do not download full video just to get text.** Try caption/subtitle retrieval first.
2. **Use captions before ASR.** Captions are faster and usually cost nothing.
3. **Only download audio for fallback transcription.** If captions are missing/unusable, download the best audio stream and run local Whisper.
4. **Preserve provenance.** Record input URL/file, selected method, language/caption source when known, and output path.
5. **For Telegram or chat delivery, prefer a `.md` attachment for long transcripts.** Avoid dumping very long transcripts into one message.

## One-command workflow

From this skill directory after `yk install video-transcript`:

```sh
python3 scripts/video_transcript.py "https://www.youtube.com/watch?v=..." \
  --format markdown \
  --output /absolute/path/transcript.md
```

For a local VTT/SRT caption file:

```sh
python3 scripts/video_transcript.py /absolute/path/captions.vtt --format markdown
```

For a local audio/video file that needs ASR:

```sh
python3 scripts/video_transcript.py /absolute/path/talk.mp4 \
  --format markdown \
  --output /absolute/path/talk-transcript.md
```

Useful options:

- `--langs "zh-Hans,zh-CN,en,ja,ko"` — caption language priority for `yt-dlp`.
- `--no-asr` — captions only; fail instead of downloading audio/transcribing.
- `--browser chrome` — retry YouTube downloads with `--cookies-from-browser chrome` when needed.
- `--proxy http://127.0.0.1:7890` — pass a proxy to `yt-dlp`.
- `--format markdown|txt|json|srt` — choose output shape.
- `--caption-file /path/file.vtt` — parse a known caption file without network access.
- `--asr-engine auto|mlx|faster` — local Whisper engine choice.
- `--language en|zh|ja|...` — language hint for ASR fallback.

## Algorithm

```text
input URL/file
  │
  ├─ if local .vtt/.srt or --caption-file
  │    parse caption file → cleaned transcript
  │
  ├─ if URL
  │    yt-dlp captions only
  │      ├─ success: parse VTT/SRT → cleaned transcript
  │      └─ failure/missing captions:
  │            if --no-asr: fail clearly
  │            else download audio only → local Whisper → transcript
  │
  └─ if local media/audio
       local Whisper → transcript
```

## Dependencies

Required for caption parsing only:

- `python3` with the standard library.

Required for URL caption/audio retrieval:

- `yt-dlp`.

Required for ASR fallback:

- One local Whisper engine:
  - Apple Silicon preferred: `pip3 install mlx-whisper`
  - Portable fallback: `pip3 install faster-whisper`
- The selected engine may need `ffmpeg` or its bundled decoder depending on package/version.

The script does **not** require any API key. API-based ASR can be added later if service-side cost/latency tradeoffs are preferred.

## Cost Model

- **YouTube/manual/auto captions found:** API cost is `$0`; runtime is usually seconds.
- **Local Whisper fallback:** API cost is `$0`; cost is local CPU/GPU time and first model download.
- **If later swapped to cloud ASR:** current market prices are roughly `$0.0025–0.006/minute` for common speech-to-text APIs, so a 60-minute video is roughly `$0.15–0.36` before any translation/LLM polishing.

For bulk use, cache by `video_id + language + output_format + asr_model` so repeated requests are free after the first successful transcript.

## Verification Checklist

After running:

1. Confirm the command exit code is 0.
2. Confirm stdout or the output file exists and is non-empty.
3. Check the reported `Method` field:
   - `captions` / `caption-file` means no ASR cost.
   - `whisper-*` means ASR fallback was used.
4. Skim the first and last transcript paragraphs to catch empty/duplicated rolling-caption artifacts.
5. If the output is meant for the user, deliver the `.md` file or provide a concise excerpt plus the path.

## Common Pitfalls

- YouTube can return 403/SABR/PO-token style failures. Retry with `--browser chrome` and/or `--proxy`.
- Auto captions may contain rolling/overlapping cues. The script removes adjacent duplicate text and word-overlap when building the plain transcript, but always skim long outputs.
- Do not use full-video download for transcript-only tasks.
- Translation/polishing is a separate task from transcript extraction. Ask before adding translation if the user only requested the original transcript.
