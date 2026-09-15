import * as vscode from 'vscode';
import { displayFileName } from './utils/displayPath';
import * as Diff from 'diff';
import * as path from 'path';
import * as fs from 'fs';
import { createHash } from 'crypto';
import ignore, { Ignore } from 'ignore';
import { compareGitContexts, GitContextSnapshot } from './gitContext';

export interface FileDiff {
    sourceNote?: string;
    filePath: string;
    fileName: string;
    originalContent: string;
    currentContent: string;
    isDeleted: boolean;
    unavailableReason?: string;
    changes: Diff.Change[];
    timestamp: Date;
}

export interface LineChange {
    lineNumber: number;  // 1-based line number in current document
    type: 'added' | 'deleted' | 'modified' | 'unchanged';
    originalLineNumber?: number;  // Original line number for reference
    oldText?: string;  // Original text content (for modified/deleted lines)
    newText?: string;  // New text content (for modified lines)
    anchorLineNumber?: number;  // For deleted lines: the line in current doc where badge should show
    segmentId?: number; // Internal segment id to keep block grouping stable across EOF edge cases
}

export type InlineLineType = 'added' | 'deleted' | 'unchanged';

export interface InlineDiffView {
    content: string;
    lineTypes: InlineLineType[];
}

export interface ChangeBlock {
    blockId: string;
    blockIndex: number;
    startLine: number;
    endLine: number;
    type: 'added' | 'modified' | 'deleted';
    changes: LineChange[];
}

export interface TrackChangesEvent {
    changedFiles: string[];
    removedFiles: string[];
    fullRefresh: boolean;
    baselineChanged: boolean;
}

interface PendingRemovedLine {
    text: string;
    normalized: string;
    originalLineNumber: number;
}

interface TextLineModel {
    lines: string[];
    hasFinalEol: boolean;
    dominantEol: '\n' | '\r\n' | '\r';
}

interface AutomationSession {
    id: string;
    filePaths: string[];
    allFiles: boolean;
    timeout: NodeJS.Timeout;
}

interface PersistedFileState {
    exists: boolean;
    content: string;
}

interface PersistedRevertItem {
    filePath: string;
    baselineRevision: string;
    before: PersistedFileState;
    after: PersistedFileState;
    saveMode: 'disk' | 'buffer';
}

interface PersistedRevertRecord {
    id: string;
    createdAt: string;
    items: PersistedRevertItem[];
}

interface PreparedBatchRevert {
    record: PersistedRevertRecord;
    retainPaths: Set<string>;
}

interface PersistedTrackerState {
    version: 2;
    isRecording: boolean;
    baselineState: 'building' | 'ready';
    workspaceRoots: string[];
    fileSnapshots: Array<[string, string]>;
    baselineExistingFiles: string[];
    unresolvedBaselineFiles: Array<[string, string]>;
    revertHistory: PersistedRevertRecord[];
    gitContexts: GitContextSnapshot[];
}

export type RestoreOutcome = 'absent' | 'restored' | 'recovered' | 'incomplete' | 'blocked';

export interface ActionResult {
    status: 'success' | 'failed' | 'conflict' | 'cancelled';
    filePath: string;
    reason?: string;
    bufferChanged?: boolean;
}

export interface BatchActionResult {
    results: ActionResult[];
    succeeded: number;
    failed: number;
}

export interface ReviewToken {
    filePath: string;
    epoch: number;
    baselineRevision: string;
    currentRevision: string;
}

type CurrentFileState =
    | { kind: 'text'; content: string }
    | { kind: 'missing' }
    | { kind: 'unavailable'; reason: string };

export class DiffTracker {
    private sessionEpoch = 0;
    private disposed = false;
    private workspaceContextChanged = false;
    private fileActionQueues = new Map<string, Promise<unknown>>();
    private undoActionQueue: Promise<void> = Promise.resolve();
    private scanUncertainFiles = new Set<string>();

    private isCurrentEpoch(epoch: number): boolean {
        return !this.disposed && epoch === this.sessionEpoch;
    }

    private advanceEpoch(): number {
        this.clearExternalChangeTimers();
        this.clearDocumentChangeTimers();
        this.scanUncertainFiles.clear();
        this.activeWriteFiles.clear();
        this.pendingWriteFiles.clear();
        return ++this.sessionEpoch;
    }

    private revision(content: string, exists: boolean): string {
        return createHash('sha256').update(exists ? 'exists:' : 'missing:').update(content).digest('hex');
    }

    public getReviewToken(filePath: string): ReviewToken | undefined {
        const change = this.trackedChanges.get(filePath);
        const baseline = this.fileSnapshots.get(filePath);
        if (!change || baseline === undefined || this.disposed) { return undefined; }
        return {
            filePath, epoch: this.sessionEpoch,
            baselineRevision: this.revision(baseline, this.baselineExistingFiles.has(filePath)),
            currentRevision: this.revision(change.currentContent, !change.isDeleted)
        };
    }

    public getReviewTokens(): ReviewToken[] {
        return [...this.trackedChanges.keys()].map(filePath => this.getReviewToken(filePath))
            .filter((token): token is ReviewToken => !!token);
    }

    private matchesReview(token: ReviewToken | undefined): token is ReviewToken {
        if (!token || !this.isCurrentEpoch(token.epoch)) { return false; }
        const current = this.getReviewToken(token.filePath);
        return !!current && current.baselineRevision === token.baselineRevision && current.currentRevision === token.currentRevision;
    }

    private async verifyReview(token: ReviewToken | undefined): Promise<boolean> {
        if (!this.matchesReview(token)) { return false; }
        if (this.trackedChanges.get(token.filePath)?.unavailableReason) { return false; }
        const state = await this.readCurrentFileState(token.filePath);
        if (!this.matchesReview(token) || state.kind === 'unavailable') { return false; }
        const doc = vscode.workspace.textDocuments.find(value => value.uri.fsPath === token.filePath && value.uri.scheme === 'file');
        if (state.kind === 'text' && doc && this.revision(doc.getText(), true) !== token.currentRevision) { return false; }
        return this.revision(state.kind === 'text' ? state.content : '', state.kind === 'text') === token.currentRevision;
    }

    private queueFileAction(filePath: string, token: ReviewToken | undefined,
        action: (review: ReviewToken) => Promise<ActionResult>): Promise<ActionResult> {
        const previous = this.fileActionQueues.get(filePath) ?? Promise.resolve();
        const task = previous.catch(() => undefined).then(async () => {
            if (!token || token.filePath !== filePath || !await this.verifyReview(token)) {
                if (token && this.isCurrentEpoch(token.epoch)) { await this.refreshRejectedReview(filePath); }
                return this.actionResult(filePath, 'conflict', 'Review is stale or unavailable; refresh and review again');
            }
            return action(token);
        });
        this.fileActionQueues.set(filePath, task);
        void task.finally(() => {
            if (this.fileActionQueues.get(filePath) === task) { this.fileActionQueues.delete(filePath); }
        }).catch(() => undefined);
        return task;
    }
    private async refreshRejectedReview(filePath: string): Promise<void> {
        const document = vscode.workspace.textDocuments.find(value =>
            value.uri.fsPath === filePath && value.uri.scheme === 'file'
        );
        if (document?.isDirty) {
            this.processDocumentChange(document);
            return;
        }
        await this.readFileAndUpdate(filePath, vscode.Uri.file(filePath));
    }

    private isRecording = false;
    private pendingWriteFiles = new Set<string>();
    private activeWriteFiles = new Set<string>();
    private fileSnapshots = new Map<string, string>();
    private baselineExistingFiles = new Set<string>();
    private unresolvedBaselineFiles = new Map<string, string>();
    private trackedChanges = new Map<string, FileDiff>();
    private trackedChangesVersion = 0;
    private trackedChangesCacheVersion = -1;
    private trackedChangesCache: FileDiff[] = [];
    private lineChanges = new Map<string, LineChange[]>();
    private lineChangesVersionByFile = new Map<string, number>();
    private changeBlocksCache = new Map<string, { version: number; blocks: ChangeBlock[] }>();
    private inlineViews = new Map<string, InlineDiffView>();
    private disposables: vscode.Disposable[] = [];
    private fileWatchers: vscode.FileSystemWatcher[] = [];
    private ignoreMatchers = new Map<string, Ignore>();
    private ignoreResultCache = new Map<string, boolean>();
    private readonly ignoreResultCacheMaxEntries = 5000;
    private gitignoreCache = new Map<string, { files: string[]; mtimeMap: Map<string, number> }>();
    private externalWatcherEnabled = false;
    private snapshotInitialized = false;
    private baselineBuilding = false;
    private pendingExternalChanges = new Set<string>();
    private externalChangeTimers = new Map<string, NodeJS.Timeout>();
    private documentChangeTimers = new Map<string, NodeJS.Timeout>();
    private watcherSuppressionTimers = new Map<string, NodeJS.Timeout>();
    private automationSessions = new Map<string, AutomationSession>();
    private automationFileRefCounts = new Map<string, number>();
    private automationGlobalRefCount = 0;
    private nextAutomationSessionId = 1;
    private persistTimer: NodeJS.Timeout | undefined;
    private persistStateWriteQueue: Promise<boolean> = Promise.resolve(true);
    private readonly persistDebounceMs = 300;
    private readonly persistedStateFileName = 'session-state.json';
    private readonly persistedStateTempFileName = 'session-state.tmp.json';
    private readonly persistedStateBackupFileName = 'session-state.last-good.json';
    private readonly persistedStateArchiveFileName = 'session-state.archive.json';
    private readonly maxPersistedSnapshots = 10000;
    private readonly maxPersistedBytes = 50 * 1024 * 1024;
    private readonly maxRevertHistory = 10;
    private nextRevertRecordId = 1;
    private revertHistory: PersistedRevertRecord[] = [];
    private recoveryBlocked = false;
    private persistenceIssue: string | undefined;
    private baselineGitContexts = new Map<string, GitContextSnapshot>();
    private pausedGitRepositories = new Map<string, string>();
    private readonly _onDidChangeRecordingState = new vscode.EventEmitter<boolean>();
    private readonly _onDidTrackChanges = new vscode.EventEmitter<TrackChangesEvent>();
    private readonly _onDidChangeBaselineState = new vscode.EventEmitter<'idle' | 'building' | 'ready'>();

    public readonly onDidChangeRecordingState = this._onDidChangeRecordingState.event;
    public readonly onDidTrackChanges = this._onDidTrackChanges.event;
    public readonly onDidChangeBaselineState = this._onDidChangeBaselineState.event;

    constructor(private readonly storageUri?: vscode.Uri) {
        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument(this.onDocumentChanged, this)
        );

        this.disposables.push(
            vscode.workspace.onDidOpenTextDocument(this.onDocumentOpened, this)
        );

        this.disposables.push(
            vscode.workspace.onWillSaveTextDocument(this.onWillSaveDocument, this)
        );

        this.disposables.push(
            vscode.workspace.onDidSaveTextDocument(this.onDidSaveDocument, this)
        );

