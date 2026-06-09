import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const script = resolve("skills/video-transcript/scripts/video_transcript.py");

async function runTranscript(args: string[]) {
  const process = Bun.spawn(["python3", script, ...args], {
    cwd: resolve("."),
    stdout: "pipe",
    stderr: "pipe"
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited
  ]);

  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  return stdout;
}

test("video-transcript script parses WebVTT captions and removes rolling overlap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yk-video-transcript-"));
  try {
    const caption = join(dir, "sample.vtt");
    await writeFile(
      caption,
      `WEBVTT

Kind: captions
Language: en

cue-1
00:00:00.000 --> 00:00:02.000 align:start position:0%
<v Speaker>Hello <00:00:00.800>world</v>

00:00:02.000 --> 00:00:04.000
world again

00:00:04.000 --> 00:00:06.000
world again
`,
      "utf8"
    );

    const stdout = await runTranscript([caption, "--format", "json"]);
    const parsed = JSON.parse(stdout);

    expect(parsed.method).toBe("caption-file");
    expect(parsed.transcript).toBe("Hello world again");
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.segments[0]).toEqual({ start: 0, end: 2, text: "Hello world" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("video-transcript script writes Markdown output files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yk-video-transcript-"));
  try {
    const caption = join(dir, "sample.srt");
    const output = join(dir, "transcript.md");
    await writeFile(
      caption,
      `1
00:00:00,000 --> 00:00:01,500
First sentence

2
00:00:01,500 --> 00:00:03,000
Second sentence
`,
      "utf8"
    );

    const stdout = await runTranscript([caption, "--format", "markdown", "--output", output]);
    expect(stdout.trim()).toBe(await realpath(output));

    const markdown = await readFile(output, "utf8");
    expect(markdown).toContain("# Video Transcript");
    expect(markdown).toContain("- Method: `caption-file`");
    expect(markdown).toContain("First sentence Second sentence");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
