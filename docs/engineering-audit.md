# DiffTracker 0.6.0 stage 0 / stage 1 engineering audit

Date: 2026-09-15. Target: `lengmh/DiffTracker`. This change is a **development review build**, not a final stable release. Only stages 0 and 1 of `DiffTracker_0.6.0_Work_Codex_Execution_Prompt_v2.md` are authorized this round. Stages 2–5 remain deferred; the release-blocking findings below are not waived by passing stage 1 tests.

## Verified starting point

- Actual starting HEAD and review baseline: `5482c154f86e35fe4551f8a27de2cd30c97d0c97`; no difference between the two.
- Actual starting tree: `3821e0ef4c4ef5dd7ed899d2da72928e9864817d`.
- Baseline blobs: `src/diffTracker.ts` = `3973a8153119485007f279e0dce85191e80ebaa0`; `src/extension.ts` = `dc271d68e25c24986b161dcbfa48daa8e9688f90`; `src/webviewDiffPanel.ts` = `cbdc45f7fcda860a14c5f39790d6ee6b158afffb`.
- Baseline package version/publisher: `0.6.0` / `TinyTigerPan`. Source and lockfile were inspected before installation; dependencies were installed with `npm ci`.
- `96e12ad` (pre-0.6.0 main) to the baseline contains two commits and eight changed files. Neither original `test/` file changed. The earlier version commit is `cef7f39` (`v0.5.2`); do not confuse its intervening README badge commit with a functional release.
- Work began on an independent branch; the initial checkout was clean. Concurrent implementation changes after that point belong to this task. No reset, force push, main-branch edit, or automatic merge is part of this delivery.
- No repository AGENTS.md or CLAUDE.md was found. The uploaded execution prompt supplies task-specific requirements.

## Existing functionality retained

The baseline already has `DiffTracker(context.storageUri)`, version-1 `session-state.json`, `restorePersistedState`, a serialized persistence queue and 300 ms debounce, `baselineExistingFiles`, and `CurrentFileState`. These are reused and their boundaries hardened; they are not newly invented capabilities. The baseline also has WorkspaceEdit-based file/hunk restoration, the missing-baseline new-file deletion path, partial Keep adding file existence, automation-only configuration and alias, and explicit `beginAutomationSession`/`endAutomationSession` APIs. Startup already preserves a restored stopped session. Existing Webview and five opening modes remain the review surfaces.

## Issue ledger

Line references in this table refer to the fixed baseline commit, so concurrent edits and later line movement do not invalidate the evidence. Method names identify corresponding implementation locations. “Source risk” is not an Extension Host reproduction.

