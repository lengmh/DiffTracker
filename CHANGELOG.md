# Changelog

## 0.7.2

- Make **Clear Diffs** accept stable unsupported resources as an opaque baseline instead of immediately recreating an unavailable review.
- Persist opaque baseline identity for oversized, UTF-8 BOM, unsupported UTF-8, and binary resources, while preserving transient read/scan uncertainty as unresolved review state.
- Revalidate opaque baselines after restart so offline deletion, replacement, or format changes surface as unavailable reviews instead of being silently hidden.
- Keep an unchanged opaque-baseline file quiet when it is opened; later file changes or actual document edits still surface it for explicit review.
- Ensure **Stop Recording** followed by **Clear Diffs** removes unavailable reviews, unresolved markers, and opaque baseline state and persists an empty stopped session.
- Add regression coverage for Clear/reset, session reload, offline replacement/deletion, document edits, later file events, and stopped-session clearing of unsupported resources.

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

See the repository history and README release notes for the 0.1.x–0.5.x changes inherited from the upstream project.
