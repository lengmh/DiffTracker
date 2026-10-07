# Code Diff Tracker

Code Diff Tracker is a VS Code extension that records local workspace file changes. Supported text can be reviewed and safely kept or reverted; non-text resources have file-level visibility and, when their identity can be verified, an Acknowledge action. Review views include:

- Inline read-only diff document
- VS Code side-by-side diff
- Cursor-like WebView diff with floating Undo/Keep actions
- Optional Native Review with read-only, version-bound snapshots

Review changes as they happen, then keep or safely revert them by block, file, or batch. Pending reviews can survive VS Code restarts, stale review actions are rejected, and Git-context changes are guarded before write operations continue.

[中文说明](./README_CN.md)

This README describes the `0.8.1` source, adding configurable WebView display defaults to `0.8.0`. The version in source does not announce a new published package; see the [release gates](docs/releasing.md) for final-VSIX checks.

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
- Automatic recording after activation when the effective scope and baseline are ready
- Activity Bar **Change Recording** tree with file grouping
- Workspace baseline snapshots with start/stop recording controls
- Rules and Whole Workspace monitoring modes with local consent for scope expansion
- File watching within the effective scope, including external file changes and visible coverage gaps
- Read-only opaque/unknown review entries, with version-checked Acknowledge for eligible opaque changes
- Inline read-only diff view with line- and word-level highlights
- Side-by-side diff (`Original ↔ Current`) through the built-in VS Code diff editor
- Cursor-like WebView diff with Split/Unified, Wrap, Expand, Keep All, and Reject All
- Deleted-line badges, CodeLens actions, and hover details
- Settings panel and unified **Manage Monitoring Scope** editor with literal includes and restricted `.gitignore`-style excludes

## Usage

1. Open **Code Diff Tracker** from the Activity Bar.
2. Recording starts automatically when the effective scope and baseline are ready. A new or expanded scope may need local confirmation first.
3. Edit files in your workspace.
4. In **Change Recording**, select a changed file to open the configured review view.
5. Use the context menu or editor title actions to open:
   - Inline Diff
   - Side-by-Side Diff
   - WebView Diff
   - Native Review Snapshot
6. In WebView Diff, use block-level **Undo/Keep** or file-level **Keep All/Reject All**.
7. Use **Revert File** / **Revert Text Changes** for eligible text, or **Acknowledge Read-only Change** for eligible opaque changes.
8. Stop recording when you no longer want to track changes.

**Clear Diffs** resets the baseline to the current workspace while recording. When recording is stopped, it clears the saved baseline and Undo history and remains stopped, including after reload. It does not modify workspace files or dirty buffers.

**Recheck Observation Coverage** is available in the Command Palette and Settings → Tools. For an active, ready configured scope, it reinstalls failed observation coverage and performs one bounded comparison against the original review baselines. Pending text/opaque reviews and unknown before-images are preserved. It refuses while recording is stopped, scope changes or recovery are pending, or editors have unsaved changes. Activity, unsupported coverage or resource limits may leave a visible coverage gap; retry after resolving the cause. It does not accept changes, rebuild the baseline or modify workspace files. See the [bounded recovery contract](docs/recheck-observation-coverage-checkpoint.md).

## Monitoring Scope and File Types

Open **Settings → Tools → Manage Monitoring Scope**, or run **Code Diff Tracker: Manage Monitoring Scope**. The old **Edit Watch Ignores** command opens this same manager. It shows the requested scope, effective scope, pending changes, preparation errors and current observation coverage.

- **Rules** follows ordinary ignore policy. Explicit workspace-relative includes can add ignored paths; explicit exclusions still take precedence.
- **Whole Workspace** requests all monitorable resources in the workspace, including ordinarily ignored files. Explicit exclusions and safety boundaries still apply; it does not mean every path is safely observable.
- Scope expansion requires a trusted workspace and local consent tied to the workspace roots and requested scope. Shared settings do not transfer consent to another machine or extension host. Saving a request alone does not make it effective.
- Preparation is bounded. Failure, cancellation or capacity limits keep the previous effective scope and pending reviews; an unprepared workspace does not become Ready. Unsupported watcher combinations remain visibly limited or paused.
- Includes are literal relative paths. New structured excludes use restricted `.gitignore`-style patterns without `!` negation. Use the manager's migration preview for legacy string rules; do not silently rewrite them.