| ID | Priority / evidence at baseline | Source reference and impact | This round / next dependency |
| --- | --- | --- | --- |
| DT-01 | P1, confirmed source defect | `diffTracker.ts:1358` splits only `/`; Webview/native Diff title fallbacks also short-circuit on Windows paths. A leaf/title can display the complete absolute path. | Stage 1: shared platform-aware display helpers; keep identity as the original path/URI; verify explicit Windows/POSIX, UNC, duplicate leaf and multiroot cases. |
| DT-02 | P0, confirmed source defect | `updateTrackedDiff:1321–1375` checks logical text equality before existence and infers deletion from nonempty-to-empty text. Existing empty file and absent file collapse; Keep may corrupt the existence baseline. `readCurrentFileState:1065` treats broad errors as missing and prefers an open document over disk state. | Stage 1: carry actual existence through the existing Map/Set and state union; exercise clear → Keep → edit → Revert and empty create/delete lifecycles. |
| DT-03 | P0, confirmed source defect | `revertAllChanges:1378` clears every pending entry after its loop. `restoreFileToContent:1454` ignores save=false and broadly falls back to file creation. `readFileSnapshot:1048` merges unsupported/unreadable with absent. | Stage 1: preserve failures, structured results and true success counts; dirty-document protection; distinguish missing/unavailable and partially applied unsaved edits. Production-boundary failure tests are required. |
| DT-04 | P0, production-method reproduction of coordinate/revision defects; mocked VS Code boundary | `keepBlock:1631–1699` inserts pure additions at `block.startLine - 1` in baseline coordinates. `getChangeBlocks:1813–1839` derives ID from ranges/type/segment, not text revision; `resolveBlock:1969` resolves current matching ID/index. Webview `handleMessage` forwards resource/ref without reviewed revision. `requestId` only correlates acknowledgements. `keepAllChangesInFile:1706` also mixes cached content and open-document fallback. | **Deferred stage 2 release blocker**: out-of-order insertion Keep, same-line stale Keep/Revert, file/all reviewed-revision checks and post-await validation. |
| DT-05 | P0 safety verification / P1 behavior, source risk | `onDocumentChanged:1981–2005` returns for automation-only without a session. `suppressWatcherForVsCodeSave:550` schedules a 1500 ms suppression; `onExternalFileChanged:1194–1212` drops a suppressed event. Neither path safely rebases only manual edits or verifies a later external write when the window ends. | **Deferred stage 2 release blocker**: manual A followed by external B at 200 ms and 2000 ms, mixed pending edits, autosave/formatter/Undo. No claim that external means Codex. |
| DT-06 | P1 durability; P0 possible valid-baseline loss, source risk | `flushPersistState:425–457` directly overwrites the final JSON file. `loadPersistedState:460` returns undefined on any read/parse failure; startup then starts a new session (`extension.ts:591–596`). V1 lacks scan-complete/Git context; `restorePersistedState:157–191` marks restored snapshots initialized. `parsePersistedState:476` skips malformed entries. `rebuildTrackedChangesFromSnapshots:1099` visits only saved paths. `dispose:3018` fire-and-forgets flush; `deactivate` is synchronous. | **Deferred stage 3 release blocker where data loss applies**: atomic durable writes/last-good recovery, corrupt state preservation, partial-scan schema validation, shutdown flush, closed-period new files and restored-path trust. Preserve V1 compatibility. |
| DT-07 | P1 context; P0 cross-context write risk, source review | Configuration/activation/tracker paths contain ignore handling for `.git`, but no branch/HEAD/worktree context coordinator. `startRecording`/`resetBaselineToCurrentState` clear review state rather than archive repo-specific context. | **Deferred stage 4 release blocker for cross-context writes**: pause affected repo writes on confirmed context change; stage 3 must first retain context with the baseline. Git restore may change files without HEAD changing. |
| DT-08 | P0 lifecycle verification, source risk | `startRecording:213` starts watchers and scan without awaiting; `initializeWorkspaceSnapshots:978–1045` checks `isRecording` around batches but has no session epoch after reads. An old read can complete during a later active session. Reset can mark Ready in finally. Webview has `onDidDispose` but old panel messages and asynchronous command replies are not revision-scoped. | **Deferred stage 2 release blocker**: delayed scan/read across stop/start/reset; file creation during scan; atomic replace/parent directory deletion; stale panel messages/late ack and multiroot lifecycle. |
| DT-09 | P1, runtime behavior unverified | Existing `WorkspaceEdit` paths (`restoreFileToContent:1454`, `deleteFileForMissingBaseline:1492`, `revertBlock:1562`) may support native Undo/Redo. A warning string is not proof that Undo is absent. | Deferred stage 3: first run real-host Undo/Redo and check review/baseline synchronization. Add bounded last-Revert recovery only if evidence warrants it. |

## Actual baseline commands and evidence level

Platform: Linux `6.18.44`, x86_64; Node `v24.19.0`; npm `11.9.0`. These results were run by the implementation lead before edits.

| Command | Exit | Observed result / limitation |
| --- | --- | --- |
| `npm ci` | 0 | Installed from the existing lockfile; no dependency upgrade was requested. |
| `npm run compile` | 0 | TypeScript and existing Webview build completed. |
| `npm run test:webview-anchors` | 0 | 8 existing cases passed. |
| `npm run test:similarity-pairing` | 0 | 5 existing cases passed. |
| `npm run lint` | 2 | Baseline ESLint configuration absent; not a pass. |
| `code --version` | 127 | A wrapper exists but its actual VS Code target is absent; no usable Extension Host was established. |

The two old standalone scripts duplicate substantial helper algorithms. Their green result is useful historical evidence but does **not** prove actual production tracker/UI behavior. They are retained. Stage 1 regressions must import compiled production methods and mock only VS Code/filesystem boundaries; those tests are not labeled Extension Host integration tests.

Additional stage 0 reproduction ran against source archived directly from the fixed baseline, transpiled with the installed TypeScript and invoked through the same VS Code boundary harness as `test/tracker-safety.mjs` (no copied production algorithm):

