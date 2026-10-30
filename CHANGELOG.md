# Changelog

## 0.8.11

- Automatically reconcile directory creation, imports, renames and finite bursts of activity within bounded observation budgets. Continue observing subsequent file changes without requiring another event or manual Recheck.
- Finish necessary coverage verification from file/folder exclusion, Save and Apply, and Restore in one action. Preserve drafts, cancellation, pending reviews and Undo; retain committed exclusions and report partial completion when verification cannot finish.
- Keep excluded historical coverage gaps dormant through later directory activity and restart. Respect directory-only ignore rules before creating observation obligations, while preserving explicit includes and ordinary-file replacements.
- Attribute unfinished coverage to the scope change that introduced it across retries and recovery; list independent failures separately. Reuse healthy observation owners without raising capacity limits, preserve Unknown before-images, and keep stopped sessions stopped.

## 0.8.10

- Confirm quick file/folder exclusions before saving settings; cancellation preserves review state, concurrent changes invalidate consent, and failed Apply compensates only its own still-current request.
- Let Recheck Observation Coverage recover withdrawn pending-exclusion control gaps against original baselines without accepting changes or bypassing real coverage failures.
- Preserve stopped review snapshots when scope settings change, and retain file/editor events that invalidate an in-flight coverage repair.

## 0.8.9

- Add `diffTracker.onlyRecordReviewableText`, disabled by default, to skip new binary, unsupported-encoding and oversized resources using safe content classification. Preserve existing baselines, pending reviews and Undo; previously skipped content requires an explicit trustworthy baseline before text review.
- Add **Stop Recording This File or Folder** to Explorer and pending-review context menus. Stage exact exclusions through the existing scope manager and Apply confirmation without silently accepting pending changes.
- Add `diffTracker.autoOpenNextPendingFile`, disabled by default, to advance after successful single-file review with no pending content remaining. Preserve stable ordering and cancel navigation after an intervening editor or tab switch; batch actions do not navigate.

## 0.8.8

- Make automatic recording in new workspaces and Git branch archive/rebuild prompts opt-in through `diffTracker.autoStartRecording` and `diffTracker.promptOnGitBranchChange`, both disabled by default.
- Keep stopped reviews quiet: stop background Git snapshot sampling and branch prompts, preserve saved stopped sessions, and defer new baselines and recovery confirmations to explicit Start. Saved recording sessions continue to restore normally.
- Preserve pending review when Start is cancelled, avoid duplicate Start and recovery prompts, and reject archive prompts that became stale after Stop or restart.
- Verify repository, branch and file content at review mutation time while stopped. Reconcile a previously paused session at the next explicit action after returning to its baseline branch, retaining in-flight transaction safety checks.

## 0.8.7

- Fix stopped Clear Diffs restoring obsolete imported-directory coverage warnings after reload. Preserve future recording coverage obligations and safely retire missing imported directories when a new baseline is established.
- Freeze already-captured pending reviews when Recording stops, including after reload and ordinary ignore-setting refreshes. Post-Stop file changes are not added to the review; explicit Start establishes a fresh baseline. Keep/Revert/Acknowledge reject newer disk or dirty-editor edits without changing the frozen review.
- Open stopped side-by-side comparisons with read-only snapshots. Previously opened Live File tabs remain live and are labelled accordingly.
- Cancel older pending Start requests when Clear Diffs is confirmed, including asynchronous recovery/rebuild confirmations; cancelling Clear leaves Start requests untouched.
- Persist stopped-review snapshots in Session V5. Older builds cannot read this format. Older stopped sessions without enough saved current-side evidence are preserved in an incomplete, paused state rather than reconstructed from later file contents. Do not remove recovery markers or mix primary and backup files to force a downgrade.

## 0.8.6

- Keep windows without workspace folders idle, including restoration of recording sessions saved by older versions.
- Ignore Git repositories outside the workspace when establishing or updating review baselines, preventing unrelated repository recovery prompts. Preserve Git safety checks for parent and nested workspace repositories.

## 0.8.5

- Revalidate compatible Git returns without reloading or rebuilding review baselines; retain pending reviews and Undo, and keep in-flight writes blocked after an incompatible transition.
- Allow explicitly selected single-file opaque Acknowledge across verified stable named branches while leaving folder/batch opaque actions, Unknown Reset and Revert guards strict.
- Make shared Acknowledge/Unknown baseline updates recoverable after late persistence failure; reject unobserved content changes and tolerate unchanged notifications during publication.
- Execute ordinary single-file Accept/Acknowledge directly, without routine confirmation dialogs or success notifications.
- Use path/existence/size reminders for files larger than 64 MiB without reading or fingerprinting their contents. Acknowledging a reminder only marks that state as seen; preserve prior review and Undo evidence, and intentionally ignore same-size content or timestamp-only changes.

## 0.8.4

- Allow selected text Keep across stable named branches in the same verified repository and worktree, including file, whole-block, folder and batch actions. Keep updates only the selected DiffTracker review baselines; it does not write workspace files, change Git state or clear the recorded Git pause.
- Preserve strict Revert/Undo guards and the existing Acknowledge/Unknown reset policy. Git/content changes during Keep are rejected or rolled back, with interruption recovery for durable baseline updates.
- Document conservative Keep limits: reftable repositories, manually replaced Git/worktree metadata, branches without an initial commit, and restored Git-backed sessions without a working Git monitor.
- Hide obsolete missing-target supplemental watcher warnings only after the owning subtree is explicitly excluded by committed monitoring scope. Preserve saved uncertainty for re-inclusion, pending or failed Apply warnings, and unrelated review evidence.
- Simplify the user READMEs and keep maintainer release procedures separate.

## 0.8.3

- Add the missing right-click alternatives for coverage-subtree exclusion, text Accept/Revert, read-only Acknowledge, and Unknown Reset Baseline. Retain the existing inline icons, row-category restrictions and shared safety-checked handlers.
- Correct menu regression coverage to verify inline and right-click contributions separately; inline actions are not automatically included in the context menu.

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
