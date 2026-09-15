# Stage 3: durable recovery and bounded Revert recovery

Stage 3 builds on PR #1 at `2ebb0d8`. It does not claim Windows or real VS Code
Extension Host verification; those remain stage 5 gates.

## Implemented

- Session persistence is now schema V2. Valid V1 states are strictly validated and
  migrated in memory; the next durable write uses V2. Invalid entries reject the
  complete state instead of silently opening a partial review.
- V2 records `building` versus `ready`, the local workspace roots, and a bounded
  Revert recovery history. A partial scan or different workspace reopens paused;
  review writes remain blocked until the user explicitly rebuilds the baseline.
- Writes use a same-directory temporary file followed by an overwrite rename and
  maintain `session-state.last-good.json`. A corrupt primary recovers from that
  file; if neither copy validates, activation preserves both and requires an
  explicit discard before a new baseline can start.
- Persistence limits are 10,000 snapshots and 50 MiB serialized state. Failures
  are observable and preserve the previous primary. Extension deactivation now
  awaits the queued state write; data that never reached the durable queue before
  process termination is still not promised.
- Revert records are written before file or hunk mutation. Failure to persist the
  record blocks the Revert. `Undo Last Revert` retains at most 10 actions, supports
  successful members of a batch and file create/delete restoration, and refuses
  to overwrite content changed after the Revert.
- Hunk recovery restores the editor buffer without forcing a save. If native
  Ctrl+Z already restored the pre-Revert content, the extension recognizes that
  state and invalidates its own record rather than applying a second inverse edit.

## Automated evidence

Linux, Node 24.19.0, npm 11.9.0:

| Command | Result | Boundary |
| --- | --- | --- |
| `npm run test:tracker-safety` | 107/107, exit 0 | Production tracker with mocked VS Code API/filesystem faults |
| `npm test` | 146/146, exit 0 | 107 tracker + 20 review UI + 6 path + 13 retained mapping/similarity cases |
| `git diff --check` | exit 0 | Whitespace validation |

The stage began with 10 new desired-behavior failures on the prior production
code. The implementation then passed those and seven additional recovery cases:
strict V1 migration, explicit corrupt-state discard, preflight persistence
failure, new/deleted file recovery, buffer-only block recovery, recovery after
reload, and conflict after newer work.

## Explicit limits

- Actual Ctrl+Z/Redo stack behavior, Extension Host reload/termination, Windows
  file locking, UNC/OneDrive paths, autosave and formatter combinations are not
  proven by these tests.
- The temporary rename is as atomic as the active VS Code filesystem provider.
  It is not an OS transaction across arbitrary external writers.
- Two extension windows sharing the same storage are not supported or claimed.
- A dismissed corrupt-session prompt preserves the damaged state and leaves
  recording paused. Rebuilding or discarding is intentionally explicit.