- `DT_SOURCE=/tmp/difftracker-stage0-src/diffTracker.ts node test/tracker-safety.mjs`: exit **1**, **7 passed / 17 failed** across the finalized 24-case suite. Failure assertions concern baseline behavior, not merely new return-value shapes. The fixed-SHA source archive was created for this run; it is a temporary test input, not a production dependency.
- DT-04 synthetic production probe: `getChangeBlocks` returned X at line 1 and Y at line 5. Calling the actual `keepBlock` on Y produced baseline `a,b,c,d,Y,e`, although the required baseline is `a,b,c,Y,d,e`. Working content stayed `X,a,b,c,Y,d,e`. This is an **observed production-method defect**, not just an inferred risk.
- DT-04 stale-ID probe: baseline `a,b,c`, reviewed current `a,B,c`, then external current `a,Z,c`. After rescanning, block IDs were equal. Calling actual `keepBlock` with the old ID returned `true` and advanced the baseline to `a,Z,c`. Unreviewed Z was accepted. The diagnostic probe itself exited 0 because it printed the observed defect; that exit does **not** mean the safety requirement passed.
- These probes exercised original production TypeScript against synthetic files and an API stub. They did not exercise a rendered Webview, Windows, or a real Extension Host. DT-04 remains deliberately unfixed in this round.

Final stage 1 commands and delivery details follow below; the table above records the original baseline separately.

## Reproduction matrix and deferred host checks

All examples use synthetic files in an isolated workspace. Do not test destructive Git operations on the implementation repository or the user's research files.

| Scenario | Steps and required observation | Host status |
| --- | --- | --- |
| DT-02 clear/keep/revert | Start with existing nonempty `sample.m`; clear and save; Keep File; add text and save; Revert File. It must finish as an **existing empty file**. Repeat with initial absence, initial empty file, deletion and recreation after Keep. | Windows + VS Code Stable **NOT RUN**; production regression coverage reported separately. |
| DT-03 partial batch | Three pending files; make the second dirty or inject save=false/permission denial; Revert All. Only successful entries disappear; failure stays visible with reason; save failure reports buffer changed but unsaved if applicable. | Windows permission/lock/real save behavior **NOT RUN**. Controlled production-boundary faults are separate tests. |
| DT-04 insertion | Baseline lines `a,b,c,d,e`, current `X,a,b,c,Y,d,e`; Keep only Y. Baseline must become `a,b,c,Y,d,e` and the working file must not change. Repeat reversed/mixed Keep/Revert orders. | Real-host test **NOT RUN**, not fixed in stage 1. |
| DT-04 stale UI | Open a Webview, externally change the same line without changing line count, then click old Keep/Revert. Require rejection/refresh, not acceptance or writeback of unseen text. | **NOT RUN**, remains a release blocker. |
| DT-05 mixed source | Enable automation-only; wait for Ready; manually edit/save section A; externally edit section B after 200 ms and 2000 ms in separate runs. Compare actual baseline, pending content and disk, not just event counts. Repeat with existing AI pending and autosave/formatter. | **NOT RUN**, remains a release blocker. |
| DT-06 restore faults | Use temporary extension storage; corrupt/truncate JSON, deny a write, terminate during scan/queued Keep, restart from stopped recording, create a file while closed. Preserve last valid baseline; do not assert durability for never-flushed data. | Process-crash/reload integration **NOT RUN**. |
| DT-07 Git | In throwaway repos test branch change, detached HEAD, same commit on another branch, worktree, multi-repo, failed checkout, ordinary commit and `restore` without HEAD change. Review writes must not target the previous context blindly. | **NOT RUN**; no Git coordination implemented this round. |
| DT-08 lifecycle | Delay reads while stop/start/reset, create/atomic-replace during scan; close/switch a Webview while an action is awaiting. Watch for old results touching new maps and old replies unlocking new work. | **NOT RUN**, remains a release blocker. |
| DT-09 Undo/Redo | After hunk/file revert, new-file deletion, missing-file recreation and batch revert, use Ctrl+Z then Redo; inspect buffer, disk, existence, baseline and list. | **NOT RUN**; no claim of complete undo support. |
| Display/encoding | Windows drive/UNC/OneDrive with Chinese/spaces, multiple roots/same names; LF/CRLF/BOM/empty/EOF/no final newline; virtual URI round-trip and POSIX literal backslash. | Real Windows/UI/filesystem-provider tests **NOT RUN**; explicit-style helper and production tests are narrower evidence. |
| UI/resource security | Old-message target authorization, out-of-workspace restored paths/symlinks, CSP/text escaping, 20 external file changes without unwanted tabs. | Full-host/security matrix **NOT RUN**; do not claim stage 5 completion. |

