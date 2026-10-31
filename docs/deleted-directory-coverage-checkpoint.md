# Deleted directory observation lifecycle

Base: main / v0.8.13, `a4a309a130041bab7f3d1b0c1096fe3a0f6ae8b4`.
This task preserves existing baselines, review and Undo; it does not change monitoring preferences.

## Confirmed cause and boundaries

A confirmed directory deletion closes supplemental handles but leaves the old existing-directory requirement. Full Recheck requires that path to exist. Literal watcher exclusions and directory includes can fail even earlier in coverage planning. Imported requirements survive reload under the independent `importedCoverageRequired` descriptor and a restart diagnostic, so matching only the visible missing reason cannot migrate old sessions.

Deletion retires a physical directory identity, not the user's future monitoring scope. The replacement proof is a direct native watch on the nearest existing, validated ancestor in the same workspace, filtered to the missing path's reconstruction chain. No sibling enumeration or inherited recursive Host coverage is assumed. The existing combined direct-watch cap continues to apply. Runtime proof is never persisted as a live OS handle; reload must independently reinstall and verify it.

## State and operation matrix

| Operation/state | Required result / invariant | Initial finding |
| --- | --- | --- |
| Delete existing supplemental/imported root | Reconcile known descendants against original before-images; replace dead owner with verified reconstruction watch; durably retire exact old diagnostic | Confirmed defect |
| Ordinary file deletion / last file, directory remains | Keep directory owner and normal deletion review | Existing path; no retirement needed |
| Repeat delete / full Recheck | Idempotent; no accumulating watches or new baseline | Missing target currently fails |
| Delete nested child under live root | Retire dead descendant identities; nearest same-owner parent guards reconstruction | Coarse identity diagnostic needs reconciliation |
| Delete ancestor chain | Move reconstruction watch upward, within exact owner; observe intermediate recreation without scanning siblings | Must explicitly cover |
| Empty/populated same-path recreation | Watch new identity, bounded reconciliation, known baselines preserved; unproven before-images remain Unknown | Existing import path usable; old missing/restart retirement incomplete |
| Rename/move/move back | Source is deletion, destination is discovery; never transfer baseline across paths/owners | Same lifecycle proof required |
| Atomic replacement / directory to file or symlink | Never certify missing from a delete notification alone; retain precise unavailable/identity evidence | `existsSync` is insufficient absence proof |
| Nested workspace/removed workspace root | No reconstruction watch outside the exact owner or discovery through another workspace | Conservative Limited required when root itself is absent |
| Revert / Undo / Keep / opaque acknowledgement | Preserve original review semantics, history and later monitoring; deletion is not scope exclusion | Existing actions do not authorize retirement of future scope |
| Reload with old missing or wrapped restart record | Reinstall independent owner; reconcile old baselines and certify absence without Reset | Confirmed recovery omission |
| Stop/pause/dispose/new epoch | Release handles; stale callbacks and pending persistence cannot mutate next session | Existing epoch gates must extend to replacement owners |
| Explicit exclude/reinclude / failed Apply | Committed exclusions may release owner; dormant uncertainty and rollback semantics remain distinct from deletion | Existing behavior retained |
| Full/scoped Recheck | Exact authorized targets only; no unrelated diagnostic retirement | Missing owner proof must participate in final transaction |
| Permission/symlink/identity uncertainty | No missing certification; preserve Limited and review | No `existsSync` absence inference |
| Watch install/quota/preparation failure | Retain exact Limited; no unbounded budget increase or leaked provisional owner | Existing failure taxonomy/cap reused |
| Persistence failure / concurrent recreation | Restore removed diagnostics; final identity/event/epoch barrier must fail stale proof | Must test durable boundary |

## Verification record

Implementation and red/green, filesystem, Host and independent-review results are recorded below when completed. This checkpoint does not claim unexecuted Windows or Extension Host acceptance.

## Candidate implementation and evidence

The replacement owner is represented on the existing supplemental watch entry by an optional `observationDirectory`. Its identity binds the nearest existing direct ancestor; the target must remain provably missing, under the same workspace, throughout certification. Named callbacks are filtered to its reconstruction chain. Existing identity sweeps, shared 256-watch budget, installation errors and lifecycle disposal also cover these owners. There is no recursive parent coverage assumption, ancestor/sibling enumeration, new baseline or preference write.

Missing responsibilities retain the existing independent restart descriptor. Old visible missing records and wrapped imported records are requalified and installed on restore. Literal/include planning accepts historical directory obligations; unsupported new absent requests retain their prior rejection. Interior dead owners can be retired by a full bounded Recheck before a delayed self-delete callback arrives. Regional Recheck uses an independently guarded missing target without clearing unrelated gaps.

Retirement serializes its short persistence transactions across independent deletions. Notifications during a transaction invalidate that proof and coalesce into at most one current-state reconciliation per already-retained target after the barrier. This preserves Unknown before-images. Two independent red/green failures exposed during this work were continuous ancestor reconstruction crossing a previous save barrier, and a seven-root deletion batch leaving six roots unretired. Both now have deterministic regression cases; real native Host callbacks also exercise them.

At this checkpoint, 26 focused filesystem-backed regressions pass, including last-file deletion, old-record migration, empty/populated recreation, ancestor chains, rename/move back, nested workspace refusal, file/symlink replacement, permission/quota failures, save-barrier recreation/Stop/failure, Revert/Undo, full/regional Recheck, Stop/Start/reload and shared-cap idempotence. Existing exclusion tests now inject a genuine reconstruction-owner failure before asserting that explicit exclusion can resolve Limited; normal deletion no longer supplies that failure.

Linux real VS Code Stable 1.144.0 and minimum 1.80.2 isolated Host runs pass. They use native filesystem callbacks (no callback injection) for ancestor deletion, intermediate reconstruction, empty recreation, later edits, restart restoration, populated recreation and seven concurrent root deletions. Official runtime archive SHA-256 values were verified. The Host can deliver a preceding deletion to a freshly registered recursive listener during an explicit Recheck. The test preserves that real concurrent evidence and requires Limited plus its root marker in that branch; it does not retry or sleep to force Full. No unrelated event or other failure is accepted by this branch.

`npm run lint`, packaging and package-content inspection pass. The candidate VSIX excludes tests, docs, logs and private probes. A full prior suite passed 1826/1826 tracker cases, 45 Git-adapter cases and 28 real temporary Git scenarios; the expanded final suite and exact PR-head CI remain separately tracked. Performance probes pass with unchanged budgets; the one local 1100-file sample was 560 ms scan, 3 ms update and 24.8 MiB RSS delta. These are descriptive local measurements.

Remaining conservative boundaries: an absent workspace root cannot borrow an outer owner; EACCES, symlink/identity uncertainty and real concurrent Recheck notifications remain Limited. Undo retains its existing refusal to implicitly delete a file restored by Revert, preserving the recovery record until the user resolves that delete. Windows acceptance and final independent review are pending CI/review, not inferred from Linux results.
