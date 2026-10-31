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

Implementation, red/green filesystem tests and native Host evidence are recorded below. Independent final review is tracked separately from test acceptance.

## Candidate implementation and evidence

The replacement owner is represented on the existing supplemental watch entry by an optional `observationDirectory`. Its identity binds the nearest existing direct ancestor; the target must remain provably missing, under the same workspace, throughout certification. Named callbacks are filtered to its reconstruction chain. Existing identity sweeps, shared 256-watch budget, installation errors and lifecycle disposal also cover these owners. There is no recursive parent coverage assumption, ancestor/sibling enumeration, new baseline or preference write.

Missing responsibilities retain the existing independent restart descriptor. Old visible missing records and wrapped imported records are requalified and installed on restore. Literal/include planning accepts historical directory obligations; unsupported new absent requests retain their prior rejection. Interior dead owners can be retired by a full bounded Recheck before a delayed self-delete callback arrives. Regional Recheck uses an independently guarded missing target without clearing unrelated gaps.

Retirement serializes its short persistence transactions across independent deletions. Notifications during a transaction invalidate that proof and coalesce into at most one current-state reconciliation per already-retained target after the barrier. This preserves Unknown before-images. Two independent red/green failures exposed during this work were continuous ancestor reconstruction crossing a previous save barrier, and a seven-root deletion batch leaving six roots unretired. Both now have deterministic regression cases; real native Host callbacks also exercise them.

At this checkpoint, 41 focused filesystem-backed regressions pass, including last-file deletion, old-record migration, empty/populated recreation, ancestor chains, rename/move back, nested workspace refusal, file/symlink replacement, permission/quota failures, save-barrier recreation/Stop/failure, Revert/Undo, full/regional Recheck, Stop/Start/reload, shared-cap idempotence, ancestor-event replay and physical-root spelling/identity checks. Existing exclusion tests now inject a genuine reconstruction-owner failure before asserting that explicit exclusion can resolve Limited; normal deletion no longer supplies that failure.

Linux real VS Code Stable 1.144.0 and minimum 1.80.2 isolated Host runs pass. They use native filesystem callbacks (no callback injection) for ancestor deletion, intermediate reconstruction, empty recreation, later edits, restart restoration, populated recreation and seven concurrent root deletions. Official runtime archive SHA-256 values were verified. The Host can deliver a preceding deletion to a freshly registered recursive listener during an explicit Recheck. The test preserves that real concurrent evidence and requires Limited plus its root marker in that branch; it does not retry or sleep to force Full. No unrelated event or other failure is accepted by this branch.

`npm run lint`, packaging and package-content inspection pass. The candidate VSIX excludes tests, docs, logs and private probes. A full prior suite passed 1826/1826 tracker cases, 45 Git-adapter cases and 28 real temporary Git scenarios; the expanded final suite and exact PR-head CI remain separately tracked. Performance probes pass with unchanged budgets; the one local 1100-file sample was 560 ms scan, 3 ms update and 24.8 MiB RSS delta. These are descriptive local measurements.

Remaining conservative boundaries: an absent workspace root cannot borrow an outer owner; EACCES, symlink/identity uncertainty and real concurrent Recheck notifications remain Limited. Undo retains its existing refusal to implicitly delete a file restored by Revert, preserving the recovery record until the user resolves that delete. Final independent review remains a separate gate.

## Automated review follow-up

PR #62 automated review reproduced a P1 in the initial coalescing implementation: an ancestor-only delete received during a narrower target's save barrier was consumed but replayed only at the target, missing a known sibling deletion. The new filesystem-backed test failed before the fix. Each bounded coalesced record now retains the widest observed ancestor plus delete semantics, and replay also preserves exact authorized-target discovery when an ancestor may be ignored or independently owned. Known sibling deletion reviews are reconciled against their original baseline. The focused lifecycle suite is now 27/27.

The first Windows full Host run stopped at the new scenario's synchronous recursive directory removal with ENOTEMPTY, before any lifecycle assertion. Its existing isolated settings comparison passed. The fixture now performs one asynchronous removal, allowing Windows native self-delete callbacks to close descendant handles during removal, consistent with existing Host fixtures. No retry, sleep or production barrier was added to hide that failure.