## Dependency and release decision

Stage 1 addresses DT-01/02/03 only. Stage 2 must close DT-04/05/08, including stale file/all actions and session-generation safety. Stage 3 must close data-loss portions of DT-06 and verify DT-09 using the existing persistence/WorkspaceEdit paths. Stage 4 then binds review state to verified Git context (DT-07). Stage 5's broad OS/UI/performance release validation remains future work; it is not implicitly completed by adding stage 1 regression scripts.

A development VSIX may be generated through the existing `vsce` build chain with an explicitly forked prerelease identity. It must not masquerade as `TinyTigerPan`'s update or be published automatically. Enable only one DiffTracker extension because command/view/configuration namespaces are shared. A different publisher changes the extension storage namespace: existing upstream storage remains intact but is not automatically migrated. Back up the existing review session and finish/retain its pending work before switching; rollback means disable the development extension and re-enable the original version, whose separate storage was not migrated. No production-stable claim is made while the P0 list above remains open.


## Stage 1 delivery addendum

Implemented source revision: `c8b57c23f21cd7d09c4a60ea776574476f3ea2e2` on
`fix/difftracker-060-review-safety`; path-only commit `7d7f35d` precedes it.
The following documentation/manifest commit does not alter tracker behavior.
The final branch SHA and PR URL are reported in the PR/delivery message (avoiding a
self-referential SHA inside its own commit).

| Issue | Final disposition this round |
| --- | --- |
| DT-01 | Fixed and covered by 6 production path cases with explicit win32/POSIX semantics. Host-native Windows URI/filesystem behavior is NOT RUN. |
| DT-02 | Fixed for tested file existence chains, empty create/delete, accepted new-file/deletion lifecycles, deleted-file hunk Keep, and empty original-content provider. Existing Map/Set and V1 meanings are unchanged. |
| DT-03 | Fixed for tested permission/read/encoding/size errors, dirty skips, applyEdit=false/throw including partial buffer mutation, save=false/throw, mixed batches, and command/Webview result propagation. Only successful file entries are cleared after state verification. |
| DT-04/05 | Not fixed: 4 separate production desired-behavior probes fail on this branch; see below. |
| DT-06/07/08/09 | No new durability, Git coordinator, session epoch or Undo history implementation. Source risks and NOT RUN matrix above still apply. |

### Design limits and preserved behavior

- V1 fields, storage path, debounce and serialized queue remain unchanged. The
  tested flush/load round trip preserves existing-empty versus missing and the
  stopped flag; it is not a full startup/reload/crash durability test or migration.
- Single actions return `ActionResult` (success/failed/conflict/cancelled, reason,
  bufferChanged); batches return per-file results and actual counts. `bufferChanged`
  means the editor changed during the operation; on a failed save it may still be
  unsaved. Hunk Revert retains its buffer-only behavior, while file Revert checks save.
  Dirty editors are conservatively skipped; save/review before another action.
- New-file Revert still uses WorkspaceEdit deletion; confirmed missing baseline
  files are restored with WorkspaceEdit creation. Arbitrary open/save errors do
  not trigger writeFile overwrite. Existence no longer follows string length.
- UTF-8 without BOM is supported; UTF-8 BOM, invalid UTF-8, binary and >5 MiB files
  are explicitly unavailable/read-only in this development build. This avoids
  silently decoding or writing bytes whose preservation has not been verified.
  Pure EOL/final-EOL-only changes retain the upstream logical-line policy.
- Unknown/unreadable baselines retain a reason instead of becoming missing or an
  implicitly accepted snapshot. Known baselines are retained through read errors.
- Writes/reads used by review are restricted to an absolute local workspace file
  and verified real-path boundary; symlink escapes are blocked. Existing V1
  malformed-state parsing and crash recovery still need stage 3. Checks do not
  claim atomic protection against arbitrary concurrent external filesystem changes.
