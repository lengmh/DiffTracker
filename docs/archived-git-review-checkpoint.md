# Restore Archived Git Review

Implements [issue #27](https://github.com/lengmh/DiffTracker/issues/27). The command restores DiffTracker review state, with current files reconciled against saved before-images. It does not execute Git checkout/reset/revert or change workspace file contents.

## Supported boundary

- Command Palette: `Code Diff Tracker: Restore Archived Git Review` (`diffTracker.restoreArchivedGitReview`).
- One supported local-file workspace root, within one repository. Full workspace-root identities and effective monitoring scope must match. Multi-root and multiple-repository sessions are refused rather than partially replaced.
- Existing or archived observation-coverage gaps and imported-directory coverage obligations must be resolved first; this version refuses them rather than dropping their evidence.
- The archived repository/worktree kind and branch or detached HEAD must be compatible with the current Git context. Unavailable or initializing Git, unstable merge/rebase state, dirty editors, pending scope/recovery work and incomplete baselines are refused.
- Returning from the rebuilt feature branch to the archived branch can leave the existing sticky Git pause. The archive's compatible context is the deciding evidence; that pause alone is not a reason to make the restore unreachable.
- Preview shows the saved repository/branch/HEAD, workspace root, text/opaque/unknown baseline counts, recovery-record count and recording state. Historical archives do not contain a reliable saved timestamp or persisted pending-diff count. Pending changes are reconstructed against the current filesystem.
- Active and stopped archives are supported. Both receive one bounded reconciliation of current modifications, deletions and later additions. The archive's recording state is preserved: active archives resume tracking; stopped archives stay stopped throughout restoration and after reload, without emitting a recording-start event. Temporary watchers cover reconciliation and publication, then are released for stopped sessions. A stopped current session does not prevent restoring an active archive.
- Archive discovery directly enumerates the current filesystem for every supported monitoring scope, using the existing 10,000-entry preparation budget and persistence-capacity checks. Host search indexing or exclusions cannot silently omit an in-scope addition. An over-budget scan cannot be accepted as a complete review. Unsafe discovery or concurrent activity rolls back, or blocks with recovery evidence preserved if rollback cannot be completed safely.
- Final confirmation replaces the entire current DiffTracker review session. Current file bytes and Git history remain unchanged. Cancelling preview/confirmation does not create a backup or replace the live session.
- This is a single-latest-archive feature, not a branch history manager. A subsequent Archive and Rebuild overwrites the prior archive.

Start Recording establishes a fresh baseline from current files. It does not resume a stopped archive's historical baseline and is not a recovery step for that archive.

## Storage and interruption handling

Every path is derived from the extension's `context.storageUri`. Ordinary local VS Code uses its local extension-host workspace storage. Remote-WSL uses the WSL-side extension-host workspace storage, not a JSON file under the Windows project or Windows UI host.

| File | Purpose |
| --- | --- |
| `session-state.archive.json` | Latest whole session from Archive and Rebuild; never overwritten by Restore |
| `session-state.pre-restore.json` | Separately validated full current-session safety backup |
| `session-state.restore-in-progress.json` | Restore intent containing version 1 and a SHA-256 digest binding the safety backup |
| `session-state.json` / `session-state.last-good.json` | Existing durable live-session pair |
| `session-state.unsaved` | Existing incomplete-write protection, retained through final archive-observation replay |

The safety backup must be durable and verified before restore intent is published. Candidate restoration uses the validated Session V4 parser and production reconciliation, not a raw overwrite of live JSON. A preview token binds the archive, live session and relevant context; changed evidence requires a new preview.

Removing restore intent commits selection of the archived session. A reload before that point uses the digest-checked pre-restore session, reconciles it with current filesystem observations, persists the recovered state and then removes the intent. The existing `session-state.unsaved` marker remains durable through commit and final event replay; it is cleared only after queued observations are reconciled and saved. This prevents a later storage failure from depending on creation of a new failure marker.

For a stopped archive, temporary observation ends synchronously once the queued review evidence is durable, before final failure-marker clearance. Edits after that cutoff are ordinary stopped-session edits and are not tracked. A failure after archived-session selection pauses review and retains the durable failure marker; reload remains blocked rather than silently dropping late additions or rolling back behind the committed archive.

A present but invalid intent, a missing/corrupt backup, a digest mismatch, unsafe reconciliation or an unrepairable write failure blocks recovery and preserves the remaining evidence. Do not manually delete the markers to force a fresh session. The existing confirmed discard/rebuild flow clears the active restore intent; the separate archive and safety backup remain inert and cannot replace the newly built session on the next reload.

A successful restore, a refusal, a completed rollback and a blocked failure are reported separately. Unknown before-images remain unknown and opaque identities remain read-only. Subsequent edits continue to be tracked only when the restored archive was recording; a stopped archive receives the explicit one-off reconciliation and remains stopped.

## Focused regression coverage

`test/archived-git-review.mjs` runs inside the existing production tracker harness (`test/tracker-safety.mjs`). Only the VS Code boundary is mocked. Coverage includes:

- Feature-branch refusal, returned-main restore and a sticky pause.
- Read-only metadata preview, missing/corrupt/future archives and root/scope/Git/editor/recovery constraints.
- Complete distinct backup, unchanged source archive, unchanged workspace file metadata/bytes and Git metadata.
- Current-file reconciliation, unknown before-images, continued watcher tracking and ordinary reload.
- Stopped archives with modified, deleted and later-added files under Legacy and configured Rules; additions with missing scan provenance remain pending and unknown. Recording stays stopped, no recording-start event is emitted, temporary watchers are released, and the reconciled review survives reload.
- Temporary watcher failure and activity during stopped-archive reconciliation preserve the current review and source archive. Bounded direct discovery refuses an incomplete scan; an unsafe rollback retains the full backup and intent for restart recovery.
- Stopped restores retain create, modify and delete events arriving while final intent deletion is held. Saved editor changes and workspace-created files are observed even without a filesystem callback, and configured Rules discovers real additions omitted by host search indexing.
- Populated directories created at the stopped-session commit boundary preserve child absence evidence under Legacy and configured Rules. Postcommit replay-budget exhaustion, persistence failure and failure-marker write failure remain blocked across reload, preserving archive, backup and workspace evidence.
- An archive switched to stopped after preview invalidates its token without creating backup or intent. A stopped current session can restore an active archive and discover later-added files.
- Stale tokens after archive replacement, live edits, Git changes, dirty editors and epoch changes.
- Backup write failure, failure after primary publication, and restart at multiple interrupted-publication points.
- Corrupt/missing safety evidence refusing restart without overwriting preserved data.
- Start and duplicate restore/discard requests cannot replace an in-flight session during intent publication. A newer review invalidates that pending cutover.
- Stop during reconciliation rolls back before stopping; Stop/dispose at the final intent-deletion boundary preserve a committed restore. Startup Stop/dispose during backup reads cannot install stale snapshots or watchers.
- Populated directories created at the final commit boundary retain child creation provenance; configured Rules also retain durable imported-directory observation obligations.
- Explicit recovery discard retires invalid restore intent before a new baseline is established, preventing old-backup resurrection.
- Concurrent disk activity preserving a pending change rather than accepting a new baseline.

Run the focused suite after compilation:

```sh
npm run compile
DT_TEST_FILTER=ARCHIVE-RESTORE node test/tracker-safety.mjs
```

## Local verification

On 2026-10-10, the final corrected working tree passed:

- `npm run compile`, `npm run lint` and `git diff --check`.
- Full `npm test`: 1,144 tracker regressions (including all 72 `ARCHIVE-RESTORE` cases), 71 Review UI cases, 32 Git-context adapter cases plus the readiness race, 9 real temporary Git-repository scenarios, 10 host-fixture setup cases, and the existing mapping/similarity/path/scope suites.
- `npm run test:performance`: 1,100-file baseline scan 316.5 ms, update 1.8 ms and RSS delta 24.6 MiB in this Linux/Node 24 run; the mixed text/opaque/native-watcher probe also passed. These measurements are descriptive, not cross-platform performance guarantees.
- `npm run test:stage2-probes`: 4/4 conservative safety probes.
- Installed-harness/final-artifact guard tests: 33/33.
- `npm audit --omit=dev --audit-level=high`: zero vulnerabilities.
- Local VSIX packaging via `npm run package`: passed. This is an unpublished test artifact, not a release.

The initial local independent review found no remaining P0/P1 findings after the lifecycle, interruption, discard/rebuild and directory-event regressions were fixed. A subsequent formal Codex review of `202ba070` identified that stopped archives skipped later-file discovery. The correction separates one-off restore observation from the saved recording state, preserving stopped sessions while reconciling additions. The stopped-archive additions regressions failed against the pre-fix production source and passed after the correction.

A subsequent Codex review of `60ffe95e` identified that failed restoration dropped same-session change-first creation provenance. The rollback snapshot now copies that transient set; two regressions prove rollback retains it and successful replacement does not inherit it. The failing rollback case was reproduced against the reviewed commit before the one-line production fix.

The corrected working tree passed `npm run compile`, all 72 `ARCHIVE-RESTORE` cases (including 19 recording-state regressions), and `git diff --check`. The added regressions cover the stopped-session discovery omission, late commit-boundary activity, editor/workspace events without filesystem callbacks, direct filesystem enumeration and durable blocking after postcommit failures. These are production-tracker tests with a mocked VS Code boundary, not a new host-verification result. The aggregate, lint, performance, safety probes and packaging checks above were rerun after this correction. A second independent review found no remaining confirmed P0/P1 findings and independently verified the double-write-failure regression.

The production tracker/UI suites mock the VS Code boundary. A real Stable host launch was not reached: the installed Xorg dummy server could not establish its local display sockets in this environment. No Windows/Remote-WSL computer was available. The original PR commit `202ba070` subsequently passed Windows Stable, VS Code 1.80, installed RC and both Quality jobs in CI; Ubuntu Stable failed in the pre-existing Quick Diff provider dropdown helper before tracker actions. Those results do not verify this corrected commit or a real Remote-WSL setup. No new VS Code 1.80/S4-D diagnosis was performed.

## Host verification

The boundary harness verifies extension-host storage routing and failure handling, but is not a real Remote-WSL host test. No new platform matrix is introduced. Use the existing supported host infrastructure and record actual host results separately; a mocked API pass is not evidence that the command was exercised in Windows/WSL.

For an ordinary local host and an existing Remote-WSL test setup:

1. Start recording on `main`, create a pending change, then move to a feature branch and run Archive and Rebuild.
2. Run Restore while still on the feature branch. Verify refusal and preservation of both sessions.
3. Return to the compatible original branch with no dirty editors. Run Restore, inspect the preview and cancel once. Verify no state replacement.
4. Run it again and confirm. Verify the archived before-image and current on-disk content appear as the review; file bytes and Git HEAD are unchanged by the command.
5. Edit a file, verify the new edit remains pending, then reload the extension host and verify the restored review is durable.
6. Check that archive and pre-restore backup are separate files in that host's workspace storage. For WSL, confirm the active extension host and storage are WSL-side.
7. Repeat with recording stopped before Archive and Rebuild, then modify, delete and add files before restoring. Verify all supported changes are reviewed, uncertain before-images remain unknown, recording stays stopped, and the review survives reload without live watchers. Separately verify that restoring an active archive from a stopped current session resumes the archive's recording state.

The deferred VS Code 1.80 S4-D intermittent issue is outside this change.