The next Windows run exposed physical workspace root spelling differences in native realpath validation. Root equality now also requires matching directory device/inode identity when physical spelling differs; a different physical identity still fails containment. Two focused regressions prove acceptance and refusal. A subsequent fixture failure exposed Windows drive normalization at the real VS Code URI boundary; the fixture now seeds keys through that same boundary used by production callbacks.

All eight checks passed on directory/source checkpoint `b74af36` in [CI 41213049491](https://github.com/lengmh/DiffTracker/actions/runs/41213049491): Ubuntu and Windows quality, native Stable Host on both platforms, Ubuntu 1.80 Host, installed VSIX, released 0.7.2 downgrade refusal and VSIX packaging. Later diagnostic changes require their own exact-head acceptance.

A second automated P1 on `9a8f465` found that restore-time directory certification awaited persistence after the final restore-event drain. Unrelated sibling notifications queued during that await were then discarded by restoration cleanup; recovery retry could persist that incomplete paused projection. Four deterministic filesystem regressions (normal restore/retry × sibling change/delete) failed before the fix and pass after it. Certification now runs before the final drain, whose existing loop also processes notifications arising during nested reconciliation. A real Stable Host test edits a sibling at the certification save boundary and waits for its actual Host callback, without injecting the notification; the edit is present before restore returns. The directory suite is 33/33. This repair requires new exact-head CI and review; prior green CI did not prove absence of this race.

The same audit found the interrupted Keep/archive recovery cleanup counterpart; see the lifecycle checkpoint for its six additional regressions and shared final-drain fix. A Linux Host run demonstrated a second delivery of the deliberate sibling edit during Recheck. The fixture preserves production Limited for that exact known change or target deletion and asserts the original/pending sibling review; it does not sleep, retry or relax the production event barrier.

## Independent ultra follow-up: reconstruction during restore certification

The ce8de6b review reproduced another event-consumption gap: certification replay called the ordinary directory-change observer while restoration still owned its guard. The observer refused the work, but the consumed notification was not retained. Normal restore returned a stale deletion; Retry then froze that deletion in its paused projection, with no live supplemental owner.

Both filesystem cases failed before the correction. Reconstructed directory signals now remain in the restore queue with explicit reconciliation provenance. The restore drain alone supplies an epoch/scope/owner-bound observation token to the existing watch/scan/persist handoff. The ordinary runtime restoring guard is unchanged. The handoff reconciles original known children, treats newly discovered child before-images as Unknown, and establishes a fresh direct owner before success or Retry pause. All restore directory work shares one existing traversal allowance, at most two attempts per target and the shared direct-owner cap. A failed budget/quota proof blocks restoration rather than returning a successful stale review; releasing the resource constraint permits a safe retry on the original baseline. Stop cannot publish an old epoch.

Six added regressions pass: normal/Retry reconstruction, quota failure then recovery, traversal-budget failure then recovery, Stop, and a new epoch arriving during directory metadata classification. An independent real Host phase seeds a legitimate files.watcherExclude blind subtree and waits for the native parent's actual reconstruction notification at certification. Both normal restore and Retry pass on VS Code 1.80.2; normal restore verifies a fresh owner observes later native edits, and Retry verifies its saved paused content. Newly discovered children remain Unknown. This phase uses fresh settings/storage/profile and no callback injection.

The first Windows run of the new Host phase passed reconstructed known-content assertions but failed its unconditional expectation that an entirely new child must remain Unknown. That run did not record individual child notification provenance, so its physical cause is not claimed as proven. Two controlled boundary cases now distinguish an independently delivered file-create notification from the coarse directory notification: an otherwise new file can retain its verified absent baseline, while an already historical Unknown cannot be upgraded by that later signal. The original parent-notification-only cases still require the newly discovered child to remain Unknown. The real Host phase now explicitly seeds historical Unknown evidence and records actual child notifications, exercising preservation without assuming all watcher backends deliver only the parent signal. These two provenance cases bring directory coverage to 41 cases and the full tracker suite to 1873 for final-head CI.


## P1 follow-up: reconstruction provenance through intent cleanup

The unresolved automatic review on `87b83684bb72dcf10b19457c923379c663745423` was valid. Independent review demonstrated that a parent-only directory notification during interrupted Keep or archive-intent cleanup could establish `baseline = ''` for an unproven child. Block Revert then returned success and emptied the actual editor buffer. Whole-file Revert protection and the preceding green CI did not cover this path.

The installed reconstruction witness now labels its notification as observation-only at the producer. Queue coalescing retains that label, including later changes and text-document notifications. Configured-scope directory creates from the Host are classified before queue publication as well: another coarse directory notification cannot temporarily authorize child absence while a concurrent bounded scan is running. Unverified metadata provides no empty-before-image proof. An independently observed file create keeps its separate evidence; historical Unknown remains protected.

All consumers preserve this distinction: ordinary restore and interrupted-operation cleanup use the restore-owned watch/scan/persist handoff; Recheck retains it in discovery and its final replay; final archive replay uses the same bounded handoff, including its one-shot stopped observation. Runtime reconstruction witnesses enter directory observation without an explicit creation identity. Directory-to-file replacement during replay also goes through the normal unavailable/Unknown reader rather than ordinary file creation. Existing epoch, owner, settings, budget, dirty-document and durability checks remain in force.

| Regression boundary | Before correction | Corrected assertion |
| --- | --- | --- |
| Keep/archive cleanup, normal restore/Retry | 4/4 fail; child gets empty baseline | 4/4 preserve Unknown and saved Retry provenance |
| Independent portable Keep/archive block-Revert probes | 2/2 return success | 2/2 return conflict; no review token |
| Host directory-create notification alone | Grants inferred child absence | No child creation proof |
| Runtime parent witness | Block Revert succeeds on an invented baseline | Unknown and block Revert conflict |
| Recheck discovery/replay | Older scan coverage grants empty baseline | Queued reconstruction interrupts that inference |
| Directory replaced with a file before replay | Replacement receives empty baseline | No empty baseline or usable token; Revert conflicts |
| Final active/stopped archive replay | 2/2 fail closed with incomplete coverage | 2/2 complete bounded observation, preserving child Unknown |

These twelve new core cases plus the two existing independent-file-create controls pass together (14 cases total, including the two portable block probes). No fixed sleep or automatic retry is used to mask a notification race.

A new real Extension Host test moves an already populated synthetic directory into a legitimate `files.watcherExclude` blind subtree while the actual Keep/archive intent deletion is held. It waits for the installed native parent's real notification and asserts that no individual child-create was delivered. All four operation/normal-or-Retry combinations preserve original known content and child Unknown. Calling block Revert against the actual VS Code document returns conflict and leaves both buffer and disk unchanged. The same test fails against the original `87b8368` production code on official VS Code 1.80.2, at the block-Revert assertion; it passes with the correction on 1.80.2 and Stable. Case-specific child paths prevent an open document from another fixture being reused. No historical Unknown is preseeded in these new cases.

The original two independently reported P2 fixes remain separate: certification reconstruction and late settings Status were independently revalidated before this P1 correction. New exact-head CI, automatic review and the original independent ultra review are required for the final correction; earlier approvals are not reused.


The full core run exposed two older configured archive tests whose assertions treated a directory-only create as blanket child absence. Their replacement checks both directions across active/stopped commit and restart: directory-only discovery must persist Unknown and refuse block Revert, while an independently delivered child-create must retain its known-absence review. Existing legacy compatibility expectations remain unchanged. Adding the latter controls also reproduced lost legitimate evidence: clearing the whole event batch hid unconsumed child-create events from the directory scan. Drains now consume only the exact event being processed, retaining remaining child evidence and skipping any event superseded during an await. The six archive controls pass without downgrading the positive known-absence assertions. This is an availability correction accompanying the stricter provenance boundary, rather than permission to upgrade historical Unknown.