- Webview handles file-level empty creation/deletion and unavailable states without
  fake text hunks. Acknowledgements require explicit success and propagate failure
  reasons; a state refresh follows acknowledgement. This small result-flow fix is
  not the deferred reviewed-version/session-epoch design.

### Final commands (same Linux / Node / npm platform as above)

| Command | Exit | Result |
| --- | --- | --- |
| `npm test` | 0 | Runs production compile/Webview build, 8 original anchors + 5 original similarity + 6 path + 31 tracker + 13 review UI = **63 passed**. The 50 new cases execute production code; the 13 retained original cases have the duplication limitation above. |
| `npm run lint` | 2 | Still blocked by the pre-existing missing ESLint config; **not passed**. No rules/old assertions were disabled. |
| `DT_SOURCE=/tmp/difftracker-baseline.ts node test/tracker-safety.mjs` | 1 | Fixed-baseline final 31-case comparison: **7 passed / 24 failed**. Archive with `git show 5482c154f86e35fe4551f8a27de2cd30c97d0c97:src/diffTracker.ts > /tmp/difftracker-baseline.ts` first. |
| `node test/known-p0.mjs` | 1 | **0/4 desired safety assertions passed** on stage 1. Intentionally separate from the stage-1 regression gate, not hidden or classified as passing. |
| `git diff --check` | 0 | No whitespace errors. |

`test/known-p0.mjs` executes the production tracker through the same boundary harness:
1. Keep Y yields `a,b,c,d,Y,e` instead of `a,b,c,Y,d,e`.
2. An old block ID accepts Z after the previously reviewed B was replaced on the same line.
3. At 200 ms after a manual save, external B reaches disk but no pending entry appears.
4. At 2000 ms, external B appears but earlier manual A reappears against the unchanged baseline.

These are **remaining P0 release blockers**, alongside unverified lifecycle races,
possible baseline-loss recovery faults and cross-Git-context writes. Stage 2–5 are
not implemented. Windows locks/UNC/VS Code Stable Extension Host, actual editor
Undo/Redo, crash/reload, broad Git and performance/UI matrices are **NOT RUN**.
Tests use temporary actual files and fault injection with mocked VS Code APIs;
review UI tests additionally execute generated inline JavaScript against a small
DOM/renderer stub, not a real browser or VS Code renderer.

### Changed files and development package

- `src/utils/displayPath.ts`, `src/diffTreeView.ts`: names, relative tree, unavailable reason.
- `src/diffTracker.ts`: existing state/action paths and failure handling.
- `src/extension.ts`, `src/webviewDiffPanel.ts`: titles, results and file-level UI states.
- `src/originalContentProvider.ts`: preserve the empty baseline string.
- `test/path-display.mjs`, `test/tracker-safety.mjs`, `test/review-ui.mjs`,
  `test/known-p0.mjs`: production regressions and separate unresolved safety probes.
- `package.json`, `package-lock.json`: test entry points and fork development identity;
  dependency versions/integrities unchanged.
- `README.md`, `README_CN.md`, this report: fork attribution, limitations and rollback.

Development identity: `lengmh.diff-tracker`, version `0.6.1`, display name
`Diff Tracker (Development)`, VSIX pre-release metadata. This is not an upstream
TinyTigerPan release and is not published to the Marketplace. Package using the
existing build chain:

```sh
npm run package -- --pre-release --out /workspace/scratch/e83d5d44bd35/diff-tracker-0.6.1-development.vsix
```

Install/rollback: disable `TinyTigerPan.diff-tracker`, install the development VSIX
with **Extensions → … → Install from VSIX**, reload, and test in a disposable workspace.
The two IDs have separate storage but shared commands/views/settings; enable only
one. No upstream-session migration is performed. To roll back, disable/remove
`lengmh.diff-tracker`, re-enable upstream and reload; edits/review decisions are not
undone or transferred by this switch. Preserve upstream storage and pending work.

Package command completed with exit **0**. VSIX manifest confirms fork publisher/version and pre-release property; packaged tracker JavaScript matches the compiled production file. Package size: **6951784 bytes**; SHA-256: `80ba3d317c015acf4bd357b4162b203c1504eeffd4915d3581a4baa982fb2900`. The package was built before this packaging-result paragraph was appended; production source and manifest are identical. No runtime installation was performed.
