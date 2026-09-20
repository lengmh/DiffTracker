import { displayFileName } from './utils/displayPath';
import * as vscode from 'vscode';
import { ActionResult, BatchActionResult, DiffTracker, MixedBatchActionResult, OpaqueReviewToken, ReviewToken, TrackChangesEvent } from './diffTracker';
import { DecorationManager } from './decorationManager';
import { DiffTreeDataProvider } from './diffTreeView';
import { DiffHoverProvider } from './hoverProvider';
import { StatusBarManager } from './statusBarManager';
import { OriginalContentProvider } from './originalContentProvider';
import { InlineContentProvider } from './inlineContentProvider';
import { DiffCodeLensProvider } from './codeLensProvider';
import { SettingsTreeDataProvider } from './settingsTreeView';
import { WebviewDiffPanel } from './webviewDiffPanel';
import { WatchExcludePanel } from './watchExcludePanel';
import { createInlineDiffUri } from './utils/inlineDiffUri';
import { GitContextEvent, GitContextMonitor, GitContextSnapshot } from './gitContext';
import { MonitoringScopeController } from './monitoringScopeController';

let diffTracker: DiffTracker;
let decorationManager: DecorationManager;
let statusBarManager: StatusBarManager;
let originalContentProvider: OriginalContentProvider;
let inlineContentProvider: InlineContentProvider;
let codeLensProvider: DiffCodeLensProvider;
let settingsTreeDataProvider: SettingsTreeDataProvider;
let diffTreeDataProvider: DiffTreeDataProvider;
let changesTreeView: vscode.TreeView<any> | undefined;
let gitContextMonitor: GitContextMonitor | undefined;

type DefaultOpenMode = 'webview' | 'inline' | 'sideBySide' | 'original' | 'splitOriginalWebview';

function extractFilePath(filePathOrItem: string | any): string | undefined {
    if (typeof filePathOrItem === 'string') {
        return filePathOrItem;
    }

    if (filePathOrItem instanceof vscode.Uri) {
        return filePathOrItem.fsPath;
    }

    return filePathOrItem?.filePath;
}

function extractIsDeleted(filePathOrItem: string | any): boolean | undefined {
    if (!filePathOrItem || typeof filePathOrItem === 'string') {
        return undefined;
    }
    return filePathOrItem?.isDeleted === true;
}

function getDefaultOpenMode(): DefaultOpenMode {
    const config = vscode.workspace.getConfiguration('diffTracker');
    const mode = config.get<string>('defaultOpenMode', 'webview');
    if (mode === 'inline' || mode === 'sideBySide' || mode === 'original' || mode === 'splitOriginalWebview' || mode === 'webview') {
        return mode;
    }
    return 'webview';
}

function isDeletedReview(filePath: string, filePathOrItem: string | any): boolean {
    const tracked = diffTracker.getTrackedChanges().find(change => change.filePath === filePath);
    return tracked ? tracked.isDeleted === true : extractIsDeleted(filePathOrItem) === true;
}

