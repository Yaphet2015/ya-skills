# Map changes to observable surfaces

Build the mapping from the target repository's routes, callers, commands, and launch configuration. The following are search hints, not a fixed path contract. A file name alone does not establish an entrypoint.

| Change | Trace to | Useful manual observation |
| --- | --- | --- |
| UI component/style | All consumers, route/window owners, accessible labels | Named control, visible state, interaction result; each materially different rendering point |
| Locale/text | Key consumers, language selector, fallback rules | Exact text after language switch, fallback and layout |
| Secondary window, preview, quick launcher | Window creation, menu/shortcut registration, supported fixture | Exact launch action, focus, window contents and close/reopen result |
| Browser panel | Tab/navigation owner and bridge | Open a known URL, navigate, then observe panel/tab state |
| Recording/media | Permission flow and recorder state machine | Permission result, recording indicator, output file and playback |
| API/message stream | Caller, transport, state transition, recovery handler | Request/response identity, UI transition, observable recovery |
| Database/migration | Schema, migration runner, callers | Read-only query or log with precise expected row/schema; use a disposable database for mutation setup |
| Main process/background service | Registration, caller, notification/file/log producer | Exact observable output; if absent, state the observability gap |
| Startup/configuration | Launch scripts, environment, connection setup | Restart with the actual command, inspect ready state or known diagnostic |
| Build/package/tooling | Public command and artifact consumer | Exit code, generated file, installation or launch behavior |
| Docs/tests | Published instructions, shipped fixtures, behavioral assertions | Explain why no manual check is needed, or map changed instructions/fixtures to a real case |

For Cowork/Electron repositories, inspect renderer components, main-process window creators, preload/IPC contracts, and gateway services as appropriate. Confirm actual paths in that checkout. Do not carry guessed paths, ports, shortcuts, or selectors from a different clone.

For each surface record:

- Changed path/symbol and current file:line; baseline SHA/path/line separately.
- Actual entrypoint and which clone/process/window owns it.
- Required build/reload/restart and the command's source.
- Data, account, service, language, permissions, or fixture prerequisites.
- Observable success/failure and how to restore altered local state.

Shared changes can affect multiple surfaces. Add separate cases when entrypoints or expected outcomes differ; combine equivalent entrypoints into a short variant list. Renamed/deleted files need both old and new caller checks. A purely internal refactor can be marked “无需新增人测” with its evidence and any existing regression case it depends on.
