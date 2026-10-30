# Exclusion settings and Apply transaction repair

Status: **Draft; implementation and acceptance are incomplete.**

Baseline: `454f107a143c41c2c4966e655d189e6c82d08ee2` (0.8.11 source).
This work addresses exclusion settings saves, Apply, conflict review and
compensation. It does not change the version or publish a release.

## Reproduction boundaries

Two failures require separate evidence:

1. A confirmed coverage-row shortcut can report that ignore-policy preparation
   was invalidated, after which its exclusion request is absent. The conditional
   settings compensation path can explain the final state; the invalidating
   event or policy transition has not yet been independently identified.
2. Save and Apply can report that scope was not applied and settings could not
   be fully restored. The saved request may already contain the new exclusion
   while the effective scope remains on the previous revision.

An in-memory production-controller probe reproduces the second error without
external edits when a successful configuration update response precedes its
observable configuration notification. Delaying the last exclusion write leaves
the target saved, fails before Apply, and rejects compensation against the stale
readback. Immediate publication succeeds with the same proposal. This establishes
a controller boundary weakness, not a proven field or real Extension Host cause.
The activated field build and VS Code version have not been independently obtained.

Structured exclusion sorting is expected: a draft containing `/prior-cache/`
then `/generated-cache/` may be saved in canonical order. Owned write expectations
already use that canonical proposal. Raw settings fingerprints also distinguish
unset values from explicit empty arrays, unlike equivalent canonical scopes.

## Intended behavior and constraints

- A resource or coverage-row exclusion, Save and Apply, and applying an already
  saved request each complete the necessary safe preparation from one initiation.
  Combine required consent and affected-review decisions into one confirmation.
- Settle only configuration writes and notifications causally owned by this
  action. Preserve real external edits, newer drafts, roots, epochs, affected
  reviews, dirty editors, Git/trust/legacy restrictions and durable evidence.
- Preserve a draft and provide one clear conflict choice. Distinguish unchanged
  settings, a saved but unapplied request, and a committed scope whose observation
  verification is incomplete. A conflict message must not assert an external
  editor merely because the action changed its own settings.
- Compensation may restore only the exact still-owned request. It must not
  overwrite newer settings or undo an effective exclusion after commit.
- Retire only corresponding active coverage evidence after committed exclusion
  or successful bounded verification. Keep unrelated failures visible, Unknown
  before-images, pending reviews and unrelated Undo intact; remain stopped.
- No fixed sleeps, blind retries, global polling, raised watcher limits, disabled
  guards, automatic Clear/Reset/Accept/Rebuild or workspace/Git file mutation.
  Any retry needs causal ownership, a finite budget and safe preparation only.

## Test seams and implementation slices

Use production scope/controller/tracker behavior through existing public scope
actions and the scope WebView. Mock configuration storage/notification and other
system boundaries, not the scope or review algorithms.

1. **R0/R1:** add one red Save and Apply case for owned delayed configuration
   publication; implement the smallest bounded settlement fix, then add negative
   external-write, failed-update and partial-save cases one vertical slice at a time.
2. **R2:** independently reproduce shortcut ignore-preparation invalidation using
   self-configuration delivery and actual observed events; fix only demonstrated
   causal interference while retaining genuine policy and content conflicts.
3. **R3:** cover ordinary resource/coverage shortcuts, Apply Saved Request,
   existing drafts and conflict review, canonical ordering and unset/empty values,
   notification reordering, cancellation, duplicate clicks and reentry.
4. **R4:** cover lifecycle/root/review/dirty/Git changes, persistence and compensation
   failure, restart, saved/effective consistency, dormant excluded evidence,
   independent faults and continuing in-scope native file observation.
5. **R5:** add real VS Code configuration update/notification acceptance on Linux,
   Windows and the minimum supported Host. Run complete quality, installed-product
   and package privacy gates on the exact head, self-review the completed diff and
   complete one deduplicated automatic review cycle.

Each checkpoint must distinguish proved behavior, boundary-model evidence and
untested combinations. Passing mocked delayed-notification cases does not replace
real Host evidence. Public examples and evidence use synthetic directories only.

## Progress

- [x] Verify baseline, existing ADRs and public action seams.
- [x] Record separate failure paths and limits of the initial boundary probe.
- [ ] R0/R1 red/green configuration settlement and external-conflict regression.
- [ ] R2 separate ignore-preparation reproduction and repair.
- [ ] R3/R4 interaction and recovery matrix.
- [ ] R5 complete real Host, quality, package and review acceptance.

The first implementation checkpoint settles an acknowledged configuration write
against its observable Workspace request before proceeding to the next key or
Apply. It listens before updating, accepts only the owned before/expected
snapshots, stops on an observed competing request, and bounds missing
publication without repeated writes or polling. The same settlement applies to
Save and Apply compensation. An observed competing edit cannot regain old
compensation authority by choosing the same final value as the proposal.

