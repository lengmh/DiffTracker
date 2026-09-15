# Stage 2: reviewed versions and asynchronous correctness

Development work only. This report extends `engineering-audit.md`; it does not
replace the stage 0–1 evidence or claim stages 3–5 were implemented.

## Verified input

- Existing PR: https://github.com/lengmh/DiffTracker/pull/1 (open at start).
- Branch: `fix/difftracker-060-review-safety`.
- Stage 2 base: `0605f993db2ac7d5cc16388041009908bf6d2985`.
- Main remains `5482c154f86e35fe4551f8a27de2cd30c97d0c97`.
- The starting worktree was clean. The previous local API-publication counterparts
  were retained on `archive/stage01-local-commits`; this work starts from the real
  remote history and does not reapply the stage 0–1 patch.
- `node test/known-p0.mjs` on the starting compiled source returned exit 1:
  the four original assertions failed, matching the earlier reproduction.

## Automation-only: safety policy and original test assumption

An ordinary VS Code document-change event or `TextDocument.save()` does not prove
that a human authored the edit. Untagged extensions, formatters and save
participants can produce the same events. The original 200/2000 ms probes label
one edit “manual” but do not supply a reliable author signal.

Stage 2 therefore uses the execution prompt's explicit conservative fallback:
preserve the accepted baseline and retain unclassified editor changes together
with external changes for review. A save by itself must not absorb unreviewed
changes into the baseline. The explicit automation session API remains supported;
no exact Codex/human author detector is claimed.

The original probes' external-write visibility requirement remains mandatory at
both delays. Their additional expectation that the baseline automatically advance
from `A=old` to `A=manual` is not promised for an ambiguous event. Preserve that
original expectation as a separate diagnostic; do not silently remove an assertion
and report the original four as unconditionally passing.

This is an intentional behavior tradeoff: automation-only can display more
changes of uncertain origin, rather than lose external edits or auto-accept them.
Users can explicitly review and Keep those changes.

## Evidence and release boundary

Production-method tests with mocked VS Code/DOM boundaries are not real Extension
Host tests. Windows file locking/UNC/editor behavior, actual Ctrl+Z/Redo,
autosave/formatter extension combinations and process-crash/reload require separate
host verification. No multi-window/shared-storage safety guarantee is made.

The V1 persistence queue/format is retained. Durable atomic state writes,
corruption recovery, partial-snapshot schema migration and reliable shutdown flush
remain stage 3. Git branch/HEAD/worktree context coordination remains stage 4.
General performance/UI/OS release qualification remains stage 5.

## Implemented and reviewed

- DT-04: map insertion hunks through existing diff segments; bind block IDs and
  review tokens to resource, baseline/current content and existence, and session
  epoch. File, block and batch actions validate again after asynchronous reads.
  Stale requests refresh the pending diff and require a new review.
- Same-file actions are serialized. Tree, CodeLens and Webview carry rendered
  tokens; batch confirmation retains its reviewed snapshot. Webview deduplicates
  requests, retains busy state through refreshes, and isolates late replies from
  switched/disposed views. A detached annotation retains its original token.
- DT-05: remove blanket post-save suppression and automatic source inference.
  Unknown-source edits stay pending with an informational notice; explicit
  automation sessions and explicit Keep/Revert remain available.
- DT-08: epoch guards protect scan, restore, watcher, read and save continuations
  across start/stop/reset/dispose. Scan-time creations with unknown before-images
  remain unavailable; failed scans do not become Ready. Parent directory deletion
  expands to tracked descendants. Workspace root changes pause actions until a
  new baseline is explicitly established. Ready denotes scan completion, not that
  every file was readable; unavailable entries remain blocked.
- Independent review found and verified fixes for late restore clearing a new
  session, clean-but-stale editor contents, old save failure/cleanup altering new
  guards, and stale requests failing to refresh. Existing diff algorithm, Webview,
  V1 persistence, existence Map/Set and automation API are reused.

## Final verification (Linux, Node 24.19.0)

| Command | Result | Evidence boundary |
| --- | --- | --- |
| `npm test` (includes TypeScript compile and Webview build) | 129/129, exit 0 | 90 production tracker, 20 production UI, 6 production path cases; 13 older standalone mapping/similarity cases are supplementary, not production coverage |
| `npm run test:stage2-probes` | 4/4, exit 0 | Conservative safety probes; also covered by the normal tracker entry |
| `npm run test:legacy-manual-policy` | 0/2, exit 1, expected diagnostic failure | Original automatic manual-baseline attribution assertions retained; policy distinction explained above |
| `npm run lint` | exit 2 | Existing repository has no ESLint configuration; lint is not passed |
| `git diff --check` | exit 0 | Whitespace validation |

The first full run exposed an outdated path-test panel fixture; it was corrected
to initialize the new view state without weakening production checks, then the
full suite was rerun. New tests invoke production methods with simulated VS Code,
filesystem timing, renderer or DOM boundaries. They include 30 insertion action
permutations, stale file/block/batch requests, queued duplicates, mixed failures,
save/read races, scan/lifecycle changes and late UI replies. They are **not** real
Extension Host tests, even where events simulate Undo/Redo or atomic replacement.

## Remaining P0 / release blockers

- DT-04/05/08 reproduced safety paths now pass at the simulated boundary. The two
  old authorship expectations remain unmet by design; no accurate human/Codex
  classifier is claimed. Actual host integration remains unverified.
- DT-06 data-loss risks remain: interrupted/corrupt state writes, last-good
  recovery, partial scan persistence and reliable shutdown durability (stage 3).
- DT-07 remains: Git HEAD/branch/worktree context is not coordinated (stage 4).
- DT-09 real Undo/Redo restoration of buffer, disk, existence and review state,
  especially after create/delete and batch operations, remains unverified.
- An arbitrary external process can write during VS Code `applyEdit`/`save`.
  Per-file queues and pre/post checks do not supply an OS transaction or CAS.
  Windows/UNC/locking, true Extension Host, crash/reload, cross-window, real
  formatter/autosave combinations and release qualification were NOT RUN.

Deliver as `0.6.2` development prerelease only. Stages 3–5 are not implemented;
the existing PR is updated without changing main or merging.
