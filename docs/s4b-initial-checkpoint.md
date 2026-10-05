# S4-B initial supplemental coverage checkpoint

## Scope

This checkpoint adds DiffTracker-owned persistent direct directory watchers for
concrete, existing `files.watcherExclude` subtrees intersecting an explicit Rules
include or Whole Workspace scope. It keeps the S4-A review-baseline, persistence,
path-identity and bounded-preparation contracts.

- Existing directory trees receive one non-recursive direct watch per directory.
- Supplemental and temporary imported-directory watchers share the existing
  256-watch total budget; their ownership remains separate.
- Installation, capacity, OS watcher-limit and runtime failures produce persisted
  subtree coverage gaps. A gap is uncertainty, not proof of no pending change.
- Failed scope preparation disposes candidate-only watches and preserves the
  previously committed scope and live watcher ownership.
- Restart reinstalls direct coverage before reconciling persisted review state.
- Scope Apply captures new baselines only. It does not retire a pre-existing
  coverage gap without checking the existing review state.
- Full-scan reconciliation only clears the exact pre-installation gap, provided
  every owned watch remains healthy and no newer failure replaced the gap.

## Explicit initial limits

Patterns without a concrete existing directory prefix, missing/file-only targets,
unverified identities and excessive pattern expansion are rejected conservatively.
A shared capacity or installation failure leaves a visible gap rather than
claiming complete observation.

New or moved-in directories create a visible persistent-coverage obligation and
continue through the existing imported-directory event path. A baseline rebuild
is required before their persistent supplemental coverage is trusted. Removing a
watcher exclusion does not erase an earlier unresolved gap. Changing overlapping
live supplemental ownership is refused conservatively; stop and rebuild to
establish the new ownership.

Automatic imported-bridge handoff, runtime subtree reconciliation/reclaim and a
broader platform/filesystem acceptance matrix remain S4-C/S4-D work. Native Review
UI and extra filesystem-provider support are outside this checkpoint.

## Verification

`npm run compile`, `npm run lint`, `npm test`, and `npm run test:performance` are the
local checks. `npm test` includes `test/s4b-supplemental-coverage.mjs` through the
production tracker regression harness. New regressions cover lifecycle failures,
stale callbacks, interrupted work, gap retention and overlapping ownership.

The existing Verification workflow supplies Ubuntu/Windows quality checks, Stable
Extension Host tests on both systems, VS Code 1.80.2 Host on Ubuntu and the released
0.7.2 downgrade guard. Host tests include direct filesystem create/change/delete
inside a watcher-excluded concrete subtree. Exact run results belong to the PR
checkpoint; this document does not claim that every planned check has passed.
