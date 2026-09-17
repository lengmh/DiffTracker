# Stage 5: cross-platform verification and release gate

Date: 2026-09-15. Branch: `fix/difftracker-060-review-safety`. Review baseline:
`5482c154f86e35fe4551f8a27de2cd30c97d0c97`.

Stage 5 adds repeatable Linux and Windows gates around the production logic from
stages 0–4. The real-host suite uses a disposable Git workspace with Chinese and
space characters in its path; it never changes the implementation repository.

## Automated release gate

GitHub Actions run
[`34967344415`](https://github.com/lengmh/DiffTracker/actions/runs/34967344415)
passed for remote commit `00e024ce9f4fe0cdf91b18522de9139a02d49d6e`:

| Job | Platform / runtime | Result |
| --- | --- | --- |
| Quality | `ubuntu-latest`, Node 22 | PASS: install, lint, 166 tests, performance |
| Quality | `windows-latest`, Node 22 | PASS: install, lint, 166 tests, performance |
| VS Code Stable Host | Ubuntu, VS Code 1.137.0 under Xvfb | PASS |
| VS Code Stable Host | Windows, VS Code 1.137.0 | PASS |
| VSIX package | Ubuntu | PASS: production audit, package, artifact upload |

The Host suite exercises actual extension activation, VS Code commands,
`WorkspaceEdit`, save, editor Undo/Redo, file watchers, built-in `vscode.git` API,
and filesystem I/O. It covers whole-file and hunk Revert/Undo/Redo, CRLF content,
empty-file creation recovery, baseline-file deletion recovery, batch recovery,
20 external file updates without opening 20 editors, branch-change pause, blocked
write, and explicit repository archive/rebuild.

## Local evidence

Linux local runtime:

| Command | Result |
| --- | --- |
| `npm ci` | exit 0 |
| `npm run lint` | exit 0; type-aware promise rules enabled |
| `npm test` | exit 0; 166/166 |
| `npm run test:stage2-probes` | exit 0; 4/4 safety probes |
| `npm run test:performance` | exit 0; 1,100 files, 3,286,798 source bytes, 3,352,791 snapshot bytes, 74.7 ms scan, 1.4 ms update, +16.6 MiB RSS |
| `npm audit --omit=dev --audit-level=high` | exit 0; 0 vulnerabilities |
| `npm audit --audit-level=high` | exit 0; 0 vulnerabilities |
| `git diff --check` | exit 0 |

The 166-test total is 8 Webview mapping, 5 similarity pairing, 6 path display,
114 tracker, 20 UI contract, 8 Git adapter, and 5 real temporary Git repository
tests. The tracker, UI, Git adapter, path, and Webview suites execute production
modules with only their VS Code boundary mocked; the five repository tests use real
Git commands in temporary repositories.

`npm run test:legacy-manual-policy` is retained as a non-gating diagnostic. Its two
assertions expect an unclassified save to be auto-accepted; both intentionally fail
under the safer documented policy that source uncertainty remains pending.

## Minimum-matrix disposition

| Area | Automated evidence | Remaining boundary |
| --- | --- | --- |
| Paths | Windows drive, UNC parsing, Chinese/space, duplicate names, multi-root, POSIX case, virtual URI routing | Real UNC share I/O: NOT RUN |
| Bytes/text | LF, real-host CRLF, empty, EOF/mixed-EOL logic, invalid UTF-8/binary/size/BOM refusal | BOM write is intentionally unsupported |
| File lifecycle | create, empty, delete, recreate, accepted deletion, directory event, rename as delete+create | Real network filesystem rename: NOT RUN |
| Errors | read/stat/write/save/apply failures, disappearance, dirty conflict, partial batch | OS-level Windows lock and ACL denial: NOT RUN |
| Hunks | ordered/interleaved insert/delete, stale text/IDs, duplicate requests | None known in supported text model |
| Source/buffer | automation sessions, uncertain saves, suppression windows, dirty/disk divergence, native Undo/Redo | Real formatter/autosave extension combinations: NOT RUN |
| Lifecycle | overlapping scan/start/stop/reset/dispose, stale callbacks, Webview close, corruption, migration, partial recovery | Forced process kill between queueing and durable write: NOT RUN and not promised |
| Git | branches, failed checkout, detached HEAD, worktree, multi-repo, conflicts, pull, restore, unavailable Git | Real rebase conflict event and multi-window shared storage: NOT RUN |
| Experience | existing views/UI contracts plus 20-file no-tab Host assertion | Manual visual review of every theme: NOT RUN |
| Performance | synthetic 1,100-file workspace measured on Linux and both CI OSes | No storage architecture claim beyond measured workload |

## Release decision and limits

No known P0 correctness issue remains within the documented local UTF-8 workspace
scope. Unsupported or unverified resources are blocked from writeback instead of
being decoded, followed, or overwritten. The persistence rename is only as atomic
as the active filesystem provider, and changes that never reach the durable queue
before a process is killed are not guaranteed. Multi-window shared storage is not
supported. Git context is a write-safety signal, not an authorship detector.

The Marketplace package keeps publisher `lengmh`, extension name `code-diff-tracker`,
MIT license and upstream attribution. It must not be enabled together with
`TinyTigerPan.diff-tracker` or the earlier local-test identity `lengmh.diff-tracker`;
their storage is separate and sessions do not migrate.
