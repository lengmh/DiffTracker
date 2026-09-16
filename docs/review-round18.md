# Round 18: ignore discovery and cancelled recovery preparation

Input PR HEAD: `0ac9157f7eed707a326ca06ab5e9f5dae3ff5b73`.
Review comments:
- https://github.com/lengmh/DiffTracker/pull/1#discussion_r4024999053
- https://github.com/lengmh/DiffTracker/pull/1#discussion_r4024999058

## Changes

Fresh Start keeps synchronous watcher registration, but defers document capture
until ignore discovery completes. Watcher, document-change and save notifications
in that interval are collected by session and classified afterward. Excluded
paths enter neither snapshots nor unresolved persistence. Included changed paths
have no reliable before-image and remain explicitly unavailable; directory events
also prevent accepting unscanned descendants. Stop/restart clears the collection,
and old callbacks cannot publish into the new session. Reset uses the same capture
ordering. Rule refresh publishes a complete replacement map, keeping the previous
rules active while discovery awaits I/O.

The earlier startup regression assumed an open document's baseline was captured
before ignore discovery. It now checks immediate watcher coverage and retention of
startup change uncertainty: the deferred capture must not accept changed text.

Recovery preparation uses the existing baseline transaction and persistence writer.
Stop, restart and disposal synchronously roll back the candidate history before
capturing their persistence state. This restores an evicted oldest record when
history was at its ten-record bound. Transaction identity and epoch checks prevent
the old writer/finalizer from changing a new session. File, block and batch Revert
all share this preparation path; successful operations retain their recovery record.

## Verification

- Red: the three original file/block/batch Stop probes failed against the input
  production code; all retained a phantom entry and lost the oldest valid record.
- Red: ignored open documents entered the persisted baseline. Follow-up probes
  reproduced exclusion gaps during rule refresh and incorrect acceptance of child
  baselines after startup directory notifications.
- Green: 17 new production tracker regressions pass. Tests use real temporary
  files and production actions, with mocked VS Code boundaries and deterministic
  I/O pauses. They cover default/custom exclusions; included create/change/delete,
  document/save events and reload; ignored churn under a reduced byte limit;
  restart isolation; directory uncertainty; refresh continuity; and Stop/dispose
  at write, rename, backup-copy and incomplete-marker deletion boundaries.
- Cancellation tests inspect both durable copies, reload the session and Undo all
  ten previous operations, checking actual restored contents.
- Full `npm test`: 338/338 (273 tracker and 65 other cases); `npm run lint`: exit 0;
  `git diff --check`: exit 0.
- Added native Extension Host assertions that open files in `node_modules` and
  `out` never enter persisted baseline data. Fixtures predate host startup.
  Exact-commit CI results are recorded in PR #1 after push; host tests were not
  run locally in this round.
- The implementer reread initialization, refresh, lifecycle transitions,
  transaction ownership and all three Revert callers. No separate reviewer
  approval is claimed. A `code-review` skill is not installed in this environment.

This remains an unmerged review build; no Marketplace publication in this round.
