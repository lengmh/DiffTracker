# Review round 14: Keep transactions and exclusive creation

Baseline: `5220acd2dde5c2fd50622933fb9305bcb7b4610b`.

Review comments:
- https://github.com/lengmh/DiffTracker/pull/1#discussion_r4023424983
- https://github.com/lengmh/DiffTracker/pull/1#discussion_r4023424989

File and block Keep now enter the shared action queue before per-file verification. This serializes Keep transactions across files and with Revert/Undo. Tokens are verified when dequeued; failure rollback completes before another queued action starts. Existing persistence failures still block actions until persistence recovers.

Deleted-file Revert and Undo share exclusive creation: write complete UTF-8 bytes in a temporary directory alongside the target, then publish with a native hard link. Link creation fails if a file or symlink already occupies the target. No destination write follows publication. Unsupported filesystems return conflict without an overwrite fallback. Temporary paths are excluded from tracking, including delayed watcher events; cleanup removes only the known payload and an empty staging directory. The destination is never deleted during cleanup. Synchronous cleanup avoids an await after the final context validation.

Eight added regressions cover all four file/block Keep combinations, failure rollback and subsequent successful persistence/reload, and ordinary-file/symlink competitors in both creation actions. Existing creation failure and Git-pause tests now intercept the native publication boundary; production logic is not mocked. The injected Git pause while link I/O is already dispatched still reports conflict and retains recovery after publication, as cancellation of dispatched I/O cannot be guaranteed.

Local verification: tracker 196/196, full suite 256/256, compile, lint and probes 4/4 pass. Native staging/link operations run against real temporary files; VS Code boundary and link dispatch timing are controlled by the harness. Host CI is a separate gate. Both READMEs document hard-link support requirements. No claim is made of arbitrary network/virtual filesystem support.

Manual follow-up inspected block Keep, Keep All routing, queue rejection handling, failure rollback, both creation call sites and staged-file cleanup. The unavailable code-review skill could not be run; independent review remains pending.
