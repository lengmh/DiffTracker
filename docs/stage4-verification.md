# Stage 4 Git-context verification

Date: 2026-09-15. Branch: `fix/difftracker-060-review-safety`.

Stage 4 adds a conservative safety boundary around the existing review model. It
uses the public `vscode.git` API v1 (`repositories`, repository `rootUri`/`kind`,
`state.HEAD`, `rebaseCommit`, `mergeChanges`, and repository lifecycle events).
It does not invoke Git commands in production and does not inspect private Git
extension objects.

## Behavior

- The baseline session persists repository/worktree root, kind, named ref or
  detached commit, and conflict state in the existing V2 session file.
- A named-branch change, named/detached transition, detached commit movement,
  merge/rebase state, newly appearing repository, or removed repository preserves
  the review and pauses Keep/Revert only for paths under that repository.
- Ordinary commits and fast-forward movement on the same named branch update the
  context marker without accepting, reverting, or clearing file changes.
- Closing the warning keeps the review paused. `Archive and Rebuild Paused Git
  Baseline` is an explicit recovery action. It refuses dirty editors and unstable
  Git state, keeps one archived session, and replaces only the selected repository
  baseline; pending changes in other repositories remain.
- If the built-in Git extension is missing, disabled, or cannot activate, ordinary
  review continues and a warning states that Git-context detection is unavailable.

## Evidence

| Scenario | Evidence | Result |
| --- | --- | --- |
| Same branch commit / `pull --ff-only` | Production comparator plus real temporary remote, seed, and clone | PASS |
| Same commit, different branch | Production comparator plus real temporary repo | PASS: incompatible |
| Failed checkout | Real temporary repo | PASS: identity unchanged |
| Detached HEAD | Production comparator plus real temporary repo | PASS: named/detached transition blocked |
| Worktree | Public-API snapshot test plus real linked worktree | PASS: root/kind identity retained |
| Merge conflict / abort | Production comparator plus real temporary repo | PASS: conflict blocked; abort stable |
| Rebase conflict | Production comparator state boundary | PASS; real rebase conflict NOT RUN |
| Multiple repositories | Production tracker test | PASS: only affected repository paused/rebuilt |
| Persisted identity and restart branch change | Production tracker persistence/restore test | PASS |
| Git extension unavailable | Production adapter activation test | PASS: no throw, empty contexts |
| `git restore` with unchanged HEAD | Real temporary repo | PASS: context unchanged; file remains for watcher review |
| Stage/status/fetch | Context policy and same-branch comparison | Does not clear/pause by itself; real Host event sequence NOT RUN |

Commands on Linux (Node 24, Git available):

- `npm run test:git-context`: 8/8 adapter tests passed with only the VS Code Git
  extension boundary mocked.
- `npm run test:git-repositories`: 5/5 real temporary Git-repository scenarios
  passed. No command touched the implementation repository.
- `npm run test:tracker-safety`: 114/114 production tracker regressions passed,
  including seven Git persistence/gating/rebuild cases.
- `npm run test:review-ui`: 20/20 production UI contract cases passed.

## Limits

Git context is a safety signal, not authorship detection. Path restore and
`git reset --hard HEAD` can change files without changing HEAD; existing file
watchers retain those as pending changes, but Diff Tracker does not claim to name
their source. Same-branch non-fast-forward movement is likewise not inferred as a
specific Git operation. No automatic reset is provided. Cross-platform Stable Host
results and the remaining manual-only boundaries are recorded in
`stage5-verification.md`.
