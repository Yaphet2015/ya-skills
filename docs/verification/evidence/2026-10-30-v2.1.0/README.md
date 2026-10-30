# v2.1.0 release evidence

Release commit: `91878da0b91b5baabdeed0582bf69f3e15ceca69`.
Release: https://github.com/Yaphet2015/ya-skills/releases/tag/v2.1.0

Added ui-parity and updated English/Chinese catalogs and the major-version policy.
Simplify reviewed the full change; only release instruction line wrapping needed cleanup.

Validation passed: typecheck; default suite (795 pass, 18 opt-in skips, 0 fail); shared release packaging with signing and strict verification; packaged lane (14 pass, 0 fail); build; smoke; fresh archive extraction with strict signature, help and exact version checks; installed Homebrew executable signature, help, version and catalog; ui-parity installation with all three files compared byte for byte against the source catalog.

The first default suite failed 13 stderr assertions because the session set both NO_COLOR and FORCE_COLOR. Its log is retained. Removing FORCE_COLOR only in verification subprocesses resolved the warning; the full suite passed on rerun. No code was changed for this environment issue. The first tag push failed with a transient GitHub TLS error; retry succeeded, as recorded in publish.jsonl.

Local, uploaded and downloaded archive SHA-256: `ef92d55b6fbccf2656cced8a49165e0bf445ac8a3e1fc8a93708e12c646ddf47`.
The Homebrew tap formula was updated, committed and pushed, then upgraded locally to 2.1.0. Formula has no explicit version field.
Release Please PR #54 was closed after confirming it targeted the version already published.

CI: https://github.com/Yaphet2015/ya-skills/actions/runs/41035664358 — success. The local-release guard skipped CI packaging and validation because uploaded assets existed. Those skipped CI gates are not counted as checks passed; local gates above provide the validation.

commands.jsonl records gates, including the first failed run. publish.jsonl records archive, upload, download, tap and installed-binary commands and results. No required local gate was omitted. Native desktop integration is opt-in and was not run for this catalog release.

After successful validation, this run's archive, checksum, dist/yk, dist/release/ya-skills, extraction, download and temporary installation directories were removed. Logs and metadata are retained here.
