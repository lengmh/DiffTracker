# PR12 watcher-case closure — 2026-09-27

## Starting point and scope

Starting PR head: `ed6c92cab48e47fad8f929225e664df5b331a3c2` (Verification #464 green).
Review comments: P1 `4115529159`, P2 `4115529161`.
This batch concerns watcher-exclusion coverage proof only. It does not add S4-B
watchers, change persisted-state limits, redefine scope membership, or modify
runtime imported-directory publication.

## Common cause and repair

Coverage is a proof that **every** watcher-hidden resource is already outside the
configured scope. A string case conversion is not that proof.

P1: wildcard patterns are considered identical only when their normalized syntax
is exactly equal. Unicode lowercasing is removed, and ASCII-only folding is not
substituted: a wildcard can select a case-sensitive child under an insensitive
root. Non-identical patterns with a concrete literal prefix still use the existing
`configuredScopeExplicitlyExcludesSubtree` / `evaluateConfiguredScope` filesystem
proof. Exact Unicode patterns, universal exclusions, folder scoping, and the
prefix-file versus descendant distinction are retained.

P2: hard-boundary classification now receives root identity. Exact canonical
`.git` and restore-directory prefixes remain immediate lexical proofs. For an
ASCII case variant beneath a concrete parent, the classifier verifies the actual
path identity, or probes case semantics inside that exact existing parent for a
missing name / restore-prefix glob. Unknown identity, ambiguous lookup and
unreadable parents do not authorize a coverage exemption. A restore-prefixed leaf
without descendants can still be an ordinary file.

Rules-mode explicit includes and Whole Workspace use the same hard-boundary
filter before direct-path, ancestor and descendant intersection checks. Concrete
parent case probes reuse the existing bounded, metadata-validated exclusion-case
cache rather than reopening the same parent for every coverage check. A counting
regression reproduced 32 opens for 32 identical checks before this cost repair;
the repaired path performs at most one probe and still validates parent metadata.

## Necessary qualification of P2

The review's suggested blanket exemption of `**/.GIT/**` using only an insensitive
**root** flag is unsafe under the existing per-directory identity contract.
A deterministic filesystem-only fixture proves this counterexample:

- the root advertises insensitive semantics;
- a sensitive child has a real `.GIT/live.txt`, while `.git` is a missing distinct spelling;
- `evaluateConfiguredScope` correctly reports the file as monitored;
- globally folding the wildcard pattern would incorrectly declare its hidden events covered.

The repair therefore recognizes verifiable patterns such as `.GIT/**` and
`literal-parent/.GIT/**`, but keeps case-variant patterns with wildcard parents as
supplemental-coverage obligations. No recursive scan or speculative wildcard
witness is used, and the declared scope is not silently narrowed to make the proof
succeed. This is a safety qualification of the requested P2 change, not a claim
that all differently-cased wildcard patterns are equivalent.

## Regression matrix

Ten `PR12 CASE` scenarios cover:

1. U+0130 versus `i` + U+0307: distinct filesystem names despite equal JS lowercase keys; public Apply refuses uncovered scope.
2. Wildcard ASCII aliases under an insensitive root with a sensitive child.
3. Real filesystem alias proof for a concrete exclusion prefix.
4. Exact Unicode identity, universal exclusions, folder scope and directory-only rules.
5. Reserved watcher patterns with sensitive lookup.
6. Reserved watcher patterns with insensitive lookup.
7. Concrete child aliases and distinct child spellings independently of root case mode.
8. The wildcard-parent P2 counterexample.
9. Shared Rules / Whole Workspace hard-boundary classification, including ordinary restore-prefixed files.
10. Unknown identity and the existing brace-expansion bound.

The fixtures change only filesystem lookup surfaces; the production scope and
coverage algorithms are exercised unchanged. The final matrix has **5 failures
on the original source and 10/10 passes on the repair**. It also rejects an
intermediate root-flag-only repair with the mixed-directory counterexample.

## Verification and publication

Compile, lint, targeted red/green regressions and the performance smoke test were
executed before updating the PR. Full regression results and exact-head CI/review
status are recorded in the associated PR checkpoint comment; do not infer a clean
review from compilation, fixture success or GitHub mergeability alone.

The temporary `assist/s4a-case-closure-20260927-runner` workflow is an execution
helper only and is not part of the PR source commit.
