# Review of 08c9c763: persistence and destructive recovery

The three findings were checked against the current production paths, including
adjacent mutations rather than only the commented lines.

| Path | Protection and verification |
| --- | --- |
| New file notification | Block review until the expanded baseline is persisted; count-limit and delayed-write tests |
| Document baseline capture | Same persistence barrier; count-limit/restart test |
| File and block Keep | Await persistence, roll back an unsuccessful decision, retain review; byte-limit tests |
| Changes during Keep persistence | Re-read current state instead of clearing later edits; both action tests |
| Failed/interrupted persistence | Write an unsaved marker before replacing session data; startup blocks stale restoration |
| Blocked restore followed by shutdown | No state deletion or overwrite; marker preservation test |
| Empty Ready / Building baseline | Restore ready / incomplete respectively, including another shutdown/restart |
| Undo that would delete a restored file | Return conflict without dispatching an edit; retain history, recognize later manual deletion |

The deletion behavior is an intentional capability restriction. VS Code's
WorkspaceEdit deletion cannot condition execution on the validated file version.
Another read before applyEdit would leave the reported pending-edit race open.
Users must inspect/delete that file themselves, then retry Undo. The real Host
scenario and both READMEs describe and assert this behavior. Other Undo branches
remain available; this does not claim atomic isolation from external writers.

Local verification: npm test 207/207 (154 production tracker regressions), lint,
and stage2 safety probes 4/4. Tracker tests use a mocked VS Code boundary; CI Host
results are reported separately in the PR. The installed skills contain no
code-review skill, so this patch received a manual path/await/rollback inspection;
independent Codex PR review is still required.

Limits: a completely unwritable storage provider cannot durably store even the
failure marker. In that case the running session reports failure and blocks
actions; no durability across process loss is claimed. Power-loss/fsync guarantees
and multi-window session coordination remain outside the supported scope.