Seven production controller/tracker boundary regressions cover delayed Save and
Apply, the coverage shortcut, competing changes in both paths, delayed
compensation, withdrawal after owned publication, and old unnamed-event
diagnostic presentation. The scope settings
Host checkpoint uses actual VS Code update/notification APIs in an isolated
single-folder workspace, including stopped and active Save and Apply and
continued real file observation. Its cross-platform execution remains pending.

Unnamed-event recovery uses the existing guarded Recheck action; no baseline
rebuild is prescribed or added. Ready coverage rows expose Recheck alongside
exclusion. Blocked rows explain the current guard and retain scope management.
Known obsolete persisted advice is corrected only for display; stored evidence
and before-images are retained. The separately reported unnamed-event case was
identified as 0.8.10; this does not establish the activated build for the
exclusion-save failures, nor identify which gap remained after its Recheck.

R1 is not yet complete: missing/rejected update publication, partial saves and
the broader conflict/restart matrix need further qualification. An independent
R2 boundary probe now reproduces the exact ignore-policy invalidation when a
notification for the settings file written by the action arrives during Apply
preparation. The failed transaction compensates its exclusion request. This is
separate from stale configuration readback and does not prove the field cause;
the bounded handling below is now under real Host qualification. The initial
documentation-head Verification run also failed Windows Stable Host during
automatic moved-directory observation; that failure remains under diagnosis
and is not established as repaired by the settings settlement changes.

Full-regression diagnosis also exposed scoped test fixtures accumulating under
the shared harness root until later Rules scans exhausted the production entry
budget. Scoped fixture disposal now removes only its own workspace and storage.
Production limits and the failing assertions remain intact.

Local checkpoint validation passed: compile, lint, complete `npm test` (1,712
tracker cases, 193 review UI cases, 28 real temporary Git scenarios and 10 Host
fixture tests), performance smoke checks, and the actual 75-entry VSIX privacy
inspection. Version remains 0.8.11. Real Host and exact-head CI results are not
established by these local checks.

The first runtime head's three real Host variants all reproduced the same
stopped Save and Apply failure after all three configuration notifications had
arrived. The next checkpoint addresses a separate source-ownership defect:
single-folder VS Code windows expose their Workspace configuration model as
Folder configuration too ([VS Code 1.80.2 implementation](https://github.com/microsoft/vscode/blob/1.80.2/src/vs/workbench/services/configuration/browser/configurationService.ts#L609)).
Comparing the Folder alias as an independent source invalidated the action's
own exclusion write. Joint before/after alias qualification now preserves owned
updates while retaining independent Folder values and pinning workspace-file
topology. Delayed readback and actual source aliasing are separate contracts.

Additional unnamed-event tests exercise a fresh callback followed by successful
public Recheck and continued native-boundary observation, dirty-editor refusal,
and injected native installation failure retaining Limited. All preserve
pending review, Unknown and Undo; the successful case executes Undo afterward.
A fixture generated by the released 0.8.10 tracker source verifies persisted
runtime-gap recovery without replacing original baselines. These are production
tracker tests with mocked VS Code/native boundaries, not installed old-extension
or real OS capacity tests. Healthy fresh-callback probes also pass against the
0.8.10 source, so an old-version label alone does not explain an unspecified
remaining gap or guarantee that an upgrade will clear every warning.

Second local checkpoint validation passed: compile, lint, complete `npm test`
(1,720 tracker cases, 193 review UI cases, 28 real temporary Git scenarios and
10 Host fixture tests), performance checks and the actual 75-entry VSIX privacy
inspection. The three Host failures on the first runtime head concern the new
stopped-save assertion; the earlier documentation-head Windows moved-directory
timeout remains a separate unresolved diagnostic. The source-alias repair still
passed stopped Save and Apply on all three real Host variants. Active Save and
Apply still failed: Windows/1.80 reproduced ignore-policy invalidation, while
Stable Linux failed at candidate durable preparation.

The next implementation reconciles the one known settings control file before
Apply, preserving its original baseline and pending review. A receipt is tied
to this operation, epoch, request, scope eligibility and physical file identity.
Only late notifications matching the already-observed bytes, metadata and
identity can be duplicates; other events retain transaction invalidation and
normal replay. The actual file is reverified at the durable commit barrier.
There is no Apply retry, fixed delay, global polling or coverage-gap clearing.
Receipt work is limited to a 1 MiB file, 16 verification reads and 4 MiB total;
exhaustion fails closed. An explicitly excluded control file is not read.

Four regressions reproduce both Host failure stages for the shortcut and Save
and Apply, then pass with one settings-write sequence. Eight negative cases
retain unrelated-event, changed-byte, replaced-identity, dirty-editor, Stop and
budget guards, including mutations without another callback at the durable
barrier. Changed or unverified physical settings are not overwritten by
compensation. Local complete validation passed 1,732 tracker cases, 193 UI
cases, 28 real temporary Git scenarios and 10 Host fixture tests, plus lint,
performance and the actual 75-entry VSIX privacy check. Real Host confirmation
and the remaining R1/R3/R4 matrix are still required.
