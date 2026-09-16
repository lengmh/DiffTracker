# Round 27: final P2 fixes before merge

Base: 7ed11f487a621bf6cd324af309a14a27a1f20d84.

## Changes

- Directory classification now checks baseline existence, not snapshot-map membership. A path with an absent baseline may become a directory; obsolete file reviews are cleared and descendants are scanned. A formerly existing baseline file still reports a type conflict.
- Imported trees are traversed by directory entries, installing a watch before enumerating descendants. Empty and ignored-file-only directories receive watches; ignored directory patterns and symbolic-link boundaries remain respected. File discovery runs after watches are installed.
- Failed file/block Keep transactions preserve the latest review while rolling back the baseline, then refresh current resource state. New disk contents, deletion, dirty buffers, and updates that received no callback remain visible. Git pause and unavailable-resource guards remain active.

## Verification

- 20 initial regressions: 15 failed before the fix; all 20 pass after it.
- Four additional regressions cover a write arriving without a notification; all pass. Total new regressions: 24.
- Full local suite: 500/500 before adding those four tests; final targeted suite: 24/24. Production code unchanged between these runs. Expected full final count: 504.
- Compile, lint, and whitespace validation pass.
- Real Linux fs.watch: both empty and ignored-file-only imported subdirectory tests pass without injected notifications.
- Extension Host acceptance now creates files in initially empty and ignored-file-only imported directories, alongside the existing import / Keep / edit / Revert workflow. Final Windows, Ubuntu Stable, VS Code 1.80 results are recorded in PR checks.

## Merge gate

Final-head CI must pass and independent review must complete. This implementation report is not an independent review approval. No Marketplace publication is part of this change.

## Independent review follow-up: watcher quotas

Independent review of 05797be reported P2 comment 4029158634: native watches were unbounded and partial traversal failure skipped file discovery while retaining watches.

- Bound supplemental imported-directory watches to 256 per tracker.
- On OS quota, bound, or directory traversal failure, dispose only watches installed by that traversal; retain existing coverage.
- Continue discovering current files, and leave a visible unavailable root explaining incomplete ongoing coverage and the need to reduce directories / resolve the watcher limit and rebuild. This fallback does not claim full ongoing coverage.
- Added three regressions (bound, ENOSPC, directory read failure), each with repeated import attempts and a pre-existing watch. All three fail on 05797be and pass after the fix.
- Final local full suite: 507/507. Compile, lint and whitespace checks pass. A new final-head CI and independent review are required before merge.

## Independent review follow-up: reclaim ignored watches and deleted markers

Independent review of 8868b6e reported P2 comments 4029240797 and 4029240807.

- Refreshing ignore rules now disposes imported-directory watches that became ignored. Watch creation also prunes ignored entries before applying the cap and rejects ignored targets, covering Stop/Start and rebuild reuse.
- A failed newly created directory with proven post-baseline absence now persists that absent baseline, allowing its unavailable marker to disappear when the directory is confirmed missing, including after restoring a session. Scan-time or older unknown baselines remain unresolved.
- Added six regressions: settings/gitignore capacity reclamation across restart; failed-directory deletion with and without intermediate restore; preservation of scan-time and older unknown provenance. The four reported failure cases all fail on 8868b6e and pass with this fix.
- Updated the existing directory-scan-failure regression to require the known absent before-image and to verify both Keep and Revert remain blocked while the directory is unavailable.
- Full local suite: 513/513. Compile, lint and whitespace checks pass. Final-head CI and independent review remain the merge gate.

## Independent review follow-up: resume coverage and asynchronous errors

Independent review of d5aa0c0 reported P2 comments 4029340175 and 4029340183.

- Ignoring a directory closes its native resource while retaining dormant discovery/provenance. Unignoring re-traverses the tree, including directories created while ignored. Failed resume restores prior dormant entries for later retry; ignored deletions remove obsolete entries.
- Watch entries retain whether a post-baseline creation was observed. Error events and unnamed events use the same absence-aware failure path as synchronous failures. Inactive/ignored callbacks are discarded; scan-time uncertainty remains unresolved.
- Added eight regressions: settings/gitignore unignore with new subdirectories, asynchronous errors/unnamed events with and without restore, failed-resume retry, and asynchronous scan-time uncertainty. All six reported reproductions fail on d5aa0c0 and pass now.
- Real Linux native fs.watch verifies both unignore scenarios without injected file events.
- Full local suite: 521/521. Compile, lint and whitespace validation pass. Final-head CI and independent review remain the merge gate.

## Independent review follow-up: reconcile the coverage gap

Independent review of 1c08636 reported P1 4029464703 and P2 4029464716.

- Successfully resumed coverage now records a pending file-reconciliation obligation. Ignore refresh performs discovery and re-reads known paths even when the rule fingerprint is unchanged. A failed scan retains that obligation for a later retry.
- After successful reconciliation, proven-absent directory failure markers and their synthetic file snapshots are removed and persisted. Older unknown before-images remain protected. Epoch/version guards prevent stale reconciliation from clearing newer state.
- Two end-to-end regressions cover retry with unchanged rules, modified/deleted/new files during the gap, scan failure followed by retry, and restoration without stale directory markers. Both fail on 1c08636 and pass after the fix.
- Full local suite: 523/523. Compile, lint and whitespace checks pass. Final-head CI and independent review remain required before merge.

## Independent review follow-up: discard stale refresh failures

Independent review of 4d9ca01 reported P2 4029569951.

- Watch-resume and reconciliation failure paths now check both session epoch and ignore-refresh version before applying failure state. The absence-aware helper rechecks after persistence awaits too.
- An outdated failure cannot recreate a marker removed by a newer successful reconciliation or fail the completed newer refresh.
- Two overlapping-refresh regressions (watch traversal failure and file discovery failure) fail on 4d9ca01 and pass after the fix.
- Local full suite: 525/525; final guard refinements also pass the targeted overlap tests. Compile/lint and whitespace checks pass. Final-head CI and independent review remain the merge gate.
