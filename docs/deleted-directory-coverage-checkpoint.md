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


A subsequent automatic P2 on the same chain confirmed that a directory-only ignore such as `ignored/` was checked as a file before restore certification. The owner correctly refused the ignored target, which incorrectly blocked the entire recovery. Two directory-aware policy checks now skip such notifications before requesting a handoff, matching the existing runtime observer. They do not enumerate the excluded tree, install an owner, clear dormant uncertainty or relax proof for an included target. Six regressions fail on e147624 and pass after the two-line correction: explicit/Git-ignore policy × normal/Retry, plus active/stopped final archive replay. Original known baseline and pending review remain intact; excluded children acquire no baseline, Unknown record or owner. A real 1.80.2 Host test waits for the actual directory-only excluded create during intent cleanup: e147624 returns blocked, while the correction recovers and retains the parent-only child/Revert protections. The Stable comparison passes as well. The independent-child-evidence P2 is separately fixed by e147624 with six positive/negative archive controls.


The final epoch audit found one more availability race at the asynchronous directory classification boundary: if the target becomes a file and a newer paused epoch is established during metadata I/O, the old restore callback could enter the ordinary file reader using that newer epoch and update its frozen review. A deterministic extension of the existing late-epoch case reproduces the unexpected new tracked change, without a baseline or disk write. Restore and final archive replay now revalidate their owning epoch/context immediately after classification for both directory and non-directory results. The two classification outcomes pass together, and the 26 provenance/ignore controls remain green. No lifecycle guard is bypassed.


## Final retirement counterpart: exact file notification retention

Automatic review and the original independent ultra review confirmed one remaining P2 on 7ce724f: during the retirement save, an exact file-create was collapsed into a coarse target observation. Runtime, restore and Retry then lost a legitimate empty before-image. The same notification after the barrier worked. This was an availability loss, with no demonstrated incorrect acceptance or disk write.

Retirement now retains independently reported regular-file events from the same workspace owner in the existing replay queue, alongside the coarse target records. That queue supplies exact creation evidence while the directory handoff scans, then consumes the events through the existing runtime or restore guard. Change preserves create evidence; delete supersedes it. Directory notifications never grant child absence, and historical Unknown remains protected. Retention and runtime replay use the existing traversal allowance. Overflow preserves a precise subtree diagnostic and the original baseline, saves uncertainty and pauses through the existing durable failure path; it cannot silently drop proofs and report Full or increase the watcher budget.

| Lifecycle stage | Coarse directory signal | Exact independent file create | Historical Unknown / invalidation |
| --- | --- | --- | --- |
| Certification / retirement, runtime + restore + Retry | Observe and preserve Unknown | Keep empty before-image and text token | Unknown stays; delete supersedes proof; bounded overflow pauses |
| Intent cleanup, Keep / archive | Observe and refuse unproven block Revert | Shared queued file evidence remains separate | Durable Unknown survives paused retry |
| Generic / final archive drain | No blanket child absence | Remaining batch evidence stays visible until consumed | Superseded events and newer epochs cannot publish |
| Directory ignore | No obligation or traversal outside policy | Excluded children are not adopted | Dormant uncertainty is retained |

The eleven added retirement cases include runtime/restore/Retry positive and historical-Unknown controls, an after-barrier comparison, create+change, create+delete and two bounded-overflow cases. The three positive during-barrier cases fail on 7ce724f and all eleven pass after the correction. The preceding 26 provenance/ignore cases and both epoch outcomes still pass. A real Host test uses WorkspaceEdit.createFile, waits for actual onDidCreateFiles delivery during certification, writes through the real provider and verifies the child has its correct empty baseline and review token; its historical-Unknown sibling stays Unknown. Normal restore and Retry pass on official 1.80.2 and Stable. The actual 1.80.2 case fails against 7ce724f at the exact-file baseline assertion. This positive case and the parent-only block-Revert negatives run together, without callback injection or retries.


## Creation evidence lifetime: fixed phase matrix

