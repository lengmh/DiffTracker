# Persisted tracker fixtures

`unnamed-runtime-0.8.10.json` was generated with the released 0.8.10
`DiffTracker.ts` source at `ddc2190cc0dba35944fc80dfba8ba963a2d850ca`,
using the production tracker regression harness and synthetic local files.
It includes a pending text review, an unknown before-image, a real persisted
Undo record and the gap produced by an unnamed supplemental watcher callback.
The VS Code and native watcher boundaries are mocked; this is not an installed
old-extension upgrade test.

Workspace/storage path prefixes were replaced with fixture tokens. The test
rebinds the workspace location, root identity and corresponding scope revision;
old coverage evidence, snapshots and Undo data remain intact. No user workspace
data is included. The fixture is excluded from the VSIX.
