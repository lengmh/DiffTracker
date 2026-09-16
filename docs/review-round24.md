# Round 24: pause restored actions until Git reconciliation

Input HEAD: `d2c737f1292d766b0f67797d29686110be0378f2`.
Finding: PR #1 review comment 4027566189 (P1).

Activation sets a transient tracker-wide Git pending gate before loading persisted
state or registering commands. An available but uninitialized Git API leaves this
gate in place. Both immediate and delayed readiness reconcile restored contexts
before releasing it. Repository-specific pauses remain after incompatible branch,
worktree, missing-repository or newly discovered repository comparisons.

The gate covers file/block Keep and Revert, batches and Undo via tracker validation.
Batch Revert rejects before preparing recovery history; pending Git cannot evict an
older Undo record. Baseline clear/reset and repository rebuild also reject while
pending. Stop does not release the gate, and a disposed tracker ignores late gate
updates. No transient gate is persisted: each activation establishes a fresh one.
Unavailable/disabled Git preserves the existing explicit degraded-mode behavior
and warning; it is distinct from an available API still initializing.

## Verification

- Full `npm test`: 432/432, including 353 tracker regressions and 23 Git adapter
  cases. Twenty cases added: 14 tracker and six production activation checks.
- Compile, lint and `git diff --check` pass.
- Eight action/recovery cases fail against the input source and pass with the fix.
  They restore real persisted sessions and check disk, baseline, recovery history,
  edit/save counts, and retained reviews. VS Code API boundaries are mocked.
- Production activation statements and ready handler are executed in a VM, checking
  the gate during restore and monitor startup, delayed/immediate/unavailable Git,
  recovered/incomplete/stopped sessions, and reconciliation-before-release order.
- Native Host audit adds a restored Keep/Revert pause and successful Keep after
  reconciliation. It uses the production tracker and real VS Code filesystem and
  document APIs; Git pending state is explicitly set rather than delaying vscode.git.
  Exact-commit Windows/Ubuntu/1.80 Host CI is checked after push.
- Implementer second-pass inspection covered activation ordering, all shared action
  guards, batch history preparation, reset/rebuild, Stop/dispose and release order.
  Existing per-repository pause logic is retained. No independent approval claimed.

PR remains unmerged. Marketplace is not published.
