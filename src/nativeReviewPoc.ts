import * as vscode from 'vscode';
import { ActionResult, ChangeBlock, DiffTracker, FileDiff } from './diffTracker';

interface NativeLineChangeLike {
    originalStartLineNumber?: number;
    originalEndLineNumber?: number;
    modifiedStartLineNumber?: number;
    modifiedEndLineNumber?: number;
}

export interface NativeSelectionProbe {
    filePath: string;
    selections: Array<{ startLine: number; endLine: number }>;
    touchedBlocks: Array<{ blockId: string; startLine: number; endLine: number; type: ChangeBlock['type'] }>;
    exactBlockIds: string[];
    partialBlockIds: string[];
}

type NativeReviewAction = 'keep' | 'revert';

export class NativeReviewPoc implements vscode.Disposable, vscode.QuickDiffProvider {
    public readonly label = 'Code Diff Tracker Baseline';

    private readonly sourceControl: vscode.SourceControl;
    private readonly pendingGroup: vscode.SourceControlResourceGroup;
    private readonly output: vscode.OutputChannel;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        private readonly diffTracker: DiffTracker,
        private readonly reportAction: (result: ActionResult) => ActionResult
    ) {
        this.sourceControl = vscode.scm.createSourceControl(
            'diffTrackerReview',
            'Code Diff Tracker Review (PoC)'
        );
        this.pendingGroup = this.sourceControl.createResourceGroup('pendingReview', 'Pending Review');
        this.sourceControl.quickDiffProvider = this;
        this.output = vscode.window.createOutputChannel('Code Diff Tracker Native Review PoC');

        this.disposables.push(
            this.sourceControl,
            this.output,
            this.diffTracker.onDidTrackChanges(() => this.refresh()),
            vscode.commands.registerCommand('diffTracker.nativeReviewPoc.openChanges', () => this.openChanges()),
            vscode.commands.registerCommand('diffTracker.nativeReviewPoc.openFile', (filePathOrUri: string | vscode.Uri) => {
                const filePath = filePathOrUri instanceof vscode.Uri ? filePathOrUri.fsPath : filePathOrUri;
                return this.openFile(filePath);
            }),
            vscode.commands.registerCommand(
                'diffTracker.nativeReviewPoc.keepChange',
                (uri: vscode.Uri, changes: NativeLineChangeLike[], index: number) =>
                    this.handleQuickDiffAction(uri, changes, index, 'keep')
            ),
            vscode.commands.registerCommand(
                'diffTracker.nativeReviewPoc.revertChange',
                (uri: vscode.Uri, changes: NativeLineChangeLike[], index: number) =>
                    this.handleQuickDiffAction(uri, changes, index, 'revert')
            ),
            vscode.commands.registerCommand(
                'diffTracker.nativeReviewPoc.keepSelectedBlock',
                () => this.applySelectedBlock('keep')
            ),
            vscode.commands.registerCommand(
                'diffTracker.nativeReviewPoc.revertSelectedBlock',
                () => this.applySelectedBlock('revert')
            ),
            vscode.commands.registerCommand('diffTracker.nativeReviewPoc.probeSelection', () => {
                const probe = this.probeSelection();
                if (probe) {
                    this.output.appendLine(JSON.stringify(probe, null, 2));
                    this.output.show(true);
                }
                return probe;
            })
        );

        this.refresh();
    }

    public provideOriginalResource(uri: vscode.Uri): vscode.Uri | undefined {
        if (uri.scheme !== 'file') {
            return undefined;
        }
        const change = this.diffTracker.getTrackedChanges().find(item => item.filePath === uri.fsPath);
        if (!change || change.unavailableReason || this.diffTracker.getOriginalContent(uri.fsPath) === undefined) {
            return undefined;
        }
        return uri.with({ scheme: 'diff-tracker-original' });
    }

    public getResourcePaths(): string[] {
        return this.pendingGroup.resourceStates.map(state => state.resourceUri.fsPath);
    }

    public async openChanges(): Promise<{ mode: 'multi-diff' | 'single-diff-fallback' | 'webview-fallback' | 'empty'; count: number }> {
        const changes = this.nativeReviewableChanges();
        if (changes.length === 0) {
            void vscode.window.showInformationMessage('Code Diff Tracker Native Review PoC: no reviewable text changes.');
            return { mode: 'empty', count: 0 };
        }

        const resources = changes.map(change => this.resourceTuple(change));
        try {
            await vscode.commands.executeCommand(
                'vscode.changes',
                'Code Diff Tracker Native Review (PoC)',
                resources
            );
            return { mode: 'multi-diff', count: resources.length };
        } catch {
            const first = changes[0];
            if (first.isDeleted) {
                await vscode.commands.executeCommand('diffTracker.showWebviewDiff', first.filePath);
                return { mode: 'webview-fallback', count: resources.length };
            }
            await this.openFile(first.filePath, false);
            return { mode: 'single-diff-fallback', count: resources.length };
        }
    }

    public async openFile(filePath: string, preferChangesEditor = true): Promise<void> {
        const change = this.diffTracker.getTrackedChanges().find(item => item.filePath === filePath);
        if (!change) {
            return;
        }
        if (change.unavailableReason) {
            await vscode.commands.executeCommand('diffTracker.showWebviewDiff', filePath);
            return;
        }

        const currentUri = vscode.Uri.file(filePath);
        const originalUri = currentUri.with({ scheme: 'diff-tracker-original' });

        if (change.isDeleted && preferChangesEditor) {
            try {
                await vscode.commands.executeCommand(
                    'vscode.changes',
                    'Code Diff Tracker Native Review (PoC)',
                    [this.resourceTuple(change)]
                );
                return;
            } catch {
                await vscode.commands.executeCommand('diffTracker.showWebviewDiff', filePath);
                return;
            }
        }

        if (change.isDeleted) {
            await vscode.commands.executeCommand('diffTracker.showWebviewDiff', filePath);
            return;
        }

        await vscode.commands.executeCommand(
            'vscode.diff',
            originalUri,
            currentUri,
            `Baseline ↔ Current: ${change.fileName}`
        );
    }

    public async handleQuickDiffAction(
        uri: vscode.Uri,
        changes: NativeLineChangeLike[],
        index: number,
        action: NativeReviewAction
    ): Promise<ActionResult> {
        const filePath = uri.fsPath;
        const nativeChange = changes?.[index];
        if (uri.scheme !== 'file' || !nativeChange) {
            return this.reportAction({
                filePath,
                status: 'conflict',
                reason: 'Native Quick Diff did not provide a usable text change'
            });
        }

        const block = this.resolveBlockForNativeChange(filePath, nativeChange);
        const token = this.diffTracker.getReviewToken(filePath);
        if (!block || !token) {
            return this.reportAction({
                filePath,
                status: 'conflict',
                reason: 'Native Quick Diff hunk could not be mapped uniquely to the current tracker block'
            });
        }

        const result = action === 'keep'
            ? await this.diffTracker.keepBlock(filePath, block.blockId, token)
            : await this.diffTracker.revertBlock(filePath, block.blockId, token);
        return this.reportAction(result);
    }

    public probeSelection(editor = vscode.window.activeTextEditor): NativeSelectionProbe | undefined {
        if (!editor || editor.document.uri.scheme !== 'file') {
            return undefined;
        }

        const filePath = editor.document.uri.fsPath;
        const blocks = this.diffTracker.getChangeBlocks(filePath);
        if (blocks.length === 0) {
            return {
                filePath,
                selections: [],
                touchedBlocks: [],
                exactBlockIds: [],
                partialBlockIds: []
            };
        }

        const selections = editor.selections
            .filter(selection => !selection.isEmpty)
            .map(selection => this.selectionLines(selection));

        const touched = blocks.filter(block =>
            selections.some(range => this.overlaps(range.startLine, range.endLine, block.startLine, block.endLine))
        );
        const exactBlockIds = touched
            .filter(block => selections.some(range => range.startLine <= block.startLine && range.endLine >= block.endLine))
            .map(block => block.blockId);
        const exact = new Set(exactBlockIds);
        const partialBlockIds = touched.filter(block => !exact.has(block.blockId)).map(block => block.blockId);

        return {
            filePath,
            selections,
            touchedBlocks: touched.map(block => ({
                blockId: block.blockId,
                startLine: block.startLine,
                endLine: block.endLine,
                type: block.type
            })),
            exactBlockIds,
            partialBlockIds
        };
    }

    public async applySelectedBlock(action: NativeReviewAction): Promise<ActionResult> {
        const probe = this.probeSelection();
        const filePath = probe?.filePath ?? vscode.window.activeTextEditor?.document.uri.fsPath ?? '';
        if (!probe || probe.selections.length === 0) {
            return this.reportAction({
                filePath,
                status: 'conflict',
                reason: 'Select changed lines in the modified side of a diff editor first'
            });
        }
        if (probe.partialBlockIds.length > 0) {
            return this.reportAction({
                filePath,
                status: 'conflict',
                reason: 'The selection covers only part of a tracker block. Native selection is available, but line-granular Keep/Revert requires a backend line-action API.'
            });
        }
        if (probe.exactBlockIds.length !== 1 || probe.touchedBlocks.length !== 1) {
            return this.reportAction({
                filePath,
                status: 'conflict',
                reason: 'PoC selection actions intentionally operate on one complete tracker block at a time'
            });
        }

        const block = this.diffTracker.getChangeBlocks(filePath).find(item => item.blockId === probe.exactBlockIds[0]);
        const token = this.diffTracker.getReviewToken(filePath);
        if (!block || !token) {
            return this.reportAction({
                filePath,
                status: 'conflict',
                reason: 'Selection review is stale; refresh the native diff and try again'
            });
        }

        const result = action === 'keep'
            ? await this.diffTracker.keepBlock(filePath, block.blockId, token)
            : await this.diffTracker.revertBlock(filePath, block.blockId, token);
        return this.reportAction(result);
    }

    public dispose(): void {
        while (this.disposables.length > 0) {
            this.disposables.pop()?.dispose();
        }
    }

    private refresh(): void {
        this.pendingGroup.resourceStates = this.diffTracker.getTrackedChanges().map(change => ({
            resourceUri: vscode.Uri.file(change.filePath),
            command: {
                title: 'Open Native Review',
                command: 'diffTracker.nativeReviewPoc.openFile',
                arguments: [change.filePath]
            }
        }));
    }

    private nativeReviewableChanges(): FileDiff[] {
        return this.diffTracker.getTrackedChanges().filter(change =>
            !change.unavailableReason && this.diffTracker.getOriginalContent(change.filePath) !== undefined
        );
    }

    private resourceTuple(change: FileDiff): [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined] {
        const currentUri = vscode.Uri.file(change.filePath);
        return [
            currentUri,
            currentUri.with({ scheme: 'diff-tracker-original' }),
            change.isDeleted ? undefined : currentUri
        ];
    }

    private selectionLines(selection: vscode.Selection): { startLine: number; endLine: number } {
        const startLine = selection.start.line + 1;
        let endLine = selection.end.line + 1;
        if (selection.end.character === 0 && selection.end.line > selection.start.line) {
            endLine -= 1;
        }
        return { startLine, endLine: Math.max(startLine, endLine) };
    }

    private resolveBlockForNativeChange(filePath: string, change: NativeLineChangeLike): ChangeBlock | undefined {
        const blocks = this.diffTracker.getChangeBlocks(filePath);
        if (blocks.length === 0) {
            return undefined;
        }

        const modifiedRange = this.nativeRange(change.modifiedStartLineNumber, change.modifiedEndLineNumber);
        if (modifiedRange) {
            const currentMatches = blocks.filter(block =>
                this.overlaps(modifiedRange.startLine, modifiedRange.endLine, block.startLine, block.endLine)
            );
            if (currentMatches.length === 1) {
                return currentMatches[0];
            }
        }

        const originalRange = this.nativeRange(change.originalStartLineNumber, change.originalEndLineNumber);
        if (originalRange) {
            const originalMatches = blocks.filter(block => {
                const originalLines = block.changes
                    .map(item => item.originalLineNumber)
                    .filter((line): line is number => line !== undefined);
                if (originalLines.length === 0) {
                    return false;
                }
                return this.overlaps(
                    originalRange.startLine,
                    originalRange.endLine,
                    Math.min(...originalLines),
                    Math.max(...originalLines)
                );
            });
            if (originalMatches.length === 1) {
                return originalMatches[0];
            }
        }

        return blocks.length === 1 ? blocks[0] : undefined;
    }

    private nativeRange(start?: number, end?: number): { startLine: number; endLine: number } | undefined {
        const positiveStart = typeof start === 'number' && start > 0 ? start : undefined;
        const positiveEnd = typeof end === 'number' && end > 0 ? end : undefined;
        if (positiveStart === undefined && positiveEnd === undefined) {
            return undefined;
        }
        const startLine = positiveStart ?? positiveEnd!;
        return {
            startLine,
            endLine: Math.max(startLine, positiveEnd ?? startLine)
        };
    }

    private overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
        return aStart <= bEnd && bStart <= aEnd;
    }
}
