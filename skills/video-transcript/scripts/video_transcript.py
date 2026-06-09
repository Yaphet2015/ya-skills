#!/usr/bin/env python3
"""Extract a transcript from captions first, then audio-only Whisper fallback.

This script is intentionally stdlib-only for caption parsing. Network/video work uses
external tools only when needed:
  - yt-dlp for URL caption/audio retrieval
  - mlx-whisper or faster-whisper for ASR fallback
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlparse

TIMESTAMP_RE = re.compile(
    r"(?P<start>\d{1,2}:\d{2}(?::\d{2})?[,.]\d{3})\s*-->\s*"
    r"(?P<end>\d{1,2}:\d{2}(?::\d{2})?[,.]\d{3})"
)
INLINE_TIMESTAMP_RE = re.compile(r"<\d{1,2}:\d{2}(?::\d{2})?[,.]\d{3}>")
TAG_RE = re.compile(r"<[^>]+>")
WHITESPACE_RE = re.compile(r"\s+")


@dataclass
class Segment:
    start: float
    end: float
    text: str


@dataclass
class TranscriptResult:
    input: str
    method: str
    transcript: str
    segments: list[Segment]
    caption_file: str | None = None
    audio_file: str | None = None
    language: str | None = None


def is_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def parse_timecode(value: str) -> float:
    value = value.replace(",", ".")
    parts = value.split(":")
    if len(parts) == 2:
        minutes = int(parts[0])
        seconds = float(parts[1])
        return minutes * 60 + seconds
    if len(parts) == 3:
        hours = int(parts[0])
        minutes = int(parts[1])
        seconds = float(parts[2])
        return hours * 3600 + minutes * 60 + seconds
    raise ValueError(f"Invalid timecode: {value}")


def format_srt_time(seconds: float) -> str:
    millis = int(round(seconds * 1000))
    hours, rem = divmod(millis, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    secs, ms = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{ms:03d}"


def clean_caption_text(lines: Iterable[str]) -> str:
    raw = " ".join(line.strip() for line in lines if line.strip())
    raw = INLINE_TIMESTAMP_RE.sub(" ", raw)
    raw = TAG_RE.sub(" ", raw)
    raw = html.unescape(raw)
    raw = raw.replace("\ufeff", "").replace("\u200b", "")
    raw = WHITESPACE_RE.sub(" ", raw).strip()
    return raw


def parse_caption_text(content: str) -> list[Segment]:
    """Parse SRT or WebVTT text into timestamped segments."""
    lines = content.replace("\ufeff", "").splitlines()
    segments: list[Segment] = []
    i = 0

    while i < len(lines):
        line = lines[i].strip()
        if not line:
            i += 1
            continue

        upper = line.upper()
        if upper.startswith(("WEBVTT", "STYLE", "NOTE")) or line.startswith(("Kind:", "Language:")):
            i += 1
            continue

        match = TIMESTAMP_RE.search(line)
        if not match:
            # Cue identifiers and numeric SRT counters arrive here.
            i += 1
            continue

        start = parse_timecode(match.group("start"))
        end = parse_timecode(match.group("end"))
        i += 1

        cue_lines: list[str] = []
        while i < len(lines):
            cue_line = lines[i].strip()
            if not cue_line:
                break
            if TIMESTAMP_RE.search(cue_line):
                # Malformed caption with missing blank separator; reprocess timestamp.
                i -= 1
                break
            if not cue_line.startswith(("Kind:", "Language:")):
                cue_lines.append(cue_line)
            i += 1

        text = clean_caption_text(cue_lines)
        if text and end > start:
            if not segments or segments[-1].text != text:
                segments.append(Segment(start=start, end=end, text=text))
        i += 1

    return segments


def load_caption_file(path: Path) -> list[Segment]:
    if not path.exists():
        raise SystemExit(f"Caption file not found: {path}")
    return parse_caption_text(path.read_text(encoding="utf-8", errors="replace"))


def transcript_from_segments(segments: list[Segment]) -> str:
    """Build readable text while removing adjacent word overlap from rolling captions."""
    output_words: list[str] = []
    previous_words: list[str] = []

    for segment in segments:
        words = segment.text.split()
        if not words:
            continue

        overlap = 0
        max_overlap = min(len(previous_words), len(words), 30)
        for size in range(max_overlap, 0, -1):
            if previous_words[-size:] == words[:size]:
                overlap = size
                break

        output_words.extend(words[overlap:])
        previous_words = words

    if output_words:
        return " ".join(output_words).strip()

    # Fallback for languages/text without whitespace tokenization.
    deduped: list[str] = []
    for segment in segments:
        if not deduped or deduped[-1] != segment.text:
            deduped.append(segment.text)
    return "\n".join(deduped).strip()


def command_exists(name: str) -> bool:
    return shutil.which(name) is not None


def run(cmd: list[str], *, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)


def yt_dlp_base(args: argparse.Namespace) -> list[str]:
    if not command_exists("yt-dlp"):
        raise SystemExit("yt-dlp is required for URL inputs. Install it first (for example: brew install yt-dlp).")

    cmd = ["yt-dlp"]
    if args.proxy:
        cmd.extend(["--proxy", args.proxy])
    return cmd


def run_yt_dlp_with_optional_cookies(cmd: list[str], args: argparse.Namespace) -> subprocess.CompletedProcess[str]:
    first = run(cmd)
    if first.returncode == 0 or not args.browser:
        return first

    retry = cmd[:-1] + ["--cookies-from-browser", args.browser, cmd[-1]]
    return run(retry)


def download_captions(url: str, workdir: Path, args: argparse.Namespace) -> Path | None:
    before = set(workdir.glob("*"))
    cmd = yt_dlp_base(args) + [
        "--skip-download",
        "--write-subs",
        "--write-auto-subs",
        "--sub-langs",
        args.langs,
        "--sub-format",
        "vtt/srt/best",
        "--no-playlist",
        "--paths",
        str(workdir),
        "--output",
        "%(id)s.%(ext)s",
        url,
    ]
    result = run_yt_dlp_with_optional_cookies(cmd, args)
    candidates = [
        path
        for path in workdir.glob("*")
        if path not in before and path.suffix.lower() in {".vtt", ".srt"} and path.is_file()
    ]
    if result.returncode != 0 and not candidates:
        print(result.stderr.strip(), file=sys.stderr)
        return None
    return sorted(candidates, key=lambda p: (p.suffix.lower() != ".vtt", p.name))[0] if candidates else None


def download_audio(url: str, workdir: Path, args: argparse.Namespace) -> Path:
    before = set(workdir.glob("*"))
    cmd = yt_dlp_base(args) + [
        "-f",
        "bestaudio/best",
        "--no-playlist",
        "--paths",
        str(workdir),
        "--output",
        "%(id)s.%(ext)s",
        url,
    ]
    result = run_yt_dlp_with_optional_cookies(cmd, args)
    if result.returncode != 0:
        raise SystemExit(result.stderr.strip() or "yt-dlp audio download failed")

    candidates = [
        path
        for path in workdir.glob("*")
        if path not in before and path.is_file() and path.suffix.lower() not in {".vtt", ".srt", ".json"}
    ]
    if not candidates:
        raise SystemExit("yt-dlp completed but no audio file was found")
    return sorted(candidates, key=lambda p: p.stat().st_mtime, reverse=True)[0]


def transcribe_with_mlx(audio_path: Path, args: argparse.Namespace) -> tuple[list[Segment], str | None]:
    try:
        import mlx_whisper  # type: ignore
    except ImportError as exc:
        raise RuntimeError("mlx-whisper is not installed") from exc

    kwargs: dict[str, Any] = {
        "path_or_hf_repo": args.mlx_model,
        "word_timestamps": False,
    }
    if args.language:
        kwargs["language"] = args.language

    result = mlx_whisper.transcribe(str(audio_path), **kwargs)
    segments = [
        Segment(float(item["start"]), float(item["end"]), clean_caption_text([str(item.get("text", ""))]))
        for item in result.get("segments", [])
        if str(item.get("text", "")).strip()
    ]
    return segments, result.get("language")


def transcribe_with_faster(audio_path: Path, args: argparse.Namespace) -> tuple[list[Segment], str | None]:
    try:
        from faster_whisper import WhisperModel  # type: ignore
    except ImportError as exc:
        raise RuntimeError("faster-whisper is not installed") from exc

    model = WhisperModel(args.asr_model, device="cpu", compute_type="int8")
    transcribe_kwargs: dict[str, Any] = {}
    if args.language:
        transcribe_kwargs["language"] = args.language

    segment_iter, info = model.transcribe(str(audio_path), **transcribe_kwargs)
    segments = [
        Segment(float(segment.start), float(segment.end), clean_caption_text([segment.text]))
        for segment in segment_iter
        if segment.text.strip()
    ]
    return segments, getattr(info, "language", None)


def transcribe_local(audio_path: Path, args: argparse.Namespace) -> tuple[list[Segment], str, str | None]:
    errors: list[str] = []
    engines = [args.asr_engine] if args.asr_engine != "auto" else ["mlx", "faster"]

    for engine in engines:
        try:
            if engine == "mlx":
                segments, language = transcribe_with_mlx(audio_path, args)
            elif engine == "faster":
                segments, language = transcribe_with_faster(audio_path, args)
            else:
                raise RuntimeError(f"Unsupported ASR engine: {engine}")
            if not segments:
                raise RuntimeError("ASR returned no segments")
            return segments, f"whisper-{engine}", language
        except Exception as exc:  # noqa: BLE001 - CLI should report all fallback failures clearly.
            errors.append(f"{engine}: {exc}")

    raise SystemExit(
        "No local Whisper engine succeeded. Install mlx-whisper or faster-whisper, "
        "or rerun with --no-asr for captions-only mode. Failures: " + "; ".join(errors)
    )


def render_markdown(result: TranscriptResult) -> str:
    lines = [
        "# Video Transcript",
        "",
        f"- Source: `{result.input}`",
        f"- Method: `{result.method}`",
    ]
    if result.language:
        lines.append(f"- Language: `{result.language}`")
    if result.caption_file:
        lines.append(f"- Caption file: `{result.caption_file}`")
    if result.audio_file:
        lines.append(f"- Audio file: `{result.audio_file}`")
    lines.extend(["", "## Transcript", "", result.transcript, ""])
    return "\n".join(lines)


def render_json(result: TranscriptResult) -> str:
    payload = asdict(result)
    payload["segments"] = [asdict(segment) for segment in result.segments]
    return json.dumps(payload, ensure_ascii=False, indent=2) + "\n"


def render_srt(result: TranscriptResult) -> str:
    blocks = []
    for index, segment in enumerate(result.segments, start=1):
        blocks.append(
            f"{index}\n{format_srt_time(segment.start)} --> {format_srt_time(segment.end)}\n{segment.text}\n"
        )
    return "\n".join(blocks)


def render(result: TranscriptResult, fmt: str) -> str:
    if fmt == "markdown":
        return render_markdown(result)
    if fmt == "json":
        return render_json(result)
    if fmt == "srt":
        return render_srt(result)
    if fmt == "txt":
        return result.transcript + "\n"
    raise ValueError(f"Unsupported output format: {fmt}")


def build_result(input_value: str, args: argparse.Namespace, workdir: Path) -> TranscriptResult:
    caption_path: Path | None = Path(args.caption_file).expanduser() if args.caption_file else None
    input_path = Path(input_value).expanduser()

    if caption_path or (input_path.exists() and input_path.suffix.lower() in {".vtt", ".srt"}):
        selected = caption_path or input_path
        assert selected is not None
        segments = load_caption_file(selected)
        if not segments:
            raise SystemExit(f"No caption segments parsed from {selected}")
        return TranscriptResult(
            input=input_value,
            method="caption-file",
            transcript=transcript_from_segments(segments),
            segments=segments,
            caption_file=str(selected),
        )

    if is_url(input_value):
        caption = download_captions(input_value, workdir, args)
        if caption:
            segments = load_caption_file(caption)
            if segments:
                return TranscriptResult(
                    input=input_value,
                    method="captions",
                    transcript=transcript_from_segments(segments),
                    segments=segments,
                    caption_file=str(caption),
                )
            print(f"Caption file had no parseable segments: {caption}", file=sys.stderr)

        if args.no_asr:
            raise SystemExit("No usable captions found and --no-asr was set")
        audio = download_audio(input_value, workdir, args)
        segments, method, language = transcribe_local(audio, args)
        return TranscriptResult(
            input=input_value,
            method=method,
            transcript=transcript_from_segments(segments),
            segments=segments,
            audio_file=str(audio),
            language=language,
        )

    if input_path.exists():
        if args.no_asr:
            raise SystemExit("Local input is not a caption file and --no-asr was set")
        segments, method, language = transcribe_local(input_path, args)
        return TranscriptResult(
            input=input_value,
            method=method,
            transcript=transcript_from_segments(segments),
            segments=segments,
            audio_file=str(input_path),
            language=language,
        )

    raise SystemExit(f"Input is neither a URL nor an existing file: {input_value}")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Return a video transcript using captions first and ASR fallback.")
    parser.add_argument("input", help="Video URL, local caption file, or local audio/video file")
    parser.add_argument("--output", "-o", help="Output path. Defaults to stdout.")
    parser.add_argument("--format", choices=["markdown", "txt", "json", "srt"], default="markdown")
    parser.add_argument("--caption-file", help="Parse this local VTT/SRT file instead of fetching captions")
    parser.add_argument("--langs", default="zh-Hans,zh-CN,en,ja,ko", help="yt-dlp caption language priority")
    parser.add_argument("--browser", default="chrome", help="Browser for yt-dlp cookie retry; pass '' to disable")
    parser.add_argument("--proxy", default="", help="Optional yt-dlp proxy, e.g. http://127.0.0.1:7890")
    parser.add_argument("--no-asr", action="store_true", help="Fail if captions are unavailable instead of transcribing audio")
    parser.add_argument("--asr-engine", choices=["auto", "mlx", "faster"], default="auto")
    parser.add_argument("--asr-model", default="large-v3-turbo", help="faster-whisper model name")
    parser.add_argument("--mlx-model", default="mlx-community/whisper-large-v3-turbo", help="MLX Whisper model repo/path")
    parser.add_argument("--language", help="Optional ASR language hint such as en, zh, ja")
    parser.add_argument("--workdir", help="Directory for temporary captions/audio. Defaults to a temp directory.")
    parser.add_argument("--keep-workdir", action="store_true", help="Do not delete auto-created temporary workdir")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    temp_root: Path | None = None

    if args.workdir:
        workdir = Path(args.workdir).expanduser().resolve()
        workdir.mkdir(parents=True, exist_ok=True)
    else:
        temp_root = Path(tempfile.mkdtemp(prefix="video-transcript-"))
        workdir = temp_root

    try:
        result = build_result(args.input, args, workdir)
        rendered = render(result, args.format)
        if args.output:
            output_path = Path(args.output).expanduser().resolve()
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text(rendered, encoding="utf-8")
            print(str(output_path))
        else:
            print(rendered, end="")
    finally:
        if temp_root and not args.keep_workdir:
            shutil.rmtree(temp_root, ignore_errors=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
