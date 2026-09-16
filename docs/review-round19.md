# Round 19: transient startup event sequences

Input PR HEAD: `9490dba8d0a6256385b81a5e9800182bcaa2fe21`.
Review: https://github.com/lengmh/DiffTracker/pull/1#discussion_r4025295719

## Repair

The startup queue previously retained only a URI. A directory created and deleted
while ignore discovery was pending was therefore classified as a missing unknown
file and persisted as an unactionable review entry.

Each path now keeps its first and latest event kinds. This compact summary
distinguishes completed create/delete incarnations from deletion or uncertainty
that preceded creation. It does not infer that every missing path is transient.
Classification retains the event history across asynchronous stat calls and
rechecks paths whose event object changes during those calls. Classifications are
applied only after all buffered paths have been checked against their latest event.

A path is omitted only when its first event is create, its final event is delete,
stat confirms absence, it was not open at startup, and no dirty buffer survives.
Permission failures, isolated deletes, change/delete-before-create sequences and
surviving recreations remain unresolved. Directory uncertainty still protects
children; a transient parent cannot silently accept a pre-existing open child.
Clean documents from completed transient paths and stale enumeration results do
not recreate the phantom entry. Epoch guards preserve Stop/restart isolation.

## Verification

- Before repair, both transient-directory and transient-file assertions failed
  against the production tracker. The phantom review also survived persistence
  and reload in the prior confirmation probe.
- 16 new regressions pass: file/directory create-change-delete; repeated complete
  incarnations; create-delete-create; delete-create-delete; change-create-delete;
  isolated delete; pre-existing/dirty/clean documents; stat permission failure;
  deletion while another path is being classified; recreation during stat;
  Stop/restart during stat; parent/child events with stale enumeration; and
  preservation of a pre-existing child under a transient parent.
- Full `npm test`: 354/354 (289 tracker cases plus 65 other cases).
- `npm run lint` and `git diff --check`: exit 0.
- These new cases use real temporary files and production tracker code with a
  mocked VS Code boundary and deterministic filesystem pause points. No new
  native Host scenario was added, and Host tests were not run locally. The
  existing Windows/Ubuntu Stable and VS Code 1.80 Host suites run in CI; exact
  commit results are recorded in PR #1 after push.
- The implementer performed a second inspection of event ordering, classification
  I/O, document/child guards and lifecycle checks. This is not separate reviewer
  approval; the requested code-review skill is not installed.

This prevents new phantom entries. It does not automatically remove previously
persisted unknown entries whose event history is unavailable; those still need
an explicit baseline rebuild. It does not relax the documented external-writer
TOCTOU limitations or infer missing events from absent disk content alone.

The PR remains unmerged, with no Marketplace publication in this round.