Two subsequent reviews identified complementary ordering errors on 152dd91: ancestor deletion did not revoke retained descendant creates, while an exact delete followed by a new regular-file create inherited an obsolete directory-observation flag. These require one queue contract rather than separate per-stage exceptions.

| Received evidence | Pending creation state |
| --- | --- |
| Independent file create | Fresh file proof; replace the previous incarnation's observation marker |
| Change, same file target | Preserve its existing creation proof; do not revive revoked proof |
| Exact delete | No creation proof remains for that incarnation |
| Ancestor delete | Revoke pending descendant creates into observation-only changes |
| New independent create after deletion | Establish fresh proof again; historical Unknown remains protected |
| Coarse directory notification / a queued target now classified as a directory | Observe the subtree; never infer all child before-images |

The same revocation and merge rules feed runtime retirement, normal restore, Retry, interrupted Keep cleanup, Recheck and final archive replay. Generic and archive consumers retain an exact queued object through asynchronous classification, then consume it only if its epoch/context and object identity remain current. Discovery and all consumers use the same directory-observation predicate. Known baselines and review data are never retired by this evidence invalidation.

The bounded regression matrix is 53 cases: 17 retirement cases, 16 provenance controls, six archive causal controls, two final-archive ancestor controls, six ignored-directory cases, two epoch outcomes and four exact type-transition controls. Ancestor negative and positive cases cover runtime/restore/Retry, Keep cleanup and stopped archive replay. The old head fails the five negative ancestor cases while accepting fresh post-delete creates. In the production handler with the mocked VS Code boundary, the three old retirement cases return success from block Revert and empty the buffer; corrected cases return conflict with both buffer and disk unchanged. Normal/Retry exact delete-to-file cases fail on the old head; the corrected historical-Unknown control remains Unknown. A file-create followed only by a directory change is also classified before consumption, preserving its children's Unknown.

A real 1.80.2 Host comparison waits for actual directory create, actual exact delete, then an actual native regular-file create at the same path during intent cleanup. The old head loses the text baseline; the correction retains the empty before-image and token. Stable passes the same scenario. A WorkspaceEdit control also passes on the old head because its onDidCreateFiles entry bypasses this particular queued-filesystem-notification bug; that control is retained as a distinct successful path and is not called a native red reproduction. The earlier real retirement WorkspaceEdit red/green remains a separate valid comparison. No callback injection, arbitrary sleep, retry or safety assertion removal forces these outcomes.


The same matrix was extended to an event already dequeued but still waiting in the file handler's metadata classification. A stopped-archive probe on 8a643d3 reproduced the safety loss after ancestor deletion; its fresh-post-delete control passed. Configured queued file creates now retain a bounded in-flight evidence token until the handler returns. Receipt of a delete revokes matching active tokens as well as queued descendants and retains observation duty. The existing creation-current guard refuses an expired token before capturing a before-image; active creation queries also check that token. A file target becoming a directory is requeued for bounded observation rather than lost. Restore-time onDidCreateFiles notifications enter the same dispatcher after the existing archive deferral, so the API and filesystem entrypoints share this restore contract. Ordinary stopped/runtime handling and automation-session safety remain in force.

The three added in-flight controls cover stale proof refusal, valid fresh proof and file-to-directory discovery. The independent review then supplied four additional Keep/archive × with/without change-notification cases for the later asynchronous type-check boundary. All four return successful block Revert on 8a643d3 and all four preserve Unknown, refuse block Revert and leave disk unchanged with the in-flight guard. Together with the preceding matrix these provide 60 focused controls; the complete suite contains 1926 tracker cases. These added cases exercise the production handler with a mocked VS Code boundary, not a native Host callback. The in-flight evidence set uses the existing traversal allowance and is cleared on epoch changes; no watch budget or persisted schema is added.

## Exact-head CI failures retained and fixture corrections

