# Minimum Host settings publication limitation

This is an unresolved availability boundary, separate from directory reconstruction and late Status publication. Settings ownership and transaction protection remain strict.

## Retained failure

Candidate `ce8de6b5fc72469c68a52b73c221a172d4914724`, [run 41216434422](https://github.com/lengmh/DiffTracker/actions/runs/41216434422), completed with six passing jobs, a failed [VS Code 1.80 Host job](https://github.com/lengmh/DiffTracker/actions/runs/41216434422/job/124581819123) and dependent packaging skipped. Neither the run nor the failed job was retried to replace this result.

The existing isolated scope-settings fixture failed in its first stopped Save and Apply, before the new recovery scenarios. Its bounded trace records this sequence:

| Relative time | Observable state |
| --- | --- |
| 530–706 ms | monitoringScope update begins, expected Rules value publishes, API responds |
| 709 ms | watchInclude update begins; prior scope and exclusions are still present |
| 827 ms | configuration notification shows all three scope settings unset; settings.json is dirty at document version 3 |
| 933 ms | configuration notification again shows expected Rules, empty includes and the prior exclusions |
| 972 ms | update returns a latched ownership conflict; Apply has not run and automatic compensation is refused |

The prior exclusions remain present. The refused action preserves the effective scope, workspace files and review. The observed final values do not erase evidence that ownership was uncertain during publication.

## What is established

`updateOwnedScopeSetting` is byte-identical to main/v0.8.13. The preceding `3971ddc` candidate with the same production code passed its complete 1.80 Host job. A fresh local isolated scope-settings scenario passes. These comparisons narrow the issue but do not prove the intermittent publication problem fixed.

A separate local probe against the unmodified official 1.80.2 runtime performed 50 serial configuration API writes in a fresh synthetic workspace/profile, capturing configuration, disk and document metadata. It observed no all-unset publication. It is one bounded reproduction attempt, not a retry of the failed acceptance case or evidence of universal success.

Controlled tests of the actual controller method reproduce the CI decision: ordinary expected publication verifies; an all-unset notification followed by the expected state before API completion still refuses. A real external clear followed by the same expected state produces the same observable sequence and the same refusal. Whitelisting the all-unset state, ignoring intervening notifications, or trusting only eventual expected values would weaken that protection.

## Upstream mechanism and uncertainty

VS Code 1.80.2's [configuration service](https://github.com/microsoft/vscode/blob/1.80.2/src/vs/workbench/services/configuration/browser/configurationService.ts#L883) saves through a write queue and explicitly reloads configuration afterwards. Its [file-based configuration loader](https://github.com/microsoft/vscode/blob/1.80.2/src/vs/workbench/services/configuration/browser/configuration.ts#L202) also reacts to debounced filesystem events; a failed file read can supply an empty object, and loading resets the prior parsed settings. These independent reloads are consistent with the observed incomplete publication during a later API save.

The CI trace did not capture the workbench's actual file read result. A truncated/empty read, a read error or another stale reload cannot be distinguished from that trace, so none is claimed as the proven physical cause. There is no evidence that the fixture merely forgot to await its API promise: the controller observes both the API response and matching readback, and the unexpected publication happened while the subsequent write was still pending.

## Safe boundary

The current protocol intentionally refuses this uncertainty and permits a fresh, explicitly reviewed action once settings settle. The late-fence Status repair ensures a settled write cannot leave Apply disabled indefinitely. It does not automatically resume a failed Apply or grant consent to a newer request.

Guaranteeing successful single-action publication would require additional proof identifying the complete owned settings write, such as a versioned atomic JSONC publication protocol with document/disk ownership and preservation of unrelated settings. That is a broader change involving dirty editors, multi-root configuration files, external edits, compensation and the existing settings-event/baseline transaction proof. It must be designed and reviewed separately; weakening the existing readback fence or adding arbitrary sleeps is not such a proof.
