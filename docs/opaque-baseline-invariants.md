# Opaque baseline safety invariants

An opaque baseline records the existence and content identity of a file whose
bytes cannot safely participate in text Keep/Revert. It is not an absent file,
a text snapshot, or a promise that an editor buffer matches the disk.

## Acceptance and reconciliation boundaries

`recordScannedBaseline` is the common synchronous publication boundary for full
workspace scans and repository rebuilds. A scan checks its session epoch after
I/O, then passes the result to this method. The method must not replace a
before-image captured while the read was pending, or accept a path carrying
scan uncertainty. It delegates stable unsupported files to `recordOpaqueBaseline`,
which checks dirty documents and historical scan evidence before changing state.

`reconcileOpaqueBaseline` owns the dirty-document check before comparing content
fingerprints. An identical disk replacement cannot prove that unsaved editor
work has disappeared. Caller-specific checks are not a substitute for this rule.

## State transitions

| Before-image | Observation | Required result |
| --- | --- | --- |
| Not yet captured | Editor mutation during scanning | Persist unresolved scan evidence; later save/close cannot make that mutation an accepted baseline. |
| Not yet captured | Stable unsupported bytes and no concurrent mutation | Capture an opaque identity without an unavailable review. |
| Captured text or opaque identity | Another scanner read completes | Preserve the first captured before-image. |
| Captured opaque identity | Change/create event while other files are scanning | Reconcile against the captured identity; do not downgrade it to an unknown path. |
| Captured opaque identity | Dirty editor and identical disk bytes | Keep an unavailable review and preserve the opaque identity. |
| Captured opaque identity | Clean save/reload with identical bytes | Clear the review only after verifying current disk content. |
| Captured opaque identity | Clean save with changed bytes | Keep a read-only unavailable review; never run text Keep/Revert. |
| Unresolved scan evidence | Subsequent binary read or restart | Preserve visible uncertainty rather than apply binary-only suppression. |
| Repository rebuild candidate | Git changes, Stop, or persistence failure after a current edit was observed | Restore the old before-image, preserve the observed edit as a visible conflict, and reconcile against the restored baseline when the session remains active. |
| Stopped recording | Explicit Clear Diffs | Persist an empty stopped session without writing workspace files. |

Opening an unchanged document is not an editor mutation. A file already captured
as opaque counts as a captured before-image in both watcher and editor paths.
Historical scan evidence and the current `isDirty` flag serve different purposes:
saving or closing an editor can clear `isDirty`, but cannot retroactively make an
observed scan-time mutation safe to accept.

## Rebuild rollback

A baseline transaction may discard its candidate baseline; it must not discard
live file/editor observations with that candidate. Repository rollback therefore
preserves candidate review paths before restoring the old maps. These paths keep
a synchronous unavailable review even if Stop cancels the remaining asynchronous
work. An active session also rereads them against the restored before-image.
The operation does not restore, overwrite, save, or otherwise mutate workspace
file bytes or editor buffers.

## Verification

`test/opaque-baseline-invariants.mjs` registers a cross-product matrix in the
existing production tracker regression harness. It covers BOM, binary,
invalid-UTF-8 and actual >5 MiB files; workspace and repository scanning;
concurrent dirty/saved/closed documents; captured-file change/create/open events;
dirty editor reconciliation; clean save/reload; persisted uncertainty and stopped
Clear. Rollback coverage adds Git changes, Stop and injected persistence failures,
both before and after candidate capture, with dirty and saved editor changes.

The VS Code API boundary is mocked, but the production tracker and actual
temporary filesystem are used. Extension Host checks remain separate CI jobs.

Run the focused matrices after compilation:

```sh
DT_TEST_FILTER=OPAQUE-INVARIANT node test/tracker-safety.mjs
DT_TEST_FILTER=OPAQUE-ROLLBACK node test/tracker-safety.mjs
```

Both matrices also run as part of `npm test` on Linux and Windows.

### Recorded red/green results

[Acceptance/reconciliation validation](https://github.com/lengmh/DiffTracker/actions/runs/35209233511)
tested the same 88 new scenarios against the previous production source and the
refactored source:

- Before (`7096536`): 24 passed, 64 failed, including the reported concurrent-dirty
  repository-rebuild P1. These are failing combinations, not 64 independent bugs.
- After (`55abb8d`): all 88 new scenarios passed; the complete tracker suite passed
  551/551. Lint and the remaining `npm test` suites also passed.
- The run preserves `opaque-invariant-red-green` logs as an Actions artifact.

[Rollback fault-injection validation](https://github.com/lengmh/DiffTracker/actions/runs/35210238873)
then tested 48 additional combinations against the refactored source:

- Before the rollback fix (`339b844`): all 48 failed because restoring the old maps
  erased the current edit's review.
- After (`9d0c893`): all 48 passed; the complete tracker suite passed 599/599,
  including all 136 new cases. Lint and the remaining `npm test` suites also passed.
- The run preserves `opaque-rollback-red-green` logs as an Actions artifact.

The PR-level cross-platform and Extension Host checks must still be evaluated on
the final PR head. These results do not claim exhaustive verification of every
filesystem/provider schedule.
