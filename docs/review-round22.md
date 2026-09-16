# Round 22: reconcile offline additions on recording restore

Input HEAD: `2b2750dff82f549bb217be765cf8099467a75f9c`.
Finding: PR #1 review comment 4026380161 (P1).

Active, complete restored recordings now enumerate supported workspace roots and
open file documents before reconstructing their reviews. New included paths get
an absent baseline, durably stored before review resumes. Empty files remain
new files. Existing snapshots and unresolved before-images are preserved.
Stopped, partial and mismatched-root sessions do not infer new absent baselines.

Watchers register before ignore discovery and retain events through the scan and
reconciliation. Editor opens cannot capture a new baseline during restoration;
editor changes queue for replay. Dirty buffers, binary/unreadable resources and
unsupported targets retain conservative action guards. Ignore/watcher/scan or
persistence failure blocks restoration and protects the prior durable session.
Stop/restart/disposal epoch checks prevent late results changing a new session.

## Verification

- Full `npm test`: 398/398, including 325 tracker regressions and 15 new cases.
- Compile, lint and `git diff --check` pass.
- The two offline text/empty discovery tests fail on the input source with
  `undefined !== ''`, then pass with the repair. The archived-source test loader
  now sets its module filename for relative imports on Node 24.
- Additional production tests cover durable reload, opening discovered files,
  conservative Revert and explicit Keep, dirty/binary/unreadable additions,
  excluded and unresolved paths, stopped/partial sessions, watcher coverage
  during ignore discovery, scan/write failure, Stop, and change/delete/recreate
  during discovery. VS Code boundaries are mocked; temporary files are real.
- Native Host assertions added for text and empty files created while the tracker
  is disposed, verified after restore alongside the existing real-watcher replay
  assertion. This is an in-process tracker reload, not a process crash test.
- Implementer second-pass inspection covered discovery, persistence failure,
  epoch cancellation, editor capture and event replay. No independent reviewer
  approval is claimed. Exact-commit Host/Windows CI is verified after push and
  reported in the PR description.

The PR remains unmerged. Marketplace is not published.
