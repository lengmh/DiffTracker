# Round 20: private parent creation and bounded staging exclusions

Input PR HEAD: `ec34fdec4c757dde8ad053a7d7f447ab0fafcba9`.
Review comments:
- https://github.com/lengmh/DiffTracker/pull/1#discussion_r4025596053
- https://github.com/lengmh/DiffTracker/pull/1#discussion_r4025596060

## Changes

Missing parent directories are created with mode 0700, subject to umask, instead
of the default 0777. Existing directories are not chmodded. This conservative
fallback avoids broadening access when original directory modes are unavailable;
it does not reconstruct original directory permissions or ACLs. Shared access
may need explicit reconfiguration. File permission restoration is unchanged.
Both READMEs now distinguish file modes from this directory policy.

Staging roots stay excluded throughout an active recovery. Cleanup starts a
five-second grace timer for delayed watcher events, after which the root and timer
are removed. Timers survive recording resets so an old operation's events do not
pollute a new baseline; they expire normally. Disposal clears both collections,
and late allocation/cleanup cannot resurrect them. Unexpected staging children
are preserved rather than recursively deleted, but do not stay permanently hidden.

Ignore checks now walk path ancestors with Set lookups rather than scanning all
retained roots. Keys preserve Windows case-insensitive matching. Thus lookup cost
depends on path depth, while retained roots are limited to active operations and
the recent grace interval rather than the lifetime recovery count. The grace
interval does not claim to cover arbitrarily delayed provider notifications.

## Verification

- Before repair, all five primary regression cases failed: private-parent modes
  for file/batch/Undo and exclusion expiry with/without recording restart.
- 12 new production regressions pass. Coverage also includes unchanged existing
  parent modes, active operations longer than the grace interval, success/failure,
  restart/dispose, unexpected children, Windows path casing, and disposal while
  asynchronous staging allocation is outstanding.
- Full `npm test`: 366/366 (301 tracker plus 65 other cases); `npm run lint` and
  `git diff --check`: exit 0.
- New local cases use production methods and real temporary files with mocked
  VS Code boundaries. POSIX mode assertions are skipped on Windows. Expiry cases
  shorten the production grace duration without replacing the timer/cleanup logic.
- Native Host parent-recovery scenarios now assert 0700 on both recreated parent
  levels on POSIX. Host tests were not run locally; exact-commit CI results are
  recorded in PR #1 after push, including Windows, Ubuntu Stable, VS Code 1.80
  and VSIX packaging.
- The implementer reread active/finally/dispose paths, session handoff, permission
  scope and Windows matching. This is not a separate reviewer approval; the
  code-review skill is not installed in this environment.
- Initial CI `35094889528` passed Ubuntu quality and both Ubuntu Host versions,
  but Windows quality failed three expiry assertions. The exclusions had expired;
  the mock workspace lookup used a case-sensitive string prefix and incorrectly
  rejected normalized Windows paths as outside the workspace. The mock now uses
  native path-relative membership, and the real Windows Host explicitly checks
  equivalent-case URI lookup. The expiry assertions remain intact. Final CI is
  run on the follow-up commit; this failed run is not counted as passing.

The PR remains unmerged; no Marketplace publication in this round.
