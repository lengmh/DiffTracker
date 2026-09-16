# Round 16: invariant-driven repair of the eight audit findings

Review input: PR #1 at `f957df24619cd246c398f098eb1400166e80f6ba`.
No merge or Marketplace publication is authorized by this repair round.

## Reproductions and changes

Nine new safety assertions (file and block Keep counted separately) failed on the
input code. They now pass and remain in the normal `npm test` entry point. The
original temporary audit harness was unavailable; the cases were reconstructed
using the repository's existing boundary scaffolding and actual production code.

| Finding | Shared repair and adjacent coverage |
| --- | --- |
| A1: writer emits state rejected by reader | Writer preflight uses the recovery parser, covering unresolved count and other schema invariants as well as serialized byte limits. Invalid candidates leave primary/backup intact and retain the incomplete-write marker. |
| A2: parent rebuild absorbs nested repositories | Longest registered repository root owns a path. Cleanup, scan, dirty-document gate, history pruning and Git pauses use that ownership. Changing nested ownership aborts an in-flight rebuild; rollback retains live pauses. |
| A3: Git pause during Keep still accepts | Baseline transactions validate their target at persistence boundaries and before completion. Invalid Keep rolls back in memory and persists the rollback. File/block/batch cases interrupt temp rename, backup copy and marker deletion. |
| A4: restore watcher gap | Watchers register before snapshot reconciliation; notifications are queued and replayed before actions resume, including notifications received during replay. |
| A5: unavailable new path lost on restart | Known creation persists an absent baseline even for unavailable bytes. Unknown paths persist unresolved state. Same-session change-before-create provenance is kept separately; restored/scan-time uncertainty cannot be silently promoted. |
| A6: old failure callback restores old history | Persistence and recovery preparation check their session epoch. Batch finalization matches record identity rather than a reusable ID. File/block/batch stale callbacks are covered. |
| A7: Undo drops recovery after altered save | Undo compares actual saved disk and editor content with the intended recovery target; conflicts retain recovery. Native-Undo recognition also revalidates the target after reading. |
| A8: internal symlink redirects write | Shared target validation rejects symlinks in file and ancestor paths, including links remaining inside the workspace. File/block/batch/Undo cases cover file and directory links. |

## Local verification

- Initial red run: 0/9 audit assertions passed, matching the eight reported findings.
- Expanded audit regressions: 34/34 passed with VS Code boundary mocks.
- `npm test`: 313/313 passed (248 tracker, 20 UI, 17 Git adapter, 9 real temporary
  Git repositories, 6 paths, 8 Webview mapping, 5 similarity cases).
- `npm run lint`: exit 0.
- Performance: 1,100 files, 523.5 ms scan, 3.9 ms update, +16 MiB RSS in this run.
- `git diff --check`: exit 0.
- Local Extension Host attempt: could not launch; VS Code download extraction
  failed because `tar` could not set archive ownership in this runtime. This is
  not a host-test pass.

Three new real Extension Host scenarios cover an internal symlink, an actual
`onWillSaveTextDocument` participant during Undo, and a native watcher event while
a restore read is deliberately held. The third case instruments the read's
completion time; filesystem, watcher delivery and production reconciliation are
real. Initial CI run `35081315256` passed Ubuntu quality and the new symlink
assertion, then the Host setup Revert returned conflict immediately after the
symlink was replaced. The test now uses a separate recovery file, waits for a
stable review before acting, and includes the full action result on failure.
No conflict is retried or treated as success. Windows diagnostics in run
`35082083762` then established that newly created fixtures delivered delayed
create/change notifications during the scan, correctly becoming unresolved
baselines. Audit fixtures now predate VS Code startup, use URI-normalized paths,
and keep native writes for the actual scenarios. The product's scan uncertainty
rule was not relaxed. Final CI results are recorded in PR #1.

## Second-pass review

A separate read-through by the same implementer checked all production changes,
including batch cleanup, transaction rollback persistence, repository membership
changes during a rebuild, and events arriving during restore replay. It found and
closed the reusable batch-ID and replay-window gaps before delivery. A further
red/green case caught Undo executing during restore's initial ignore-rule load;
the restoration guard now owns the entire async operation, including loading and
replay, and clears only its own epoch. No external
reviewer or unavailable `code-review` skill was represented as having run during
that second pass. A subsequent external Codex PR review (comment `4024706739`)
identified one P2 in event coalescing: create followed by change lost creation
provenance. Three ordered-sequence regressions were added; create/change and
delete/recreate/change failed before the repair. Coalescing now retains create
evidence until deletion; a later create establishes a new incarnation.

This is not a proof against arbitrary external filesystem replacement during a
native save, network-provider semantics, multi-window storage races, or forced
process termination. Existing unverified release boundaries remain applicable.
