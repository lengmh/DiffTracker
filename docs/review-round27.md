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