        if (vscode.workspace.onDidChangeWorkspaceFolders) {
            this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
                // Root membership changes invalidate all issued actions. Preserve review
                // data, but require an explicit start/reset before establishing new roots.
                this.stopRecording();
                this.workspaceContextChanged = true;
                vscode.window.showWarningMessage('Diff Tracker: Workspace folders changed. Review paused; establish a new baseline explicitly.');
            }));
        }

        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (
                    e.affectsConfiguration('diffTracker.onlyTrackAutomatedChanges') ||
                    e.affectsConfiguration('diffTracker.onlyTrackVSCodeChanges') ||
                    e.affectsConfiguration('diffTracker.watchExclude') ||
                    e.affectsConfiguration('files.watcherExclude') ||
                    e.affectsConfiguration('search.exclude') ||
                    e.affectsConfiguration('files.exclude')
                ) {
                    if (this.isRecording) {
                        this.refreshIgnoreMatchers().catch(() => undefined);
                    }
                }
            })
        );
    }

    public async restorePersistedState(): Promise<RestoreOutcome> {
        const epoch = this.advanceEpoch();
        const loaded = await this.loadPersistedStateWithRecovery();
        if (!this.isCurrentEpoch(epoch)) { return 'blocked'; }
        if (loaded.kind === 'absent') {
            return 'absent';
        }
        if (loaded.kind === 'blocked') {
            this.recoveryBlocked = true;
            this.persistenceIssue = loaded.reason;
            this.isRecording = false;
            this.baselineBuilding = false;
            this.snapshotInitialized = false;
            return 'blocked';
        }
        const state = loaded.state;
        this.recoveryBlocked = false;
        this.persistenceIssue = loaded.kind === 'recovered'
            ? 'Recovered the last-good Diff Tracker session because the primary state was unreadable.'
            : undefined;

        if (
            state.isRecording &&
            state.fileSnapshots.length === 0 &&
            state.unresolvedBaselineFiles.length === 0 &&
            (vscode.workspace.workspaceFolders?.length ?? 0) > 0
        ) {
            this.recoveryBlocked = true;
            this.persistenceIssue = 'Persisted recording state has no baseline snapshots; automatic replacement was blocked.';
            return 'blocked';
        }

        this.clearExternalChangeTimers();
        this.clearDocumentChangeTimers();
        this.clearWatcherSuppressionTimers();
        this.clearAutomationSessions();
        this.disposeFileWatchers();

        const currentRoots = this.getWorkspaceRoots();
        const rootsMatch = this.sameStringSet(state.workspaceRoots, currentRoots);
        const incomplete = state.baselineState === 'building' || !rootsMatch;
        this.isRecording = incomplete ? false : state.isRecording;
        this.fileSnapshots = new Map(state.fileSnapshots);
        this.baselineExistingFiles = new Set(state.baselineExistingFiles);
        this.unresolvedBaselineFiles = new Map(state.unresolvedBaselineFiles);
        this.revertHistory = state.revertHistory.slice(-this.maxRevertHistory);
        this.baselineGitContexts = new Map(state.gitContexts.map(context => [context.repoRoot, context]));
        this.pausedGitRepositories.clear();
        this.clearTrackedChanges();
        this.lineChanges.clear();
        this.resetChangeBlocksCaches();
        this.inlineViews.clear();
        this.pendingExternalChanges.clear();
        this.snapshotInitialized = !incomplete;
        this.baselineBuilding = incomplete;
        this.workspaceContextChanged = !rootsMatch;

        try {
            await this.refreshIgnoreMatchers();
        } catch (error) {
            console.warn('Failed to refresh ignore rules while restoring session state', error);
        }
        if (!this.isCurrentEpoch(epoch)) { return 'blocked'; }

        await this.rebuildTrackedChangesFromSnapshots();
        if (!this.isCurrentEpoch(epoch)) { return 'blocked'; }

        if (this.isRecording) {
            await this.startExternalWatchers();
            if (!this.isCurrentEpoch(epoch)) { return 'blocked'; }
        } else {
            this.externalWatcherEnabled = false;
        }

        if (incomplete) {
            this.persistenceIssue = state.baselineState === 'building'
                ? 'Recovered a partial baseline scan in paused mode; rebuild the baseline before review actions.'
                : 'Workspace roots differ from the persisted session; review is paused until an explicit baseline rebuild.';
            return 'incomplete';
        }
        return loaded.kind === 'recovered' ? 'recovered' : 'restored';
    }

    private shouldTrackOnlyAutomatedChanges(): boolean {
        const config = vscode.workspace.getConfiguration('diffTracker');
        return (
            config.get<boolean>('onlyTrackAutomatedChanges', false) ||
            config.get<boolean>('onlyTrackVSCodeChanges', false)
        );
    }

    public startRecording() {
        if (this.disposed || this.recoveryBlocked) { return; }
        const epoch = this.advanceEpoch();
        this.workspaceContextChanged = false;
        const removedFiles = Array.from(this.trackedChanges.keys());
        this.isRecording = true;
        this.clearAutomationSessions();
        this.clearWatcherSuppressionTimers();
        this.pendingWriteFiles.clear();
        this.fileSnapshots.clear();
        this.baselineExistingFiles.clear();
        this.unresolvedBaselineFiles.clear();
        this.clearTrackedChanges();
        this.lineChanges.clear();
        this.resetChangeBlocksCaches();
        this.inlineViews.clear();
        this.pendingExternalChanges.clear();
        this.revertHistory = [];
        this.baselineGitContexts.clear();
        this.pausedGitRepositories.clear();
        this.snapshotInitialized = false;
        this.baselineBuilding = true;
        this._onDidChangeBaselineState.fire('building');

        vscode.workspace.textDocuments.forEach(doc => {
            this.ensureSnapshotForDocument(doc);
        });

        void this.startExternalWatchers();
        void this.initializeWorkspaceSnapshots().catch(() => {
            if (this.isCurrentEpoch(epoch) && this.baselineBuilding) {
                vscode.window.showWarningMessage('Diff Tracker: Baseline scan did not complete; review remains incomplete.');
            }
        });
        this.schedulePersistState();

        this._onDidChangeRecordingState.fire(true);
        this.emitTrackChangesEvent({
            removedFiles,
            fullRefresh: true,
            baselineChanged: true
        });
    }

    public stopRecording() {
        this.advanceEpoch();
        this.isRecording = false;
        this.baselineBuilding = false;
        this._onDidChangeBaselineState.fire('idle');
        this.clearAutomationSessions();
        this.clearExternalChangeTimers();
        this.clearDocumentChangeTimers();
        this.clearWatcherSuppressionTimers();
        this.disposeFileWatchers();
        this.resetChangeBlocksCaches();
        this.schedulePersistState();
        this._onDidChangeRecordingState.fire(false);
        this.emitTrackChangesEvent({ fullRefresh: true });
    }

    public clearDiffs() {
        const removedFiles = Array.from(this.trackedChanges.keys());
        this.clearTrackedChanges();
        this.lineChanges.clear();
        this.resetChangeBlocksCaches();
        this.inlineViews.clear();
        this.emitTrackChangesEvent({
            removedFiles,
            fullRefresh: true
        });
    }

    public async resetBaselineToCurrentState(): Promise<void> {
        if (this.recoveryBlocked) { return; }
        const epoch = this.advanceEpoch();
        this.workspaceContextChanged = false;
        if (!this.isRecording) {
            this.clearDiffs();
            return;
        }

        const removedFiles = Array.from(this.trackedChanges.keys());

        this.clearExternalChangeTimers();
        this.clearDocumentChangeTimers();

        this.pendingWriteFiles.clear();
        this.fileSnapshots.clear();
        this.baselineExistingFiles.clear();
        this.unresolvedBaselineFiles.clear();
        this.clearTrackedChanges();
        this.lineChanges.clear();
        this.resetChangeBlocksCaches();
        this.inlineViews.clear();
        this.pendingExternalChanges.clear();
        void this.startExternalWatchers();
        this.snapshotInitialized = false;
        this.baselineBuilding = true;
        this._onDidChangeBaselineState.fire('building');

        try {
            // Open editors may be ahead of on-disk state; use their in-memory text as baseline.
            vscode.workspace.textDocuments.forEach(doc => {
                this.ensureSnapshotForDocument(doc);
            });

            await this.initializeWorkspaceSnapshots();
        } catch (error) {
            console.error('Failed to reset baseline to current state:', error);
        } finally {
            if (!this.isCurrentEpoch(epoch)) { return; }
            // A failed/partial scan remains Building; only the scanner can publish Ready.
            this.emitTrackChangesEvent({
                removedFiles,
                fullRefresh: true,
                baselineChanged: true
            });
            this.schedulePersistState();
        }
    }

    private async startExternalWatchers(): Promise<void> {
        const epoch = this.sessionEpoch;
        this.disposeFileWatchers();
        this.externalWatcherEnabled = false;

        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return;
        }

        try {
            await this.refreshIgnoreMatchers();
        } catch (error) {
            console.warn('Failed to build ignore rules for file watcher', error);
        }
        if (!this.isCurrentEpoch(epoch) || !this.isRecording) { return; }

        try {
            const patternGlob = '**/*';

            for (const folder of folders) {
                const createWatcher = (glob: string) => {
                    const pattern = new vscode.RelativePattern(folder, glob);
                    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

                    watcher.onDidChange(uri => { if (this.isCurrentEpoch(epoch)) { void this.onExternalFileChanged(uri); } });
                    watcher.onDidCreate(uri => { if (this.isCurrentEpoch(epoch)) { void this.onExternalFileCreated(uri); } });
                    watcher.onDidDelete(uri => { if (this.isCurrentEpoch(epoch)) { void this.onExternalFileDeleted(uri); } });

                    this.fileWatchers.push(watcher);
                };

                createWatcher(patternGlob);
            }

            this.externalWatcherEnabled = true;
        } catch (error: any) {
            this.externalWatcherEnabled = false;
            this.disposeFileWatchers();
            const message = error?.code === 'ENOSPC'
                ? 'Diff Tracker: File watcher limit reached (ENOSPC). Falling back to open files only.'
                : 'Diff Tracker: File watcher failed. Falling back to open files only.';
            vscode.window.showWarningMessage(message);
        }
    }

    private disposeFileWatchers() {
        this.fileWatchers.forEach(w => w.dispose());
        this.fileWatchers = [];
    }

    private clearExternalChangeTimers(): void {
        this.externalChangeTimers.forEach(timer => clearTimeout(timer));
        this.externalChangeTimers.clear();
    }

    private clearDocumentChangeTimers(): void {
        this.documentChangeTimers.forEach(timer => clearTimeout(timer));
        this.documentChangeTimers.clear();
    }

    private clearWatcherSuppressionTimers(): void {
        this.watcherSuppressionTimers.forEach(timer => clearTimeout(timer));
        this.watcherSuppressionTimers.clear();
    }

    private getPersistedStateUri(fileName = this.persistedStateFileName): vscode.Uri | undefined {
        if (!this.storageUri) {
            return undefined;
        }

        return vscode.Uri.joinPath(this.storageUri, fileName);
    }

    private getWorkspaceRoots(): string[] {
        return (vscode.workspace.workspaceFolders ?? [])
            .filter(folder => folder.uri.scheme === 'file')
            .map(folder => path.resolve(folder.uri.fsPath))
            .sort((left, right) => left.localeCompare(right));
    }

    private sameStringSet(left: string[], right: string[]): boolean {
        if (left.length !== right.length) { return false; }
        const sortedLeft = [...left].sort((a, b) => a.localeCompare(b));
        const sortedRight = [...right].sort((a, b) => a.localeCompare(b));
        return sortedLeft.every((value, index) => value === sortedRight[index]);
    }

    private buildPersistedState(): PersistedTrackerState | undefined {
        if (!this.storageUri) {
            return undefined;
        }

        if (!this.isRecording && this.fileSnapshots.size === 0) {
            return undefined;
        }

        return {
            version: 2,
            isRecording: this.isRecording,
            baselineState: this.baselineBuilding || !this.snapshotInitialized ? 'building' : 'ready',
            workspaceRoots: this.getWorkspaceRoots(),
            fileSnapshots: Array.from(this.fileSnapshots.entries())
                .sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath)),
            baselineExistingFiles: Array.from(this.baselineExistingFiles.values())
                .sort((leftPath, rightPath) => leftPath.localeCompare(rightPath)),
            unresolvedBaselineFiles: Array.from(this.unresolvedBaselineFiles.entries())
                .sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath)),
            revertHistory: this.revertHistory.slice(-this.maxRevertHistory),
            gitContexts: [...this.baselineGitContexts.values()]
                .sort((left, right) => left.repoRoot.localeCompare(right.repoRoot))
        };
    }

    private schedulePersistState(): void {
        if (!this.storageUri) {
            return;
        }

        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
        }

        this.persistTimer = setTimeout(() => {
            this.persistTimer = undefined;
            void this.flushPersistState();
        }, this.persistDebounceMs);
    }

    public async flushPendingPersistence(): Promise<boolean> {
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
            this.persistTimer = undefined;
        }
        return this.flushPersistState();
    }

    private async deletePersistedFile(uri: vscode.Uri): Promise<void> {
        try {
            await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false });
        } catch (error) {
            if (!this.isFileNotFound(error)) { throw error; }
        }
    }

    private reportPersistenceIssue(message: string, error?: unknown): void {
        this.persistenceIssue = message;
        console.error(message, error);
    }

    private async flushPersistState(): Promise<boolean> {
        const storageUri = this.storageUri;
        if (!storageUri) {
            return true;
        }

        const state = this.buildPersistedState();
        let payload: Uint8Array | undefined;
        if (state) {
            if (state.fileSnapshots.length > this.maxPersistedSnapshots) {
                this.reportPersistenceIssue(`Failed to persist Diff Tracker session: snapshot count exceeds ${this.maxPersistedSnapshots}.`);
                return false;
            }
            payload = new TextEncoder().encode(JSON.stringify(state));
            if (payload.byteLength > this.maxPersistedBytes) {
                this.reportPersistenceIssue(`Failed to persist Diff Tracker session: state exceeds ${this.maxPersistedBytes} bytes.`);
                return false;
            }
        }

        const persistTask = async (): Promise<boolean> => {
            const targetUri = this.getPersistedStateUri();
            const tempUri = this.getPersistedStateUri(this.persistedStateTempFileName);
            const backupUri = this.getPersistedStateUri(this.persistedStateBackupFileName);
            if (!targetUri || !tempUri || !backupUri) { return true; }

            if (!payload) {
                try {
                    await this.deletePersistedFile(targetUri);
                    await this.deletePersistedFile(tempUri);
                    await this.deletePersistedFile(backupUri);
                    this.persistenceIssue = undefined;
                    return true;
                } catch (error) {
                    this.reportPersistenceIssue('Failed to clear Diff Tracker persisted session state.', error);
                    return false;
                }
            }

            try {
                await vscode.workspace.fs.createDirectory(storageUri);
                await vscode.workspace.fs.writeFile(tempUri, payload);
                await vscode.workspace.fs.rename(tempUri, targetUri, { overwrite: true });
                await vscode.workspace.fs.copy(targetUri, backupUri, { overwrite: true });
                this.persistenceIssue = undefined;
                return true;
            } catch (error) {
                try { await this.deletePersistedFile(tempUri); } catch { /* Retain the primary failure. */ }
                this.reportPersistenceIssue('Failed to persist Diff Tracker session state; the previous valid state was preserved.', error);
                return false;
            }
        };

        this.persistStateWriteQueue = this.persistStateWriteQueue.then(persistTask, persistTask);
        return this.persistStateWriteQueue;
    }

    private async loadPersistedState(): Promise<PersistedTrackerState | undefined> {
        const loaded = await this.loadPersistedStateWithRecovery();
        return loaded.kind === 'primary' || loaded.kind === 'recovered' ? loaded.state : undefined;
    }

    private async readPersistedCandidate(uri: vscode.Uri): Promise<
        { kind: 'absent' } | { kind: 'invalid'; reason: string } | { kind: 'valid'; state: PersistedTrackerState }
    > {
        try {
            const payload = await vscode.workspace.fs.readFile(uri);
            if (payload.byteLength > this.maxPersistedBytes) {
                return { kind: 'invalid', reason: `state exceeds ${this.maxPersistedBytes} bytes` };
            }
            const raw = new TextDecoder('utf-8', { fatal: true }).decode(payload);
            const state = this.parsePersistedState(JSON.parse(raw) as unknown);
            return state ? { kind: 'valid', state } : { kind: 'invalid', reason: 'schema or invariant validation failed' };
        } catch (error) {
            if (this.isFileNotFound(error)) { return { kind: 'absent' }; }
            return { kind: 'invalid', reason: error instanceof Error ? error.message : 'read failed' };
        }
    }

    private async loadPersistedStateWithRecovery(): Promise<
        | { kind: 'absent' }
        | { kind: 'blocked'; reason: string }
        | { kind: 'primary'; state: PersistedTrackerState }
        | { kind: 'recovered'; state: PersistedTrackerState }
    > {
        const targetUri = this.getPersistedStateUri();
        const backupUri = this.getPersistedStateUri(this.persistedStateBackupFileName);
        if (!targetUri || !backupUri) { return { kind: 'absent' }; }
        const primary = await this.readPersistedCandidate(targetUri);
        if (primary.kind === 'valid') { return { kind: 'primary', state: primary.state }; }
        const backup = await this.readPersistedCandidate(backupUri);
        if (backup.kind === 'valid') { return { kind: 'recovered', state: backup.state }; }
        if (primary.kind === 'absent' && backup.kind === 'absent') { return { kind: 'absent' }; }
        return {
            kind: 'blocked',
            reason: `Diff Tracker session recovery is blocked: primary ${primary.kind === 'invalid' ? primary.reason : 'is absent'}; last-good ${backup.kind === 'invalid' ? backup.reason : 'is absent'}.`
        };
    }

    private parsePersistedState(raw: unknown): PersistedTrackerState | undefined {
        if (!raw || typeof raw !== 'object') {
            return undefined;
        }

        const candidate = raw as {
            version?: unknown;
            isRecording?: unknown;
            baselineState?: unknown;
            workspaceRoots?: unknown;
            fileSnapshots?: unknown;
            baselineExistingFiles?: unknown;
            unresolvedBaselineFiles?: unknown;
            revertHistory?: unknown;
            gitContexts?: unknown;
        };

        if ((candidate.version !== 1 && candidate.version !== 2) || typeof candidate.isRecording !== 'boolean') {
            return undefined;
        }

        if (!Array.isArray(candidate.fileSnapshots) || !Array.isArray(candidate.baselineExistingFiles)) {
            return undefined;
        }
        if (candidate.fileSnapshots.length > this.maxPersistedSnapshots) { return undefined; }

        const fileSnapshots: Array<[string, string]> = [];
        const snapshotPaths = new Set<string>();
        for (const entry of candidate.fileSnapshots) {
            if (!Array.isArray(entry) || entry.length !== 2) {
                return undefined;
            }

            const [filePath, content] = entry;
            if (typeof filePath !== 'string' || typeof content !== 'string' || !path.isAbsolute(filePath) || snapshotPaths.has(filePath)) {
                return undefined;
            }

            fileSnapshots.push([filePath, content]);
            snapshotPaths.add(filePath);
        }

        const baselineExistingFiles: string[] = [];
        const existingPaths = new Set<string>();
        for (const entry of candidate.baselineExistingFiles) {
            if (typeof entry !== 'string' || existingPaths.has(entry) || !snapshotPaths.has(entry)) { return undefined; }
            baselineExistingFiles.push(entry);
            existingPaths.add(entry);
        }

        const workspaceRoots = candidate.version === 1
            ? this.getWorkspaceRoots()
            : candidate.workspaceRoots;
        if (!Array.isArray(workspaceRoots) || workspaceRoots.some(root => typeof root !== 'string' || !path.isAbsolute(root)) ||
            new Set(workspaceRoots).size !== workspaceRoots.length) {
            return undefined;
        }
        const normalizedRoots = (workspaceRoots as string[]).map(root => path.resolve(root));
        const isWithinRoot = (filePath: string): boolean => normalizedRoots.some(root => {
            const relative = path.relative(root, filePath);
            return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
        });
        if (fileSnapshots.some(([filePath]) => !isWithinRoot(filePath))) { return undefined; }

        const rawUnresolved = candidate.version === 1 ? [] : (candidate.unresolvedBaselineFiles ?? []);
        if (!Array.isArray(rawUnresolved) || rawUnresolved.length > this.maxPersistedSnapshots) { return undefined; }
        const unresolvedBaselineFiles: Array<[string, string]> = [];
        const unresolvedPaths = new Set<string>();
        for (const entry of rawUnresolved) {
            if (!Array.isArray(entry) || entry.length !== 2) { return undefined; }
            const [filePath, reason] = entry;
            if (typeof filePath !== 'string' || typeof reason !== 'string' || reason.length === 0 || reason.length > 1000 ||
                !path.isAbsolute(filePath) || !isWithinRoot(filePath) || snapshotPaths.has(filePath) || unresolvedPaths.has(filePath)) {
                return undefined;
            }
            unresolvedBaselineFiles.push([filePath, reason]);
            unresolvedPaths.add(filePath);
        }

        const baselineState = candidate.version === 1 ? 'ready' : candidate.baselineState;
        if (baselineState !== 'building' && baselineState !== 'ready') { return undefined; }

        const rawHistory = candidate.version === 1 ? [] : candidate.revertHistory;
        const revertHistory = this.parseRevertHistory(rawHistory, snapshotPaths);
        if (!revertHistory) { return undefined; }

        const gitContexts = this.parseGitContexts(candidate.version === 1 ? [] : (candidate.gitContexts ?? []), normalizedRoots);
        if (!gitContexts) { return undefined; }

        return {
            version: 2,
            isRecording: candidate.isRecording,
            baselineState,
            workspaceRoots: normalizedRoots,
            fileSnapshots,
            baselineExistingFiles,
            unresolvedBaselineFiles,
            revertHistory,
            gitContexts
        };
    }

    private parseGitContexts(raw: unknown, workspaceRoots: string[]): GitContextSnapshot[] | undefined {
        if (!Array.isArray(raw)) { return undefined; }
        const contexts: GitContextSnapshot[] = [];
        const seenRoots = new Set<string>();
        const overlapsWorkspace = (repoRoot: string): boolean => workspaceRoots.some(workspaceRoot => {
            const workspaceRelative = path.relative(repoRoot, workspaceRoot);
            const repoRelative = path.relative(workspaceRoot, repoRoot);
            const within = (relative: string) => relative === '' ||
                (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
            return within(workspaceRelative) || within(repoRelative);
        });
        for (const candidate of raw) {
            if (!candidate || typeof candidate !== 'object') { return undefined; }
            const value = candidate as Partial<GitContextSnapshot>;
            if (typeof value.repoRoot !== 'string' || !path.isAbsolute(value.repoRoot) || seenRoots.has(value.repoRoot) ||
                (value.kind !== 'repository' && value.kind !== 'submodule' && value.kind !== 'worktree') ||
                (value.headName !== undefined && typeof value.headName !== 'string') ||
                (value.headCommit !== undefined && typeof value.headCommit !== 'string') ||
                typeof value.detached !== 'boolean' || typeof value.inProgress !== 'boolean' || !overlapsWorkspace(value.repoRoot)) {
                return undefined;
            }
            seenRoots.add(value.repoRoot);
            contexts.push(value as GitContextSnapshot);
        }
        return contexts;
    }

    private parseRevertHistory(raw: unknown, snapshotPaths: Set<string>): PersistedRevertRecord[] | undefined {
        if (!Array.isArray(raw) || raw.length > this.maxRevertHistory) { return undefined; }
        const records: PersistedRevertRecord[] = [];
        for (const candidate of raw) {
            if (!candidate || typeof candidate !== 'object') { return undefined; }
            const value = candidate as { id?: unknown; createdAt?: unknown; items?: unknown };
            if (typeof value.id !== 'string' || typeof value.createdAt !== 'string' || !Array.isArray(value.items) || value.items.length === 0) {
                return undefined;
            }
            const items: PersistedRevertItem[] = [];
            for (const rawItem of value.items) {
                if (!rawItem || typeof rawItem !== 'object') { return undefined; }
                const item = rawItem as Partial<PersistedRevertItem>;
                const validState = (state: unknown): state is PersistedFileState => !!state && typeof state === 'object' &&
                    typeof (state as PersistedFileState).exists === 'boolean' && typeof (state as PersistedFileState).content === 'string';
                if (typeof item.filePath !== 'string' || !snapshotPaths.has(item.filePath) ||
                    typeof item.baselineRevision !== 'string' || !validState(item.before) || !validState(item.after) ||
                    (item.saveMode !== 'disk' && item.saveMode !== 'buffer')) { return undefined; }
                items.push(item as PersistedRevertItem);
            }
            records.push({ id: value.id, createdAt: value.createdAt, items });
        }
        return records;
    }

    public getPersistenceIssue(): string | undefined { return this.persistenceIssue; }

    public isRecoveryBlocked(): boolean { return this.recoveryBlocked; }

    public async discardRecoveryState(): Promise<boolean> {
        if (!this.storageUri) {
            this.recoveryBlocked = false;
            this.persistenceIssue = undefined;
            return true;
        }
        try {
            for (const name of [this.persistedStateFileName, this.persistedStateTempFileName, this.persistedStateBackupFileName]) {
                const uri = this.getPersistedStateUri(name);
                if (uri) { await this.deletePersistedFile(uri); }
            }
            this.recoveryBlocked = false;
            this.persistenceIssue = undefined;
            return true;
        } catch (error) {
            this.reportPersistenceIssue('Failed to discard the unreadable Diff Tracker session.', error);
            return false;
        }
    }

    private clearAutomationSessions(): void {
        [...this.automationSessions.keys()].forEach(sessionId => this.endAutomationSession(sessionId));
    }

    private onWillSaveDocument(event: vscode.TextDocumentWillSaveEvent): void {
        // Save events do not establish authorship. No time window may hide external writes.
    }

    private onDidSaveDocument(doc: vscode.TextDocument): void {
        if (this.isRecording && !this.activeWriteFiles.has(doc.uri.fsPath)) {
            this.processDocumentChange(doc);
        }
        if (!this.activeWriteFiles.has(doc.uri.fsPath) && this.pendingWriteFiles.delete(doc.uri.fsPath)) {
            void this.readFileAndUpdate(doc.uri.fsPath, doc.uri);
        }
    }

    private normalizeAutomationFilePath(value: unknown): string | undefined {
        if (typeof value === 'string' && value.trim().length > 0) {
            return value;
        }

        if (value instanceof vscode.Uri) {
            return value.fsPath;
        }

        if (typeof value === 'object' && value !== null) {
            const candidate = (value as { filePath?: unknown }).filePath;
            if (typeof candidate === 'string' && candidate.trim().length > 0) {
                return candidate;
            }
        }

        return undefined;
    }

    private normalizeAutomationFilePaths(values: unknown[]): string[] {
        const normalized = new Set<string>();
        values.forEach(value => {
            const filePath = this.normalizeAutomationFilePath(value);
            if (filePath) {
                normalized.add(filePath);
            }
        });
        return [...normalized];
    }

    private parseAutomationSessionTarget(target?: unknown): { filePaths: string[]; ttlMs: number; allFiles: boolean } {
        const defaultTtlMs = 30000;

        if (Array.isArray(target)) {
            const filePaths = this.normalizeAutomationFilePaths(target);
            return {
                filePaths,
                ttlMs: defaultTtlMs,
                allFiles: filePaths.length === 0
            };
        }

        const directFilePath = this.normalizeAutomationFilePath(target);
        if (directFilePath) {
            return {
                filePaths: [directFilePath],
                ttlMs: defaultTtlMs,
                allFiles: false
            };
        }

        if (typeof target === 'object' && target !== null) {
            const payload = target as {
                filePath?: unknown;
                filePaths?: unknown;
                ttlMs?: unknown;
                allFiles?: unknown;
            };
            const filePaths = this.normalizeAutomationFilePaths([
                payload.filePath,
                ...(Array.isArray(payload.filePaths) ? payload.filePaths : [])
            ]);
            const ttlMs = typeof payload.ttlMs === 'number' && Number.isFinite(payload.ttlMs)
                ? Math.max(1000, payload.ttlMs)
                : defaultTtlMs;
            const allFiles = payload.allFiles === true || filePaths.length === 0;
            return { filePaths, ttlMs, allFiles };
        }

        return {
            filePaths: [],
            ttlMs: defaultTtlMs,
            allFiles: true
        };
    }

    private incrementAutomationFileRefs(filePaths: string[]): void {
        filePaths.forEach(filePath => {
            this.automationFileRefCounts.set(filePath, (this.automationFileRefCounts.get(filePath) ?? 0) + 1);
        });
    }

    private decrementAutomationFileRefs(filePaths: string[]): void {
        filePaths.forEach(filePath => {
            const next = (this.automationFileRefCounts.get(filePath) ?? 0) - 1;
            if (next > 0) {
                this.automationFileRefCounts.set(filePath, next);
            } else {
                this.automationFileRefCounts.delete(filePath);
            }
        });
    }

    private isAutomationChangeAllowed(filePath: string): boolean {
        return this.automationGlobalRefCount > 0 || this.automationFileRefCounts.has(filePath);
    }

    public beginAutomationSession(target?: unknown): string {
        const { filePaths, ttlMs, allFiles } = this.parseAutomationSessionTarget(target);
        const sessionId = `automation-${Date.now()}-${this.nextAutomationSessionId++}`;

        if (allFiles) {
            this.automationGlobalRefCount++;
        }
        this.incrementAutomationFileRefs(filePaths);

        const timeout = setTimeout(() => {
            this.endAutomationSession(sessionId);
        }, ttlMs);

        this.automationSessions.set(sessionId, {
            id: sessionId,
            filePaths,
            allFiles,
            timeout
        });

        return sessionId;
    }

    public endAutomationSession(target?: unknown): void {
        if (typeof target === 'string' && this.automationSessions.has(target)) {
            const session = this.automationSessions.get(target);
            if (!session) {
                return;
            }

            clearTimeout(session.timeout);
            if (session.allFiles) {
                this.automationGlobalRefCount = Math.max(0, this.automationGlobalRefCount - 1);
            }
            this.decrementAutomationFileRefs(session.filePaths);
            this.automationSessions.delete(target);
            return;
        }

        if (typeof target === 'object' && target !== null) {
            const sessionId = (target as { sessionId?: unknown }).sessionId;
            if (typeof sessionId === 'string') {
                this.endAutomationSession(sessionId);
                return;
            }
        }

        if (target === undefined) {
            const sessionIds = [...this.automationSessions.keys()];
            sessionIds.forEach(sessionId => this.endAutomationSession(sessionId));
            return;
        }

        const { filePaths, allFiles } = this.parseAutomationSessionTarget(target);
        const sessionIds = [...this.automationSessions.keys()];

        sessionIds.forEach(sessionId => {
            const session = this.automationSessions.get(sessionId);
            if (!session) {
                return;
            }

            const matchesAllFiles = allFiles && session.allFiles;
            const matchesFiles =
                filePaths.length > 0 &&
                filePaths.every(filePath => session.filePaths.includes(filePath));

            if (matchesAllFiles || matchesFiles) {
                this.endAutomationSession(sessionId);
            }
        });
    }

    private async refreshIgnoreMatchers(): Promise<void> {
        const epoch = this.sessionEpoch;
        this.ignoreMatchers.clear();
        this.ignoreResultCache.clear();
        const folders = vscode.workspace.workspaceFolders;
        if (!folders) {
            return;
        }

        for (const folder of folders) {
            const matcher = await this.buildIgnoreMatcher(folder);
            if (!this.isCurrentEpoch(epoch)) { return; }
            this.ignoreMatchers.set(folder.uri.fsPath, matcher);
        }

        this.pruneIgnoredTrackedChanges();
    }

    private getDefaultExcludePatterns(): string[] {
        return [
            '**/.git/**',
            '**/node_modules/**',
            '**/out/**',
            '**/dist/**',
            '**/build/**',
            '**/coverage/**',
            '**/tmp/**'
        ];
    }

    private getVsCodeExcludePatterns(): string[] {
        const config = vscode.workspace.getConfiguration();
        const watcherExclude = config.get<Record<string, boolean>>('files.watcherExclude', {});
        const searchExclude = config.get<Record<string, boolean>>('search.exclude', {});
        const filesExclude = config.get<Record<string, boolean>>('files.exclude', {});
        const patterns = new Set<string>();

        const addPatterns = (obj: Record<string, boolean>) => {
            Object.entries(obj).forEach(([pattern, enabled]) => {
                if (enabled) {
                    patterns.add(pattern);
                }
            });
        };

        addPatterns(watcherExclude);
        addPatterns(searchExclude);
        addPatterns(filesExclude);

        return Array.from(patterns);
    }

    private getWatchExcludePatterns(): string[] {
        const config = vscode.workspace.getConfiguration('diffTracker');
        const raw = config.get<string[]>('watchExclude', []) ?? [];
        const ignoreRules: string[] = [];

        raw.forEach(line => {
            const trimmed = line.trim();
            if (!trimmed) {
                return;
            }
            ignoreRules.push(trimmed);
        });

        return ignoreRules;
    }

    private async buildIgnoreMatcher(folder: vscode.WorkspaceFolder): Promise<Ignore> {
        const ig = ignore();
        const watchExcludes = this.getWatchExcludePatterns();
        const basePatterns = [
            ...this.getDefaultExcludePatterns(),
            ...this.getVsCodeExcludePatterns(),
            ...watchExcludes
        ];
        ig.add(basePatterns);

        const gitignoreFiles = await this.getCachedGitignoreFiles(folder);

        for (const uri of gitignoreFiles) {
            try {
                const content = await vscode.workspace.fs.readFile(uri);
                const text = new TextDecoder('utf-8').decode(content);
                const relPath = this.toPosixPath(path.relative(folder.uri.fsPath, uri.fsPath));
                const relDir = path.posix.dirname(relPath);
                const prefix = relDir === '.' ? '' : `${relDir}/`;
                this.addGitignorePatterns(ig, text, prefix);
            } catch {
                // ignore read errors
            }
        }

        const infoExcludePath = path.join(folder.uri.fsPath, '.git', 'info', 'exclude');
        if (fs.existsSync(infoExcludePath)) {
            try {
                const text = fs.readFileSync(infoExcludePath, 'utf8');
                this.addGitignorePatterns(ig, text, '');
            } catch {
                // ignore read errors
            }
        }

        return ig;
    }

    private async getCachedGitignoreFiles(folder: vscode.WorkspaceFolder): Promise<vscode.Uri[]> {
        const folderPath = folder.uri.fsPath;
        const cached = this.gitignoreCache.get(folderPath);
        if (!cached) {
            return this.refreshGitignoreCache(folder);
        }

        const mtimeMap = cached.mtimeMap;
        for (const filePath of cached.files) {
            try {
                const stat = await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
                const mtime = stat.mtime;
                if (mtimeMap.get(filePath) !== mtime) {
                    return this.refreshGitignoreCache(folder);
                }
            } catch {
                return this.refreshGitignoreCache(folder);
            }
        }

        return cached.files.map(filePath => vscode.Uri.file(filePath));
    }

    private async refreshGitignoreCache(folder: vscode.WorkspaceFolder): Promise<vscode.Uri[]> {
        const epoch = this.sessionEpoch;
        const gitignoreFiles = await vscode.workspace.findFiles(
            new vscode.RelativePattern(folder, '**/.gitignore'),
            new vscode.RelativePattern(folder, '**/.git/**')
        );

        const mtimeMap = new Map<string, number>();
        const files: string[] = [];
        for (const uri of gitignoreFiles) {
            files.push(uri.fsPath);
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                mtimeMap.set(uri.fsPath, stat.mtime);
            } catch {
                // ignore stat errors
            }
        }

        if (this.isCurrentEpoch(epoch)) { this.gitignoreCache.set(folder.uri.fsPath, { files, mtimeMap }); }
        return gitignoreFiles;
    }

    private addGitignorePatterns(ig: Ignore, content: string, prefix: string) {
        const lines = content.split(/\r?\n/);
        lines.forEach(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) {
                return;
            }
            if (trimmed.startsWith('!')) {
                ig.add(`!${prefix}${trimmed.slice(1)}`);
            } else {
                ig.add(`${prefix}${trimmed}`);
            }
        });
    }

    private toPosixPath(value: string): string {
        return value.split(path.sep).join(path.posix.sep);
    }

    public testIgnorePath(inputPath?: string): { ignored: boolean; reason: string } {
        if (!inputPath || inputPath.trim().length === 0) {
            return { ignored: false, reason: 'No path provided' };
        }

        const normalizedInput = inputPath.trim();
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return { ignored: false, reason: 'No workspace folders' };
        }

        let targetFolder: vscode.WorkspaceFolder | undefined;
        let relPath = normalizedInput;

        if (path.isAbsolute(normalizedInput)) {
            const uri = vscode.Uri.file(normalizedInput);
            targetFolder = vscode.workspace.getWorkspaceFolder(uri);
            if (!targetFolder) {
                return { ignored: false, reason: 'Path is outside workspace' };
            }
            relPath = this.toPosixPath(path.relative(targetFolder.uri.fsPath, normalizedInput));
        } else {
            targetFolder = folders[0];
            relPath = this.toPosixPath(relPath);
        }

        let matcher = this.ignoreMatchers.get(targetFolder.uri.fsPath);
        if (!matcher) {
            return { ignored: false, reason: 'Ignore rules not initialized yet' };
        }

        const ignored = matcher.ignores(relPath);
        const result = { ignored, reason: ignored ? 'Matched ignore rules' : 'Not ignored' };
        return result;
    }

    private isPathIgnored(uri: vscode.Uri): boolean {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (!folder) {
            return true;
        }

        const matcher = this.ignoreMatchers.get(folder.uri.fsPath);
        if (!matcher) {
            return false;
        }

        const relPath = this.toPosixPath(path.relative(folder.uri.fsPath, uri.fsPath));
        const cacheKey = `${folder.uri.fsPath}::${relPath}`;
        const cached = this.ignoreResultCache.get(cacheKey);
        if (cached !== undefined) {
            return cached;
        }

        const ignored = matcher.ignores(relPath);
        this.setIgnoreResultCache(cacheKey, ignored);
        return ignored;
    }

    private pruneIgnoredTrackedChanges(): void {
        const removedFiles: string[] = [];

        for (const filePath of this.trackedChanges.keys()) {
            const uri = vscode.Uri.file(filePath);
            if (this.isPathIgnored(uri)) {
                this.deleteTrackedChange(filePath);
                this.lineChanges.delete(filePath);
                this.markLineChangesUpdated(filePath);
                this.inlineViews.delete(filePath);
                removedFiles.push(filePath);
            }
        }

        if (removedFiles.length > 0) {
            this.emitTrackChangesEvent({ removedFiles });
        }
    }

    private async initializeWorkspaceSnapshots(): Promise<void> {
        const epoch = this.sessionEpoch;
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            this.snapshotInitialized = true;
            this.baselineBuilding = false;
            this._onDidChangeBaselineState.fire('ready');
            this.schedulePersistState();
            return;
        }

        await this.refreshIgnoreMatchers();
        if (!this.isCurrentEpoch(epoch)) { return; }

        for (const folder of folders) {
            if (!this.isRecording || !this.isCurrentEpoch(epoch)) {
                return;
            }

            const files = await vscode.workspace.findFiles(
                new vscode.RelativePattern(folder, '**/*'),
                new vscode.RelativePattern(folder, '**/{node_modules,.git,out,dist,build,coverage,tmp}/**')
            );
            if (!this.isCurrentEpoch(epoch)) { return; }

            const candidates = files.filter(uri => {
                if (this.isPathIgnored(uri)) {
                    return false;
                }
                return !this.fileSnapshots.has(uri.fsPath);
            });

            const batchSize = 50;
            const readConcurrency = 8;

            for (let i = 0; i < candidates.length; i += batchSize) {
                if (!this.isRecording || !this.isCurrentEpoch(epoch)) {
                    return;
                }

                const batch = candidates.slice(i, i + batchSize);
                await this.runWithConcurrency(batch, readConcurrency, async (uri) => {
                    if (!this.isRecording || !this.isCurrentEpoch(epoch)) {
                        return;
                    }
                    if (this.fileSnapshots.has(uri.fsPath)) {
                        return;
                    }
                    const state = await this.readFileSnapshot(uri);
                    if (!this.isCurrentEpoch(epoch)) { return; }
                    if (this.scanUncertainFiles.has(uri.fsPath)) {
                        this.recordUnresolvedBaseline(uri.fsPath, 'File changed during baseline scan; before-image is unknown');
                        return;
                    }
                    if (state.kind !== 'text') {
                        const reason = state.kind === 'unavailable'
                            ? state.reason
                            : 'File disappeared during baseline scan; before-image is unknown';
                        this.recordUnresolvedBaseline(uri.fsPath, reason);
                        return;
                    }
                    this.unresolvedBaselineFiles.delete(uri.fsPath);
                    this.fileSnapshots.set(uri.fsPath, state.content);
                    this.baselineExistingFiles.add(uri.fsPath);
                });

                if (!this.isRecording || !this.isCurrentEpoch(epoch)) {
                    return;
                }

                await this.yieldToEventLoop();
                if (!this.isCurrentEpoch(epoch)) { return; }
            }
        }

        this.snapshotInitialized = true;
        if (this.isRecording && this.baselineBuilding) {
            this.baselineBuilding = false;
            this._onDidChangeBaselineState.fire('ready');
        }
        await this.processPendingExternalChanges();
        this.schedulePersistState();
    }

    private isFileNotFound(error: unknown): boolean {
        const code = (error as { code?: string } | undefined)?.code;
        return code === 'FileNotFound' || code === 'ENOENT';
    }

    private async readFileSnapshot(uri: vscode.Uri): Promise<CurrentFileState> {
        const targetError = this.validateResourceTarget(uri.fsPath);
        if (uri.scheme !== 'file' || targetError) {
            return { kind: 'unavailable', reason: targetError ?? 'Only local file resources are supported' };
        }
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.type & vscode.FileType.Directory) {
                return { kind: 'unavailable', reason: 'Resource is a directory' };
            }
            if (stat.size > 5 * 1024 * 1024) {
                return { kind: 'unavailable', reason: 'File exceeds the 5 MiB limit' };
            }
            const content = await vscode.workspace.fs.readFile(uri);
            const afterStat = await vscode.workspace.fs.stat(uri);
            if (stat.size !== afterStat.size || stat.mtime !== afterStat.mtime || stat.type !== afterStat.type) {
                return { kind: 'unavailable', reason: 'File changed while being read; refresh before review' };
            }
            if (content.length > 5 * 1024 * 1024) {
                return { kind: 'unavailable', reason: 'File exceeds the 5 MiB limit' };
            }
            if (content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf) {
                return { kind: 'unavailable', reason: 'UTF-8 BOM files require encoding preservation and are read-only in this version' };
            }
            if (this.isLikelyBinaryContent(content)) {
                return { kind: 'unavailable', reason: 'Binary content is unsupported' };
            }
            try {
                return { kind: 'text', content: new TextDecoder('utf-8', { fatal: true }).decode(content) };
            } catch {
                return { kind: 'unavailable', reason: 'Unsupported text encoding (expected UTF-8)' };
            }
        } catch (error) {
            return this.isFileNotFound(error)
                ? { kind: 'missing' }
                : { kind: 'unavailable', reason: 'File cannot be read (access or provider error)' };
        }
    }

    private async readCurrentFileState(filePath: string): Promise<CurrentFileState> {
        // Existence and read errors come from the resource, never a stale clean editor.
        const state = await this.readFileSnapshot(vscode.Uri.file(filePath));
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath && d.uri.scheme === 'file');
        if (doc?.isDirty) {
            return { kind: 'unavailable', reason: 'Unsaved editor changes require review before file actions' };
        }
        return state;
    }

    private markFileUnavailable(filePath: string, reason: string): void {
        const previous = this.trackedChanges.get(filePath);
        this.setTrackedChange(filePath, {
            filePath, fileName: displayFileName(filePath),
            originalContent: this.fileSnapshots.get(filePath) ?? '',
            currentContent: previous?.currentContent ?? '',
            isDeleted: previous?.isDeleted ?? false,
            changes: previous?.changes ?? [], timestamp: new Date(), unavailableReason: reason
        });
        this.emitTrackChangesEvent({ changedFiles: [filePath] });
    }

    private recordUnresolvedBaseline(filePath: string, reason: string): void {
        this.unresolvedBaselineFiles.set(filePath, reason);
        this.markFileUnavailable(filePath, reason);
        this.schedulePersistState();
    }

    private async rebuildTrackedChangesFromSnapshots(): Promise<void> {
        const epoch = this.sessionEpoch;
        this.clearTrackedChanges();
        this.lineChanges.clear();
        this.resetChangeBlocksCaches();
        this.inlineViews.clear();

        const snapshotPaths = Array.from(this.fileSnapshots.keys());

        await this.runWithConcurrency(snapshotPaths, 8, async (filePath) => {
            const uri = vscode.Uri.file(filePath);
            if (this.isPathIgnored(uri)) {
                return;
            }

            const currentState = await this.readCurrentFileState(filePath);
            if (!this.isCurrentEpoch(epoch)) { return; }
            if (currentState.kind === 'text') {
                this.updateTrackedDiff(filePath, currentState.content);
                return;
            }

            if (currentState.kind === 'missing' && this.baselineExistingFiles.has(filePath)) {
                this.updateTrackedDiff(filePath, '', { currentExists: false });
            } else if (currentState.kind === 'unavailable') {
                this.markFileUnavailable(filePath, currentState.reason);
            }
        });
        if (!this.isCurrentEpoch(epoch)) { return; }
        for (const [filePath, reason] of this.unresolvedBaselineFiles) {
            if (!this.isPathIgnored(vscode.Uri.file(filePath))) {
                this.markFileUnavailable(filePath, reason);
            }
        }
    }

    private isLikelyBinaryContent(content: Uint8Array): boolean {
        if (content.length === 0) {
            return false;
        }

        const sampleSize = Math.min(content.length, 8192);
        let nonPrintableCount = 0;

        for (let i = 0; i < sampleSize; i++) {
            const byte = content[i];

            if (byte === 0x00) {
                return true;
            }

            const isAsciiControl = byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d;
            const isDel = byte === 0x7f;
            if (isAsciiControl || isDel) {
                nonPrintableCount++;
            }
        }

        return nonPrintableCount / sampleSize > 0.3;
    }

    private async runWithConcurrency<T>(
        items: T[],
        limit: number,
        worker: (item: T) => Promise<void>
    ): Promise<void> {
        let index = 0;
        const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (index < items.length) {
                const current = items[index++];
                await worker(current);
            }
        });
        await Promise.all(workers);
    }

    private async yieldToEventLoop(): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, 0));
    }

    private async processPendingExternalChanges(): Promise<void> {
        const epoch = this.sessionEpoch;
        if (this.pendingExternalChanges.size === 0) {
            return;
        }

        const pending = Array.from(this.pendingExternalChanges);
        this.pendingExternalChanges.clear();

        for (const filePath of pending) {
            if (!this.isRecording || !this.isCurrentEpoch(epoch)) {
                return;
            }

            const uri = vscode.Uri.file(filePath);
            if (this.isPathIgnored(uri)) {
                continue;
            }

            await this.readFileAndUpdate(filePath, uri);
        }
    }

    private async onExternalFileChanged(uri: vscode.Uri): Promise<void> {
        const epoch = this.sessionEpoch;
        if (!this.isRecording || !this.externalWatcherEnabled) {
            return;
        }

        if (uri.scheme !== 'file') {
            return;
        }

        if (this.isPathIgnored(uri)) {
            return;
        }

        const filePath = uri.fsPath;

        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
        if (doc && doc.isDirty) {
            this.markFileUnavailable(filePath, 'External change while editor has unsaved content; reconcile disk and buffer before review');
            return;
        }

        if (!this.fileSnapshots.has(filePath) && !this.snapshotInitialized) {
            this.scanUncertainFiles.add(filePath);
            this.pendingExternalChanges.add(filePath);
            this.recordUnresolvedBaseline(filePath, 'File changed during baseline scan; before-image is unknown');
            return;
        }

        const existingTimer = this.externalChangeTimers.get(filePath);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        const timer = setTimeout(() => {
            this.externalChangeTimers.delete(filePath);
            if (!this.isRecording || !this.externalWatcherEnabled || !this.isCurrentEpoch(epoch)) {
                return;
            }
            if (this.isPathIgnored(uri)) {
                return;
            }
            this.readFileAndUpdate(filePath, uri).catch(() => undefined);
        }, 120);

        this.externalChangeTimers.set(filePath, timer);
    }

    private onDocumentOpened(doc: vscode.TextDocument): void {
        this.ensureSnapshotForDocument(doc);
    }

    private async onExternalFileCreated(uri: vscode.Uri): Promise<void> {
        const epoch = this.sessionEpoch;
        if (!this.isRecording || !this.externalWatcherEnabled) {
            return;
        }

        if (uri.scheme !== 'file') {
            return;
        }

        if (this.isPathIgnored(uri)) {
            return;
        }

        const filePath = uri.fsPath;
        if (!this.snapshotInitialized && !this.fileSnapshots.has(filePath)) {
            this.scanUncertainFiles.add(filePath);
            this.recordUnresolvedBaseline(filePath, 'File appeared during baseline scan; before-image is unknown');
            return;
        }
        const state = await this.readFileSnapshot(uri);
        if (!this.isCurrentEpoch(epoch)) { return; }
        if (state.kind === 'unavailable') {
            this.markFileUnavailable(filePath, state.reason);
            return;
        }
        // Some watchers (notably Windows) can deliver a change notification before
        // the matching create notification. That provisional change has no
        // before-image and is marked unavailable, but the later create event is the
        // evidence that this path did not exist in the ready baseline. Do not,
        // however, resolve entries that were already uncertain during baseline scan.
        if (!this.fileSnapshots.has(filePath) && !this.unresolvedBaselineFiles.has(filePath)) {
            this.fileSnapshots.set(filePath, '');
            this.schedulePersistState();
        }
        await this.readFileAndUpdate(filePath, uri);
    }

    private async onExternalFileDeleted(uri: vscode.Uri): Promise<void> {
        const epoch = this.sessionEpoch;
        if (!this.isRecording || !this.externalWatcherEnabled || uri.scheme !== 'file' || this.isPathIgnored(uri)) {
            return;
        }
        // A delete notification may race an atomic replacement; confirm actual state.
        const targets = new Set([uri.fsPath, ...[...this.fileSnapshots.keys()].filter(filePath => {
            const relative = path.relative(uri.fsPath, filePath);
            return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
        })]);
        for (const filePath of targets) {
            if (!this.isCurrentEpoch(epoch)) { return; }
            await this.readFileAndUpdate(filePath, vscode.Uri.file(filePath));
        }
    }

    private async readFileAndUpdate(filePath: string, uri: vscode.Uri): Promise<void> {
        const epoch = this.sessionEpoch;
        if (this.pendingWriteFiles.has(filePath) && !this.activeWriteFiles.has(filePath)) {
            const doc = vscode.workspace.textDocuments.find(value => value.uri.fsPath === filePath);
            if (!doc?.isDirty) { this.pendingWriteFiles.delete(filePath); }
        }
        const state = await this.readFileSnapshot(uri);
        if (!this.isCurrentEpoch(epoch)) { return; }
        if (state.kind === 'unavailable') {
            this.markFileUnavailable(filePath, state.reason);
        } else if (state.kind === 'text') {
            this.updateTrackedDiff(filePath, state.content);
        } else if (this.fileSnapshots.has(filePath)) {
            this.updateTrackedDiff(filePath, '', { currentExists: false });
        }
    }

    private updateTrackedDiff(
        filePath: string,
        currentContent: string,
        options?: { baselineChanged?: boolean; currentExists?: boolean }
    ): void {
        if (this.pendingWriteFiles.has(filePath)) { return; }
        const currentExists = options?.currentExists !== false;
        const hadTrackedChange = this.trackedChanges.has(filePath);
        const hadLineChanges = this.lineChanges.has(filePath);
        const hadInlineView = this.inlineViews.has(filePath);
        let originalContent = this.fileSnapshots.get(filePath);
        if (originalContent === undefined) {
            // No before-image: do not silently accept an unknown baseline.
            this.markFileUnavailable(filePath, 'Baseline is unknown; start a new baseline explicitly');
            return;
        }

        const originalModel = this.toTextLineModel(originalContent);
        const currentModel = this.toTextLineModel(currentContent);
        const sameLogicalLines =
            originalModel.lines.length === currentModel.lines.length &&
            originalModel.lines.every((line, index) => line === currentModel.lines[index]);

        // Ignore pure EOL-style / final-EOL toggles and track only logical line changes.
        if (sameLogicalLines && this.baselineExistingFiles.has(filePath) === currentExists) {
            this.deleteTrackedChange(filePath);
            this.lineChanges.delete(filePath);
            this.markLineChangesUpdated(filePath);
            this.inlineViews.delete(filePath);
            const shouldNotify = hadTrackedChange || hadLineChanges || hadInlineView;
            if (shouldNotify) {
                this.emitTrackChangesEvent({
                    removedFiles: [filePath],
                    baselineChanged: options?.baselineChanged ?? false
                });
            }
            return;
        }

        const normalizedOriginal = this.serializeTextModel(
            { ...originalModel, dominantEol: '\n' },
            '\n'
        );
        const normalizedCurrent = this.serializeTextModel(
            { ...currentModel, dominantEol: '\n' },
            '\n'
        );
        const changes = Diff.diffLines(normalizedOriginal, normalizedCurrent);
        const fileName = displayFileName(filePath);
        const isDeleted = !currentExists;

        this.setTrackedChange(filePath, {
            filePath,
            fileName,
            sourceNote: this.shouldTrackOnlyAutomatedChanges() && !this.isAutomationChangeAllowed(filePath)
                ? 'Change source is uncertain; manual, formatter, reload and external edits remain pending until reviewed.'
                : undefined,
            originalContent,
            currentContent,
            isDeleted,
            changes,
            timestamp: new Date()
        });

        this.calculateLineChanges(filePath);
        this.emitTrackChangesEvent({
            changedFiles: [filePath],
            baselineChanged: options?.baselineChanged ?? false
        });
    }

    private validateActionTarget(filePath: string): string | undefined {
        if (this.recoveryBlocked) { return 'Session recovery is blocked; preserve or discard the damaged state before review actions'; }
        if (this.baselineBuilding || !this.snapshotInitialized) { return 'Baseline is incomplete; rebuild it before review actions'; }
        if (this.disposed || this.workspaceContextChanged) { return 'Session is closed or workspace membership changed; review is paused'; }
        const gitPauseReason = this.getGitPauseReason(filePath);
        if (gitPauseReason) { return gitPauseReason; }
        return this.validateResourceTarget(filePath);
    }

    private pathBelongsToRoot(filePath: string, root: string): boolean {
        const relative = path.relative(root, filePath);
        return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    }

    public setBaselineGitContexts(contexts: GitContextSnapshot[]): void {
        this.baselineGitContexts.clear();
        this.pausedGitRepositories.clear();
        for (const context of contexts) {
            if (context.inProgress) {
                this.pausedGitRepositories.set(context.repoRoot, 'Git merge or rebase is in progress; review actions are paused');
            } else {
                this.baselineGitContexts.set(context.repoRoot, { ...context });
            }
        }
        this.schedulePersistState();
        this.emitTrackChangesEvent({ fullRefresh: true });
    }

    public reconcileRestoredGitContexts(contexts: GitContextSnapshot[]): void {
        if (this.baselineGitContexts.size === 0) {
            // One-time migration for sessions written before Git contexts existed.
            this.setBaselineGitContexts(contexts);
            return;
        }
        const currentRoots = new Set(contexts.map(context => context.repoRoot));
        for (const context of contexts) { this.observeGitContext(context); }
        for (const root of this.baselineGitContexts.keys()) {
            if (!currentRoots.has(root)) { this.observeGitRepositoryRemoved(root); }
        }
    }

    public observeGitContext(context: GitContextSnapshot): string | undefined {
        const baseline = this.baselineGitContexts.get(context.repoRoot);
        if (!baseline) {
            const reason = 'Git repository appeared after the baseline was created; review actions for it are paused';
            this.pausedGitRepositories.set(context.repoRoot, reason);
            this.emitTrackChangesEvent({ fullRefresh: true });
            this.schedulePersistState();
            return reason;
        }
        if (this.pausedGitRepositories.has(context.repoRoot)) {
            return undefined;
        }
        const comparison = compareGitContexts(baseline, context);
        if (!comparison.compatible) {
            const reason = `${comparison.reason ?? 'Git context changed'}; review actions for this repository are paused`;
            this.pausedGitRepositories.set(context.repoRoot, reason);
            this.emitTrackChangesEvent({ fullRefresh: true });
            this.schedulePersistState();
            return reason;
        }
        // Commit movement on the same named branch is informational, not a reset.
        this.baselineGitContexts.set(context.repoRoot, { ...context });
        this.schedulePersistState();
        return undefined;
    }

    public observeGitRepositoryRemoved(repoRoot: string): string | undefined {
        if (!this.baselineGitContexts.has(repoRoot)) { return undefined; }
        const existing = this.pausedGitRepositories.get(repoRoot);
        if (existing) { return undefined; }
        const reason = 'Git repository became unavailable or was closed; review actions for it are paused';
        this.pausedGitRepositories.set(repoRoot, reason);
        this.emitTrackChangesEvent({ fullRefresh: true });
        this.schedulePersistState();
        return reason;
    }

    public getGitPauseReason(filePath: string): string | undefined {
        return [...this.pausedGitRepositories.entries()]
            .filter(([root]) => this.pathBelongsToRoot(filePath, root))
            .sort(([left], [right]) => right.length - left.length)[0]?.[1];
    }

    public getPausedGitRepositories(): Array<{ repoRoot: string; reason: string }> {
        return [...this.pausedGitRepositories.entries()]
            .map(([repoRoot, reason]) => ({ repoRoot, reason }))
            .sort((left, right) => left.repoRoot.localeCompare(right.repoRoot));
    }

    private async archiveCurrentSession(): Promise<boolean> {
        const targetUri = this.getPersistedStateUri();
        const archiveUri = this.getPersistedStateUri(this.persistedStateArchiveFileName);
        if (!targetUri || !archiveUri) {
            this.reportPersistenceIssue('Cannot archive the Git review because extension storage is unavailable.');
            return false;
        }
        if (!await this.flushPendingPersistence()) { return false; }
        try {
            await vscode.workspace.fs.copy(targetUri, archiveUri, { overwrite: true });
            return true;
        } catch (error) {
            this.reportPersistenceIssue('Failed to archive the current Diff Tracker review; repository rebuild was blocked.', error);
            return false;
        }
    }

    public async rebuildRepositoryBaseline(repoRoot: string, context: GitContextSnapshot): Promise<boolean> {
        if (this.disposed || this.recoveryBlocked || !this.snapshotInitialized || this.baselineBuilding ||
            context.repoRoot !== repoRoot || context.inProgress || !path.isAbsolute(repoRoot)) {
            return false;
        }
        const overlapsWorkspace = this.getWorkspaceRoots().some(workspaceRoot =>
            this.pathBelongsToRoot(workspaceRoot, repoRoot) || this.pathBelongsToRoot(repoRoot, workspaceRoot));
        if (!overlapsWorkspace) { return false; }
        if (vscode.workspace.textDocuments.some(document =>
            document.uri.scheme === 'file' && this.pathBelongsToRoot(document.uri.fsPath, repoRoot) && document.isDirty)) {
            return false;
        }
        if (!await this.archiveCurrentSession()) { return false; }

        const previous = {
            fileSnapshots: new Map(this.fileSnapshots),
            baselineExistingFiles: new Set(this.baselineExistingFiles),
            trackedChanges: new Map(this.trackedChanges),
            lineChanges: new Map(this.lineChanges),
            inlineViews: new Map(this.inlineViews),
            revertHistory: [...this.revertHistory],
            unresolvedBaselineFiles: new Map(this.unresolvedBaselineFiles),
            baselineGitContexts: new Map(this.baselineGitContexts),
            pausedGitRepositories: new Map(this.pausedGitRepositories)
        };
        const restorePrevious = async (): Promise<void> => {
            this.fileSnapshots = previous.fileSnapshots;
            this.baselineExistingFiles = previous.baselineExistingFiles;
            this.trackedChanges = previous.trackedChanges;
            this.lineChanges = previous.lineChanges;
            this.inlineViews = previous.inlineViews;
            this.revertHistory = previous.revertHistory;
            this.unresolvedBaselineFiles = previous.unresolvedBaselineFiles;
            this.baselineGitContexts = previous.baselineGitContexts;
            this.pausedGitRepositories = previous.pausedGitRepositories;
            this.resetChangeBlocksCaches();
            this.trackedChangesVersion++;
            this.trackedChangesCacheVersion = -1;
            if (this.isRecording) { await this.startExternalWatchers(); }
            this.emitTrackChangesEvent({ fullRefresh: true });
        };

        const epoch = this.advanceEpoch();
        const previousReviewPaths = [...this.trackedChanges.keys()].filter(filePath => this.pathBelongsToRoot(filePath, repoRoot));
        try {
            const repositoryBaselinePaths = new Set([
                ...this.fileSnapshots.keys(),
                ...this.unresolvedBaselineFiles.keys()
            ]);
            for (const filePath of repositoryBaselinePaths) {
                if (!this.pathBelongsToRoot(filePath, repoRoot)) { continue; }
                this.fileSnapshots.delete(filePath);
                this.baselineExistingFiles.delete(filePath);
                this.unresolvedBaselineFiles.delete(filePath);
                this.deleteTrackedChange(filePath);
                this.lineChanges.delete(filePath);
                this.inlineViews.delete(filePath);
                this.markLineChangesUpdated(filePath);
            }

            await this.refreshIgnoreMatchers();
            const files = await vscode.workspace.findFiles(
                new vscode.RelativePattern(repoRoot, '**/*'),
                new vscode.RelativePattern(repoRoot, '**/{node_modules,.git,out,dist,build,coverage,tmp}/**')
            );
            if (!this.isCurrentEpoch(epoch)) { throw new Error('Session changed during repository baseline rebuild'); }
            await this.runWithConcurrency(files.filter(uri => uri.scheme === 'file' && !this.isPathIgnored(uri)), 8, async uri => {
                const state = await this.readFileSnapshot(uri);
                if (!this.isCurrentEpoch(epoch)) { throw new Error('Session changed during repository baseline rebuild'); }
                if (state.kind !== 'text') {
                    throw new Error(state.kind === 'unavailable' ? state.reason : `File disappeared during baseline rebuild: ${displayFileName(uri.fsPath)}`);
                }
                this.unresolvedBaselineFiles.delete(uri.fsPath);
                this.fileSnapshots.set(uri.fsPath, state.content);
                this.baselineExistingFiles.add(uri.fsPath);
            });

            this.revertHistory = this.revertHistory.map(record => ({
                ...record,
                items: record.items.filter(item => !this.pathBelongsToRoot(item.filePath, repoRoot))
            })).filter(record => record.items.length > 0);
            this.baselineGitContexts.set(repoRoot, { ...context });
            this.pausedGitRepositories.delete(repoRoot);
            this.resetChangeBlocksCaches();
            if (this.isRecording) { await this.startExternalWatchers(); }
            if (!await this.flushPendingPersistence()) {
                await restorePrevious();
                return false;
            }
            this.emitTrackChangesEvent({ removedFiles: previousReviewPaths, fullRefresh: true, baselineChanged: true });
            return true;
        } catch (error) {
            this.reportPersistenceIssue('Failed to rebuild the repository baseline; the archived review remains preserved.', error);
            await restorePrevious();
            return false;
        }
    }

    private validateResourceTarget(filePath: string): string | undefined {
        if (this.disposed) { return 'Session is closed; resource access is blocked'; }
        const uri = vscode.Uri.file(filePath);
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (!path.isAbsolute(filePath) || !folder || folder.uri.scheme !== 'file') {
            return 'Resource is outside the current local workspace; action blocked';
        }
        const isWithin = (root: string, target: string): boolean => {
            const relative = path.relative(root, target);
            return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
        };
        if (!isWithin(folder.uri.fsPath, filePath)) {
            return 'Resource is outside the workspace or is its root; action blocked';
        }
        try {
            const realRoot = fs.realpathSync(folder.uri.fsPath);
            let existing = filePath;
            while (true) {
                try {
                    fs.lstatSync(existing);
                    break;
                } catch (error) {
                    if (!this.isFileNotFound(error)) { throw error; }
                    const parent = path.dirname(existing);
                    if (parent === existing) { throw error; }
                    existing = parent;
                }
            }
            const realExisting = fs.realpathSync(existing);
            if (realExisting !== realRoot && !isWithin(realRoot, realExisting)) {
                return 'Symbolic link resolves outside the workspace; action blocked';
            }
        } catch {
            return 'Cannot verify the resource workspace boundary; action blocked';
        }
        return undefined;
    }

    private actionResult(filePath: string, status: ActionResult['status'], reason?: string, bufferChanged = false): ActionResult {
        return { filePath, status, reason, bufferChanged };
    }

    private fileStateMatches(left: PersistedFileState, right: PersistedFileState): boolean {
        return left.exists === right.exists && (!left.exists || left.content === right.content);
    }

    private createRevertItem(
        filePath: string,
        before: PersistedFileState,
        after: PersistedFileState,
        saveMode: PersistedRevertItem['saveMode']
    ): PersistedRevertItem | undefined {
        const baseline = this.fileSnapshots.get(filePath);
        if (baseline === undefined) { return undefined; }
        return {
            filePath,
            baselineRevision: this.revision(baseline, this.baselineExistingFiles.has(filePath)),
            before,
            after,
            saveMode
        };
    }

    private async prepareRevertRecord(items: PersistedRevertItem[]): Promise<PersistedRevertRecord | undefined> {
        if (items.length === 0) { return undefined; }
        const previousHistory = [...this.revertHistory];
        const record: PersistedRevertRecord = {
            id: `revert-${Date.now()}-${this.nextRevertRecordId++}`,
            createdAt: new Date().toISOString(),
            items
        };
        this.revertHistory.push(record);
        this.revertHistory = this.revertHistory.slice(-this.maxRevertHistory);
        if (await this.flushPendingPersistence()) { return record; }
        this.revertHistory = previousHistory;
        return undefined;
    }

    private async removeRevertRecord(record: PersistedRevertRecord): Promise<void> {
        const previousLength = this.revertHistory.length;
        this.revertHistory = this.revertHistory.filter(candidate => candidate.id !== record.id);
        if (this.revertHistory.length !== previousLength) { await this.flushPendingPersistence(); }
    }

    private createFileRevertItem(filePath: string): PersistedRevertItem | undefined {
        const change = this.trackedChanges.get(filePath);
        if (!change || !this.fileSnapshots.has(filePath)) { return undefined; }
        return this.createRevertItem(
            filePath,
            { exists: !change.isDeleted, content: change.currentContent },
            { exists: this.baselineExistingFiles.has(filePath), content: change.originalContent },
            'disk'
        );
    }

    private preparedRecordMatchesItem(record: PersistedRevertRecord, expected: PersistedRevertItem): boolean {
        const item = record.items.find(candidate => candidate.filePath === expected.filePath);
        return !!item && item.baselineRevision === expected.baselineRevision && item.saveMode === expected.saveMode &&
            this.fileStateMatches(item.before, expected.before) && this.fileStateMatches(item.after, expected.after);
    }

    private async finalizeBatchRevertRecord(batch: PreparedBatchRevert): Promise<void> {
        const current = this.revertHistory.find(candidate => candidate.id === batch.record.id);
        if (!current) { return; }
        current.items = current.items.filter(item => batch.retainPaths.has(item.filePath));
        if (current.items.length === 0) {
            await this.removeRevertRecord(current);
            return;
        }
        await this.flushPendingPersistence();
    }

    private clearFileReview(filePath: string, baselineChanged = false): void {
        this.deleteTrackedChange(filePath);
        this.lineChanges.delete(filePath);
        this.markLineChangesUpdated(filePath);
        this.inlineViews.delete(filePath);
        this.emitTrackChangesEvent({ removedFiles: [filePath], baselineChanged });
    }

    public async revertAllChanges(tokens: ReviewToken[] = this.getReviewTokens()): Promise<BatchActionResult> {
        if (tokens.length === 0) { return { results: [], succeeded: 0, failed: 0 }; }
        const preparedPaths = new Set<string>();
        const items = tokens.flatMap(token => {
            if (preparedPaths.has(token.filePath)) { return []; }
            preparedPaths.add(token.filePath);
            const item = this.createFileRevertItem(token.filePath);
            return item ? [item] : [];
        });
        const record = await this.prepareRevertRecord(items);
        if (!record) {
            const results = tokens.map(token => this.actionResult(
                token.filePath,
                'failed',
                'Cannot persist the batch recovery record; Revert All was blocked'
            ));
            return { results, succeeded: 0, failed: results.length };
        }
        const batch: PreparedBatchRevert = { record, retainPaths: new Set<string>() };
        const result = await this.runReviewedBatch(tokens, token => this.revertFileQueued(token.filePath, token, batch));
        await this.finalizeBatchRevertRecord(batch);
        return result;
    }

    public async keepAllChanges(tokens: ReviewToken[] = this.getReviewTokens()): Promise<BatchActionResult> {
        return this.runReviewedBatch(tokens, token => this.keepAllChangesInFile(token.filePath, token));
    }

    private async runReviewedBatch(tokens: ReviewToken[], action: (token: ReviewToken) => Promise<ActionResult>): Promise<BatchActionResult> {
        const results: ActionResult[] = [];
        for (const token of [...tokens]) {
            try { results.push(await action(token)); }
            catch { results.push(this.actionResult(token.filePath, 'failed', 'Unexpected action failure; review retained')); }
        }
        const succeeded = results.filter(result => result.status === 'success').length;
        return { results, succeeded, failed: results.length - succeeded };
    }

    public revertFile(filePath: string, token = this.getReviewToken(filePath)): Promise<ActionResult> {
        return this.revertFileQueued(filePath, token);
    }

    private revertFileQueued(
        filePath: string,
        token: ReviewToken | undefined,
        preparedBatch?: PreparedBatchRevert
    ): Promise<ActionResult> {
        return this.queueFileAction(
            filePath,
            token,
            review => this.revertFileReviewed(filePath, review, preparedBatch)
        );
    }

    private async revertFileReviewed(
        filePath: string,
        review: ReviewToken,
        preparedBatch?: PreparedBatchRevert
    ): Promise<ActionResult> {
        const targetError = this.validateActionTarget(filePath);
        if (targetError) { return this.actionResult(filePath, 'conflict', targetError); }
        const change = this.trackedChanges.get(filePath);
        if (!change || !this.fileSnapshots.has(filePath)) {
            return this.actionResult(filePath, 'conflict', 'No known baseline is available');
        }
        const revertItem = this.createFileRevertItem(filePath);
        if (!revertItem) { return this.actionResult(filePath, 'failed', 'Cannot create a recovery record; revert blocked'); }
        if (preparedBatch && !this.preparedRecordMatchesItem(preparedBatch.record, revertItem)) {
            return this.actionResult(filePath, 'conflict', 'Batch recovery record no longer matches the reviewed file');
        }
        const recoveryRecord = preparedBatch?.record ?? await this.prepareRevertRecord([revertItem]);
        if (!recoveryRecord) {
            return this.actionResult(filePath, 'failed', 'Cannot persist a recovery record; revert blocked');
        }
        const result = await this.restoreFileToContent(filePath, change.originalContent, {
            deleteIfMissingInBaseline: !this.baselineExistingFiles.has(filePath), review
        });
        if (preparedBatch && (result.status === 'success' || result.bufferChanged)) {
            preparedBatch.retainPaths.add(filePath);
        }
        if (result.status !== 'success') {
            if (!preparedBatch && !result.bufferChanged) { await this.removeRevertRecord(recoveryRecord); }
            return result;
        }
        // Verify persisted state, including existence, before removing this item.
        const current = await this.readCurrentFileState(filePath);
        if (!this.matchesReview(review)) { return this.actionResult(filePath, 'conflict', 'Session or review changed during revert', result.bufferChanged); }
        const baselineExists = this.baselineExistingFiles.has(filePath);
        if ((baselineExists && (current.kind !== 'text' || current.content !== change.originalContent)) ||
            (!baselineExists && current.kind !== 'missing')) {
            return this.actionResult(filePath, 'conflict', 'File does not match the baseline after revert; review retained', result.bufferChanged);
        }
        this.clearFileReview(filePath);
        this.schedulePersistState();
        return result;
    }

    private async readUndoCurrentState(item: PersistedRevertItem): Promise<CurrentFileState> {
        const document = vscode.workspace.textDocuments.find(doc => doc.uri.scheme === 'file' && doc.uri.fsPath === item.filePath);
        if (document?.isDirty) { return { kind: 'text', content: document.getText() }; }
        return this.readCurrentFileState(item.filePath);
    }

    private async applyUndoItem(item: PersistedRevertItem, epoch: number): Promise<ActionResult> {
        if (!this.isCurrentEpoch(epoch)) {
            return this.actionResult(item.filePath, 'cancelled', 'Session changed before recovery');
        }
        const targetError = this.validateActionTarget(item.filePath);
        if (targetError) { return this.actionResult(item.filePath, 'conflict', targetError); }
        const baseline = this.fileSnapshots.get(item.filePath);
        if (baseline === undefined || this.revision(baseline, this.baselineExistingFiles.has(item.filePath)) !== item.baselineRevision) {
            return this.actionResult(item.filePath, 'conflict', 'Baseline changed after the revert; recovery record is stale');
        }
        const current = await this.readUndoCurrentState(item);
        if (!this.isCurrentEpoch(epoch)) {
            return this.actionResult(item.filePath, 'cancelled', 'Session changed during recovery read');
        }
        if (current.kind === 'unavailable') { return this.actionResult(item.filePath, 'failed', current.reason); }
        const currentState: PersistedFileState = {
            exists: current.kind === 'text',
            content: current.kind === 'text' ? current.content : ''
        };
        if (this.fileStateMatches(currentState, item.before)) {
            this.updateTrackedDiff(item.filePath, item.before.content, { currentExists: item.before.exists });
            return this.actionResult(item.filePath, 'success', 'The native editor undo already restored this change');
        }
        if (!this.fileStateMatches(currentState, item.after)) {
            return this.actionResult(item.filePath, 'conflict', 'File changed after the revert; recovery will not overwrite newer work');
        }

        const uri = vscode.Uri.file(item.filePath);
        const edit = new vscode.WorkspaceEdit();
        if (!item.before.exists) {
            edit.deleteFile(uri, { ignoreIfNotExists: false, recursive: false });
            if (!this.isCurrentEpoch(epoch)) {
                return this.actionResult(item.filePath, 'cancelled', 'Session changed before recovery deletion');
            }
            if (!await vscode.workspace.applyEdit(edit)) {
                return this.actionResult(item.filePath, 'failed', 'Editor rejected recovery file deletion');
            }
            this.updateTrackedDiff(item.filePath, '', { currentExists: false });
            return this.actionResult(item.filePath, 'success', undefined, true);
        }
        if (!item.after.exists) {
            this.pendingWriteFiles.add(item.filePath);
            this.activeWriteFiles.add(item.filePath);
            let bufferChanged = false;
            try {
                const createEdit = new vscode.WorkspaceEdit();
                createEdit.createFile(uri, { overwrite: false, ignoreIfExists: false });
                if (!this.isCurrentEpoch(epoch)) {
                    return this.actionResult(item.filePath, 'cancelled', 'Session changed before recovery creation');
                }
                bufferChanged = true;
                if (!await vscode.workspace.applyEdit(createEdit)) {
                    return this.actionResult(item.filePath, 'failed', 'Editor rejected recovery file creation', true);
                }
                const document = await vscode.workspace.openTextDocument(uri);
                if (!this.isCurrentEpoch(epoch)) {
                    return this.actionResult(item.filePath, 'cancelled', 'Session changed during recovery creation', true);
                }
                if (item.before.content.length > 0) {
                    const contentEdit = new vscode.WorkspaceEdit();
                    contentEdit.insert(uri, new vscode.Position(0, 0), item.before.content);
                    if (!await vscode.workspace.applyEdit(contentEdit)) {
                        return this.actionResult(item.filePath, 'failed', 'Editor rejected recovery file content', true);
                    }
                }
                if (document.getText() !== item.before.content) {
                    return this.actionResult(item.filePath, 'failed', 'Recovery file content was not applied', true);
                }
                if (item.saveMode === 'disk' && !await document.save()) {
                    return this.actionResult(item.filePath, 'failed', 'Recovery created the buffer but saving failed', true);
                }
                bufferChanged = false;
            } finally {
                this.activeWriteFiles.delete(item.filePath);
                if (!bufferChanged) { this.pendingWriteFiles.delete(item.filePath); }
            }
            this.updateTrackedDiff(item.filePath, item.before.content, { currentExists: true });
            return this.actionResult(item.filePath, 'success', undefined, true);
        }

        const document = await vscode.workspace.openTextDocument(uri);
        if (item.saveMode === 'disk' && document.isDirty) {
            return this.actionResult(item.filePath, 'conflict', 'Unsaved editor changes appeared after revert; recovery blocked');
        }
        edit.replace(uri, this.getFullDocumentRange(document), item.before.content);
        this.pendingWriteFiles.add(item.filePath);
        this.activeWriteFiles.add(item.filePath);
        try {
            if (!this.isCurrentEpoch(epoch)) {
                return this.actionResult(item.filePath, 'cancelled', 'Session changed before recovery edit');
            }
            if (!await vscode.workspace.applyEdit(edit) || document.getText() !== item.before.content) {
                return this.actionResult(item.filePath, 'failed', 'Editor rejected recovery edit', document.getText() !== item.after.content);
            }
            if (item.saveMode === 'disk') {
                if (!await document.save()) {
                    return this.actionResult(item.filePath, 'failed', 'Recovery changed the buffer but saving failed', true);
                }
            }
            this.pendingWriteFiles.delete(item.filePath);
            this.updateTrackedDiff(item.filePath, item.before.content, { currentExists: true });
            return this.actionResult(item.filePath, 'success', undefined, true);
        } finally {
            this.activeWriteFiles.delete(item.filePath);
            this.pendingWriteFiles.delete(item.filePath);
        }
    }

    public undoLastRevert(): Promise<BatchActionResult> {
        const epoch = this.sessionEpoch;
        const operation = this.undoActionQueue
            .catch(() => undefined)
            .then(() => this.performUndoLastRevert(epoch));
        this.undoActionQueue = operation.then(() => undefined, () => undefined);
        return operation;
    }

    private async performUndoLastRevert(epoch: number): Promise<BatchActionResult> {
        if (!this.isCurrentEpoch(epoch)) { return { results: [], succeeded: 0, failed: 0 }; }
        const record = this.revertHistory[this.revertHistory.length - 1];
        if (!record) { return { results: [], succeeded: 0, failed: 0 }; }
        const results: ActionResult[] = [];
        const remaining: PersistedRevertItem[] = [];
        for (const item of [...record.items].reverse()) {
            try {
                const result = await this.applyUndoItem(item, epoch);
                results.push(result);
                if (result.status !== 'success') { remaining.unshift(item); }
            } catch {
                results.push(this.actionResult(item.filePath, 'failed', 'Unexpected recovery failure; newer work was preserved'));
                remaining.unshift(item);
            }
        }
        const recordIndex = this.isCurrentEpoch(epoch)
            ? this.revertHistory.findIndex(candidate =>
                candidate === record && candidate.id === record.id && candidate.createdAt === record.createdAt
            )
            : -1;
        if (recordIndex >= 0) {
            if (remaining.length === 0) {
                this.revertHistory.splice(recordIndex, 1);
            } else {
                record.items = remaining;
            }
        }
        await this.flushPendingPersistence();
        const succeeded = results.filter(result => result.status === 'success').length;
        return { results, succeeded, failed: results.length - succeeded };
    }

    private async restoreFileToContent(
        filePath: string,
        content: string,
        options?: { deleteIfMissingInBaseline?: boolean; review?: ReviewToken }
    ): Promise<ActionResult> {
        const epoch = this.sessionEpoch;
        const uri = vscode.Uri.file(filePath);
        const openDoc = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === filePath && doc.uri.scheme === 'file');
        if (openDoc?.isDirty) {
            return this.actionResult(filePath, 'conflict', 'Unsaved editor changes; file skipped');
        }
        const state = await this.readCurrentFileState(filePath);
        if (options?.review && !await this.verifyReview(options.review)) {
            return this.actionResult(filePath, 'conflict', 'Review changed before revert');
        }
        if (state.kind === 'unavailable') {
            this.markFileUnavailable(filePath, state.reason);
            return this.actionResult(filePath, 'failed', state.reason);
        }
        if (options?.deleteIfMissingInBaseline) {
            return this.deleteFileForMissingBaseline(uri, filePath, options.review);
        }
        let bufferChanged = false;
        let editedDocument: vscode.TextDocument | undefined;
        let beforeText: string | undefined;
        this.pendingWriteFiles.add(filePath);
        this.activeWriteFiles.add(filePath);
        try {
            if (state.kind === 'missing') {
                // Only confirmed absence permits creation. No overwrite fallback after open/save errors.
                const createEdit = new vscode.WorkspaceEdit();
                createEdit.createFile(uri, { overwrite: false, ignoreIfExists: false });
                const targetError = this.validateActionTarget(filePath);
                if (targetError) { return this.actionResult(filePath, 'conflict', targetError); }
                // A failed WorkspaceEdit may have created the resource before rejecting
                // a later entry, so conservatively retain recovery until disk is verified.
                bufferChanged = true;
                if (!await vscode.workspace.applyEdit(createEdit)) {
                    return this.actionResult(filePath, 'failed', 'File creation was rejected', true);
                }
                editedDocument = await vscode.workspace.openTextDocument(uri);
                beforeText = '';
                if (content.length > 0) {
                    const contentEdit = new vscode.WorkspaceEdit();
                    contentEdit.insert(uri, new vscode.Position(0, 0), content);
                    if (!await vscode.workspace.applyEdit(contentEdit)) {
                        return this.actionResult(filePath, 'failed', 'Created file content was rejected', true);
                    }
                }
                if (editedDocument.getText() !== content) {
                    return this.actionResult(filePath, 'failed', 'Created file content was not applied', true);
                }
                if (!await editedDocument.save()) {
                    this.markFileUnavailable(filePath, 'File was created but saving its restored content failed; review retained');
                    return this.actionResult(filePath, 'failed', 'File was created but saving its restored content failed; review retained', true);
                }
                bufferChanged = false;
                return this.actionResult(filePath, 'success', undefined, true);
            }
            const doc = await vscode.workspace.openTextDocument(uri);
            if (options?.review && !await this.verifyReview(options.review)) {
                return this.actionResult(filePath, 'conflict', 'Review changed while opening document');
            }
            if (doc.isDirty) {
                return this.actionResult(filePath, 'conflict', 'Unsaved editor changes; file skipped');
            }
            editedDocument = doc;
            beforeText = doc.getText();
            const edit = new vscode.WorkspaceEdit();
            edit.replace(uri, this.getFullDocumentRange(doc), content);
            const targetError = this.validateActionTarget(filePath);
            if (targetError) { return this.actionResult(filePath, 'conflict', targetError); }
            if (!await vscode.workspace.applyEdit(edit)) {
                bufferChanged = doc.getText() !== beforeText;
                return this.actionResult(filePath, 'failed', 'Editor rejected the revert; review retained', bufferChanged);
            }
            bufferChanged = true;
            if (options?.review && (!this.matchesReview(options.review) || doc.getText() !== content)) {
                return this.actionResult(filePath, 'conflict', 'Document or session changed during edit; buffer not saved', true);
            }
            const diskBeforeSave = await this.readFileSnapshot(uri);
            if (options?.review && (!this.matchesReview(options.review) || diskBeforeSave.kind !== 'text' ||
                this.revision(diskBeforeSave.content, true) !== options.review.currentRevision || doc.getText() !== content)) {
                return this.actionResult(filePath, 'conflict', 'Disk changed during edit; buffer not saved', true);
            }
            const saveTargetError = this.validateActionTarget(filePath);
            if (saveTargetError) { return this.actionResult(filePath, 'conflict', saveTargetError, true); }
            const saved = await doc.save();
            if (!this.isCurrentEpoch(epoch)) { return this.actionResult(filePath, 'cancelled', 'Session changed during save', true); }
            if (!saved) {
                this.markFileUnavailable(filePath, 'Editor buffer changed but saving failed; pending review retained');
                return this.actionResult(filePath, 'failed', 'Editor buffer changed but saving failed; pending review retained', true);
            }
            bufferChanged = false;
            return this.actionResult(filePath, 'success', undefined, true);
        } catch {
            if (!this.isCurrentEpoch(epoch)) { return this.actionResult(filePath, 'cancelled', 'Session changed during revert', bufferChanged); }
            if (editedDocument && beforeText !== undefined) {
                bufferChanged = bufferChanged || editedDocument.getText() !== beforeText;
            }
            const reason = bufferChanged
                ? 'Editor buffer changed but saving failed; pending review retained'
                : 'Revert failed (open, edit or provider error); review retained';
            if (bufferChanged) { this.markFileUnavailable(filePath, reason); }
            return this.actionResult(filePath, 'failed', reason, bufferChanged);
        } finally {
            if (this.isCurrentEpoch(epoch)) {
                this.activeWriteFiles.delete(filePath);
                // Keep the failed buffer from erasing the disk-level pending entry via document events.
                if (!bufferChanged) { this.pendingWriteFiles.delete(filePath); }
            }
        }
    }

    private async deleteFileForMissingBaseline(uri: vscode.Uri, filePath: string, review?: ReviewToken): Promise<ActionResult> {
        const doc = vscode.workspace.textDocuments.find(value => value.uri.fsPath === filePath);
        if (doc?.isDirty) {
            return this.actionResult(filePath, 'conflict', 'Unsaved editor changes; file skipped');
        }
        try {
            if (review && !await this.verifyReview(review)) { return this.actionResult(filePath, 'conflict', 'Review changed before deletion'); }
            const edit = new vscode.WorkspaceEdit();
            edit.deleteFile(uri, { ignoreIfNotExists: true, recursive: false });
            const targetError = this.validateActionTarget(filePath);
            if (targetError) { return this.actionResult(filePath, 'conflict', targetError); }
            if (!await vscode.workspace.applyEdit(edit)) {
                return this.actionResult(filePath, 'failed', 'Editor rejected new-file deletion');
            }
            return this.actionResult(filePath, 'success');
        } catch {
            return this.actionResult(filePath, 'failed', 'New-file deletion failed; review retained');
        }
    }

    public getIsRecording(): boolean {
        return this.isRecording;
    }

    public getBaselineState(): 'idle' | 'building' | 'ready' {
        if (this.baselineBuilding) {
            return 'building';
        }
        if (!this.isRecording) {
            return 'idle';
        }
        return 'ready';
    }

    public getTrackedChanges(): FileDiff[] {
        if (this.trackedChangesCacheVersion !== this.trackedChangesVersion) {
            this.trackedChangesCache = Array.from(this.trackedChanges.values())
                .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
            this.trackedChangesCacheVersion = this.trackedChangesVersion;
        }

        return this.trackedChangesCache.slice();
    }

    public getLineChanges(filePath: string): LineChange[] | undefined {
        return this.lineChanges.get(filePath);
    }

    public getOriginalContent(filePath: string): string | undefined {
        return this.fileSnapshots.get(filePath);
    }

    public getInlineContent(filePath: string): string | undefined {
        const view = this.ensureInlineView(filePath);
        if (!view) {
            return undefined;
        }

        return view.content;
    }

    public getInlineView(filePath: string): InlineDiffView | undefined {
        return this.ensureInlineView(filePath);
    }

    public buildInlineViewFromContents(originalContent: string, currentContent: string): InlineDiffView {
        return this.buildDiffViewFromContents(
            originalContent,
            currentContent
        ).inlineView;
    }

    /**
     * Revert a specific change block to its original content
     */
    public revertBlock(filePath: string, blockRef: string | number, token = this.getReviewToken(filePath)): Promise<ActionResult> {
        return this.queueFileAction(filePath, token, review => this.revertBlockReviewed(filePath, blockRef, review));
    }

    private async revertBlockReviewed(filePath: string, blockRef: string | number, review: ReviewToken): Promise<ActionResult> {
        const targetError = this.validateActionTarget(filePath);
        if (targetError) { return this.actionResult(filePath, 'conflict', targetError); }
        const originalContent = this.fileSnapshots.get(filePath);

        if (originalContent === undefined) {
            return this.actionResult(filePath, 'failed', 'Block action could not be completed; review retained');
        }

        if (this.trackedChanges.get(filePath)?.unavailableReason) {
            return this.actionResult(filePath, 'failed', 'File is unavailable; refresh before block actions');
        }
        const block = this.resolveBlock(filePath, blockRef);
        if (!block) {
            return this.actionResult(filePath, 'failed', 'Block action could not be completed; review retained');
        }

        let editedDocument: vscode.TextDocument | undefined;
        let beforeText: string | undefined;
        let recoveryRecord: PersistedRevertRecord | undefined;
        try {
            const uri = vscode.Uri.file(filePath);
            const doc = await vscode.workspace.openTextDocument(uri);
            if (!await this.verifyReview(review)) { return this.actionResult(filePath, 'conflict', 'Block review changed while opening document'); }
            if (doc.isDirty) {
                return this.actionResult(filePath, 'conflict', 'Unsaved editor changes; block skipped');
            }
            editedDocument = doc;
            beforeText = doc.getText();
            const currentModel = this.toTextLineModel(beforeText);
            const originalModel = this.toTextLineModel(originalContent);
            const nextLines = [...currentModel.lines];
            const startIdx = Math.max(0, block.startLine - 1);
            const deleteCount = Math.max(0, block.endLine - block.startLine + 1);

            if (block.type === 'added') {
                nextLines.splice(startIdx, deleteCount);
            } else if (block.type === 'modified') {
                const originalBlockLines = this.getOrderedOriginalLines(block);
                nextLines.splice(startIdx, deleteCount, ...originalBlockLines);
            } else if (block.type === 'deleted') {
                const deletedLines = this.getOrderedOriginalLines(block);
                nextLines.splice(startIdx, 0, ...deletedLines);
            }

            const nextHasFinalEol = this.blockTouchesEof(block, currentModel.lines.length, originalModel.lines.length)
                ? originalModel.hasFinalEol
                : currentModel.hasFinalEol;
            const nextText = this.serializeTextModel(
                {
                    lines: nextLines,
                    hasFinalEol: nextHasFinalEol,
                    dominantEol: currentModel.dominantEol
                },
                currentModel.dominantEol
            );

            if (nextText === doc.getText()) {
                return this.actionResult(filePath, 'success');
            }

            const revertItem = this.createRevertItem(
                filePath,
                { exists: true, content: beforeText },
                { exists: true, content: nextText },
                'buffer'
            );
            if (!revertItem) { return this.actionResult(filePath, 'failed', 'Cannot create a recovery record; block revert blocked'); }
            recoveryRecord = await this.prepareRevertRecord([revertItem]);
            if (!recoveryRecord) {
                return this.actionResult(filePath, 'failed', 'Cannot persist a recovery record; block revert blocked');
            }

            const edit = new vscode.WorkspaceEdit();
            const fullRange = this.getFullDocumentRange(doc);
            edit.replace(uri, fullRange, nextText);

            const targetError = this.validateActionTarget(filePath);
            if (targetError) {
                await this.removeRevertRecord(recoveryRecord);
                recoveryRecord = undefined;
                return this.actionResult(filePath, 'conflict', targetError);
            }
            this.pendingWriteFiles.add(filePath);
            this.activeWriteFiles.add(filePath);
            const success = await vscode.workspace.applyEdit(edit);
            if (!this.matchesReview(review)) {
                const bufferChanged = doc.getText() !== beforeText;
                if (!bufferChanged) {
                    this.pendingWriteFiles.delete(filePath);
                    await this.removeRevertRecord(recoveryRecord);
                    recoveryRecord = undefined;
                } else {
                    this.markFileUnavailable(filePath, 'Review changed after the editor buffer was modified; recovery retained');
                }
                return this.actionResult(filePath, 'conflict', 'Session or review changed during block edit', bufferChanged);
            }
            if (!success) {
                const bufferChanged = doc.getText() !== beforeText;
                if (!bufferChanged) { this.pendingWriteFiles.delete(filePath); }
                else { this.markFileUnavailable(filePath, 'Block edit failed after changing the editor buffer; review retained'); }
                if (!bufferChanged) {
                    await this.removeRevertRecord(recoveryRecord);
                    recoveryRecord = undefined;
                }
                return this.actionResult(filePath, 'failed', 'Block edit was rejected; review retained', bufferChanged);
            }
            this.pendingWriteFiles.delete(filePath);
            if (doc.getText() !== nextText) {
                const bufferChanged = doc.getText() !== beforeText;
                this.updateTrackedDiff(filePath, doc.getText());
                if (!bufferChanged) {
                    await this.removeRevertRecord(recoveryRecord);
                    recoveryRecord = undefined;
                }
                return this.actionResult(filePath, 'conflict', 'Document changed during block edit; review again', bufferChanged);
            }

            // Refresh immediately so WebView/CodeLens state does not wait for debounced document-change events.
            this.updateTrackedDiff(filePath, nextText);
            this.schedulePersistState();
            return this.actionResult(filePath, 'success', undefined, true);
        } catch {
            if (!this.isCurrentEpoch(review.epoch)) { return this.actionResult(filePath, 'cancelled', 'Session changed during block edit'); }
            const bufferChanged = !!editedDocument && beforeText !== undefined && editedDocument.getText() !== beforeText;
            if (!bufferChanged) { this.pendingWriteFiles.delete(filePath); }
            else {
                this.pendingWriteFiles.add(filePath);
                this.markFileUnavailable(filePath, 'Block edit failed after changing the editor buffer; review retained');
            }
            if (recoveryRecord && !bufferChanged) {
                await this.removeRevertRecord(recoveryRecord);
                recoveryRecord = undefined;
            }
            return this.actionResult(filePath, 'failed', 'Block action could not be completed; review retained', bufferChanged);
        } finally {
            if (this.isCurrentEpoch(review.epoch)) { this.activeWriteFiles.delete(filePath); }
        }
    }

    /**
     * Keep a specific change block (accept the changes)
     * Updates the snapshot so this block's changes become the new baseline
     */
    public keepBlock(filePath: string, blockRef: string | number, token = this.getReviewToken(filePath)): Promise<ActionResult> {
        return this.queueFileAction(filePath, token, review => this.keepBlockReviewed(filePath, blockRef, review));
    }

    private async keepBlockReviewed(filePath: string, blockRef: string | number, review: ReviewToken): Promise<ActionResult> {
        const targetError = this.validateActionTarget(filePath);
        if (targetError) { return this.actionResult(filePath, 'conflict', targetError); }
        if (this.trackedChanges.get(filePath)?.unavailableReason) {
            return this.actionResult(filePath, 'failed', 'File is unavailable; refresh before block actions');
        }
        const currentState = await this.readFileSnapshot(vscode.Uri.file(filePath));
        if (!await this.verifyReview(review)) { return this.actionResult(filePath, 'conflict', 'Block review changed; review again'); }
        if (currentState.kind !== 'text' || this.trackedChanges.get(filePath)?.isDeleted) {
            return this.actionResult(filePath, 'conflict', 'Missing or unavailable files require a file-level review');
        }
        const block = this.resolveBlock(filePath, blockRef);
        if (!block) {
            return this.actionResult(filePath, 'failed', 'Block action could not be completed; review retained');
        }
        const originalContent = this.fileSnapshots.get(filePath);
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
        const currentText = doc?.getText() ?? this.trackedChanges.get(filePath)?.currentContent;

        if (originalContent === undefined || currentText === undefined) {
            return this.actionResult(filePath, 'failed', 'Block action could not be completed; review retained');
        }

        const originalModel = this.toTextLineModel(originalContent);
        const currentModel = this.toTextLineModel(currentText);
        const originalLines = [...originalModel.lines];
        const currentLines = currentModel.lines;

        // Get current file's lines for this block (what we want to keep)
        const currentBlockLines = currentLines.slice(block.startLine - 1, block.endLine);

        // Find original line numbers affected by this block
        const originalLineNumbers = block.changes
            .map(c => c.originalLineNumber)
            .filter((n): n is number => n !== undefined);

        if (block.type === 'deleted') {
            // Deleted block: remove lines from original (they don't exist in current)
            // Sort descending to avoid index shifting issues
            const sortedDesc = [...new Set(originalLineNumbers)].sort((a, b) => b - a);
            for (const origLineNum of sortedDesc) {
                const idx = origLineNum - 1;
                if (idx >= 0 && idx < originalLines.length) {
                    originalLines.splice(idx, 1);
                }
            }
        } else if (originalLineNumbers.length > 0) {
            // Modified or mixed block: replace original lines with current block lines
            const minOrig = Math.min(...originalLineNumbers);
            const maxOrig = Math.max(...originalLineNumbers);
            const origStartIdx = minOrig - 1;
            const deleteCount = maxOrig - minOrig + 1;
            originalLines.splice(origStartIdx, deleteCount, ...currentBlockLines);
        } else {
            // Pure addition (no original lines): insert at block position
            // Find the closest preceding unchanged line to determine insert position
            // Walk the existing diff in its two coordinate spaces. Earlier unaccepted
            // additions consume current lines only; deletions consume baseline lines only.
            let originalOffset = 0;
            let currentOffset = 0;
            const targetOffset = Math.max(0, block.startLine - 1);
            for (const segment of this.trackedChanges.get(filePath)!.changes) {
                const count = segment.count ?? this.toTextLineModel(segment.value).lines.length;
                if (segment.removed) { originalOffset += count; continue; }
                if (targetOffset < currentOffset + count) {
                    if (!segment.added) { originalOffset += targetOffset - currentOffset; }
                    break;
                }
                currentOffset += count;
                if (!segment.added) { originalOffset += count; }
            }
            const insertIdx = originalOffset;
            originalLines.splice(insertIdx, 0, ...currentBlockLines);
        }

        // Update snapshot using current editor newline style while keeping logical accepted content.
        const keepHasFinalEol = this.blockTouchesEof(block, currentModel.lines.length, originalModel.lines.length)
            ? currentModel.hasFinalEol
            : originalModel.hasFinalEol;
        const newSnapshot = this.serializeTextModel(
            {
                lines: originalLines,
                hasFinalEol: keepHasFinalEol,
                dominantEol: currentModel.dominantEol
            },
            currentModel.dominantEol
        );
        this.fileSnapshots.set(filePath, newSnapshot);
        const currentExists = true;
        this.baselineExistingFiles.add(filePath);
        this.schedulePersistState();

        // Recompute diff against updated snapshot
        this.updateTrackedDiff(filePath, currentText, { baselineChanged: true, currentExists });
        return this.actionResult(filePath, 'success');
    }

    /**
     * Keep all changes in a file (accept all changes)
     * Updates the snapshot to match current document content
     */
    public keepAllChangesInFile(filePath: string, token = this.getReviewToken(filePath)): Promise<ActionResult> {
        return this.queueFileAction(filePath, token, review => this.keepFileReviewed(filePath, review));
    }

    private async keepFileReviewed(filePath: string, review: ReviewToken): Promise<ActionResult> {
        const targetError = this.validateActionTarget(filePath);
        if (targetError) { return this.actionResult(filePath, 'conflict', targetError); }
        const tracked = this.trackedChanges.get(filePath);
        if (!tracked || !this.fileSnapshots.has(filePath)) {
            return this.actionResult(filePath, 'conflict', 'No known baseline is available');
        }
        const state = await this.readCurrentFileState(filePath);
        if (!this.matchesReview(review)) { return this.actionResult(filePath, 'conflict', 'Review changed during Keep'); }
        if (state.kind === 'unavailable') {
            this.markFileUnavailable(filePath, state.reason);
            return this.actionResult(filePath, 'conflict', state.reason);
        }
        const currentContent = state.kind === 'text' ? state.content : '';
        if (currentContent !== tracked.currentContent || (state.kind === 'missing') !== tracked.isDeleted) {
            this.updateTrackedDiff(filePath, currentContent, { currentExists: state.kind === 'text' });
            return this.actionResult(filePath, 'conflict', 'File changed since review; review again');
        }
        this.fileSnapshots.set(filePath, currentContent);
        if (state.kind === 'missing') {
            this.baselineExistingFiles.delete(filePath);
        } else {
            this.baselineExistingFiles.add(filePath);
        }
        this.pendingWriteFiles.delete(filePath);
        this.clearFileReview(filePath, true);
        this.schedulePersistState();
        return this.actionResult(filePath, 'success');
    }

    /**
     * Get change blocks for a file (used by CodeLens)
     */
    public getChangeBlocks(filePath: string): ChangeBlock[] {
        const currentVersion = this.lineChangesVersionByFile.get(filePath) ?? 0;
        const cached = this.changeBlocksCache.get(filePath);
        if (cached && cached.version === currentVersion) {
            return cached.blocks.slice();
        }

        const lineChanges = this.lineChanges.get(filePath);
        if (!lineChanges || lineChanges.length === 0) {
            const emptyBlocks: ChangeBlock[] = [];
            this.changeBlocksCache.set(filePath, { version: currentVersion, blocks: emptyBlocks });
            return [];
        }

        // Keep original order from diff computation; sorting by line number can break EOF deletions.
        const changes = lineChanges
            .filter(c => c.type !== 'unchanged');

        if (changes.length === 0) {
            const emptyBlocks: ChangeBlock[] = [];
            this.changeBlocksCache.set(filePath, { version: currentVersion, blocks: emptyBlocks });
            return [];
        }

        const shouldMerge = (prev: LineChange, next: LineChange): boolean => {
            const prevSegment = prev.segmentId;
            const nextSegment = next.segmentId;
            if (prevSegment !== undefined && nextSegment !== undefined) {
                return prevSegment === nextSegment;
            }
            if (prevSegment !== undefined || nextSegment !== undefined) {
                return false;
            }
            return next.lineNumber <= prev.lineNumber + 1;
        };

        const groupedChanges: LineChange[][] = [];
        let currentGroup: LineChange[] = [];
        for (const change of changes) {
            if (currentGroup.length === 0) {
                currentGroup = [change];
                continue;
            }

            const prev = currentGroup[currentGroup.length - 1];
            if (shouldMerge(prev, change)) {
                currentGroup.push(change);
            } else {
                groupedChanges.push(currentGroup);
                currentGroup = [change];
            }
        }

        if (currentGroup.length > 0) {
            groupedChanges.push(currentGroup);
        }

        const coalescedGroups = this.coalesceChangeGroups(groupedChanges);
        const idCounter = new Map<string, number>();
        const blocks = coalescedGroups.map((group, index) => {
            const startLine = Math.min(...group.map(change => change.lineNumber));
            const endLine = Math.max(...group.map(change => change.lineNumber));

            const hasAdded = group.some(change => change.type === 'added');
            const hasDeleted = group.some(change => change.type === 'deleted');
            const hasModified = group.some(change => change.type === 'modified');
            const type: 'added' | 'modified' | 'deleted' =
                hasModified || (hasAdded && hasDeleted)
                    ? 'modified'
                    : (hasDeleted ? 'deleted' : 'added');

            const originalLineNumbers = group
                .map(change => change.originalLineNumber)
                .filter((n): n is number => n !== undefined)
                .sort((a, b) => a - b);
            const originalStart = originalLineNumbers.length > 0 ? originalLineNumbers[0] : 0;
            const originalEnd = originalLineNumbers.length > 0 ? originalLineNumbers[originalLineNumbers.length - 1] : 0;
            const segmentIds = [...new Set(
                group
                    .map(change => change.segmentId)
                    .filter((segmentId): segmentId is number => segmentId !== undefined)
            )].sort((a, b) => a - b);
            const segmentKey = segmentIds.length > 0 ? segmentIds.join(',') : '0';
            const key = `${type}:${startLine}:${endLine}:${originalStart}:${originalEnd}:${segmentKey}`;
            const seen = idCounter.get(key) ?? 0;
            idCounter.set(key, seen + 1);

            return {
                startLine,
                endLine,
                type,
                changes: group,
                blockId: `${filePath}::${this.sessionEpoch}:${this.getReviewToken(filePath)?.baselineRevision}:${this.getReviewToken(filePath)?.currentRevision}:${key}:${seen + 1}`,
                blockIndex: index
            };
        });
        this.changeBlocksCache.set(filePath, { version: currentVersion, blocks });
        return blocks.slice();
    }

    private coalesceChangeGroups(groups: LineChange[][]): LineChange[][] {
        if (groups.length <= 1) {
            return groups;
        }

        const coalesced: LineChange[][] = [];
        for (const group of groups) {
            if (group.length === 0) {
                continue;
            }

            if (coalesced.length === 0) {
                coalesced.push([...group]);
                continue;
            }

            const previous = coalesced[coalesced.length - 1];
            if (this.isSameEditCluster(previous, group)) {
                previous.push(...group);
            } else {
                coalesced.push([...group]);
            }
        }

        return coalesced;
    }

    private isSameEditCluster(prevGroup: LineChange[], nextGroup: LineChange[]): boolean {
        const prevSegments = new Set(
            prevGroup
                .map(change => change.segmentId)
                .filter((segmentId): segmentId is number => segmentId !== undefined)
        );
        const nextSegments = new Set(
            nextGroup
                .map(change => change.segmentId)
                .filter((segmentId): segmentId is number => segmentId !== undefined)
        );

        if (prevSegments.size > 0 && nextSegments.size > 0) {
            for (const segmentId of prevSegments) {
                if (nextSegments.has(segmentId)) {
                    return true;
                }
            }
        }

        const prevCurrentRange = this.getLineRange(prevGroup.map(change => change.lineNumber));
        const nextCurrentRange = this.getLineRange(nextGroup.map(change => change.lineNumber));
        const currentRangesTouch = this.areRangesAdjacentOrOverlapping(prevCurrentRange, nextCurrentRange);

        const combinedTypes = new Set<LineChange['type']>(
            [...prevGroup, ...nextGroup]
                .map(change => change.type)
                .filter(type => type !== 'unchanged')
        );

        if (currentRangesTouch && combinedTypes.size >= 2) {
            return true;
        }

        const oneSidePureBlankAdded = this.isPureBlankAddedGroup(prevGroup) || this.isPureBlankAddedGroup(nextGroup);
        if (!oneSidePureBlankAdded) {
            return false;
        }

        const otherGroup = this.isPureBlankAddedGroup(prevGroup) ? nextGroup : prevGroup;
        const hasModifiedOrDeleted = otherGroup.some(change => change.type === 'modified' || change.type === 'deleted');
        if (!hasModifiedOrDeleted) {
            return false;
        }

        const prevOriginalRange = this.getLineRange(
            prevGroup
                .map(change => change.originalLineNumber)
                .filter((line): line is number => line !== undefined)
        );
        const nextOriginalRange = this.getLineRange(
            nextGroup
                .map(change => change.originalLineNumber)
                .filter((line): line is number => line !== undefined)
        );
        const originalRangesTouch = this.areRangesAdjacentOrOverlapping(prevOriginalRange, nextOriginalRange);

        return currentRangesTouch || originalRangesTouch;
    }

    private isPureBlankAddedGroup(group: LineChange[]): boolean {
        if (group.length === 0) {
            return false;
        }

        return group.every(change => change.type === 'added' && (change.newText ?? '').trim().length === 0);
    }

    private getLineRange(lines: number[]): { start: number; end: number } | undefined {
        if (lines.length === 0) {
            return undefined;
        }

        const positiveLines = lines.filter(line => Number.isFinite(line) && line > 0);
        if (positiveLines.length === 0) {
            return undefined;
        }

        return {
            start: Math.min(...positiveLines),
            end: Math.max(...positiveLines)
        };
    }

    private areRangesAdjacentOrOverlapping(
        first: { start: number; end: number } | undefined,
        second: { start: number; end: number } | undefined
    ): boolean {
        if (!first || !second) {
            return false;
        }

        return second.start <= first.end + 1 && first.start <= second.end + 1;
    }

    private resolveBlock(filePath: string, blockRef: string | number): ChangeBlock | undefined {
        const blocks = this.getChangeBlocks(filePath);
        if (typeof blockRef === 'number') {
            if (blockRef < 0 || blockRef >= blocks.length) {
                return undefined;
            }
            return blocks[blockRef];
        }

        return blocks.find(block => block.blockId === blockRef);
    }

    private onDocumentChanged(event: vscode.TextDocumentChangeEvent) {
        const epoch = this.sessionEpoch;
        if (!this.isRecording) {
            return;
        }

        const doc = event.document;
        if (doc.uri.scheme !== 'file') {
            return;
        }

        const filePath = doc.uri.fsPath;
        const uri = doc.uri;
        if (this.isPathIgnored(uri)) {
            return;
        }

        // VS Code does not provide reliable manual/formatter/reload provenance.
        // Unknown and mixed edits remain reviewable, including Undo/Redo.

        // For files without snapshot (not open when recording started),
        // capture the document's current content BEFORE this change as the baseline.
        // We do this immediately (before debounce) to avoid autosave overwriting
        // the on-disk content and erasing the true baseline.
        if (!this.fileSnapshots.has(filePath)) {
            this.ensureSnapshotForDocument(doc);
            if (!this.fileSnapshots.has(filePath)) { return; }
        }

        const existingTimer = this.documentChangeTimers.get(filePath);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        const timer = setTimeout(() => {
            this.documentChangeTimers.delete(filePath);
            if (!this.isRecording || !this.isCurrentEpoch(epoch)) {
                return;
            }
            this.processDocumentChange(doc);
        }, 120);

        this.documentChangeTimers.set(filePath, timer);
    }

    private processDocumentChange(doc: vscode.TextDocument): void {
        if (!this.isRecording) {
            return;
        }

        if (doc.uri.scheme !== 'file') {
            return;
        }

        const filePath = doc.uri.fsPath;
        const uri = doc.uri;
        if (this.isPathIgnored(uri)) {
            return;
        }

        if (this.pendingWriteFiles.has(filePath)) { return; }
        try {
            fs.statSync(filePath);
        } catch (error) {
            if (this.isFileNotFound(error) && !doc.isDirty) {
                this.updateTrackedDiff(filePath, '', { currentExists: false });
            } else {
                this.markFileUnavailable(filePath, 'Resource is missing or unreadable while editor changes remain');
            }
            return;
        }
        this.updateTrackedDiff(filePath, doc.getText());
    }

    private ensureInlineView(filePath: string): InlineDiffView | undefined {
        const cached = this.inlineViews.get(filePath);
        if (cached) {
            return cached;
        }

        const view = this.buildDiffView(filePath);
        if (!view) {
            return undefined;
        }

        this.lineChanges.set(filePath, view.lineChanges);
        this.markLineChangesUpdated(filePath);
        this.inlineViews.set(filePath, view.inlineView);
        return view.inlineView;
    }

    private getCurrentContent(filePath: string): string | undefined {
        const tracked = this.trackedChanges.get(filePath);
        if (tracked) {
            return tracked.currentContent;
        }

        const doc = vscode.workspace.textDocuments.find(textDoc => textDoc.uri.fsPath === filePath);
        return doc?.getText();
    }

    private ensureSnapshotForDocument(doc: vscode.TextDocument): void {
        if (!this.isRecording) {
            return;
        }

        if (doc.uri.scheme !== 'file') {
            return;
        }

        const filePath = doc.uri.fsPath;
        if (this.fileSnapshots.has(filePath)) {
            return;
        }

        if (this.isPathIgnored(doc.uri)) {
            return;
        }

        if (this.trackedChanges.get(filePath)?.unavailableReason) { return; }
        const targetError = this.validateActionTarget(filePath);
        if (targetError) { this.markFileUnavailable(filePath, targetError); return; }

        try {
            const stat = fs.statSync(filePath);
            if (!stat.isFile() || stat.size > 5 * 1024 * 1024) {
                this.markFileUnavailable(filePath, 'Baseline is unsupported or exceeds the 5 MiB limit');
                return;
            }
            const bytes = fs.readFileSync(filePath);
            if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
                this.markFileUnavailable(filePath, 'UTF-8 BOM baseline is unsupported in this version');
                return;
            }
            if (this.isLikelyBinaryContent(bytes)) {
                this.markFileUnavailable(filePath, 'Binary baseline content is unsupported');
                return;
            }
            const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            this.fileSnapshots.set(filePath, content);
            this.baselineExistingFiles.add(filePath);
        } catch (error) {
            if (!this.isFileNotFound(error)) {
                this.markFileUnavailable(filePath, 'Baseline cannot be read or decoded');
                return;
            }
            this.fileSnapshots.set(filePath, '');
            this.baselineExistingFiles.delete(filePath);
        }
        this.schedulePersistState();
    }

    private calculateLineChanges(filePath: string) {
        const view = this.buildDiffView(filePath);
        if (!view) {
            this.lineChanges.delete(filePath);
            this.markLineChangesUpdated(filePath);
            this.inlineViews.delete(filePath);
            return;
        }

        this.lineChanges.set(filePath, view.lineChanges);
        this.markLineChangesUpdated(filePath);
        this.inlineViews.set(filePath, view.inlineView);
    }

    private buildDiffView(filePath: string): { lineChanges: LineChange[]; inlineView: InlineDiffView } | undefined {
        const originalContent = this.fileSnapshots.get(filePath);
        const currentContent = this.getCurrentContent(filePath);

        if (originalContent === undefined || currentContent === undefined) {
            return undefined;
        }

        return this.buildDiffViewFromContents(originalContent, currentContent);
    }

    private buildDiffViewFromContents(
        originalContent: string,
        currentContent: string
    ): { lineChanges: LineChange[]; inlineView: InlineDiffView } {
        const originalModel = this.toTextLineModel(originalContent);
        const currentModel = this.toTextLineModel(currentContent);

        return this.buildDiffViewFromLines(
            originalModel.lines,
            currentModel.lines,
            originalModel.hasFinalEol,
            currentModel.hasFinalEol
        );
    }

    private buildDiffViewFromLines(
        originalLines: string[],
        currentLines: string[],
        originalHasFinalEol: boolean,
        currentHasFinalEol: boolean
    ): { lineChanges: LineChange[]; inlineView: InlineDiffView } {
        const originalNormalized = originalLines.map(line => this.normalizeLineForMatch(line));
        const currentNormalized = currentLines.map(line => this.normalizeLineForMatch(line));

        const diffResult = Diff.diffArrays(originalLines, currentLines);
        const lineChanges: LineChange[] = [];
        const inlineLines: string[] = [];
        const inlineTypes: InlineLineType[] = [];

        let originalIndex = 0;
        let currentIndex = 0;
        let originalLineNumber = 1;
        let currentLineNumber = 1;
        let lastMatchedCurrentLine = 0;
        let nextSegmentId = 1;
        let activeSegmentId: number | undefined;

        const pendingRemoved: PendingRemovedLine[] = [];
        const beginSegment = (): number => {
            if (activeSegmentId === undefined) {
                activeSegmentId = nextSegmentId++;
            }
            return activeSegmentId;
        };
        const closeSegment = (): void => {
            activeSegmentId = undefined;
        };

        const flushPendingRemoved = () => {
            if (pendingRemoved.length === 0) {
                return;
            }

            const segmentId = beginSegment();
            const anchorLine = lastMatchedCurrentLine;
            pendingRemoved.forEach(removed => {
                lineChanges.push({
                    lineNumber: currentLineNumber,
                    type: 'deleted',
                    originalLineNumber: removed.originalLineNumber,
                    oldText: removed.text,
                    anchorLineNumber: anchorLine,
                    segmentId
                });
                inlineLines.push(removed.text);
                inlineTypes.push('deleted');
            });

            pendingRemoved.length = 0;
        };

        for (const change of diffResult) {
            const length = change.value.length;
            if (length === 0) {
                continue;
            }

            if (change.removed) {
                for (let i = 0; i < length; i++) {
                    const oldLine = originalLines[originalIndex] ?? '';
                    pendingRemoved.push({
                        text: oldLine,
                        normalized: originalNormalized[originalIndex] ?? this.normalizeLineForMatch(oldLine),
                        originalLineNumber
                    });
                    originalIndex++;
                    originalLineNumber++;
                }
                continue;
            }

            if (change.added) {
                const segmentId = beginSegment();
                const addedLines = currentLines.slice(currentIndex, currentIndex + length);
                const addedNormalized = currentNormalized.slice(currentIndex, currentIndex + length);
                const pairing = this.pairLinesBySimilarity(pendingRemoved, addedLines, addedNormalized);

                pairing.pairedByAdded.forEach((deletedIndex, addedIndex) => {
                    const deleted = pendingRemoved[deletedIndex];
                    const nextLine = addedLines[addedIndex] ?? '';
                    lineChanges.push({
                        lineNumber: currentLineNumber + addedIndex,
                        type: 'modified',
                        originalLineNumber: deleted.originalLineNumber,
                        oldText: deleted.text,
                        newText: nextLine,
                        segmentId
                    });
                });

                const canSuppressBlankDeletes =
                    pendingRemoved.length > 0 &&
                    pendingRemoved.every(removed => (removed.text ?? '').trim().length === 0) &&
                    pendingRemoved.length === addedLines.length;

                pairing.unpairedDeleted.forEach(index => {
                    const deleted = pendingRemoved[index];
                    const isBlankDeleted = (deleted?.text ?? '').trim().length === 0;
                    if (canSuppressBlankDeletes && isBlankDeleted) {
                        return;
                    }

                    lineChanges.push({
                        lineNumber: currentLineNumber,
                        type: 'deleted',
                        originalLineNumber: deleted.originalLineNumber,
                        oldText: deleted.text,
                        anchorLineNumber: lastMatchedCurrentLine,
                        segmentId
                    });
                });

                pairing.unpairedAdded.forEach(index => {
                    const addedLine = addedLines[index] ?? '';
                    lineChanges.push({
                        lineNumber: currentLineNumber + index,
                        type: 'added',
                        newText: addedLine,
                        segmentId
                    });
                });

                const inlineDeleted = canSuppressBlankDeletes
                    ? pendingRemoved.filter(removed => (removed.text ?? '').trim().length !== 0)
                    : pendingRemoved;

                inlineDeleted.forEach(removed => {
                    inlineLines.push(removed.text);
                    inlineTypes.push('deleted');
                });

                addedLines.forEach(line => {
                    inlineLines.push(line ?? '');
                    inlineTypes.push('added');
                });

                pendingRemoved.length = 0;
                currentIndex += length;
                currentLineNumber += length;
                continue;
            }

            flushPendingRemoved();
            closeSegment();

            for (let i = 0; i < length; i++) {
                const newLine = currentLines[currentIndex] ?? '';
                inlineLines.push(newLine);
                inlineTypes.push('unchanged');
                lineChanges.push({
                    lineNumber: currentLineNumber,
                    type: 'unchanged',
                    originalLineNumber
                });
                originalIndex++;
                currentIndex++;
                originalLineNumber++;
                lastMatchedCurrentLine = currentLineNumber;
                currentLineNumber++;
            }
        }

        flushPendingRemoved();
        closeSegment();

        // Track metadata so final-EOL-only edits do not create phantom blocks.
        if (originalHasFinalEol !== currentHasFinalEol && lineChanges.every(change => change.type === 'unchanged')) {
            lineChanges.length = 0;
            inlineLines.length = 0;
            inlineTypes.length = 0;
            for (let i = 0; i < currentLines.length; i++) {
                inlineLines.push(currentLines[i] ?? '');
                inlineTypes.push('unchanged');
                lineChanges.push({
                    lineNumber: i + 1,
                    type: 'unchanged',
                    originalLineNumber: i + 1
                });
            }
        }

        return {
            lineChanges,
            inlineView: {
                content: inlineLines.join('\n'),
                lineTypes: inlineTypes
            }
        };
    }

    private pairLinesBySimilarity(
        deletedLines: PendingRemovedLine[],
        addedLines: string[],
        addedNormalized: string[]
    ): {
        pairedByAdded: Map<number, number>,
        unpairedDeleted: number[],
        unpairedAdded: number[]
    } {
        const pairedByAdded = new Map<number, number>();
        const usedDeleted = new Set<number>();
        const usedAdded = new Set<number>();

        // Always pair by position first (up to the minimum count).
        // This treats adjacent deleted+added as "modified" rather than separate operations,
        // which matches user expectations for edits like "# TBD" -> "# TBD123".
        const minLen = Math.min(deletedLines.length, addedLines.length);
        for (let i = 0; i < minLen; i++) {
            pairedByAdded.set(i, i);
            usedDeleted.add(i);
            usedAdded.add(i);
        }

        // If counts differ, try to pair remaining lines by similarity to keep modified hunks compact.
        const similarityThreshold = 0.3;
        const maxOffset = 5;
        for (let i = 0; i < addedLines.length; i++) {
            if (usedAdded.has(i)) {
                continue;
            }

            let bestDeleted = -1;
            let bestSimilarity = 0;

            for (let j = 0; j < deletedLines.length; j++) {
                if (usedDeleted.has(j)) {
                    continue;
                }

                if (Math.abs(j - i) > maxOffset) {
                    continue;
                }

                const similarity = this.calculatePairSimilarity(
                    deletedLines[j],
                    addedLines[i],
                    addedNormalized[i]
                );

                if (similarity > bestSimilarity) {
                    bestSimilarity = similarity;
                    bestDeleted = j;
                }
            }

            if (bestDeleted >= 0 && bestSimilarity >= similarityThreshold) {
                pairedByAdded.set(i, bestDeleted);
                usedDeleted.add(bestDeleted);
                usedAdded.add(i);
            }
        }

        // Remaining unpaired lines stay as pure deleted or pure added

        const unpairedDeleted = deletedLines
            .map((_, index) => index)
            .filter(index => !usedDeleted.has(index));

        const unpairedAdded = addedLines
            .map((_, index) => index)
            .filter(index => !usedAdded.has(index));

        return { pairedByAdded, unpairedDeleted, unpairedAdded };
    }

    private calculatePairSimilarity(
        deleted: PendingRemovedLine,
        addedLine: string,
        addedNormalized: string
    ): number {
        if (deleted.normalized.length > 0 && deleted.normalized === addedNormalized) {
            return 1;
        }

        const rawSimilarity = this.calculateSetSimilarity(deleted.text, addedLine);
        const normalizedSimilarity = this.calculateSetSimilarity(deleted.normalized, addedNormalized);

        return Math.max(rawSimilarity, normalizedSimilarity);
    }

    private calculateSetSimilarity(str1: string | undefined, str2: string | undefined): number {
        const tokens1 = this.tokenizeForSimilarity(str1);
        const tokens2 = this.tokenizeForSimilarity(str2);

        if (tokens1.length === 0 && tokens2.length === 0) {
            return 1;
        }

        const counts1 = new Map<string, number>();
        const counts2 = new Map<string, number>();
        for (const token of tokens1) {
            counts1.set(token, (counts1.get(token) ?? 0) + 1);
        }
        for (const token of tokens2) {
            counts2.set(token, (counts2.get(token) ?? 0) + 1);
        }

        let overlapCount = 0;
        for (const [token, count1] of counts1.entries()) {
            const count2 = counts2.get(token) ?? 0;
            overlapCount += Math.min(count1, count2);
        }

        const totalCount = tokens1.length + tokens2.length;
        return totalCount > 0 ? (2 * overlapCount) / totalCount : 0;
    }

    private tokenizeForSimilarity(input: string | undefined): string[] {
        const normalized = (input ?? '').trim().replace(/\s+/g, ' ');
        if (!normalized) {
            return [];
        }

        const tokens = normalized.match(/[A-Za-z0-9_]+/g);
        if (tokens && tokens.length > 0) {
            return tokens;
        }

        const compact = normalized.replace(/\s+/g, '');
        return [...compact];
    }

    private detectDominantEol(content: string): '\n' | '\r\n' | '\r' {
        const matches = content.match(/\r\n|\r|\n/g);
        if (!matches || matches.length === 0) {
            return '\n';
        }

        let lf = 0;
        let crlf = 0;
        let cr = 0;
        for (const token of matches) {
            if (token === '\r\n') {
                crlf++;
            } else if (token === '\r') {
                cr++;
            } else {
                lf++;
            }
        }

        if (crlf >= lf && crlf >= cr) {
            return '\r\n';
        }
        if (lf >= cr) {
            return '\n';
        }
        return '\r';
    }

    private normalizeEol(content: string): string {
        return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    }

    private toTextLineModel(content: string): TextLineModel {
        const dominantEol = this.detectDominantEol(content);
        const normalized = this.normalizeEol(content);
        if (normalized.length === 0) {
            return { lines: [], hasFinalEol: false, dominantEol };
        }

        const hasFinalEol = normalized.endsWith('\n');
        const split = normalized.split('\n');
        const lines = hasFinalEol ? split.slice(0, -1) : split;
        return { lines, hasFinalEol, dominantEol };
    }

    private serializeTextModel(model: TextLineModel, preferredEol?: '\n' | '\r\n' | '\r'): string {
        const eol = preferredEol ?? model.dominantEol;
        let value = model.lines.join(eol);
        if (model.hasFinalEol) {
            value += eol;
        }
        return value;
    }

    private getOrderedOriginalLines(block: ChangeBlock): string[] {
        const byOriginalLine = new Map<number, string>();
        for (const change of block.changes) {
            if (change.originalLineNumber === undefined || change.oldText === undefined) {
                continue;
            }
            if (!byOriginalLine.has(change.originalLineNumber)) {
                byOriginalLine.set(change.originalLineNumber, change.oldText);
            }
        }

        if (byOriginalLine.size > 0) {
            return [...byOriginalLine.entries()]
                .sort((a, b) => a[0] - b[0])
                .map((entry) => entry[1]);
        }

        const fallback: string[] = [];
        for (const change of block.changes) {
            if (change.oldText !== undefined) {
                fallback.push(change.oldText);
            }
        }
        return fallback;
    }

    private blockTouchesEof(
        block: ChangeBlock,
        currentLineCount: number,
        originalLineCount: number
    ): boolean {
        const touchesCurrent = currentLineCount === 0 || block.endLine >= currentLineCount;
        const maxOriginal = block.changes
            .map(change => change.originalLineNumber ?? 0)
            .reduce((max, value) => Math.max(max, value), 0);
        const touchesOriginal = maxOriginal > 0 && maxOriginal >= originalLineCount;
        return touchesCurrent || touchesOriginal;
    }

    private getFullDocumentRange(doc: vscode.TextDocument): vscode.Range {
        if (doc.lineCount === 0) {
            return new vscode.Range(0, 0, 0, 0);
        }

        const firstLine = doc.lineAt(0);
        const lastLine = doc.lineAt(doc.lineCount - 1);
        const end = lastLine.rangeIncludingLineBreak.end;
        return new vscode.Range(firstLine.range.start, end);
    }

    /**
     * Patience Diff algorithm implementation.
     * 
     * Unlike LCS-based diff, this algorithm:
     * 1. Finds unique lines (appearing exactly once in both old and new)
     * 2. Uses unique lines as anchors
     * 3. Falls back to positional diff (not LCS) when no unique lines exist
     * 
     * This produces more intuitive diffs when similar code blocks exist nearby.
     */
    private patienceDiff(
        oldLines: string[],
        newLines: string[]
    ): Array<{ value: string[]; added?: boolean; removed?: boolean }> {
        return this.patienceDiffRecursive(oldLines, 0, oldLines.length, newLines, 0, newLines.length);
    }

    private patienceDiffRecursive(
        oldLines: string[],
        oldStart: number,
        oldEnd: number,
        newLines: string[],
        newStart: number,
        newEnd: number
    ): Array<{ value: string[]; added?: boolean; removed?: boolean }> {
        // Base cases
        if (oldStart >= oldEnd && newStart >= newEnd) {
            return [];
        }
        if (oldStart >= oldEnd) {
            // All remaining new lines are additions
            return [{ value: newLines.slice(newStart, newEnd), added: true }];
        }
        if (newStart >= newEnd) {
            // All remaining old lines are deletions
            return [{ value: oldLines.slice(oldStart, oldEnd), removed: true }];
        }

        // Find unique lines and their positions
        const oldUniques = this.findUniqueLineIndices(oldLines, oldStart, oldEnd);
        const newUniques = this.findUniqueLineIndices(newLines, newStart, newEnd);

        // Find matching unique lines (anchors)
        const anchors = this.findAnchors(oldLines, oldUniques, newLines, newUniques);

        if (anchors.length === 0) {
            // No anchors: fall back to positional diff
            return this.positionalDiff(oldLines, oldStart, oldEnd, newLines, newStart, newEnd);
        }

        // Process blocks between anchors
        const result: Array<{ value: string[]; added?: boolean; removed?: boolean }> = [];
        let prevOldIdx = oldStart;
        let prevNewIdx = newStart;

        for (const [oldIdx, newIdx] of anchors) {
            // Recursively process content before this anchor
            const beforeDiff = this.patienceDiffRecursive(
                oldLines, prevOldIdx, oldIdx,
                newLines, prevNewIdx, newIdx
            );
            result.push(...beforeDiff);

            // Add the anchor line itself (unchanged)
            result.push({ value: [oldLines[oldIdx]] });

            prevOldIdx = oldIdx + 1;
            prevNewIdx = newIdx + 1;
        }

        // Process content after the last anchor
        const afterDiff = this.patienceDiffRecursive(
            oldLines, prevOldIdx, oldEnd,
            newLines, prevNewIdx, newEnd
        );
        result.push(...afterDiff);

        return this.mergeConsecutiveChanges(result);
    }

    /**
     * Find indices of lines that appear exactly once in the given range.
     */
    private findUniqueLineIndices(
        lines: string[],
        start: number,
        end: number
    ): Map<string, number> {
        const counts = new Map<string, { count: number; index: number }>();

        for (let i = start; i < end; i++) {
            const line = lines[i];
            const existing = counts.get(line);
            if (existing) {
                existing.count++;
            } else {
                counts.set(line, { count: 1, index: i });
            }
        }

        const uniques = new Map<string, number>();
        for (const [line, { count, index }] of counts) {
            if (count === 1) {
                uniques.set(line, index);
            }
        }
        return uniques;
    }

    /**
     * Find matching unique lines between old and new, maintaining order.
     * Uses LCS on the unique lines only to find the longest matching sequence.
     */
    private findAnchors(
        oldLines: string[],
        oldUniques: Map<string, number>,
        newLines: string[],
        newUniques: Map<string, number>
    ): Array<[number, number]> {
        // Find common unique lines
        const commonUniques: Array<{ line: string; oldIdx: number; newIdx: number }> = [];

        for (const [line, oldIdx] of oldUniques) {
            const newIdx = newUniques.get(line);
            if (newIdx !== undefined) {
                commonUniques.push({ line, oldIdx, newIdx });
            }
        }

        if (commonUniques.length === 0) {
            return [];
        }

        // Sort by position in old file
        commonUniques.sort((a, b) => a.oldIdx - b.oldIdx);

        // Find LCS by new index (patience sorting)
        // This ensures we get the longest sequence of anchors that maintains order in both files
        const lcs = this.longestIncreasingSubsequence(
            commonUniques.map(u => u.newIdx)
        );

        return lcs.map(i => [commonUniques[i].oldIdx, commonUniques[i].newIdx] as [number, number]);
    }

    /**
     * Find the longest increasing subsequence indices.
     * Used to find the best anchor chain that maintains order.
     */
    private longestIncreasingSubsequence(nums: number[]): number[] {
        if (nums.length === 0) {
            return [];
        }

        const n = nums.length;
        const dp: number[] = new Array(n).fill(1);
        const parent: number[] = new Array(n).fill(-1);

        for (let i = 1; i < n; i++) {
            for (let j = 0; j < i; j++) {
                if (nums[j] < nums[i] && dp[j] + 1 > dp[i]) {
                    dp[i] = dp[j] + 1;
                    parent[i] = j;
                }
            }
        }

        // Find the index with maximum length
        let maxLen = 0;
        let maxIdx = 0;
        for (let i = 0; i < n; i++) {
            if (dp[i] > maxLen) {
                maxLen = dp[i];
                maxIdx = i;
            }
        }

        // Reconstruct the sequence
        const result: number[] = [];
        let idx = maxIdx;
        while (idx !== -1) {
            result.push(idx);
            idx = parent[idx];
        }
        result.reverse();

        return result;
    }

    /**
     * Positional diff: matches lines by position, not by content similarity.
     * This is the key difference from LCS - it prevents cross-matching similar lines
     * from different code blocks.
     * 
     * When block sizes differ, we first check if the content aligns at the start
     * or end (indicating simple deletion), before falling back to pure removed+added.
     */
    private positionalDiff(
        oldLines: string[],
        oldStart: number,
        oldEnd: number,
        newLines: string[],
        newStart: number,
        newEnd: number
    ): Array<{ value: string[]; added?: boolean; removed?: boolean }> {
        const oldLen = oldEnd - oldStart;
        const newLen = newEnd - newStart;
        const result: Array<{ value: string[]; added?: boolean; removed?: boolean }> = [];

        // If one side is empty, return pure add or remove
        if (oldLen === 0 && newLen > 0) {
            return [{ value: newLines.slice(newStart, newEnd), added: true }];
        }
        if (newLen === 0 && oldLen > 0) {
            return [{ value: oldLines.slice(oldStart, oldEnd), removed: true }];
        }

        // Check if this is a deletion at the START (old ends match new)
        // i.e., new content is a suffix of old content
        if (oldLen > newLen) {
            const diff = oldLen - newLen;
            let suffixMatch = true;
            for (let i = 0; i < newLen; i++) {
                if (oldLines[oldStart + diff + i] !== newLines[newStart + i]) {
                    suffixMatch = false;
                    break;
                }
            }
            if (suffixMatch) {
                // Lines at start were deleted, rest unchanged
                result.push({ value: oldLines.slice(oldStart, oldStart + diff), removed: true });
                result.push({ value: oldLines.slice(oldStart + diff, oldEnd) });
                return result;
            }
        }

        // Check if this is a deletion at the END (old starts match new)
        // i.e., new content is a prefix of old content
        if (oldLen > newLen) {
            const diff = oldLen - newLen;
            let prefixMatch = true;
            for (let i = 0; i < newLen; i++) {
                if (oldLines[oldStart + i] !== newLines[newStart + i]) {
                    prefixMatch = false;
                    break;
                }
            }
            if (prefixMatch) {
                // Lines at end were deleted, start unchanged
                result.push({ value: oldLines.slice(oldStart, oldStart + newLen) });
                result.push({ value: oldLines.slice(oldStart + newLen, oldEnd), removed: true });
                return result;
            }
        }

        // Check if this is an addition at the START (new ends match old)
        if (newLen > oldLen) {
            const diff = newLen - oldLen;
            let suffixMatch = true;
            for (let i = 0; i < oldLen; i++) {
                if (newLines[newStart + diff + i] !== oldLines[oldStart + i]) {
                    suffixMatch = false;
                    break;
                }
            }
            if (suffixMatch) {
                result.push({ value: newLines.slice(newStart, newStart + diff), added: true });
                result.push({ value: newLines.slice(newStart + diff, newEnd) });
                return result;
            }
        }

        // Check if this is an addition at the END (new starts match old)
        if (newLen > oldLen) {
            const diff = newLen - oldLen;
            let prefixMatch = true;
            for (let i = 0; i < oldLen; i++) {
                if (newLines[newStart + i] !== oldLines[oldStart + i]) {
                    prefixMatch = false;
                    break;
                }
            }
            if (prefixMatch) {
                result.push({ value: newLines.slice(newStart, newStart + oldLen) });
                result.push({ value: newLines.slice(newStart + oldLen, newEnd), added: true });
                return result;
            }
        }

        // No simple prefix/suffix match - fall back to finding leading/trailing unchanged
        const minLen = Math.min(oldLen, newLen);

        let leadingUnchanged = 0;
        while (leadingUnchanged < minLen &&
            oldLines[oldStart + leadingUnchanged] === newLines[newStart + leadingUnchanged]) {
            leadingUnchanged++;
        }

        if (leadingUnchanged > 0) {
            result.push({ value: oldLines.slice(oldStart, oldStart + leadingUnchanged) });
        }

        let trailingUnchanged = 0;
        while (trailingUnchanged < minLen - leadingUnchanged &&
            oldLines[oldEnd - 1 - trailingUnchanged] === newLines[newEnd - 1 - trailingUnchanged]) {
            trailingUnchanged++;
        }

        const oldMiddleStart = oldStart + leadingUnchanged;
        const oldMiddleEnd = oldEnd - trailingUnchanged;
        const newMiddleStart = newStart + leadingUnchanged;
        const newMiddleEnd = newEnd - trailingUnchanged;

        if (oldMiddleStart < oldMiddleEnd) {
            result.push({ value: oldLines.slice(oldMiddleStart, oldMiddleEnd), removed: true });
        }
        if (newMiddleStart < newMiddleEnd) {
            result.push({ value: newLines.slice(newMiddleStart, newMiddleEnd), added: true });
        }

        if (trailingUnchanged > 0) {
            result.push({ value: oldLines.slice(oldEnd - trailingUnchanged, oldEnd) });
        }

        return result;
    }

    /**
     * Merge consecutive changes of the same type for cleaner output.
     */
    private mergeConsecutiveChanges(
        changes: Array<{ value: string[]; added?: boolean; removed?: boolean }>
    ): Array<{ value: string[]; added?: boolean; removed?: boolean }> {
        if (changes.length === 0) {
            return [];
        }

        const result: Array<{ value: string[]; added?: boolean; removed?: boolean }> = [];

        for (const change of changes) {
            if (change.value.length === 0) {
                continue;
            }

            const last = result[result.length - 1];
            if (last &&
                last.added === change.added &&
                last.removed === change.removed) {
                last.value.push(...change.value);
            } else {
                result.push({ ...change, value: [...change.value] });
            }
        }

        return result;
    }

    private normalizeLineForMatch(input: string | undefined): string {
        let value = (input ?? '').trim();

        value = value.replace(/^\/\/\s?/, '');
        value = value.replace(/^#\s?/, '');
        value = value.replace(/^--\s?/, '');
        value = value.replace(/^\/\*\s?/, '');
        value = value.replace(/\*\/\s?$/, '');
        value = value.replace(/\s+/g, ' ');

        return value.trim();
    }

    private setTrackedChange(filePath: string, diff: FileDiff): void {
        this.trackedChanges.set(filePath, diff);
        this.markTrackedChangesDirty();
    }

    private deleteTrackedChange(filePath: string): void {
        if (this.trackedChanges.delete(filePath)) {
            this.markTrackedChangesDirty();
        }
    }

    private clearTrackedChanges(): void {
        if (this.trackedChanges.size === 0) {
            return;
        }
        this.trackedChanges.clear();
        this.markTrackedChangesDirty();
    }

    private markTrackedChangesDirty(): void {
        this.trackedChangesVersion++;
    }

    private bumpLineChangesVersion(filePath: string): number {
        const current = this.lineChangesVersionByFile.get(filePath) ?? 0;
        const next = current + 1;
        this.lineChangesVersionByFile.set(filePath, next);
        return next;
    }

    private invalidateChangeBlocksCache(filePath: string): void {
        this.changeBlocksCache.delete(filePath);
    }

    private resetChangeBlocksCaches(): void {
        this.changeBlocksCache.clear();
        this.lineChangesVersionByFile.clear();
    }

    private markLineChangesUpdated(filePath: string): void {
        this.bumpLineChangesVersion(filePath);
        this.invalidateChangeBlocksCache(filePath);
    }

    private emitTrackChangesEvent(event: Partial<TrackChangesEvent>): void {
        const normalizeFiles = (files: string[] | undefined): string[] => {
            if (!files || files.length === 0) {
                return [];
            }
            return [...new Set(files)];
        };

        this._onDidTrackChanges.fire({
            changedFiles: normalizeFiles(event.changedFiles),
            removedFiles: normalizeFiles(event.removedFiles),
            fullRefresh: event.fullRefresh === true,
            baselineChanged: event.baselineChanged === true
        });
    }

    private setIgnoreResultCache(cacheKey: string, ignored: boolean): void {
        this.ignoreResultCache.set(cacheKey, ignored);
        if (this.ignoreResultCache.size <= this.ignoreResultCacheMaxEntries) {
            return;
        }

        const oldestKey = this.ignoreResultCache.keys().next().value as string | undefined;
        if (oldestKey !== undefined) {
            this.ignoreResultCache.delete(oldestKey);
        }
    }

    public async dispose(): Promise<void> {
        this.advanceEpoch();
        this.disposed = true;
        await this.flushPendingPersistence();
        this.clearExternalChangeTimers();
        this.clearDocumentChangeTimers();
        this.clearWatcherSuppressionTimers();
        this.clearAutomationSessions();
        this.disposeFileWatchers();
        this.disposables.forEach(d => d.dispose());
        this._onDidChangeRecordingState.dispose();
        this._onDidTrackChanges.dispose();
        this._onDidChangeBaselineState.dispose();
    }
}
