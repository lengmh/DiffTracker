# Round 21: durable stopped clear and deleted-file split routing

Input PR HEAD: `b53a9b33553ed4c83ee23187bd2cb9bee31c20f3`.
Both P2 findings are in the review body, rather than inline threads:
https://github.com/lengmh/DiffTracker/pull/1#pullrequestreview-5222598361

## Changes

Clear Diffs while stopped now commits an explicit empty stopped session using
the existing baseline transaction and durable persistence writer. It removes
snapshots, existence/unknown entries, modes, Git baseline context and Undo
history, then clears review UI only after persistence succeeds. Workspace files
and dirty buffers are untouched. Reload preserves the stopped empty session;
it does not treat the cleared session as absent and auto-start recording.

Reset runs through the recovery action queue. Persistence failures roll memory
back; Stop, restart and disposal invalidate the transaction before storing their
own state. Incomplete-write markers retain existing recovery protection. The
command reports success only on a completed reset. While recording, Clear Diffs
continues to establish the current workspace baseline. While stopped, it discards
the stored baseline/history and remains stopped; it does not scan a new baseline.

Deleted files route to Webview before opening a filesystem document in both the
default split route and the direct split command. Current tracker state takes
precedence over stale tree-item flags. Existing-file split behavior is unchanged.

## Verification

- Before repair, the stopped-clear regression retained the old snapshot; the
  production split callback threw FileNotFound. Both regressions now pass.
- Full `npm test`: 383/383 (310 tracker, 28 UI and 45 other cases), including 17
  new regressions. Compile, lint and `git diff --check` pass.
- New tracker cases cover empty/deleted/unknown files, dirty buffers, durable
  reload, write/rename/copy failure, blocked recovery and Stop/restart/disposal
  during a held write. Tests use production logic and real temporary files with
  mocked VS Code boundaries. UI tests extract and execute the production command
  callbacks unchanged, with command/renderer boundaries mocked.
- Native Host assertions cover deleted-file direct split, the stopped Clear Diffs
  command, and production tracker disposal/reload after clear. The latter is an
  in-process tracker reload in a real Host, not a VS Code process crash test.
  Host tests are not run locally; exact-commit CI results are recorded in PR #1
  after push, including Windows Stable, Ubuntu Stable, VS Code 1.80 and packaging.
- Initial CI `35098691466` failed the new Host tab assertion: the test queried
  the tab model immediately after panel creation, before the workbench event
  reached the extension host. The follow-up waits for the tab model to report
  the Webview before asserting and closing it. The command executes once;
  panel-presence and missing-file assertions remain required. Final CI verifies
  this correction; the initial run is not counted as passing.
- The implementer inspected the persistence writer, rollback identity checks,
  session invalidation, command routing and messages a second time. This is not
  independent reviewer approval; no code-review skill is installed here.

The PR remains unmerged; no Marketplace publication in this repair round.
