# Review of de048552: unfinished Git operations

Production repository snapshots now supplement vscode.git conflict/rebase fields
with operation markers from the worktree-specific Git directory. A `.git` directory
is used directly; a gitfile is resolved relative to its containing worktree. The
shared `commondir` is not used for these markers. Invalid/unavailable metadata is
treated as unsafe instead of silently enabling review.

Markers cover MERGE_HEAD, both rebase directories, CHERRY_PICK_HEAD, REVERT_HEAD,
and sequencer. Normal staged changes alone do not pause review. Completion/abort
removes the operation condition; existing tracker policy still requires explicit
baseline reconciliation after a recorded Git safety pause.

Git format reference: https://git-scm.com/docs/gitrepository-layout

The real Git scenario tests now call production snapshotGitRepository instead of
computing inProgress themselves. Before the fix, 4/9 passed; after it, 9/9 pass.
Four new scenarios cover clean --no-ff --no-commit merges in ordinary and linked
worktrees, each ending in commit or abort, and check worktree isolation.
Three additional adapter tests cover event-driven observation with no conflicts,
relative gitfiles and adjacent operation markers, and invalid/missing metadata.

Local npm test: 218/218; lint and safety probes 4/4 pass. The real Git commands use
temporary repositories; adapter event tests fake only the VS Code API boundary.
Host CI and package results are reported on the PR for the exact commit. Manual
inspection checked path resolution, read failure behavior and monitor call sites;
independent Codex PR review remains pending.

This remains a local-file implementation and uses the built-in Git API's state
events. It does not claim atomic exclusion of arbitrary external Git operations
between observations and workspace writes.
