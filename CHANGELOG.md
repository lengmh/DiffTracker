# Changelog

## [Unreleased]

The entries below describe development work. The source package version remains `0.7.2`; no new release or RC pass is implied. Verification status is recorded in the [Native Review checkpoint](docs/s5-native-review-checkpoint.md) and [bounded RC checkpoint](docs/bounded-rc-checkpoint.md).

- Add file-level text, opaque and unknown review visibility, version-checked **Acknowledge Read-only Change**, and mixed accept/acknowledge semantics. Non-text content is not backed up and cannot be reverted.
- Add the unified **Manage Monitoring Scope** manager, Rules and Whole Workspace modes, local scope-expansion consent, bounded preparation, explicit scope recovery controls and visible observation gaps.
- Persist effective scope and durable gap evidence in Session V4 while retaining supported older session data and blocking incompatible downgrades. Released `0.7.2` already provides opaque identity storage; migration preserves that evidence when present.
- Add bounded supplemental observation and imported-directory watcher handoff for the verified local Windows/Linux scope, without raising resource limits or claiming universal filesystem coverage.
- Add **Recheck Observation Coverage** to reinstall coverage and compare against original review baselines without accepting changes or modifying workspace files.
- Add optional stable-API Native Review with immutable text snapshots, guarded file/full-block Keep/Revert, real Quick Diff navigation and Multi Diff where available. VS Code 1.80 retains the file-picker/single-file Diff fallback.
- Add `nativeReview` to `diffTracker.defaultOpenMode` and the sidebar **Display → Default open mode** picker. The five existing values remain available, the default remains `webview`, opaque/unknown resources use WebView, and Quick Diff remains a separate disabled-by-default opt-in.
- Prepare bounded installed-VSIX upgrade/recovery and mixed-workspace resource checks. New acceptance outcomes remain pending until their corresponding logs and artifacts are verified.

## 0.7.2

- Fix **Clear Diffs** immediately recreating unavailable reviews for stable unsupported files. **Stop Recording** followed by **Clear Diffs** now persists an empty stopped session without modifying workspace files.
- Preserve opaque baseline existence and content identity for UTF-8 BOM, binary, invalid-UTF-8, and oversized resources. Detect subsequent deletion, replacement, format changes, and file-to-directory replacement, including changes made while VS Code was closed.
- Unify workspace-scan and repository-rebuild acceptance checks. Concurrent editor and watcher changes remain unresolved, even if an editor is saved or closed before the scan completes; already-captured before-images are not overwritten or downgraded.
- Preserve dirty-editor reviews across identical disk replacement notifications. Clean save, reload, and unchanged create notifications reconcile actual bytes instead of creating false pending reviews or treating unsupported content as a text baseline.
- Preserve newly observed file/editor changes when repository rebuilds roll back after a Git-context change, Stop, or persistence failure.
- Use streaming SHA-256 identity for oversized files so same-size, timestamp-preserving rewrites are detected without loading the entire file into memory. The 5 MiB text-review limit remains unchanged.
- Write session schema **V3** while migrating V1/V2 sessions. Older releases reject V3 rather than silently discard opaque identities; downgrade recovery remains blocked until the user explicitly handles the incompatible state.
- Accept valid finite pre-epoch modification timestamps while retaining strict validation of malformed metadata.
- Add cross-product production regressions for unsupported formats, scan scopes, editor transitions, rollback, persistence, and schema compatibility, plus downgrade checks against the released 0.7.1 source. Verification details are maintained in `docs/opaque-baseline-invariants.md`.

## 0.7.1

- Prevent delayed VS Code Git initialization from being misclassified as a repository appearing after the review baseline.
- Make the initial Git reconciliation boundary emit `ready` before any repository `changed` or `removed` events.
- Add regression coverage for repository open, close, and HEAD-change events that occur while the Git API is still uninitialized.

## 0.7.0

- Publish under the unique Marketplace identity `lengmh.code-diff-tracker` and display name **Code Diff Tracker**.
- Preserve file-existence semantics for empty, created, deleted, and restored files.
- Keep failed or conflicted items visible during file, hunk, and batch review actions.
- Reject stale CodeLens and Webview actions with versioned review tokens.
- Coordinate same-file review actions and session lifecycle callbacks to prevent stale writes.
- Persist versioned sessions atomically with last-known-good recovery, strict migration, and corruption blocking.
- Add bounded **Undo Last Revert** recovery for file, hunk, creation, deletion, and batch reverts.
- Pause review writes when a Git branch, detached HEAD, worktree, or conflict context changes; add explicit archive-and-rebuild recovery.
- Recognize VS Code file-creation events so new text files receive an explicit absent baseline, exclude binary additions from text review counts, and explain that dirty files must be saved before Keep/Revert.
- Add Linux and Windows quality gates, real VS Code Stable Extension Host tests, temporary-repository Git tests, and workspace performance measurements.

## 0.6.0

- Persist recording sessions and workspace baselines across VS Code restarts.
- Add automation-only tracking and automation session commands.
- Add configurable Webview placement and automatic recording on activation.

## Earlier versions

See the repository history for the 0.1.x–0.5.x changes inherited from the upstream project.
