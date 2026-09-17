# Code Diff Tracker

Code Diff Tracker is a VS Code extension that records workspace file changes and provides three review modes:

- Inline read-only diff document
- VS Code side-by-side diff
- Cursor-like WebView diff with floating Undo/Keep actions

Review changes as they happen, then keep or safely revert them by block, file, or batch. Pending reviews can survive VS Code restarts, stale review actions are rejected, and Git-context changes are guarded before write operations continue.

[中文说明](./README_CN.md)

This repository is the `lengmh/DiffTracker` continuation of the DiffTracker fork lineage:
[`wizyoung/DiffTracker`](https://github.com/wizyoung/DiffTracker) →
[`TinyTigerPan/DiffTracker`](https://github.com/TinyTigerPan/DiffTracker) →
[`lengmh/DiffTracker`](https://github.com/lengmh/DiffTracker).
The project retains the MIT license and upstream attribution. The Marketplace extension ID is `lengmh.code-diff-tracker`.

> **Compatibility note:** Before installing, disable or uninstall `TinyTigerPan.diff-tracker` and any earlier test VSIX published as `lengmh.diff-tracker`. These extensions register the same commands, views, and configuration keys and are not supported side by side. VS Code treats each extension ID separately, so saved review sessions are not migrated between IDs.

## Screenshots

| Cursor-like WebView Unified | Cursor-like WebView Split |
|:---------------:|:--------------:|
| ![Word diff](./resources/webview1.png) | ![Settings](./resources/webview2.png) |

|               Editor Inline View                |    Editor Inline View (hover effect)    |
| :---------------------------------------------: | :-------------------------------------: |
| ![Editor highlighting](./resources/inline1.png) | ![Inline diff](./resources/inline2.png) |

| Inline View 2 | Side-by-side diff |
|:---------------:|:--------------:|
| ![Word diff](./resources/diff2.png) | ![Settings](./resources/diff3.png) |

## Features

- Persistent review sessions: pending, unaccepted changes survive VS Code restarts
- Versioned review actions that reject stale CodeLens and WebView operations
- Block-, file-, and batch-level Keep/Revert workflows
- Bounded **Undo Last Revert** recovery for supported revert operations
- Git-context protection for branch, detached HEAD, worktree, and conflict changes
- Automation-only tracking mode for AI/agent or extension-driven edits
- Configurable WebView opening position (`current group` or `beside`)
- Automatic recording after extension activation
- Activity Bar **Change Recording** tree with file grouping
- Workspace baseline snapshots with start/stop recording controls
- Workspace-wide file watching, including external file changes
- Inline read-only diff view with line- and word-level highlights
- Side-by-side diff (`Original ↔ Current`) through the built-in VS Code diff editor
- Cursor-like WebView diff with Split/Unified, Wrap, Expand, Keep All, and Reject All
- Deleted-line badges, CodeLens actions, and hover details
- Settings panel and Watch Ignore editor with `.gitignore`-style patterns

## Usage

1. Open **Code Diff Tracker** from the Activity Bar.
2. Recording starts automatically after the extension activates and establishes a baseline.
3. Edit files in your workspace.
4. In **Change Recording**, select a changed file to open the configured review view.
5. Use the context menu or editor title actions to open:
   - Inline Diff
   - Side-by-Side Diff
   - WebView Diff
6. In WebView Diff, use block-level **Undo/Keep** or file-level **Keep All/Reject All**.
7. Use **Revert File** / **Revert All Changes** when needed.
8. Stop recording when you no longer want to track changes.

**Clear Diffs** resets the baseline to the current workspace while recording. When recording is stopped, it clears the saved baseline and Undo history and remains stopped, including after reload. It does not modify workspace files or dirty buffers.

## How It Works

When recording starts, Code Diff Tracker:

1. Captures baseline snapshots for supported workspace files.
2. Tracks file and document changes and rebuilds line/block diffs.
3. Serves virtual inline/original documents for review views.
4. Persists the baseline and pending reviews so they can be restored after restart.
5. Keeps the tree, decorations, CodeLens, and WebView synchronized.
6. Verifies review version, file state, persistence state, and Git context before mutating reviewed files.

## Safety and Recovery Behavior

### Review consistency and persistence

Code Diff Tracker rejects an action when the displayed review is stale, the baseline is incomplete, persistence has failed, or the target cannot be validated safely. Session state is written atomically and retains a last-known-good copy. If recovery data is corrupt or a session write is interrupted, automatic restoration is blocked instead of silently replacing the saved review state.

Baseline growth and Keep operations must be persisted before review actions resume.

### Git context changes

Fresh recording waits for the VS Code Git API to become ready before establishing the Git baseline. If a repository later changes branch, detached HEAD, worktree identity, or enters an unstable merge/rebase state, existing review data is preserved but write actions for that repository pause. Use **Archive and Rebuild Paused Git Baseline** only after the repository reaches a stable state.

Ordinary commits on the same named branch do not invalidate the review context.

### Created and deleted files

Code Diff Tracker does not automatically delete a file when a Revert or Undo operation would remove a file that was absent from the baseline. VS Code does not expose a conditional, version-checked delete primitive, so automatic deletion could destroy newer work. Inspect and delete the file manually, then retry the operation if required. Batch Revert reports that item as a conflict and continues with other eligible files.

When restoring a deleted file, Code Diff Tracker publishes fully written content without overwriting a destination that appeared concurrently. If the destination already exists or the filesystem cannot provide the required safe publication behavior, the action reports a conflict.

### Baseline and ignore provenance

A newly discovered path is classified as a new file only when Code Diff Tracker has sufficient baseline-scan provenance to prove that it was absent. Files exposed by changed ignore rules, or restored from older sessions without compatible scan provenance, remain pending with an unknown baseline until an explicit rebuild. Existing known baselines are preserved.

Changes to folder-scoped or nested ignore semantics may invalidate older scan provenance even when the visible rule text is unchanged.

### Unsupported or unsafe files

Binary files, unsupported text encodings, UTF-8 BOM files, oversized or unreadable files, paths outside the workspace, and unsafe symlink write targets are skipped or retained as unavailable review entries instead of being decoded and written speculatively. Pure line-ending-style changes are treated as no logical content change.

New snapshots and recovery records preserve POSIX file permission bits, including executability. Older sessions without mode metadata cannot reconstruct original permissions. Missing parent directories created during recovery use private permissions (`0700`, subject to umask); existing directory permissions are not changed. Directory ACLs and historical directory modes are not reconstructed automatically.

### Automation-only mode

Automation-only mode conservatively retains editor changes when their source cannot be proven. Saving a document does not silently accept those changes. Extensions can use the automation-session API described under **Extension Settings** to identify their own edits.

## Installation

### Marketplace

Search for **Code Diff Tracker** by publisher `lengmh`, or run:

```bash
code --install-extension lengmh.code-diff-tracker
```

### From VSIX

1. Download the `.vsix` file.
2. Open VS Code.
3. Open Extensions (`Cmd+Shift+X` / `Ctrl+Shift+X`).
4. Open the Extensions menu and select **Install from VSIX...**.
5. Select the downloaded file.

### Development

1. Clone the repository.
2. Run `npm install`.
3. Run `npm run compile`.
4. Press `F5` to launch the Extension Development Host.

## Requirements

- VS Code `^1.80.0`

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `diffTracker.showDeletedLinesBadge` | `true` | Show a badge indicating deleted lines |
| `diffTracker.showCodeLens` | `true` | Show CodeLens actions (Revert/Keep) above change blocks |
| `diffTracker.highlightAddedLines` | `true` | Highlight added lines with green background |
| `diffTracker.highlightModifiedLines` | `true` | Highlight modified lines with blue background |
| `diffTracker.highlightWordChanges` | `true` | Highlight word-level changes within modified lines |
| `diffTracker.openWebviewBeside` | `false` | Open WebView diff in a side editor group instead of the current editor group |
| `diffTracker.watchExclude` | `[]` | Additional watch-ignore patterns (`.gitignore` style) |
| `diffTracker.onlyTrackAutomatedChanges` | `false` | Track external/tagged automation edits while retaining uncertain editor edits for explicit review |

Display/highlight settings can be toggled in the sidebar **Settings** panel. Watch-ignore patterns can be edited through **Edit Watch Ignores**.

When `diffTracker.openWebviewBeside` is enabled, WebView diff opens in a side editor group. By default it opens in the current editor group.

When `diffTracker.onlyTrackAutomatedChanges` is enabled:

- Editor events without reliable source information remain visible with an uncertainty notice.
- External tools or CLI processes that modify files on disk are still tracked through file watchers.
- VS Code extensions should call `diffTracker.beginAutomationSession` before applying edits and `diffTracker.endAutomationSession` after they finish.

Example integration from another VS Code extension:

```ts
const sessionId = await vscode.commands.executeCommand<string>(
  'diffTracker.beginAutomationSession',
  { allFiles: true, ttlMs: 30000 }
);

try {
  // Apply WorkspaceEdit or editor edits here.
} finally {
  await vscode.commands.executeCommand('diffTracker.endAutomationSession', sessionId);
}
```

## Upgrade Notes

When upgrading from older DiffTracker builds, saved review sessions remain associated with the extension ID that created them. Sessions from `TinyTigerPan.diff-tracker` or earlier `lengmh.diff-tracker` test builds are not migrated automatically to `lengmh.code-diff-tracker`.

If an older saved session lacks current baseline-scan provenance, newly discovered paths may require an explicit baseline rebuild. Existing pending reviews and known baselines are preserved whenever they can be validated safely.

## Known Issues

- Pure line-ending-style changes (CRLF/LF only) are treated as no logical content change.
- Unsupported or unsafe files are not eligible for text Keep/Revert actions.
- If you find a reproducible diff/render edge case, open an issue with a minimal file sample.

## Release Notes

Release history is maintained in [CHANGELOG.md](./CHANGELOG.md). GitHub releases provide the corresponding tagged release notes and source archives.

## License

MIT

## Acknowledgements

[![LinuxDO](https://img.shields.io/badge/Community-Linux.do-blue?style=flat-square)](https://linux.do/)

Discuss, free AI, and get help at [linux.do](https://linux.do/).
