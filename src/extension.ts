import { displayFileName } from './utils/displayPath';
import * as vscode from 'vscode';
import { ActionResult, BatchActionResult, DiffTracker, ReviewToken, TrackChangesEvent } from './diffTracker';
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

export async function activate(context: vscode.ExtensionContext) {
    const runningExtensionTests = context.extensionMode === vscode.ExtensionMode.Test;

    // Initialize services
    diffTracker = new DiffTracker(context.storageUri);
    const restoreOutcome = await diffTracker.restorePersistedState();
    decorationManager = new DecorationManager(diffTracker);
    statusBarManager = new StatusBarManager(diffTracker);
    originalContentProvider = new OriginalContentProvider(diffTracker);
    inlineContentProvider = new InlineContentProvider(diffTracker);
    codeLensProvider = new DiffCodeLensProvider(diffTracker);
    settingsTreeDataProvider = new SettingsTreeDataProvider();

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

    const startRecordingFlow = async (): Promise<boolean> => {
        if (diffTracker.isRecoveryBlocked()) {
            const answer = await vscode.window.showErrorMessage(
                'Diff Tracker could not validate the saved review session. It remains preserved and recording is paused.',
                { modal: true },
                'Discard Saved Session and Rebuild'
            );
            if (answer !== 'Discard Saved Session and Rebuild' || !await diffTracker.discardRecoveryState()) {
                return false;
            }
        } else if (!diffTracker.getIsRecording() && diffTracker.getBaselineState() === 'building') {
            const answer = await vscode.window.showWarningMessage(
                'Diff Tracker recovered an incomplete or different-workspace baseline. Starting will discard that review and build a new baseline.',
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
            void vscode.window.showWarningMessage('Diff Tracker: The Git repository is unavailable; its preserved review remains paused.');
            return false;
        }
        if (snapshot.inProgress) {
            void vscode.window.showWarningMessage('Diff Tracker: Finish or abort the Git merge/rebase before rebuilding this repository baseline.');
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
        const rebuilt = await diffTracker.rebuildRepositoryBaseline(repoRoot, snapshot);
        if (rebuilt) {
            refreshReview();
            void vscode.window.showInformationMessage('Diff Tracker: The repository review was archived and its baseline rebuilt.');
        } else {
            void vscode.window.showWarningMessage(
                'Diff Tracker did not rebuild the repository. Its review remains paused; save dirty editors, wait for Git to become stable, and try again.'
            );
        }
        return rebuilt;
    };

    const handleGitContextEvent = async (event: GitContextEvent): Promise<void> => {
        if (event.kind === 'ready') {
            diffTracker.reconcileRestoredGitContexts(event.contexts);
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
                `Diff Tracker: ${reason}`,
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
                trackedChanges: diffTracker.getTrackedChanges(),
                gitPauses: diffTracker.getPausedGitRepositories()
            })),
            vscode.commands.registerCommand('diffTracker._testRevertFile', (filePath: string) => {
                const token = diffTracker.getReviewToken(filePath);
                return token ? diffTracker.revertFile(filePath, token) : undefined;
            }),
            vscode.commands.registerCommand('diffTracker._testRevertBlock', (filePath: string) => {
                const token = diffTracker.getReviewToken(filePath);
                const block = diffTracker.getChangeBlocks(filePath)[0];
                return token && block ? diffTracker.revertBlock(filePath, block.blockId, token) : undefined;
            }),
            vscode.commands.registerCommand('diffTracker._testRevertAll', () => {
                return diffTracker.revertAllChanges(diffTracker.getReviewTokens());
            }),
            vscode.commands.registerCommand('diffTracker._testUndoLastRevert', () => diffTracker.undoLastRevert()),
            vscode.commands.registerCommand('diffTracker._testRebuildGitBaseline', (repoRoot: string) => {
                const snapshot = gitContextMonitor?.getSnapshot(repoRoot);
                return snapshot ? diffTracker.rebuildRepositoryBaseline(repoRoot, snapshot) : false;
            })
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
            const tokens = reviewTokens ?? diffTracker.getReviewTokens();
            const changes = tokens;
            if (changes.length === 0) {
                return { results: [], succeeded: 0, failed: 0 } satisfies BatchActionResult;
            }

            // Confirm with user
            const answer = await vscode.window.showWarningMessage(
                `Revert all ${changes.length} file(s) to their original state? Review pending changes and save any dirty editors first.`,
                { modal: true },
                'Revert All',
                'Cancel'
            );

            if (answer === 'Revert All') {
                return reportBatch('Reverted', await diffTracker.revertAllChanges(tokens));
            }
            return {
                results: changes.map(change => ({ filePath: change.filePath, status: 'cancelled', reason: 'Revert cancelled' })),
                succeeded: 0,
                failed: changes.length
            } satisfies BatchActionResult;
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.keepAllChanges', async (reviewTokens?: ReviewToken[]) => {
            const tokens = reviewTokens ?? diffTracker.getReviewTokens();
            const changes = tokens;
            if (changes.length === 0) {
                return { results: [], succeeded: 0, failed: 0 } satisfies BatchActionResult;
            }

            return reportBatch('Accepted', await diffTracker.keepAllChanges(tokens));
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.undoLastRevert', async () => {
            const result = await diffTracker.undoLastRevert();
            if (result.results.length === 0) {
                void vscode.window.showInformationMessage('Diff Tracker: No recent Revert is available to undo.');
                return result;
            }
            return reportBatch('Restored', result);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.rebuildGitBaseline', async () => {
            const paused = diffTracker.getPausedGitRepositories();
            if (paused.length === 0) {
                void vscode.window.showInformationMessage('Diff Tracker: No Git repository review is paused.');
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

            const deletedFromItem = extractIsDeleted(filePathOrItem);
            const deletedFromTracked = diffTracker.getTrackedChanges().find(change => change.filePath === filePath)?.isDeleted === true;
            const isDeleted = deletedFromItem ?? deletedFromTracked;
            const defaultMode = getDefaultOpenMode();

            if (isDeleted && defaultMode === 'original') {
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
            if (diffTracker.getIsRecording()) {
                await diffTracker.resetBaselineToCurrentState();
            } else {
                diffTracker.clearDiffs();
            }
            refreshChangesTree();
            decorationManager.clearAllDecorations();
            vscode.window.showInformationMessage('Diff Tracker: Baseline reset to current workspace state');
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

    context.subscriptions.push(
        vscode.commands.registerCommand('diffTracker.editWatchExcludes', () => {
            WatchExcludePanel.createOrShow(context.extensionUri, diffTracker);
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
    if (gitContextAvailable && gitContextMonitor.isReady() &&
        (restoreOutcome === 'restored' || restoreOutcome === 'recovered' || restoreOutcome === 'incomplete')) {
        diffTracker.reconcileRestoredGitContexts(gitContextMonitor.getSnapshots());
    } else if (!gitContextAvailable && !runningExtensionTests) {
        void vscode.window.showWarningMessage(
            'Diff Tracker: Git context monitoring is unavailable. Ordinary review continues, but branch/worktree safety detection is disabled.'
        );
    }

    refreshChangesTree();
    await vscode.commands.executeCommand('setContext', 'diffTracker.isRecording', diffTracker.getIsRecording());

    if (restoreOutcome === 'restored' || restoreOutcome === 'recovered' || restoreOutcome === 'incomplete') {
        updateVisibleDecorations();
        if (restoreOutcome === 'recovered') {
            void vscode.window.showWarningMessage(diffTracker.getPersistenceIssue() ?? 'Diff Tracker restored the last-good review session.');
        } else if (restoreOutcome === 'incomplete') {
            void vscode.window.showWarningMessage(diffTracker.getPersistenceIssue() ?? 'Diff Tracker restored the review in paused mode. Rebuild the baseline before review actions.');
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
