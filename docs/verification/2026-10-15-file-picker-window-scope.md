# File chooser window-scope diagnosis — 2026-10-15

## Root cause

Cua Driver 0.30.4 resolves a window-scoped observation against top-level `AXWindow` candidates. A standard attached Open panel is an `AXSheet` nested under its parent `AXWindow`, with its own CGWindowID. The driver enumerates that native window but cannot resolve its ID through the restricted AX candidate set. It therefore returns `ax_window_unresolved` and an empty tree.

The controls are exposed by macOS. Reading the parent window reaches the nested sheet and its controls. Treating the sheet's CGWindowID as a standalone AXWindow is the failing operation.

## Original LogosCowork evidence

The original cached records were retained during the failed interaction:

- Parent: PID 36221, window 132388, observation `a739afbf-2c90-436e-8aa3-f73630dbccea`.
- The parent tree already contained `AXSheet: open`, `AXTextField: Search`, and `AXButton: Cancel`.
- Its sheet frame was (893, 370, 880, 448), exactly the independent Open window's recorded bounds.
- Open panel: same PID, window 133610, observation `cf128d63-1c9c-4b4f-a2a6-aec5a5e0e44c`.
- Targeting 133610 returned zero elements and `ax_window_unresolved`: only one AXWindow was found, and its ID did not match.

The earlier operator conclusion that the chooser had no readable controls was incorrect. The parent observation already contained them; switching the target to the attached panel exposed the driver's unsupported scope.

Evidence: [original observations](evidence/2026-10-15-file-picker-window-scope/original-observations.json).

## Controlled differential reproduction

A temporary AppKit fixture creates the same NSOpenPanel in two modes. The directory shown by the chooser is an empty test directory. A separate read-only Swift probe calls AXUIElementCopyAttributeValue and _AXUIElementGetWindow. At capture, the SDK was the repository-pinned 0.30.4 dependency.

| Fixture mode | Native AX structure | Parent observation | Exact panel observation | Verdict |
| --- | --- | --- | --- | --- |
| Attached sheet | One AXWindow; nested AXSheet has the requested CGWindowID | 46 elements, including AXSheet | 0 elements, ax_window_unresolved | FAIL, exit 1 |
| Standalone panel | Two AXWindows; panel itself is AXWindow | 2 elements | 41 elements | PASS, exit 0 |

The AX probe reported trusted=true in both cases. Changing only the panel attachment mode changed failure to success. The fixtures did not select a file or send an application message, and each run awaited fixture termination in finally.

Evidence: [attached sheet](evidence/2026-10-15-file-picker-window-scope/sheet.json), [standalone panel](evidence/2026-10-15-file-picker-window-scope/standalone.json).

Live commands used:

```sh
bun /private/tmp/yk-panel-root-cause-20261015/repro.ts
bun /private/tmp/yk-panel-root-cause-20261015/repro.ts --standalone
```

The temporary diagnostic sources remain beside those commands. They require a native desktop context; the restricted sandbox's direct Swift AX query reported trusted=false, so the controlled probes ran with approved sandbox escalation.

## Exact source cause

Upstream tag `cua-driver-rs-v0.30.4`, commit `bf6c76786d938070f4ecf1e44004752f69f518b8`:

