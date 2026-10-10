# Restore Archived Git Review

Implements [issue #27](https://github.com/lengmh/DiffTracker/issues/27). The command restores DiffTracker review state, with current files reconciled against saved before-images. It does not execute Git checkout/reset/revert or change workspace file contents.

## Supported boundary

- Command Palette: `Code Diff Tracker: Restore Archived Git Review` (`diffTracker.restoreArchivedGitReview`).
- One supported local-file workspace root, within one repository. Full workspace-root identities and effective monitoring scope must match. Multi-root and multiple-repository sessions are refused rather than partially replaced.
- Existing or archived observation-coverage gaps and imported-directory coverage obligations must be resolved first; this version refuses them rather than dropping their evidence.
- The archived repository/worktree kind and branch or detached HEAD must be compatible with the current Git context. Unavailable or initializing Git, unstable merge/rebase state, dirty editors, pending scope/recovery work and incomplete baselines are refused.
- Returning from the rebuilt feature branch to the archived branch can leave the existing sticky Git pause. The archive's compatible context is the deciding evidence; that pause alone is not a reason to make the restore unreachable.
- Preview shows the saved repository/branch/HEAD, workspace root, text/opaque/unknown baseline counts, recovery-record count and recording state. Historical archives do not contain a reliable saved timestamp or persisted pending-diff count. Pending changes are reconstructed against the current filesystem.
- Final confirmation replaces the entire current DiffTracker review session. Current file bytes and Git history remain unchanged. Cancelling preview/confirmation does not create a backup or replace the live session.
- This is a single-latest-archive feature, not a branch history manager. A subsequent Archive and Rebuild overwrites the prior archive.

## Storage and interruption handling

Every path is derived from the extension's `context.storageUri`. Ordinary local VS Code uses its local extension-host workspace storage. Remote-WSL uses the WSL-side extension-host workspace storage, not a JSON file under the Windows project or Windows UI host.

| File | Purpose |
| --- | --- |
| `session-state.archive.json` | Latest whole session from Archive and Rebuild; never overwritten by Restore |
| `session-state.pre-restore.json` | Separately validated full current-session safety backup |
| `session-state.restore-in-progress.json` | Restore intent containing version 1 and a SHA-256 digest binding the safety backup |
| `session-state.json` / `session-state.last-good.json` | Existing durable live-session pair |
| `session-state.unsaved` | Existing incomplete-write protection |

The safety backup must be durable and verified before restore intent is published. Candidate restoration uses the validated Session V4 parser and production reconciliation, not a raw overwrite of live JSON. A preview token binds the archive, live session and relevant context; changed evidence requires a new preview.

The final removal of restore intent commits the operation. A reload before that point uses the digest-checked pre-restore session, reconciles it with current filesystem observations, persists the recovered state and then removes the intent. A present but invalid intent, a missing/corrupt backup, a digest mismatch, unsafe reconciliation or an unrepairable write failure blocks recovery and preserves the remaining archive, backup and intent. Do not manually delete the markers to force a fresh session. The existing confirmed discard/rebuild flow clears the active restore intent; the separate archive and safety backup remain inert and cannot replace the newly built session on the next reload.

A successful restore, a refusal, a completed rollback and a blocked failure are reported separately. Unknown before-images remain unknown, opaque identities remain read-only, and subsequent edits continue to be tracked.

## Focused regression coverage

`test/archived-git-review.mjs` runs inside the existing production tracker harness (`test/tracker-safety.mjs`). Only the VS Code boundary is mocked. Coverage includes:

- Feature-branch refusal, returned-main restore and a sticky pause.
- Read-only metadata preview, missing/corrupt/future archives and root/scope/Git/editor/recovery constraints.
- Complete distinct backup, unchanged source archive, unchanged workspace file metadata/bytes and Git metadata.
- Current-file reconciliation, unknown before-images, continued watcher tracking and ordinary reload.
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

On 2026-10-10, the final working tree passed:

- `npm run compile`, `npm run lint` and `git diff --check`.
- Full `npm test`: 1,123 tracker regressions (including all 51 `ARCHIVE-RESTORE` cases), 71 Review UI cases, 32 Git-context adapter cases plus the readiness race, 9 real temporary Git-repository scenarios, 10 host-fixture setup cases, and the existing mapping/similarity/path/scope suites.
- `npm run test:performance`: 1,100-file baseline scan 311 ms, update 1.9 ms and RSS delta 27.7 MiB in this Linux/Node 24 run; the mixed text/opaque/native-watcher probe also passed. These measurements are descriptive, not cross-platform performance guarantees.
- `npm run test:stage2-probes`: 4/4 conservative safety probes.
- Installed-harness/final-artifact guard tests: 33/33.
- `npm audit --omit=dev --audit-level=high`: zero vulnerabilities.
- Local VSIX packaging via `npm run package`: passed. This is an unpublished test artifact, not a release.

Independent source review found no remaining P0/P1 findings after the lifecycle, interruption, discard/rebuild and directory-event regressions were fixed. This is local independent review, not a GitHub automatic-review result for a published commit.

The production tracker/UI suites mock the VS Code boundary. A real Stable host launch was not reached: the installed Xorg dummy server could not establish its local display sockets in this environment. No Windows/Remote-WSL computer was available. Those host checks remain unverified; no VS Code 1.80/S4-D investigation was performed.

## Host verification

The boundary harness verifies extension-host storage routing and failure handling, but is not a real Remote-WSL host test. No new platform matrix is introduced. Use the existing supported host infrastructure and record actual host results separately; a mocked API pass is not evidence that the command was exercised in Windows/WSL.

For an ordinary local host and an existing Remote-WSL test setup:

1. Start recording on `main`, create a pending change, then move to a feature branch and run Archive and Rebuild.
2. Run Restore while still on the feature branch. Verify refusal and preservation of both sessions.
3. Return to the compatible original branch with no dirty editors. Run Restore, inspect the preview and cancel once. Verify no state replacement.
4. Run it again and confirm. Verify the archived before-image and current on-disk content appear as the review; file bytes and Git HEAD are unchanged by the command.
5. Edit a file, verify the new edit remains pending, then reload the extension host and verify the restored review is durable.
6. Check that archive and pre-restore backup are separate files in that host's workspace storage. For WSL, confirm the active extension host and storage are WSL-side.

The deferred VS Code 1.80 S4-D intermittent issue is outside this change.
