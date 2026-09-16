# Review of 2ff9d01c: deletion and initial watcher coverage

New-file Revert now returns an explicit conflict without dispatching file deletion.
The user must inspect/delete the file manually; the existing watcher then clears
the pending review. Batch Revert retains that item and continues with existing
files. This intentionally extends the previous conservative Undo deletion rule.
Production workspace code now contains no WorkspaceEdit.deleteFile calls; the
remaining workspace.fs.delete helper only deletes extension session metadata.

Fresh Start registers and activates watchers synchronously before capturing open
documents or beginning the asynchronous ignore discovery/workspace scan. Failure
to register watchers leaves the baseline Building. Epoch checks and disposal
prevent a stopped startup from later publishing Ready or reactivating watchers.

Verification:
- Four added production regressions: startup change during ignore discovery,
  watcher creation failure, Stop during startup, and mixed batch Revert.
- Existing new-file tests now assert conflict, unchanged contents, no dispatched
  edit, and review clearance after manual deletion. Historical recovery records
  remain covered using the production recovery-record creation methods.
- Real Host scenarios assert empty/nonempty new-file conflicts, preservation of
  later content, and manual deletion notifications.
- Local npm test: 211/211, including 158 tracker cases; lint and probes 4/4 pass.
- Host/packaging CI results are recorded on the PR for the exact published SHA.

Manual patch inspection covered initial Start, reset/rebuild watcher handoffs,
Stop/epoch handling, both destructive paths, and batch partial success. No
code-review skill is installed; independent Codex PR review remains pending.
