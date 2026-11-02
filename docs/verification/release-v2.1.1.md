# v2.1.1 release verification

- Release commit: 62f902e; tag: v2.1.1; tap commit: f14d69d.
- Release: https://github.com/Yaphet2015/ya-skills/releases/tag/v2.1.1
- Archive SHA-256 (local and downloaded): `9dbbfa560a3263818186b68be45c316a830e5f1260cdacc84fa6200748a98f7f`.
- macOS arm64; Bun 1.4.0.
- `bun run typecheck`: passed. `bun run test`: initial run failed with FORCE_COLOR/NO_COLOR warnings; rerun with FORCE_COLOR unset passed.
- `bun run package:release -- --version 2.1.1`: passed; signed and verified binary.
- Release tests: `YK_RELEASE_TESTS=1 bun test tests/computer-e2e-release.test.ts tests/computer-session-release.test.ts tests/computer-lane-release-packaging.test.ts`: passed with FORCE_COLOR unset.
- `bun run build` and `bun run smoke`: passed. Fresh archive extraction: signature, help, version, runtime and skills checks passed; checksum matched.
- Homebrew upgrade: passed; installed binary signature, help and version checks passed.
- GitHub Actions: https://github.com/Yaphet2015/ya-skills/actions/runs/41409566845 reported success; its results do not replace the local gates above.
- Release Please PR #55 closed after local publication.
