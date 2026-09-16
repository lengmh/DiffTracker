# Review round 12: unsupported workspace URI schemes

Review comment: https://github.com/lengmh/DiffTracker/pull/1#discussion_r4022627060

Baseline: remote `951f26d1d90bc89750892889d54ea08286c0873d`.

## Change

Workspace discovery, watcher registration, ignore discovery and persisted roots now use the same file-scheme folder selection. Scan candidates and ignore-file results also reject non-file URIs. Existing document and external event guards remain in place. Non-file resources do not become unresolved baseline entries that cannot pass restoration validation.

This preserves the current file-only support boundary; it does not add virtual filesystem support. The condition depends on the URI seen by the extension host, not on whether the user calls their environment SSH or a container. Existing invalid persisted states remain blocked; the fix does not silently discard entries from a previously invalid session.

## Verification

- Added pure virtual and mixed workspace scan/persist/reload cases, including an unexpected non-file result returned from discovery for a file folder. Both failed before the fix; the pure virtual state failed the production parser and the mixed state retained unsupported entries.
- Both cases now pass, avoid virtual-folder discovery/watchers, and restore successfully. Mixed workspaces continue tracking supported files after reload.
- Added a same-path non-file event/document check to protect a pending local review.
- Tracker regressions: 182/182. Full local suite: 242/242. Compilation, lint, and conservative safety probes (4/4) pass.
- Tests call production tracker methods with mocked VS Code boundaries. Actual virtual-provider/SSH/container host validation was not run. CI and independent review of the new commit are separate gates.

Manual follow-up inspection covered Start/Reset scanning, watcher installation, repository rebuild filtering, document/external event entry points, and persistence validation. The code-review skill is unavailable in this environment; this inspection is not an independent review.
