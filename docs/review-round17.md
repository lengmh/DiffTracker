# Round 17: restore files after parent-directory deletion

Input PR HEAD: `e8d7b37a268fe47eecfb028b356c7b54536725cd`.
Review comment: https://github.com/lengmh/DiffTracker/pull/1#discussion_r4024807602

The missing-file restoration helper previously called `mkdtemp` beneath the
destination parent even when that parent had been deleted. File and batch Revert
therefore returned ENOENT; Undo's shared recreation path had the same limitation.

The helper now validates the action target and session, discovers missing parent
directories, and creates them one level at a time before staging. Each level is
checked without an intervening await. Existing files and symlinks are never
replaced or followed; EEXIST is accepted only for an ordinary directory. Session
and target checks run again after asynchronous staging. File publication still
uses an exclusive hard link and never overwrites the destination.

Parents use normal mkdir permissions subject to umask; original directory modes
are not stored and are not claimed to be recovered. On failure, any newly created
empty parents are retained rather than recursively removed, since another writer
may already be using them. Existing arbitrary external-writer TOCTOU limitations
remain; this is not an OS-level directory-handle transaction.

## Verification

- Before repair: file, batch and Undo restoration assertions all failed with
  ENOENT; the two existing-parent obstruction assertions passed.
- After repair: 8/8 new regressions passed (real temporary filesystem and
  production tracker, mocked VS Code boundary). Coverage includes nested parent
  recreation, both batch children, Undo, file/link obstruction, stop during mkdir,
  permission denial and a parent changed to a symlink during mkdir.
- Full `npm test`: 321/321; `npm run lint`: exit 0; `git diff --check`: exit 0.
- Added native Extension Host assertions for file and batch Revert after deleting
  the entire multi-level parent hierarchy. Fixtures are created before host startup.
  Exact-commit Windows/Ubuntu/VS Code 1.80 results are recorded in PR #1 after CI.
- The implementer performed a second read-through of creation, failure cleanup,
  session validation and shared callers. This is not a separate reviewer approval.

The branch remains an unmerged review build. No Marketplace publication occurs
in this round.
