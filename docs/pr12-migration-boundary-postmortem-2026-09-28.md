# PR12 initial Rules migration and acquisition-boundary review

## Evidence and scope

Starting PR head: `83b9c862e4c22c440647b25dd54b903d78dad23d`.
Latest review: P1 `4116019157`, reviewed on that exact head.
Standard Verification #465 failed Windows Quality (851/852 tracker regressions),
not a green workflow. Its one assertion failure was the simulated sensitive
reserved-name case fixture (`.Git`). The other main jobs passed.

This repair covers scope Apply acquisition and that cross-platform regression.
It does not implement S4-B watchers, W1 ownership transfer, arbitrary line actions,
change persistence formats/limits, or publish a release. The legacy Rules
Start/restore search paths are not claimed to have been redesigned by this batch.

## Why the P1 recurred

The earlier broader-include repair selected bounded preparation by reading
human-readable expansion reasons. Those reasons existed only when the previous
scope was already configured. A first `legacyV3 -> rules` migration had no
expansion object and therefore reached a second, unbudgeted include acquisition
implementation.

The defect was not only a missing `legacyV3` condition:

- The include-only capture branch could also be reached by a repeated or
  contracting Rules Apply. Safety depended on caller routing rather than the
  actual acquisition boundary.
- That branch used recursive `readdir` arrays and lacked incremental byte/category
  accounting and the transaction-valid predicate after asynchronous reads.
- Missing literal targets were inserted as text absence snapshots without
  reserving their cost or checking explicit-exclusion precedence.
- The original fixtures exercised configured expansion, but not the complete
  source-kind x acquisition-path matrix. Compilation and many passing tests did
  not prove the first-migration route safe.

## Repair invariants

1. Every first migration reaches bounded preflight. Existing configured
   expansions use `detectScopeExpansion(...).expands`, not diagnostic text.
2. Every Apply path that acquires content is independently bounded. The old
   `enumerateExplicitIncludeFiles` implementation is removed. Include-only
   acquisition uses the existing streaming candidate enumerator with a shared
   work allowance, category/byte ledger, and explicit transaction-valid callback.
   Both capture helpers require that callback in their TypeScript signature.
3. Literal targets, including missing targets, consume preparation work. A known
   absence sentinel consumes text-category capacity and encoded bytes before
   insertion. Excluded or already-retained targets cannot borrow capacity or
   overwrite prior review evidence.
4. Directory and file reads revalidate transaction state after awaits. The first
   budget failure prevents later acquisition and flows into the existing complete
   rollback, including prior durable scope, baseline and review preservation.
5. Overlapping explicit includes share visited-directory and candidate identity
   sets, so the same subtree is not repeatedly enumerated or charged. Unknown
   Dirents use the shared lstat classifier rather than disappearing from capture.
6. Rules expansion retains the existing explicit-missing-target absence contract,
   sharing the broad acquisition budget instead of reopening an unbounded helper.
7. Stopped Apply still acquires no candidate content. Identity, pending exclusions,
   watcher coverage, consent/controller guards and durable commit/rollback remain
   in force; no guard is disabled to make an assertion pass.

## Important selection/provenance counterexample

An intermediate local repair sent every initial Rules migration through a full
workspace content scan. Existing PR11 coverage-callback tests rejected it: that
scan accepted an unrelated `candidate.txt` before its later explicit include was
applied. This intermediate source was not pushed to the PR.

Preflight breadth and permission to acquire baselines are now separate decisions:
first Rules migration is preflighted, but acquires only its explicit targets via
the bounded include path. Whole Workspace and actual configured expansion retain
their broad acquisition behavior. A Rules migration does not certify a new
workspace-wide `scanCoverage` fingerprint from include-only acquisition. Other
unverified resources therefore remain conservative rather than gaining false
absence provenance. The four original PR11 callback tests remain unchanged.

## Windows failure: incomplete simulated lookup, not a weaker expected result

The sensitive fixture denied `.git` and `.Git`, but probing the real `.GIT` entry
toggles its first ASCII letter and looks up `.gIT`. Windows could resolve that
unmodelled spelling to the existing entry; directory enumeration order selected
which witness was probed first. A root flag did not make the fixture sensitive.

The fixture now explicitly models `.gIT` and asserts the case-probe precondition
before testing coverage. Two additional tests force Git-first and probe-first
entry order over a simulated insensitive backing lookup even on Linux. The
production classifier and the sensitive `false` coverage expectation are retained.
The existing Unicode distinction and mixed-parent hard-boundary tests are kept.

## Regression and validation matrix

Fourteen `PR12 MIGRATION` cases cover:
- initial legacy, configured repeat, and configured expansion routing/work bounds;
- no unrelated baseline acceptance and no false complete-scan certification;
- incremental byte failure and durable rollback on both acquisition routes;
- Rules missing-target absence, text-category limits, excluded missing targets,
  and byte reservation before absence retention;
- concurrent transaction invalidation before later reads;
- stopped Apply, overlapping targets, and unknown Dirent classification.

The final migration matrix produces **nine failures on the original source**
(5/14 pass) and **14/14 passes on the repair**. The revised case matrix has 12
passing scenarios. Four unchanged PR11 candidate-coverage callback cases pass.
Full compile/lint/test/performance results and remote exact-head verification are
recorded in the associated checkpoint comment; the test matrix is not itself a
claim of a clean fresh review or merge readiness.

## Prevention and remaining acceptance gates

Future Apply changes must add a route to this matrix rather than introduce an
unbudgeted capture helper. Review budget accounting at acquisition, after each
await, and before the durable barrier; distinguish scope selection, physical
observation coverage and persisted absence evidence. Test both rejection and
successful preservation paths, including explicit missing files and prior review.

All reported fixes remain subject to standard PR CI on Ubuntu/Windows and the
supported Extension Hosts, followed by review on the actual final head. No finite
regression suite proves that future P1/P0 defects cannot exist. This batch supplies
specific invariants, counterexamples, and reproducible gates instead of that claim.
