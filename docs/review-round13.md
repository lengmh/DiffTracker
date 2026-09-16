# Review round 13: repository rebuild with unsupported files

Review: https://github.com/lengmh/DiffTracker/pull/1#discussion_r4023334869

Baseline: remote `f6ef792d1cb55519a17fc1bd145993edf8b89fd8`.

Repository rebuild now records non-text read results as unresolved baseline entries and continues scanning. Binary, BOM, oversized, unreadable and disappeared files retain a reason and cannot receive actionable review tokens. This matches initial baseline scanning without relaxing read/write support or persisted-state validation.

Epoch and Git-context changes, archive failures and persistence failures still abort the rebuild. Manual inspection confirmed those guards remain unchanged. The branch-change regression now also includes an unsupported file and verifies unresolved candidate state is rolled back.

Six added production regressions cover each file category plus a wholly unsupported scan. All six failed before the fix; all now pass. Each persists and restores the session, checks unresolved entries remain blocked, and (where present) checks supported text can still be reviewed after reload.

Verification: tracker 188/188; full local suite 248/248; compilation, lint and conservative probes 4/4 pass. These are production-method tests with mocked VS Code boundaries. CI and independent review of the new commit are separate gates. No new actual remote-provider host testing was performed. The code-review skill is unavailable; manual inspection is not an independent review.
