# v2.1.3 release verification

- Release commit: `74ab9b1b1478e843a06110b0f26cd804db5a07e5`; tag: `v2.1.3`.
- Tap commit: `6d693b052b5641859d2a82c0426d7a5d50633d87`.
- Release: https://github.com/Yaphet2015/ya-skills/releases/tag/v2.1.3
- Change: coding-recon identifies the object/stage of a requested simplification, preserves requirements outside that change, and asks only about material ambiguity remaining after reading evidence.
- macOS 27.0 arm64; Bun 1.4.0.
- Archive SHA-256, local and downloaded: `bf39bd22d2f4917531651b1cd360b6f2fdd0ff8dac51e743e37bde1e15a03c0f`.

## Checks

- `bun run typecheck`: passed.
- `bun run test`, with FORCE_COLOR unset: first run had 801 passed, 11 skipped and 1 failure because the default packaged test discovered a stale v2.1.1 executable in dist/release. Preserved that tree under the run evidence directory before repeating the default suite. No source fix or assertion change was needed.
- Repeated `bun run test`, with FORCE_COLOR unset: 795 passed, 18 skipped, 0 failures. The packaged lanes skip when their artifact or opt-in is absent; those skips are not counted as passes.
- Skill frontmatter parsed using Bun YAML; name and description match skill.json.
- Simplify: reviewed the two-file release change; no further changes needed. This narrower wording was not subjected to a new paired behavioral study; release-gate success is not a claim of measured skill effectiveness.
- `bun run package:release -- --version 2.1.3`: passed, including compiled binary signing and strict signature verification.
- `YK_RELEASE_TESTS=1 bun test tests/computer-e2e-release.test.ts tests/computer-session-release.test.ts tests/computer-lane-release-packaging.test.ts`: 14 passed, 0 failures.
- `bun run build` and `bun run smoke`: passed.
- Fresh archive extraction: strict signature, exit-0 help containing Usage, exact 2.1.3 version, runtime directory, and coding-recon bytes all passed. Generated checksum matched the actual archive.
- Git tag and GitHub Release created without overwrite. Downloaded archive and published checksum matched the validated local hash before the tap update.
- Tap updated using scripts/update-ya-skills-formula.py; formula has no explicit version line. Homebrew upgraded 2.1.2 to 2.1.3.
- Installed formula-prefix executable: strict signature, exit-0 help and exact 2.1.3 version passed. Backed up the previous global coding-recon, then installed only coding-recon with the published executable; installed bytes match the release catalog.
- GitHub Actions: https://github.com/Yaphet2015/ya-skills/actions/runs/41767117369 completed successfully. Its local-asset guard skipped checkout/build/test/upload steps, so it is not a substitute for the local gates above.
- Superseded Release Please PR #57 closed after publication; not merged.

## Evidence and cleanup

Command logs, checksum receipts, release/CI metadata and prior-artifact backups: `/private/tmp/ya-skills-release-2.1.3-20261104`.
Only this run's archive/checksum, dist/yk, dist/release/ya-skills, fresh extraction and download directories are removed after successful verification. The pre-existing stale release and previous installed skill remain backed up in the evidence directory.
