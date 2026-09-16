# Diff Tracker

Review workspace changes as they happen, then keep or safely revert them by block,
file, or batch. Version 0.7.0 adds versioned review actions, durable session recovery,
bounded **Undo Last Revert**, and Git-context safety.

Undo that would delete a restored file requires manual deletion: inspect and delete
that file yourself, then retry Undo to acknowledge it. The recovery record remains
available until then. VS Code does not provide a conditional, version-checked file
deletion, so this branch never automatically deletes potentially newer work.
Revert of a file absent from the baseline follows the same rule: inspect and delete
it manually; the watcher clears its pending review after deletion. Batch Revert
reports that item as a conflict while continuing with other files.
Restoring a deleted file publishes fully written content with an exclusive hard
link. If the destination appears concurrently or the filesystem does not support
hard links, the action reports a conflict without overwriting the destination.
New snapshots and recovery records preserve POSIX permission bits, including
executability. Older sessions without mode metadata use the normal creation mode
filtered by the process umask; original permissions cannot be inferred retroactively.
Fresh recording waits for an available Git API to initialize before taking its baseline.
Baseline growth and Keep must persist before review resumes. An interrupted or
failed session write leaves a recovery marker and blocks automatic restoration;
preserve the session and workspace before explicitly rebuilding.

This is the [lengmh/DiffTracker](https://github.com/lengmh/DiffTracker) fork of
[TinyTigerPan/DiffTracker](https://github.com/TinyTigerPan/DiffTracker), retaining the
MIT license and upstream attribution. Its Marketplace extension ID is
`lengmh.diff-tracker`.

> If `TinyTigerPan.diff-tracker` is installed, disable it before enabling this fork.
> Both extensions register the same commands, views, and configuration keys and are
> not supported side by side. Their VS Code storage is separate, so review sessions
> are not migrated automatically.

Diff Tracker blocks a review action when the displayed version is stale, a file is
unsafe to decode or write, or the repository has moved to a different Git context.
When a Git branch, detached HEAD, worktree, or conflict context changes, existing
review data remains available but writes pause until you explicitly archive and
rebuild that repository's baseline. Session data is written atomically and keeps a
last-known-good copy; corrupt recovery data is reported instead of silently replaced.

Automation-only mode conservatively retains editor changes whose source cannot be
proven. Saving a document does not silently accept it. Extensions can use the
existing automation-session API to identify their own edits.

Unsupported text encodings, binary or oversized files, UTF-8 BOM files, unreadable
files, paths outside the workspace, and symlink write targets are review-only or
skipped; Diff Tracker will not decode and write them back speculatively. Pure EOL
style changes are treated as no logical content change.

[中文说明](./README_CN.md)


Diff Tracker is a VS Code extension that records file changes and provides three review modes:
- Inline readonly diff document
- VS Code side-by-side diff
- Cursor-like WebView diff with floating Undo/Keep actions

**Fork From [wizyoung/DiffTracker](https://github.com/wizyoung/DiffTracker)**


## Screenshots

💥 **Highlights in 0.6.0: Auto-start recording, persistent review sessions, automation-only tracking, and more flexible WebView opening behavior.**

| Cursor like WebView Unified | Cursor like WebView Split |
|:---------------:|:--------------:|
| ![Word diff](./resources/webview1.png) | ![Settings](./resources/webview2.png) |

|               Editor Inline View                |    Editor Inline View (hover effect)    |
| :---------------------------------------------: | :-------------------------------------: |
| ![Editor highlighting](./resources/inline1.png) | ![Inline diff](./resources/inline2.png) |

| Inline View 2 | Side-by-side diff |
|:---------------:|:--------------:|
| ![Word diff](./resources/diff2.png) | ![Settings](./resources/diff3.png) |


## Features
- [New 🚀] Pending, unaccepted changes survive VS Code restarts and are restored from the saved baseline
- [New 🚀] Automation-only tracking mode for AI/agent or extension-driven edits
- [New 🚀] Configurable WebView opening position (`current group` or `beside`)
- [New 🚀] Automatically start recording file changes after the extension is activated
- Activity Bar **Change Recording** tree with file grouping
- Recording mode (start/stop) with workspace baseline snapshot
- Workspace-wide file watching (including external file changes)
- Inline readonly diff view with line and word-level highlights
- Side-by-side diff (`Original ↔ Current`) via built-in VS Code diff
- Cursor-like WebView diff (Split/Unified, Wrap, Expand, Keep All, Reject All)
- Block-wise actions: Undo/Keep per change block
- File-level actions: Revert file, Revert all files, Keep all changes in file
- Deleted-line badge, CodeLens actions, and hover details
- Settings panel + Watch Ignore editor (`.gitignore` style patterns)

## Usage

1. Open **Diff Tracker** from the Activity Bar.
2. Recording starts automatically after the extension activates.
3. Edit files in your workspace.
4. In **Change Recording**, click a changed file to open inline diff.
5. Use context menu or editor title buttons to open:
   - Inline Diff (active file)
   - Side-by-Side Diff
   - WebView Diff
6. In WebView Diff, use block-level **Undo/Keep** or file-level **Keep All/Reject All**.
7. Use **Revert File** / **Revert All Changes** as needed.
8. Stop recording when done.

## How It Works

When recording starts, Diff Tracker:
1. Captures baseline snapshots for workspace files (batched)
2. Tracks file/document changes and rebuilds line/block diffs
3. Serves virtual inline/original documents
4. Restores pending changes after restart until they are accepted/reverted or the baseline is cleared
5. Keeps tree, decorations, CodeLens, and WebView in sync

## Installation

### Marketplace

Search for **Diff Tracker** by publisher `lengmh`, or run:

```bash
code --install-extension lengmh.diff-tracker
```

### From VSIX
1. Download the .vsix file
2. Open VS Code
3. Open Extensions (Cmd+Shift+X)
4. Click ... -> Install from VSIX...
5. Select the downloaded .vsix

### Development
1. Clone the repository
2. Run npm install
3. Run npm run compile
4. Press F5 to launch the Extension Development Host

## Requirements

- VS Code ^1.80.0

## Extension Settings

This extension provides the following settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `diffTracker.showDeletedLinesBadge` | `true` | Show a badge indicating deleted lines |
| `diffTracker.showCodeLens` | `true` | Show CodeLens actions (Revert/Keep) above change blocks |
| `diffTracker.highlightAddedLines` | `true` | Highlight added lines with green background |
| `diffTracker.highlightModifiedLines` | `true` | Highlight modified lines with blue background |
| `diffTracker.highlightWordChanges` | `true` | Highlight word-level changes within modified lines |
| `diffTracker.openWebviewBeside` | `false` | Open Webview diff in a side editor group instead of the current editor group |
| `diffTracker.watchExclude` | `[]` | Additional watch ignore patterns (`.gitignore` style) |
| `diffTracker.onlyTrackAutomatedChanges` | `false` | Track external/tagged automation edits; retain uncertain editor edits for explicit review without automatic baseline acceptance |

You can toggle display/highlight settings in the sidebar **Settings** panel, and edit watch ignore patterns via **Edit Watch Ignores**.

When `diffTracker.openWebviewBeside` is enabled, Webview diff opens in a side editor group. By default it opens in the current editor group.

When `diffTracker.onlyTrackAutomatedChanges` is enabled:
- Editor events without reliable source information remain visible with an uncertainty notice
- External tools/CLI that modify files on disk are still tracked through file watchers
- VS Code extensions should call `diffTracker.beginAutomationSession` before applying edits, and `diffTracker.endAutomationSession` after they finish

Example integration from another VS Code extension:

```ts
const sessionId = await vscode.commands.executeCommand<string>(
  'diffTracker.beginAutomationSession',
  { allFiles: true, ttlMs: 30000 }
);

try {
  // apply WorkspaceEdit or editor edits here
} finally {
  await vscode.commands.executeCommand('diffTracker.endAutomationSession', sessionId);
}
```

## Known Issues

- Pure line-ending-style changes (CRLF/LF only) are currently treated as no logical content change.
- If you find a reproducible diff/render edge case, please open an issue with a minimal file sample.

## Release Notes

### 0.7.0

- Add stale-action rejection and serialized same-file review actions
- Add atomic session persistence, last-known-good recovery, strict migration, and corruption blocking
- Add bounded **Undo Last Revert** for file, hunk, creation, deletion, and batch reverts
- Pause writes across Git branch, detached HEAD, worktree, and conflict-context changes
- Preserve failed/conflicted batch items and empty-file existence semantics
- Add Linux and Windows CI, real VS Code Stable Extension Host coverage, and performance measurements

### 0.1.0

- Activity Bar entry
- Recording mode for change tracking
- Inline diff highlighting
- Side-by-side diff
- Multi-file tracking with timestamps
- Revert file and revert all
- Clear diffs

### 0.2.0
- Change from LCS-based diff to Patience Diff algorithm for more intuitive diff display

### 0.3.0
- Add Partial Revert/Keep buttons, just like cursor
- Add go-to-original-file button in left panel

### 0.3.1
- Add file-level "Revert All" / "Keep All" buttons (CodeLens at file top)
- Add settings panel in sidebar to toggle display options
- Fix block-wise keep/revert affecting all blocks instead of just one
- Fix hover showing "unknown" for deleted empty lines

### 0.3.2
- Tiny bug fix

### 0.3.3
- Add word-level diff highlighting for modified lines
- Add "Highlight Word Changes" setting to toggle word-level highlighting

### 0.4.0
- Cursor-like WebView diff: floating Undo/Keep, unified view default, wrap/expand, and Keep All/Reject All in the toolbar
- Offline WebView rendering (bundled @pierre/diffs)
- Workspace-wide file watching (no longer limited to open files)
- New Watch Ignore panel with `.gitignore` support
- Faster tracking in large workspaces (debounced changes + optimized watchers)
- Smoother recording start on big repos (baseline builds in batches, large files skipped)

### 0.4.1
- Refactor diff pipeline to use a unified logical-line model
- Stabilize block grouping for large paste/delete and EOF scenarios
- Fix WebView empty-file rendering fallback that could hide block actions after full deletion
- Unify inline virtual URI mapping and refresh flow to prevent stale inline readonly content
- Improve mixed newline handling (LF/CRLF/CR) in Keep/Revert block operations

### 0.5.0
- Add Explorer file context action for Diff Tracker while recording, with the final label: **Open with Diff Tracker**
- Add configurable default open mode for changed files (WebView / Inline / Side-by-side / Original / Split Original+WebView)
- Add `Open split view` mode (left original file + right WebView diff)
- Add global recording toggle shortcut: `Shift+Alt+D`
- Improve changes tree to workspace-relative nested directory grouping
- Use VS Code native file icons in the changes tree
- Show changed-file count badge on the Diff Tracker activity icon
- Add and streamline global file actions in changes view workflows (Keep All / Revert All)
- Add `Clear Diffs` baseline reset to current workspace state
- lots of optimizations & fixes

### 0.5.1
- Improve recording controls in Change Recording with inline start entry, starting status, and title start/stop actions

### 0.5.2
- Fix watch ignore rules not refreshing in some recording states
- Reuse snapshot filtering in watcher updates to avoid tracking binary/oversized files
- Clear pre-seeded empty baseline for non-trackable created files in watcher flow

### 0.6.0
- Persist recording session state and workspace baselines so pending diffs can be restored after restarting VS Code
- Add `diffTracker.onlyTrackAutomatedChanges` plus `diffTracker.beginAutomationSession` / `diffTracker.endAutomationSession` for automation-aware tracking workflows
- Add `diffTracker.openWebviewBeside`, expose the new recording/display toggles in the settings tree, and make WebView diff open behavior more configurable
- Start recording automatically after activation and restore decorations/tree state when a previous session is resumed

## License

MIT

## Acknowledge
[![LinuxDO](https://img.shields.io/badge/Community-Linux.do-blue?style=flat-square)](https://linux.do/)

Discuss, free ai, and get help at [linux.do](https://linux.do/).
