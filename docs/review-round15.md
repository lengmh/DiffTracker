# Review round 15: baseline transactions, recovery history, modes and Git startup

Baseline: `4dc1394c64a3e64caa3e3ac5277f89bcde2f8d2c`.

## Findings addressed

- 4023694592: Keep rollback on Stop/deactivation/session replacement, for files and blocks.
- 4023781706: partial repository rebuilds reaching primary/backup through background persistence.
- 4023694603: obsolete recovery history preventing access to older valid Undo records.
- 4023694609: fixed 0600 staging permissions losing executable/read permissions.
- 4023781717: late Git initialization unnecessarily pausing a fresh recording.

## Behavior

Keep and repository rebuild use an explicit baseline transaction. Background timers do not persist tentative state, and explicit flushes wait until the transaction finishes. Epoch transitions synchronously roll back the transaction before resetting or persisting session state. Candidate persistence checks transaction ownership before dispatch and after asynchronous writes, retaining an incomplete-write marker for interrupted writes. Failed rebuilds flush the restored baseline. Rebuild joins the same action queue as Keep/Revert/Undo.

Keep removes recovery items for the accepted path within that transaction. Other batch members and older records remain; rollback restores the old history. Successful durable Keep followed by a session switch reports saved, while a switch during the transaction reports failure after rollback.

Snapshots and recovery file states now carry ordinary POSIX mode bits (000–777), validated during parsing. Initial scan, open-document capture, Keep and repository rebuild capture them; recreation applies mode before exclusive publication. Old sessions without this optional metadata remain readable and use ordinary creation mode filtered by umask. Ownership, ACLs and special setuid/setgid/sticky bits are outside this feature; no historical permission inference is claimed.

Fresh Start waits for an available Git API's readiness before snapshot capture, then records its current identity. Stop cancels a pending Start and monitor disposal releases waiters without starting recording. Restored sessions retain reconciliation and Git-change pause behavior. Git-unavailable environments retain their existing degraded mode.

## Verification

- Full local suite 279/279; tracker 214/214; Git adapter/activation 17/17; compile, lint and conservative probes 4/4 pass.
- Eighteen added tracker cases cover file/block Stop/dispose/restart during Keep, success/failure history pruning, preserved batch members, long rebuild interruption and restart, POSIX 0644/0755 restoration through both creation paths, and malformed/legacy mode metadata.
- Five Git tests cover delayed readiness, disposal, and extracted unchanged production activation functions for fresh/restored/stopped startup.
- Host fixture now starts with an executable deleted-file target on POSIX and asserts its mode after Revert. Windows does not assert POSIX mode semantics. CI is a separate gate.
- Production logic runs with controlled VS Code boundaries; temporary filesystem operations are real. Actual SSH/container startup delays and arbitrary filesystem ACL behavior were not tested.

Manual follow-up inspected both Keep methods, baseline writer/queue, epoch transitions, rebuild rollback, parser compatibility, both file creation callers, and startup cancellation. The code-review skill is unavailable; fresh independent review remains pending.