export async function activate(context: vscode.ExtensionContext) {
    const runningExtensionTests = context.extensionMode === vscode.ExtensionMode.Test;

    // Initialize services
    diffTracker = new DiffTracker(context.storageUri);
    // Commands and restored review views must never precede Git reconciliation.
    diffTracker.setGitContextPending(true);
    const restoreOutcome = await diffTracker.restorePersistedState();
    decorationManager = new DecorationManager(diffTracker);
    statusBarManager = new StatusBarManager(diffTracker);
    originalContentProvider = new OriginalContentProvider(diffTracker);
    inlineContentProvider = new InlineContentProvider(diffTracker);
    codeLensProvider = new DiffCodeLensProvider(diffTracker);
    settingsTreeDataProvider = new SettingsTreeDataProvider();
    const monitoringScopeController = new MonitoringScopeController(context, diffTracker);
    context.subscriptions.push(monitoringScopeController);
    // A fresh workspace with no legacy Global rules can safely adopt the default
    // Rules scope before recording starts. Restored V1/V2/V3 sessions remain in
    // compatibility mode until the user explicitly migrates/applies them.
    if (restoreOutcome === 'absent' && monitoringScopeController.getLegacyGlobalRules().length === 0) {
        await monitoringScopeController.applyPendingScope();
    }

    // Register tree view provider for activity bar
    diffTreeDataProvider = new DiffTreeDataProvider(diffTracker);
    changesTreeView = vscode.window.createTreeView('diffTracker.changesView', {
        treeDataProvider: diffTreeDataProvider,
        showCollapseAll: false
    });
    context.subscriptions.push(changesTreeView);

    // Register settings tree view
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('diffTracker.settingsView', settingsTreeDataProvider)
    );

    const refreshChangesTree = () => {
        diffTreeDataProvider.refresh();

        if (!changesTreeView) {
            return;
        }

        const count = diffTracker.getTrackedChanges().length;
        if (count > 0) {
            changesTreeView.badge = {
                value: count,
                tooltip: `${count} changed file(s)`
            };
        } else {
            changesTreeView.badge = undefined;
        }
    };

    let recordingRequest = 0;
    const startRecordingFlow = async (): Promise<boolean> => {
        const request = ++recordingRequest;
        // Establish Git identity before capturing a fresh baseline; never adopt
        // a late context onto snapshots that might predate a checkout.
        if (gitContextMonitor && !await gitContextMonitor.whenReady()) { return false; }
        if (request !== recordingRequest) { return false; }
        const scopeStatus = monitoringScopeController.getStatus();
        if (scopeStatus.requested.ok && scopeStatus.expansionReasons.length > 0 && !scopeStatus.consented) {
            void vscode.window.showWarningMessage(
                'Code Diff Tracker: The requested monitoring scope expands local access and is not authorized on this host. Apply it from Manage Monitoring Scope before starting recording.'
            );
            return false;
        }
        if (diffTracker.isRecoveryBlocked()) {
            const answer = await vscode.window.showErrorMessage(
                'Code Diff Tracker could not validate the saved review session. It remains preserved and recording is paused.',
                { modal: true },
                'Discard Saved Session and Rebuild'
            );
            if (answer !== 'Discard Saved Session and Rebuild' || !await diffTracker.discardRecoveryState()) {
                return false;
            }
        } else if (!diffTracker.getIsRecording() && diffTracker.getBaselineState() === 'building') {
            const answer = await vscode.window.showWarningMessage(
                'Code Diff Tracker recovered an incomplete or different-workspace baseline. Starting will discard that review and build a new baseline.',
                { modal: true },
                'Rebuild Baseline'
            );
            if (answer !== 'Rebuild Baseline') { return false; }
        }
        diffTracker.startRecording();
        if (gitContextMonitor?.isReady()) {
            diffTracker.setBaselineGitContexts(gitContextMonitor.getSnapshots());
        }
        void vscode.commands.executeCommand('setContext', 'diffTracker.isRecording', true);
        return diffTracker.getIsRecording();
    };

    const stopRecordingFlow = () => {
        ++recordingRequest;
        diffTracker.stopRecording();
        void vscode.commands.executeCommand('setContext', 'diffTracker.isRecording', false);
    };

    // Register toggle setting command
    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.toggleSetting', async (settingKey: string) => {
            await settingsTreeDataProvider.toggleSetting(settingKey);
            // Refresh decorations after setting change
            vscode.window.visibleTextEditors.forEach(editor => {
                decorationManager.updateDecorations(editor);
            });
            codeLensProvider.refresh();
        })
    );

    // Register hover provider to show diff details
    context.subscriptions.push(
        vscode.languages.registerHoverProvider('*', new DiffHoverProvider(diffTracker))
    );

    // Register CodeLens provider for block-wise actions
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider('*', codeLensProvider)
    );

    // Register virtual document provider for original content
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider('diff-tracker-original', originalContentProvider)
    );

    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider('diff-tracker-inline', inlineContentProvider)
    );

    const refreshReview = () => {
        codeLensProvider.refresh();
        refreshChangesTree();
        vscode.window.visibleTextEditors.forEach(editor => decorationManager.updateDecorations(editor));
    };

    const reportAction = (result: ActionResult): ActionResult => {
        refreshReview();
        if (result.status !== 'success') {
            void vscode.window.showWarningMessage(
                `${displayFileName(result.filePath)}: ${result.reason ?? result.status}`
            );
        }
        return result;
    };

    const reportBatch = (verb: string, result: BatchActionResult): BatchActionResult => {
        refreshReview();
        const summary = `${verb} ${result.succeeded} file(s); ${result.failed} not completed.`;
        const failures = result.results.filter(item => item.status !== 'success');
        if (failures.length > 0) {
            void vscode.window.showWarningMessage(`${summary} ${failures.map(item =>
                `${displayFileName(item.filePath)}: ${item.reason ?? item.status}`
            ).join('; ')}`);
        } else {
            void vscode.window.showInformationMessage(summary);
        }
        return result;
    };

    const reportMixedBatch = (verb: string, result: MixedBatchActionResult): MixedBatchActionResult => {
        refreshReview();
        const parts = [
            result.accepted ? `${result.accepted} accepted` : '',
            result.acknowledged ? `${result.acknowledged} acknowledged` : '',
            result.reverted ? `${result.reverted} reverted` : '',
            result.needsConfirmation ? `${result.needsConfirmation} need confirmation` : '',
            result.needsAttention ? `${result.needsAttention} need attention` : '',
            result.failures ? `${result.failures} failed` : '',
            result.conflicts ? `${result.conflicts} conflict` : '',
            result.cancelled ? `${result.cancelled} cancelled` : ''
        ].filter(Boolean).join(' · ');
        const message = `Code Diff Tracker: ${verb}: ${parts || 'no pending items'}.`;
        if (result.failures || result.conflicts || result.needsAttention || result.needsConfirmation) {
            void vscode.window.showWarningMessage(message);
        } else {
            void vscode.window.showInformationMessage(message);
        }
        return result;
    };

    const missingReview = (filePath: string): ActionResult => reportAction({
        filePath, status: 'conflict', reason: 'Review version is unavailable; reopen or refresh the review before acting'
    });

    const gitPromptInFlight = new Set<string>();
    const rebuildGitBaseline = async (
        repoRoot: string,
        contextSnapshot?: GitContextSnapshot,
        confirmed = false
    ): Promise<boolean> => {
        const snapshot = contextSnapshot ?? gitContextMonitor?.getSnapshot(repoRoot);
        if (!snapshot) {
            void vscode.window.showWarningMessage('Code Diff Tracker: The Git repository is unavailable; its preserved review remains paused.');
            return false;
        }
        if (snapshot.inProgress) {
            void vscode.window.showWarningMessage('Code Diff Tracker: Finish or abort the Git merge/rebase before rebuilding this repository baseline.');
            return false;
        }
        if (!confirmed) {
            const answer = await vscode.window.showWarningMessage(
                'Archive the current review and rebuild only this repository from disk? Pause automation and save or close dirty editors first.',
                { modal: true, detail: repoRoot },
                'Archive and Rebuild'
            );
            if (answer !== 'Archive and Rebuild') { return false; }
        }
        const currentSnapshot = gitContextMonitor?.getSnapshot(repoRoot);
        if (!currentSnapshot || currentSnapshot.inProgress) { return false; }
        const rebuilt = await diffTracker.rebuildRepositoryBaseline(repoRoot, currentSnapshot);
        if (rebuilt) {
            refreshReview();
            void vscode.window.showInformationMessage('Code Diff Tracker: The repository review was archived and its baseline rebuilt.');
        } else {
            void vscode.window.showWarningMessage(
                'Code Diff Tracker did not rebuild the repository. Its review remains paused; save dirty editors, wait for Git to become stable, and try again.'
            );
        }
        return rebuilt;
    };

    const handleGitContextEvent = async (event: GitContextEvent): Promise<void> => {
        if (event.kind === 'ready') {
            if (diffTracker.getIsRecording() || restoreOutcome === 'restored' || restoreOutcome === 'recovered' || restoreOutcome === 'incomplete') {
                diffTracker.reconcileRestoredGitContexts(event.contexts);
            }
            diffTracker.setGitContextPending(false);
            return;
        }
        const repoRoot = event.kind === 'changed' ? event.context.repoRoot : event.repoRoot;
        const reason = event.kind === 'changed'
            ? diffTracker.observeGitContext(event.context)
            : diffTracker.observeGitRepositoryRemoved(event.repoRoot);
        if (!reason || runningExtensionTests || gitPromptInFlight.has(repoRoot)) { return; }
        gitPromptInFlight.add(repoRoot);
        try {
            const answer = await vscode.window.showWarningMessage(
                `Code Diff Tracker: ${reason}`,
                { modal: true, detail: 'The existing review is preserved. Closing this message keeps it paused.' },
                'Archive and Rebuild'
            );
            if (answer === 'Archive and Rebuild') {
                await rebuildGitBaseline(repoRoot, event.kind === 'changed' ? event.context : undefined, true);
            }
        } finally {
            gitPromptInFlight.delete(repoRoot);
        }
    };

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.toggleRecording', () => {
            if (diffTracker.getIsRecording()) {
                stopRecordingFlow();
            } else {
                return startRecordingFlow();
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.startRecording', () => {
            return startRecordingFlow();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.stopRecording', () => {
            stopRecordingFlow();
        })
    );

    if (runningExtensionTests) {
        context.subscriptions.push(
            vscode.commands.registerCommand('diffTracker._testState', () => ({
                isRecording: diffTracker.getIsRecording(),
                baselineState: diffTracker.getBaselineState(),
                reviewTokens: diffTracker.getReviewTokens(),
                opaqueReviewTokens: diffTracker.getOpaqueReviewTokens(),
                unknownReviewPaths: diffTracker.getUnknownReviewPaths(),
                trackedChanges: diffTracker.getTrackedChanges(),
                gitPauses: diffTracker.getPausedGitRepositories(),
                effectiveMonitoringScope: diffTracker.getEffectiveMonitoringScope(),
                retainedReviewPaths: diffTracker.getRetainedReviewPaths(),
                coverageGaps: diffTracker.getCoverageGaps(),
                policyFingerprint: diffTracker.getPolicyFingerprint(),
                coverageGeneration: diffTracker.getCoverageGeneration()
            })),
            vscode.commands.registerCommand('diffTracker._testOriginalContent', (filePath: string) =>
                diffTracker.getOriginalContent(filePath)
            ),
            vscode.commands.registerCommand('diffTracker._testRevertFile', (filePath: string) => {
                const token = diffTracker.getReviewToken(filePath);
                return token ? diffTracker.revertFile(filePath, token) : undefined;
            }),
            vscode.commands.registerCommand('diffTracker._testRevertBlock', (filePath: string) => {
                const token = diffTracker.getReviewToken(filePath);
                const block = diffTracker.getChangeBlocks(filePath)[0];
                return token && block ? diffTracker.revertBlock(filePath, block.blockId, token) : undefined;
            }),
            vscode.commands.registerCommand('diffTracker._testKeepBlock', (filePath: string) => {
                const token = diffTracker.getReviewToken(filePath);
                const block = diffTracker.getChangeBlocks(filePath)[0];
                return token && block ? diffTracker.keepBlock(filePath, block.blockId, token) : undefined;
            }),
            vscode.commands.registerCommand('diffTracker._testRevertAll', () => {
                return diffTracker.revertAllChanges(diffTracker.getReviewTokens());
            }),
            vscode.commands.registerCommand('diffTracker._testAcknowledgeOpaque', (filePath: string) => {
                const token = diffTracker.getOpaqueReviewToken(filePath);
                return token ? diffTracker.acknowledgeOpaqueChange(filePath, token) : undefined;
            }),
            vscode.commands.registerCommand('diffTracker._testAcceptAllPending', () =>
                diffTracker.acceptAllPendingChanges()
            ),
            vscode.commands.registerCommand('diffTracker._testRevertAllPending', () =>
                diffTracker.revertAllPendingChanges()
            ),
            vscode.commands.registerCommand('diffTracker._testUndoLastRevert', () => diffTracker.undoLastRevert()),
            vscode.commands.registerCommand('diffTracker._testClearDiffs', () => diffTracker.resetBaselineToCurrentState()),
            vscode.commands.registerCommand('diffTracker._testRebuildGitBaseline', (repoRoot: string) => {
                const snapshot = gitContextMonitor?.getSnapshot(repoRoot);
                return snapshot ? diffTracker.rebuildRepositoryBaseline(repoRoot, snapshot) : false;
            }),
            vscode.commands.registerCommand('diffTracker._testMonitoringScopeStatus', () =>
                monitoringScopeController.getStatus()
            ),
            vscode.commands.registerCommand('diffTracker._testApplyMonitoringScope', (options?: { grantConsent?: boolean; discardExplicitlyExcludedReviews?: boolean }) =>
                monitoringScopeController.applyPendingScope(options)
            ),
            vscode.commands.registerCommand('diffTracker._testMigrateLegacyScope', () =>
                monitoringScopeController.migrateLegacyWatchRules()
            )
        );
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.beginAutomationSession', (target?: unknown) => {
            return diffTracker.beginAutomationSession(target);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.endAutomationSession', (target?: unknown) => {
            diffTracker.endAutomationSession(target);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.showInlineDiff', async (filePathOrItem: string | any) => {
            const filePath = extractFilePath(filePathOrItem);

            if (!filePath) {
                return;
            }

            const inlineUri = createInlineDiffUri(filePath);
            const doc = await vscode.workspace.openTextDocument(inlineUri);
            const editor = await vscode.window.showTextDocument(doc);
            decorationManager.updateDecorations(editor);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.showSideBySideDiff', async (filePathOrItem: string | any) => {
            const filePath = extractFilePath(filePathOrItem);

            if (!filePath) {
                return;
            }

            // Show side-by-side diff using VS Code's built-in diff editor
            const currentUri = vscode.Uri.file(filePath);
            const originalUri = currentUri.with({ scheme: 'diff-tracker-original' });

            const fileName = displayFileName(filePath);

            await vscode.commands.executeCommand('vscode.diff',
                originalUri,
                currentUri,
                `Original  ↔  Current: ${fileName}`
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.showSideBySideDiffActive', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.uri.scheme !== 'file') {
                return;
            }

            await vscode.commands.executeCommand('diffTracker.showSideBySideDiff', editor.document.uri.fsPath);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.showDiffs', async () => {
            // Update decorations for current editor
            if (vscode.window.activeTextEditor) {
                decorationManager.updateDecorations(vscode.window.activeTextEditor);
            }
            vscode.window.showInformationMessage('Diff highlighting applied to editor');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.revertAllChanges', async (reviewTokens?: ReviewToken[]) => {
            // Explicit token callers retain the legacy text-only contract.
            if (reviewTokens) {
                if (reviewTokens.length === 0) { return { results: [], succeeded: 0, failed: 0 } satisfies BatchActionResult; }
                const answer = await vscode.window.showWarningMessage(
                    `Revert ${reviewTokens.length} text-reviewable file(s) to their original state?`,
                    { modal: true, detail: 'Read-only and unknown reviews are not part of this explicit text-only request.' },
                    'Revert Text Changes',
                    'Cancel'
                );
                return answer === 'Revert Text Changes'
                    ? reportBatch('Reverted', await diffTracker.revertAllChanges(reviewTokens))
                    : { results: reviewTokens.map(token => ({ filePath: token.filePath, status: 'cancelled', reason: 'Revert cancelled' } as ActionResult)), succeeded: 0, failed: reviewTokens.length };
            }

            const textTokens = diffTracker.getReviewTokens();
            const opaquePaths = diffTracker.getOpaqueReviewTokens().map(token => token.filePath);
            const unknownPaths = diffTracker.getUnknownReviewPaths();
            if (textTokens.length === 0) {
                const result = await diffTracker.revertAllPendingChanges([], opaquePaths, unknownPaths);
                if (opaquePaths.length || unknownPaths.length) {
                    void vscode.window.showInformationMessage(
                        `Code Diff Tracker: No text changes can be reverted. ${opaquePaths.length} read-only change(s) need acknowledgement and ${unknownPaths.length} unknown change(s) need attention.`
                    );
                }
                return result;
            }
            const answer = await vscode.window.showWarningMessage(
                `Revert ${textTokens.length} text file(s)? ${opaquePaths.length} read-only and ${unknownPaths.length} unknown item(s) will remain pending.`,
                { modal: true, detail: 'Only text resources with a reliable before-image are modified. Read-only and unknown resources are never written or deleted.' },
                'Revert Text Changes',
                'Cancel'
            );
            if (answer !== 'Revert Text Changes') {
                const result = await diffTracker.revertAllPendingChanges([], opaquePaths, unknownPaths);
                result.results.unshift(...textTokens.map(token => ({ filePath: token.filePath, status: 'cancelled', reason: 'Revert cancelled' } as ActionResult)));
                result.cancelled += textTokens.length;
                result.failed += textTokens.length;
                return reportMixedBatch('Revert cancelled', result);
            }
            return reportMixedBatch('Revert result', await diffTracker.revertAllPendingChanges(textTokens, opaquePaths, unknownPaths));
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.keepAllChanges', async (reviewTokens?: ReviewToken[]) => {
            // Explicit token callers retain the legacy text-only contract.
            if (reviewTokens) {
                if (reviewTokens.length === 0) { return { results: [], succeeded: 0, failed: 0 } satisfies BatchActionResult; }
                return reportBatch('Accepted', await diffTracker.keepAllChanges(reviewTokens));
            }

            const textTokens = diffTracker.getReviewTokens();
            const opaqueTokens = diffTracker.getOpaqueReviewTokens();
            const unknownPaths = diffTracker.getUnknownReviewPaths();
            if (textTokens.length === 0 && opaqueTokens.length === 0 && unknownPaths.length === 0) {
                return {
                    results: [], succeeded: 0, failed: 0,
                    accepted: 0, acknowledged: 0, reverted: 0,
                    needsConfirmation: 0, needsAttention: 0,
                    failures: 0, conflicts: 0, cancelled: 0
                } satisfies MixedBatchActionResult;
            }
            if (opaqueTokens.length > 0 || unknownPaths.length > 0) {
                const answer = await vscode.window.showWarningMessage(
                    `Accept ${textTokens.length} text file(s) and acknowledge ${opaqueTokens.length} read-only file(s)? ${unknownPaths.length} unknown item(s) will remain pending.`,
                    { modal: true, detail: 'Acknowledge advances only the saved file identity. It does not write, delete, restore, or copy read-only file content.' },
                    'Accept / Acknowledge',
                    'Cancel'
                );
                if (answer !== 'Accept / Acknowledge') {
                    const results: ActionResult[] = [
                        ...textTokens.map(token => ({ filePath: token.filePath, status: 'cancelled', reason: 'Accept cancelled' } as ActionResult)),
                        ...opaqueTokens.map(token => ({ filePath: token.filePath, status: 'cancelled', reason: 'Acknowledge cancelled' } as ActionResult)),
                        ...unknownPaths.map(filePath => ({ filePath, status: 'needsAttention', reason: 'Review evidence is incomplete' } as ActionResult))
                    ];
                    return reportMixedBatch('Accept cancelled', {
                        results, succeeded: 0, failed: results.length,
                        accepted: 0, acknowledged: 0, reverted: 0,
                        needsConfirmation: 0, needsAttention: unknownPaths.length,
                        failures: 0, conflicts: 0, cancelled: textTokens.length + opaqueTokens.length
                    });
                }
            }
            return reportMixedBatch('Accept result', await diffTracker.acceptAllPendingChanges(textTokens, opaqueTokens, unknownPaths));
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.acknowledgeOpaqueChange', async (
            filePathOrItem: string | any,
            opaqueToken?: OpaqueReviewToken
        ) => {
            const filePath = extractFilePath(filePathOrItem);
            if (!filePath) { return; }
            const token = opaqueToken ?? (typeof filePathOrItem === 'string'
                ? diffTracker.getOpaqueReviewToken(filePath)
                : filePathOrItem?.opaqueReviewToken);
            if (!token) { return missingReview(filePath); }
            const answer = await vscode.window.showWarningMessage(
                `Acknowledge the read-only change for ${displayFileName(filePath)}?`,
                { modal: true, detail: 'This advances only the saved identity baseline. It does not write, delete, restore, or copy the file contents, and it creates no Undo record.' },
                'Acknowledge',
                'Cancel'
            );
            if (answer !== 'Acknowledge') {
                return { filePath, status: 'cancelled', reason: 'Acknowledge cancelled' } satisfies ActionResult;
            }
            const result = reportAction(await diffTracker.acknowledgeOpaqueChange(filePath, token));
            if (result.status === 'success') {
                void vscode.window.showInformationMessage('Code Diff Tracker: Read-only change acknowledged.');
            }
            return result;
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.undoLastRevert', async () => {
            const result = await diffTracker.undoLastRevert();
            if (result.results.length === 0) {
                void vscode.window.showInformationMessage('Code Diff Tracker: No recent Revert is available to undo.');
                return result;
            }
            return reportBatch('Restored', result);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.rebuildGitBaseline', async () => {
            const paused = diffTracker.getPausedGitRepositories();
            if (paused.length === 0) {
                void vscode.window.showInformationMessage('Code Diff Tracker: No Git repository review is paused.');
                return false;
            }
            const selected = paused.length === 1
                ? paused[0]
                : await vscode.window.showQuickPick(
                    paused.map(item => ({
                        label: displayFileName(item.repoRoot),
                        description: item.reason,
                        detail: item.repoRoot,
                        value: item
                    })),
                    { placeHolder: 'Choose the paused repository to archive and rebuild' }
                ).then(item => item?.value);
            return selected ? rebuildGitBaseline(selected.repoRoot) : false;
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.revertFile', async (filePathOrItem: string | any, reviewToken?: ReviewToken) => {
            const filePath = typeof filePathOrItem === 'string'
                ? filePathOrItem
                : filePathOrItem?.filePath;

            if (!filePath) {
                return;
            }

            // Tree items carry the version shown; direct command invocations capture
            // their target before opening the modal and never recapture afterward.
            const token = reviewToken ?? (typeof filePathOrItem === 'string'
                ? diffTracker.getReviewToken(filePath) : filePathOrItem.reviewToken);
            if (!token) { return missingReview(filePath); }

            const answer = await vscode.window.showWarningMessage(
                `Revert changes for ${displayFileName(filePath)}? Review pending changes and save any dirty editors first.`,
                { modal: true },
                'Revert',
                'Cancel'
            );

            if (answer !== 'Revert') {
                return { status: 'cancelled', filePath, reason: 'Revert cancelled' } satisfies ActionResult;
            }

            const result = reportAction(await diffTracker.revertFile(filePath, token));
            if (result.status === 'success') {
                void vscode.window.showInformationMessage('File reverted to original content');
            }
            return result;
        })
    );

    // Open the original file (not the diff view)
    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.openOriginalFile', async (filePathOrItem: string | any) => {
            const filePath = extractFilePath(filePathOrItem);

            if (!filePath) {
                return;
            }

            const uri = vscode.Uri.file(filePath);
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.openDiffDefault', async (filePathOrItem: string | any) => {
            const filePath = extractFilePath(filePathOrItem);
            if (!filePath) {
                return;
            }

            const isDeleted = isDeletedReview(filePath, filePathOrItem);
            const defaultMode = getDefaultOpenMode();

            if (isDeleted && (defaultMode === 'original' || defaultMode === 'splitOriginalWebview')) {
                await vscode.commands.executeCommand('diffTracker.showWebviewDiff', filePath);
                return;
            }

            switch (defaultMode) {
                case 'inline':
                    await vscode.commands.executeCommand('diffTracker.showInlineDiff', filePath);
                    break;
                case 'sideBySide':
                    await vscode.commands.executeCommand('diffTracker.showSideBySideDiff', filePath);
                    break;
                case 'original':
                    await vscode.commands.executeCommand('diffTracker.openOriginalFile', filePath);
                    break;
                case 'splitOriginalWebview':
                    await vscode.commands.executeCommand('diffTracker.showOriginalAndWebviewSplit', filePath);
                    break;
                case 'webview':
                default:
                    await vscode.commands.executeCommand('diffTracker.showWebviewDiff', filePath);
                    break;
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.clearDiffs', async () => {
            const wasRecording = diffTracker.getIsRecording();
            const answer = await vscode.window.showWarningMessage(
                wasRecording
                    ? 'Clear Diffs by rebuilding the review baseline from the current workspace state?'
                    : 'Clear the saved review baseline, pending review, and recovery history while keeping recording stopped?',
                {
                    modal: true,
                    detail: wasRecording
                        ? 'The operation does not modify workspace files. It succeeds only after the replacement baseline is persisted; pending review and recovery history are then cleared.'
                        : 'Workspace files are not modified. Recording remains stopped. This does not guarantee secure erasure of prior backup or filesystem remnants.'
                },
                'Clear Diffs',
                'Cancel'
            );
            if (answer !== 'Clear Diffs') { return false; }
            if (diffTracker.getIsRecording() !== wasRecording) {
                void vscode.window.showWarningMessage(
                    'Code Diff Tracker: Recording state changed while Clear Diffs was awaiting confirmation; nothing was cleared.'
                );
                return false;
            }
            if (!await diffTracker.resetBaselineToCurrentState()) {
                vscode.window.showWarningMessage('Code Diff Tracker: Clear Diffs did not complete. The review remains unavailable or preserved according to the current baseline state; check persistence and coverage warnings.');
                return false;
            }
            refreshChangesTree();
            decorationManager.clearAllDecorations();
            vscode.window.showInformationMessage(wasRecording
                ? 'Code Diff Tracker: Review baseline rebuilt from the current workspace state; workspace files were not modified.'
                : 'Code Diff Tracker: Saved baseline, pending review, and recovery history cleared; recording remains stopped.');
            return true;
        })
    );

    // Block-wise revert command
    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.revertBlock', async (filePath: string, blockRef: string | number, token?: ReviewToken) => {
            if (!token) { return missingReview(filePath); }
            return reportAction(await diffTracker.revertBlock(filePath, blockRef, token));
        })
    );

    // Block-wise keep command
    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.keepBlock', async (filePath: string, blockRef: string | number, token?: ReviewToken) => {
            if (!token) { return missingReview(filePath); }
            return reportAction(await diffTracker.keepBlock(filePath, blockRef, token));
        })
    );

    // Navigate to block
    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.goToBlock', async (filePath: string, blockRef: string | number) => {
            const blocks = diffTracker.getChangeBlocks(filePath);
            if (blocks.length === 0) {
                return;
            }

            let block;
            if (typeof blockRef === 'number') {
                if (blockRef < 0 || blockRef >= blocks.length) {
                    return;
                }
                block = blocks[blockRef];
            } else {
                block = blocks.find(item => item.blockId === blockRef);
                if (!block) {
                    return;
                }
            }

            const uri = vscode.Uri.file(filePath);
            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc);
            const line = Math.max(0, block.startLine - 1);
            const position = new vscode.Position(line, 0);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
        })
    );

    // Revert all blocks in a file
    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.revertAllBlocksInFile', async (filePath: string, token?: ReviewToken) => {
            if (!token) { return missingReview(filePath); }
            return reportAction(await diffTracker.revertFile(filePath, token));
        })
    );

    // Keep all blocks in a file (accept all changes)
    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.keepAllBlocksInFile', async (filePath: string, token?: ReviewToken) => {
            if (!token) { return missingReview(filePath); }
            return reportAction(await diffTracker.keepAllChangesInFile(filePath, token));
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.showInlineDiffActive', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.uri.scheme !== 'file') {
                return;
            }

            await vscode.commands.executeCommand('diffTracker.showInlineDiff', editor.document.uri.fsPath);
        })
    );

    // Webview-based diff commands
    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.showWebviewDiff', async (filePathOrItem: string | any) => {
            const filePath = extractFilePath(filePathOrItem);

            if (!filePath) {
                return;
            }

            WebviewDiffPanel.createOrShow(context.extensionUri, diffTracker, filePath);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.showOriginalAndWebviewSplit', async (filePathOrItem: string | any) => {
            const filePath = extractFilePath(filePathOrItem);
            if (!filePath) {
                return;
            }

            if (isDeletedReview(filePath, filePathOrItem)) {
                await vscode.commands.executeCommand('diffTracker.showWebviewDiff', filePath);
                return;
            }

            const uri = vscode.Uri.file(filePath);
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, {
                viewColumn: vscode.ViewColumn.One,
                preserveFocus: true,
                preview: false
            });

            WebviewDiffPanel.createOrShow(
                context.extensionUri,
                diffTracker,
                filePath,
                vscode.ViewColumn.Two
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.selectDefaultOpenMode', async () => {
            const config = vscode.workspace.getConfiguration('diffTracker');
            const current = getDefaultOpenMode();
            const items: Array<{ label: string; description: string; value: DefaultOpenMode }> = [
                { label: 'Webview', description: 'Interactive diff panel', value: 'webview' },
                { label: 'Inline (read-only)', description: 'Virtual inline diff document', value: 'inline' },
                { label: 'Side-by-Side', description: 'VS Code built-in diff editor', value: 'sideBySide' },
                { label: 'Original', description: 'Open original file directly', value: 'original' },
                { label: 'Split: Original | Webview', description: 'Left original file, right webview diff', value: 'splitOriginalWebview' }
            ];

            const selected = await vscode.window.showQuickPick(
                items.map(item => ({
                    label: item.value === current ? `$(check) ${item.label}` : item.label,
                    description: item.description,
                    value: item.value
                })),
                { placeHolder: 'Select default open mode when clicking a changed file' }
            );

            if (!selected) {
                return;
            }

            await config.update('defaultOpenMode', selected.value, vscode.ConfigurationTarget.Global);
            settingsTreeDataProvider.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.showWebviewDiffActive', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.uri.scheme !== 'file') {
                return;
            }

            WebviewDiffPanel.createOrShow(context.extensionUri, diffTracker, editor.document.uri.fsPath);
        })
    );

    const openMonitoringScopeManager = () => {
        WatchExcludePanel.createOrShow(context.extensionUri, diffTracker, monitoringScopeController);
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.manageMonitoringScope', openMonitoringScopeManager),
        // Compatibility alias retained for existing keybindings/scripts.
        vscode.commands.registerCommand('diffTracker.editWatchExcludes', openMonitoringScopeManager),
        vscode.commands.registerCommand('diffTracker.applyPendingScope', async () => {
            const panel = WatchExcludePanel.createOrShow(context.extensionUri, diffTracker, monitoringScopeController);
            await panel.applyInteractively();
        }),
        vscode.commands.registerCommand('diffTracker.retryScopePreparation', async () => {
            const panel = WatchExcludePanel.createOrShow(context.extensionUri, diffTracker, monitoringScopeController);
            await panel.applyInteractively();
        }),
        vscode.commands.registerCommand('diffTracker.migrateLegacyWatchRules', async () => {
            const outcome = await monitoringScopeController.migrateLegacyWatchRules();
            if (outcome.status === 'migrated') {
                void vscode.window.showInformationMessage('Code Diff Tracker: Legacy Global watch rules migrated into this workspace request.');
            } else {
                void vscode.window.showWarningMessage(`Code Diff Tracker: ${outcome.reason ?? outcome.status}`);
                openMonitoringScopeManager();
            }
            settingsTreeDataProvider.refresh();
            return outcome;
        }),
        vscode.commands.registerCommand('diffTracker.restoreEffectiveScopeConfiguration', async () => {
            const answer = await vscode.window.showWarningMessage(
                'Restore Workspace Settings to the currently effective DiffTracker monitoring scope?',
                { modal: true },
                'Restore Effective Scope'
            );
            if (answer === 'Restore Effective Scope') {
                await monitoringScopeController.restoreEffectiveScopeConfiguration();
                settingsTreeDataProvider.refresh();
                return true;
            }
            return false;
        })
    );

    // Update decorations when switching editors
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) {
                decorationManager.updateDecorations(editor);
            }
        })
    );

    const updateVisibleDecorations = (affectedFiles?: Set<string>) => {
        vscode.window.visibleTextEditors.forEach(editor => {
            if (
                affectedFiles &&
                editor.document.uri.scheme === 'file' &&
                !affectedFiles.has(editor.document.uri.fsPath)
            ) {
                return;
            }
            decorationManager.updateDecorations(editor);
        });
    };

    // Update decorations when changes are tracked
    context.subscriptions.push(
        diffTracker.onDidTrackChanges((event: TrackChangesEvent) => {
            refreshChangesTree();

            if (event.fullRefresh) {
                updateVisibleDecorations();
                return;
            }

            const affectedFiles = new Set<string>([
                ...event.changedFiles,
                ...event.removedFiles
            ]);
            if (affectedFiles.size === 0) {
                return;
            }

            updateVisibleDecorations(affectedFiles);
        })
    );

    context.subscriptions.push(
        diffTracker.onDidChangeBaselineState(() => {
            refreshChangesTree();
        })
    );

    gitContextMonitor = new GitContextMonitor(event => { void handleGitContextEvent(event); });
    context.subscriptions.push(gitContextMonitor);
    const gitContextAvailable = await gitContextMonitor.start();
    if (gitContextAvailable && gitContextMonitor.isReady()) {
        if (restoreOutcome === 'restored' || restoreOutcome === 'recovered' || restoreOutcome === 'incomplete') {
            diffTracker.reconcileRestoredGitContexts(gitContextMonitor.getSnapshots());
        }
        diffTracker.setGitContextPending(false);
    } else if (!gitContextAvailable) {
        diffTracker.setGitContextPending(false);
    }
    if (!gitContextAvailable && !runningExtensionTests) {
        void vscode.window.showWarningMessage(
            'Code Diff Tracker: Git context monitoring is unavailable. Ordinary review continues, but branch/worktree safety detection is disabled.'
        );
    }

    refreshChangesTree();
    await vscode.commands.executeCommand('setContext', 'diffTracker.isRecording', diffTracker.getIsRecording());

    if (restoreOutcome === 'restored' || restoreOutcome === 'recovered' || restoreOutcome === 'incomplete') {
        updateVisibleDecorations();
        if (restoreOutcome === 'recovered') {
            void vscode.window.showWarningMessage(diffTracker.getPersistenceIssue() ?? 'Code Diff Tracker restored the last-good review session.');
        } else if (restoreOutcome === 'incomplete') {
            void vscode.window.showWarningMessage(diffTracker.getPersistenceIssue() ?? 'Code Diff Tracker restored the review in paused mode. Rebuild the baseline before review actions.');
        }
    } else if (restoreOutcome === 'blocked') {
        void startRecordingFlow();
    } else {
        void startRecordingFlow();
    }

    // Register disposables
    context.subscriptions.push(statusBarManager);
    context.subscriptions.push(originalContentProvider);
}

export async function deactivate(): Promise<void> {
    if (gitContextMonitor) {
        gitContextMonitor.dispose();
    }
    if (diffTracker) {
        await diffTracker.dispose();
    }
    if (decorationManager) {
        decorationManager.dispose();
    }
    if (statusBarManager) {
        statusBarManager.dispose();
    }
    if (originalContentProvider) {
        originalContentProvider.dispose();
    }
    if (inlineContentProvider) {
        inlineContentProvider.dispose();
    }
    if (codeLensProvider) {
        codeLensProvider.dispose();
    }
    if (settingsTreeDataProvider) {
        settingsTreeDataProvider.dispose();
    }
    if (diffTreeDataProvider) {
        diffTreeDataProvider.dispose();
    }
}