Text baselines store content in workspace-specific extension storage. Opaque resources, such as binary files, unsupported encodings and oversized text, retain existence and bounded identity evidence rather than new content copies. **Acknowledge Read-only Change** rechecks the reviewed identity and persists it as the new baseline. It does not modify the file, back up its bytes or create non-text Undo/Revert capability. An unreadable file or unknown before-image cannot be accepted as a verified opaque baseline merely to clear the list. Coverage diagnostics for directories are separate from file reviews.

Recovery controls have distinct purposes:

- **Apply Pending Scope** reviews and applies a requested scope; **Retry Scope Preparation** retries preparation of an already authorized scope.
- **Recheck Observation Coverage** repairs observation and compares against the original baselines, as described above.
- **Restore Effective Scope Configuration** explicitly writes the previous effective scope back to Workspace Settings; **Migrate Legacy Watch Rules** opens migration preview.
- **Clear Diffs** rebuilds the baseline while recording, or clears saved review state while stopped. It is not a substitute for Recheck.

## How It Works

When recording starts, Code Diff Tracker:

1. Captures baseline snapshots for supported workspace files.
2. Tracks file and document changes and rebuilds line/block diffs.
3. Serves virtual inline/original documents for review views.
4. Persists the baseline and pending reviews so they can be restored after restart.
5. Keeps the tree, decorations, CodeLens, and WebView synchronized.
6. Verifies review version, file state, persistence state, and Git context before mutating reviewed files.

## Safety and Recovery Behavior

### Optional Native Review

Choose **Native Review** in **Settings → Display → Default open mode**, or set `diffTracker.defaultOpenMode` to `nativeReview` in VS Code settings. Clicking a changed file then uses the existing guarded Native Review adapter. The original target and URI provenance are preserved; opaque and unknown resources use the WebView fallback. The default remains `webview`, and all five existing mode values remain available.

You can also run **Open Native Review Snapshot** for the active changed file, or **Review Text Changes Natively** for a multi-file view. Both sides are read-only, version-bound snapshots. VS Code 1.80 and hosts without Multi Diff use an explicit file picker and single-file Diff; more than 50 text changes also use this bounded fallback. This limit applies to one Multi Diff view, not the monitoring capacity.

Right-click inside the snapshot's current side to **Keep Reviewed File**, **Revert Reviewed File**, or act on one exactly selected whole block. Partial selections, deleted-line blocks, stale snapshots, and ambiguous editor targets are refused. Use file-level review when a block cannot be mapped safely. Block Revert retains the existing unsaved-buffer behavior; save the real file when required, then open a fresh snapshot.

The separate `diffTracker.nativeQuickDiff` setting remains `false` by default; selecting Native Review does not enable it. Enable it explicitly to use the **Code Diff Tracker Review** gutter provider. Its **Open Native Review Snapshot** menu opens a fresh review; it does not directly apply unversioned Quick Diff hunks. Read-only/unknown resources remain in the existing Changes view. See the [S5 checkpoint](docs/s5-native-review-checkpoint.md) for the supported boundaries and verification status.

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

