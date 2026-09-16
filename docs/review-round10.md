# Review of 1fdd0e84: block action revalidation

Both P1 findings are addressed: buffer Undo and block Revert recheck action
eligibility after applyEdit. A changed Git context, baseline or session cannot be
reported as successful recovery. Modified buffers are reported explicitly and
recovery records remain available in the owning session.

The second inspection covered these adjacent boundaries:

| Path | Verification |
| --- | --- |
| Block Revert recovery-record persistence | Recheck reviewed content and dirty editor before applying; newer editor content is not replaced |
| Revert/Undo pending edit | Test branch and unfinished-operation pauses; disk is not saved |
| Old-session completion | No mutation of new-session pending review or write flags |
| Undo baseline revision | Reject revision change after applying; retain recovery |
| Undo partial failure | Report bufferChanged when the provider throws after editing |
| Recovery cleanup | Remove only the owned record object; reused IDs cannot remove another session's record |
| Block Keep | Inspected pre-acceptance validation, persistence rollback and post-write refresh; existing race/byte-limit/stale-token tests remain passing |

Ten added regressions; the six primary pause/session cases all failed before the
patch. Local npm test: 228/228, including 168 production tracker cases; lint and
stage2 probes 4/4 pass. VS Code boundaries are mocked in these race regressions;
real Host/packaging CI results are separately reported for the published commit.

These checks cannot cancel an edit already dispatched to VS Code. They report
the resulting changed buffer as conflict/failure and retain recovery instead of
automatically rolling it back or claiming success. Independent PR review remains
pending; the installed skills do not include the code-review skill.
