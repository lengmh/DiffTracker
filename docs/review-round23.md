# Round 23: register scan uncertainty before asynchronous classification

Input HEAD: `440d29856598fdfe0dd262772a6fbc99ae9e308a`.
Finding: PR #1 review comment 4027324959 (P1).

Create and change callbacks now synchronously mark unknown scan-time paths before
awaiting directory classification. The event retains its scan-time identity even
if the baseline completes while stat is pending. Baseline workers and editor opens
observe the marker and cannot accept the changed bytes. Directory markers protect
children without creating phantom file reviews. Known snapshots and ignored paths
keep their existing behavior; epoch checks reject late callbacks after restart.

## Verification

- Full `npm test`: 412/412, including 339 tracker regressions (14 new).
- Compile, lint and `git diff --check` pass.
- Four primary tests hold the event stat while the real baseline worker completes:
  create/change, each for enumerated and unlisted paths. All four fail against the
  input source and pass after repair, including persistence and reload assertions.
- Additional cases cover directory descendants, editor opens during stat, session
  restart, existing baselines and ignored paths for both callbacks.
- Boundaries are mocked VS Code APIs with real temporary files; no new native Host
  assertions were added for this deterministic interleaving. Existing Host suites
  and Windows checks run in CI after push.
- Implementer second-pass inspection covered scan publication, editor capture,
  directory handling, durable unresolved entries and epoch cancellation. The shared
  marker helper avoids duplicating the synchronous registration policy. This is
  not an independent reviewer approval.

PR remains unmerged. Marketplace is not published.