Within the effective monitoring scope, binary files, unsupported text encodings, UTF-8 BOM files and oversized resources are represented as read-only opaque changes when sufficient evidence is available. Unreadable resources and unknown before-images retain their uncertainty and reasons. They are not decoded and written speculatively. Paths outside the workspace and unsafe target identities remain excluded or safely refused. Pure line-ending-style changes are treated as no logical content change.

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
- Verified local Host combinations: Windows Stable 1.140.0, Ubuntu Stable 1.140.0 and Ubuntu 1.80.2. This is a finite Windows/Linux support scope, not verification of every platform, filesystem or future Stable version. The minimum-version Host uses the single-file Native Diff fallback.

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `diffTracker.showDeletedLinesBadge` | `true` | Show a badge indicating deleted lines |
| `diffTracker.showCodeLens` | `true` | Show CodeLens actions (Revert/Keep) above change blocks |
| `diffTracker.highlightAddedLines` | `true` | Highlight added lines with green background |
| `diffTracker.highlightModifiedLines` | `true` | Highlight modified lines with blue background |
| `diffTracker.highlightWordChanges` | `true` | Highlight word-level changes within modified lines |
| `diffTracker.defaultOpenMode` | `webview` | Changed-file opening mode; select `nativeReview` for version-bound text snapshots with WebView fallback for opaque/unknown resources |
| `diffTracker.nativeQuickDiff` | `false` | Separate opt-in Quick Diff provider whose menu opens a fresh Native Review snapshot |
| `diffTracker.monitoringScope` | `rules` | Requested `rules` or `wholeWorkspace` mode; expansion requires local consent and preparation |
| `diffTracker.watchInclude` | `[]` | Structured literal workspace-relative includes, managed with the scope editor |
| `diffTracker.webviewDiffStyle` | `split` | Initial WebView layout: `split` (side by side) or `unified` (one column) |
| `diffTracker.webviewWordWrap` | `false` | Wrap long lines in a new WebView panel |
| `diffTracker.webviewExpandUnchanged` | `false` | Expand all unchanged context lines in a new WebView panel |
| `diffTracker.openWebviewBeside` | `false` | Open WebView diff in a side editor group instead of the current editor group |
| `diffTracker.watchExclude` | `[]` | Structured explicit exclusions without `!` negation; legacy string entries retain compatibility until migration |
| `diffTracker.onlyTrackAutomatedChanges` | `false` | Track external/tagged automation edits while retaining uncertain editor edits for explicit review |

Choose the opening mode in **Settings → Display → Default open mode**, through **Select Default Open Mode**, or in VS Code settings. The values are `webview`, `inline`, `sideBySide`, `original`, `splitOriginalWebview` and `nativeReview`. Display/highlight settings remain in the sidebar Settings panel; monitoring rules are in **Manage Monitoring Scope**.

WebView display defaults are also available under **Settings → Display**: **WebView default layout**, **WebView default: Wrap**, and **WebView default: Expand**. Expand shows unchanged context, including lines outside the changed hunks. These settings initialize a new panel; an existing panel keeps its toolbar choices during updates, hiding/revealing, and file switches. Close the WebView tab and open it again to apply changed defaults. Toolbar clicks do not rewrite your settings. These defaults do not change the native VS Code diff editor.

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

The `0.8.0` source writes **Session V4** and supports migration of valid V1/V2/V3 sessions. V4 preserves effective scope and durable gap evidence; observation coverage is re-established after activation. Restored older sessions remain in scope-compatibility mode until explicit rule migration and scope preparation succeed. Cancelled or failed migration retains the existing review state.

Released `0.7.2` already supports opaque existence and content identity. Upgrade checks must preserve whatever the actual saved format contains; an upgrade must not invent a historical fingerprint from the current file. If an older session lacks current scan provenance or a known before-image, uncertainty remains visible. The installed-VSIX checks proved actual released V3→V4 text/session migration with ordered legacy rules preserved, plus separate candidate-created opaque recovery across process restarts. Released-asset opaque migration remains unproven; process restarts do not prove a physical **Reload Window** click. The [RC checkpoint](docs/bounded-rc-checkpoint.md) records these boundaries separately from source-level compatibility checks.

V4 is incompatible with released `0.7.2`; downgrade recovery must be blocked rather than silently discard scope or review data. Preserve the workspace and extension storage before changing versions. Do not delete recovery markers or saved state merely to bypass a compatibility warning.

## Known Issues

- Pure line-ending-style changes (CRLF/LF only) are treated as no logical content change.
- Unsupported or unsafe files are not eligible for text Keep/Revert actions.
- If you find a reproducible diff/render edge case, open an issue with a minimal file sample.

## Release Notes

Release notes are maintained in [CHANGELOG.md](./CHANGELOG.md). The `0.8.0` entry is prepared for release; publication is a separate step. A final release VSIX must be verified with its checksum, version, source commit and run provenance before upload, tagging or release, as described in [Releasing](docs/releasing.md).

## License

MIT

## Acknowledgements

[![LinuxDO](https://img.shields.io/badge/Community-Linux.do-blue?style=flat-square)](https://linux.do/)

Discuss, free AI, and get help at [linux.do](https://linux.do/).