1. [tree.rs, lines 277–299](https://github.com/trycua/cua/blob/bf6c76786d938070f4ecf1e44004752f69f518b8/libs/cua-driver/rust/crates/platform-macos/src/ax/tree.rs#L277-L299) constructs candidates only from application-level children/windows, and reads a native window ID only when the role equals AXWindow.
2. [window_scope.rs, lines 133–151](https://github.com/trycua/cua/blob/bf6c76786d938070f4ecf1e44004752f69f518b8/libs/cua-driver/rust/crates/platform-macos/src/ax/window_scope.rs#L133-L151) requires role == AXWindow and an exact ID match. No match produces AxUnresolved and an empty walk.
3. [exact_target.rs, lines 100–114](https://github.com/trycua/cua/blob/bf6c76786d938070f4ecf1e44004752f69f518b8/libs/cua-driver/rust/crates/platform-macos/src/ax/exact_target.rs#L100-L114) also derives action-target records from AXWindows. A complete driver fix must keep observation and action scope consistent.

The yk adapter forwards the requested PID/window ID and preserves the degraded reason. Its legacy snapshot path separately substitutes an overbroad hidden/occluded message, which obscured this diagnosis.

## Upgrade assessment: 0.35.4

The npm latest channel and upstream versioned release both resolve to 0.35.4 (release dated October 14, 2026). The version contains an AXSheet-to-parent ownership fix for issue #4392 in [exact_target.rs](https://github.com/trycua/cua/blob/d74a9cab3fb2e80ab7f0cef47025ec828586ea75/libs/cua-driver/rust/crates/platform-macos/src/ax/exact_target.rs). It maps a sheet element to the parent AXWindow when AX proves that relationship. The independent sheet-window observation still uses the AXWindow-only resolver; the supported route is to observe the parent and address its sheet controls with tokens.

A second controlled probe used the same attached NSOpenPanel, observed the parent, then clicked its Cancel token exactly once. The fixture stayed alive after cancellation so the driver could return its action receipt. A fixture callback recorded the actual modal response independently of driver metadata.

| SDK/native version | Driver receipt | Fixture Cancel callback | Verdict |
| --- | --- | --- | --- |
| 0.30.4 | element_outside_target_window | Absent | FAIL, exit 1 |
| 0.35.4, explicit embedded mode | Accessibility AXPress; effect remains unverifiable | response=0, exact fixture PID | PASS, exit 0 |

The new driver's effect metadata alone does not confirm success; the independent fixture callback does. Both runtimes reported sameProcess=true. Both test processes were terminated and awaited by the harness.

Evidence: [0.30.4 action](evidence/2026-10-15-file-picker-window-scope/action-0.30.4.json), [0.35.4 action](evidence/2026-10-15-file-picker-window-scope/action-0.35.4.json). These records were captured with `bun /private/tmp/yk-panel-root-cause-20261015/action-repro.ts` and the same command with `--latest`, before upgrading the repository dependency. The retained JSON records preserve that before/after comparison.

During the assessment, the latest package was installed only in the temporary diagnostic directory. An initial create(undefined) call preferred the installed daemon and failed with contract version 0.7.0 versus SDK 0.8.0. Explicit embedded mode selected the matching 0.35.4 native runtime and passed. Therefore a yk upgrade must retain its process-ownership contract explicitly, update the SDK/native/package-release pins together, and verify the typed/result adapters and packaged runtime. A dependency-number-only change is insufficient.

Upgrade to 0.35.4 is justified by this real before/after result. Using the main window's sheet tokens is also required. At the assessment stage, successful input delivery was established on the controlled fixture, not on the original LogosCowork chooser. The following section records the subsequent product upgrade.


## Implemented upgrade and validation

The repository now pins both the TypeScript SDK and macOS arm64 native package to 0.35.4. The release packager pins the same versions. Production and diagnostic constructors explicitly pass `{ embedded: true, claudeCodeCompatibility: false }` so an unrelated installed daemon cannot change process ownership or cause a protocol mismatch. The lazy import boundary is unchanged.

A real packaged-session probe also exposed an existing worker bug: extracting `ensure().executeStep` detached the method from its ComputerSession receiver. The first step failed before native dispatch with `undefined is not an object (evaluating 'this.batchDeadlineAt')`. The worker now invokes the method through the session object. A desktop-free subprocess regression uses the real session factory, real step dispatcher, and mocked SDK transport. It failed with the daemon mismatch before the constructor fix, then with the receiver error before the worker fix, and passes with both fixes. It checks lazy construction, one background input, and ordered cleanup.

Validation after both fixes:

- Typecheck: passed.
- Default tests: 772 passed, 11 configured skips, zero failures. A restricted-sandbox run initially failed user-cache writes and process checks; rerunning with access to those facilities passed.
- Release package: assembled by the standard packaging script with matching 0.35.4 SDK/native packages.
- Packaged E2E and runtime assembly tests: 8 passed, zero failures.
- Build and smoke: passed.
- Installed `yk computer-use doctor`: ok=true, version=0.35.4, sameProcess=true, Accessibility=true, Screen Recording=true. The existing local yk launcher resolves to this rebuilt package.

The final product check passed after the user unlocked the desktop. The rebuilt compiled yk opened a persistent session against a fresh fixture's parent window (PID 43299, window 134376), observed the sheet and Cancel token, and dispatched exactly one selector click. Its receipt retained route=accessibility, effect=unverifiable, and delivery=background. The independent AppKit callback recorded response=0 for the exact fixture PID, confirming cancellation. The post-action observation contained only the parent window and its close button. Session close reported driverTerminated=true, leaseReleased=true, and no unresolved requests; the harness then terminated and awaited the fixture.

An earlier final-package attempt occurred while loginwindow (PID 426) was frontmost. AX exposed no AXWindows in that state; no input was dispatched. That locked-desktop record is retained separately. The successful product result uses a newly created fixture and session after unlocking. Successful input delivery is now verified through the packaged yk CLI as well as the earlier direct SDK comparison; the original LogosCowork chooser was not reopened.

Evidence: [upgrade checks](evidence/2026-10-15-file-picker-window-scope/upgrade-validation.json), [packaged chooser cancellation](evidence/2026-10-15-file-picker-window-scope/upgraded-package.json), [earlier locked desktop probe](evidence/2026-10-15-file-picker-window-scope/upgraded-package-locked.json).
