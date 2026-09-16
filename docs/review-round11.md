# Review of 86ec20ef: file recovery and migration provenance

File Revert now validates Git/action eligibility after save before reporting
success. Recreating a deleted baseline file rechecks the session and target after
creation, before populating it, and after the content write/readback. Conflicts
report bufferChanged and retain the recovery record and pending review.

The analogous Undo recreation path has matching target checks and epoch-guarded
cleanup. A failed old-session write no longer marks a new session's review.
Previously added block Revert/Undo checks remain covered by the full regression
suite. Checks cannot cancel a provider operation already dispatched; they prevent
subsequent writes and false success, without automatically overwriting newer work.

The parser records actual V1 provenance in memory. Only a restoration parsed from
V1 receives one-time permission to adopt initial Git contexts. V2 with an empty
Git-context list follows normal newly-appearing repository pause behavior.
Provenance is not read from an arbitrary JSON property or emitted in V2 writes;
session changes clear it and reconciliation consumes it once.

Eleven added tests cover file save/create/write with branch and operation pauses,
Undo recreation, V1/V2 restoration, and one-time migration consumption. Seven
primary failure cases reproduced before the fix. Local npm test: 239/239,
including 179 tracker regressions; lint and stage2 probes 4/4 pass. These race tests
use a mocked VS Code boundary. Exact-commit Host/package CI is reported in the PR.
Independent review remains pending.