[CI 41231302443](https://github.com/lengmh/DiffTracker/actions/runs/41231302443) on 8a643d3 failed Windows Quality and the minimum 1.80 Host; five checks passed and packaging was skipped. Its clear automatic review is separate from those failed checks.

The Windows failure was the pre-existing `continues-through-read` fixture: successive replacements had equal length and depended on mtime precision to make the second write observable. Both bounded-reader methods are byte-identical to main. Pinning the mocked VS Code mtime reproduces the old fixture's `text` rather than `unknown` result; changing the size on every write makes the same safety expectation deterministic. The corrected fixture pins mtime deliberately, keeps the Unknown assertion, and keeps stable-read/text-token controls. It changes neither the reader nor stale-token validation.

The 1.80 failure was the first `batch-a.txt` pending wait before Stop/Clear, after restoring two live observation settings and waiting a fixed 250ms. The failed run lacked tracker diagnostics, so its physical cause is not established and it is not attributed to the separate settings-ownership limitation. One diagnostic full 1.80 run passed the original location with Recording/Ready and no lifecycle blocker both before and after configuration restoration; that successful comparison does not erase the failure. The fixture now tests Clear under the observation configuration already verified by the preceding native-edit checks, restores settings only after recording stops, and asserts their values. The fixed sleep is removed. A timeout includes the recording/baseline/lifecycle and synthetic target diagnostics. No production ownership, transaction, Unknown or watcher guard is weakened, and no retry or extra write supplies a missed notification.


The next exact-head run, [41234576077](https://github.com/lengmh/DiffTracker/actions/runs/41234576077), passed both Ubuntu Hosts including 1.80, but Windows Stable reached the existing Issue 55 multi-round directory scenario and failed its separate post-idle gap assertion. The visible gaps were active directory-verification markers at the parent and `live-2`; the unchanged fixture had awaited only an empty job map, then asserted Full after yielding back to asynchronous classification/native notifications. It now requires idle and Full together in one bounded observation, with exact gap/job diagnostics on timeout. Full is still mandatory; no marker is filtered or cleared, no proof is retried, and a failure to converge still fails the test. This evidence does not establish that the production proof failed permanently; the original failed run remains retained.


## Recheck consumes proof-expiration fallbacks

Automatic review of 0fedcd4 confirmed a P2 in the final Recheck consumer: the file handler correctly refused creation proof after an awaited stat resolved to a replacement directory, but its replacement observation was appended after Recheck had captured a fixed replay snapshot. Recheck could return `rechecked` with no gap while the child was undiscovered and the observation remained stranded.

A deterministic filesystem-backed boundary regression delivers the exact create at Recheck's certification-to-replay handoff, holds the actual production handler's metadata await, replaces the file with a populated directory without another notification, and releases it. On 0fedcd4 it returns `rechecked`, no gap and no child review; the ordinary-file control succeeds. This is a mocked VS Code boundary test, not an injected event claimed as a native Host reproduction.

Recheck now consumes newly queued replacements within the same fixed notification allowance, instead of only its original snapshot. Exhaustion retains queued work and reserves precise durable uncertainty before publishing it; a reservation or save failure uses the existing safe-pause path. Full cannot be reported for undiscovered deferred work. Five controls pass for directory replacement (Unknown, no token, block conflict and a fresh owner), ordinary file creation, bounded exhaustion with a persisted Limited marker, a newer epoch and directory-only exclusion. The old head fails directory, exhaustion and stranded ignored-observation cases. All 60 uppercase Recheck cases, eight other Recheck cases, the original four type-await P1 cases and three in-flight controls pass after the change. The earlier complete suite was 1926 cases; these five additions require 1931 cases on the new exact-head CI. The producer/consumer matrix now has 65 focused lifetime controls. No watcher allowance, schema or user scope preference changes.


## Deferred-target uncertainty also has a verified retirement path

Independent ultra confirmed a P2 on f500d1a: the new non-root `coverage-recheck-incomplete` evidence survived after normal budgets returned, its children were reconciled and a current owner existed. Workspace-root markers already had a retirement path; target-level markers did not. Allowance-zero and allowance-one recovery controls both fail on the old production code with repeated static Limited results.

Deferred directory targets now enter the existing failed-import repair and certification transaction: reserve the retained direct-observation obligation, install/validate its same-owner coverage, scan against original before-images, capture owner identity/event revisions and retire only the unchanged evidence after the durable barrier. Deferred file targets use the existing stable-file control-gap transaction. Workspace-root markers keep their existing handling. No general reason-code clear is added. A current owner alone is insufficient; changed ownership, events, scope, failed scan or persistence still refuse certification and retain uncertainty.

The seven fallback controls pass, including zero/one notification allowance recovery, an exhausted file target, failed direct-owner allocation followed by safe recovery, and a rejected certification save that restores target evidence before a later quiet Recheck succeeds. Child before-images remain Unknown and known originals are unchanged. Existing Recheck, P1, lifecycle and Host verification are rerun for the new candidate. The full tracker count is now 1933; exact-head CI and original independent ultra re-review remain required.


## Durable before-image provenance and save-event replay

Independent ultra reproduced a P1 on 971c72d after an actual allowance-one fallback save: reload discarded the temporary queue, restored discovery trusted the old scan fingerprint, and gave an unproven child an empty before-image before the target gap was retired. The raw and older imported-wrapper records both fail the new pre-certification baseline assertion on the old code; independently delivered exact-file creation remains a passing control.

Restored discovery now checks same-owner, non-workspace-root deferred directory evidence as well as the temporary queue before inferring absence. Independent creation proof still wins for a previously unknown path; historical Unknown remains protected. Imported-owner serialization preserves the deferred reason code instead of hiding it under the restart wrapper. Older candidate wrappers are recognized only by their exact retained deferred-observation reason; unrelated restart evidence is not globally reclassified. No field or schema is added. The three controls cover raw/wrapped persistence, a real queue-delivered positive file proof, unrelated offline additions retaining their normal baseline inference, transaction retirement and a second reload. Unproven children keep no text token and block Revert leaves their buffer unchanged.

The original [971c72d Ubuntu Stable failure](https://github.com/lengmh/DiffTracker/actions/runs/41237227580/job/124643433700) lacked event provenance diagnostics and remains retained. The tested restore path performs zero Recheck calls, so the previous Recheck-only retirement change is not on that path. A controlled real Stable reproduction found a separate production producer: onDidSaveTextDocument processed a newly created file before its queued creation was replayed, publishing historical Unknown despite the retained, unrevoked create proof. WorkspaceEdit.createFile followed by an actual document edit/save reproduces the same empty-baseline assertion failure; the trace records queued create proof and no later delete. This proves the save-notification defect, without claiming the unrecorded original CI had exactly that event sequence.

Save notifications now defer through the existing retirement/recovery queue, preserving create+change semantics instead of constructing a before-image early. Four boundary controls cover normal runtime, restore, Retry and historical Unknown; restore/Retry fail before correction, all four pass after it. Both official Stable and 1.80.2 Host pass direct creation and forced actual save × normal restore/Retry, together with the parent-only Unknown/block-Revert negatives. The original positive assertion is unchanged; bounded event/Unknown-producer diagnostics now make any recurrence reviewable. No sleeps, retries, gap filtering, baseline adoption or extra watcher allowance force these outcomes. The prospective full tracker count is 1940; new exact-head CI and original independent ultra review remain required.

## Follow-up on 8cf9e805: revocable creation proof at publication

Four independently supplied controlled probes were reproduced separately before
editing production code. The restored-discovery late-create P2 and Workspace
Source hints toggle P2 are specific to this branch. The stale restored absence
plan P1 and direct runtime metadata-await P1 also reproduce on main a4a309a.
The P1 probes demonstrate block Revert emptying the editor buffer; they do not
demonstrate a disk write or a successful whole-file Revert.

Direct configured file notifications and queued consumers now share the same
revocable proof. It binds the current epoch, effective scope, coverage generation,
workspace owner, parent physical identity and regular-file type. A proof applies
only to its exact file, and cannot authorize a replacement directory's children.
An ordinary atomic file update under the same parent remains supported. A new
independent create after deletion establishes a fresh proof; historical Unknown
is never upgraded by this discovery path.

Restored discovery rederives each candidate at the synchronous publication
boundary, after all metadata awaits. This both rejects revoked empty-baseline
plans and admits valid file-create proof received after an earlier Unknown plan.
The final categories are reserved against a fresh persistence budget before any
baseline maps change. An invalidated direct create also retains the existing
pending-scope event obligation when a newly requested exclusion caused the
invalidation.

| Boundary | Negative control | Positive control |
| --- | --- | --- |
| Direct runtime metadata await | Ancestor replacement, including no delivered delete; file to populated directory | Ordinary file creation, fresh post-delete proof, atomic file update |
| Restore planning to publication | Ancestor delete revokes an already planned empty baseline; block and whole-file Revert refuse | Same-incarnation late file-create replaces only the provisional Unknown plan |
| Persistence and allowance | Publication budget refusal, save failure, historical Unknown | Valid proof and revoked proof retain their correct categories across reload |
| Lifecycle and scope | Stop, newer epoch, pending exclusion preserve original state and observation duty | Known baseline and unrelated review remain intact |

The portable independent probes first report runtime 1/3, restored discovery 2/6
and Source hints 1/3 on 8cf9e805. Unchanged probes pass 3/3, 6/6 and 3/3 after the
correction. Twenty-one integrated tracker regressions cover these cases and the
failure/lifecycle controls. Three UI regressions toggle both directions with a
true/false Workspace override and with no override, checking effective value,
write target and unchanged Global preference. Source hints uses an existing
Workspace override when present; other settings keep their current write scope.

The first full local run exposed an unpublished compatibility regression: final
file-type validation skipped a disappeared scan candidate, dropping its proven
absent baseline during an offline delete replay. The correction captures the
parent/scan witness before the metadata await and preserves confirmed missing
files under that still-valid witness. It does not accept directories or unknown
metadata. The final full suite passes 1961/1961 tracker cases and all UI, Git
and Host fixture suites, including the final pending-scope control. Full real Linux Extension Host runs pass on official Stable and 1.80.2,
including existing native parent-only Unknown/block-Revert protections and
independent file-create controls. The newly reported interleavings use real
files and controlled production notification/provider boundaries; natural Host
delivery has not independently reproduced those exact new sequences.

No persisted schema or user configuration migration is introduced. The private
independent reproduction package and raw logs are excluded from the repository
and VSIX. Exact-head CI, automatic review and a new independent review remain
required before acceptance; no merge or release is included.

## Follow-up: a failed directory import owns only its own publication

A rollback snapshot can contain a transient Unknown that a later independent
creation has legitimately replaced. Restoring that snapshot must not overwrite
the newer publication or its accepted baseline. The failed import still restores
its own provisional children; historical Unknown is not eligible for promotion.
Legacy runtime file-create notifications now use the same revocable proof as
configured notifications, so a subsequent delete can also revoke the newer
provisional creation before it is accepted.

The fixed 16-case rollback matrix covers configured/legacy scope, storage/no
storage, a later exact file creation, a later nested-directory batch, revoked
creation, and historical Unknown. It fails the old parent at a real metadata
await after other children have been prepared. Storage cases verify primary,
last-good and reload state; all cases preserve file contents and the unrelated
Unknown children. The independent four-case reproduction changes from 0/4 to
4/4. These are controlled filesystem/provider-boundary regressions, not a claim
of a naturally delivered Host reproduction of this exact interleaving.

## Follow-up: legacy recovery queues retain revocable creation proof

Legacy and configured restore queues now capture the same exact-file witness,
revalidate it across asynchronous classification, and revoke it on ancestor
deletion. A coarse directory notification does not establish child absence.
Legacy queued directory observations use the existing bounded scan/publication
path while retaining independent child proof, historical Unknown and the
original review baseline. Healthy legacy recording remains available.

Imported direct handles retain their physical directory identity. Reusing an
owner requires that identity still to match; replacement consumes the existing
watcher slot. A failed runtime observation keeps precise Limited evidence and
can recover after the allowance is restored, without promoting Unknown files.
No persisted schema, version or settings migration is introduced.

The 25-case legacy matrix covers actual saved-session recovery after listeners
are registered, direct/queued notifications, storage/no storage, ancestor and
file-type replacement, coarse directories with/without exact child proof,
historical Unknown, Stop/epoch, storage refusal, quotas and watcher rebinding.
Before-image protection is checked in memory, primary/last-good state and
reload; negative block-Revert actions preserve buffer and disk. The independent
actual-restore probe changes from 2/3 to 3/3 and its type matrix from 8/12 to
12/12. These interleavings control production provider/notification boundaries;
they do not constitute a natural Host reproduction.

The full-suite follow-up also preserves the original stopped-review boundary
when an archive restoration is cancelled. Rollback to a stopped session limits
temporary observation to existing baseline/review paths, refreshing their real
changes without expanding the frozen review to unseen files. Active-session
rollback still reconciles all its events. Both legacy and configured creation
controls fail on the preceding candidate and pass after correction, including
an independent creation during rollback intent cleanup. Exact document-save
notifications at cleanup and earlier ancestor notifications keep changes to
existing review files visible. Primary, last-good, archived bytes and review before-images
retain their original assertions. Legacy archive directory controls require Unknown for
coarse notifications and add exact-child-create positive controls.

A second existing proof gap occurred when a directory child was classified with
valid exact-file evidence, but a delete revoked it while file bytes were being
read. Both legacy and configured negative controls allowed block Revert on the
preceding candidate. The consumer now rechecks proof after reading and binds
the surviving exact witness to its provisional publication, including the
durable write barrier. Queue consumption alone does not revoke valid proof.
Eight controls cover both scopes, read/write awaits, valid/revoked evidence and
reload. Listener registration precedes physical creation; notifications run the
installed production callbacks at the modeled VS Code boundary.

The automatic review of 7778b3b also identified missing deletion projection for
legacy directory reconstruction. Both direct and queued legacy imports must
reconcile retained baseline descendants absent from the completed scan before
certifying coverage. They now share the same owner-filtered, bounded missing-path
pass as configured handoffs. Two controls fail on the preceding candidates and
pass after correction, preserving original baselines, sibling edits and deletion
review through primary/last-good persistence and reload.

Stopped archive rollback also keeps that frozen review boundary when a saved
`.gitignore` notification refreshes policy. The refresh retains its ordinary
context-invalidated diagnostic, but its event drain does not discover unseen
files. Four controls cover legacy/configured and active/stopped rollback;
known edits remain reconciled, and only active rollback can discover additions.

A filesystem-backed deletion control exposed an older directory observation
finishing after normal deletion had already certified its reconstruction owner.
That obsolete pass wrote a fresh runtime coverage failure. Each bounded proof
pass now binds the directory incarnation across its awaits; obsolete scans
cannot publish later failures. A coalesced replacement still receives its own
bounded pass, with unknown child before-images protected. This control matches
the residual gap seen in a minimum Host failure; its exact native event ordering
has not been established. The original failure is retained separately from the
subsequent isolated Host diagnostic, which passed once.

The next Windows Host failure retained directory-change gaps after a finite
series of Ready publications interrupted preparation before its first proof.
A deterministic filesystem/write-barrier control reproduces that omission.
Completed publications now count as progress, with a separate finite allowance
bounded by the existing preparation-entry limit; scan entries and the two actual
proof passes are unchanged. Zero allowance, Stop and storage failure still
prevent certification. The minimum Host's workspace-context refusal
is a separate retained failure, with its folder-event diagnostics expanded
without changing the production workspace membership guard.

Policy contraction during rollback also preserves the original stopped review
in legacy Rules. A temporary, epoch-bound set of original known resources now
survives rollback discovery and intent cleanup. Ordinary policy pruning retains
those exact resources so current-content reconciliation can still read them;
pending explicit exclusions and hard boundaries remain in force. The set ends
with the archive task and does not authorize discovery of new files. File and
parent exclusions have red/green legacy controls and configured positive
controls, including latest review content, primary/last-good persistence,
unchanged safety backup and the existing recovery pause on reload.

A duplicate file-create can also finish its older Ready save after a newer
creation has started reading. The obsolete operation previously reserved the
latest-read slot before checking its validity, so it could suppress the valid
read while its own result was rejected. Empty and nonempty creation reviews
could both disappear without changing the baseline or disk. Reads now check
their operation before claiming that slot and still validate after I/O. Four
legacy/configured controls reproduce the omission on main/v0.8.13 and c12 and
verify review tokens and Keep after correction. The Windows empty-creation
failure has the matching two-create/two-read shape; its trace did not capture
the old operation's predicate, so exact native causality is not asserted from
that trace alone.
## Follow-up: snapshot publication after saved review actions

A watcher snapshot can finish sampling before a newer editor save and Keep or
Revert, while its final provider result returns afterward. Ordering read starts
alone allowed that old result to recreate a phantom text review and token. Stop
then persisted the phantom projection into primary/last-good and reload. The
reported sequence is an existing main/0.8.13 defect; subsequent stale Revert still
refused, and no incorrect workspace write was demonstrated.

Document change/save notifications now revoke an older pending read's
publication marker. A returning read also checks that its same-file
baseline and semantic review state remain the values observed before I/O. Cache
rebuilding with identical values and activity in another file do not invalidate
it. The existing epoch, latest-read and creation-proof guards remain in place;
there is no new persistent generation table or implicit baseline adoption.

Completing action verification alone does not revoke a read: that verification
may have sampled older bytes and returned after a newer watcher result. If the
action then refuses, the newer pending observation remains eligible to publish.
Actual accepted/reverted baseline and review changes participate in the returning
read's semantic-state check. Both the original stale-result matrix and the
rejected-action/newer-read matrix remain required.

The initial action-verification revocation introduced a P2: a delayed old
verification could cancel a newer watcher result even though the action then
correctly refused. Removing that revocation is 8/16 to 16/16 on its focused
matrix, with both scopes, four actions, fresh-notification controls and Stop
primary/last-good/reload checks. The original saved-action and positive controls
remain required alongside these cases; no refused action adopts a baseline or
requires another notification to recover the already sampled edit.

The bounded production regression matrix is 14/28 on the preceding candidate
and 28/28 after correction. It covers both scope modes, file/block Keep/Revert,
save-only observation, reads begun during an action, fresh-read controls,
same-value view rebuilding, sibling activity, Stop primary/last-good/reload and
epoch replacement. These use real synthetic files, registered production watcher
callbacks and controlled provider-await boundaries; they are not a claimed
natural Extension Host reproduction. The separate 1.80 workspace-root notification
cause remains unresolved, irrespective of passing CI comparisons.

## Follow-up: deferred observation kind during Recheck

The release-preparation review found another bounded-replay recovery omission:
a queued directory create can become a regular file before the replay allowance
is exhausted. Missing creation proof was treated as current directory type,
persisting a subtree obligation which later tried to install a directory watcher
on that file. Three quiet Rechecks still returned Limited. The same-file control
recovered. This path was already present in the reviewed behavior candidate;
the version-only preparation did not introduce it.

Deferred notifications now retain uncertainty for the current metadata kind.
Recheck also classifies older deferred evidence without replacing it before
certification: regular files require same-owner parent observation, directories
require their bounded tree observation. Captured type and physical identity join
the existing epoch, policy, owner/event and persistence barrier. Only successful
certification retires the matching evidence and an obsolete file-path directory
descriptor; rollback restores both. Missing, inaccessible, symlink and unrelated
watcher evidence retain their existing conservative paths. Budgets are unchanged.

Planning can bypass an impossible directory installation for a verified regular
file while retaining its deferred evidence/descriptor for the transaction. This
also preserves the origin through reload instead of overwriting it with an
installation error. File-kind deferred evidence still prevents unproven child
before-images if that path later becomes a directory. Genuine independent
creation and historical Unknown continue through their existing proof rules.

The 19-case filesystem-backed matrix changes from 4/19 on the preceding source
to 19/19 after correction. It covers ordinary files/directories, both replacement
directions, older descriptors and reload, quota refusal/recovery, inaccessible
kind, full/regional Recheck, unrelated evidence, pending-review retention,
rejected certification and primary-state preservation, and type/Stop/epoch
changes at the actual temporary-state write barrier. A Host-only observation
control caught an unpublished patch omission: after a full Recheck rebinds Host
watchers, its parent proof must bind the new watcher array, not the disposed one.
That control passes after correcting the capture point. No test converts Unknown
to an invented empty baseline or removes the earlier directory-to-file guard.

These are controlled production/provider-boundary regressions, not a claimed
natural Host reproduction. The original release-preparation CI 41381273950
passed its primary minimum Host run but failed the configuration-publication
diagnostic comparison; its log download was denied by storage. That failure is
retained and unattributed, independently of this correction or later results.
Fresh final-code CI and independent review are required before publication.

## Independent directory origin and mutable watcher health

Independent review of `62d1ff4` found a residual P1 and P2. A native watcher
failure could replace deferred-directory diagnostics, then the queue was consumed.
An unobserved late child subsequently gained an empty baseline and a block action
which cleared its buffer; primary/last-good and reload retained that projection.
The associated current-kind recovery also lost its eligibility after the same
diagnostic replacement. Both sequences reproduce on the earlier `dcd8c834`
candidate; an unmatched main queue precondition does not establish main behavior.

The existing bounded coverage-record array now stores three independent facts:
`importedCoverageRequired` describes durable observation ownership, `file` and
`subtree` carry current health diagnostics, and `unprovenDirectoryObservation`
preserves before-image origin for the current baseline. Replacing or retiring a
diagnostic cannot erase that origin. Source-only records do not count as Limited
and do not themselves create imported watcher obligations. Real watcher failures
remain precise, while current-kind certification still needs the appropriate
owner, identity, event, epoch and durable transaction.

Discovery consults the typed origin and live creation evidence. Valid exact file
creation remains reviewable; historical Unknown is not upgraded. Health repair
cannot establish an empty before-image for an unobserved child. Origin survives
primary/last-good, reload, interrupted operations and local/scope rollback;
rollback merges live observation facts without replacing newer file evidence.
An explicit fresh baseline retires the earlier origin. Ordinary Keep/Revert,
Stop and coverage repair preserve it. Existing trusted baselines are not silently
rewritten, and missing historical before-images are not reconstructed.

Current V4/V5 readers strictly validate the optional boolean, standalone records,
workspace boundaries and existing count/byte limits. Known older loss diagnostics
are conservatively migrated without changing their error or owner evidence.
New native/reconstruction producers record origin explicitly; new before-image
decisions do not depend on diagnostic text. No budget or storage-version increase
is introduced. The serialized reservation includes the origin before accepting
directory children. Metadata-only origin also remains distinct from optional
human/automation source hints.

Ordinary control gaps retain their existing Host-backed recovery path when origin
is present; origin alone cannot demand a native directory owner. A paired control
caught and corrected that unpublished implementation regression. Healthy configured
native coverage likewise retains source-only metadata without a new imported owner.

The supplied 19-case provider matrix changes from 15/19 to 19/19, including the
actual buffer-action refusals and exact-create controls. New public regressions
use registered Host watcher callbacks plus real temporary-state-write and provider
stat boundaries, with actual synthetic files. They cover quota/type/absence
transitions, late children, genuine and historical creation, primary/last-good,
reload, and import/scope rollback. Schema controls cover both supported formats,
invalid markers and workspace boundaries. These are controlled production-boundary
tests, not a claimed natural Extension Host reproduction. Earlier clear reviews
and CI are not acceptance of this follow-up; fresh exact-head checks remain required.

Final local checks for this follow-up pass: tracker 2194, review UI 221 plus 19
branch-Keep cases, Git 45/28, Host fixtures 15, the supplied 215-case comparison,
lint, performance and 35 artifact guards. Official cached Linux Stable 1.144.0
and minimum 1.80.2 each complete all six real Host phases. Twelve public origin
controls and nine schema cases are included in the tracker total. The inspected
75-file internal VSIX changes only the compiled tracker from the prior candidate;
it is not a Release artifact. Independent review and remote Verification remain
separate gates; the earlier denied log and historical Host limitations remain.
