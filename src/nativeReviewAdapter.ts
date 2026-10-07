import * as vscode from 'vscode';
import { ActionResult, DiffTracker, FileDiff, ReviewToken } from './diffTracker';
import { displayFileName } from './utils/displayPath';

const BASE_SCHEME = 'diff-tracker-review-base';
const CURRENT_SCHEME = 'diff-tracker-review-current';
const MAX_MULTI_DIFF_RESOURCES = 50;

/** Read-only native projections. The tracker remains the only review authority. */
export class NativeReviewAdapter implements vscode.Disposable, vscode.TextDocumentContentProvider, vscode.QuickDiffProvider {
    private readonly disposables: vscode.Disposable[] = [];
    private sourceControl: vscode.SourceControl | undefined;

    constructor(
        private readonly tracker: DiffTracker,
        private readonly reportAction: (result: ActionResult) => ActionResult
    ) {
        this.disposables.push(
            vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, this),
            vscode.workspace.registerTextDocumentContentProvider(CURRENT_SCHEME, this),
            vscode.commands.registerCommand('diffTracker.nativeReview.openFile', (target: unknown) => this.openFile(target)),
            // Stable Quick Diff menus have no review-version provenance. This is
            // navigation only: deliberately ignore all supplied hunk coordinates.
            vscode.commands.registerCommand('diffTracker.nativeReview.openFromQuickDiff', (uri: vscode.Uri) =>
                uri instanceof vscode.Uri && uri.scheme === 'file' ? this.openFile(uri) : undefined),
            vscode.commands.registerCommand('diffTracker.nativeReview.openChanges', () => this.openChanges()),
            vscode.commands.registerCommand('diffTracker.nativeReview.keepFile', (context?: unknown) => this.applyFile('keep', context)),
            vscode.commands.registerCommand('diffTracker.nativeReview.revertFile', (context?: unknown) => this.applyFile('revert', context)),
            vscode.commands.registerCommand('diffTracker.nativeReview.keepSelectedBlock', (context?: unknown) => this.applyBlock('keep', context)),
            vscode.commands.registerCommand('diffTracker.nativeReview.revertSelectedBlock', (context?: unknown) => this.applyBlock('revert', context)),
            vscode.window.onDidChangeActiveTextEditor(editor => this.publishMenuContext(editor)),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('diffTracker.nativeQuickDiff')) { this.configureQuickDiff(); }
            })
        );
        this.publishMenuContext(vscode.window.activeTextEditor);
        this.configureQuickDiff();
    }

    private publishMenuContext(editor: vscode.TextEditor | undefined): void {
        // Multi Diff's menu scope does not reliably publish resourceScheme for
        // its focused child. This is visibility only; handlers still require
        // the clicked URI, active document, immutable content and backend token.
        void vscode.commands.executeCommand('setContext', 'diffTracker.nativeReviewContext',
            editor?.document.uri.scheme === CURRENT_SCHEME);
    }

    private configureQuickDiff(): void {
        const enabled = vscode.workspace.getConfiguration('diffTracker').get<boolean>('nativeQuickDiff', false);
        if (!enabled) { this.sourceControl?.dispose(); this.sourceControl = undefined; return; }
        if (this.sourceControl) { return; }
        this.sourceControl = vscode.scm.createSourceControl('diffTrackerNativeReview', 'Code Diff Tracker Review');
        this.sourceControl.inputBox.visible = false;
        this.sourceControl.quickDiffProvider = this;
    }

    public provideOriginalResource(uri: vscode.Uri): vscode.Uri | undefined {
        if (uri.scheme !== 'file') { return undefined; }
        const filePath = this.tracker.getOriginalFilePath(uri.fsPath);
        if (!filePath) { return undefined; }
        const pending = this.tracker.getTrackedChange(filePath);
        if (pending && !this.tracker.getReviewToken(filePath)) { return undefined; }
        // Match incremental baseline notifications even before a change exists.
        return vscode.Uri.file(filePath).with({ scheme: 'diff-tracker-original', query: '', fragment: '' });
    }

    private snapshotUri(token: ReviewToken, scheme: string): vscode.Uri {
        return vscode.Uri.file(token.filePath).with({ scheme, query: JSON.stringify(token), fragment: '' });
    }

    private readToken(uri: vscode.Uri): ReviewToken | undefined {
        if (uri.scheme !== BASE_SCHEME && uri.scheme !== CURRENT_SCHEME) { return undefined; }
        try {
            const value: unknown = JSON.parse(uri.query);
            if (!value || typeof value !== 'object') { return undefined; }
            const token = value as ReviewToken;
            if (typeof token.filePath !== 'string' || !Number.isSafeInteger(token.epoch) || token.epoch < 0 ||
                !/^[a-f0-9]{64}$/.test(token.baselineRevision) || !/^[a-f0-9]{64}$/.test(token.currentRevision) ||
                this.snapshotUri(token, uri.scheme).toString() !== uri.toString()) { return undefined; }
            return token;
        } catch { return undefined; }
    }

    private currentReview(token: ReviewToken): FileDiff | undefined {
        const current = this.tracker.getReviewToken(token.filePath);
        if (!current || current.filePath !== token.filePath || current.epoch !== token.epoch ||
            current.baselineRevision !== token.baselineRevision || current.currentRevision !== token.currentRevision) {
            return undefined;
        }
        return this.tracker.getTrackedChanges().find(change => change.filePath === token.filePath);
    }

    public provideTextDocumentContent(uri: vscode.Uri): string {
        const token = this.readToken(uri);
        const change = token && this.currentReview(token);
        // Never refresh an old URI to new content or disguise an error as text.
        // VS Code may keep already-open old snapshots readable; actions recheck.
        if (!change) { throw new Error('Native review is stale or unavailable. Open a new review.'); }
        return uri.scheme === BASE_SCHEME ? change.originalContent : change.currentContent;
    }

    private async openFile(target: unknown): Promise<{ mode: string; count: number }> {
        target ??= vscode.window.activeTextEditor?.document.uri;
        const filePath = typeof target === 'string' ? target
            : target instanceof vscode.Uri ? (target.scheme === 'file' ? target.fsPath : this.readToken(target)?.filePath)
            : target && typeof target === 'object' && 'filePath' in target && typeof target.filePath === 'string' ? target.filePath
            : undefined;
        const token = filePath && this.tracker.getReviewToken(filePath);
        if (!token) {
            const pending = filePath ? this.tracker.getTrackedChange(filePath) : undefined;
            if (pending) {
                await vscode.commands.executeCommand('diffTracker.showWebviewDiff', pending.filePath);
                return { mode: 'existing-review', count: 1 };
            }
            void vscode.window.showInformationMessage('No safely reviewable text change is available here. Use the Changes view for read-only or unknown resources.');
            return { mode: 'unavailable', count: 0 };
        }
        await vscode.commands.executeCommand('vscode.diff',
            this.snapshotUri(token, BASE_SCHEME), this.snapshotUri(token, CURRENT_SCHEME),
            `Review Snapshot: ${displayFileName(token.filePath)}`,
            { preview: false, selection: new vscode.Range(0, 0, 0, 0) });
        return { mode: 'single-diff', count: 1 };
    }

    private async openChanges(): Promise<{ mode: string; count: number }> {
        const tokens = this.tracker.getReviewTokens();
        if (!tokens.length) {
            void vscode.window.showInformationMessage('No safely reviewable text changes. Read-only and unknown resources remain in the Changes view.');
            return { mode: 'empty', count: 0 };
        }
        if (tokens.length <= MAX_MULTI_DIFF_RESOURCES && (await vscode.commands.getCommands(true)).includes('vscode.changes')) {
            try {
                await vscode.commands.executeCommand('vscode.changes', 'Code Diff Tracker Review Snapshots', tokens.map(token => [
                    vscode.Uri.file(token.filePath), this.snapshotUri(token, BASE_SCHEME), this.snapshotUri(token, CURRENT_SCHEME)
                ]));
                return { mode: 'multi-diff', count: tokens.length };
            } catch { /* Older or unsupported hosts retain the single-file path. */ }
        }
        const selected = await vscode.window.showQuickPick(tokens.map(token => ({
            label: displayFileName(token.filePath), description: token.filePath, token
        })), {
            title: tokens.length > MAX_MULTI_DIFF_RESOURCES
                ? 'Native Review opens up to 50 files together; choose one file'
                : 'Multi Diff is unavailable on this host; choose a single-file Diff',
            placeHolder: 'Choose a text change for Native Review'
        });
        if (!selected) { return { mode: 'cancelled', count: tokens.length }; }
        if (!this.currentReview(selected.token)) { return { mode: 'unavailable', count: tokens.length }; }
        await this.openFile(selected.token.filePath);
        return { mode: 'single-diff-fallback', count: tokens.length };
    }

    private activeReview(context?: unknown): { token: ReviewToken; editor: vscode.TextEditor } | undefined {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme !== CURRENT_SCHEME || editor.document.isDirty ||
            !(context instanceof vscode.Uri) || context.toString() !== editor.document.uri.toString()) {
            return undefined;
        }
        const token = this.readToken(editor.document.uri);
        const change = token && this.currentReview(token);
        if (!token || !change || editor.document.getText() !== change.currentContent) { return undefined; }
        return { token, editor };
    }

    private refuse(reason: string): ActionResult {
        return this.reportAction({ filePath: vscode.window.activeTextEditor?.document.uri.fsPath ?? '', status: 'conflict', reason });
    }

    private async applyFile(action: 'keep' | 'revert', context?: unknown): Promise<ActionResult> {
        const review = this.activeReview(context);
        if (!review) { return this.refuse('Focus a current Native Review snapshot; stale or unproven views cannot be changed. Open a new review.'); }
        return this.reportAction(await (action === 'keep'
            ? this.tracker.keepAllChangesInFile(review.token.filePath, review.token)
            : this.tracker.revertFile(review.token.filePath, review.token)));
    }

    private async applyBlock(action: 'keep' | 'revert', context?: unknown): Promise<ActionResult> {
        const review = this.activeReview(context);
        if (!review) { return this.refuse('Focus a current Native Review snapshot; stale or unproven views cannot be changed. Open a new review.'); }
        const { editor, token } = review;
        // editor/context identifies a document, not an editor instance. Two
        // groups showing it can have different selections; never guess which.
        if (vscode.window.visibleTextEditors.filter(candidate =>
            candidate.document.uri.toString() === editor.document.uri.toString()).length > 1) {
            return this.refuse('This snapshot is visible in multiple editors. Close the duplicate or use reviewed-file actions.');
        }
        const selection = editor.selections.length === 1 ? editor.selections[0] : undefined;
        const blocks = selection && !selection.isEmpty ? this.tracker.getChangeBlocks(token.filePath).filter(block => {
            // A current-side range cannot prove which deleted lines were selected.
            if (block.changes.some(change => change.type === 'deleted') ||
                block.startLine < 1 || block.endLine > editor.document.lineCount) { return false; }
            return selection.start.line === block.startLine - 1 && selection.start.character === 0 &&
                ((selection.end.line === block.endLine - 1 &&
                    selection.end.character === editor.document.lineAt(block.endLine - 1).text.length) ||
                 (selection.end.line === block.endLine && selection.end.character === 0 &&
                    block.endLine < editor.document.lineCount));
        }) : [];
        if (blocks.length !== 1) {
            return this.refuse('Select exactly one complete changed block, including whole lines. Partial, multiple, or deleted-line selections are unsupported; use reviewed-file actions instead.');
        }
        return this.reportAction(await (action === 'keep'
            ? this.tracker.keepBlock(token.filePath, blocks[0].blockId, token)
            : this.tracker.revertBlock(token.filePath, blocks[0].blockId, token)));
    }

    public dispose(): void {
        this.publishMenuContext(undefined);
        this.sourceControl?.dispose();
        this.sourceControl = undefined;
        while (this.disposables.length) { this.disposables.pop()?.dispose(); }
    }
}
