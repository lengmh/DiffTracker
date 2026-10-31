# Monitoring lifecycle and saved-review recovery

This change preserves scope requests/drafts, workspace files and existing review data unless the user separately confirms destructive saved-session discard. It does not change the session schema, extension version or legacy policy matching.

## Confirmed defects

Apply and preflight merged disposed, recovery-blocked and baseline-transaction causes into one error. Monitoring Scope had no lifecycle projection or subscription, so its Status could not explain those causes as they changed. Start checked requested/effective scope mismatch before exposing recovery; a pending Workspace request plus blocked legacy/configured restoration could therefore block both Apply and the only recovery entry.

`legacyMigrationComplete` describes migration evidence, not configured scope activation. Valid `legacyV3` sessions with no legacy rules were indistinguishable from migrations still requiring Apply. The existing recovery option deleted saved review/recovery files and immediately continued rebuilding without a separate explanation of the loss.

## State and action boundaries

| State/action | Behavior |
| --- | --- |
| Disposed tracker | Report closed instance and reload guidance; no scope write or Start |
| Recovery blocked | Show persisted failure reason separately from scope/migration status; recovery remains reachable despite request mismatch |
| Durable preparation interrupted | Require reload; refuse retry in this instance; never force-clear a transaction |
| Baseline transaction or scan | Show activity/available phase and wait guidance; Apply/preflight refuse without mutation |
| Settings write or scope action pending | Status updates live; duplicate or stale recovery actions refuse; editor draft remains intact |
| Legacy mode without rules | Valid compatibility remains recordable when no Workspace request is pending |
| Legacy rules pending/reviewed | Distinguish rule review from reviewed-but-not-applied configuration, including committed-only legacy policies |
| Safe recovery retry | Serialize on existing recovery queue, revalidate preserved state/last-good data, preserve original before-images and Undo, finish paused; reconcile latest request and Git monitor without applying or starting |
| Missing legacy policy evidence | Preserve the failure and storage; a newer structured request cannot invent historical policy |
| Stop/dispose during retry | Finish the finite restore before persisting its complete paused projection; stale epochs cannot stop or block a newer lifecycle |
| Explicit discard | Independent modal lists saved baseline, pending review, Undo and interrupted-operation loss; bind approval to epoch, persistence reason and request revision; stay stopped |

Retry reuses the existing validated restoration path. It cannot repair corrupt data, missing historical policy or unknown before-images by inference. Missing/inaccessible recovery evidence can still require manual recovery or a separately confirmed discard. Loaded review is not implicitly replaced by a new baseline. Legacy migration, scope expansion consent and review-discard consent remain distinct.

## Local validation

- Ten filesystem-backed lifecycle regressions cover cause combinations, common Apply/preflight diagnostics, transaction lifecycle, reload-required preparation, paused restoration with original review/Undo, duplicate/failed retry, stale epoch, Stop/dispose and discard storage failure.
- Production UI/command tests cover live Status with an unsaved invalid draft, migration stages, early Save and Apply refusal, transaction onset during confirmation, reachable recovery for legacy/configured mismatch, cancellation/duplicate discard, revision-bound confirmation, newer request reconciliation and latest Git context validation.
- Real VS Code Stable 1.144.0 and minimum 1.80.2 isolated Host scenarios validate corrupt primary/last-good blocking, missing committed legacy-policy refusal with the actual reason, successful last-good retry in paused mode, original pending review and workspace bytes, live transaction/retry status, and public recovery commands refusing an unrelated healthy session. Fixtures use fresh synthetic workspaces/storage; no production recovery lock is bypassed.
- The prior diagnostic checkpoint passes the complete tracker suite 1855/1855; four subsequent restore-certification event-drain regressions additionally pass, bringing the focused directory suite to 33/33. The review UI suite reports 218 primary cases plus its startup/recovery/branch command cases. Lint and compilation pass. Exact final-head cross-platform CI and independent review remain separate gates.
