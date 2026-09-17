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

## Persisted schema and compatibility

0.7.2 writes schema **V3**, including both the primary and last-good session files.
V1 and V2 sessions migrate to the current representation; V2 scan provenance and
file-existence semantics are retained. The parser also preserves opaque entries
from development V2 sessions. Only genuine V1 input grants legacy Git-context
adoption. V3 requires its opaque identity array instead of silently treating a
missing array as an empty baseline.

The released 0.7.1 reader rejects V3 rather than ignoring unsupported-file
identities and reinterpreting their paths as absent. A partially published upgrade
with a V3 primary and V2 backup remains protected by the existing durable
incomplete-write marker. Downgrading with saved V3 state therefore blocks session
recovery; it does not automatically convert or discard the review. Preserve the
review before deliberately resetting or discarding incompatible state.

Opaque `mtime` metadata accepts any finite numeric timestamp, including valid
pre-1970 values. Non-numeric and infinite timestamps remain invalid. Equality
uses size and SHA-256 identity, not timestamp equality.

## Verification

`test/opaque-baseline-invariants.mjs` registers a cross-product matrix in the
existing production tracker regression harness. It covers BOM, binary,
invalid-UTF-8 and actual >5 MiB files; workspace and repository scanning;
concurrent dirty/saved/closed documents; captured-file change/create/open events;
dirty editor reconciliation; clean save/reload; persisted uncertainty and stopped
Clear. Rollback coverage adds Git changes, Stop and injected persistence failures,
both before and after candidate capture, with dirty and saved editor changes.

`test/state-schema-compatibility.mjs` adds migration, primary/backup publication,
interrupted upgrade and timestamp cases. Its separately selected downgrade subset
runs against the actual released 0.7.1 source using `DT_SOURCE`.

The VS Code API boundary is mocked, but the production tracker and actual
temporary filesystem are used. Extension Host checks remain separate CI jobs.

Run the focused matrices after compilation:

```sh
DT_TEST_FILTER=OPAQUE-INVARIANT node test/tracker-safety.mjs
DT_TEST_FILTER=OPAQUE-ROLLBACK node test/tracker-safety.mjs
DT_TEST_FILTER=SCHEMA- node test/tracker-safety.mjs
```

All current-source matrices also run as part of `npm test` on Linux and Windows.

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

[Schema compatibility validation](https://github.com/lengmh/DiffTracker/actions/runs/35211008840)
adds 17 current-source cases. It also ran four downgrade cases against the
released v0.7.1 production source: primary-only, primary+backup, backup-only, and
interrupted V3/V2 publication. All four confirmed blocked recovery and unchanged
session/workspace bytes across Start, flush and disposal. The run passed lint and
the complete `npm test` suite, and retains `state-schema-v3-compatibility` logs.

[Timestamp validation](https://github.com/lengmh/DiffTracker/actions/runs/35211184594)
adds nine cases for valid pre-epoch timestamps, invalid metadata, and
pre-1970 timestamps through workspace/repository scanning and restore. The fixture
uses actual filesystem timestamps when the host exposes them; otherwise it
supplies negative mtime metadata at the existing mocked VS Code provider boundary.
Both paths exercise the production reader, scanner, persistence and restore with
real file bytes; neither path skips or weakens the negative-timestamp assertions. The old parser
failed the negative-timestamp regressions; the fixed source passed lint and the
complete `npm test` suite. Logs are retained in `opaque-mtime-red-green`.

The 162 new current-source cases comprise 88 acceptance/reconciliation cases,
48 rollback cases and 26 schema/timestamp cases. Four legacy-source downgrade
cases run separately. The PR-level cross-platform and Extension Host checks must
still be evaluated on the final PR head. These results do not claim exhaustive
verification of every filesystem/provider schedule.
