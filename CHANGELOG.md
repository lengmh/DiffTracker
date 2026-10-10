# Changelog

## 0.8.2

- Add **Restore Archived Git Review** to the Command Palette. Restore the most recent Archive & Rebuild review, when compatible, after confirming replacement, with a separate pre-restore backup and current-file reconciliation. Active and stopped sessions are supported; workspace files and Git state are not modified.
- Fail closed when repository identity, monitoring scope, ignore policy or observation coverage changes during archive restoration. Preserve unknown before-images and recovery evidence if restoration cannot finish safely.
- Add a coverage-diagnostic shortcut to stage an exact directory exclusion in Workspace Settings. Preserve existing rules and unsaved scope-editor drafts; applying the scope remains explicit.
- Add category-specific file and folder review actions, including guarded text Accept/Revert, opaque Acknowledge and confirmed current-disk baseline reset for Unknown entries. Protect newer reviews from stale asynchronous reads.
- Clear stale imported-directory coverage warnings after explicit subtree exclusion, and suppress repeated delivered Git-pause dialogs across reactivation while retaining the paused safety state.

## 0.8.1

- Add configurable WebView defaults for Split/Unified layout, Wrap, and Expand (all unchanged context lines) in VS Code settings and the sidebar Display group. Existing defaults remain Split, Wrap off, and Expand off.
- Apply these defaults when a new WebView panel is created. Toolbar choices remain local to the current panel across refreshes and file switches; close and reopen to apply changed defaults.

## 0.8.0

These notes accompany the `0.8.0` source release preparation; they do not announce a published tag, GitHub release or Marketplace package. The merged feature candidate passed its bounded checks; the final release VSIX must separately pass the [release gates](docs/releasing.md) before publication.

- Add file-level text, opaque and unknown review visibility, version-checked **Acknowledge Read-only Change**, and mixed accept/acknowledge semantics. Non-text content is not backed up and cannot be reverted.
- Add the unified **Manage Monitoring Scope** manager, Rules and Whole Workspace modes, local scope-expansion consent, bounded preparation, explicit scope recovery controls and visible observation gaps.
- Persist effective scope and durable gap evidence in Session V4 while retaining supported older session data and blocking incompatible downgrades. Released `0.7.2` already provides opaque identity storage; migration preserves that evidence when present.
- Add bounded supplemental observation and imported-directory watcher handoff for the verified local Windows/Linux scope, without raising resource limits or claiming universal filesystem coverage.
- Add **Recheck Observation Coverage** to reinstall coverage and compare against original review baselines without accepting changes or modifying workspace files.
- Add optional stable-API Native Review with immutable text snapshots, guarded file/full-block Keep/Revert, real Quick Diff navigation and Multi Diff where available. VS Code 1.80 retains the file-picker/single-file Diff fallback.
- Add `nativeReview` to `diffTracker.defaultOpenMode` and the sidebar **Display → Default open mode** picker. The five existing values remain available, the default remains `webview`, opaque/unknown resources use WebView, and Quick Diff remains a separate disabled-by-default opt-in.

Bounded verification includes real installed-product activation and process-restart recovery, released `0.7.2` V3→V4 text/session migration with ordered legacy rules preserved, candidate-created opaque recovery, and mixed-workspace resource checks. It does not prove a physical **Reload Window** click or released-asset opaque migration. Exact candidate/main CI evidence and historical failures are retained in the [bounded RC checkpoint](docs/bounded-rc-checkpoint.md).

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
