# Exclusion settings and Apply transaction repair

Status: **Implementation checkpoint; final acceptance is tracked in
[PR #58](https://github.com/lengmh/DiffTracker/pull/58).**

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

## Implementation and contract coverage

- [x] R0/R1 owned configuration settlement and external-conflict protection.
- [x] R2 exact settings-file interference reproduction and bounded repair.
- [x] R3/R4 interaction, lifecycle and failure boundary regressions.
- R5 final exact-head Host, quality, package and automatic review results are
  recorded in the PR checks and description.

Configuration API response and observable publication now share one deadline.
Listeners start before each write. The action accepts its exact before/expected
snapshots and retains an observed competing change even if it later chooses the
proposal value. Missing responses and unverified rejection/publication return
partial results without compensating across uncertainty. A retained write fence
blocks new writes and Apply until the response and observable state settle, or
the controller closes. Late completion never resumes Apply or compensation.
An exact owned value silently published before the deadline is checked once at
that deadline. After partial feedback, an explicit status/action query may
observe completion and release only the fence. A competing silent value remains
a conflict. Late observation also restores the normal pending-request privacy
projection when its notification was missing. No periodic retry or additional
write is introduced.
Save Request Only and Restore use the same settlement, and disposal does not
wait indefinitely for the API. An unresolved failure explains waiting or
reloading before reviewing the saved Workspace request. Successful ordinary
operations still need one initiation.

Single-folder VS Code windows expose Workspace settings through the Folder
view too ([VS Code 1.80.2 implementation](https://github.com/microsoft/vscode/blob/1.80.2/src/vs/workbench/services/configuration/browser/configurationService.ts#L609)).
Joint before/after alias qualification preserves owned writes while retaining
independent Folder values, multiple roots and workspace-file topology guards.
Raw unset/empty values and canonical rule ordering keep their existing meaning.

Before Apply, the tracker reconciles the one known settings control file through
the ordinary review reader, preserving its original baseline. An operation-bound
receipt checks epoch, request, scope eligibility, physical identity, metadata and
SHA256. Only matching late notifications are duplicates; other events retain
transaction invalidation and replay. The file is reverified at durable commit.
Proof is limited to a 1 MiB file, 16 reads and 4 MiB total. Changed or unverified
physical settings cannot be overwritten by compensation. An explicitly excluded
control file is not read. No Apply retry or polling is added.

| Contract | Deterministic coverage |
| --- | --- |
| Delayed/duplicate publication, unset/empty values, canonical order, API timeout or rejection, partial three-key save | `EXCLUDES` cases in `test/scope-exclusion-recovery.mjs` |
| Quick resource/coverage exclusion, Save and Apply, Save Request Only, Apply Saved Request, Restore | Same cases; `SCOPE-RECOVERY` cases and real configuration Host checkpoint |
| Raw draft, current-version leases, Cancel, conflict review, duplicate actions, newer draft and stale results | `test/review-ui.mjs` production panel/command/renderer tests |
| External edits and observed withdrawal/ABA, independent sources, topology, dirty/Stop, identity, byte and budget failures | `EXCLUDES` cases plus existing scope/coverage regressions |
| Saved but unapplied request, compensation failure, late completion and controller recreation | `EXCLUDES uncertain`, compensation and disposal/recreation cases |
| Committed exclusion with incomplete required recovery; unrelated faults remain separate | `SCOPE-RECOVERY`, single-action acceptance/crash and A5 regressions |
| Old/fresh unnamed evidence, healthy Recheck, dirty refusal, native failure and retirement persistence failure | `test/recheck-observation-coverage.mjs` |
| Unknown before-image, pending text, durable gap evidence, Undo and subsequent native-boundary edits | Recheck/upgrade tests and existing single-action recovery regressions |

Unnamed events retain `supplemental-watcher-runtime-gap` evidence. Existing
public Recheck can restore coverage when its guard, scan, owner and durability
proofs succeed. Known obsolete rebuild advice is corrected only for display,
including wrapped old reasons; durable records remain intact. Ready diagnostic
rows expose guarded Recheck and single-action exclusion. Blocked rows explain
the guard and retain scope management. No baseline-replacing button is added.
The field unnamed report was explicitly identified as 0.8.10; that does not
establish the version of the separate Excludes report.

Fresh unnamed probes pass on both released 0.8.10 and current tracker sources.
A sanitized fixture generated by released 0.8.10 source exercises restoration,
healthy recovery, native installation failure and retirement persistence failure.
Failures retain unverified durable state and original review/Undo; success also
observes a later edit and executes Undo. These production tracker tests mock VS
Code/native boundaries. They do not prove the unspecified field remaining-gap
cause, installed 0.8.10 upgrade behavior, or real OS capacity exhaustion.

Two deterministic directory regressions separately exposed pre-proof parent
coalescing spending the coordinator's proof allowance. It now reserves two
actual proof passes and separately bounds preparation interruptions without
progress. Strict upward coalescing is bounded by workspace path depth; all
attempts share the original traversal budget. Later native-boundary edits and
Unknown before-images are asserted. The earlier Windows moved-directory Host
failure predates this PR's runtime implementation; it is not attributed to the
settings readback defect.

The minimum-version native input trace showed a command click delivered to the
editor rather than the expected action. The driver rechecks its hit target after
rendered hover layout before one real click; uncertain clicks are never retried.
Functional assertions and deadlines are unchanged. Scoped fixture disposal also
removes only its own workspace/storage, preventing later test scans from
exhausting production entry budgets. Production limits are unchanged.

At `d00284a`, real Windows Stable, Linux Stable and Ubuntu 1.80 Hosts all passed,
including Windows' three moved-directory rounds. Installed RC, downgrade and
Linux Quality passed. Windows Quality passed tracker/UI/Git/fixture checks but
failed the mixed performance fixture: an asynchronous diagnostic save contained
an additional dependency-parent record compared with active diagnostics.
The next run's bounded event/reason trace identified a healthy owner's
`importedCoverageRequired` / `imported-coverage-restart-required` record, retained
for restart safety. A controlled replay of named parent-directory callbacks
reproduced the exact old assertion failure. The fixture now asserts the exact
union of active gaps and required restart obligations, including each record's
reason, flag and live native owner. It still rejects unrelated or file gaps,
requires one successful Recheck, preserves all review identities and checks
continued observation; no production evidence is cleared to satisfy the test.
The subsequent failure-boundary changes extend the real configuration checkpoint
with public quick exclusion, Apply Saved Request, Restore and later in-scope
observation. Their complete exact-head results and automatic review remain
required. Local checks cannot substitute for these Host results.

The subsequent local checkpoint passed complete `npm test`: 1,749 tracker
cases, 193 production UI cases, 28 real temporary Git scenarios and 12 Host
fixture/driver tests. Targeted Excludes 36/36, scope recovery 48/48 and Recheck
35/35 passed. Lint, performance and the actual 75-entry VSIX privacy inspection
also passed; version remains 0.8.11. The revised persistence assertions and
controlled directory-callback replay also pass locally. Windows confirmation
remains required. The extended Host scenario uses the same saved-request Save
and Apply entry as the public panel and checks the lower-level primitive's
affected-review guard separately; its refusal of unowned concurrent events is
preserved.

The `52e899c` checkpoint passed all eight Verification jobs, including the three
real Hosts, both Quality/performance jobs, installed RC, downgrade and package.
The following notification-loss slice adds seven deterministic cases: owned or
foreign silent publication, publication after partial feedback, and a late API
response after observed publication and withdrawal. The exact final head's
checks and review are recorded in the PR; the earlier green head does not
replace them.
