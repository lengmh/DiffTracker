import * as vscode from 'vscode';
import { displayFileName } from './utils/displayPath';
import * as Diff from 'diff';
import * as path from 'path';
import * as fs from 'fs';
import { createHash } from 'crypto';
import ignore, { Ignore } from 'ignore';
import { compareGitContexts, GitContextSnapshot } from './gitContext';
import { detectLocalPathCaseSensitivity, resolveRelativePathIdentity } from './utils/pathIdentity';
import { CanonicalMonitoringScope, configuredScopeExplicitlyExcludesSubtree, createLegacyEffectiveScope, detectScopeExpansion, EffectiveMonitoringScope, evaluateConfiguredScope, isHardUnmonitorableRelativePath, parseEffectiveMonitoringScope, validateAndCanonicalizeScope, WorkspaceRootIdentity } from './monitoringScope';

export type ReviewKind = 'text' | 'opaque' | 'unknown';

export interface FileDiff {
    sourceNote?: string;
    filePath: string;
    fileName: string;
    originalContent: string;
    currentContent: string;
    isDeleted: boolean;
    reviewKind: ReviewKind;
    reviewReason?: string;
    unavailableReason?: string;
    baselineExists?: boolean;
    currentExists?: boolean;
    baselineSize?: number;
    currentSize?: number;
    baselineFingerprint?: string;
    currentFingerprint?: string;
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
    mode?: number;
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

interface ImportedDirectoryWatch {
    watcher: vscode.Disposable;
    epoch: number;
    provenAbsent: boolean;
}

interface CandidateCapacityGuard {
    // Coarse pre-read bound only. A candidate's durable category is unknown
    // until its current state has been read, so category limits are enforced
    // separately before the baseline is retained.
    remaining: number;
    exemptPaths: ReadonlySet<string>;
    countedCandidates: Set<string>;
}

interface CandidatePersistenceBudget {
    remainingBytes: number;
    fileSnapshots: number;
    fileModes: number;
    baselineExistingFiles: number;
    unresolvedBaselineFiles: number;
    opaqueBaselineFiles: number;
}

interface BaselineTransaction {
    epoch: number;
    valid?: () => boolean;
    observedEvents?: Map<string, StartupEvent>;
    rollback: () => void;
    done: Promise<void>;
    finish: () => void;
}

interface StartupEvent {
    uri: vscode.Uri;
    firstKind: 'change' | 'create' | 'delete';
    kind: 'change' | 'create' | 'delete';
}

interface OpaqueBaselineState {
    reason: string;
    size: number;
    mtime: number;
    fingerprint?: string;
}

interface CoverageGapEvidence {
    targetKind: 'file' | 'subtree';
    reasonCode: string;
    reason: string;
}

interface CoverageGapRecord {
    file?: CoverageGapEvidence;
    subtree?: CoverageGapEvidence;
}

export interface SubtreeCoverageDiagnostic {
    targetPath: string;
    reasonCode: string;
    reason: string;
}

interface PersistedTrackerState {
    version: 4;
    /** Parser-only provenance; never copied from JSON or emitted by buildPersistedState. */
    migratedFromV1?: boolean;
    isRecording: boolean;
    baselineState: 'building' | 'ready';
    scanCoverage?: string;
    workspaceRoots: string[];
    effectiveMonitoringScope: EffectiveMonitoringScope;
    retainedReviewPaths: string[];
    coverageGaps: Array<[string, CoverageGapRecord]>;
    legacyWatchExcludeByRoot: Array<[string, string[]]>;
    fileSnapshots: Array<[string, string]>;
    fileModes: Array<[string, number]>;
    baselineExistingFiles: string[];
    unresolvedBaselineFiles: Array<[string, string]>;
    opaqueBaselineFiles: Array<[string, OpaqueBaselineState]>;
    revertHistory: PersistedRevertRecord[];
    gitContexts: GitContextSnapshot[];
}

export type RestoreOutcome = 'absent' | 'restored' | 'recovered' | 'incomplete' | 'blocked';

export interface ActionResult {
    status: 'success' | 'failed' | 'conflict' | 'cancelled' | 'needsConfirmation' | 'needsAttention';
    filePath: string;
    reason?: string;
    bufferChanged?: boolean;
}

export interface BatchActionResult {
    results: ActionResult[];
    succeeded: number;
    failed: number;
}

export interface MixedBatchActionResult extends BatchActionResult {
    accepted: number;
    acknowledged: number;
    reverted: number;
    needsConfirmation: number;
    needsAttention: number;
    failures: number;
    conflicts: number;
    cancelled: number;
}

export interface ReviewToken {
    filePath: string;
    epoch: number;
    baselineRevision: string;
    currentRevision: string;
}

export interface OpaqueReviewToken {
    filePath: string;
    epoch: number;
    reviewRevision: string;
}

export interface MonitoringScopeApplyResult {
    status: 'applied' | 'failed' | 'conflict' | 'requiresS4';
    reason?: string;
    retainedReviews: number;
    discardedReviews: number;
    releasedBaselines: number;
    capturedBaselines: number;
}

export interface MonitoringScopePreflightDirectorySummary {
    root: string;
    path: string;
    entries: number;
}

export interface MonitoringScopePreflightDiagnostic {
    root: string;
    path: string;
    reason: string;
}

export interface MonitoringScopePreflightResult {
    status: 'ready' | 'conflict' | 'failed';
    scopeRevision: string;
    inspectedEntries: number;
    candidateFiles: number;
    candidateDirectories: number;
    skippedSymlinks: number;
    skippedHardBoundaries: number;
    skippedExplicitExclusions: number;
    truncated: boolean;
    entryLimit: number;
    unreadableDirectoryCount: number;
    unreadableDirectories: MonitoringScopePreflightDiagnostic[];
    largestDirectories: MonitoringScopePreflightDirectorySummary[];
    reason?: string;
}

type CurrentFileState =
    | { kind: 'text'; content: string; mode?: number }
    | { kind: 'missing' }
    | { kind: 'unavailable'; reason: string; reasonCode?: string; targetKind?: 'file' | 'directory'; size?: number; mtime?: number; fingerprint?: string };

type CandidateBaselinePlan =
    | { kind: 'text'; content: string; mode?: number; baselineExists: boolean }
    | { kind: 'opaque'; state: Extract<CurrentFileState, { kind: 'unavailable' }> & { size: number; mtime: number } }
    | { kind: 'unresolved'; reason: string };

export class DiffTracker {
    private sessionEpoch = 0;
    private disposed = false;
    private workspaceContextChanged = false;
    private sessionWorkspaceRoots: string[] = [];
    private latestGitContexts = new Map<string, GitContextSnapshot | undefined>();
    private fileActionQueues = new Map<string, Promise<unknown>>();
    private recoveryActionQueue: Promise<void> = Promise.resolve();
    private readonly creationTempRoots = new Set<string>();
    private readonly creationTempExpiryTimers = new Map<string, NodeJS.Timeout>();
    private readonly creationTempGraceMs = 5000;
    private fileModes = new Map<string, number>();
    private baselineTransaction?: BaselineTransaction;
    private restoringEpoch?: number;
    private initialIgnoreEpoch?: number;
    private initialWatchBoundaryMs?: number;
    private initialWatchBoundaryMonotonicNs?: bigint;
    private readonly startupTimestampSafetyMarginMs = 2000;
    private initialIgnoreEvents = new Map<string, StartupEvent>();
    private restoreEvents = new Map<string, { uri: vscode.Uri; kind: 'change' | 'create' | 'delete' }>();
    // Only same-session post-baseline notifications can be resolved by a later
    // create event. Restored or scan-time uncertainty still requires a rebuild.
    private postBaselineUnknownFiles = new Set<string>();

    private beginBaselineTransaction(rollback: () => void): BaselineTransaction {
        if (this.baselineTransaction) { throw new Error('Baseline transaction already active'); }
        if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = undefined; }
        let finish!: () => void;
        const done = new Promise<void>(resolve => { finish = resolve; });
        return this.baselineTransaction = { epoch: this.sessionEpoch, rollback, done, finish };
    }

    private endBaselineTransaction(transaction: BaselineTransaction, commit: boolean): void {
        if (this.baselineTransaction !== transaction) { return; }
        if (!commit) { transaction.rollback(); }
        this.baselineTransaction = undefined;
        transaction.finish();
    }
    private mayAdoptLegacyGitContexts = false;
    private gitContextPending = false;

    private queueRecoveryAction<T>(action: () => Promise<T>): Promise<T> {
        const operation = this.recoveryActionQueue.then(action);
        this.recoveryActionQueue = operation.then(() => undefined, () => undefined);
        return operation;
    }
    private scanUncertainFiles = new Set<string>();
    private activeCreations = new Map<string, { duringScan: boolean; cancelled?: boolean }>();
    private nextExternalOperationId = 1;
    private activeExternalOperations = new Map<number, { uri: vscode.Uri; kind: 'change' | 'delete' }>();

    private recordBaselineTransactionEvent(uri: vscode.Uri, kind: StartupEvent['kind']): void {
        const events = this.baselineTransaction?.observedEvents;
        if (!events) { return; }
        const previous = events.get(uri.fsPath);
        events.set(uri.fsPath, { uri, firstKind: previous?.firstKind ?? kind, kind });
    }

    private beginExternalOperation(uri: vscode.Uri, kind: 'change' | 'delete'): number {
        const id = this.nextExternalOperationId++;
        this.activeExternalOperations.set(id, { uri, kind });
        return id;
    }

    private endExternalOperation(id: number): void {
        this.activeExternalOperations.delete(id);
    }

    private isCurrentEpoch(epoch: number): boolean {
        return !this.disposed && epoch === this.sessionEpoch;
    }

    private advanceEpoch(): number {
        if (this.baselineTransaction) { this.endBaselineTransaction(this.baselineTransaction, false); }
        this.restoringEpoch = undefined;
        this.initialIgnoreEpoch = undefined;
        this.initialWatchBoundaryMs = undefined;
        this.initialWatchBoundaryMonotonicNs = undefined;
        this.initialIgnoreEvents.clear();
        this.restoreEvents.clear();
        this.postBaselineUnknownFiles.clear();
        this.mayAdoptLegacyGitContexts = false;
        this.clearExternalChangeTimers();
        this.clearDocumentChangeTimers();
        this.scanUncertainFiles.clear();
        for (const creation of this.activeCreations.values()) { creation.cancelled = true; }
        this.activeCreations.clear();
        this.activeExternalOperations.clear();
        this.pendingImportedDirectoryReconciliation.clear();
        this.importedDirectoryResumePromise = undefined;
        this.workspaceRootCaseSensitivityCache.clear();
        this.activeWriteFiles.clear();
        this.pendingWriteFiles.clear();
        return ++this.sessionEpoch;
    }

    private revision(content: string, exists: boolean): string {
        return createHash('sha256').update(exists ? 'exists:' : 'missing:').update(content).digest('hex');
    }

    public getReviewToken(filePath: string): ReviewToken | undefined {
        filePath = this.canonicalTrackingPath(filePath);
        const change = this.trackedChanges.get(filePath);
        const baseline = this.fileSnapshots.get(filePath);
        if (!change || change.reviewKind !== 'text' || change.unavailableReason || baseline === undefined ||
            !!this.coverageGaps.get(filePath)?.file || this.disposed) { return undefined; }
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

    private opaqueReviewRevision(change: FileDiff): string {
        return createHash('sha256').update(JSON.stringify({
            reviewKind: change.reviewKind,
            baselineExists: change.baselineExists ?? null,
            currentExists: change.currentExists ?? null,
            baselineSize: change.baselineSize ?? null,
            currentSize: change.currentSize ?? null,
            baselineFingerprint: change.baselineFingerprint ?? null,
            currentFingerprint: change.currentFingerprint ?? null,
            reviewReason: change.reviewReason ?? null,
            isDeleted: change.isDeleted
        })).digest('hex');
    }

    public getOpaqueReviewToken(filePath: string): OpaqueReviewToken | undefined {
        filePath = this.canonicalTrackingPath(filePath);
        const change = this.trackedChanges.get(filePath);
        if (!change || change.reviewKind !== 'opaque' || change.unavailableReason ||
            !!this.coverageGaps.get(filePath)?.file || this.disposed) { return undefined; }
        return { filePath, epoch: this.sessionEpoch, reviewRevision: this.opaqueReviewRevision(change) };
    }

    public getOpaqueReviewTokens(): OpaqueReviewToken[] {
        return [...this.trackedChanges.keys()].map(filePath => this.getOpaqueReviewToken(filePath))
            .filter((token): token is OpaqueReviewToken => !!token);
    }

    public getUnknownReviewPaths(): string[] {
        return [...this.trackedChanges.values()]
            .filter(change => change.reviewKind === 'unknown')
            .map(change => change.filePath);
    }

    private matchesOpaqueReview(token: OpaqueReviewToken | undefined): token is OpaqueReviewToken {
        if (!token || !this.isCurrentEpoch(token.epoch)) { return false; }
        const change = this.trackedChanges.get(token.filePath);
        return !!change && change.reviewKind === 'opaque' && !change.unavailableReason &&
            this.opaqueReviewRevision(change) === token.reviewRevision;
    }

    private currentStateMatchesOpaqueReview(change: FileDiff, state: CurrentFileState): boolean {
        if (change.currentExists === false) { return state.kind === 'missing'; }
        if (state.kind === 'text') {
            if (change.currentExists !== true || !change.currentFingerprint) { return false; }
            const fingerprint = createHash('sha256').update(state.content, 'utf8').digest('hex');
            return change.currentFingerprint === fingerprint &&
                (change.currentSize === undefined || change.currentSize === Buffer.byteLength(state.content, 'utf8'));
        }
        if (this.isStableUnsupportedState(state)) {
            return change.currentExists === true && !!change.currentFingerprint && !!state.fingerprint &&
                change.currentFingerprint === state.fingerprint &&
                (change.currentSize === undefined || change.currentSize === state.size);
        }
        return false;
    }

    private async verifyOpaqueReview(token: OpaqueReviewToken | undefined): Promise<CurrentFileState | undefined> {
        if (!this.matchesOpaqueReview(token)) { return undefined; }
        const state = await this.readCurrentFileState(token.filePath);
        if (!this.matchesOpaqueReview(token)) { return undefined; }
        const change = this.trackedChanges.get(token.filePath);
        return change && this.currentStateMatchesOpaqueReview(change, state) ? state : undefined;
    }

    private queueOpaqueFileAction(
        filePath: string,
        token: OpaqueReviewToken | undefined,
        action: (review: OpaqueReviewToken, state: CurrentFileState) => Promise<ActionResult>
    ): Promise<ActionResult> {
        const previous = this.fileActionQueues.get(filePath) ?? Promise.resolve();
        const task = previous.catch(() => undefined).then(async () => {
            const state = token?.filePath === filePath ? await this.verifyOpaqueReview(token) : undefined;
            if (!token || token.filePath !== filePath || !state) {
                const reason = this.hasDirtyDocument(filePath)
                    ? 'Save or discard editor changes before acknowledging this read-only review'
                    : 'Read-only review is stale or unavailable; refresh and review again';
                if (token && this.isCurrentEpoch(token.epoch)) { await this.refreshRejectedReview(filePath); }
                return this.actionResult(filePath, 'conflict', reason);
            }
            return action(token, state);
        });
        this.fileActionQueues.set(filePath, task);
        void task.finally(() => {
            if (this.fileActionQueues.get(filePath) === task) { this.fileActionQueues.delete(filePath); }
        }).catch(() => undefined);
        return task;
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
        const doc = vscode.workspace.textDocuments.find(value => value.uri.scheme === 'file' && this.canonicalTrackingPath(value.uri.fsPath) === token.filePath);
        if (state.kind === 'text' && doc && this.revision(doc.getText(), true) !== token.currentRevision) { return false; }
        return this.revision(state.kind === 'text' ? state.content : '', state.kind === 'text') === token.currentRevision;
    }

    private queueFileAction(filePath: string, token: ReviewToken | undefined,
        action: (review: ReviewToken) => Promise<ActionResult>): Promise<ActionResult> {
        const previous = this.fileActionQueues.get(filePath) ?? Promise.resolve();
        const task = previous.catch(() => undefined).then(async () => {
            if (!token || token.filePath !== filePath || !await this.verifyReview(token)) {
                const dirty = vscode.workspace.textDocuments.some(document =>
                    document.uri.scheme === 'file' && this.canonicalTrackingPath(document.uri.fsPath) === filePath && document.isDirty
                );
                const reason = dirty
                    ? 'Save the file before Keep or Revert so the reviewed content matches disk'
                    : this.trackedChanges.get(filePath)?.unavailableReason
                        ?? 'Review is stale or unavailable; refresh and review again';
                if (token && this.isCurrentEpoch(token.epoch)) { await this.refreshRejectedReview(filePath); }
                return this.actionResult(filePath, 'conflict', reason);
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
            value.uri.scheme === 'file' && this.canonicalTrackingPath(value.uri.fsPath) === filePath
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
    private opaqueBaselineFiles = new Map<string, OpaqueBaselineState>();
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
    private importedDirectoryWatchers = new Map<string, ImportedDirectoryWatch>();
    private pendingImportedDirectoryReconciliation = new Set<string>();
    private importedDirectoryResumePromise?: Promise<void>;
    private ignoreMatchers = new Map<string, Ignore>();
    private ignoreRefreshVersion = 0;
    private ignoreRefreshPromise: Promise<void> = Promise.resolve();
    private ignoreFingerprint?: string;
    private scanCoverage?: string;
    private effectiveMonitoringScope: EffectiveMonitoringScope;
    // Scope preparation temporarily stages matcher/baseline state. Public
    // status and live coverage callbacks must still see the committed scope.
    private committedScopeDuringApply?: EffectiveMonitoringScope;
    private readonly canonicalTrackingPaths = new Map<string, string>();
    private readonly workspaceRootCaseSensitivityCache = new Map<string, boolean>();
    private readonly rootIdentityUnavailableReason = 'Workspace root identity is unverified; prior review is preserved until identity and current state can be reconciled';
    private pendingMonitoringScope?: CanonicalMonitoringScope;
    private pendingScopeSuspendedPaths = new Set<string>();
    private retainedReviewPaths = new Set<string>();
    private coverageGaps = new Map<string, CoverageGapRecord>();
    // Resource-scoped legacy watchExclude policy that was actually committed
    // before a structured S3 request started replacing Workspace settings.
    // This is policy evidence, not user consent: it protects the old effective
    // scope until configured publication succeeds atomically.
    private committedLegacyWatchExcludeByRoot = new Map<string, string[]>();
    private coverageGeneration = 0;
    private ignoreResultCache = new Map<string, boolean>();
    private readonly ignoreResultCacheMaxEntries = 5000;
    private externalWatcherEnabled = false;
    private snapshotInitialized = false;
    private baselineBuilding = false;
    private pendingExternalChanges = new Set<string>();
    private externalChangeTimers = new Map<string, NodeJS.Timeout>();
    private documentChangeTimers = new Map<string, NodeJS.Timeout>();
    private scopeApplyPreflight = false;
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
    // Preflight is advisory discovery, not a project-size rejection threshold.
    // Hitting this bound returns a truncated lower-fidelity estimate rather than
    // publishing a partial scope or silently dropping resources.
    private readonly maxScopePreflightEntries = 10000;
    private readonly maxScopePreflightDiagnostics = 20;
    private readonly maxScopePreflightDirectorySummaries = 10;
    private readonly maxRevertHistory = 10;
    private nextRevertRecordId = 1;
    private revertHistory: PersistedRevertRecord[] = [];
    private readonly preparedHistory = new Map<PersistedRevertRecord, PersistedRevertRecord[]>();
    private recoveryBlocked = false;
    private persistenceIssue: string | undefined;
    private persistenceFailed = false;
    private baselineCompletionVersion = 0;
    private readonly persistenceFailureFileName = 'session-state.unsaved';
    private baselineGitContexts = new Map<string, GitContextSnapshot>();
    private pausedGitRepositories = new Map<string, string>();
    private readonly _onDidChangeRecordingState = new vscode.EventEmitter<boolean>();
    private readonly _onDidTrackChanges = new vscode.EventEmitter<TrackChangesEvent>();
    private readonly _onDidChangeBaselineState = new vscode.EventEmitter<'idle' | 'building' | 'ready'>();

    public readonly onDidChangeRecordingState = this._onDidChangeRecordingState.event;
    public readonly onDidTrackChanges = this._onDidTrackChanges.event;
    public readonly onDidChangeBaselineState = this._onDidChangeBaselineState.event;

    constructor(private readonly storageUri?: vscode.Uri) {
        this.sessionWorkspaceRoots = this.getWorkspaceRoots();
        this.effectiveMonitoringScope = this.createLegacyEffectiveScopeForRoots(this.sessionWorkspaceRoots);
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

        this.disposables.push(
            vscode.workspace.onDidCreateFiles(event => {
                for (const uri of event.files) {
                    void this.onExternalFileCreated(uri);
                }
            })
        );

        if (vscode.workspace.onDidChangeWorkspaceFolders) {
            this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
                // Root membership changes invalidate all issued actions. Preserve review
                // data, but require an explicit start/reset before establishing new roots.
                this.stopRecording();
                this.workspaceContextChanged = true;
                vscode.window.showWarningMessage('Code Diff Tracker: Workspace folders changed. Review paused; establish a new baseline explicitly.');
            }));
        }

        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                const watcherCoverageChanged = e.affectsConfiguration('files.watcherExclude');
                if (
                    e.affectsConfiguration('diffTracker.onlyTrackAutomatedChanges') ||
                    e.affectsConfiguration('diffTracker.onlyTrackVSCodeChanges') ||
                    e.affectsConfiguration('diffTracker.watchExclude') ||
                    watcherCoverageChanged ||
                    e.affectsConfiguration('search.exclude') ||
                    e.affectsConfiguration('files.exclude')
                ) {
                    if (watcherCoverageChanged) {
                        this.invalidateConfiguredScopeForWatcherCoverage();
                    }
                    this.scanCoverage = undefined;
                    this.schedulePersistState();
                    this.refreshIgnoreMatchers().catch(() => undefined);
                }
            })
        );
    }

    public async restorePersistedState(): Promise<RestoreOutcome> {
        const epoch = this.advanceEpoch();
        this.restoringEpoch = epoch;
        try {
            return await this.restorePersistedStateForEpoch(epoch);
        } catch {
            if (this.isCurrentEpoch(epoch)) {
                this.recoveryBlocked = true;
                this.isRecording = false;
                this.disposeFileWatchers();
                this.persistenceIssue = 'Restoration reconciliation failed; persisted review is preserved.';
            }
            return 'blocked';
        } finally {
            if (epoch === this.sessionEpoch) {
                this.restoringEpoch = undefined;
                this.restoreEvents.clear();
            }
        }
    }

    private async restorePersistedStateForEpoch(epoch: number): Promise<RestoreOutcome> {
        const failureUri = this.getPersistedStateUri(this.persistenceFailureFileName);
        if (failureUri) {
            try {
                await vscode.workspace.fs.stat(failureUri);
                if (!this.isCurrentEpoch(epoch)) { return 'blocked'; }
                this.recoveryBlocked = true;
                this.isRecording = false;
                this.persistenceIssue = 'The previous session could not be saved completely; preserve it before rebuilding.';
                return 'blocked';
            } catch (error) {
                if (!this.isFileNotFound(error)) {
                    this.recoveryBlocked = true;
                    this.persistenceIssue = 'Cannot verify whether the previous session was saved completely.';
                    return 'blocked';
                }
            }
        }
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
        this.mayAdoptLegacyGitContexts = state.migratedFromV1 === true;
        this.scanCoverage = state.scanCoverage;
        this.recoveryBlocked = false;
        this.persistenceIssue = loaded.kind === 'recovered'
            ? 'Recovered the last-good Code Diff Tracker session because the primary state was unreadable.'
            : undefined;

        this.clearExternalChangeTimers();
        this.clearDocumentChangeTimers();
        this.clearWatcherSuppressionTimers();
        this.clearAutomationSessions();
        this.disposeFileWatchers();

        const currentRoots = this.getWorkspaceRoots();
        const currentRootIdentities = this.currentWorkspaceRootIdentities();
        this.sessionWorkspaceRoots = [...state.workspaceRoots];
        const rootsMatch = this.sameStringSet(state.workspaceRoots, currentRoots);
        const scopeRootsMatch = this.sameWorkspaceRootIdentities(
            state.effectiveMonitoringScope.roots,
            currentRootIdentities
        );
        this.effectiveMonitoringScope = state.effectiveMonitoringScope;
        const configuredScopeNeedsReconciliation = state.effectiveMonitoringScope.kind === 'configured'
            ? (() => {
                const live = validateAndCanonicalizeScope({
                    mode: state.effectiveMonitoringScope.mode,
                    includes: state.effectiveMonitoringScope.includes,
                    excludes: state.effectiveMonitoringScope.excludes
                }, currentRootIdentities);
                return !live.ok || !live.scope ||
                    live.scope.scopeRevision !== state.effectiveMonitoringScope.scopeRevision;
            })()
            : false;
        const watcherCoverageNeedsS4 = state.effectiveMonitoringScope.kind === 'configured'
            ? this.configuredScopeNeedsSupplementalCoverage(state.effectiveMonitoringScope)
            : undefined;
        const incomplete = state.baselineState === 'building' || !rootsMatch || !scopeRootsMatch ||
            configuredScopeNeedsReconciliation || !!watcherCoverageNeedsS4;
        this.isRecording = incomplete ? false : state.isRecording;
        this.retainedReviewPaths = new Set(state.retainedReviewPaths);
        this.coverageGaps = new Map(state.coverageGaps);
        this.restorePendingScopeSuspendedPathsFromCoverageGaps();
        this.committedLegacyWatchExcludeByRoot = new Map(
            state.legacyWatchExcludeByRoot.map(([rootUri, patterns]) => [rootUri, [...patterns]])
        );
        this.fileSnapshots = new Map(state.fileSnapshots);
        this.fileModes = new Map(state.fileModes);
        this.baselineExistingFiles = new Set(state.baselineExistingFiles);
        this.unresolvedBaselineFiles = new Map(state.unresolvedBaselineFiles);
        this.opaqueBaselineFiles = new Map(state.opaqueBaselineFiles);
        this.canonicalTrackingPaths.clear();
        for (const filePath of new Set([
            ...this.fileSnapshots.keys(), ...this.unresolvedBaselineFiles.keys(), ...this.opaqueBaselineFiles.keys()
        ])) { this.canonicalTrackingPath(filePath, true); }
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
        this.workspaceContextChanged = !rootsMatch || !scopeRootsMatch;

        // Cover ignore discovery too; restore callbacks queue until reconciliation.
        if (this.isRecording) {
            try {
                this.activateExternalWatchers(this.createExternalWatchers(epoch));
            } catch (error) {
                this.recoveryBlocked = true;
                this.isRecording = false;
                this.persistenceIssue = 'Cannot restore watcher coverage; persisted review is preserved.';
                return 'blocked';
            }
        }
        // Persisted subtree gaps are also restart obligations. Rebuild their
        // runtime watcher entries after the general workspace watcher is live,
        // then let ignore reconciliation install/validate the direct watches.
        this.restoreImportedDirectoryCoverageObligations();
        try {
            await this.refreshIgnoreMatchers();
        } catch (error) {
            if (!this.isCurrentEpoch(epoch)) { return 'blocked'; }
            this.recoveryBlocked = true;
            this.isRecording = false;
            this.disposeFileWatchers();
            this.persistenceIssue = 'Cannot restore ignore rules; persisted review is preserved.';
            return 'blocked';
        }
        if (!this.isCurrentEpoch(epoch)) { return 'blocked'; }
        const migratedDirectorySentinels = this.normalizeRestoredDirectorySentinels();
        if (migratedDirectorySentinels && !await this.flushPersistState()) {
            this.recoveryBlocked = true;
            this.isRecording = false;
            this.disposeFileWatchers();
            this.persistenceIssue = 'Cannot persist migrated directory coverage diagnostics; the previous saved review remains preserved.';
            return 'blocked';
        }
        if (watcherCoverageNeedsS4 && state.baselineState !== 'building') {
            // Persist the pause so removing the setting before a later restart
            // cannot silently resurrect a baseline that had an observation gap.
            if (!await this.flushPersistState()) {
                this.recoveryBlocked = true;
                this.persistenceIssue = 'Cannot persist the watcher-coverage pause; saved review is preserved.';
                return 'blocked';
            }
        }

        // Discover offline additions before rebuilding diffs. An existing empty
        // file and an absent baseline are distinct, including across reloads.
        if (this.isRecording) {
            try {
                await this.discoverRestoredFiles(epoch);
            } catch (error) {
                if (!this.isCurrentEpoch(epoch)) { return 'blocked'; }
                this.recoveryBlocked = true;
                this.isRecording = false;
                this.disposeFileWatchers();
                this.persistenceIssue = 'Cannot reconcile restored workspace files; persisted review is preserved.';
                return 'blocked';
            }
            if (!this.isCurrentEpoch(epoch)) { return 'blocked'; }
            // A persisted imported-directory diagnostic can retire only after
            // both its fresh direct watch and this restore scan have succeeded.
            this.reconcileImportedDirectoryCoverageAfterSuccessfulScan(epoch);
        } else {
            this.externalWatcherEnabled = false;
        }
        await this.rebuildTrackedChangesFromSnapshots();
        if (!this.isCurrentEpoch(epoch)) { return 'blocked'; }
        this.reconcilePendingScopeSuspendedPaths();
        while (this.restoreEvents.size > 0) {
            if ([...this.restoreEvents.values()].some(event => path.basename(event.uri.fsPath) === '.gitignore')) {
                await this.refreshIgnoreMatchers();
                if (!this.isCurrentEpoch(epoch)) { return 'blocked'; }
                await this.discoverRestoredFiles(epoch);
            }
            const restoreEvents = [...this.restoreEvents.values()];
            this.restoreEvents.clear();
            for (const { uri, kind } of restoreEvents) {
                if (!this.isCurrentEpoch(epoch)) { return 'blocked'; }
                if (this.isPathIgnored(uri)) { continue; }
                if (kind === 'create') { await this.onExternalFileCreated(uri); }
                else if (kind === 'delete') { await this.onExternalFileDeleted(uri); }
                else { await this.readFileAndUpdate(uri.fsPath, uri); }
            }
        }
        if (!this.isCurrentEpoch(epoch)) { return 'blocked'; }
        if (incomplete) {
            this.persistenceIssue = watcherCoverageNeedsS4
                ? `Effective monitoring scope requires supplemental coverage at ${watcherCoverageNeedsS4}; review is paused until the scope is narrowed or S4-B coverage exists, then the baseline is rebuilt.`
                : state.baselineState === 'building'
                    ? 'Recovered a partial baseline scan in paused mode; rebuild the baseline before review actions.'
                    : !rootsMatch
                        ? 'Workspace roots differ from the persisted session; review is paused until an explicit baseline rebuild.'
                        : !scopeRootsMatch
                            ? 'Workspace root identity differs from the effective monitoring scope; review is paused until the scope is reconciled.'
                            : 'Effective monitoring scope is durably preserved, but its current filesystem identity cannot be safely verified; review is paused until the scope is reconciled or the baseline is rebuilt.';
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
        const identityIssue = this.getPathIdentityIssue();
        if (identityIssue) {
            vscode.window.showWarningMessage(`Code Diff Tracker: ${identityIssue}. Recording remains paused.`);
            return;
        }
        if (this.effectiveMonitoringScope.kind === 'configured') {
            const watcherCoverageIssue = this.configuredScopeNeedsSupplementalCoverage(this.effectiveMonitoringScope);
            if (watcherCoverageIssue) {
                vscode.window.showWarningMessage(
                    `Code Diff Tracker: Effective monitoring scope requires supplemental coverage at ${watcherCoverageIssue}. Narrow the scope or wait for S4-B supplemental coverage before rebuilding.`
                );
                return;
            }
        }
        this.sessionWorkspaceRoots = this.getWorkspaceRoots();
        if (this.effectiveMonitoringScope.kind === 'legacyV3') {
            this.effectiveMonitoringScope = this.createLegacyEffectiveScopeForRoots(this.sessionWorkspaceRoots);
        }
        const epoch = this.advanceEpoch();
        this.workspaceContextChanged = false;
        const removedFiles = Array.from(this.trackedChanges.keys());
        this.isRecording = true;
        this.clearAutomationSessions();
        this.clearWatcherSuppressionTimers();
        this.pendingWriteFiles.clear();
        this.fileSnapshots.clear();
        this.canonicalTrackingPaths.clear();
        this.fileModes.clear();
        this.baselineExistingFiles.clear();
        this.unresolvedBaselineFiles.clear();
        this.opaqueBaselineFiles.clear();
        this.retainedReviewPaths.clear();
        this.coverageGaps.clear();
        this.pendingScopeSuspendedPaths.clear();
        this.clearTrackedChanges();
        this.lineChanges.clear();
        this.resetChangeBlocksCaches();
        this.inlineViews.clear();
        this.pendingExternalChanges.clear();
        this.revertHistory = [];
        this.baselineGitContexts.clear();
        this.pausedGitRepositories.clear();
        this.snapshotInitialized = false;
        this.scanCoverage = undefined;
        this.baselineBuilding = true;
        this._onDidChangeBaselineState.fire('building');

        try {
            // Watch immediately, but classify paths and capture documents only
            // after ignore discovery. Startup events cannot establish a before-image.
            // The wall-clock boundary is used only to reject a synthetic/late
            // create when file birth/content metadata proves it predates watcher
            // activation. Ambiguous timestamps remain conservative uncertainty.
            this.initialWatchBoundaryMs = Date.now();
            this.initialWatchBoundaryMonotonicNs = process.hrtime.bigint();
            this.initialIgnoreEpoch = epoch;
            this.activateExternalWatchers(this.createExternalWatchers(epoch));
            void this.initializeWorkspaceSnapshots().catch(() => {
                if (this.isCurrentEpoch(epoch) && this.baselineBuilding) {
                    vscode.window.showWarningMessage('Code Diff Tracker: Baseline scan did not complete; review remains incomplete.');
                }
            });
        } catch (error) {
            this.initialWatchBoundaryMs = undefined;
            this.initialWatchBoundaryMonotonicNs = undefined;
            this.disposeFileWatchers();
            this.externalWatcherEnabled = false;
            vscode.window.showWarningMessage('Code Diff Tracker: Cannot establish file watcher coverage; baseline remains incomplete.');
            console.warn('Failed to start baseline recording', error);
        }
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

    public resetBaselineToCurrentState(): Promise<boolean> {
        const epoch = this.sessionEpoch;
        return this.queueRecoveryAction(() => this.isCurrentEpoch(epoch) && !this.gitContextPending
            ? this.performBaselineReset() : Promise.resolve(false));
    }

    private async performBaselineReset(): Promise<boolean> {
        if (this.recoveryBlocked) { return false; }
        const previousEpoch = this.sessionEpoch;
        let watchers: vscode.FileSystemWatcher[] | undefined;
        if (this.isRecording) {
            try {
                await this.refreshIgnoreMatchers();
                if (!this.isCurrentEpoch(previousEpoch)) { return false; }
                watchers = this.createExternalWatchers(previousEpoch + 1);
            } catch (error) {
                this.reportExternalWatcherFailure(error);
                return false;
            }
        }
        // Creation handlers carry stronger provenance than a generic path read:
        // they can establish known absence and recursively discover imported
        // directories. advanceEpoch() cancels handlers from the old epoch, so
        // retain their kind for an exact rollback replay.
        const preResetCreations = new Map(
            [...this.activeCreations].map(([filePath, creation]) => [filePath, creation.duringScan] as const)
        );
        const preResetStartupEvents = new Map(this.initialIgnoreEvents);
        const previousScanUncertainFiles = new Set(this.scanUncertainFiles);
        const preResetExternalEvents = new Map<string, StartupEvent>();
        for (const { uri, kind } of this.activeExternalOperations.values()) {
            const previous = preResetExternalEvents.get(uri.fsPath);
            preResetExternalEvents.set(uri.fsPath, { uri, firstKind: previous?.firstKind ?? kind, kind });
        }
        const preResetObservedPaths = new Set<string>([
            ...this.pendingExternalChanges,
            ...this.externalChangeTimers.keys(),
            ...this.documentChangeTimers.keys(),
            ...this.scanUncertainFiles
        ]);
        preResetExternalEvents.forEach((_event, filePath) => preResetObservedPaths.delete(filePath));
        // advanceEpoch() intentionally clears same-session provenance. Keep a
        // copy so a failed replacement baseline can restore the old session
        // exactly; otherwise a change-first addition can no longer be upgraded
        // by a later create event after rollback.
        const previousPostBaselineUnknownFiles = new Set(this.postBaselineUnknownFiles);
        const epoch = this.advanceEpoch();
        if (watchers) { this.activateExternalWatchers(watchers); }
        if (!this.isRecording) {
            return this.clearStoppedBaseline(epoch);
        }

        const previous = {
            fileSnapshots: new Map(this.fileSnapshots),
            fileModes: new Map(this.fileModes),
            baselineExistingFiles: new Set(this.baselineExistingFiles),
            unresolvedBaselineFiles: new Map(this.unresolvedBaselineFiles),
            opaqueBaselineFiles: new Map(this.opaqueBaselineFiles),
            trackedChanges: new Map(this.trackedChanges),
            lineChanges: new Map(this.lineChanges),
            inlineViews: new Map(this.inlineViews),
            revertHistory: this.revertHistory.map(record => ({
                ...record,
                items: record.items.map(item => ({ ...item, before: { ...item.before }, after: { ...item.after } }))
            })),
            baselineGitContexts: new Map(this.baselineGitContexts),
            pausedGitRepositories: new Map(this.pausedGitRepositories),
            sessionWorkspaceRoots: [...this.sessionWorkspaceRoots],
            snapshotInitialized: this.snapshotInitialized,
            baselineBuilding: this.baselineBuilding,
            workspaceContextChanged: this.workspaceContextChanged,
            scanCoverage: this.scanCoverage,
            retainedReviewPaths: new Set(this.retainedReviewPaths),
            coverageGaps: new Map(this.coverageGaps),
            pendingScopeSuspendedPaths: new Set(this.pendingScopeSuspendedPaths),
            pendingExternalChanges: new Set(this.pendingExternalChanges),
            postBaselineUnknownFiles: previousPostBaselineUnknownFiles,
            scanUncertainFiles: previousScanUncertainFiles
        };
        const previousReviewPaths = [...previous.trackedChanges.keys()];
        let transaction!: BaselineTransaction;
        let replacementEvents = new Map<string, StartupEvent>();
        const restoreMemory = (): void => {
            const observedPaths = new Set([
                ...this.trackedChanges.keys(),
                ...this.pendingExternalChanges
            ]);
            this.fileSnapshots = previous.fileSnapshots;
            this.fileModes = previous.fileModes;
            this.baselineExistingFiles = previous.baselineExistingFiles;
            this.unresolvedBaselineFiles = previous.unresolvedBaselineFiles;
            this.opaqueBaselineFiles = previous.opaqueBaselineFiles;
            this.trackedChanges = previous.trackedChanges;
            this.lineChanges = previous.lineChanges;
            this.inlineViews = previous.inlineViews;
            this.revertHistory = previous.revertHistory;
            this.baselineGitContexts = previous.baselineGitContexts;
            this.pausedGitRepositories = previous.pausedGitRepositories;
            this.sessionWorkspaceRoots = previous.sessionWorkspaceRoots;
            this.snapshotInitialized = previous.snapshotInitialized;
            this.baselineBuilding = previous.baselineBuilding;
            this.workspaceContextChanged = previous.workspaceContextChanged;
            this.scanCoverage = previous.scanCoverage === this.ignoreFingerprint ? previous.scanCoverage : undefined;
            this.retainedReviewPaths = new Set(previous.retainedReviewPaths);
            this.coverageGaps = new Map(previous.coverageGaps);
            this.pendingScopeSuspendedPaths = new Set(previous.pendingScopeSuspendedPaths);
            this.pendingExternalChanges = new Set([
                ...previous.pendingExternalChanges,
                ...preResetObservedPaths,
                ...observedPaths
            ].filter(filePath => !preResetCreations.has(filePath) &&
                !preResetExternalEvents.has(filePath) && !replacementEvents.has(filePath)));
            this.postBaselineUnknownFiles = new Set(previous.postBaselineUnknownFiles);
            this.scanUncertainFiles = new Set(previous.scanUncertainFiles);
            this.resetChangeBlocksCaches();
            this.trackedChangesVersion++;
            this.trackedChangesCacheVersion = -1;
        };
        const rollback = async (): Promise<void> => {
            if (!this.isCurrentEpoch(epoch)) { return; }
            // Events queued while the replacement baseline is in its startup-ignore
            // phase belong to the failed transaction. Freeze them before restoring
            // memory, then end that phase so replay cannot be deferred again.
            const startupEvents = new Map<string, StartupEvent>();
            const appendStartupEvent = (event: StartupEvent): void => {
                const existing = startupEvents.get(event.uri.fsPath);
                startupEvents.set(event.uri.fsPath, {
                    uri: event.uri,
                    firstKind: existing?.firstKind ?? event.firstKind,
                    kind: event.kind
                });
            };
            preResetStartupEvents.forEach(appendStartupEvent);
            if (previous.baselineBuilding) {
                for (const [filePath] of preResetCreations) {
                    appendStartupEvent({
                        uri: vscode.Uri.file(filePath),
                        firstKind: 'create',
                        kind: 'create'
                    });
                }
                preResetExternalEvents.forEach(appendStartupEvent);
            }
            if (this.initialIgnoreEpoch === epoch) {
                this.initialIgnoreEvents.forEach(appendStartupEvent);
            }
            replacementEvents = new Map(transaction.observedEvents ?? []);
            if (previous.baselineBuilding) {
                replacementEvents.forEach(appendStartupEvent);
            }
            this.initialIgnoreEpoch = undefined;
            this.initialIgnoreEvents.clear();

            // Replacement create handlers captured scanEvent against the candidate
            // baseline. They must not resume after old memory is restored and
            // overwrite replayed post-baseline creation evidence.
            for (const creation of this.activeCreations.values()) { creation.cancelled = true; }
            this.activeCreations.clear();

            this.endBaselineTransaction(transaction, false);

            if (previous.baselineBuilding && this.isRecording) {
                // advanceEpoch() cancelled the previous scan. Restoring only its
                // flags would strand the session in "Starting..." forever, so
                // resume discovery in the current epoch from the restored partial
                // evidence. Treat all creation/startup events seen across the
                // handoff as scan-time evidence; they must not establish a fresh
                // post-baseline absence while the prior baseline was incomplete.
                this.initialIgnoreEpoch = epoch;
                this.initialIgnoreEvents = startupEvents;
                try {
                    await this.initializeWorkspaceSnapshots();
                } catch (error) {
                    if (this.isCurrentEpoch(epoch)) {
                        this.reportPersistenceIssue(
                            'Failed to resume the interrupted baseline after Clear Diffs rollback.',
                            error
                        );
                    }
                }
            } else {
                const replayEvents = new Map<string, StartupEvent>();
                const appendReplayEvent = (event: StartupEvent): void => {
                    const existing = replayEvents.get(event.uri.fsPath);
                    replayEvents.set(event.uri.fsPath, {
                        uri: event.uri,
                        firstKind: existing?.firstKind ?? event.firstKind,
                        kind: event.kind
                    });
                };
                for (const [filePath] of preResetCreations) {
                    appendReplayEvent({ uri: vscode.Uri.file(filePath), firstKind: 'create', kind: 'create' });
                }
                preResetExternalEvents.forEach(appendReplayEvent);
                startupEvents.forEach(appendReplayEvent);
                replacementEvents.forEach(appendReplayEvent);

                if ([...replayEvents.values()].some(event => path.basename(event.uri.fsPath) === '.gitignore')) {
                    await this.refreshIgnoreMatchers();
                }
                for (const event of replayEvents.values()) {
                    if (!this.isCurrentEpoch(epoch)) { return; }
                    if (event.kind === 'delete') {
                        await this.onExternalFileDeleted(event.uri);
                    } else if (event.kind === 'create' || event.firstKind === 'create') {
                        await this.onExternalFileCreated(event.uri);
                    } else {
                        this.pendingExternalChanges.add(event.uri.fsPath);
                    }
                }
                await this.processPendingExternalChanges();
            }
            await this.flushPendingPersistence();
            this._onDidChangeBaselineState.fire(this.baselineBuilding ? 'building' : 'ready');
            this.emitTrackChangesEvent({ fullRefresh: true, baselineChanged: true });
        };

        transaction = this.beginBaselineTransaction(restoreMemory);
        transaction.observedEvents = new Map();
        transaction.valid = () => this.isRecording && !this.recoveryBlocked &&
            !this.workspaceContextChanged && !this.gitContextPending;

        this.workspaceContextChanged = false;
        this.revertHistory = [];
        this.sessionWorkspaceRoots = this.getWorkspaceRoots();
        this.clearExternalChangeTimers();
        this.clearDocumentChangeTimers();
        this.pendingWriteFiles.clear();
        this.fileSnapshots = new Map();
        this.fileModes = new Map();
        this.baselineExistingFiles = new Set();
        this.unresolvedBaselineFiles = new Map();
        this.opaqueBaselineFiles = new Map();
        this.retainedReviewPaths = new Set();
        this.coverageGaps = new Map();
        this.pendingScopeSuspendedPaths = new Set();
        this.clearTrackedChanges();
        this.lineChanges = new Map();
        this.resetChangeBlocksCaches();
        this.inlineViews = new Map();
        this.pendingExternalChanges = new Set();
        this.snapshotInitialized = false;
        this.scanCoverage = undefined;
        this.baselineBuilding = true;
        this._onDidChangeBaselineState.fire('building');

        try {
            this.initialIgnoreEpoch = epoch;
            await this.initializeWorkspaceSnapshots(transaction);
            const committed = this.isCurrentEpoch(epoch) && this.baselineTransaction === transaction &&
                this.snapshotInitialized && !this.baselineBuilding && (!transaction.valid || transaction.valid());
            if (!committed) {
                await rollback();
                return false;
            }
            this.endBaselineTransaction(transaction, true);
            this.emitTrackChangesEvent({
                removedFiles: previousReviewPaths,
                fullRefresh: true,
                baselineChanged: true
            });
            return true;
        } catch (error) {
            if (this.isCurrentEpoch(epoch)) {
                this.reportPersistenceIssue('Clear Diffs baseline rebuild failed; prior review retained.', error);
                await rollback();
            }
            return false;
        } finally {
            if (this.baselineTransaction === transaction) {
                await rollback();
            }
        }
    }

    private async clearStoppedBaseline(epoch: number): Promise<boolean> {
        const previous = {
            fileSnapshots: this.fileSnapshots, fileModes: this.fileModes,
            baselineExistingFiles: this.baselineExistingFiles, unresolvedBaselineFiles: this.unresolvedBaselineFiles,
            opaqueBaselineFiles: this.opaqueBaselineFiles,
            revertHistory: this.revertHistory, baselineGitContexts: this.baselineGitContexts,
            pausedGitRepositories: this.pausedGitRepositories, sessionWorkspaceRoots: this.sessionWorkspaceRoots,
            snapshotInitialized: this.snapshotInitialized, baselineBuilding: this.baselineBuilding,
            workspaceContextChanged: this.workspaceContextChanged,
            scanCoverage: this.scanCoverage,
            retainedReviewPaths: this.retainedReviewPaths,
            coverageGaps: this.coverageGaps,
            pendingScopeSuspendedPaths: this.pendingScopeSuspendedPaths
        };
        const transaction = this.beginBaselineTransaction(() => { Object.assign(this, previous); });
        this.fileSnapshots = new Map();
        this.fileModes = new Map();
        this.baselineExistingFiles = new Set();
        this.unresolvedBaselineFiles = new Map();
        this.opaqueBaselineFiles = new Map();
        this.retainedReviewPaths = new Set();
        this.coverageGaps = new Map();
        this.pendingScopeSuspendedPaths = new Set();
        this.revertHistory = [];
        this.baselineGitContexts = new Map();
        this.pausedGitRepositories = new Map();
        this.sessionWorkspaceRoots = this.getWorkspaceRoots();
        if (this.effectiveMonitoringScope.kind === 'legacyV3') {
            this.effectiveMonitoringScope = this.createLegacyEffectiveScopeForRoots(this.sessionWorkspaceRoots);
        }
        this.workspaceContextChanged = false;
        this.scanCoverage = undefined;
        this.snapshotInitialized = true;
        this.baselineBuilding = true;
        let committed = false;
        try {
            // Persist an explicit empty, stopped session through the same durable
            // writer as Keep. Deleting several state files cannot be atomic.
            committed = await this.flushPersistState(true, transaction) && this.isCurrentEpoch(epoch);
            if (!committed) { return false; }
            this.endBaselineTransaction(transaction, true);
            this.baselineBuilding = false;
            this.pendingExternalChanges.clear();
            this.clearDiffs();
            return true;
        } finally {
            this.endBaselineTransaction(transaction, committed);
            if (!committed && this.isCurrentEpoch(epoch)) { await this.flushPendingPersistence(); }
            if (this.isCurrentEpoch(epoch)) { this._onDidChangeBaselineState.fire(this.getBaselineState()); }
        }
    }

    private createExternalWatchers(epoch: number): vscode.FileSystemWatcher[] {
        const watchers: vscode.FileSystemWatcher[] = [];
        try {
            for (const folder of this.getSupportedWorkspaceFolders()) {
                const pattern = new vscode.RelativePattern(folder, '**/*');
                watchers.push(this.createPathWatcher(pattern, epoch));
            }
            return watchers;
        } catch (error) {
            watchers.forEach(watcher => watcher.dispose());
            throw error;
        }
    }

    private createPathWatcher(pattern: vscode.RelativePattern, epoch: number): vscode.FileSystemWatcher {
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        watcher.onDidChange(uri => this.dispatchExternalEvent(uri, 'change', epoch));
        watcher.onDidCreate(uri => this.dispatchExternalEvent(uri, 'create', epoch));
        watcher.onDidDelete(uri => this.dispatchExternalEvent(uri, 'delete', epoch));
        return watcher;
    }

    private dispatchExternalEvent(uri: vscode.Uri, kind: 'change' | 'create' | 'delete', epoch: number): void {
        if (!this.isCurrentEpoch(epoch)) { return; }
        if (uri.scheme === 'file') { uri = vscode.Uri.file(this.canonicalTrackingPath(uri.fsPath)); }
        if (path.basename(uri.fsPath) === '.gitignore') {
            this.scanCoverage = undefined;
            this.schedulePersistState();
            void this.refreshIgnoreMatchers().catch(() => undefined);
        }
        if (this.restoringEpoch === epoch) {
            // A change does not invalidate the evidence that a path
            // was created. Delete replaces it; a later create starts
            // a new incarnation and establishes absence again.
            const previous = this.restoreEvents.get(uri.fsPath);
            if (kind !== 'change' || previous?.kind !== 'create') {
                this.restoreEvents.set(uri.fsPath, { uri, kind });
            }
            return;
        }
        if (kind === 'create') { void this.onExternalFileCreated(uri); }
        else if (kind === 'delete') { void this.onExternalFileDeleted(uri); }
        else { void this.onExternalFileChanged(uri); }
    }

    private readonly maxImportedDirectoryWatchers = 256;

    private pruneIgnoredImportedDirectoryWatchers(): void {
        for (const [directory, entry] of this.importedDirectoryWatchers) {
            if (this.isPathIgnored(vscode.Uri.file(directory), true)) {
                entry.watcher.dispose();
                // Retain discovery/provenance, not an active OS resource.
                entry.epoch = -1;
            }
        }
    }

    private isImportedDirectoryCoverageGap(record: CoverageGapRecord | undefined): boolean {
        const reasonCode = record?.subtree?.reasonCode;
        return reasonCode === 'directory-scan-coverage-gap' ||
            reasonCode === 'directory-runtime-coverage-gap';
    }

    private restoreImportedDirectoryCoverageObligations(): void {
        for (const [targetPath, record] of this.coverageGaps) {
            if (!this.isImportedDirectoryCoverageGap(record)) { continue; }
            const directory = path.resolve(targetPath);
            const provenAbsent = record.subtree?.reasonCode === 'directory-runtime-coverage-gap';
            const existing = this.importedDirectoryWatchers.get(directory);
            if (existing) {
                existing.provenAbsent = provenAbsent;
                if (existing.epoch === this.sessionEpoch) {
                    this.pendingImportedDirectoryReconciliation.add(directory);
                }
                continue;
            }
            // Persistence stores the uncertainty, not an OS handle. A no-op
            // placeholder is enough for resumeImportedDirectoryWatchers() to
            // rebuild the direct watch before the gap can be retired.
            this.importedDirectoryWatchers.set(directory, {
                watcher: { dispose: () => undefined },
                epoch: -1,
                provenAbsent
            });
        }
    }

    private reconcileImportedDirectoryCoverageAfterSuccessfulScan(
        epoch: number,
        directories?: readonly string[]
    ): void {
        const targets = directories ?? [...this.pendingImportedDirectoryReconciliation];
        for (const targetPath of targets) {
            const directory = path.resolve(targetPath);
            const record = this.coverageGaps.get(directory);
            if (!this.isImportedDirectoryCoverageGap(record)) {
                this.pendingImportedDirectoryReconciliation.delete(targetPath);
                this.pendingImportedDirectoryReconciliation.delete(directory);
                continue;
            }
            const entry = this.importedDirectoryWatchers.get(directory);
            if (entry?.epoch !== epoch || this.validateResourceTarget(directory)) {
                // Keep the obligation pending: a later refresh may restore the
                // direct watch, and only a subsequent successful scan may clear it.
                continue;
            }
            try {
                if (!fs.lstatSync(directory).isDirectory()) { continue; }
            } catch {
                continue;
            }
            this.clearCoverageGap(directory, 'subtree');
            if (this.fileSnapshots.has(directory) && !this.baselineExistingFiles.has(directory)) {
                this.clearAbsentDirectorySentinel(directory);
            }
            this.pendingImportedDirectoryReconciliation.delete(targetPath);
            this.pendingImportedDirectoryReconciliation.delete(directory);
        }
    }

    private async resumeImportedDirectoryWatchers(epoch: number, version: number): Promise<void> {
        const previous = this.importedDirectoryResumePromise;
        const operation = (async () => {
            await previous;
            if (!this.isCurrentEpoch(epoch) || version !== this.ignoreRefreshVersion) { return; }
            await this.performImportedDirectoryResume(epoch, version);
        })();
        // A newer refresh must wait until older physical installation finishes,
        // then inherit its reconciliation obligation. This queue covers only
        // watch installation, never the ignore-refresh promise that calls it.
        this.importedDirectoryResumePromise = operation.catch(() => undefined);
        await operation;
    }

    private async performImportedDirectoryResume(epoch: number, version: number): Promise<void> {
        if (!this.isRecording || !this.externalWatcherEnabled) { return; }
        for (const [directory, previous] of Array.from(this.importedDirectoryWatchers)) {
            if (!this.isCurrentEpoch(epoch) || version !== this.ignoreRefreshVersion) { return; }
            if (this.importedDirectoryWatchers.get(directory)?.epoch === epoch ||
                this.isPathIgnored(vscode.Uri.file(directory), true)) { continue; }
            try {
                if (!fs.lstatSync(directory).isDirectory()) { this.removeImportedDirectoryWatchers(directory); continue; }
                // Register before exposing active watches to overlapping refreshes.
                this.pendingImportedDirectoryReconciliation.add(directory);
                await this.watchImportedTree(directory, epoch, previous.provenAbsent);
            } catch (error) {
                if (!this.isCurrentEpoch(epoch) || version !== this.ignoreRefreshVersion) { return; }
                if (this.isFileNotFound(error)) { this.removeImportedDirectoryWatchers(directory); }
                else { await this.markCreatedDirectoryUnavailable(directory, 'Imported directory watch coverage could not be restored; rebuild after resolving the watcher failure', !previous.provenAbsent, epoch, version); }
            }
        }
    }

    private watchImportedDirectory(directory: string, epoch: number, inheritedAbsence = false): boolean {
        this.pruneIgnoredImportedDirectoryWatchers();
        if (this.isPathIgnored(vscode.Uri.file(directory), true)) { return false; }
        const previous = this.importedDirectoryWatchers.get(directory);
        if (previous?.epoch === epoch) { return false; }
        const activeCount = Array.from(this.importedDirectoryWatchers.values()).filter(entry => entry.epoch === epoch).length;
        if (activeCount >= this.maxImportedDirectoryWatchers) { throw new Error('Imported directory watcher limit reached'); }
        // The host may reuse a recursive watcher that never adopted moved-in
        // descendants. Watch local directories directly, without that backend.
        const targetError = this.validateResourceTarget(directory);
        if (targetError) { throw new Error(targetError); }
        const provenAbsent = previous?.provenAbsent ?? (inheritedAbsence || this.hasObservedCreation(directory));
        const reportFailure = (reason: string): void => {
            void this.markCreatedDirectoryUnavailable(directory, reason, !provenAbsent, epoch);
        };
        const native = fs.watch(directory, { persistent: false }, (kind, filename) => {
            if (!this.isCurrentEpoch(epoch) || this.importedDirectoryWatchers.get(directory)?.epoch !== epoch ||
                this.isPathIgnored(vscode.Uri.file(directory), true)) { return; }
            if (!filename) {
                reportFailure('Directory watcher returned an unnamed event; rebuild the baseline to reconcile');
                return;
            }
            const filePath = path.join(directory, filename.toString());
            if (!this.pathBelongsToRoot(filePath, directory)) { return; }
            this.dispatchExternalEvent(vscode.Uri.file(filePath), kind === 'change' ? 'change' : fs.existsSync(filePath) ? 'create' : 'delete', epoch);
        });
        const watcher = { dispose: () => native.close() };
        this.importedDirectoryWatchers.set(directory, { watcher, epoch, provenAbsent });
        native.on('error', () => {
            native.close();
            if (this.isCurrentEpoch(epoch) && this.importedDirectoryWatchers.get(directory)?.watcher === watcher &&
                this.importedDirectoryWatchers.get(directory)?.epoch === epoch) {
                this.importedDirectoryWatchers.get(directory)!.epoch = -1;
                reportFailure('Directory watcher failed; rebuild the baseline after resolving the watcher failure');
            }
        });
        previous?.watcher.dispose();
        return true;
    }

    private async watchImportedTree(root: string, epoch: number, inheritedAbsence = false): Promise<void> {
        const pending = [root];
        const installed = new Map<string, { current: ImportedDirectoryWatch; previous?: ImportedDirectoryWatch }>();
        try {
            while (pending.length > 0 && this.isCurrentEpoch(epoch)) {
                const directory = pending.pop()!;
                if (this.isPathIgnored(vscode.Uri.file(directory), true)) { continue; }
                // Watch before enumeration so later children cannot fall into the
                // discovery gap. Empty and ignored-file-only directories count too.
                const previous = this.importedDirectoryWatchers.get(directory);
                if (this.watchImportedDirectory(directory, epoch, inheritedAbsence)) {
                    installed.set(directory, { current: this.importedDirectoryWatchers.get(directory)!, previous });
                }
                const entries = await fs.promises.readdir(directory, { withFileTypes: true });
                if (!this.isCurrentEpoch(epoch)) { return; }
                for (const entry of entries) {
                    // Never follow symlink directories outside the validated tree.
                    if (entry.isDirectory() && !entry.isSymbolicLink()) {
                        pending.push(path.join(directory, entry.name));
                    }
                }
            }
        } catch (error) {
            // Keep pre-existing coverage, but do not leak a partial installation
            // on OS quota, configured bound, or directory enumeration failures.
            for (const [directory, entry] of installed) {
                if (this.importedDirectoryWatchers.get(directory) === entry.current) {
                    entry.current.watcher.dispose();
                    if (entry.previous) { this.importedDirectoryWatchers.set(directory, entry.previous); }
                    else { this.importedDirectoryWatchers.delete(directory); }
                }
            }
            throw error;
        }
    }

    private removeImportedDirectoryWatchers(root: string): void {
        for (const [directory, entry] of this.importedDirectoryWatchers) {
            if (this.pathBelongsToRoot(directory, root)) {
                entry.watcher.dispose();
                this.importedDirectoryWatchers.delete(directory);
            }
        }
    }

    private activateExternalWatchers(watchers: vscode.FileSystemWatcher[]): void {
        const previousWatchers = this.fileWatchers;
        this.coverageGeneration++;
        this.fileWatchers = watchers;
        this.externalWatcherEnabled = watchers.length > 0;
        previousWatchers.forEach(watcher => watcher.dispose());
        for (const [directory, previous] of this.importedDirectoryWatchers) {
            try {
                if (!fs.lstatSync(directory).isDirectory()) { this.removeImportedDirectoryWatchers(directory); continue; }
                this.watchImportedDirectory(directory, this.sessionEpoch);
            } catch (error) {
                if (this.isFileNotFound(error)) { this.removeImportedDirectoryWatchers(directory); }
                else { void this.markCreatedDirectoryUnavailable(directory, 'Imported directory watcher could not restart; rebuild after resolving the watcher failure', !previous.provenAbsent, this.sessionEpoch); }
            }
        }
    }

    private reportExternalWatcherFailure(error: any): void {
        const message = error?.code === 'ENOSPC'
            ? 'Code Diff Tracker: File watcher limit reached (ENOSPC). Falling back to open files only.'
            : 'Code Diff Tracker: File watcher failed. Falling back to open files only.';
        vscode.window.showWarningMessage(message);
    }

    private async startExternalWatchers(): Promise<void> {
        const epoch = this.sessionEpoch;
        const folders = this.getSupportedWorkspaceFolders();
        if (!folders || folders.length === 0) {
            this.disposeFileWatchers();
            this.externalWatcherEnabled = false;
            return;
        }

        try {
            await this.refreshIgnoreMatchers();
        } catch (error) {
            console.warn('Failed to build ignore rules for file watcher', error);
        }
        if (!this.isCurrentEpoch(epoch) || !this.isRecording) { return; }

        try {
            this.activateExternalWatchers(this.createExternalWatchers(epoch));
        } catch (error: any) {
            this.externalWatcherEnabled = false;
            this.disposeFileWatchers();
            this.reportExternalWatcherFailure(error);
        }
    }

    private disposeFileWatchers() {
        this.fileWatchers.forEach(w => w.dispose());
        this.fileWatchers = [];
        for (const entry of this.importedDirectoryWatchers.values()) { entry.watcher.dispose(); entry.epoch = -1; }
    }

    private clearExternalChangeTimers(): void {
        this.externalChangeTimers.forEach(timer => clearTimeout(timer));
        this.externalChangeTimers.clear();
    }

    private clearDocumentChangeTimers(): void {
        this.documentChangeTimers.forEach(timer => clearTimeout(timer));
        this.documentChangeTimers.clear();
    }

    private preserveDeferredScopeApplyEvent(filePath: string): void {
        filePath = this.canonicalTrackingPath(filePath);
        const reason = 'File event was observed before monitoring scope application; prior review evidence is preserved until the current state is reconciled';
        if (!this.fileSnapshots.has(filePath) && !this.opaqueBaselineFiles.has(filePath) &&
            !this.unresolvedBaselineFiles.has(filePath)) {
            this.unresolvedBaselineFiles.set(filePath, reason);
        }
        this.setFileCoverageGap(filePath, 'scope-apply-event', reason);
        this.markFileUnavailable(filePath, reason);
    }

    private configuredScopeMonitorsPath(
        scope: CanonicalMonitoringScope,
        uri: vscode.Uri,
        directory = false
    ): boolean {
        if (uri.scheme !== 'file') { return false; }
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (!folder || folder.uri.scheme !== 'file') { return false; }
        const rootIdentity = this.workspaceRootIdentityForFolder(folder);
        if (typeof rootIdentity.caseSensitive !== 'boolean') { return false; }
        const relative = this.toPosixPath(path.relative(folder.uri.fsPath, uri.fsPath)) + (directory ? '/' : '');
        const matcher = this.ignoreMatchers.get(folder.uri.fsPath);
        const ordinaryIgnored = matcher?.ignores(relative) ?? false;
        return evaluateConfiguredScope(scope, rootIdentity, relative, ordinaryIgnored, directory).monitored;
    }

    private preserveRejectedScopePreparationEvent(event: StartupEvent): void {
        const filePath = this.canonicalTrackingPath(event.uri.fsPath);
        let directory = false;
        if (event.kind === 'delete') {
            directory = this.hasHistoricalDirectoryProvenance(filePath);
            if (!directory && !this.fileSnapshots.has(filePath) &&
                !this.opaqueBaselineFiles.has(filePath) && !this.unresolvedBaselineFiles.has(filePath)) {
                // The rejected candidate never committed a file/directory identity.
                // Preserve uncertainty as subtree evidence rather than recreating
                // the historical "Resource is a directory" phantom file review.
                this.setSubtreeCoverageGap(
                    filePath,
                    'scope-preparation-delete-unknown-kind',
                    'A resource disappeared during rejected monitoring-scope preparation; its prior kind and contents are unknown'
                );
                return;
            }
        } else {
            try { directory = fs.lstatSync(filePath).isDirectory(); }
            catch { directory = false; }
        }
        if (directory) {
            this.setSubtreeCoverageGap(
                filePath,
                'scope-preparation-event',
                'A directory changed during rejected monitoring-scope preparation; descendant state requires reconciliation'
            );
            return;
        }

        const reason =
            'A file changed during rejected monitoring-scope preparation before a reliable before-image was committed';
        if (!this.fileSnapshots.has(filePath) && !this.opaqueBaselineFiles.has(filePath)) {
            this.unresolvedBaselineFiles.set(filePath, reason);
        }
        this.setFileCoverageGap(filePath, 'scope-preparation-event', reason);
        this.retainedReviewPaths.add(filePath);
        this.markFileUnavailable(filePath, reason);
    }

    private async drainDeferredScopeApplyEvents(epoch: number): Promise<boolean> {
        const deadline = Date.now() + 5000;
        this.scopeApplyPreflight = true;
        try {
            while (this.isCurrentEpoch(epoch)) {
                const documentPaths = [...this.documentChangeTimers.keys()];
                const externalPaths = [...this.externalChangeTimers.keys()];
                for (const filePath of documentPaths) {
                    const timer = this.documentChangeTimers.get(filePath);
                    if (timer) { clearTimeout(timer); }
                    this.documentChangeTimers.delete(filePath);
                    const uri = vscode.Uri.file(filePath);
                    if (this.pendingScopeExplicitlyExcludes(uri)) {
                        this.preserveDeferredScopeApplyEvent(filePath);
                        continue;
                    }
                    const doc = vscode.workspace.textDocuments.find(value =>
                        value.uri.scheme === 'file' && this.canonicalTrackingPath(value.uri.fsPath) === filePath);
                    if (doc) { this.processDocumentChange(doc); }
                }
                for (const filePath of externalPaths) {
                    const timer = this.externalChangeTimers.get(filePath);
                    if (timer) { clearTimeout(timer); }
                    this.externalChangeTimers.delete(filePath);
                    const uri = vscode.Uri.file(filePath);
                    if (this.pendingScopeExplicitlyExcludes(uri)) {
                        this.preserveDeferredScopeApplyEvent(filePath);
                        continue;
                    }
                    await this.readFileAndUpdate(filePath, uri);
                    if (!this.isCurrentEpoch(epoch)) { return false; }
                }
                if (this.activeExternalOperations.size === 0 && this.activeCreations.size === 0 &&
                    this.externalChangeTimers.size === 0 && this.documentChangeTimers.size === 0) {
                    return true;
                }
                if (Date.now() >= deadline) { return false; }
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            return false;
        } finally {
            this.scopeApplyPreflight = false;
        }
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

    private getSupportedWorkspaceFolders(): vscode.WorkspaceFolder[] {
        // Snapshots and persisted identities currently support file URIs only.
        // Discovery must use the same scope as restoration validation.
        return (vscode.workspace.workspaceFolders ?? [])
            .filter(folder => folder.uri.scheme === 'file');
    }

    private getWorkspaceRoots(): string[] {
        return this.getSupportedWorkspaceFolders()
            .map(folder => path.resolve(folder.uri.fsPath))
            .sort((left, right) => left.localeCompare(right));
    }

    private detectWorkspaceRootCaseSensitivity(rootPath: string): boolean | undefined {
        const key = path.resolve(rootPath);
        const cached = this.workspaceRootCaseSensitivityCache.get(key);
        if (cached !== undefined) { return cached; }
        const detected = detectLocalPathCaseSensitivity(key);
        if (typeof detected === 'boolean') {
            this.workspaceRootCaseSensitivityCache.set(key, detected);
        }
        return detected;
    }

    private workspaceRootIdentitiesForPaths(roots: readonly string[]): WorkspaceRootIdentity[] {
        const current = new Map(this.getSupportedWorkspaceFolders()
            .map(folder => [path.resolve(folder.uri.fsPath), {
                name: folder.name,
                uri: folder.uri.toString(),
                caseSensitive: this.detectWorkspaceRootCaseSensitivity(folder.uri.fsPath)
            }] as const));
        return [...roots]
            .map(root => {
                const normalized = path.resolve(root);
                return current.get(normalized) ?? {
                    name: path.basename(normalized) || normalized,
                    uri: vscode.Uri.file(normalized).toString(),
                    caseSensitive: this.detectWorkspaceRootCaseSensitivity(normalized)
                };
            })
            .sort((left, right) => left.uri.localeCompare(right.uri) || left.name.localeCompare(right.name));
    }

    private workspaceRootIdentityForFolder(folder: vscode.WorkspaceFolder): WorkspaceRootIdentity {
        return {
            name: folder.name,
            uri: folder.uri.toString(),
            caseSensitive: this.detectWorkspaceRootCaseSensitivity(folder.uri.fsPath)
        };
    }

    private currentWorkspaceRootIdentities(): WorkspaceRootIdentity[] {
        return this.workspaceRootIdentitiesForPaths(this.getWorkspaceRoots());
    }

    private sameWorkspaceRootIdentities(left: readonly WorkspaceRootIdentity[], right: readonly WorkspaceRootIdentity[]): boolean {
        if (left.length !== right.length) { return false; }
        const key = (root: WorkspaceRootIdentity) => {
            const caseKey = root.caseSensitive === true ? 'cs' : root.caseSensitive === false ? 'ci' : 'unknown';
            return `${root.name}\0${root.uri}\0${caseKey}`;
        };
        const a = [...left].map(key).sort((x, y) => x.localeCompare(y));
        const b = [...right].map(key).sort((x, y) => x.localeCompare(y));
        return a.every((value, index) => value === b[index]);
    }

    private getPathIdentityIssue(): string | undefined {
        const unresolved = this.currentWorkspaceRootIdentities()
            .filter(root => typeof root.caseSensitive !== 'boolean')
            .map(root => root.name);
        return unresolved.length > 0
            ? `Cannot verify path case-sensitivity for workspace root(s): ${unresolved.join(', ')}`
            : undefined;
    }

    private workspaceRootIdentityKey(root: WorkspaceRootIdentity): string {
        const caseKey = root.caseSensitive === true ? 'cs' : root.caseSensitive === false ? 'ci' : 'unknown';
        return `${root.name}\0${root.uri}\0${caseKey}`;
    }

    private canReconcileRemovedWorkspaceRoots(scope: CanonicalMonitoringScope): boolean {
        if (!this.workspaceContextChanged || this.effectiveMonitoringScope.kind !== 'configured') { return false; }
        if (!this.sameWorkspaceRootIdentities(scope.roots, this.currentWorkspaceRootIdentities())) { return false; }
        const effectiveKeys = new Set(
            this.effectiveMonitoringScope.roots.map(root => this.workspaceRootIdentityKey(root))
        );
        const requestedKeys = scope.roots.map(root => this.workspaceRootIdentityKey(root));
        if (requestedKeys.length >= effectiveKeys.size || !requestedKeys.every(key => effectiveKeys.has(key))) {
            return false;
        }
        return !detectScopeExpansion(this.effectiveMonitoringScope, scope).expands;
    }

    private createLegacyEffectiveScopeForRoots(roots: readonly string[]): EffectiveMonitoringScope {
        return createLegacyEffectiveScope(this.workspaceRootIdentitiesForPaths(roots), this.getLegacyGlobalWatchExcludePatterns());
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

        const effectiveRootUris = new Set(this.effectiveMonitoringScope.roots.map(root => root.uri));
        const hasCommittedLegacyPolicyEvidence = this.effectiveMonitoringScope.kind === 'legacyV3' &&
            [...this.committedLegacyWatchExcludeByRoot.entries()].some(([rootUri, patterns]) =>
                effectiveRootUris.has(rootUri) && patterns.length > 0
            );
        const hasConfiguredScopeEvidence = this.effectiveMonitoringScope.kind === 'configured';

        if (!this.isRecording && !this.baselineBuilding && !this.snapshotInitialized && this.fileSnapshots.size === 0 &&
            this.unresolvedBaselineFiles.size === 0 && this.opaqueBaselineFiles.size === 0 &&
            !hasCommittedLegacyPolicyEvidence && !hasConfiguredScopeEvidence) {
            return undefined;
        }

        return {
            version: 4,
            isRecording: this.isRecording,
            baselineState: this.baselineBuilding || !this.snapshotInitialized ? 'building' : 'ready',
            scanCoverage: this.scanCoverage,
            workspaceRoots: [...this.sessionWorkspaceRoots],
            effectiveMonitoringScope: this.effectiveMonitoringScope,
            retainedReviewPaths: [...this.retainedReviewPaths].sort((left, right) => left.localeCompare(right)),
            coverageGaps: [...this.coverageGaps.entries()].sort(([left], [right]) => left.localeCompare(right)),
            legacyWatchExcludeByRoot: this.effectiveMonitoringScope.kind === 'legacyV3'
                ? [...this.committedLegacyWatchExcludeByRoot.entries()]
                    .filter(([rootUri]) => effectiveRootUris.has(rootUri))
                    .map(([rootUri, patterns]) => [rootUri, [...patterns]] as [string, string[]])
                    .sort(([left], [right]) => left.localeCompare(right))
                : [],
            fileSnapshots: Array.from(this.fileSnapshots.entries())
                .sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath)),
            fileModes: [...this.fileModes].filter(([filePath]) => this.fileSnapshots.has(filePath)),
            baselineExistingFiles: Array.from(this.baselineExistingFiles.values())
                .sort((leftPath, rightPath) => leftPath.localeCompare(rightPath)),
            unresolvedBaselineFiles: Array.from(this.unresolvedBaselineFiles.entries())
                .sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath)),
            opaqueBaselineFiles: Array.from(this.opaqueBaselineFiles.entries())
                .sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath)),
            revertHistory: this.revertHistory.slice(-this.maxRevertHistory),
            gitContexts: [...this.baselineGitContexts.values()]
                .sort((left, right) => left.repoRoot.localeCompare(right.repoRoot))
        };
    }

    private schedulePersistState(): void {
        if (!this.storageUri || this.baselineTransaction) {
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
        this.persistenceFailed = true;
        console.error(message, error);
    }

    private async flushPersistState(
        completedBaseline = false,
        transaction?: BaselineTransaction,
        retainFailureMarker = false
    ): Promise<boolean> {
        const epoch = this.sessionEpoch;
        if (transaction && (this.baselineTransaction !== transaction || !this.isCurrentEpoch(transaction.epoch))) { return false; }
        if (this.baselineTransaction && !transaction) {
            await this.baselineTransaction.done;
            if (epoch !== this.sessionEpoch) { return false; }
            return this.flushPersistState(completedBaseline, undefined, retainFailureMarker);
        }
        // A blocked restore must never erase the evidence during shutdown.
        if (this.recoveryBlocked) { return false; }
        const storageUri = this.storageUri;
        if (!storageUri) {
            return true;
        }

        const state = this.buildPersistedState();
        // Persist the ready candidate while actions remain blocked in memory.
        if (state && completedBaseline) { state.baselineState = 'ready'; }
        let payload: Uint8Array | undefined;
        let limitError: string | undefined;
        if (state) {
            if (state.fileSnapshots.length > this.maxPersistedSnapshots) {
                limitError = `Failed to persist Code Diff Tracker session: snapshot count exceeds ${this.maxPersistedSnapshots}.`;
            }
            if (!limitError && !this.parsePersistedState(state)) {
                limitError = 'Failed to persist Code Diff Tracker session: state does not satisfy recovery schema and limits.';
            }
            payload = new TextEncoder().encode(JSON.stringify(state));
            if (payload.byteLength > this.maxPersistedBytes) {
                limitError = `Failed to persist Code Diff Tracker session: state exceeds ${this.maxPersistedBytes} bytes.`;
            }
        }

        const persistTask = async (): Promise<boolean> => {
            const transactionCurrent = (): boolean => epoch === this.sessionEpoch && (!transaction ||
                (this.baselineTransaction === transaction && this.isCurrentEpoch(transaction.epoch) && (transaction.valid?.() ?? true)));
            if (!transactionCurrent()) { return false; }
            const targetUri = this.getPersistedStateUri();
            const tempUri = this.getPersistedStateUri(this.persistedStateTempFileName);
            const backupUri = this.getPersistedStateUri(this.persistedStateBackupFileName);
            const failureUri = this.getPersistedStateUri(this.persistenceFailureFileName);
            if (!targetUri || !tempUri || !backupUri) { return true; }

            if (!payload) {
                try {
                    await this.deletePersistedFile(targetUri);
                    await this.deletePersistedFile(tempUri);
                    await this.deletePersistedFile(backupUri);
                    if (failureUri) { await this.deletePersistedFile(failureUri); }
                    if (!transactionCurrent()) { return false; }
                    this.persistenceIssue = undefined;
                    this.persistenceFailed = false;
                    return true;
                } catch (error) {
                    if (epoch === this.sessionEpoch) { this.reportPersistenceIssue('Failed to clear Code Diff Tracker persisted session state.', error); }
                    return false;
                }
            }

            try {
                await vscode.workspace.fs.createDirectory(storageUri);
                if (!transactionCurrent()) { return false; }
                // A durable intent survives size-limit failures and interrupted writes.
                if (failureUri) { await vscode.workspace.fs.writeFile(failureUri, new TextEncoder().encode('Session write incomplete')); }
                if (!transactionCurrent()) { return false; }
                if (limitError) { this.reportPersistenceIssue(limitError); return false; }
                await vscode.workspace.fs.writeFile(tempUri, payload);
                if (!transactionCurrent()) { return false; }
                await vscode.workspace.fs.rename(tempUri, targetUri, { overwrite: true });
                if (!transactionCurrent()) { return false; } // Keep the incomplete-write marker.
                await vscode.workspace.fs.copy(targetUri, backupUri, { overwrite: true });
                if (!transactionCurrent()) { return false; }

                // A scope transaction may durably prepare primary + backup before
                // its final context validation. Keep the incomplete-write marker
                // until the caller explicitly commits that prepared publication.
                if (!retainFailureMarker && failureUri) {
                    await this.deletePersistedFile(failureUri);
                }
                if (!transactionCurrent()) {
                    if (!retainFailureMarker && failureUri) {
                        await vscode.workspace.fs.writeFile(
                            failureUri,
                            new TextEncoder().encode('Session write interrupted')
                        );
                    }
                    return false;
                }
                this.persistenceIssue = undefined;
                this.persistenceFailed = false;
                return true;
            } catch (error) {
                try { await this.deletePersistedFile(tempUri); } catch { /* Retain the primary failure. */ }
                if (epoch === this.sessionEpoch) { this.reportPersistenceIssue('Failed to persist Code Diff Tracker session state; the previous valid state was preserved.', error); }
                return false;
            }
        };

        this.persistStateWriteQueue = this.persistStateWriteQueue.then(persistTask, persistTask);
        return this.persistStateWriteQueue;
    }

    private async commitPreparedScopePersistence(transaction: BaselineTransaction): Promise<boolean> {
        const epoch = this.sessionEpoch;
        const storageUri = this.storageUri;
        if (!storageUri) { return true; }
        const failureUri = this.getPersistedStateUri(this.persistenceFailureFileName);
        if (!failureUri) { return true; }

        const commitTask = async (): Promise<boolean> => {
            const transactionCurrent = (): boolean =>
                epoch === this.sessionEpoch &&
                this.baselineTransaction === transaction &&
                this.isCurrentEpoch(transaction.epoch) &&
                (transaction.valid?.() ?? true);
            if (!transactionCurrent()) { return false; }
            try {
                // Marker deletion is the durable commit point. All context
                // validation happens before this operation; after it succeeds,
                // later events are treated as post-commit activity/new requests.
                await this.deletePersistedFile(failureUri);
                this.persistenceIssue = undefined;
                this.persistenceFailed = false;
                return true;
            } catch (error) {
                if (epoch === this.sessionEpoch) {
                    this.reportPersistenceIssue(
                        'Failed to commit prepared monitoring-scope persistence; the uncommitted marker was retained.',
                        error
                    );
                }
                return false;
            }
        };

        this.persistStateWriteQueue = this.persistStateWriteQueue.then(commitTask, commitTask);
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
            reason: `Code Diff Tracker session recovery is blocked: primary ${primary.kind === 'invalid' ? primary.reason : 'is absent'}; last-good ${backup.kind === 'invalid' ? backup.reason : 'is absent'}.`
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
            scanCoverage?: unknown;
            workspaceRoots?: unknown;
            effectiveMonitoringScope?: unknown;
            retainedReviewPaths?: unknown;
            coverageGaps?: unknown;
            legacyWatchExcludeByRoot?: unknown;
            fileSnapshots?: unknown;
            fileModes?: unknown;
            baselineExistingFiles?: unknown;
            unresolvedBaselineFiles?: unknown;
            opaqueBaselineFiles?: unknown;
            revertHistory?: unknown;
            gitContexts?: unknown;
        };

        if ((candidate.version !== 1 && candidate.version !== 2 && candidate.version !== 3 && candidate.version !== 4) ||
            typeof candidate.isRecording !== 'boolean') {
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

        // V1/V2 sessions remain readable, including development V2 states that
        // already contain opaque entries. V3/V4 require the field so corruption
        // cannot silently erase the only before-image for unsupported files.
        const rawOpaque = candidate.version === 1 ? [] : candidate.version === 2
            ? (candidate.opaqueBaselineFiles ?? []) : candidate.opaqueBaselineFiles;
        if (!Array.isArray(rawOpaque) || rawOpaque.length > this.maxPersistedSnapshots) { return undefined; }
        const opaqueBaselineFiles: Array<[string, OpaqueBaselineState]> = [];
        const opaquePaths = new Set<string>();
        for (const entry of rawOpaque) {
            if (!Array.isArray(entry) || entry.length !== 2 || !entry[1] || typeof entry[1] !== 'object') { return undefined; }
            const [filePath, rawState] = entry;
            const value = rawState as Partial<OpaqueBaselineState>;
            if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !isWithinRoot(filePath) ||
                snapshotPaths.has(filePath) || unresolvedPaths.has(filePath) || opaquePaths.has(filePath) ||
                typeof value.reason !== 'string' || !this.isStableUnsupportedBaselineReason(value.reason) ||
                typeof value.size !== 'number' || !Number.isFinite(value.size) || value.size < 0 ||
                typeof value.mtime !== 'number' || !Number.isFinite(value.mtime) ||
                (value.fingerprint !== undefined && (typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint)))) {
                return undefined;
            }
            opaqueBaselineFiles.push([filePath, {
                reason: value.reason,
                size: value.size,
                mtime: value.mtime,
                fingerprint: value.fingerprint
            }]);
            opaquePaths.add(filePath);
        }

        if (candidate.scanCoverage !== undefined &&
            (typeof candidate.scanCoverage !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.scanCoverage))) { return undefined; }
        const baselineState = candidate.version === 1 ? 'ready' : candidate.baselineState;
        if (baselineState !== 'building' && baselineState !== 'ready') { return undefined; }

        const rawHistory = candidate.version === 1 ? [] : candidate.revertHistory;
        const rawModes = candidate.fileModes ?? [];
        if (!Array.isArray(rawModes)) { return undefined; }
        const fileModes: Array<[string, number]> = [];
        const modePaths = new Set<string>();
        for (const entry of rawModes) {
            if (!Array.isArray(entry) || entry.length !== 2 || !snapshotPaths.has(entry[0]) || modePaths.has(entry[0]) ||
                !Number.isInteger(entry[1]) || entry[1] < 0 || entry[1] > 0o777) { return undefined; }
            fileModes.push([entry[0], entry[1]]); modePaths.add(entry[0]);
        }
        const revertHistory = this.parseRevertHistory(rawHistory, snapshotPaths);
        if (!revertHistory) { return undefined; }

        const gitContexts = this.parseGitContexts(candidate.version === 1 ? [] : (candidate.gitContexts ?? []), normalizedRoots);
        if (!gitContexts) { return undefined; }

        const effectiveMonitoringScope = candidate.version === 4
            ? parseEffectiveMonitoringScope(candidate.effectiveMonitoringScope)
            : this.createLegacyEffectiveScopeForRoots(normalizedRoots);
        if (!effectiveMonitoringScope) { return undefined; }

        const parsePathList = (rawList: unknown): string[] | undefined => {
            if (!Array.isArray(rawList) || rawList.length > this.maxPersistedSnapshots) { return undefined; }
            const values: string[] = [];
            const seen = new Set<string>();
            for (const value of rawList) {
                if (typeof value !== 'string' || !path.isAbsolute(value) || !isWithinRoot(value) || seen.has(value)) { return undefined; }
                seen.add(value);
                values.push(value);
            }
            return values;
        };
        const retainedReviewPaths = candidate.version === 4 ? parsePathList(candidate.retainedReviewPaths) : [];
        if (!retainedReviewPaths) { return undefined; }

        const rawLegacyWatchExcludeByRoot = candidate.version === 4
            ? (candidate.legacyWatchExcludeByRoot ?? [])
            : [];
        if (!Array.isArray(rawLegacyWatchExcludeByRoot) ||
            rawLegacyWatchExcludeByRoot.length > this.maxPersistedSnapshots) {
            return undefined;
        }
        const effectiveRootUris = new Set(effectiveMonitoringScope.roots.map(root => root.uri));
        const legacyWatchExcludeByRoot: Array<[string, string[]]> = [];
        const legacyPolicyRoots = new Set<string>();
        for (const entry of rawLegacyWatchExcludeByRoot) {
            if (!Array.isArray(entry) || entry.length !== 2) { return undefined; }
            const [rootUri, rawPatterns] = entry;
            if (typeof rootUri !== 'string' || !effectiveRootUris.has(rootUri) ||
                legacyPolicyRoots.has(rootUri) || !Array.isArray(rawPatterns) ||
                rawPatterns.length > this.maxPersistedSnapshots) {
                return undefined;
            }
            const patterns: string[] = [];
            for (const pattern of rawPatterns) {
                if (typeof pattern !== 'string' || pattern.length > 1000) { return undefined; }
                patterns.push(pattern);
            }
            legacyPolicyRoots.add(rootUri);
            legacyWatchExcludeByRoot.push([rootUri, patterns]);
        }

        const rawCoverageGaps = candidate.version === 4 ? candidate.coverageGaps : [];
        if (!Array.isArray(rawCoverageGaps) || rawCoverageGaps.length > this.maxPersistedSnapshots) { return undefined; }
        const parseCoverageGapEvidence = (rawEvidence: unknown, expectedKind: 'file' | 'subtree'): CoverageGapEvidence | undefined => {
            if (!rawEvidence || typeof rawEvidence !== 'object') { return undefined; }
            const value = rawEvidence as Partial<CoverageGapEvidence>;
            if (value.targetKind !== expectedKind ||
                typeof value.reasonCode !== 'string' || value.reasonCode.length === 0 || value.reasonCode.length > 100 ||
                typeof value.reason !== 'string' || value.reason.length === 0 || value.reason.length > 1000) {
                return undefined;
            }
            return { targetKind: expectedKind, reasonCode: value.reasonCode, reason: value.reason };
        };
        const coverageGaps: Array<[string, CoverageGapRecord]> = [];
        const gapPaths = new Set<string>();
        for (const entry of rawCoverageGaps) {
            if (!Array.isArray(entry) || entry.length !== 2) { return undefined; }
            const [filePath, rawRecord] = entry;
            if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !isWithinRoot(filePath) || gapPaths.has(filePath)) {
                return undefined;
            }
            let record: CoverageGapRecord | undefined;
            if (typeof rawRecord === 'string') {
                if (rawRecord.length === 0 || rawRecord.length > 1000) { return undefined; }
                record = {
                    file: { targetKind: 'file', reasonCode: 'legacy-file-gap', reason: rawRecord }
                };
            } else if (rawRecord && typeof rawRecord === 'object' &&
                ((rawRecord as { targetKind?: unknown }).targetKind === 'file' ||
                    (rawRecord as { targetKind?: unknown }).targetKind === 'subtree')) {
                const targetKind = (rawRecord as { targetKind: 'file' | 'subtree' }).targetKind;
                const evidence = parseCoverageGapEvidence(rawRecord, targetKind);
                if (!evidence) { return undefined; }
                record = targetKind === 'file' ? { file: evidence } : { subtree: evidence };
            } else if (rawRecord && typeof rawRecord === 'object') {
                const rawValue = rawRecord as { file?: unknown; subtree?: unknown };
                const fileEvidence = rawValue.file === undefined ? undefined : parseCoverageGapEvidence(rawValue.file, 'file');
                const subtreeEvidence = rawValue.subtree === undefined ? undefined : parseCoverageGapEvidence(rawValue.subtree, 'subtree');
                if ((rawValue.file !== undefined && !fileEvidence) ||
                    (rawValue.subtree !== undefined && !subtreeEvidence) ||
                    (!fileEvidence && !subtreeEvidence)) {
                    return undefined;
                }
                record = { file: fileEvidence, subtree: subtreeEvidence };
            }
            if (!record) { return undefined; }
            gapPaths.add(filePath);
            coverageGaps.push([filePath, record]);
        }

        return {
            version: 4,
            isRecording: candidate.isRecording,
            migratedFromV1: candidate.version === 1,
            baselineState,
            scanCoverage: candidate.version !== 1 ? candidate.scanCoverage as string | undefined : undefined,
            workspaceRoots: normalizedRoots,
            effectiveMonitoringScope,
            retainedReviewPaths,
            coverageGaps,
            legacyWatchExcludeByRoot,
            fileSnapshots,
            fileModes,
            baselineExistingFiles,
            unresolvedBaselineFiles,
            opaqueBaselineFiles,
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
                    typeof (state as PersistedFileState).exists === 'boolean' && typeof (state as PersistedFileState).content === 'string' &&
                    ((state as PersistedFileState).mode === undefined || (Number.isInteger((state as PersistedFileState).mode) &&
                        (state as PersistedFileState).mode! >= 0 && (state as PersistedFileState).mode! <= 0o777));
                if (typeof item.filePath !== 'string' || !snapshotPaths.has(item.filePath) ||
                    typeof item.baselineRevision !== 'string' || !validState(item.before) || !validState(item.after) ||
                    (item.saveMode !== 'disk' && item.saveMode !== 'buffer')) { return undefined; }
                items.push(item as PersistedRevertItem);
            }
            records.push({ id: value.id, createdAt: value.createdAt, items });
        }
        return records;
    }

    private canonicalTrackingPath(filePath: string, preserveStoredKey = false): string {
        // Already-established keys are stable for the life of their baseline.
        if (!preserveStoredKey && (this.fileSnapshots.has(filePath) || this.opaqueBaselineFiles.has(filePath) ||
            this.unresolvedBaselineFiles.has(filePath))) { return filePath; }
        const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
        if (!folder || folder.uri.scheme !== 'file') { return filePath; }
        const identity = this.workspaceRootIdentityForFolder(folder);
        if (typeof identity.caseSensitive !== 'boolean') { return filePath; }
        const relative = path.relative(folder.uri.fsPath, filePath);
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            return filePath;
        }
        const relativePosix = this.toPosixPath(relative);
        const resolvedIdentity = resolveRelativePathIdentity(folder.uri.fsPath, relativePosix, identity.caseSensitive);
        const key = `${folder.uri.toString()}\0${resolvedIdentity.identity}`;
        const resolvedPath = vscode.Uri.file(path.join(
            folder.uri.fsPath,
            ...resolvedIdentity.resolvedRelativePath.split('/').filter(Boolean)
        )).fsPath;

        if (preserveStoredKey) {
            if (!this.canonicalTrackingPaths.has(key)) {
                this.canonicalTrackingPaths.set(key, resolvedPath);
            }
            return this.canonicalTrackingPaths.get(key)!;
        }
        const known = this.canonicalTrackingPaths.get(key);
        if (known) { return known; }

        // Filesystem entry spelling is the identity oracle. JS Unicode
        // lowercasing is intentionally not used because filesystems such as NTFS
        // can keep entries distinct even when ECMAScript folds their strings.
        const actualFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(resolvedPath));
        if (!actualFolder || actualFolder.uri.toString() !== folder.uri.toString() ||
            this.validateResourceTarget(resolvedPath)) {
            return filePath;
        }
        this.canonicalTrackingPaths.set(key, resolvedPath);
        return resolvedPath;
    }

    private releaseScopeBaselineData(filePath: string): void {
        this.fileSnapshots.delete(filePath);
        this.fileModes.delete(filePath);
        this.baselineExistingFiles.delete(filePath);
        this.unresolvedBaselineFiles.delete(filePath);
        this.opaqueBaselineFiles.delete(filePath);
        this.postBaselineUnknownFiles.delete(filePath);
        this.retainedReviewPaths.delete(filePath);
        this.clearCoverageGap(filePath, 'file', false);
        this.revertHistory = this.revertHistory
            .map(record => ({ ...record, items: record.items.filter(item => item.filePath !== filePath) }))
            .filter(record => record.items.length > 0);
    }

    private releaseRetainedReviewBaseline(filePath: string): void {
        if (!this.retainedReviewPaths.has(filePath) || this.trackedChanges.has(filePath)) { return; }
        this.releaseScopeBaselineData(filePath);
        this.schedulePersistState();
    }

    private pendingScopeExplicitlyExcludes(uri: vscode.Uri, directory = false): boolean {
        const scope = this.pendingMonitoringScope;
        if (!scope || uri.scheme !== 'file') { return false; }
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (!folder || folder.uri.scheme !== 'file') { return false; }
        const relPath = this.toPosixPath(path.relative(folder.uri.fsPath, uri.fsPath)) + (directory ? '/' : '');
        return evaluateConfiguredScope(scope, this.workspaceRootIdentityForFolder(folder), relPath, false, directory).source === 'explicitExclude';
    }

    private setCoverageGap(
        targetPath: string,
        evidence: CoverageGapEvidence,
        schedule = true
    ): void {
        const key = evidence.targetKind === 'file' ? this.canonicalTrackingPath(targetPath) : path.resolve(targetPath);
        const previous = this.coverageGaps.get(key) ?? {};
        const next: CoverageGapRecord = evidence.targetKind === 'file'
            ? { ...previous, file: evidence }
            : { ...previous, subtree: evidence };
        this.coverageGaps.set(key, next);
        if (schedule) { this.schedulePersistState(); }
    }

    private clearCoverageGap(targetPath: string, targetKind: 'file' | 'subtree', schedule = true): boolean {
        const key = targetKind === 'file' ? this.canonicalTrackingPath(targetPath) : path.resolve(targetPath);
        const previous = this.coverageGaps.get(key);
        if (!previous || (targetKind === 'file' ? !previous.file : !previous.subtree)) { return false; }
        const next: CoverageGapRecord = { ...previous };
        if (targetKind === 'file') { delete next.file; } else { delete next.subtree; }
        if (!next.file && !next.subtree) { this.coverageGaps.delete(key); }
        else { this.coverageGaps.set(key, next); }
        if (schedule) { this.schedulePersistState(); }
        if (targetKind === 'subtree') {
            this.emitTrackChangesEvent({ fullRefresh: true });
        }
        return true;
    }

    private setFileCoverageGap(filePath: string, reasonCode: string, reason: string): void {
        this.setCoverageGap(filePath, { targetKind: 'file', reasonCode, reason });
    }

    private setSubtreeCoverageGap(directory: string, reasonCode: string, reason: string): void {
        const key = path.resolve(directory);
        const previous = this.coverageGaps.get(key)?.subtree;
        this.setCoverageGap(directory, { targetKind: 'subtree', reasonCode, reason });
        if (!previous || previous.reasonCode !== reasonCode || previous.reason !== reason) {
            this.emitTrackChangesEvent({ fullRefresh: true });
        }
    }

    private clearSubtreeCoverageGapsUnder(root: string): void {
        let changed = false;
        for (const [targetPath, record] of [...this.coverageGaps]) {
            if (!record.subtree || !this.pathBelongsToRoot(targetPath, root)) { continue; }
            const next: CoverageGapRecord = { ...record };
            delete next.subtree;
            if (!next.file) { this.coverageGaps.delete(targetPath); }
            else { this.coverageGaps.set(targetPath, next); }
            changed = true;
        }
        if (changed) {
            this.schedulePersistState();
            this.emitTrackChangesEvent({ fullRefresh: true });
        }
    }

    private retainCoverageGapReview(filePath: string): boolean {
        const evidence = this.coverageGaps.get(filePath)?.file;
        if (!evidence) { return false; }
        this.markFileUnavailable(filePath, evidence.reason);
        return true;
    }

    private pendingScopeEvidenceKind(record: CoverageGapRecord | undefined): 'file' | 'subtree' | undefined {
        if (record?.subtree?.reasonCode === 'pending-scope-deferred-event' ||
            record?.subtree?.reasonCode === 'pending-scope-deferred-delete') {
            return 'subtree';
        }
        if (record?.file?.reasonCode === 'pending-scope-deferred-event' ||
            record?.file?.reasonCode === 'pending-scope-deferred-delete' ||
            record?.file?.reasonCode === 'pending-explicit-exclusion') {
            return 'file';
        }
        return undefined;
    }

    private restorePendingScopeSuspendedPathsFromCoverageGaps(): void {
        this.pendingScopeSuspendedPaths.clear();
        for (const [targetPath, record] of this.coverageGaps) {
            if (this.pendingScopeEvidenceKind(record)) {
                this.pendingScopeSuspendedPaths.add(targetPath);
            }
        }
    }

    private reconcilePendingScopeSuspendedPaths(): void {
        for (const filePath of [...this.pendingScopeSuspendedPaths]) {
            const record = this.coverageGaps.get(filePath);
            const targetKind = this.pendingScopeEvidenceKind(record) ?? 'file';
            const directory = targetKind === 'subtree';
            const uri = vscode.Uri.file(filePath);
            if (this.pendingScopeExplicitlyExcludes(uri, directory)) { continue; }

            this.pendingScopeSuspendedPaths.delete(filePath);
            if (this.isPathIgnored(uri, directory, true, false)) { continue; }

            const reason = 'Monitoring was paused while an explicit exclusion awaited confirmation; current state requires review';
            if (directory) {
                this.setSubtreeCoverageGap(filePath, 'pending-scope-gap', reason);
                continue;
            }
            this.setFileCoverageGap(filePath, 'pending-scope-gap', reason);
            this.markFileUnavailable(filePath, reason);
        }
    }

    private deferPendingScopeEvent(uri: vscode.Uri, directory = false): boolean {
        let targetIsDirectory = directory;
        if (!targetIsDirectory) {
            try {
                const stat = fs.lstatSync(uri.fsPath);
                targetIsDirectory = stat.isDirectory() && !stat.isSymbolicLink();
            } catch {
                // A missing/racing non-delete path remains conservatively
                // file-level. Delete events use historical subtree provenance
                // through deferPendingScopeDeletion() below.
            }
        }
        if (!this.pendingScopeExplicitlyExcludes(uri, targetIsDirectory)) { return false; }

        this.pendingScopeSuspendedPaths.add(uri.fsPath);
        const reason = 'A resource event was observed while an explicit exclusion awaited confirmation; its baseline was intentionally not read';
        if (targetIsDirectory) {
            this.setSubtreeCoverageGap(uri.fsPath, 'pending-scope-deferred-event', reason);
        } else {
            this.setFileCoverageGap(uri.fsPath, 'pending-scope-deferred-event', reason);
        }
        return true;
    }

    private knownFileEvidenceUnder(root: string): string[] {
        const normalizedRoot = path.resolve(root);
        const values = new Set<string>([
            ...this.fileSnapshots.keys(),
            ...this.unresolvedBaselineFiles.keys(),
            ...this.opaqueBaselineFiles.keys(),
            ...this.trackedChanges.keys()
        ]);
        for (const [targetPath, record] of this.coverageGaps) {
            if (record.file) { values.add(targetPath); }
        }
        return [...values].filter(filePath =>
            path.resolve(filePath) !== normalizedRoot &&
            this.pathBelongsToRoot(filePath, normalizedRoot)
        );
    }

    private hasHistoricalDirectoryProvenance(root: string): boolean {
        const normalizedRoot = path.resolve(root);
        if (this.coverageGaps.get(normalizedRoot)?.subtree) { return true; }
        for (const directory of this.importedDirectoryWatchers.keys()) {
            if (this.pathBelongsToRoot(directory, normalizedRoot)) { return true; }
        }
        return this.knownFileEvidenceUnder(normalizedRoot).length > 0;
    }

    private deferPendingScopeDeletion(uri: vscode.Uri): boolean {
        const directory = this.hasHistoricalDirectoryProvenance(uri.fsPath);
        if (!directory) { return this.deferPendingScopeEvent(uri); }
        if (!this.pendingScopeExplicitlyExcludes(uri, true)) { return false; }

        const root = path.resolve(uri.fsPath);
        const reason =
            'A known directory subtree was deleted while an explicit exclusion awaited confirmation; descendant state requires review';
        this.pendingScopeSuspendedPaths.add(root);
        // A missing directory must never be projected as a file review merely
        // because lstat can no longer classify the deleted path.
        this.clearCoverageGap(root, 'file', false);
        this.setSubtreeCoverageGap(root, 'pending-scope-deferred-delete', reason);

        for (const filePath of this.knownFileEvidenceUnder(root)) {
            this.pendingScopeSuspendedPaths.add(filePath);
            this.setFileCoverageGap(filePath, 'pending-scope-deferred-delete', reason);
            this.markFileUnavailable(filePath, reason);
        }
        this.schedulePersistState();
        return true;
    }

    public setPendingMonitoringScope(scope?: CanonicalMonitoringScope): void {
        this.pendingMonitoringScope = scope
            ? JSON.parse(JSON.stringify(scope)) as CanonicalMonitoringScope
            : undefined;

        // Durable coverage evidence reconstructs same-session suspended paths
        // after reload, so withdrawing the request cannot silently forget events.
        for (const [targetPath, record] of this.coverageGaps) {
            if (this.pendingScopeEvidenceKind(record)) {
                this.pendingScopeSuspendedPaths.add(targetPath);
            }
        }
        this.reconcilePendingScopeSuspendedPaths();

        // Once an explicit exclusion request is pending, all existing baseline
        // evidence it covers must be treated as potentially stale even if the host
        // never delivers a file event during the pause (including across reload).
        if (this.pendingMonitoringScope) {
            const baselinePaths = new Set([
                ...this.fileSnapshots.keys(),
                ...this.unresolvedBaselineFiles.keys(),
                ...this.opaqueBaselineFiles.keys(),
                ...this.trackedChanges.keys()
            ]);
            for (const filePath of baselinePaths) {
                if (!this.pendingScopeExplicitlyExcludes(vscode.Uri.file(filePath))) { continue; }
                this.pendingScopeSuspendedPaths.add(filePath);
                const reason = this.coverageGaps.get(filePath)?.file?.reason ??
                    'Monitoring is paused by a pending explicit exclusion; prior baseline/review state is preserved as unverified';
                this.setFileCoverageGap(filePath, 'pending-explicit-exclusion', reason);
                this.markFileUnavailable(filePath, reason);
            }
        }
    }

    public getExplicitlyExcludedPendingReviewPaths(scope: CanonicalMonitoringScope): string[] {
        const results: string[] = [];
        for (const filePath of this.trackedChanges.keys()) {
            const uri = vscode.Uri.file(filePath);
            const folder = vscode.workspace.getWorkspaceFolder(uri);
            if (!folder || folder.uri.scheme !== 'file') { continue; }
            const relPath = this.toPosixPath(path.relative(folder.uri.fsPath, filePath));
            const decision = evaluateConfiguredScope(scope, this.workspaceRootIdentityForFolder(folder), relPath, false, false);
            if (decision.source === 'explicitExclude') { results.push(filePath); }
        }
        return results.sort((left, right) => left.localeCompare(right));
    }

    public getExplicitlyExcludedReviewRevision(scope: CanonicalMonitoringScope): string {
        const entries = this.getExplicitlyExcludedPendingReviewPaths(scope).map(filePath => [
            filePath,
            { ...this.trackedChanges.get(filePath), timestamp: undefined },
            this.fileSnapshots.get(filePath), this.baselineExistingFiles.has(filePath),
            this.opaqueBaselineFiles.get(filePath), this.unresolvedBaselineFiles.get(filePath),
            this.coverageGaps.get(filePath)?.file
        ]);
        return createHash('sha256').update(JSON.stringify({
            epoch: this.sessionEpoch, scopeRevision: scope.scopeRevision, entries
        })).digest('hex');
    }

    public async preflightConfiguredMonitoringScope(
        scope: CanonicalMonitoringScope,
        requestStillCurrent: () => boolean = () => true
    ): Promise<MonitoringScopePreflightResult> {
        const result: MonitoringScopePreflightResult = {
            status: 'ready',
            scopeRevision: scope.scopeRevision,
            inspectedEntries: 0,
            candidateFiles: 0,
            candidateDirectories: 0,
            skippedSymlinks: 0,
            skippedHardBoundaries: 0,
            skippedExplicitExclusions: 0,
            truncated: false,
            entryLimit: this.maxScopePreflightEntries,
            unreadableDirectoryCount: 0,
            unreadableDirectories: [],
            largestDirectories: []
        };
        const conflict = (reason: string): MonitoringScopePreflightResult => ({
            ...result, status: 'conflict', reason
        });
        if (this.disposed || this.recoveryBlocked || this.baselineTransaction) {
            return conflict('Monitoring scope preflight is blocked by recovery or another baseline transaction.');
        }
        if (!requestStillCurrent()) {
            return conflict('Monitoring scope request changed before preflight started.');
        }
        const identityIssue = this.getPathIdentityIssue();
        if (identityIssue) { return conflict(identityIssue); }
        if (!this.sameWorkspaceRootIdentities(scope.roots, this.currentWorkspaceRootIdentities())) {
            return conflict('Requested scope roots do not match the current local workspace identity.');
        }

        const epoch = this.sessionEpoch;
        const pending = this.getSupportedWorkspaceFolders().map(folder => ({
            folder,
            directory: path.resolve(folder.uri.fsPath)
        }));
        const directorySummaries: MonitoringScopePreflightDirectorySummary[] = [];
        const rememberUnreadable = (folder: vscode.WorkspaceFolder, directory: string, error: unknown): void => {
            result.unreadableDirectoryCount++;
            if (result.unreadableDirectories.length >= this.maxScopePreflightDiagnostics) { return; }
            const relative = this.toPosixPath(path.relative(folder.uri.fsPath, directory)) || '.';
            result.unreadableDirectories.push({
                root: folder.name,
                path: relative,
                reason: error instanceof Error ? error.message : String(error)
            });
        };
        const contextStillCurrent = (): boolean =>
            this.isCurrentEpoch(epoch) && requestStillCurrent() &&
            this.sameWorkspaceRootIdentities(scope.roots, this.currentWorkspaceRootIdentities());

        while (pending.length > 0) {
            if (!contextStillCurrent()) {
                return conflict('Monitoring scope request, session, or workspace identity changed during preflight.');
            }
            const { folder, directory } = pending.pop()!;
            if (!this.workspaceFolderOwnsTraversalPath(folder, directory)) { continue; }
            const rootIdentity = this.workspaceRootIdentityForFolder(folder);
            if (typeof rootIdentity.caseSensitive !== 'boolean') {
                return conflict('Workspace path case-sensitivity could not be verified during preflight.');
            }
            const relativeDirectory = this.toPosixPath(path.relative(folder.uri.fsPath, directory));
            if (!relativeDirectory && configuredScopeExplicitlyExcludesSubtree(scope, rootIdentity, '')) {
                result.skippedExplicitExclusions++;
                continue;
            }
            if (relativeDirectory && isHardUnmonitorableRelativePath(relativeDirectory, rootIdentity, true)) {
                result.skippedHardBoundaries++;
                continue;
            }
            if (relativeDirectory) {
                const directoryMatcher = this.ignoreMatchers.get(folder.uri.fsPath);
                const ordinaryDirectoryIgnored = directoryMatcher?.ignores(relativeDirectory + '/') ?? false;
                const directoryDecision = evaluateConfiguredScope(
                    scope, rootIdentity, relativeDirectory, ordinaryDirectoryIgnored, true
                );
                if (directoryDecision.source === 'explicitExclude') {
                    result.skippedExplicitExclusions++;
                    continue;
                }
                if (directoryDecision.source === 'hardBoundary' || directoryDecision.source === 'identityUnknown') {
                    result.skippedHardBoundaries++;
                    continue;
                }
                if (!directoryDecision.monitored) {
                    continue;
                }
            }

            let directoryEntries = 0;
            try {
                const handle = await fs.promises.opendir(directory);
                for await (const entry of handle) {
                    if (!contextStillCurrent()) {
                        return conflict('Monitoring scope request, session, or workspace identity changed during preflight.');
                    }
                    if (result.inspectedEntries >= this.maxScopePreflightEntries) {
                        result.truncated = true;
                        break;
                    }
                    result.inspectedEntries++;
                    directoryEntries++;

                    const child = path.join(directory, entry.name);
                    const entryKind = this.classifyDirectoryEntry(directory, entry);
                    if (entryKind === 'missing' || entryKind === 'other') { continue; }
                    if (entryKind === 'symlink') {
                        result.skippedSymlinks++;
                        continue;
                    }
                    const isDirectory = entryKind === 'directory';
                    const relative = this.toPosixPath(path.relative(folder.uri.fsPath, child));
                    if (isDirectory && !this.workspaceFolderOwnsTraversalPath(folder, child)) {
                        continue;
                    }
                    if (isHardUnmonitorableRelativePath(relative, rootIdentity, isDirectory)) {
                        result.skippedHardBoundaries++;
                        continue;
                    }
                    const ordinaryMatcher = this.ignoreMatchers.get(folder.uri.fsPath);
                    const ordinaryIgnored = ordinaryMatcher?.ignores(relative + (isDirectory ? '/' : '')) ?? false;
                    const decision = evaluateConfiguredScope(
                        scope, rootIdentity, relative, ordinaryIgnored, isDirectory
                    );
                    if (decision.source === 'explicitExclude') {
                        result.skippedExplicitExclusions++;
                        continue;
                    }
                    if (decision.source === 'hardBoundary' || decision.source === 'identityUnknown') {
                        result.skippedHardBoundaries++;
                        continue;
                    }
                    if (!decision.monitored) {
                        continue;
                    }
                    if (isDirectory) {
                        result.candidateDirectories++;
                        pending.push({ folder, directory: child });
                    } else {
                        result.candidateFiles++;
                    }
                }
            } catch (error) {
                if (!this.isFileNotFound(error)) { rememberUnreadable(folder, directory, error); }
            }

            directorySummaries.push({
                root: folder.name,
                path: relativeDirectory || '.',
                entries: directoryEntries
            });
            if (result.truncated) { break; }
        }

        result.largestDirectories = directorySummaries
            .sort((left, right) => right.entries - left.entries ||
                left.root.localeCompare(right.root) || left.path.localeCompare(right.path))
            .slice(0, this.maxScopePreflightDirectorySummaries);
        return result;
    }

    private async enumerateExplicitIncludeFiles(
        rootPath: string,
        scope: CanonicalMonitoringScope,
        epoch: number
    ): Promise<string[]> {
        const files: string[] = [];
        const pending = [rootPath];
        while (pending.length > 0) {
            if (!this.isCurrentEpoch(epoch)) { return files; }
            const current = pending.pop()!;
            const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(current));
            if (!folder || folder.uri.scheme !== 'file') { continue; }
            const relative = this.toPosixPath(path.relative(folder.uri.fsPath, current));
            const rootIdentity = this.workspaceRootIdentityForFolder(folder);
            if (typeof rootIdentity.caseSensitive !== 'boolean' ||
                isHardUnmonitorableRelativePath(relative, rootIdentity, true)) { continue; }
            const currentDecision = evaluateConfiguredScope(scope, rootIdentity, relative, false, true);
            if (currentDecision.source === 'explicitExclude') { continue; }

            let entries: fs.Dirent[];
            try { entries = await fs.promises.readdir(current, { withFileTypes: true }); }
            catch (error) {
                if (this.isFileNotFound(error)) { continue; }
                throw error;
            }
            if (!this.isCurrentEpoch(epoch)) { return files; }

            for (const entry of entries) {
                if (!this.isCurrentEpoch(epoch)) { return files; }
                const child = path.join(current, entry.name);
                const childRelative = this.toPosixPath(path.relative(folder.uri.fsPath, child));
                if (typeof rootIdentity.caseSensitive !== 'boolean' ||
                    isHardUnmonitorableRelativePath(childRelative, rootIdentity, entry.isDirectory()) ||
                    entry.isSymbolicLink()) { continue; }
                const childDecision = evaluateConfiguredScope(
                    scope, rootIdentity, childRelative, false, entry.isDirectory()
                );
                if (childDecision.source === 'explicitExclude') { continue; }
                if (entry.isDirectory()) {
                    pending.push(child);
                } else if (entry.isFile()) {
                    files.push(child);
                }
            }
        }
        return files;
    }

    private async captureConfiguredIncludeBaselines(scope: CanonicalMonitoringScope, epoch: number): Promise<number> {
        let captured = 0;
        const rootsByName = new Map(this.getSupportedWorkspaceFolders().map(folder => [folder.name, folder] as const));
        const captureFile = async (filePath: string): Promise<void> => {
            filePath = this.canonicalTrackingPath(filePath);
            if (!this.isCurrentEpoch(epoch) || this.hasCapturedBaseline(filePath) ||
                this.unresolvedBaselineFiles.has(filePath) || this.trackedChanges.has(filePath) ||
                this.isPathIgnored(vscode.Uri.file(filePath), false, false)) { return; }
            const targetError = this.isRecording
                ? this.validateSnapshotTarget(filePath)
                : this.validateResourceTarget(filePath);
            if (targetError) { return; }
            const state = await this.readCurrentFileState(filePath);
            if (!this.isCurrentEpoch(epoch)) { return; }
            this.recordScannedBaseline(filePath, state, 'workspace');
            captured++;
        };

        for (const rule of scope.includes) {
            const folders = rule.scope === 'folder'
                ? [rootsByName.get(rule.folder ?? '')].filter((value): value is vscode.WorkspaceFolder => !!value)
                : this.getSupportedWorkspaceFolders();
            for (const folder of folders) {
                if (!this.isCurrentEpoch(epoch)) { return captured; }
                const target = this.canonicalTrackingPath(path.join(folder.uri.fsPath, ...rule.path.split('/')));
                const targetError = this.validateResourceTarget(target);
                if (targetError) { throw new Error(targetError); }
                let stat: fs.Stats | undefined;
                try { stat = fs.lstatSync(target); }
                catch (error) {
                    if (!this.isFileNotFound(error)) { throw error; }
                }
                if (!stat) {
                    if (!this.hasCapturedBaseline(target) && !this.unresolvedBaselineFiles.has(target)) {
                        this.fileSnapshots.set(target, '');
                        this.fileModes.delete(target);
                        this.baselineExistingFiles.delete(target);
                        this.opaqueBaselineFiles.delete(target);
                        captured++;
                    }
                    continue;
                }
                if (stat.isSymbolicLink()) { throw new Error('Explicit include resolves through a symbolic link'); }
                if (stat.isFile()) {
                    await captureFile(target);
                    continue;
                }
                if (!stat.isDirectory()) { continue; }
                const files = await this.enumerateExplicitIncludeFiles(target, scope, epoch);
                if (!this.isCurrentEpoch(epoch)) { return captured; }
                for (const filePath of files) {
                    if (!this.pathBelongsToRoot(filePath, target)) { continue; }
                    await captureFile(filePath);
                }
            }
        }
        return captured;
    }

    private workspaceFolderOwnsTraversalPath(
        folder: vscode.WorkspaceFolder,
        targetPath: string
    ): boolean {
        const resolvedTarget = path.resolve(targetPath);
        let owner: vscode.WorkspaceFolder | undefined;
        let ownerLength = -1;
        for (const candidate of this.getSupportedWorkspaceFolders()) {
            const candidateRoot = path.resolve(candidate.uri.fsPath);
            if (!this.pathBelongsToRoot(resolvedTarget, candidateRoot)) { continue; }
            if (candidateRoot.length > ownerLength) {
                owner = candidate;
                ownerLength = candidateRoot.length;
            }
        }
        return !!owner && path.resolve(owner.uri.fsPath) === path.resolve(folder.uri.fsPath);
    }

    private owningWorkspaceFolderForTraversal(targetPath: string): vscode.WorkspaceFolder | undefined {
        const resolvedTarget = path.resolve(targetPath);
        let owner: vscode.WorkspaceFolder | undefined;
        let ownerLength = -1;
        for (const candidate of this.getSupportedWorkspaceFolders()) {
            const candidateRoot = path.resolve(candidate.uri.fsPath);
            if (!this.pathBelongsToRoot(resolvedTarget, candidateRoot)) { continue; }
            if (candidateRoot.length > ownerLength) {
                owner = candidate;
                ownerLength = candidateRoot.length;
            }
        }
        return owner;
    }

    private classifyDirectoryEntry(
        directory: string,
        entry: fs.Dirent
    ): 'file' | 'directory' | 'symlink' | 'other' | 'missing' {
        if (entry.isSymbolicLink()) { return 'symlink'; }
        if (entry.isDirectory()) { return 'directory'; }
        if (entry.isFile()) { return 'file'; }
        const child = path.join(directory, entry.name);
        try {
            const stat = fs.lstatSync(child);
            if (stat.isSymbolicLink()) { return 'symlink'; }
            if (stat.isDirectory()) { return 'directory'; }
            if (stat.isFile()) { return 'file'; }
            return 'other';
        } catch (error) {
            if (this.isFileNotFound(error)) { return 'missing'; }
            throw error;
        }
    }

    private async enumerateConfiguredCandidateFiles(
        scope: CanonicalMonitoringScope,
        epoch: number,
        scanRoot?: string,
        capacityGuard?: CandidateCapacityGuard,
        preparationBudget: { remainingEntries: number } = { remainingEntries: this.maxScopePreflightEntries },
        preparationStillCurrent: () => boolean = () => this.isCurrentEpoch(epoch)
    ): Promise<string[]> {
        const files: string[] = [];
        const countedCandidates = capacityGuard?.countedCandidates ?? new Set<string>();
        const requestedRoot = scanRoot ? path.resolve(scanRoot) : undefined;
        const pending: Array<{ folder: vscode.WorkspaceFolder; directory: string }> = requestedRoot
            ? (() => {
                const folder = this.owningWorkspaceFolderForTraversal(requestedRoot);
                return folder?.uri.scheme === 'file'
                    ? [{ folder, directory: requestedRoot }]
                    : [];
            })()
            : this.getSupportedWorkspaceFolders().map(folder => ({
                folder,
                directory: path.resolve(folder.uri.fsPath)
            }));
        while (pending.length > 0) {
            if (!this.isCurrentEpoch(epoch)) { return files; }
            if (!preparationStillCurrent()) {
                throw new Error('Monitoring scope preparation was invalidated by concurrent workspace activity');
            }
            const { folder, directory } = pending.pop()!;
            if (!this.workspaceFolderOwnsTraversalPath(folder, directory)) { continue; }
            const rootIdentity = this.workspaceRootIdentityForFolder(folder);
            if (typeof rootIdentity.caseSensitive !== 'boolean') {
                throw new Error('Workspace path case-sensitivity could not be verified during scope preparation');
            }
            const relativeDirectory = this.toPosixPath(path.relative(folder.uri.fsPath, directory));
            if (!relativeDirectory && configuredScopeExplicitlyExcludesSubtree(scope, rootIdentity, '')) {
                continue;
            }
            if (relativeDirectory && (
                isHardUnmonitorableRelativePath(relativeDirectory, rootIdentity, true) ||
                this.isPathIgnored(vscode.Uri.file(directory), true, false, false)
            )) { continue; }

            let handle: fs.Dir | undefined;
            try {
                handle = await fs.promises.opendir(directory);
                if (!this.isCurrentEpoch(epoch)) { return files; }
                if (!preparationStillCurrent()) {
                    throw new Error('Monitoring scope preparation was invalidated by concurrent workspace activity');
                }
                // Keep the traversal streaming, but do not yield between every
                // directory entry. Per-entry async iteration lets watcher events
                // interleave with startup baseline discovery and can turn a
                // pre-existing stopped-session file into scan-time uncertainty.
                // readSync() preserves the earlier readdir scheduling boundary
                // while still avoiding an unbounded Dirent[] allocation.
                while (true) {
                    const entry = handle.readSync();
                    if (!entry) { break; }
                    if (!this.isCurrentEpoch(epoch)) { return files; }
                    if (preparationBudget.remainingEntries <= 0) {
                        throw new Error(
                            `Monitoring scope preparation work budget would exceed ${this.maxScopePreflightEntries} inspected directory entries; add explicit exclusions or narrow the scope before retrying.`
                        );
                    }
                    preparationBudget.remainingEntries--;

                    const entryKind = this.classifyDirectoryEntry(directory, entry);
                    if (entryKind === 'missing' || entryKind === 'other' || entryKind === 'symlink') { continue; }
                    const child = path.join(directory, entry.name);
                    const isDirectory = entryKind === 'directory';
                    if (isDirectory && !this.workspaceFolderOwnsTraversalPath(folder, child)) { continue; }
                    const relative = this.toPosixPath(path.relative(folder.uri.fsPath, child));
                    if (isHardUnmonitorableRelativePath(relative, rootIdentity, isDirectory)) { continue; }
                    if (this.isPathIgnored(vscode.Uri.file(child), isDirectory, false, false)) { continue; }
                    if (isDirectory) {
                        pending.push({ folder, directory: child });
                    } else {
                        const canonical = this.canonicalTrackingPath(child);
                        if (capacityGuard && !capacityGuard.exemptPaths.has(canonical) &&
                            !this.trackedChanges.has(canonical) && !countedCandidates.has(canonical)) {
                            if (capacityGuard.remaining <= 0) {
                                throw new Error(
                                    `Monitoring scope snapshot capacity would exceed ${this.maxPersistedSnapshots} persisted resources; add explicit exclusions before retrying.`
                                );
                            }
                            countedCandidates.add(canonical);
                            capacityGuard.remaining--;
                        }
                        // Capacity accounting uses canonical identity, but discovery
                        // keeps the raw directory-entry path. Downstream callers
                        // already canonicalize at their established boundary.
                        files.push(child);
                    }
                }
            } catch (error) {
                if (this.isFileNotFound(error)) { continue; }
                throw error;
            } finally {
                if (handle) {
                    try { handle.closeSync(); }
                    catch (error) {
                        if (!this.isFileNotFound(error)) { throw error; }
                    }
                }
            }
        }
        return files;
    }

    private remainingCandidatePersistenceSlots(): number {
        return Math.max(0, this.maxPersistedSnapshots - this.fileSnapshots.size) +
            Math.max(0, this.maxPersistedSnapshots - this.unresolvedBaselineFiles.size) +
            Math.max(0, this.maxPersistedSnapshots - this.opaqueBaselineFiles.size);
    }

    private createCandidatePersistenceBudget(projectedScanCoverage = this.scanCoverage): CandidatePersistenceBudget {
        const state = this.buildPersistedState();
        let remainingBytes = Number.POSITIVE_INFINITY;
        let fileModes = [...this.fileModes.keys()].filter(filePath => this.fileSnapshots.has(filePath)).length;
        let baselineExistingFiles = this.baselineExistingFiles.size;
        if (state) {
            // Scope Apply clears scanCoverage during preparation and restores the
            // ready coverage fingerprint immediately before persistence. Reserve
            // those final bytes now so candidate capture cannot fill the payload
            // right up to the limit and defer rejection to final serialization.
            state.scanCoverage = projectedScanCoverage;
            const usedBytes = Buffer.byteLength(JSON.stringify(state), 'utf8');
            if (usedBytes > this.maxPersistedBytes) {
                throw new Error(
                    'Monitoring scope persisted byte capacity already exceeds ' +
                    this.maxPersistedBytes +
                    ' bytes before candidate capture; narrow the scope before retrying.'
                );
            }
            remainingBytes = this.maxPersistedBytes - usedBytes;
            fileModes = state.fileModes.length;
            baselineExistingFiles = state.baselineExistingFiles.length;
        }
        return {
            remainingBytes,
            fileSnapshots: this.fileSnapshots.size,
            fileModes,
            baselineExistingFiles,
            unresolvedBaselineFiles: this.unresolvedBaselineFiles.size,
            opaqueBaselineFiles: this.opaqueBaselineFiles.size
        };
    }

    private planScannedBaseline(
        filePath: string,
        state: CurrentFileState,
        scope: 'workspace' | 'repository'
    ): CandidateBaselinePlan {
        const phase = scope === 'repository' ? 'repository baseline rebuild' : 'baseline scan';
        if (this.hasScanUncertainty(filePath)) {
            return { kind: 'unresolved', reason: 'File changed during ' + phase + '; before-image is unknown' };
        }
        if (state.kind === 'text') {
            return { kind: 'text', content: state.content, mode: state.mode, baselineExists: true };
        }
        if (this.isStableUnsupportedState(state)) {
            return { kind: 'opaque', state };
        }
        return {
            kind: 'unresolved',
            reason: state.kind === 'unavailable'
                ? state.reason
                : 'File disappeared during ' + phase + '; before-image is unknown'
        };
    }

    private serializedArrayAppendBytes(entryCount: number, value: unknown): number {
        const serialized = JSON.stringify(value);
        if (serialized === undefined) {
            throw new Error('Monitoring scope candidate persistence value could not be serialized');
        }
        return Buffer.byteLength(serialized, 'utf8') + (entryCount > 0 ? 1 : 0);
    }

    private consumeCandidatePersistenceBudget(
        filePath: string,
        plan: CandidateBaselinePlan,
        budget: CandidatePersistenceBudget
    ): void {
        filePath = this.canonicalTrackingPath(filePath);
        let addedBytes = 0;
        let nextMode: number | undefined;
        let addsExistingPath = false;

        if (plan.kind === 'text') {
            if (budget.fileSnapshots >= this.maxPersistedSnapshots) {
                throw new Error(
                    'Monitoring scope text snapshot capacity would exceed ' +
                    this.maxPersistedSnapshots +
                    ' entries; add explicit exclusions before retrying.'
                );
            }
            addedBytes += this.serializedArrayAppendBytes(
                budget.fileSnapshots,
                [filePath, plan.content]
            );
            nextMode = plan.mode ?? this.fileModes.get(filePath);
            if (nextMode !== undefined && !this.fileSnapshots.has(filePath)) {
                addedBytes += this.serializedArrayAppendBytes(
                    budget.fileModes,
                    [filePath, nextMode]
                );
            }
            addsExistingPath = plan.baselineExists && !this.baselineExistingFiles.has(filePath);
            if (addsExistingPath) {
                addedBytes += this.serializedArrayAppendBytes(
                    budget.baselineExistingFiles,
                    filePath
                );
            }
        } else if (plan.kind === 'opaque') {
            if (budget.opaqueBaselineFiles >= this.maxPersistedSnapshots) {
                throw new Error(
                    'Monitoring scope opaque snapshot capacity would exceed ' +
                    this.maxPersistedSnapshots +
                    ' entries; add explicit exclusions before retrying.'
                );
            }
            addedBytes += this.serializedArrayAppendBytes(
                budget.opaqueBaselineFiles,
                [filePath, {
                    reason: plan.state.reason,
                    size: plan.state.size,
                    mtime: plan.state.mtime,
                    fingerprint: plan.state.fingerprint
                }]
            );
        } else {
            if (budget.unresolvedBaselineFiles >= this.maxPersistedSnapshots) {
                throw new Error(
                    'Monitoring scope unresolved snapshot capacity would exceed ' +
                    this.maxPersistedSnapshots +
                    ' entries; add explicit exclusions before retrying.'
                );
            }
            addedBytes += this.serializedArrayAppendBytes(
                budget.unresolvedBaselineFiles,
                [filePath, plan.reason]
            );
        }

        if (addedBytes > budget.remainingBytes) {
            throw new Error(
                'Monitoring scope persisted byte capacity would exceed ' +
                this.maxPersistedBytes +
                ' bytes; add explicit exclusions before retrying.'
            );
        }

        budget.remainingBytes -= addedBytes;
        if (plan.kind === 'text') {
            budget.fileSnapshots++;
            if (nextMode !== undefined && !this.fileSnapshots.has(filePath)) { budget.fileModes++; }
            if (addsExistingPath) { budget.baselineExistingFiles++; }
        } else if (plan.kind === 'opaque') {
            budget.opaqueBaselineFiles++;
        } else {
            budget.unresolvedBaselineFiles++;
        }
    }

    private async captureConfiguredExpansionBaselines(
        scope: CanonicalMonitoringScope,
        epoch: number,
        preparationStillCurrent: () => boolean = () => this.isCurrentEpoch(epoch)
    ): Promise<number> {
        let captured = 0;
        const durableResourcePaths = new Set([
            ...this.fileSnapshots.keys(),
            ...this.unresolvedBaselineFiles.keys(),
            ...this.opaqueBaselineFiles.keys()
        ]);
        const capacityExemptPaths = new Set([
            ...durableResourcePaths,
            ...this.trackedChanges.keys()
        ]);
        const projectedScanCoverage =
            !this.isRecording || this.baselineBuilding || !this.snapshotInitialized || this.workspaceContextChanged
                ? undefined
                : this.ignoreFingerprint;
        const persistenceBudget = this.createCandidatePersistenceBudget(projectedScanCoverage);
        const files = await this.enumerateConfiguredCandidateFiles(
            scope,
            epoch,
            undefined,
            {
                remaining: this.remainingCandidatePersistenceSlots(),
                exemptPaths: capacityExemptPaths,
                countedCandidates: new Set<string>()
            },
            { remainingEntries: this.maxScopePreflightEntries },
            preparationStillCurrent
        );
        if (!this.isCurrentEpoch(epoch)) { return captured; }
        if (!preparationStillCurrent()) {
            throw new Error('Monitoring scope preparation was invalidated by concurrent workspace activity');
        }
        const candidatePaths = [...new Set(files.map(filePath => this.canonicalTrackingPath(filePath)))]
            .filter(filePath =>
                !durableResourcePaths.has(filePath) &&
                !this.trackedChanges.has(filePath) &&
                !this.isPathIgnored(vscode.Uri.file(filePath), false, false, false)
            );
        for (let filePath of candidatePaths) {
            if (!this.isCurrentEpoch(epoch)) { return captured; }
            if (!preparationStillCurrent()) {
                throw new Error('Monitoring scope preparation was invalidated by concurrent workspace activity');
            }
            filePath = this.canonicalTrackingPath(filePath);
            if (this.hasCapturedBaseline(filePath) ||
                this.unresolvedBaselineFiles.has(filePath) ||
                this.trackedChanges.has(filePath) ||
                this.isPathIgnored(vscode.Uri.file(filePath), false, false, false)) { continue; }
            const targetError = this.validateSnapshotTarget(filePath);
            if (targetError) { continue; }
            const state = await this.readCurrentFileState(filePath);
            if (!this.isCurrentEpoch(epoch)) { return captured; }
            if (!preparationStillCurrent()) {
                throw new Error('Monitoring scope preparation was invalidated by concurrent workspace activity');
            }
            if (this.hasCapturedBaseline(filePath) ||
                this.unresolvedBaselineFiles.has(filePath) ||
                this.trackedChanges.has(filePath) ||
                this.isPathIgnored(vscode.Uri.file(filePath), false, false, false)) { continue; }
            const plan = this.planScannedBaseline(filePath, state, 'workspace');
            this.consumeCandidatePersistenceBudget(filePath, plan, persistenceBudget);
            this.recordScannedBaseline(filePath, state, 'workspace');
            captured++;
        }
        return captured;
    }

    public async applyConfiguredMonitoringScope(
        scope: CanonicalMonitoringScope,
        discardExplicitlyExcludedReviews = false,
        requestStillCurrent: () => boolean = () => true,
        expectedAffectedReviewRevision?: string
    ): Promise<MonitoringScopeApplyResult> {
        const empty = (status: MonitoringScopeApplyResult['status'], reason?: string): MonitoringScopeApplyResult => ({
            status, reason, retainedReviews: 0, discardedReviews: 0, releasedBaselines: 0, capturedBaselines: 0
        });
        const activeBaselineScan = this.baselineBuilding && this.isRecording;
        if (this.disposed || this.recoveryBlocked || this.baselineTransaction || activeBaselineScan) {
            return empty('conflict',
                activeBaselineScan
                    ? 'Monitoring scope cannot change while a baseline scan is still building.'
                    : 'Monitoring scope cannot change while recovery or another baseline transaction is active.');
        }
        if (!requestStillCurrent()) {
            return empty('conflict', 'Monitoring scope request changed before preparation started.');
        }
        const identityIssue = this.getPathIdentityIssue();
        if (identityIssue) {
            return empty('conflict', identityIssue);
        }
        if (!this.sameWorkspaceRootIdentities(scope.roots, this.currentWorkspaceRootIdentities())) {
            return empty('conflict', 'Requested scope roots do not match the current local workspace identity.');
        }
        const supplementalCoverageIssue = this.configuredScopeNeedsSupplementalCoverage(scope);
        if (supplementalCoverageIssue) {
            return empty('requiresS4',
                `Monitoring scope requires S4-B supplemental observation coverage at ${supplementalCoverageIssue}.`);
        }
        const expansion = this.effectiveMonitoringScope.kind === 'configured'
            ? detectScopeExpansion(this.effectiveMonitoringScope, scope)
            : undefined;
        const needsBroadPreparation = scope.mode === 'wholeWorkspace' ||
            !!expansion?.reasons.some(reason =>
                reason.startsWith('New workspace root:') ||
                reason.startsWith('Explicit exclude removed or changed:') ||
                reason.startsWith('Whole Workspace mode'));
        if (needsBroadPreparation) {
            const preflight = await this.preflightConfiguredMonitoringScope(scope, requestStillCurrent);
            if (preflight.status !== 'ready') {
                return empty(preflight.status === 'conflict' ? 'conflict' : 'failed',
                    preflight.reason ?? 'Monitoring scope bounded preflight failed.');
            }
            if (preflight.unreadableDirectoryCount > 0) {
                return empty('failed',
                    `Monitoring scope preflight could not enumerate ${preflight.unreadableDirectoryCount} director${preflight.unreadableDirectoryCount === 1 ? 'y' : 'ies'}; the previous effective scope remains active.`);
            }
        }
        const rootRemovalReconciliation = this.canReconcileRemovedWorkspaceRoots(scope);
        const preflightEpoch = this.sessionEpoch;
        if (!await this.drainDeferredScopeApplyEvents(preflightEpoch) || !requestStillCurrent()) {
            return empty('conflict', 'Monitoring scope preparation could not drain file events observed under the current effective scope; retry after file activity settles.');
        }
        const approvedDiscardRevision = discardExplicitlyExcludedReviews
            ? expectedAffectedReviewRevision ?? this.getExplicitlyExcludedReviewRevision(scope) : undefined;
        let approvedReviewsDiscarded = false;
        const discardApprovalStillCurrent = (): boolean => !discardExplicitlyExcludedReviews ||
            (approvedReviewsDiscarded
                ? this.getExplicitlyExcludedPendingReviewPaths(scope).length === 0
                : this.getExplicitlyExcludedReviewRevision(scope) === approvedDiscardRevision);
        if (!discardApprovalStillCurrent()) {
            return empty('conflict', 'Affected review changed after discard approval; confirm the current review set again.');
        }

        const epoch = this.sessionEpoch;
        const previous = {
            effectiveMonitoringScope: this.getEffectiveMonitoringScope(),
            retainedReviewPaths: new Set(this.retainedReviewPaths),
            coverageGaps: new Map(this.coverageGaps),
            fileSnapshots: new Map(this.fileSnapshots),
            fileModes: new Map(this.fileModes),
            baselineExistingFiles: new Set(this.baselineExistingFiles),
            unresolvedBaselineFiles: new Map(this.unresolvedBaselineFiles),
            opaqueBaselineFiles: new Map(this.opaqueBaselineFiles),
            postBaselineUnknownFiles: new Set(this.postBaselineUnknownFiles),
            trackedChanges: new Map(this.trackedChanges),
            lineChanges: new Map([...this.lineChanges].map(([key, value]) => [key, [...value]])),
            inlineViews: new Map(this.inlineViews),
            revertHistory: this.revertHistory.map(record => ({
                ...record,
                items: record.items.map(item => ({ ...item, before: { ...item.before }, after: { ...item.after } }))
            })),
            scanCoverage: this.scanCoverage,
            committedLegacyWatchExcludeByRoot: new Map(
                [...this.committedLegacyWatchExcludeByRoot]
                    .map(([rootUri, patterns]) => [rootUri, [...patterns]] as [string, string[]])
            ),
            ignoreMatchers: new Map(this.ignoreMatchers),
            ignoreFingerprint: this.ignoreFingerprint,
            ignoreResultCache: new Map(this.ignoreResultCache)
        };
        const restore = (): void => {
            this.committedScopeDuringApply = undefined;
            this.effectiveMonitoringScope = previous.effectiveMonitoringScope;
            this.retainedReviewPaths = new Set(previous.retainedReviewPaths);
            this.coverageGaps = new Map(previous.coverageGaps);
            this.fileSnapshots = new Map(previous.fileSnapshots);
            this.fileModes = new Map(previous.fileModes);
            this.baselineExistingFiles = new Set(previous.baselineExistingFiles);
            this.unresolvedBaselineFiles = new Map(previous.unresolvedBaselineFiles);
            this.opaqueBaselineFiles = new Map(previous.opaqueBaselineFiles);
            this.postBaselineUnknownFiles = new Set(previous.postBaselineUnknownFiles);
            this.trackedChanges = new Map(previous.trackedChanges);
            this.lineChanges = new Map([...previous.lineChanges].map(([key, value]) => [key, [...value]]));
            this.inlineViews = new Map(previous.inlineViews);
            this.revertHistory = previous.revertHistory;
            this.scanCoverage = previous.scanCoverage;
            this.committedLegacyWatchExcludeByRoot = new Map(
                [...previous.committedLegacyWatchExcludeByRoot]
                    .map(([rootUri, patterns]) => [rootUri, [...patterns]] as [string, string[]])
            );
            // Candidate scope preparation publishes matcher state only inside the
            // transaction. Rollback restores the committed matcher atomically;
            // the best-effort rebuild below may refresh it, but a rebuild failure
            // must never leave candidate exclusions active under a legacy scope.
            this.ignoreMatchers = new Map(previous.ignoreMatchers);
            this.ignoreFingerprint = previous.ignoreFingerprint;
            this.ignoreResultCache = new Map(previous.ignoreResultCache);
            this.resetChangeBlocksCaches();
            this.trackedChangesVersion++;
            this.trackedChangesCacheVersion = -1;
        };

        let transaction: BaselineTransaction;
        try { transaction = this.beginBaselineTransaction(restore); }
        catch { return empty('conflict', 'Another baseline transaction is active.'); }
        transaction.observedEvents = new Map();
        const scopeContextStillCurrent = (): boolean =>
            this.isCurrentEpoch(epoch) &&
            requestStillCurrent() &&
            (!this.workspaceContextChanged || rootRemovalReconciliation) &&
            !this.recoveryBlocked &&
            !this.configuredScopeNeedsSupplementalCoverage(scope) &&
            discardApprovalStillCurrent() &&
            (transaction.observedEvents?.size ?? 0) === 0 &&
            (!this.isRecording || (!this.gitContextPending && this.pausedGitRepositories.size === 0));
        transaction.valid = scopeContextStillCurrent;
        if (!scopeContextStillCurrent()) {
            this.endBaselineTransaction(transaction, false);
            return empty('conflict', 'Monitoring scope preparation is blocked by the current workspace or Git context.');
        }
        const result = empty('failed');
        let committed = false;
        let requiresS4Reason: string | undefined;
        this.committedScopeDuringApply = previous.effectiveMonitoringScope;
        try {
            this.effectiveMonitoringScope = { kind: 'configured', ...(JSON.parse(JSON.stringify(scope)) as CanonicalMonitoringScope) };
            // Protect all pending reviews from matcher pruning until each path is
            // classified against the candidate scope.
            for (const filePath of this.trackedChanges.keys()) { this.retainedReviewPaths.add(filePath); }
            this.scanCoverage = undefined;
            this.ignoreResultCache.clear();
            await this.refreshIgnoreMatchers();
            if (!scopeContextStillCurrent()) {
                throw new Error('Monitoring scope or workspace context changed during preparation');
            }

            const explicitlyExcludedReviews = new Set(this.getExplicitlyExcludedPendingReviewPaths(scope));
            for (const filePath of [...this.trackedChanges.keys()]) {
                const ignored = this.isPathIgnored(vscode.Uri.file(filePath), false, false);
                if (!ignored) {
                    this.retainedReviewPaths.delete(filePath);
                    continue;
                }
                const explicitlyExcluded = explicitlyExcludedReviews.has(filePath);
                if (explicitlyExcluded && discardExplicitlyExcludedReviews) {
                    this.clearFileReview(filePath);
                    this.releaseScopeBaselineData(filePath);
                    result.discardedReviews++;
                } else {
                    this.retainedReviewPaths.add(filePath);
                    result.retainedReviews++;
                }
            }

            // Only this synchronous discard step may consume the approved set.
            // Later excluded reviews invalidate publication rather than sharing
            // the earlier user's approval.
            approvedReviewsDiscarded = discardExplicitlyExcludedReviews;

            const baselinePaths = new Set([
                ...this.fileSnapshots.keys(),
                ...this.unresolvedBaselineFiles.keys(),
                ...this.opaqueBaselineFiles.keys()
            ]);
            for (const filePath of baselinePaths) {
                if (this.trackedChanges.has(filePath) || this.retainedReviewPaths.has(filePath)) { continue; }
                if (this.isPathIgnored(vscode.Uri.file(filePath), false, false)) {
                    this.releaseScopeBaselineData(filePath);
                    result.releasedBaselines++;
                }
            }

            // Apply is not Start: stopped sessions must not acquire new
            // before-images or enumerate newly included resource contents.
            result.capturedBaselines = this.isRecording
                ? needsBroadPreparation
                    ? await this.captureConfiguredExpansionBaselines(scope, epoch, scopeContextStillCurrent)
                    : await this.captureConfiguredIncludeBaselines(scope, epoch)
                : 0;
            const lateSupplementalCoverageIssue = this.configuredScopeNeedsSupplementalCoverage(scope);
            if (lateSupplementalCoverageIssue) {
                requiresS4Reason =
                    `Monitoring scope now requires S4-B supplemental observation coverage at ${lateSupplementalCoverageIssue}.`;
                throw new Error(requiresS4Reason);
            }
            if (!scopeContextStillCurrent()) {
                throw new Error('Monitoring scope or workspace context changed during preparation');
            }
            this.scanCoverage = !this.isRecording || this.baselineBuilding || !this.snapshotInitialized || this.workspaceContextChanged
                ? undefined
                : this.ignoreFingerprint;
            if (!await this.flushPersistState(false, transaction, true)) {
                throw new Error('Configured monitoring scope could not be prepared durably');
            }
            if (!scopeContextStillCurrent()) {
                throw new Error('Monitoring scope or workspace context changed after durable preparation');
            }
            if (!await this.commitPreparedScopePersistence(transaction)) {
                throw new Error('Configured monitoring scope could not cross the durable commit barrier');
            }
            committed = true;
            this.committedScopeDuringApply = undefined;
            this.endBaselineTransaction(transaction, true);
            result.status = 'applied';
            result.reason = undefined;
            this.emitTrackChangesEvent({ fullRefresh: true, baselineChanged: true });
            return result;
        } catch (error) {
            const observed = new Map(transaction.observedEvents ?? []);
            this.endBaselineTransaction(transaction, false);
            try { await this.refreshIgnoreMatchers(); } catch { /* retain previous memory and report failure below */ }
            for (const event of observed.values()) {
                if (!this.isCurrentEpoch(epoch)) { break; }
                let directory = false;
                if (event.kind !== 'delete') {
                    try { directory = fs.lstatSync(event.uri.fsPath).isDirectory(); } catch { directory = false; }
                } else {
                    directory = this.hasHistoricalDirectoryProvenance(event.uri.fsPath);
                }
                const candidateMonitored = this.configuredScopeMonitorsPath(scope, event.uri, directory);
                const ignoredByRestoredScope = this.isPathIgnored(event.uri, directory, false, false);
                if (candidateMonitored && ignoredByRestoredScope) {
                    this.preserveRejectedScopePreparationEvent(event);
                    continue;
                }
                if (event.kind === 'delete') { await this.onExternalFileDeleted(event.uri); }
                else if (event.kind === 'create' || event.firstKind === 'create') { await this.onExternalFileCreated(event.uri); }
                else { this.pendingExternalChanges.add(event.uri.fsPath); }
            }
            await this.processPendingExternalChanges();
            const rollbackPersisted = await this.flushPendingPersistence();
            if (!rollbackPersisted) {
                const wasRecording = this.isRecording;
                this.recoveryBlocked = true;
                this.isRecording = false;
                this.disposeFileWatchers();
                this.persistenceFailed = true;
                this.persistenceIssue =
                    'Monitoring scope rollback could not be persisted; recovery is blocked because durable storage may still contain the rejected candidate scope.';
                if (wasRecording) { this._onDidChangeRecordingState.fire(false); }
                this.emitTrackChangesEvent({ fullRefresh: true, baselineChanged: true });
                result.status = 'failed';
                result.reason = this.persistenceIssue;
                return result;
            }
            result.status = requiresS4Reason ? 'requiresS4' : 'failed';
            result.reason = requiresS4Reason ??
                (error instanceof Error ? error.message : 'Monitoring scope preparation failed');
            return result;
        } finally {
            if (!committed && this.baselineTransaction === transaction) { this.endBaselineTransaction(transaction, false); }
        }
    }

    public getEffectiveMonitoringScope(): EffectiveMonitoringScope {
        return JSON.parse(JSON.stringify(this.committedScopeDuringApply ?? this.effectiveMonitoringScope)) as EffectiveMonitoringScope;
    }

    public getCommittedLegacyCompatibilityPolicy(): Array<[string, string[]]> {
        const effective = this.committedScopeDuringApply ?? this.effectiveMonitoringScope;
        if (effective.kind !== 'legacyV3') { return []; }
        const rootUris = new Set(effective.roots.map(root => root.uri));
        return [...this.committedLegacyWatchExcludeByRoot.entries()]
            .filter(([rootUri]) => rootUris.has(rootUri))
            .map(([rootUri, patterns]) => [rootUri, [...patterns]] as [string, string[]])
            .sort(([left], [right]) => left.localeCompare(right));
    }

    public getRetainedReviewPaths(): string[] {
        return [...this.retainedReviewPaths].sort((left, right) => left.localeCompare(right));
    }

    private isDormantPendingScopeGap(targetPath: string, evidence: CoverageGapEvidence): boolean {
        if (!evidence.reasonCode.startsWith('pending-scope-') &&
            evidence.reasonCode !== 'pending-explicit-exclusion') { return false; }
        // Retained file review is still actionable evidence even outside scope.
        if (evidence.targetKind === 'file' && this.trackedChanges.has(targetPath)) { return false; }
        const scope = this.committedScopeDuringApply ?? this.effectiveMonitoringScope;
        if (scope.kind !== 'configured') { return false; }
        const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(targetPath));
        if (!folder || folder.uri.scheme !== 'file') { return false; }
        const relative = this.toPosixPath(path.relative(folder.uri.fsPath, targetPath));
        return evaluateConfiguredScope(scope, this.workspaceRootIdentityForFolder(folder), relative,
            false, evidence.targetKind === 'subtree').source === 'explicitExclude';
    }

    public getCoverageGaps(): Array<[string, string]> {
        const result: Array<[string, string]> = [];
        for (const [targetPath, record] of this.coverageGaps) {
            if (record.file && !this.isDormantPendingScopeGap(targetPath, record.file)) { result.push([targetPath, record.file.reason]); }
            if (record.subtree && !this.isDormantPendingScopeGap(targetPath, record.subtree)) { result.push([targetPath, record.subtree.reason]); }
        }
        return result.sort(([leftPath, leftReason], [rightPath, rightReason]) =>
            leftPath.localeCompare(rightPath) || leftReason.localeCompare(rightReason)
        );
    }

    public getSubtreeCoverageGaps(): SubtreeCoverageDiagnostic[] {
        const result: SubtreeCoverageDiagnostic[] = [];
        for (const [targetPath, record] of this.coverageGaps) {
            if (!record.subtree || this.isDormantPendingScopeGap(targetPath, record.subtree)) { continue; }
            result.push({
                targetPath,
                reasonCode: record.subtree.reasonCode,
                reason: record.subtree.reason
            });
        }
        return result.sort((left, right) =>
            left.targetPath.localeCompare(right.targetPath) ||
            left.reasonCode.localeCompare(right.reasonCode) ||
            left.reason.localeCompare(right.reason)
        );
    }

    public getPolicyFingerprint(): string | undefined { return this.ignoreFingerprint; }

    public getCoverageGeneration(): number { return this.coverageGeneration; }

    public getPersistenceIssue(): string | undefined { return this.persistenceIssue; }

    public isRecoveryBlocked(): boolean { return this.recoveryBlocked; }

    public async discardRecoveryState(): Promise<boolean> {
        if (!this.storageUri) {
            this.recoveryBlocked = false;
            this.persistenceIssue = undefined;
            return true;
        }
        try {
            for (const name of [this.persistedStateFileName, this.persistedStateTempFileName, this.persistedStateBackupFileName, this.persistenceFailureFileName]) {
                const uri = this.getPersistedStateUri(name);
                if (uri) { await this.deletePersistedFile(uri); }
            }
            this.recoveryBlocked = false;
            this.persistenceFailed = false;
            this.persistenceIssue = undefined;
            return true;
        } catch (error) {
            this.reportPersistenceIssue('Failed to discard the unreadable Code Diff Tracker session.', error);
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
        if (this.isRecording && !this.activeWriteFiles.has(this.canonicalTrackingPath(doc.uri.fsPath))) {
            this.processDocumentChange(doc);
        }
        if (!this.activeWriteFiles.has(this.canonicalTrackingPath(doc.uri.fsPath)) && this.pendingWriteFiles.delete(this.canonicalTrackingPath(doc.uri.fsPath))) {
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
        let latest = this.loadIgnoreMatchers(++this.ignoreRefreshVersion);
        this.ignoreRefreshPromise = latest;
        while (true) {
            await latest;
            if (latest === this.ignoreRefreshPromise) { return; }
            latest = this.ignoreRefreshPromise;
        }
    }

    private async loadIgnoreMatchers(version: number): Promise<void> {
        const epoch = this.sessionEpoch;
        const matchers = new Map<string, Ignore>();
        // Matching semantics are part of scan provenance: older implementations
        // may have excluded a different set even with identical rule text.
        const evidence: string[] = ['ignore-semantics-v2'];
        const previousMatchers = this.ignoreMatchers;
        const currentRootUris = new Set(this.getSupportedWorkspaceFolders().map(folder => folder.uri.toString()));
        const nextLegacyPolicy = this.effectiveMonitoringScope.kind === 'legacyV3'
            ? new Map([...this.committedLegacyWatchExcludeByRoot]
                .filter(([rootUri]) => currentRootUris.has(rootUri))
                .map(([rootUri, patterns]) => [rootUri, [...patterns]] as [string, string[]]))
            : new Map<string, string[]>();
        for (const folder of this.getSupportedWorkspaceFolders()) {
            const matcher = await this.buildIgnoreMatcher(folder, evidence, nextLegacyPolicy);
            if (!this.isCurrentEpoch(epoch) || version !== this.ignoreRefreshVersion) { return; }
            matchers.set(folder.uri.fsPath, matcher);
        }
        if (!this.isCurrentEpoch(epoch) || version !== this.ignoreRefreshVersion) { return; }
        const legacyPolicyChanged = !this.sameLegacyWatchExcludePolicy(
            this.committedLegacyWatchExcludeByRoot,
            nextLegacyPolicy
        );
        this.committedLegacyWatchExcludeByRoot = nextLegacyPolicy;
        if (legacyPolicyChanged) { this.schedulePersistState(); }
        const fingerprint = createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
        const changed = fingerprint !== this.ignoreFingerprint;
        this.ignoreFingerprint = fingerprint;
        if (this.scanCoverage && this.scanCoverage !== fingerprint) {
            this.scanCoverage = undefined;
            this.schedulePersistState();
        }
        this.ignoreMatchers = matchers;
        this.ignoreResultCache.clear();
        this.pruneIgnoredImportedDirectoryWatchers();
        await this.resumeImportedDirectoryWatchers(epoch, version);
        if (!this.isCurrentEpoch(epoch) || version !== this.ignoreRefreshVersion) { return; }
        this.pruneIgnoredTrackedChanges();
        // Identity can recover without any rule text/fingerprint changing.
        // Reconcile only already-retained review resources, never discover new
        // paths or bypass pending explicit exclusions and hard boundaries.
        if (!this.baselineTransaction && this.restoringEpoch === undefined &&
            !this.baselineBuilding && this.snapshotInitialized) {
            for (const change of [...this.trackedChanges.values()]) {
                if (change.unavailableReason !== this.rootIdentityUnavailableReason) { continue; }
                const uri = vscode.Uri.file(change.filePath);
                if (this.isPathIgnored(uri)) { continue; }
                await this.readFileAndUpdate(change.filePath, uri);
                if (!this.isCurrentEpoch(epoch) || version !== this.ignoreRefreshVersion) { return; }
            }
        }
        if (!this.isRecording || (!changed && this.pendingImportedDirectoryReconciliation.size === 0) || previousMatchers.size === 0 ||
            this.restoringEpoch !== undefined || this.baselineBuilding || !this.snapshotInitialized) { return; }
        const restored = [...this.pendingImportedDirectoryReconciliation];
        const restoredMarkers = new Set(restored.filter(directory =>
            this.isImportedDirectoryCoverageGap(this.coverageGaps.get(path.resolve(directory)))
        ));
        try {
            // A same-fingerprint retry must reconcile the gap too. Retain this
            // obligation if discovery fails, even though OS watches now exist.
            await this.discoverRestoredFiles(epoch);
            for (const filePath of [...this.fileSnapshots.keys(), ...this.unresolvedBaselineFiles.keys(), ...this.opaqueBaselineFiles.keys()]) {
                if (!this.isCurrentEpoch(epoch) || version !== this.ignoreRefreshVersion) { return; }
                if (restoredMarkers.has(filePath)) { continue; }
                const uri = vscode.Uri.file(filePath);
                if (!this.isPathIgnored(uri)) { await this.readFileAndUpdate(filePath, uri); }
            }
        } catch (error) {
            if (!this.isCurrentEpoch(epoch) || version !== this.ignoreRefreshVersion) { return; }
            for (const directory of restored) {
                if (!this.isCurrentEpoch(epoch) || version !== this.ignoreRefreshVersion) { return; }
                const entry = this.importedDirectoryWatchers.get(directory);
                await this.markCreatedDirectoryUnavailable(directory, 'Restored directory coverage could not be reconciled; refresh or rebuild after resolving the scan failure', !entry?.provenAbsent, epoch, version);
            }
            if (this.isCurrentEpoch(epoch) && version === this.ignoreRefreshVersion) { throw error; }
            return;
        }
        if (!this.isCurrentEpoch(epoch) || version !== this.ignoreRefreshVersion) { return; }
        this.reconcileImportedDirectoryCoverageAfterSuccessfulScan(epoch, restored);
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

    private async findScopeFilesUnderDirectory(
        rootPath: string,
        wholeWorkspacePreparationBudget?: { remainingEntries: number },
        wholeWorkspaceCapacityGuard?: CandidateCapacityGuard
    ): Promise<vscode.Uri[]> {
        const candidates = new Map<string, vscode.Uri>();
        const normalizedRootPath = path.resolve(rootPath);
        const workspaceRoot = this.getSupportedWorkspaceFolders()
            .find(folder => path.resolve(folder.uri.fsPath) === normalizedRootPath);
        const patternBase: vscode.WorkspaceFolder | string = workspaceRoot ?? rootPath;
        const add = (uris: readonly vscode.Uri[]): void => {
            for (const uri of uris) {
                if (uri.scheme !== 'file' || !this.pathBelongsToRoot(uri.fsPath, rootPath)) { continue; }
                const folder = vscode.workspace.getWorkspaceFolder(uri);
                if (!folder || folder.uri.scheme !== 'file') { continue; }
                const relative = this.toPosixPath(path.relative(folder.uri.fsPath, uri.fsPath));
                const identity = this.workspaceRootIdentityForFolder(folder);
                if (typeof identity.caseSensitive !== 'boolean') { continue; }
                if (!isHardUnmonitorableRelativePath(relative, identity)) { const canonical = this.canonicalTrackingPath(uri.fsPath); candidates.set(canonical, vscode.Uri.file(canonical)); }
            }
        };

        const wholeWorkspaceDiscovery = this.effectiveMonitoringScope.kind === 'configured' &&
            this.effectiveMonitoringScope.mode === 'wholeWorkspace';
        if (wholeWorkspaceDiscovery) {
            // VS Code findFiles/search indexing can lag resources created while
            // recording is stopped and can inherit host search exclusions. Whole
            // Workspace rebuilds therefore use the same direct filesystem scope
            // enumeration as transactional expansion preparation.
            const localCapacityGuard = wholeWorkspaceCapacityGuard ?? (() => {
                const durableResourcePaths = new Set([
                    ...this.fileSnapshots.keys(),
                    ...this.unresolvedBaselineFiles.keys(),
                    ...this.opaqueBaselineFiles.keys()
                ]);
                return {
                    remaining: this.remainingCandidatePersistenceSlots(),
                    exemptPaths: new Set([
                        ...durableResourcePaths,
                        ...this.trackedChanges.keys()
                    ]),
                    countedCandidates: new Set<string>()
                } satisfies CandidateCapacityGuard;
            })();
            const files = await this.enumerateConfiguredCandidateFiles(
                this.effectiveMonitoringScope as CanonicalMonitoringScope,
                this.sessionEpoch,
                rootPath,
                localCapacityGuard,
                wholeWorkspacePreparationBudget ?? { remainingEntries: this.maxScopePreflightEntries }
            );
            add(files.map(filePath => vscode.Uri.file(filePath)));
            return [...candidates.values()];
        } else {
            add(await vscode.workspace.findFiles(
                new vscode.RelativePattern(patternBase, '**/*'),
                new vscode.RelativePattern(patternBase,
                    '**/{node_modules,.git,out,dist,build,coverage,tmp,.difftracker-restore-*}/**')
            ));
        }

        if (this.effectiveMonitoringScope.kind === 'configured') {
            const foldersByName = new Map(this.getSupportedWorkspaceFolders().map(folder => [folder.name, folder] as const));
            for (const rule of this.effectiveMonitoringScope.includes) {
                const folders = rule.scope === 'folder'
                    ? [foldersByName.get(rule.folder ?? '')].filter((value): value is vscode.WorkspaceFolder => !!value)
                    : this.getSupportedWorkspaceFolders();
                for (const folder of folders) {
                    const target = this.canonicalTrackingPath(path.join(folder.uri.fsPath, ...rule.path.split('/')));
                    const rootInsideTarget = this.pathBelongsToRoot(rootPath, target);
                    const targetInsideRoot = this.pathBelongsToRoot(target, rootPath);
                    if (!rootInsideTarget && !targetInsideRoot) { continue; }
                    const scanRoot = rootInsideTarget ? rootPath : target;
                    let stat: fs.Stats | undefined;
                    try { stat = fs.lstatSync(scanRoot); }
                    catch (error) { if (!this.isFileNotFound(error)) { throw error; } }
                    if (!stat) { continue; }
                    if (stat.isSymbolicLink()) { continue; }
                    if (stat.isFile()) {
                        add([vscode.Uri.file(scanRoot)]);
                        continue;
                    }
                    if (!stat.isDirectory()) { continue; }
                    add(await vscode.workspace.findFiles(
                        new vscode.RelativePattern(scanRoot, '**/*'),
                        new vscode.RelativePattern(scanRoot, '**/{.git,.difftracker-restore-*}/**')
                    ));
                }
            }
        }
        return [...candidates.values()];
    }

    private getVsCodeWatcherExcludePatterns(resource: vscode.Uri): string[] {
        const config = vscode.workspace.getConfiguration(undefined, resource);
        const raw = config.get<Record<string, boolean>>('files.watcherExclude', {});
        return Object.entries(raw)
            .filter(([, enabled]) => enabled)
            .map(([pattern]) => pattern);
    }

    private expandSimpleBraceGlob(pattern: string): string[] {
        const match = pattern.match(/\{([^{}]+)\}/);
        if (!match) { return [pattern]; }
        const alternatives = match[1].split(',').map(value => value.trim()).filter(Boolean);
        if (alternatives.length === 0) { return [pattern]; }
        return alternatives.flatMap(value =>
            this.expandSimpleBraceGlob(pattern.slice(0, match.index!) + value + pattern.slice(match.index! + match[0].length)));
    }

    private watcherPatternOnlyTargetsHardBoundary(pattern: string): boolean {
        const segments = pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').split('/');
        // An exact .git path segment is unmonitorable regardless of whether the
        // leaf is a file or directory. Restore-prefixed names are different:
        // only restore-prefixed directories are hard boundaries, while an
        // ordinary file such as ".difftracker-restore-notes" is monitorable.
        return segments.some(segment => segment === '.git');
    }

    private watcherGlobSegmentMatches(patternSegment: string, value: string, caseSensitive: boolean): boolean {
        let source = '^';
        for (let index = 0; index < patternSegment.length; index++) {
            const char = patternSegment[index];
            if (char === '*') {
                source += '.*';
            } else if (char === '?') {
                source += '.';
            } else if (char === '[') {
                const close = patternSegment.indexOf(']', index + 1);
                if (close > index + 1) {
                    // One-character wildcard is conservative for intersection
                    // proof and avoids trusting arbitrary character-class syntax.
                    source += '.';
                    index = close;
                } else {
                    source += '\\[';
                }
            } else {
                source += '\\^$.*+?(){}|[]'.includes(char) ? `\\${char}` : char;
            }
        }
        try {
            return new RegExp(source + '$', caseSensitive ? '' : 'i').test(value);
        } catch {
            return true;
        }
    }

    private watcherPatternMatchesPath(
        pattern: string,
        relativePath: string,
        caseSensitive: boolean
    ): boolean {
        const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/$/, '');
        const target = relativePath.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/$/, '');
        const patternSegments = normalized.split('/').filter(Boolean);
        const targetSegments = target.split('/').filter(Boolean);
        if (patternSegments.length === 0) { return false; }

        const memo = new Map<string, boolean>();
        const visit = (patternIndex: number, targetIndex: number): boolean => {
            const key = `${patternIndex}:${targetIndex}`;
            const cached = memo.get(key);
            if (cached !== undefined) { return cached; }

            let result: boolean;
            if (patternIndex === patternSegments.length) {
                result = targetIndex === targetSegments.length;
            } else if (patternSegments[patternIndex] === '**') {
                result = patternIndex === patternSegments.length - 1
                    ? targetIndex < targetSegments.length
                    : visit(patternIndex + 1, targetIndex) ||
                        (targetIndex < targetSegments.length && visit(patternIndex, targetIndex + 1));
            } else if (targetIndex === targetSegments.length) {
                result = false;
            } else {
                result = this.watcherGlobSegmentMatches(
                    patternSegments[patternIndex],
                    targetSegments[targetIndex],
                    caseSensitive
                ) && visit(patternIndex + 1, targetIndex + 1);
            }
            memo.set(key, result);
            return result;
        };
        return visit(0, 0);
    }

    private watcherPatternMayMatchWithinInclude(
        pattern: string,
        includePath: string,
        caseSensitive: boolean
    ): boolean {
        if (this.watcherPatternOnlyTargetsHardBoundary(pattern)) { return false; }
        const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/$/, '');
        const include = includePath.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/$/, '');
        const patternSegments = normalized.split('/').filter(Boolean);
        const includeSegments = include.split('/').filter(Boolean);
        if (patternSegments.length === 0) { return false; }

        const memo = new Map<string, boolean>();
        const visit = (patternIndex: number, includeIndex: number): boolean => {
            const key = `${patternIndex}:${includeIndex}`;
            const cached = memo.get(key);
            if (cached !== undefined) { return cached; }

            let result: boolean;
            if (includeIndex === includeSegments.length) {
                // The fixed include prefix is consumed. Any remaining valid glob
                // can choose a descendant witness, so disjointness is unproven.
                result = true;
            } else if (patternIndex === patternSegments.length) {
                result = false;
            } else if (patternSegments[patternIndex] === '**') {
                result = visit(patternIndex + 1, includeIndex) || visit(patternIndex, includeIndex + 1);
            } else {
                result = this.watcherGlobSegmentMatches(
                    patternSegments[patternIndex],
                    includeSegments[includeIndex],
                    caseSensitive
                ) && visit(patternIndex + 1, includeIndex + 1);
            }
            memo.set(key, result);
            return result;
        };
        return visit(0, 0);
    }

    private explicitIncludeNeedsSupplementalCoverage(scope: CanonicalMonitoringScope): string | undefined {
        const foldersByName = new Map(this.getSupportedWorkspaceFolders().map(folder => [folder.name, folder] as const));
        for (const rule of scope.includes) {
            const folders = rule.scope === 'folder'
                ? [foldersByName.get(rule.folder ?? '')].filter((value): value is vscode.WorkspaceFolder => !!value)
                : this.getSupportedWorkspaceFolders();
            for (const folder of folders) {
                const identity = this.workspaceRootIdentityForFolder(folder);
                if (typeof identity.caseSensitive !== 'boolean') { return `${folder.name}:unverified-path-identity`; }
                const rel = rule.path.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/$/, '');
                const directDisposition = evaluateConfiguredScope(scope, identity, rel, false, false);
                if (directDisposition.source === 'explicitExclude') {
                    continue;
                }
                const descendantsExplicitlyExcluded =
                    configuredScopeExplicitlyExcludesSubtree(scope, identity, rel);
                const patterns = this.getVsCodeWatcherExcludePatterns(folder.uri)
                    .flatMap(pattern => this.expandSimpleBraceGlob(pattern));
                if (patterns.length === 0) { continue; }

                const matcher = ignore({ ignorecase: !identity.caseSensitive }).add(patterns);
                if (patterns.some(pattern =>
                    this.watcherPatternMatchesPath(pattern, rel, identity.caseSensitive!))) {
                    return `${folder.name}:${rule.path}`;
                }
                if (descendantsExplicitlyExcluded) {
                    // A descendant-only exclusion such as vendor/** does not
                    // exclude a monitorable file named vendor. The direct target
                    // was checked above; only descendant coverage can be skipped.
                    continue;
                }

                let mayHaveDescendants = true;
                try {
                    mayHaveDescendants = !fs.lstatSync(path.join(folder.uri.fsPath, ...rel.split('/'))).isFile();
                } catch (error) {
                    if (!this.isFileNotFound(error)) { return `${folder.name}:${rule.path}`; }
                }
                if (!mayHaveDescendants) { continue; }

                const directProbes = [
                    `${rel}/__difftracker_probe__`,
                    `${rel}/__difftracker_probe__/file.txt`
                ];
                if (directProbes.some(probe => matcher.ignores(probe)) ||
                    patterns.some(pattern =>
                        this.watcherPatternMayMatchWithinInclude(pattern, rel, identity.caseSensitive!))) {
                    return `${folder.name}:${rule.path}`;
                }
            }
        }
        return undefined;
    }

    private watcherPatternCoveredByExplicitScopeExclusion(
        scope: CanonicalMonitoringScope,
        identity: WorkspaceRootIdentity,
        pattern: string
    ): boolean {
        const normalized = pattern.replace(/\\/g, '/')
            .replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/$/, '');

        // A universal configured exclusion is sufficient regardless of whether
        // the host watcher blind spot has any literal prefix.
        if (configuredScopeExplicitlyExcludesSubtree(scope, identity, '')) {
            return true;
        }

        // Wildcard-prefixed watcher patterns cannot be reduced to a literal
        // subtree witness. An identical supported structured exclusion is still
        // a direct proof: both sides use the same segment/globstar vocabulary,
        // and explicit exclusions have higher precedence than Whole Workspace.
        // Do not equate directory-only structured rules (trailing slash) with
        // watcher patterns, whose coverage helper strips that marker.
        const comparable = (value: string): string =>
            value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/$/, '');
        const watcherKey = identity.caseSensitive ? normalized : normalized.toLowerCase();
        const identicalExplicitExclusion = scope.excludes.some(rule => {
            if (rule.scope === 'folder' && rule.folder !== identity.name) { return false; }
            if (rule.pattern.endsWith('/')) { return false; }
            const ruleKey = comparable(rule.pattern);
            return (identity.caseSensitive ? ruleKey : ruleKey.toLowerCase()) === watcherKey;
        });
        if (identicalExplicitExclusion) {
            return true;
        }

        const segments = normalized.split('/').filter(Boolean);
        const literalPrefix: string[] = [];
        for (const segment of segments) {
            if (segment === '**' || /[*?\[\]{}]/.test(segment)) { break; }
            literalPrefix.push(segment);
        }
        if (literalPrefix.length === 0) { return false; }
        const prefix = literalPrefix.join('/');
        if (!configuredScopeExplicitlyExcludesSubtree(scope, identity, prefix)) {
            return false;
        }
        if (literalPrefix.length === segments.length) {
            const directTarget = evaluateConfiguredScope(scope, identity, prefix, false, false);
            if (directTarget.source !== 'explicitExclude') {
                return false;
            }
        }
        return true;
    }

    private configuredScopeNeedsSupplementalCoverage(scope: CanonicalMonitoringScope): string | undefined {
        const includeIssue = this.explicitIncludeNeedsSupplementalCoverage(scope);
        if (includeIssue) { return includeIssue; }
        if (scope.mode !== 'wholeWorkspace') { return undefined; }

        for (const folder of this.getSupportedWorkspaceFolders()) {
            const identity = this.workspaceRootIdentityForFolder(folder);
            if (typeof identity.caseSensitive !== 'boolean') {
                return `${folder.name}:unverified-path-identity`;
            }
            const patterns = this.getVsCodeWatcherExcludePatterns(folder.uri)
                .flatMap(pattern => this.expandSimpleBraceGlob(pattern))
                .filter(pattern => !this.watcherPatternOnlyTargetsHardBoundary(pattern))
                .filter(pattern => !this.watcherPatternCoveredByExplicitScopeExclusion(scope, identity, pattern));
            if (patterns.length > 0) {
                return `${folder.name}:Whole Workspace intersects files.watcherExclude (${patterns[0]})`;
            }
        }
        return undefined;
    }

    private invalidateConfiguredScopeForWatcherCoverage(): void {
        const committedScope = this.getEffectiveMonitoringScope();
        if (committedScope.kind !== 'configured') { return; }
        const issue = this.configuredScopeNeedsSupplementalCoverage(committedScope);
        if (!issue) { return; }

        const alreadyPaused = !this.isRecording && this.baselineBuilding && !this.snapshotInitialized;
        if (this.isRecording) {
            this.stopRecording();
        } else {
            this.disposeFileWatchers();
        }
        this.snapshotInitialized = false;
        this.baselineBuilding = true;
        this.scanCoverage = undefined;
        this.schedulePersistState();
        this._onDidChangeBaselineState.fire('building');
        this.emitTrackChangesEvent({ fullRefresh: true, baselineChanged: true });

        if (!alreadyPaused) {
            void vscode.window.showWarningMessage(
                `Code Diff Tracker: Effective monitoring scope now requires supplemental coverage at ${issue}. Review is paused; narrow the scope or restore watcher coverage, then rebuild the baseline.`
            );
        }
    }

    private getVsCodeExcludePatterns(resource: vscode.Uri): string[] {
        const config = vscode.workspace.getConfiguration(undefined, resource);
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

    private getLegacyGlobalWatchExcludePatterns(): string[] {
        const config = vscode.workspace.getConfiguration('diffTracker');
        const inspected = typeof config.inspect === 'function'
            ? config.inspect<unknown[]>('watchExclude')
            : undefined;
        const raw = inspected?.globalValue ?? config.get<unknown[]>('watchExclude', []) ?? [];
        if (!Array.isArray(raw)) { return []; }
        const ignoreRules: string[] = [];
        raw.forEach(line => {
            if (typeof line !== 'string') { return; }
            const trimmed = line.trim();
            if (trimmed) { ignoreRules.push(trimmed); }
        });
        return ignoreRules;
    }

    private hasStructuredWorkspaceScopeRequest(): boolean {
        const config = vscode.workspace.getConfiguration('diffTracker');
        const inspect = <T>(key: string): T | undefined =>
            typeof config.inspect === 'function' ? config.inspect<T>(key)?.workspaceValue : undefined;
        const mode = inspect<unknown>('monitoringScope');
        const include = inspect<unknown>('watchInclude');
        const exclude = inspect<unknown>('watchExclude');
        if (mode !== undefined || include !== undefined) { return true; }
        if (exclude === undefined) { return false; }
        if (Array.isArray(exclude) && (exclude.length === 0 || exclude.every(value => typeof value === 'string'))) {
            // An isolated empty/string array is still a valid pre-S3 legacy
            // setting. Once mode/include exist, the branch above identifies S3.
            return false;
        }
        return true;
    }

    private sameLegacyWatchExcludePolicy(
        left: ReadonlyMap<string, readonly string[]>,
        right: ReadonlyMap<string, readonly string[]>
    ): boolean {
        if (left.size !== right.size) { return false; }
        for (const [rootUri, patterns] of left) {
            const other = right.get(rootUri);
            if (!other || patterns.length !== other.length ||
                patterns.some((pattern, index) => pattern !== other[index])) {
                return false;
            }
        }
        return true;
    }

    private getWatchExcludePatterns(
        resource: vscode.Uri,
        legacyPolicyCandidate?: Map<string, string[]>
    ): string[] {
        if (this.effectiveMonitoringScope.kind !== 'legacyV3') { return []; }
        // 0.7.2 used resource-scoped VS Code precedence: Folder overrides
        // Workspace, which overrides Global. Arrays replace, not concatenate.
        const config = vscode.workspace.getConfiguration('diffTracker', resource);
        const raw = config.get<unknown>('watchExclude', []);
        const structuredRequest = this.hasStructuredWorkspaceScopeRequest();
        const folder = vscode.workspace.getWorkspaceFolder(resource);
        const rootUri = folder?.uri.toString();

        if (Array.isArray(raw) && raw.every(value => typeof value === 'string') &&
            (raw.length > 0 || !structuredRequest)) {
            const patterns = (raw as string[]).map(value => value.trim()).filter(Boolean);
            if (rootUri && legacyPolicyCandidate) {
                legacyPolicyCandidate.set(rootUri, [...patterns]);
            }
            return patterns;
        }

        if (structuredRequest) {
            const committed = rootUri ? this.committedLegacyWatchExcludeByRoot.get(rootUri) : undefined;
            if (committed) { return [...committed]; }
            throw new Error(
                'Committed resource-scoped legacy watchExclude policy is unavailable while a structured scope request is pending'
            );
        }

        if (Array.isArray(raw) && raw.every(value => typeof value === 'string')) {
            const patterns = (raw as string[]).map(value => value.trim()).filter(Boolean);
            if (rootUri && legacyPolicyCandidate) {
                legacyPolicyCandidate.set(rootUri, [...patterns]);
            }
            return patterns;
        }
        throw new Error('Invalid legacy watchExclude configuration; compatibility discovery is blocked');
    }

    public async prepareLegacyCompatibilityPolicySnapshot(): Promise<boolean> {
        if (this.effectiveMonitoringScope.kind !== 'legacyV3') { return true; }
        const previous = new Map(
            [...this.committedLegacyWatchExcludeByRoot]
                .map(([rootUri, patterns]) => [rootUri, [...patterns]] as [string, string[]])
        );
        const captured = new Map(previous);
        try {
            for (const folder of this.getSupportedWorkspaceFolders()) {
                const config = vscode.workspace.getConfiguration('diffTracker', folder.uri);
                const raw = config.get<unknown>('watchExclude', []);
                if (Array.isArray(raw) && raw.every(value => typeof value === 'string')) {
                    captured.set(
                        folder.uri.toString(),
                        (raw as string[]).map(value => value.trim()).filter(Boolean)
                    );
                    continue;
                }
                const committed = previous.get(folder.uri.toString());
                if (!committed) {
                    throw new Error('Resource-scoped legacy policy is no longer available for a safe migration snapshot');
                }
                captured.set(folder.uri.toString(), [...committed]);
            }
            this.committedLegacyWatchExcludeByRoot = captured;
            if (await this.flushPendingPersistence()) { return true; }
        } catch {
            // The caller will keep Workspace settings unchanged.
        }
        this.committedLegacyWatchExcludeByRoot = previous;
        return false;
    }

    private async buildIgnoreMatcher(
        folder: vscode.WorkspaceFolder,
        evidence: string[],
        legacyPolicyCandidate?: Map<string, string[]>
    ): Promise<Ignore> {
        const epoch = this.sessionEpoch;
        for (let attempt = 0; ; attempt++) {
            const candidateEvidence: string[] = [];
            try {
                const matcher = await this.readIgnoreMatcher(folder, candidateEvidence, legacyPolicyCandidate);
                evidence.push(...candidateEvidence);
                return matcher;
            } catch (error) {
                // Atomic replacement/deletion and transient provider errors can
                // race discovery. Retry the whole candidate, never skip a rule
                // or publish evidence from a partially read set of files.
                if (attempt >= 2 || !this.isCurrentEpoch(epoch)) { throw error; }
                await new Promise(resolve => setTimeout(resolve, 25));
                if (!this.isCurrentEpoch(epoch)) { throw error; }
            }
        }
    }

    private async readIgnoreMatcher(
        folder: vscode.WorkspaceFolder,
        evidence: string[],
        legacyPolicyCandidate?: Map<string, string[]>
    ): Promise<Ignore> {
        const ig = ignore();
        const watchExcludes = this.getWatchExcludePatterns(folder.uri, legacyPolicyCandidate);
        const basePatterns = [
            ...this.getDefaultExcludePatterns(),
            ...this.getVsCodeExcludePatterns(folder.uri),
            ...watchExcludes
        ];
        ig.add(basePatterns);
        evidence.push(folder.uri.fsPath, JSON.stringify(basePatterns));
        // Include resource-scoped settings that may influence VS Code discovery.
        const scoped = vscode.workspace.getConfiguration(undefined, folder.uri);
        evidence.push(JSON.stringify(['files.exclude', 'files.watcherExclude', 'search.exclude']
            .map(key => scoped.get(key, {}))));

        // Repository-local excludes have lower priority than .gitignore files.
        const infoExcludePath = path.join(folder.uri.fsPath, '.git', 'info', 'exclude');
        if (fs.existsSync(infoExcludePath)) {
            const text = fs.readFileSync(infoExcludePath, 'utf8');
            this.addGitignorePatterns(ig, text, '');
            evidence.push('.git/info/exclude', text);
        }

        const gitignoreFiles = await this.getGitignoreFiles(folder);

        for (const uri of gitignoreFiles.sort((a, b) => a.fsPath.localeCompare(b.fsPath))) {
            // Explicit scope exclusions are a read boundary, including while a
            // candidate scope is being applied. A nested .gitignore can only be
            // skipped when its whole containing subtree is also excluded; if
            // only the metadata file is excluded, treating its policy as empty
            // could expose files that its rules would otherwise protect.
            const disposition = this.excludedIgnoreFileDisposition(uri);
            if (disposition === 'skip') { continue; }
            if (disposition === 'block') {
                throw new Error(
                    'Explicitly excluded .gitignore cannot be ignored while its parent subtree remains monitored; nested ignore policy is unavailable'
                );
            }
            const content = await vscode.workspace.fs.readFile(uri);
            const text = new TextDecoder('utf-8').decode(content);
            const relPath = this.toPosixPath(path.relative(folder.uri.fsPath, uri.fsPath));
            const relDir = path.posix.dirname(relPath);
            const prefix = relDir === '.' ? '' : `${relDir}/`;
            this.addGitignorePatterns(ig, text, prefix);
            evidence.push(relPath, text);
        }

        return ig;
    }

    private excludedIgnoreFileDisposition(uri: vscode.Uri): 'read' | 'skip' | 'block' {
        if (uri.scheme !== 'file') { return 'block'; }
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (!folder || folder.uri.scheme !== 'file') { return 'block'; }
        const scope = this.pendingMonitoringScope ??
            (this.effectiveMonitoringScope.kind === 'configured'
                ? this.effectiveMonitoringScope as CanonicalMonitoringScope
                : undefined);
        if (!scope) { return 'read'; }

        const rootIdentity = this.workspaceRootIdentityForFolder(folder);
        const relative = this.toPosixPath(path.relative(folder.uri.fsPath, uri.fsPath));
        const fileDecision = evaluateConfiguredScope(scope, rootIdentity, relative, false, false);
        if (fileDecision.source !== 'explicitExclude') { return 'read'; }

        const relativeDir = path.posix.dirname(relative);
        return configuredScopeExplicitlyExcludesSubtree(
            scope,
            rootIdentity,
            relativeDir === '.' ? '' : relativeDir
        ) ? 'skip' : 'block';
    }

    private async getGitignoreFiles(folder: vscode.WorkspaceFolder): Promise<vscode.Uri[]> {
        // Rediscover additions as well as modifications/deletions on each refresh.
        return vscode.workspace.findFiles(
            new vscode.RelativePattern(folder, '**/.gitignore'),
            new vscode.RelativePattern(folder, '**/.git/**')
        ).then(files => files.filter(uri => uri.scheme === 'file'));
    }

    private addGitignorePatterns(ig: Ignore, content: string, prefix: string) {
        // Directory names are literal, even when they contain glob characters.
        const literalPrefix = prefix.replace(/([\\*?\[\]!#])/g, '\\$1');
        for (const line of content.split(/\r?\n/)) {
            if (!line.trim() || line.startsWith('#') || line === '!') { continue; }
            if (!prefix) { ig.add(line); continue; }
            const negated = line.startsWith('!');
            const pattern = negated ? line.slice(1) : line;
            // A slashless rule (including directory-only foo/) applies at every
            // depth below its .gitignore. Leading/inner slashes anchor it there.
            const recursive = !pattern.replace(/ +$/, '').replace(/\/$/, '').includes('/');
            const scoped = `${literalPrefix}${recursive ? '**/' : ''}${pattern.replace(/^\//, '')}`;
            ig.add(`${negated ? '!' : ''}${scoped}`);
        }
    }

    private toPosixPath(value: string): string {
        return value.split(path.sep).join(path.posix.sep);
    }

    public testIgnorePath(inputPath?: string): { ignored: boolean; reason: string } {
        if (!inputPath || inputPath.trim().length === 0) {
            return { ignored: false, reason: 'No path provided' };
        }

        const normalizedInput = inputPath.trim();
        const folders = this.getSupportedWorkspaceFolders();
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

        const ordinaryIgnored = matcher.ignores(relPath);
        if (this.effectiveMonitoringScope.kind === 'configured') {
            const decision = evaluateConfiguredScope(
                this.effectiveMonitoringScope as CanonicalMonitoringScope,
                this.workspaceRootIdentityForFolder(targetFolder),
                relPath,
                ordinaryIgnored,
                false
            );
            const reason = decision.source === 'identityUnknown'
                ? 'Workspace path case-sensitivity could not be verified'
                : decision.source === 'hardBoundary'
                ? 'Matched an unmonitorable DiffTracker hard boundary'
                : decision.source === 'explicitExclude'
                ? 'Matched explicit DiffTracker exclusion'
                : decision.source === 'explicitInclude'
                    ? 'Explicit DiffTracker inclusion overrides ordinary ignore policy'
                    : decision.source === 'wholeWorkspace'
                        ? 'Whole Workspace target scope'
                        : decision.monitored ? 'Not ignored' : 'Matched ordinary ignore policy';
            return { ignored: !decision.monitored, reason };
        }
        return { ignored: ordinaryIgnored, reason: ordinaryIgnored ? 'Matched legacy ignore rules' : 'Not ignored' };
    }

    private isPathIgnored(uri: vscode.Uri, directory = false, respectRetainedReview = true, respectPendingScope = true): boolean {
        if (uri.scheme !== 'file') { return true; }
        // Lookup cost depends on path depth, not the number of recent recoveries.
        for (let current = uri.fsPath; ; current = path.dirname(current)) {
            if (this.creationTempRoots.has(this.creationTempKey(current))) { return true; }
            if (path.dirname(current) === current) { break; }
        }
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (!folder || folder.uri.scheme !== 'file') {
            return true;
        }
        const hardBoundaryPath = this.toPosixPath(path.relative(folder.uri.fsPath, uri.fsPath));
        const rootIdentity = this.workspaceRootIdentityForFolder(folder);
        if (typeof rootIdentity.caseSensitive !== 'boolean') { return true; }
        let hardBoundaryDirectory = directory;
        if (!hardBoundaryDirectory &&
            !isHardUnmonitorableRelativePath(hardBoundaryPath, rootIdentity, false) &&
            isHardUnmonitorableRelativePath(hardBoundaryPath, rootIdentity, true)) {
            try { hardBoundaryDirectory = fs.lstatSync(uri.fsPath).isDirectory(); }
            catch (error) { if (!this.isFileNotFound(error)) { return true; } }
        }
        if (isHardUnmonitorableRelativePath(
            hardBoundaryPath,
            rootIdentity,
            hardBoundaryDirectory
        )) { return true; }
        if (respectPendingScope && this.pendingScopeExplicitlyExcludes(uri, directory)) { return true; }

        // Retained Review is outside the current target scope but remains
        // minimally observable until its pending review is resolved.
        if (respectRetainedReview && this.retainedReviewPaths.has(uri.fsPath)) { return false; }

        const matcher = this.ignoreMatchers.get(folder.uri.fsPath);
        if (!matcher) {
            return false;
        }

        const relPath = this.toPosixPath(path.relative(folder.uri.fsPath, uri.fsPath)) + (directory ? '/' : '');
        const scopeKey = this.effectiveMonitoringScope.kind === 'configured'
            ? this.effectiveMonitoringScope.scopeRevision
            : this.effectiveMonitoringScope.scopeRevision;
        const cacheKey = `${scopeKey}::${folder.uri.fsPath}::${relPath}`;
        const cached = this.ignoreResultCache.get(cacheKey);
        if (cached !== undefined) {
            return cached;
        }

        const ordinaryIgnored = matcher.ignores(relPath);
        const ignored = this.effectiveMonitoringScope.kind === 'configured'
            ? !evaluateConfiguredScope(
                this.effectiveMonitoringScope as CanonicalMonitoringScope,
                this.workspaceRootIdentityForFolder(folder),
                relPath,
                ordinaryIgnored,
                directory
            ).monitored
            : ordinaryIgnored;
        this.setIgnoreResultCache(cacheKey, ignored);
        return ignored;
    }

    private preserveUnverifiedRootReview(filePath: string): boolean {
        const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
        if (!folder || folder.uri.scheme !== 'file' ||
            typeof this.workspaceRootIdentityForFolder(folder).caseSensitive === 'boolean' ||
            (!this.trackedChanges.has(filePath) && !this.retainedReviewPaths.has(filePath))) { return false; }
        // Unproven identity blocks resource I/O, not preservation of evidence.
        // Retained paths plus their existing baselines are durable in Session V4.
        this.retainedReviewPaths.add(filePath);
        this.markFileUnavailable(filePath, this.rootIdentityUnavailableReason);
        return true;
    }

    private pruneIgnoredTrackedChanges(): void {
        const removedFiles: string[] = [];
        const retainedFiles: string[] = [];
        for (const filePath of this.trackedChanges.keys()) {
            const uri = vscode.Uri.file(filePath);
            const folder = vscode.workspace.getWorkspaceFolder(uri);
            if (this.workspaceContextChanged && (!folder || folder.uri.scheme !== 'file')) { continue; }
            if (this.preserveUnverifiedRootReview(filePath)) {
                retainedFiles.push(filePath);
                continue;
            }
            if (this.retainedReviewPaths.has(filePath) && !this.isPathIgnored(uri, false, false, false)) {
                this.retainedReviewPaths.delete(filePath);
                retainedFiles.push(filePath);
            }
            if (!this.isPathIgnored(uri, false, true, false)) { continue; }
            if (this.effectiveMonitoringScope.kind === 'configured' && folder?.uri.scheme === 'file') {
                const identity = this.workspaceRootIdentityForFolder(folder);
                const relative = this.toPosixPath(path.relative(folder.uri.fsPath, filePath));
                if (typeof identity.caseSensitive === 'boolean' &&
                    !isHardUnmonitorableRelativePath(relative, identity)) {
                    // Ordinary policy does not acknowledge or discard review.
                    // Retention permits only this resource's verification, not
                    // discovery throughout its newly excluded parent directory.
                    this.retainedReviewPaths.add(filePath);
                    retainedFiles.push(filePath);
                    continue;
                }
            }
            this.deleteTrackedChange(filePath);
            this.lineChanges.delete(filePath);
            this.markLineChangesUpdated(filePath);
            this.inlineViews.delete(filePath);
            removedFiles.push(filePath);
        }
        if (retainedFiles.length > 0) {
            this.schedulePersistState();
            this.emitTrackChangesEvent({ changedFiles: retainedFiles, fullRefresh: true });
        }
        if (removedFiles.length > 0) { this.emitTrackChangesEvent({ removedFiles }); }
    }

    private startupCreatePredatesWatchBoundary(
        event: StartupEvent,
        boundaryMs: number | undefined,
        boundaryMonotonicNs: bigint | undefined
    ): boolean {
        if (boundaryMs === undefined || boundaryMonotonicNs === undefined ||
            event.firstKind !== 'create' || event.kind !== 'create' ||
            event.uri.scheme !== 'file') { return false; }

        const nowWallMs = Date.now();
        const elapsedMonotonicMs = Number(process.hrtime.bigint() - boundaryMonotonicNs) / 1_000_000;
        const elapsedWallMs = nowWallMs - boundaryMs;
        if (!Number.isFinite(elapsedMonotonicMs) || !Number.isFinite(elapsedWallMs) ||
            elapsedMonotonicMs < 0 || elapsedWallMs < 0 ||
            Math.abs(elapsedWallMs - elapsedMonotonicMs) > this.startupTimestampSafetyMarginMs) {
            // Wall-clock jumps make file timestamps incomparable with the
            // activation boundary. Preserve uncertainty instead of guessing.
            return false;
        }

        try {
            const stat = fs.statSync(event.uri.fsPath);
            const latestSafeTimestamp = boundaryMs - this.startupTimestampSafetyMarginMs;
            const timestamps = [stat.birthtimeMs, stat.mtimeMs, stat.ctimeMs];
            return timestamps.every(value =>
                Number.isFinite(value) && value > 0 && value < latestSafeTimestamp
            );
        } catch {
            return false;
        }
    }

    private async initializeWorkspaceSnapshots(transaction?: BaselineTransaction): Promise<void> {
        const epoch = this.sessionEpoch;
        const folders = this.getSupportedWorkspaceFolders();
        const initialDocuments = new Set(vscode.workspace.textDocuments.filter(doc => doc.uri.scheme === 'file').map(doc => doc.uri.fsPath));
        const transientPaths = new Set<string>();
        await this.refreshIgnoreMatchers();
        if (!this.isCurrentEpoch(epoch)) { return; }

        const scanFingerprint = this.ignoreFingerprint;
        const scanIgnoreVersion = this.ignoreRefreshVersion;
        const wholeWorkspacePreparationBudget =
            this.effectiveMonitoringScope.kind === 'configured' &&
            this.effectiveMonitoringScope.mode === 'wholeWorkspace'
                ? { remainingEntries: this.maxScopePreflightEntries }
                : undefined;
        if (this.initialIgnoreEpoch === epoch) {
            const classified = new Map<string, { event: StartupEvent; state: 'ignored' | 'directory' | 'missing' | 'other' }>();
            // Keep each path's first event across I/O rounds. An event arriving
            // during stat invalidates that classification, not its earlier history.
            while (true) {
                const events = [...this.initialIgnoreEvents.values()].filter(event => classified.get(event.uri.fsPath)?.event !== event);
                if (events.length === 0) { break; }
                for (const event of events) {
                    if (!this.isCurrentEpoch(epoch)) { return; }
                    const uri = event.uri;
                    let state: 'ignored' | 'directory' | 'missing' | 'other' = 'other';
                    if (this.isPathIgnored(uri)) { state = 'ignored'; }
                    else {
                        try {
                            const stat = await vscode.workspace.fs.stat(uri);
                            if (stat.type & vscode.FileType.Directory) { state = 'directory'; }
                        } catch (error) {
                            if (this.isFileNotFound(error)) { state = 'missing'; }
                        }
                    }
                    if (!this.isCurrentEpoch(epoch)) { return; }
                    classified.set(uri.fsPath, { event, state });
                }
            }
            const initialWatchBoundaryMs = this.initialWatchBoundaryMs;
            const initialWatchBoundaryMonotonicNs = this.initialWatchBoundaryMonotonicNs;
            this.initialIgnoreEpoch = undefined;
            this.initialWatchBoundaryMs = undefined;
            this.initialWatchBoundaryMonotonicNs = undefined;
            this.initialIgnoreEvents.clear();
            for (const [filePath, { event, state }] of classified) {
                if (state === 'ignored') { continue; }
                if ((state === 'other' || state === 'directory') &&
                    this.startupCreatePredatesWatchBoundary(
                        event,
                        initialWatchBoundaryMs,
                        initialWatchBoundaryMonotonicNs
                    )) {
                    // Some watcher backends report an existing path as "create"
                    // when a new watcher starts. Only a single create whose
                    // birth/content metadata is strictly older than the watcher
                    // activation boundary can be discarded as stale.
                    continue;
                }
                // Even a transient parent must not cause surviving children or
                // pre-existing open documents to be accepted as a fresh baseline.
                this.scanUncertainFiles.add(filePath);
                if (state === 'directory') { continue; }
                const dirty = vscode.workspace.textDocuments.some(doc => doc.uri.scheme === 'file' && this.canonicalTrackingPath(doc.uri.fsPath) === filePath && doc.isDirty);
                if (state === 'missing' && event.firstKind === 'create' && event.kind === 'delete' && !initialDocuments.has(filePath) && !dirty) {
                    transientPaths.add(filePath);
                    continue;
                }
                this.recordUnresolvedBaseline(filePath, 'File changed during ignore discovery; before-image is unknown');
                this.pendingExternalChanges.add(filePath);
            }
            // Unchanged editors may be ahead of disk. Changed paths stay unknown.
            vscode.workspace.textDocuments.forEach(doc => {
                if (!transientPaths.has(doc.uri.fsPath)) { this.ensureSnapshotForDocument(doc, true); }
            });
        }

        const wholeWorkspaceCapacityGuard: CandidateCapacityGuard | undefined =
            wholeWorkspacePreparationBudget
                ? {
                    remaining: this.remainingCandidatePersistenceSlots(),
                    exemptPaths: new Set([
                        ...this.fileSnapshots.keys(),
                        ...this.unresolvedBaselineFiles.keys(),
                        ...this.opaqueBaselineFiles.keys(),
                        ...this.trackedChanges.keys()
                    ]),
                    countedCandidates: new Set<string>()
                }
                : undefined;
        const wholeWorkspacePersistenceBudget = wholeWorkspacePreparationBudget
            ? this.createCandidatePersistenceBudget(scanFingerprint)
            : undefined;

        for (const folder of folders) {
            if (!this.isRecording || !this.isCurrentEpoch(epoch)) {
                return;
            }

            const files = await this.findScopeFilesUnderDirectory(
                folder.uri.fsPath,
                wholeWorkspacePreparationBudget,
                wholeWorkspaceCapacityGuard
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
                    if (state.kind === 'missing' && transientPaths.has(uri.fsPath)) { return; }
                    if (wholeWorkspacePersistenceBudget) {
                        const plan = this.planScannedBaseline(uri.fsPath, state, 'workspace');
                        this.consumeCandidatePersistenceBudget(uri.fsPath, plan, wholeWorkspacePersistenceBudget);
                    }
                    this.recordScannedBaseline(uri.fsPath, state, 'workspace');
                });

                if (!this.isRecording || !this.isCurrentEpoch(epoch)) {
                    return;
                }

                await this.yieldToEventLoop();
                if (!this.isCurrentEpoch(epoch)) { return; }
            }
        }

        this.scanCoverage = scanIgnoreVersion === this.ignoreRefreshVersion ? scanFingerprint : undefined;
        await this.completeBaseline(epoch, transaction);
    }

    private async completeBaseline(epoch: number, transaction?: BaselineTransaction): Promise<boolean> {
        ++this.baselineCompletionVersion;
        this.baselineBuilding = true;
        this.snapshotInitialized = true;
        await this.processPendingExternalChanges();
        if (!this.isCurrentEpoch(epoch)) { return false; }
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
            this.persistTimer = undefined;
        }
        let version: number;
        do {
            version = this.baselineCompletionVersion;
            if (!await this.flushPersistState(true, transaction) || !this.isCurrentEpoch(epoch)) { return false; }
        } while (version !== this.baselineCompletionVersion);
        if (transaction?.valid && !transaction.valid()) { return false; }
        this.baselineBuilding = false;
        this._onDidChangeBaselineState.fire('ready');
        return true;
    }

    private isFileNotFound(error: unknown): boolean {
        const code = (error as { code?: string } | undefined)?.code;
        return code === 'FileNotFound' || code === 'ENOENT';
    }

    private async fingerprintLocalFile(filePath: string): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const hash = createHash('sha256');
            const stream = fs.createReadStream(filePath);
            stream.on('data', chunk => hash.update(chunk));
            stream.once('error', reject);
            stream.once('end', () => resolve(hash.digest('hex')));
        });
    }

    private async readFileSnapshot(uri: vscode.Uri): Promise<CurrentFileState> {
        const targetError = this.validateResourceTarget(uri.fsPath);
        if (uri.scheme !== 'file' || targetError) {
            return { kind: 'unavailable', reason: targetError ?? 'Only local file resources are supported' };
        }
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.type & vscode.FileType.Directory) {
                return {
                    kind: 'unavailable',
                    targetKind: 'directory',
                    reasonCode: 'resource-directory',
                    reason: 'Resource is a directory'
                };
            }
            if (stat.size > 5 * 1024 * 1024) {
                const fingerprint = await this.fingerprintLocalFile(uri.fsPath);
                const afterStat = await vscode.workspace.fs.stat(uri);
                if (stat.size !== afterStat.size || stat.mtime !== afterStat.mtime || stat.type !== afterStat.type) {
                    return { kind: 'unavailable', reason: 'File changed while being read; refresh before review' };
                }
                return {
                    kind: 'unavailable',
                    reason: 'File exceeds the 5 MiB limit',
                    size: stat.size,
                    mtime: stat.mtime,
                    fingerprint
                };
            }
            const content = await vscode.workspace.fs.readFile(uri);
            const afterStat = await vscode.workspace.fs.stat(uri);
            if (stat.size !== afterStat.size || stat.mtime !== afterStat.mtime || stat.type !== afterStat.type) {
                return { kind: 'unavailable', reason: 'File changed while being read; refresh before review' };
            }
            if (content.length > 5 * 1024 * 1024) {
                return { kind: 'unavailable', reason: 'File exceeds the 5 MiB limit', size: stat.size, mtime: stat.mtime, fingerprint: createHash('sha256').update(content).digest('hex') };
            }
            if (content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf) {
                return { kind: 'unavailable', reason: 'UTF-8 BOM files require encoding preservation and are read-only in this version', size: stat.size, mtime: stat.mtime, fingerprint: createHash('sha256').update(content).digest('hex') };
            }
            if (this.isLikelyBinaryContent(content)) {
                return { kind: 'unavailable', reason: 'Binary content is unsupported', size: stat.size, mtime: stat.mtime, fingerprint: createHash('sha256').update(content).digest('hex') };
            }
            try {
                return { kind: 'text', content: new TextDecoder('utf-8', { fatal: true }).decode(content), mode: fs.statSync(uri.fsPath).mode & 0o777 };
            } catch {
                return { kind: 'unavailable', reason: 'Unsupported text encoding (expected UTF-8)', size: stat.size, mtime: stat.mtime, fingerprint: createHash('sha256').update(content).digest('hex') };
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
        const doc = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && this.canonicalTrackingPath(d.uri.fsPath) === filePath);
        if (doc?.isDirty) {
            return { kind: 'unavailable', reason: 'Unsaved editor changes require review before file actions' };
        }
        return state;
    }

    private isBinaryUnavailableReason(reason: string): boolean {
        return reason === 'Binary content is unsupported' || reason === 'Binary baseline content is unsupported';
    }

    private markFileUnavailable(filePath: string, reason: string): void {
        filePath = this.canonicalTrackingPath(filePath);
        const existingUnresolvedReason = this.unresolvedBaselineFiles.get(filePath);
        const preservedUncertaintyReason = existingUnresolvedReason &&
            !this.isStableUnsupportedBaselineReason(existingUnresolvedReason) &&
            !this.isBinaryUnavailableReason(existingUnresolvedReason)
            ? existingUnresolvedReason
            : undefined;
        // Unknown paths must survive restart too. A later create notification may
        // establish an absent baseline, but unavailable bytes are never accepted.
        if (!this.fileSnapshots.has(filePath) && !this.opaqueBaselineFiles.has(filePath)) {
            if (!existingUnresolvedReason && this.snapshotInitialized && !this.baselineBuilding && this.restoringEpoch === undefined) {
                this.postBaselineUnknownFiles.add(filePath);
            }
            if (!preservedUncertaintyReason) {
                this.unresolvedBaselineFiles.set(filePath, reason.slice(0, 1000));
                this.schedulePersistState();
            }
        }
        const effectiveReason = preservedUncertaintyReason ?? reason;
        const previous = this.trackedChanges.get(filePath);
        this.setTrackedChange(filePath, {
            filePath, fileName: displayFileName(filePath),
            originalContent: this.fileSnapshots.get(filePath) ?? '',
            currentContent: previous?.currentContent ?? '',
            isDeleted: previous?.isDeleted ?? false,
            reviewKind: 'unknown',
            reviewReason: effectiveReason,
            changes: previous?.changes ?? [], timestamp: new Date(), unavailableReason: effectiveReason
        });
        this.emitTrackChangesEvent({ changedFiles: [filePath] });
    }

    private isStableUnsupportedBaselineReason(reason: string): boolean {
        return reason === 'File exceeds the 5 MiB limit' ||
            reason === 'UTF-8 BOM files require encoding preservation and are read-only in this version' ||
            reason === 'Binary content is unsupported' ||
            reason === 'Unsupported text encoding (expected UTF-8)';
    }

    private isStableUnsupportedState(state: CurrentFileState): state is Extract<CurrentFileState, { kind: 'unavailable' }> & { size: number; mtime: number } {
        return state.kind === 'unavailable' && this.isStableUnsupportedBaselineReason(state.reason) &&
            typeof state.size === 'number' && Number.isFinite(state.size) &&
            typeof state.mtime === 'number' && Number.isFinite(state.mtime);
    }

    private getCurrentStateSize(state: CurrentFileState): number | undefined {
        if (this.isStableUnsupportedState(state)) { return state.size; }
        if (state.kind === 'text') { return Buffer.byteLength(state.content, 'utf8'); }
        return undefined;
    }

    private markOpaqueReview(filePath: string, state: CurrentFileState, reason: string): void {
        filePath = this.canonicalTrackingPath(filePath);
        const opaqueBaseline = this.opaqueBaselineFiles.get(filePath);
        const textBaseline = this.fileSnapshots.get(filePath);
        const baselineExists = opaqueBaseline ? true : this.baselineExistingFiles.has(filePath);
        const currentExists = state.kind !== 'missing';
        const previous = this.trackedChanges.get(filePath);
        const hadLineChanges = this.lineChanges.has(filePath);

        this.setTrackedChange(filePath, {
            filePath,
            fileName: displayFileName(filePath),
            originalContent: textBaseline ?? '',
            currentContent: state.kind === 'text' ? state.content : '',
            isDeleted: !currentExists,
            reviewKind: 'opaque',
            reviewReason: reason,
            sourceNote: previous?.sourceNote,
            baselineExists,
            currentExists,
            baselineSize: opaqueBaseline?.size ??
                (baselineExists && textBaseline !== undefined ? Buffer.byteLength(textBaseline, 'utf8') : undefined),
            currentSize: this.getCurrentStateSize(state),
            baselineFingerprint: opaqueBaseline?.fingerprint ??
                (baselineExists && textBaseline !== undefined
                    ? createHash('sha256').update(textBaseline, 'utf8').digest('hex')
                    : undefined),
            currentFingerprint: this.isStableUnsupportedState(state)
                ? state.fingerprint
                : state.kind === 'text'
                    ? createHash('sha256').update(state.content, 'utf8').digest('hex')
                    : undefined,
            changes: [],
            timestamp: new Date()
        });
        this.lineChanges.delete(filePath);
        this.inlineViews.delete(filePath);
        this.invalidateChangeBlocksCache(filePath);
        if (hadLineChanges) { this.markLineChangesUpdated(filePath); }
        this.emitTrackChangesEvent({ changedFiles: [filePath] });
    }

    private hasCapturedBaseline(filePath: string): boolean {
        filePath = this.canonicalTrackingPath(filePath);
        return this.fileSnapshots.has(filePath) || this.opaqueBaselineFiles.has(filePath);
    }

    private hasDirtyDocument(filePath: string): boolean {
        filePath = this.canonicalTrackingPath(filePath);
        return vscode.workspace.textDocuments.some(document =>
            document.uri.scheme === 'file' && this.canonicalTrackingPath(document.uri.fsPath) === filePath && document.isDirty);
    }

    private recordScannedBaseline(filePath: string, state: CurrentFileState, scope: 'workspace' | 'repository'): void {
        filePath = this.canonicalTrackingPath(filePath);
        if (this.pendingScopeExplicitlyExcludes(vscode.Uri.file(filePath))) { return; }
        // Recheck after the scanner's await. An editor may have captured a valid
        // before-image in the meantime; neither scanner may overwrite it.
        if (this.hasCapturedBaseline(filePath) || this.isPathIgnored(vscode.Uri.file(filePath))) { return; }
        const plan = this.planScannedBaseline(filePath, state, scope);
        if (plan.kind === 'text') {
            this.unresolvedBaselineFiles.delete(filePath);
            this.fileSnapshots.set(filePath, plan.content);
            if (plan.mode !== undefined) { this.fileModes.set(filePath, plan.mode); }
            this.baselineExistingFiles.add(filePath);
            return;
        }
        if (plan.kind === 'opaque') {
            this.recordOpaqueBaseline(filePath, plan.state);
            return;
        }
        this.recordUnresolvedBaseline(filePath, plan.reason);
    }

    private recordOpaqueBaseline(filePath: string, state: Extract<CurrentFileState, { kind: 'unavailable' }>): void {
        filePath = this.canonicalTrackingPath(filePath);
        // Acceptance is synchronous and owns its safety checks: new callers must
        // not be able to erase dirty buffers or historical scan evidence.
        if (this.hasCapturedBaseline(filePath)) { return; }
        if (this.hasScanUncertainty(filePath)) {
            this.recordUnresolvedBaseline(filePath, 'File changed during baseline scan; before-image is unknown');
            return;
        }
        if (this.hasDirtyDocument(filePath)) {
            this.recordUnresolvedBaseline(filePath, 'Unsupported file has unsaved editor changes; save or discard them before clearing the baseline');
            return;
        }
        if (!this.isStableUnsupportedState(state)) {
            this.recordUnresolvedBaseline(filePath, state.reason);
            return;
        }
        this.postBaselineUnknownFiles.delete(filePath);
        this.unresolvedBaselineFiles.delete(filePath);
        this.fileSnapshots.delete(filePath);
        this.fileModes.delete(filePath);
        this.baselineExistingFiles.delete(filePath);
        this.opaqueBaselineFiles.set(filePath, {
            reason: state.reason,
            size: state.size,
            mtime: state.mtime,
            fingerprint: state.fingerprint
        });
        this.deleteTrackedChange(filePath);
        this.lineChanges.delete(filePath);
        this.markLineChangesUpdated(filePath);
        this.inlineViews.delete(filePath);
        this.schedulePersistState();
    }

    private opaqueBaselineMatches(baseline: OpaqueBaselineState, state: CurrentFileState): boolean {
        if (!this.isStableUnsupportedState(state) || baseline.reason !== state.reason) { return false; }
        return baseline.fingerprint !== undefined && state.fingerprint !== undefined &&
            baseline.size === state.size && baseline.fingerprint === state.fingerprint;
    }

    private reconcileOpaqueBaseline(filePath: string, state: CurrentFileState): boolean {
        const baseline = this.opaqueBaselineFiles.get(filePath);
        if (!baseline) { return false; }
        if (this.hasDirtyDocument(filePath)) {
            this.markFileUnavailable(filePath, 'Disk notification while editor has unsaved content; reconcile disk and buffer before review');
            return true;
        }
        if (this.opaqueBaselineMatches(baseline, state)) {
            if (this.trackedChanges.has(filePath) || this.lineChanges.has(filePath) || this.inlineViews.has(filePath)) {
                this.clearFileReview(filePath);
            }
            return true;
        }
        const reason = state.kind === 'missing'
            ? 'File was deleted after an unsupported baseline was accepted; original content is unavailable'
            : state.kind === 'text'
                ? 'File changed from an unsupported baseline; original content is unavailable'
                : this.isStableUnsupportedState(state)
                    ? 'Unsupported file changed since the baseline; content is available only as a file identity'
                    : state.reason;
        if (state.kind === 'missing' || state.kind === 'text' || this.isStableUnsupportedState(state)) {
            this.markOpaqueReview(filePath, state, reason);
        } else {
            this.markFileUnavailable(filePath, reason);
        }
        return true;
    }

    private recordUnresolvedBaseline(filePath: string, reason: string): void {
        filePath = this.canonicalTrackingPath(filePath);
        this.opaqueBaselineFiles.delete(filePath);
        this.postBaselineUnknownFiles.delete(filePath);
        this.unresolvedBaselineFiles.set(filePath, reason);
        this.markFileUnavailable(filePath, reason);
        this.schedulePersistState();
    }

    private hasObservedCreation(filePath: string): boolean {
        for (let current = filePath; ; current = path.dirname(current)) {
            if (this.activeCreations.get(current)?.duringScan === false || this.restoreEvents.get(current)?.kind === 'create') { return true; }
            if (path.dirname(current) === current) { return false; }
        }
    }

    private async discoverRestoredFiles(epoch: number): Promise<void> {
        const candidates = new Map<string, vscode.Uri>();
        const wholeWorkspace = this.effectiveMonitoringScope.kind === 'configured' &&
            this.effectiveMonitoringScope.mode === 'wholeWorkspace';
        const wholeWorkspacePreparationBudget = wholeWorkspace
            ? { remainingEntries: this.maxScopePreflightEntries }
            : undefined;
        const durableResourcePaths = wholeWorkspace ? new Set([
            ...this.fileSnapshots.keys(),
            ...this.unresolvedBaselineFiles.keys(),
            ...this.opaqueBaselineFiles.keys()
        ]) : undefined;
        const persistenceBudget = wholeWorkspace
            ? this.createCandidatePersistenceBudget()
            : undefined;
        const wholeWorkspaceCapacityGuard: CandidateCapacityGuard | undefined =
            wholeWorkspace && durableResourcePaths
                ? {
                    remaining: this.remainingCandidatePersistenceSlots(),
                    exemptPaths: new Set([
                        ...durableResourcePaths,
                        ...this.trackedChanges.keys()
                    ]),
                    countedCandidates: new Set<string>()
                }
                : undefined;
        for (const folder of this.getSupportedWorkspaceFolders()) {
            const files = await this.findScopeFilesUnderDirectory(
                folder.uri.fsPath,
                wholeWorkspacePreparationBudget,
                wholeWorkspaceCapacityGuard
            );
            if (!this.isCurrentEpoch(epoch)) { return; }
            for (const uri of files) { candidates.set(uri.fsPath, uri); }
        }
        for (const doc of vscode.workspace.textDocuments) {
            if (doc.uri.scheme !== 'file' || this.isPathIgnored(doc.uri)) { continue; }
            const canonical = this.canonicalTrackingPath(doc.uri.fsPath);
            const canonicalUri = vscode.Uri.file(canonical);
            if (this.isPathIgnored(canonicalUri)) { continue; }
            if (wholeWorkspaceCapacityGuard &&
                !wholeWorkspaceCapacityGuard.exemptPaths.has(canonical) &&
                !this.trackedChanges.has(canonical) &&
                !wholeWorkspaceCapacityGuard.countedCandidates.has(canonical)) {
                if (wholeWorkspaceCapacityGuard.remaining <= 0) {
                    throw new Error(
                        'Monitoring scope snapshot capacity would exceed the remaining per-category persistence slots; add explicit exclusions before retrying.'
                    );
                }
                wholeWorkspaceCapacityGuard.countedCandidates.add(canonical);
                wholeWorkspaceCapacityGuard.remaining--;
            }
            candidates.set(canonical, canonicalUri);
        }

        const plannedAdditions: Array<{ filePath: string; plan: CandidateBaselinePlan }> = [];
        for (const uri of candidates.values()) {
            if (!this.isCurrentEpoch(epoch)) { return; }
            const filePath = uri.fsPath;
            if (uri.scheme !== 'file' || this.isPathIgnored(uri) ||
                this.fileSnapshots.has(filePath) || this.unresolvedBaselineFiles.has(filePath) || this.opaqueBaselineFiles.has(filePath)) { continue; }
            if (await this.isUntrackedDirectory(uri)) { continue; }
            if (!this.isCurrentEpoch(epoch)) { return; }
            if (this.isPathIgnored(uri) || this.fileSnapshots.has(filePath) || this.unresolvedBaselineFiles.has(filePath) || this.opaqueBaselineFiles.has(filePath)) { continue; }
            const observedCreation = this.hasObservedCreation(filePath);
            const plan: CandidateBaselinePlan =
                observedCreation || (this.scanCoverage && this.scanCoverage === this.ignoreFingerprint)
                    ? { kind: 'text', content: '', baselineExists: false }
                    : {
                        kind: 'unresolved',
                        reason: 'Prior scan coverage is unknown or ignore rules changed; before-image is unknown'
                    };
            if (persistenceBudget) {
                this.consumeCandidatePersistenceBudget(filePath, plan, persistenceBudget);
            }
            plannedAdditions.push({ filePath, plan });
        }

        for (const { filePath, plan } of plannedAdditions) {
            if (plan.kind === 'text') {
                this.fileSnapshots.set(filePath, plan.content);
                this.fileModes.delete(filePath);
                this.baselineExistingFiles.delete(filePath);
            } else if (plan.kind === 'unresolved') {
                this.recordUnresolvedBaseline(filePath, plan.reason);
            } else {
                // Restore discovery never creates opaque before-images because no
                // file content is read here; keep this exhaustive for type safety.
                throw new Error('Unexpected opaque restore candidate');
            }
        }
        if (plannedAdditions.length > 0 && !await this.flushPendingPersistence()) {
            throw new Error('Restored additions could not be persisted');
        }
    }

    private normalizeRestoredDirectorySentinels(): boolean {
        let changed = false;
        for (const [filePath, baseline] of [...this.fileSnapshots]) {
            if (baseline !== '' || this.baselineExistingFiles.has(filePath) ||
                this.pendingScopeExplicitlyExcludes(vscode.Uri.file(filePath), true) ||
                this.validateResourceTarget(filePath)) {
                continue;
            }
            let stat: fs.Stats;
            try { stat = fs.lstatSync(filePath); }
            catch { continue; }
            if (!stat.isDirectory() || stat.isSymbolicLink()) { continue; }

            const priorReason = this.coverageGaps.get(filePath)?.file?.reason;
            this.fileSnapshots.delete(filePath);
            this.fileModes.delete(filePath);
            this.unresolvedBaselineFiles.delete(filePath);
            this.postBaselineUnknownFiles.delete(filePath);
            this.clearFileReview(filePath, true);
            this.clearCoverageGap(filePath, 'file', false);
            this.setSubtreeCoverageGap(
                filePath,
                'legacy-directory-sentinel',
                priorReason ?? 'Restored directory coverage requires subtree reconciliation'
            );
            changed = true;
        }
        return changed;
    }

    private async rebuildTrackedChangesFromSnapshots(): Promise<void> {
        const epoch = this.sessionEpoch;
        this.clearTrackedChanges();
        this.lineChanges.clear();
        this.resetChangeBlocksCaches();
        this.inlineViews.clear();

        const restoredGapReviewPaths = new Set<string>();
        for (const filePath of this.retainedReviewPaths) {
            if (this.preserveUnverifiedRootReview(filePath)) { restoredGapReviewPaths.add(filePath); }
        }
        for (const [filePath, record] of this.coverageGaps) {
            const evidence = record.file;
            if (!evidence || restoredGapReviewPaths.has(filePath)) { continue; }
            const hasBaselineEvidence = this.fileSnapshots.has(filePath) ||
                this.opaqueBaselineFiles.has(filePath) ||
                this.unresolvedBaselineFiles.has(filePath);
            if (!hasBaselineEvidence) { continue; }
            const uri = vscode.Uri.file(filePath);
            if (this.isPathIgnored(uri, false, true, false)) { continue; }
            this.markFileUnavailable(filePath, evidence.reason);
            restoredGapReviewPaths.add(filePath);
        }

        const snapshotPaths = Array.from(this.fileSnapshots.keys());

        await this.runWithConcurrency(snapshotPaths, 8, async (filePath) => {
            if (restoredGapReviewPaths.has(filePath)) { return; }
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
                if (currentState.targetKind === 'directory') {
                    if (this.baselineExistingFiles.has(filePath)) {
                        this.markFileUnavailable(
                            filePath,
                            'A baseline file is now a directory; file actions are disabled while the replacement directory is preserved'
                        );
                    } else {
                        this.clearAbsentDirectorySentinel(filePath);
                    }
                } else if (this.isStableUnsupportedState(currentState)) {
                    this.markOpaqueReview(
                        filePath,
                        currentState,
                        this.baselineExistingFiles.has(filePath)
                            ? 'Text baseline changed to a read-only unsupported file'
                            : 'Read-only unsupported file was created after the baseline'
                    );
                } else {
                    this.markFileUnavailable(filePath, currentState.reason);
                }
            }
        });
        if (!this.isCurrentEpoch(epoch)) { return; }
        const opaquePaths = Array.from(this.opaqueBaselineFiles.keys());
        await this.runWithConcurrency(opaquePaths, 8, async (filePath) => {
            if (restoredGapReviewPaths.has(filePath)) { return; }
            const uri = vscode.Uri.file(filePath);
            if (this.isPathIgnored(uri)) { return; }
            const currentState = await this.readCurrentFileState(filePath);
            if (!this.isCurrentEpoch(epoch)) { return; }
            this.reconcileOpaqueBaseline(filePath, currentState);
        });
        if (!this.isCurrentEpoch(epoch)) { return; }
        for (const [filePath, reason] of this.unresolvedBaselineFiles) {
            if (restoredGapReviewPaths.has(filePath)) { continue; }
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

    private markScanEvent(filePath: string): boolean {
        if (this.snapshotInitialized || this.hasCapturedBaseline(filePath)) { return false; }
        // Register before any await so scanners and editor opens cannot adopt
        // these bytes. Keep directory markers too, to protect their children.
        this.scanUncertainFiles.add(filePath);
        return true;
    }

    private async isUntrackedDirectory(uri: vscode.Uri): Promise<boolean> {
        // A tracked file replaced with a directory must still report a conflict.
        if (this.baselineExistingFiles.has(uri.fsPath) || this.opaqueBaselineFiles.has(uri.fsPath)) { return false; }
        try {
            return !!((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory);
        } catch {
            // Let the normal reader report missing/unreadable files.
            return false;
        }
    }

    private async onExternalFileChanged(uri: vscode.Uri): Promise<void> {
        if (uri.scheme === 'file') { uri = vscode.Uri.file(this.canonicalTrackingPath(uri.fsPath)); }
        const epoch = this.sessionEpoch;
        if (!this.isRecording || !this.externalWatcherEnabled) {
            return;
        }

        if (uri.scheme !== 'file') {
            return;
        }

        if (this.deferInitialIgnoreEvent(uri)) { return; }
        const filePath = uri.fsPath;
        this.recordBaselineTransactionEvent(uri, 'change');
        if (this.scopeApplyPreflight && this.pendingScopeExplicitlyExcludes(uri)) {
            this.preserveDeferredScopeApplyEvent(filePath);
            return;
        }
        if (this.deferPendingScopeEvent(uri)) { return; }
        if (this.isPathIgnored(uri)) {
            return;
        }

        if (this.retainCoverageGapReview(filePath)) { return; }
        const operationId = this.beginExternalOperation(uri, 'change');
        try {
            const scanEvent = this.markScanEvent(filePath);
            if (await this.isUntrackedDirectory(uri) || !this.isCurrentEpoch(epoch)) { return; }
            if (scanEvent) {
                this.pendingExternalChanges.add(filePath);
                this.recordUnresolvedBaseline(filePath, 'File changed during baseline scan; before-image is unknown');
                return;
            }

            const doc = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && this.canonicalTrackingPath(d.uri.fsPath) === filePath);
            if (doc && doc.isDirty) {
                this.markFileUnavailable(filePath, 'External change while editor has unsaved content; reconcile disk and buffer before review');
                return;
            }

            if (this.scopeApplyPreflight) {
                await this.readFileAndUpdate(filePath, uri);
                return;
            }

            const existingTimer = this.externalChangeTimers.get(filePath);
            if (existingTimer) {
                clearTimeout(existingTimer);
            }

            const timer = setTimeout(() => {
                this.externalChangeTimers.delete(filePath);
                const readOperationId = this.beginExternalOperation(uri, 'change');
                void (async () => {
                    try {
                        if (!this.isRecording || !this.externalWatcherEnabled || !this.isCurrentEpoch(epoch)) {
                            return;
                        }
                        if (this.isPathIgnored(uri)) {
                            return;
                        }
                        await this.readFileAndUpdate(filePath, uri);
                    } finally {
                        this.endExternalOperation(readOperationId);
                    }
                })().catch(() => undefined);
            }, 120);

            this.externalChangeTimers.set(filePath, timer);
        } finally {
            this.endExternalOperation(operationId);
        }
    }

    private onDocumentOpened(doc: vscode.TextDocument): void {
        this.ensureSnapshotForDocument(doc);
    }

    private async markCreatedDirectoryUnavailable(filePath: string, reason: string, duringScan: boolean, epoch: number, refreshVersion?: number): Promise<void> {
        const isCurrent = () => this.isCurrentEpoch(epoch) && (refreshVersion === undefined || refreshVersion === this.ignoreRefreshVersion);
        if (!isCurrent()) { return; }
        const historicalFileEvidence = this.baselineExistingFiles.has(filePath) || this.opaqueBaselineFiles.has(filePath);
        if (!historicalFileEvidence) {
            // A directory coverage obligation is not an absent text-file baseline.
            // Remove only synthetic/unverified file projections; real file
            // before-images remain protected by the branch below.
            if (this.fileSnapshots.has(filePath) && !this.baselineExistingFiles.has(filePath)) {
                this.clearAbsentDirectorySentinel(filePath);
            }
            this.unresolvedBaselineFiles.delete(filePath);
            this.postBaselineUnknownFiles.delete(filePath);
            this.clearCoverageGap(filePath, 'file', false);
            this.clearFileReview(filePath, true);
        } else {
            this.markFileUnavailable(
                filePath,
                'A baseline file is now a directory; file actions are disabled while the replacement directory is preserved'
            );
        }
        if (!isCurrent()) { return; }
        this.setSubtreeCoverageGap(
            filePath,
            duringScan ? 'directory-scan-coverage-gap' : 'directory-runtime-coverage-gap',
            reason
        );
    }

    private clearAbsentDirectorySentinel(filePath: string): boolean {
        if (!this.fileSnapshots.has(filePath) || this.baselineExistingFiles.has(filePath)) {
            return false;
        }
        const hadTrackedChange = this.trackedChanges.has(filePath);
        const hadLineChanges = this.lineChanges.has(filePath);
        const hadInlineView = this.inlineViews.has(filePath);
        this.releaseScopeBaselineData(filePath);
        this.deleteTrackedChange(filePath);
        this.lineChanges.delete(filePath);
        if (hadLineChanges) { this.markLineChangesUpdated(filePath); }
        this.inlineViews.delete(filePath);
        this.invalidateChangeBlocksCache(filePath);
        if (hadTrackedChange || hadLineChanges || hadInlineView) {
            this.emitTrackChangesEvent({ removedFiles: [filePath], baselineChanged: true });
        }
        return true;
    }

    private async onExternalFileCreated(uri: vscode.Uri, duringScan = false): Promise<void> {
        if (uri.scheme === 'file') { uri = vscode.Uri.file(this.canonicalTrackingPath(uri.fsPath)); }
        const epoch = this.sessionEpoch;
        if (!this.isRecording || !this.externalWatcherEnabled) {
            return;
        }

        if (uri.scheme !== 'file') {
            return;
        }

        if (this.deferInitialIgnoreEvent(uri, 'create')) { return; }
        const filePath = uri.fsPath;
        this.recordBaselineTransactionEvent(uri, 'create');
        if (this.scopeApplyPreflight && this.pendingScopeExplicitlyExcludes(uri)) {
            this.preserveDeferredScopeApplyEvent(filePath);
            return;
        }
        if (this.deferPendingScopeEvent(uri)) { return; }
        if (this.isPathIgnored(uri)) {
            return;
        }

        if (this.retainCoverageGapReview(filePath)) { return; }
        const scanEvent = this.markScanEvent(filePath) || (duringScan && !this.hasCapturedBaseline(filePath));
        // Capture creation evidence before stat/ignore discovery can yield. A
        // concurrent refresh must not classify this directory's children as old.
        const creation = { duringScan: scanEvent, cancelled: false };
        this.activeCreations.set(filePath, creation);
        const creationIsCurrent = () => this.isCurrentEpoch(epoch) && !creation.cancelled &&
            this.activeCreations.get(filePath) === creation;
        try {
            const directory = await this.isUntrackedDirectory(uri);
            if (!creationIsCurrent()) { return; }
            if (directory) {
                // A missing explicit include is represented by an absent-file
                // sentinel. Once that path is known to be a directory the
                // sentinel must not survive persistence: directories are not
                // file review targets, and each discovered child receives its
                // own absence provenance below.
                const removedAbsentSentinel = this.clearAbsentDirectorySentinel(filePath);
                if (!removedAbsentSentinel && this.fileSnapshots.has(filePath) && this.baselineExistingFiles.has(filePath)) {
                    this.markFileUnavailable(
                        filePath,
                        'A baseline file is now a directory; file actions are disabled while the replacement directory is preserved'
                    );
                }
                // Native watchers may report only the parent when a populated
                // directory appears; its nested .gitignore events are not guaranteed.
                try {
                    await this.refreshIgnoreMatchers();
                    if (!creationIsCurrent()) { return; }
                    let watchFailed = false;
                    try { await this.watchImportedTree(filePath, epoch); }
                    catch { watchFailed = true; }
                    if (!creationIsCurrent()) { return; }
                    const durablePaths = new Set([
                        ...this.fileSnapshots.keys(),
                        ...this.unresolvedBaselineFiles.keys(),
                        ...this.opaqueBaselineFiles.keys(),
                        ...this.trackedChanges.keys()
                    ]);
                    const childCapacityGuard: CandidateCapacityGuard = {
                        remaining: Math.max(
                            0,
                            this.maxPersistedSnapshots -
                                (scanEvent ? this.unresolvedBaselineFiles.size : this.fileSnapshots.size)
                        ),
                        exemptPaths: durablePaths,
                        countedCandidates: new Set<string>()
                    };
                    const children = await this.findScopeFilesUnderDirectory(
                        filePath,
                        undefined,
                        childCapacityGuard
                    );
                    if (!creationIsCurrent()) { return; }
                    for (const child of children) {
                        if (!creationIsCurrent()) { return; }
                        if (child.fsPath !== filePath && this.pathBelongsToRoot(child.fsPath, filePath)) {
                            await this.onExternalFileCreated(child, scanEvent);
                        }
                    }
                    if (watchFailed && creationIsCurrent()) {
                        await this.markCreatedDirectoryUnavailable(filePath, 'Imported directory watch coverage is incomplete; current files were scanned, but rebuild the baseline after reducing watched directories or resolving the system watcher limit', scanEvent, epoch);
                    } else if (creationIsCurrent()) {
                        // A successful watch plus the completed bounded scan above
                        // satisfies an existing diagnostic; watcher installation
                        // alone never clears the obligation.
                        this.clearCoverageGap(filePath, 'subtree');
                        if (removedAbsentSentinel) { this.schedulePersistState(); }
                    }
                } catch {
                    if (creationIsCurrent()) {
                        await this.markCreatedDirectoryUnavailable(filePath, 'Created directory could not be scanned; rebuild the baseline after resolving the read failure', scanEvent, epoch);
                    }
                }
                return;
            }
            if (scanEvent) {
                this.recordUnresolvedBaseline(filePath, 'File appeared during baseline scan; before-image is unknown');
                return;
            }
            const state = await this.readFileSnapshot(uri);
            if (!creationIsCurrent()) { return; }
            if (!this.fileSnapshots.has(filePath) && !this.opaqueBaselineFiles.has(filePath) &&
                (!this.unresolvedBaselineFiles.has(filePath) || this.postBaselineUnknownFiles.has(filePath))) {
                this.unresolvedBaselineFiles.delete(filePath);
                this.postBaselineUnknownFiles.delete(filePath);
                this.fileSnapshots.set(filePath, '');
                if (!await this.completeBaseline(epoch)) { return; }
            }
            if (this.reconcileOpaqueBaseline(filePath, state)) {
                return;
            }
            if (state.kind === 'unavailable') {
                if (state.targetKind === 'directory') {
                    if (this.fileSnapshots.has(filePath) && this.baselineExistingFiles.has(filePath)) {
                        this.markFileUnavailable(
                            filePath,
                            'A baseline file is now a directory; file actions are disabled while the replacement directory is preserved'
                        );
                    } else if (this.fileSnapshots.has(filePath) && !this.baselineExistingFiles.has(filePath)) {
                        this.clearAbsentDirectorySentinel(filePath);
                    }
                    return;
                }
                if (this.isStableUnsupportedState(state) && this.fileSnapshots.has(filePath)) {
                    this.markOpaqueReview(
                        filePath,
                        state,
                        this.baselineExistingFiles.has(filePath)
                            ? 'Text baseline changed to a read-only unsupported file'
                            : 'Read-only unsupported file was created after the baseline'
                    );
                } else {
                    this.markFileUnavailable(filePath, state.reason);
                }
                return;
            }
            await this.readFileAndUpdate(filePath, uri);
        } finally {
            if (this.activeCreations.get(filePath) === creation) { this.activeCreations.delete(filePath); }
        }
    }

    private async onExternalFileDeleted(uri: vscode.Uri): Promise<void> {
        if (uri.scheme === 'file') { uri = vscode.Uri.file(this.canonicalTrackingPath(uri.fsPath)); }
        const epoch = this.sessionEpoch;
        if (!this.isRecording || !this.externalWatcherEnabled || uri.scheme !== 'file' ||
            this.deferInitialIgnoreEvent(uri, 'delete')) {
            return;
        }
        this.recordBaselineTransactionEvent(uri, 'delete');
        if (this.scopeApplyPreflight) {
            // A parent-only delete can arrive after the subtree has already
            // disappeared, so file-system stat cannot recover its type. Route
            // historically proven directories through the same subtree-aware
            // pending-scope deletion path before the file-level preflight
            // fallback preserves the event.
            if (this.hasHistoricalDirectoryProvenance(uri.fsPath) &&
                this.deferPendingScopeDeletion(uri)) {
                return;
            }
            if (this.pendingScopeExplicitlyExcludes(uri)) {
                this.preserveDeferredScopeApplyEvent(uri.fsPath);
                return;
            }
        }
        if (this.deferPendingScopeDeletion(uri)) { return; }
        const operationId = this.beginExternalOperation(uri, 'delete');
        try {
            // Remove watches only for a confirmed missing subtree.
            const confirmedMissing = !fs.existsSync(uri.fsPath);
            if (confirmedMissing) { this.removeImportedDirectoryWatchers(uri.fsPath); }

            const parentIgnored = this.isPathIgnored(uri);
            if (parentIgnored) {
                // Ordinary policy may ignore the parent while an already-pending
                // child review is deliberately retained outside target scope.
                // Reconcile only those retained resources; do not enumerate or
                // discover new descendants in the ignored subtree.
                const root = path.resolve(uri.fsPath);
                const retainedDescendants = [...this.retainedReviewPaths]
                    .filter(filePath => path.resolve(filePath) !== root && this.pathBelongsToRoot(filePath, root));
                for (const filePath of retainedDescendants) {
                    if (!this.isCurrentEpoch(epoch)) { return; }
                    await this.readFileAndUpdate(filePath, vscode.Uri.file(filePath));
                }
                return;
            }

            if (this.retainCoverageGapReview(uri.fsPath)) { return; }
            // A delete notification may race an atomic replacement; confirm actual state.
            const baselinePaths = new Set([...this.fileSnapshots.keys(), ...this.opaqueBaselineFiles.keys()]);
            const targets = new Set([uri.fsPath, ...[...baselinePaths].filter(filePath => {
                const relative = path.relative(uri.fsPath, filePath);
                return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
            })]);
            for (const filePath of targets) {
                if (!this.isCurrentEpoch(epoch)) { return; }
                await this.readFileAndUpdate(filePath, vscode.Uri.file(filePath));
            }
            if (confirmedMissing && this.isCurrentEpoch(epoch)) {
                // A parent directory delete invalidates diagnostics for every
                // covered descendant, not only the exact watcher path.
                this.clearSubtreeCoverageGapsUnder(uri.fsPath);
            }
        } finally {
            this.endExternalOperation(operationId);
        }
    }

    private async readFileAndUpdate(filePath: string, uri: vscode.Uri): Promise<void> {
        filePath = this.canonicalTrackingPath(filePath);
        if (uri.scheme === 'file') { uri = vscode.Uri.file(filePath); }
        const epoch = this.sessionEpoch;
        if (this.deferPendingScopeEvent(uri)) { return; }
        if (this.retainCoverageGapReview(filePath)) { return; }
        if (this.pendingWriteFiles.has(filePath) && !this.activeWriteFiles.has(filePath)) {
            const doc = vscode.workspace.textDocuments.find(value => value.uri.scheme === 'file' && this.canonicalTrackingPath(value.uri.fsPath) === filePath);
            if (!doc?.isDirty) { this.pendingWriteFiles.delete(filePath); }
        }
        if (this.isPathIgnored(uri)) { return; }
        const state = await this.readFileSnapshot(uri);
        if (!this.isCurrentEpoch(epoch) || this.isPathIgnored(uri)) { return; }
        // A watcher read can finish after native Undo or another buffer edit.
        // Its disk snapshot must not erase the newer unsaved review.
        const document = vscode.workspace.textDocuments.find(doc => doc.uri.scheme === 'file' && this.canonicalTrackingPath(doc.uri.fsPath) === filePath);
        if (document?.isDirty && !this.activeWriteFiles.has(filePath)) {
            this.markFileUnavailable(filePath, 'Disk notification while editor has unsaved content; reconcile disk and buffer before review');
            return;
        }
        if (this.reconcileOpaqueBaseline(filePath, state)) {
            return;
        }
        if (state.kind === 'unavailable') {
            if (state.targetKind === 'directory') {
                if (this.fileSnapshots.has(filePath) && this.baselineExistingFiles.has(filePath)) {
                    this.markFileUnavailable(
                        filePath,
                        'A baseline file is now a directory; file actions are disabled while the replacement directory is preserved'
                    );
                } else if (this.fileSnapshots.has(filePath) && !this.baselineExistingFiles.has(filePath)) {
                    this.clearAbsentDirectorySentinel(filePath);
                } else if (this.opaqueBaselineFiles.has(filePath)) {
                    this.markFileUnavailable(
                        filePath,
                        'A baseline file is now a directory; file actions are disabled while the replacement directory is preserved'
                    );
                }
                return;
            }
            if (this.isStableUnsupportedState(state) && this.fileSnapshots.has(filePath)) {
                this.markOpaqueReview(
                    filePath,
                    state,
                    this.baselineExistingFiles.has(filePath)
                        ? 'Text baseline changed to a read-only unsupported file'
                        : 'Read-only unsupported file changed after creation'
                );
            } else {
                this.markFileUnavailable(filePath, state.reason);
            }
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
        filePath = this.canonicalTrackingPath(filePath);
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
            this.releaseRetainedReviewBaseline(filePath);
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
            reviewKind: 'text',
            baselineExists: this.baselineExistingFiles.has(filePath),
            currentExists,
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
        if (this.restoringEpoch !== undefined) { return 'Session restoration is still reconciling changes; review is paused'; }
        if (this.persistenceFailed) { return 'Session persistence failed; review actions are paused until it can be saved'; }
        if (this.recoveryBlocked) { return 'Session recovery is blocked; preserve or discard the damaged state before review actions'; }
        if (this.baselineBuilding || !this.snapshotInitialized) { return 'Baseline is incomplete; rebuild it before review actions'; }
        return this.validateSnapshotTarget(filePath);
    }

    private validateSnapshotTarget(filePath: string): string | undefined {
        if (this.recoveryBlocked) { return 'Session recovery is blocked; preserve or discard the damaged state before review actions'; }
        if (this.disposed || this.workspaceContextChanged) { return 'Session is closed or workspace membership changed; review is paused'; }
        const gitPauseReason = this.getGitPauseReason(filePath);
        if (gitPauseReason) { return gitPauseReason; }
        return this.validateResourceTarget(filePath);
    }

    private pathBelongsToRoot(filePath: string, root: string): boolean {
        const relative = path.relative(root, filePath);
        return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    }

    public setGitContextPending(pending: boolean): void {
        if (this.disposed || this.gitContextPending === pending) { return; }
        this.gitContextPending = pending;
        this.emitTrackChangesEvent({ fullRefresh: true });
    }

    public setBaselineGitContexts(contexts: GitContextSnapshot[]): void {
        this.latestGitContexts = new Map(contexts.map(context => [context.repoRoot, { ...context }]));
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
        if (this.mayAdoptLegacyGitContexts) {
            this.mayAdoptLegacyGitContexts = false;
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
        this.latestGitContexts.set(context.repoRoot, { ...context });
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
        this.latestGitContexts.set(repoRoot, undefined);
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
        if (this.gitContextPending) { return 'Git initialization and context reconciliation are pending; review actions are paused'; }
        const owner = this.getRepositoryOwner(filePath);
        return owner ? this.pausedGitRepositories.get(owner) : undefined;
    }

    private getRepositoryRoots(): string[] {
        return [...new Set([...this.baselineGitContexts.keys(), ...this.latestGitContexts.keys(), ...this.pausedGitRepositories.keys()])];
    }

    private getRepositoryOwner(filePath: string): string | undefined {
        return this.getRepositoryRoots()
            .filter(root => this.pathBelongsToRoot(filePath, root)).sort((a, b) => b.length - a.length)[0];
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
            this.reportPersistenceIssue('Failed to archive the current Code Diff Tracker review; repository rebuild was blocked.', error);
            return false;
        }
    }

    public async rebuildRepositoryBaseline(repoRoot: string, context: GitContextSnapshot): Promise<boolean> {
        const epoch = this.sessionEpoch;
        return this.queueRecoveryAction(() => this.isCurrentEpoch(epoch)
            ? this.performRepositoryRebuild(repoRoot, context) : Promise.resolve(false));
    }

    private async performRepositoryRebuild(repoRoot: string, context: GitContextSnapshot): Promise<boolean> {
        const requestedEpoch = this.sessionEpoch;
        const ownsPath = (filePath: string): boolean => this.pathBelongsToRoot(filePath, repoRoot) &&
            (this.getRepositoryOwner(filePath) ?? repoRoot) === repoRoot;
        const ownershipSignature = (): string => JSON.stringify(this.getRepositoryRoots()
            .filter(root => this.pathBelongsToRoot(root, repoRoot)).sort());
        const originalOwnership = ownershipSignature();
        const contextStillCurrent = (): boolean => {
            const latest = this.latestGitContexts.get(repoRoot);
            return ownershipSignature() === originalOwnership && !!latest && compareGitContexts(context, latest).compatible &&
                context.headCommit === latest.headCommit && !latest.inProgress;
        };
        if (this.disposed || this.gitContextPending || this.recoveryBlocked || !this.snapshotInitialized || this.baselineBuilding ||
            context.repoRoot !== repoRoot || context.inProgress || !path.isAbsolute(repoRoot)) {
            return false;
        }
        const overlapsWorkspace = this.getWorkspaceRoots().some(workspaceRoot =>
            this.pathBelongsToRoot(workspaceRoot, repoRoot) || this.pathBelongsToRoot(repoRoot, workspaceRoot));
        if (!overlapsWorkspace) { return false; }
        if (vscode.workspace.textDocuments.some(document =>
            document.uri.scheme === 'file' && ownsPath(document.uri.fsPath) && document.isDirty)) {
            return false;
        }
        if (!await this.archiveCurrentSession()) { return false; }
        if (!this.isCurrentEpoch(requestedEpoch) || !contextStillCurrent()) { return false; }

        const previous = {
            fileSnapshots: new Map(this.fileSnapshots),
            fileModes: new Map(this.fileModes),
            baselineExistingFiles: new Set(this.baselineExistingFiles),
            trackedChanges: new Map(this.trackedChanges),
            lineChanges: new Map(this.lineChanges),
            inlineViews: new Map(this.inlineViews),
            revertHistory: [...this.revertHistory],
            unresolvedBaselineFiles: new Map(this.unresolvedBaselineFiles),
            opaqueBaselineFiles: new Map(this.opaqueBaselineFiles),
            baselineGitContexts: new Map(this.baselineGitContexts),
            pausedGitRepositories: new Map(this.pausedGitRepositories),
            snapshotInitialized: this.snapshotInitialized,
            scanCoverage: this.scanCoverage,
            baselineBuilding: this.baselineBuilding
        };
        let transaction: BaselineTransaction;
        const restoreMemory = (): void => {
            // Roll back the baseline candidate, not observations made while it
            // was being built. Editor-only changes need not emit a watcher event.
            const observedReviewPaths = [...this.trackedChanges.keys()].filter(ownsPath);
            this.fileSnapshots = previous.fileSnapshots;
            this.fileModes = previous.fileModes;
            this.baselineExistingFiles = previous.baselineExistingFiles;
            this.trackedChanges = previous.trackedChanges;
            this.lineChanges = previous.lineChanges;
            this.inlineViews = previous.inlineViews;
            this.revertHistory = previous.revertHistory;
            this.unresolvedBaselineFiles = previous.unresolvedBaselineFiles;
            this.opaqueBaselineFiles = previous.opaqueBaselineFiles;
            this.baselineGitContexts = previous.baselineGitContexts;
            // Pauses observed during the transaction belong to the live Git
            // context and must survive rollback of the baseline candidate.
            this.pausedGitRepositories = new Map([...previous.pausedGitRepositories, ...this.pausedGitRepositories]);
            this.snapshotInitialized = previous.snapshotInitialized;
            this.scanCoverage = previous.scanCoverage === this.ignoreFingerprint ? previous.scanCoverage : undefined;
            this.baselineBuilding = previous.baselineBuilding;
            for (const filePath of observedReviewPaths) {
                if (this.isPathIgnored(vscode.Uri.file(filePath))) { continue; }
                // Preserve a visible conflict synchronously even when Stop or
                // disposal cancels the remaining async reconciliation. When the
                // session stays active, reread against the restored before-image.
                this.markFileUnavailable(filePath, 'Baseline rebuild was interrupted; reconcile current file and editor changes before review');
                this.pendingExternalChanges.add(filePath);
            }
            this.resetChangeBlocksCaches();
            this.trackedChangesVersion++;
            this.trackedChangesCacheVersion = -1;
        };
        const restorePrevious = async (): Promise<void> => {
            if (!this.isCurrentEpoch(epoch)) { return; }
            this.endBaselineTransaction(transaction, false);
            if (this.isRecording && !this.externalWatcherEnabled) { await this.startExternalWatchers(); }
            await this.processPendingExternalChanges();
            await this.flushPendingPersistence();
            this._onDidChangeBaselineState.fire(this.baselineBuilding ? 'building' : 'ready');
            this.emitTrackChangesEvent({ fullRefresh: true });
        };

        const previousEpoch = this.sessionEpoch;
        let replacementWatchers: vscode.FileSystemWatcher[] | undefined;
        if (this.isRecording) {
            try {
                // Register the next epoch's watchers while the current epoch's
                // watchers remain active, then switch them without an await gap.
                await this.refreshIgnoreMatchers();
                if (!this.isCurrentEpoch(previousEpoch) || !contextStillCurrent()) { return false; }
                replacementWatchers = this.createExternalWatchers(previousEpoch + 1);
            } catch (error: any) {
                this.reportExternalWatcherFailure(error);
                this.reportPersistenceIssue('Failed to prepare file watcher coverage for repository baseline rebuild.', error);
                return false;
            }
        }

        const epoch = this.advanceEpoch();
        // No asynchronous work may occur between the epoch change and handoff.
        if (replacementWatchers) { this.activateExternalWatchers(replacementWatchers); }
        transaction = this.beginBaselineTransaction(restoreMemory);
        transaction.valid = contextStillCurrent;
        const previousReviewPaths = [...this.trackedChanges.keys()].filter(ownsPath);
        this.snapshotInitialized = false;
        this.scanCoverage = undefined;
        this.baselineBuilding = true;
        this._onDidChangeBaselineState.fire('building');
        try {
            const repositoryBaselinePaths = new Set([
                ...this.fileSnapshots.keys(),
                ...this.unresolvedBaselineFiles.keys(),
                ...this.opaqueBaselineFiles.keys()
            ]);
            for (const filePath of repositoryBaselinePaths) {
                if (!ownsPath(filePath)) { continue; }
                this.fileSnapshots.delete(filePath);
                this.fileModes.delete(filePath);
                this.baselineExistingFiles.delete(filePath);
                this.unresolvedBaselineFiles.delete(filePath);
                this.opaqueBaselineFiles.delete(filePath);
                this.deleteTrackedChange(filePath);
                this.lineChanges.delete(filePath);
                this.inlineViews.delete(filePath);
                this.markLineChangesUpdated(filePath);
            }

            const projectedScanCoverage =
                previous.scanCoverage === this.ignoreFingerprint ? previous.scanCoverage : undefined;
            const repositoryPersistenceBudget =
                this.createCandidatePersistenceBudget(projectedScanCoverage);

            const files = await this.findScopeFilesUnderDirectory(repoRoot);
            if (!this.isCurrentEpoch(epoch)) { throw new Error('Session changed during repository baseline rebuild'); }
            await this.runWithConcurrency(files.filter(uri => uri.scheme === 'file' && ownsPath(uri.fsPath) && !this.isPathIgnored(uri)), 8, async uri => {
                const state = await this.readFileSnapshot(uri);
                if (!this.isCurrentEpoch(epoch)) { throw new Error('Session changed during repository baseline rebuild'); }
                const plan = this.planScannedBaseline(uri.fsPath, state, 'repository');
                this.consumeCandidatePersistenceBudget(uri.fsPath, plan, repositoryPersistenceBudget);
                this.recordScannedBaseline(uri.fsPath, state, 'repository');
            });

            if (!contextStillCurrent()) { throw new Error('Git context changed during baseline rebuild'); }
            this.revertHistory = this.revertHistory.map(record => ({
                ...record,
                items: record.items.filter(item => !ownsPath(item.filePath))
            })).filter(record => record.items.length > 0);
            this.baselineGitContexts.set(repoRoot, { ...context });
            this.scanCoverage = projectedScanCoverage;
            this.resetChangeBlocksCaches();
            this.snapshotInitialized = true;
            await this.processPendingExternalChanges();
            if (!this.isCurrentEpoch(epoch) || !contextStillCurrent()) {
                await restorePrevious();
                return false;
            }
            if (this.persistTimer) {
                clearTimeout(this.persistTimer);
                this.persistTimer = undefined;
            }
            if (!await this.flushPersistState(true, transaction)) {
                await restorePrevious();
                return false;
            }
            if (!this.isCurrentEpoch(epoch) || !contextStillCurrent()) {
                await restorePrevious();
                await this.flushPendingPersistence();
                return false;
            }
            this.baselineBuilding = false;
            this.endBaselineTransaction(transaction, true);
            this._onDidChangeBaselineState.fire('ready');
            this.pausedGitRepositories.delete(repoRoot);
            this.emitTrackChangesEvent({ removedFiles: previousReviewPaths, fullRefresh: true, baselineChanged: true });
            return true;
        } catch (error) {
            if (this.isCurrentEpoch(epoch)) {
                this.reportPersistenceIssue('Failed to rebuild the repository baseline; the archived review remains preserved.', error);
            }
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
        const relativePath = this.toPosixPath(path.relative(folder.uri.fsPath, filePath));
        const rootIdentity = this.workspaceRootIdentityForFolder(folder);
        if (typeof rootIdentity.caseSensitive !== 'boolean') {
            return 'Cannot verify workspace path case-sensitivity; action blocked';
        }
        let targetIsDirectory = false;
        try { targetIsDirectory = fs.lstatSync(filePath).isDirectory(); }
        catch (error) { if (!this.isFileNotFound(error)) { return 'Cannot verify the resource workspace boundary; action blocked'; } }
        if (isHardUnmonitorableRelativePath(
            relativePath,
            rootIdentity,
            targetIsDirectory
        )) {
            return 'Resource is inside a DiffTracker hard-excluded internal path; action blocked';
        }
        try {
            const realRoot = fs.realpathSync(folder.uri.fsPath);
            // Reject aliases even when they stay inside the workspace. Checking
            // ancestors also covers directory links and dangling target links.
            for (let component = path.resolve(filePath); isWithin(folder.uri.fsPath, component); component = path.dirname(component)) {
                try {
                    if (fs.lstatSync(component).isSymbolicLink()) { return 'Symbolic link target is read-only; action blocked'; }
                } catch (error) { if (!this.isFileNotFound(error)) { throw error; } }
            }
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
            before: { ...before, mode: before.mode ?? (before.exists ? this.readFileMode(filePath) : undefined) },
            after: { ...after, mode: after.mode ?? this.fileModes.get(filePath) },
            saveMode
        };
    }

    private async prepareRevertRecord(items: PersistedRevertItem[]): Promise<PersistedRevertRecord | undefined> {
        if (items.length === 0) { return undefined; }
        const epoch = this.sessionEpoch;
        const previousHistory = [...this.revertHistory];
        // Session transitions roll this back synchronously, before Stop/dispose
        // can capture a persistence payload. The shared action queue serializes
        // preparation with Keep, Undo and other Reverts.
        const transaction = this.beginBaselineTransaction(() => { this.revertHistory = previousHistory; });
        const record: PersistedRevertRecord = {
            id: `revert-${Date.now()}-${this.nextRevertRecordId++}`,
            createdAt: new Date().toISOString(),
            items
        };
        this.revertHistory.push(record);
        this.revertHistory = this.revertHistory.slice(-this.maxRevertHistory);
        let committed = false;
        try {
            committed = await this.flushPersistState(false, transaction) && this.isCurrentEpoch(epoch);
            if (committed) { this.preparedHistory.set(record, previousHistory); }
            return committed ? record : undefined;
        } finally {
            this.endBaselineTransaction(transaction, committed);
        }
    }

    private async removeRevertRecord(record: PersistedRevertRecord): Promise<void> {
        const previousLength = this.revertHistory.length;
        // IDs can be reused after session reset; an old callback owns only this object.
        const previous = this.preparedHistory.get(record);
        this.preparedHistory.delete(record);
        // Restore evicted records only while this candidate still owns a slot.
        if (previous && this.revertHistory.includes(record)) { this.revertHistory = previous; }
        else { this.revertHistory = this.revertHistory.filter(candidate => candidate !== record); }
        if (previous || this.revertHistory.length !== previousLength) { await this.flushPendingPersistence(); }
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
        const current = this.revertHistory.find(candidate => candidate === batch.record);
        if (!current) { this.preparedHistory.delete(batch.record); return; }
        current.items = current.items.filter(item => batch.retainPaths.has(item.filePath));
        if (current.items.length === 0) {
            await this.removeRevertRecord(current);
            return;
        }
        this.preparedHistory.delete(batch.record);
        await this.flushPendingPersistence();
    }

    private clearFileReview(filePath: string, baselineChanged = false): void {
        this.deleteTrackedChange(filePath);
        this.releaseRetainedReviewBaseline(filePath);
        this.lineChanges.delete(filePath);
        this.markLineChangesUpdated(filePath);
        this.inlineViews.delete(filePath);
        this.emitTrackChangesEvent({ removedFiles: [filePath], baselineChanged });
    }

    private beginAcknowledgeTransaction(filePath: string, review: OpaqueReviewToken): BaselineTransaction {
        const previous = {
            snapshotPresent: this.fileSnapshots.has(filePath),
            snapshot: this.fileSnapshots.get(filePath),
            modePresent: this.fileModes.has(filePath),
            mode: this.fileModes.get(filePath),
            baselineExists: this.baselineExistingFiles.has(filePath),
            unresolved: this.unresolvedBaselineFiles.get(filePath),
            opaque: this.opaqueBaselineFiles.get(filePath),
            postBaselineUnknown: this.postBaselineUnknownFiles.has(filePath),
            revertHistory: this.revertHistory,
            baselineBuilding: this.baselineBuilding,
            snapshotInitialized: this.snapshotInitialized
        };
        const transaction = this.beginBaselineTransaction(() => {
            if (previous.snapshotPresent) { this.fileSnapshots.set(filePath, previous.snapshot!); }
            else { this.fileSnapshots.delete(filePath); }
            if (previous.modePresent) { this.fileModes.set(filePath, previous.mode!); }
            else { this.fileModes.delete(filePath); }
            if (previous.baselineExists) { this.baselineExistingFiles.add(filePath); }
            else { this.baselineExistingFiles.delete(filePath); }
            if (previous.unresolved !== undefined) { this.unresolvedBaselineFiles.set(filePath, previous.unresolved); }
            else { this.unresolvedBaselineFiles.delete(filePath); }
            if (previous.opaque) { this.opaqueBaselineFiles.set(filePath, previous.opaque); }
            else { this.opaqueBaselineFiles.delete(filePath); }
            if (previous.postBaselineUnknown) { this.postBaselineUnknownFiles.add(filePath); }
            else { this.postBaselineUnknownFiles.delete(filePath); }
            this.revertHistory = previous.revertHistory;
            this.baselineBuilding = previous.baselineBuilding;
            this.snapshotInitialized = previous.snapshotInitialized;
        });
        transaction.valid = () => !this.validateSnapshotTarget(filePath) && this.matchesOpaqueReview(review);
        this.revertHistory = previous.revertHistory
            .map(record => ({ ...record, items: record.items.filter(item => item.filePath !== filePath) }))
            .filter(record => record.items.length > 0);
        return transaction;
    }

    private applyAcknowledgedStateAsBaseline(filePath: string, state: CurrentFileState): boolean {
        this.unresolvedBaselineFiles.delete(filePath);
        this.postBaselineUnknownFiles.delete(filePath);
        if (state.kind === 'missing') {
            this.fileSnapshots.set(filePath, '');
            this.fileModes.delete(filePath);
            this.baselineExistingFiles.delete(filePath);
            this.opaqueBaselineFiles.delete(filePath);
            return true;
        }
        if (state.kind === 'text') {
            this.fileSnapshots.set(filePath, state.content);
            if (state.mode === undefined) { this.fileModes.delete(filePath); } else { this.fileModes.set(filePath, state.mode); }
            this.baselineExistingFiles.add(filePath);
            this.opaqueBaselineFiles.delete(filePath);
            return true;
        }
        if (this.isStableUnsupportedState(state)) {
            this.fileSnapshots.delete(filePath);
            this.fileModes.delete(filePath);
            this.baselineExistingFiles.delete(filePath);
            this.opaqueBaselineFiles.set(filePath, {
                reason: state.reason,
                size: state.size,
                mtime: state.mtime,
                fingerprint: state.fingerprint
            });
            return true;
        }
        return false;
    }

    private async commitAcknowledgeTransaction(filePath: string, epoch: number, transaction: BaselineTransaction): Promise<boolean> {
        let committed = false;
        try {
            committed = await this.completeBaseline(epoch, transaction) &&
                this.baselineTransaction === transaction && this.isCurrentEpoch(epoch);
            return committed;
        } catch (error) {
            if (this.isCurrentEpoch(epoch)) {
                this.reportPersistenceIssue('Acknowledge transaction failed; prior baseline retained.', error);
            }
            return false;
        } finally {
            const invalidTarget = this.isCurrentEpoch(epoch) && transaction.valid && !transaction.valid();
            this.endBaselineTransaction(transaction, committed);
            if (!committed && invalidTarget) { await this.flushPendingPersistence(); }
            if (!committed && this.isCurrentEpoch(epoch)) {
                await this.readFileAndUpdate(filePath, vscode.Uri.file(filePath));
            }
        }
    }

    public acknowledgeOpaqueChange(
        filePath: string,
        token = this.getOpaqueReviewToken(filePath)
    ): Promise<ActionResult> {
        filePath = this.canonicalTrackingPath(filePath);
        return this.queueRecoveryAction(() => this.queueOpaqueFileAction(
            filePath,
            token,
            (review, state) => this.acknowledgeOpaqueReviewed(filePath, review, state)
        ));
    }

    private async acknowledgeOpaqueReviewed(
        filePath: string,
        review: OpaqueReviewToken,
        state: CurrentFileState
    ): Promise<ActionResult> {
        const targetError = this.validateActionTarget(filePath);
        if (targetError) { return this.actionResult(filePath, 'conflict', targetError); }
        if (!this.matchesOpaqueReview(review)) {
            return this.actionResult(filePath, 'conflict', 'Read-only review changed during Acknowledge');
        }
        const current = await this.readCurrentFileState(filePath);
        const change = this.trackedChanges.get(filePath);
        if (!this.matchesOpaqueReview(review) || !change || !this.currentStateMatchesOpaqueReview(change, current)) {
            await this.refreshRejectedReview(filePath);
            return this.actionResult(filePath, 'conflict', 'File changed since this read-only review; review again');
        }
        // Prefer the second authoritative read. The first state exists only to
        // prove the queued action targeted the same review before entering here.
        void state;
        const finalTargetError = this.validateActionTarget(filePath);
        if (finalTargetError) { return this.actionResult(filePath, 'conflict', finalTargetError); }
        const epoch = this.sessionEpoch;
        const transaction = this.beginAcknowledgeTransaction(filePath, review);
        if (!this.applyAcknowledgedStateAsBaseline(filePath, current)) {
            this.endBaselineTransaction(transaction, false);
            return this.actionResult(filePath, 'conflict', 'Current resource identity is not reliable enough to acknowledge');
        }
        if (!await this.commitAcknowledgeTransaction(filePath, epoch, transaction)) {
            return this.actionResult(filePath, 'failed', 'Acknowledge could not be saved; read-only review remains pending');
        }
        if (!this.isCurrentEpoch(epoch)) {
            return this.actionResult(filePath, 'success', 'Acknowledge was saved before the session changed');
        }
        // The accepted identity is now the baseline even when the follow-up read
        // merely clears the old review. Notify original-content providers
        // explicitly so already-open diff editors cannot retain the old baseline.
        this.emitTrackChangesEvent({ changedFiles: [filePath], baselineChanged: true });
        await this.readFileAndUpdate(filePath, vscode.Uri.file(filePath));
        return this.actionResult(filePath, 'success');
    }

    private mixedBatchResult(
        results: ActionResult[],
        acceptedPaths: Set<string>,
        acknowledgedPaths: Set<string>,
        revertedPaths: Set<string>
    ): MixedBatchActionResult {
        const accepted = results.filter(item => item.status === 'success' && acceptedPaths.has(item.filePath)).length;
        const acknowledged = results.filter(item => item.status === 'success' && acknowledgedPaths.has(item.filePath)).length;
        const reverted = results.filter(item => item.status === 'success' && revertedPaths.has(item.filePath)).length;
        const succeeded = accepted + acknowledged + reverted;
        return {
            results,
            succeeded,
            failed: results.length - succeeded,
            accepted,
            acknowledged,
            reverted,
            needsConfirmation: results.filter(item => item.status === 'needsConfirmation').length,
            needsAttention: results.filter(item => item.status === 'needsAttention').length,
            failures: results.filter(item => item.status === 'failed').length,
            conflicts: results.filter(item => item.status === 'conflict').length,
            cancelled: results.filter(item => item.status === 'cancelled').length
        };
    }

    public async acceptAllPendingChanges(
        textTokens: ReviewToken[] = this.getReviewTokens(),
        opaqueTokens: OpaqueReviewToken[] = this.getOpaqueReviewTokens(),
        unknownPaths: string[] = this.getUnknownReviewPaths()
    ): Promise<MixedBatchActionResult> {
        const results: ActionResult[] = [];
        const acceptedPaths = new Set<string>();
        const acknowledgedPaths = new Set<string>();
        for (const token of [...textTokens]) {
            const result = await this.keepAllChangesInFile(token.filePath, token);
            results.push(result);
            if (result.status === 'success') { acceptedPaths.add(token.filePath); }
        }
        for (const token of [...opaqueTokens]) {
            const result = await this.acknowledgeOpaqueChange(token.filePath, token);
            results.push(result);
            if (result.status === 'success') { acknowledgedPaths.add(token.filePath); }
        }
        for (const filePath of [...new Set(unknownPaths)]) {
            const current = this.trackedChanges.get(filePath);
            results.push(current?.reviewKind === 'unknown'
                ? this.actionResult(filePath, 'needsAttention', current.reviewReason ?? current.unavailableReason ?? 'Review evidence is incomplete')
                : this.actionResult(filePath, 'conflict', 'Review changed before the mixed Accept action completed'));
        }
        return this.mixedBatchResult(results, acceptedPaths, acknowledgedPaths, new Set());
    }

    public async revertAllPendingChanges(
        textTokens: ReviewToken[] = this.getReviewTokens(),
        opaquePaths: string[] = this.getOpaqueReviewTokens().map(token => token.filePath),
        unknownPaths: string[] = this.getUnknownReviewPaths()
    ): Promise<MixedBatchActionResult> {
        const textResult = await this.revertAllChanges(textTokens);
        const results = [...textResult.results];
        const revertedPaths = new Set(textResult.results.filter(item => item.status === 'success').map(item => item.filePath));
        for (const filePath of [...new Set(opaquePaths)]) {
            const current = this.trackedChanges.get(filePath);
            results.push(current?.reviewKind === 'opaque'
                ? this.actionResult(filePath, 'needsConfirmation', 'Read-only changes cannot be reverted; acknowledge or inspect them separately')
                : this.actionResult(filePath, 'conflict', 'Read-only review changed before the mixed Revert action completed'));
        }
        for (const filePath of [...new Set(unknownPaths)]) {
            const current = this.trackedChanges.get(filePath);
            results.push(current?.reviewKind === 'unknown'
                ? this.actionResult(filePath, 'needsAttention', current.reviewReason ?? current.unavailableReason ?? 'Review evidence is incomplete')
                : this.actionResult(filePath, 'conflict', 'Unknown review changed before the mixed Revert action completed'));
        }
        return this.mixedBatchResult(results, new Set(), new Set(), revertedPaths);
    }

    public revertAllChanges(tokens: ReviewToken[] = this.getReviewTokens()): Promise<BatchActionResult> {
        const epoch = this.sessionEpoch;
        const reviewedTokens = [...tokens];
        return this.queueRecoveryAction(() => this.isCurrentEpoch(epoch)
            ? this.performRevertAllChanges(reviewedTokens)
            : Promise.resolve({ results: [], succeeded: 0, failed: 0 }));
    }

    private async performRevertAllChanges(tokens: ReviewToken[]): Promise<BatchActionResult> {
        if (tokens.length === 0) { return { results: [], succeeded: 0, failed: 0 }; }
        if (this.gitContextPending) {
            const results = tokens.map(token => this.actionResult(token.filePath, 'conflict', this.getGitPauseReason(token.filePath)));
            return { results, succeeded: 0, failed: results.length };
        }
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
        filePath = this.canonicalTrackingPath(filePath);
        return this.queueRecoveryAction(() => this.revertFileQueued(filePath, token));
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
        if (!preparedBatch && (result.status === 'success' || result.bufferChanged)) { this.preparedHistory.delete(recoveryRecord); }
        if (preparedBatch && (result.status === 'success' || result.bufferChanged)) {
            preparedBatch.retainPaths.add(filePath);
        }
        if (result.status !== 'success') {
            if (!preparedBatch && !result.bufferChanged) { await this.removeRevertRecord(recoveryRecord); }
            return result;
        }
        // Verify persisted state, including existence, before removing this item.
        // Our own save can race a watcher that observes the restored baseline and
        // clears the pending review before this continuation resumes. Treat that
        // as success only when the session, baseline revision and current bytes
        // still prove the exact reviewed target was restored.
        const current = await this.readCurrentFileState(filePath);
        const finalTargetError = this.validateActionTarget(filePath);
        if (finalTargetError) {
            return this.actionResult(filePath, 'conflict', finalTargetError, result.bufferChanged);
        }
        const baseline = this.fileSnapshots.get(filePath);
        const baselineExists = this.baselineExistingFiles.has(filePath);
        if (!this.isCurrentEpoch(review.epoch) || baseline === undefined ||
            this.revision(baseline, baselineExists) !== review.baselineRevision) {
            return this.actionResult(filePath, 'conflict', 'Session or baseline changed during revert', result.bufferChanged);
        }
        const currentMatchesBaseline = baselineExists
            ? current.kind === 'text' && current.content === baseline
            : current.kind === 'missing';
        if (!currentMatchesBaseline) {
            return this.actionResult(filePath, 'conflict', 'File does not match the baseline after revert; review retained', result.bufferChanged);
        }
        // Any pending projection left here is stale with respect to the
        // authoritative resource state we just verified. This includes late
        // watcher/document events from our own write. A genuinely newer state
        // (dirty, unreadable, deleted, binary, or different text) cannot reach
        // this branch because readCurrentFileState/currentMatchesBaseline above
        // rejects it.
        this.clearFileReview(filePath);
        this.schedulePersistState();
        return result;
    }

    private async readUndoCurrentState(item: PersistedRevertItem): Promise<CurrentFileState> {
        const document = vscode.workspace.textDocuments.find(doc => doc.uri.scheme === 'file' && this.canonicalTrackingPath(doc.uri.fsPath) === item.filePath);
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
        const afterReadError = this.validateActionTarget(item.filePath);
        if (afterReadError) { return this.actionResult(item.filePath, 'conflict', afterReadError); }
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
            // WorkspaceEdit.deleteFile has no expected-content/version condition.
            // Re-reading cannot protect a replacement while applyEdit is pending.
            return this.actionResult(item.filePath, 'conflict', 'Recovery would delete a restored file. Inspect and delete it manually, then retry Undo; the recovery record is retained');
        }
        if (!item.after.exists) {
            this.pendingWriteFiles.add(item.filePath);
            this.activeWriteFiles.add(item.filePath);
            let bufferChanged = false;
            try {
                const result = await this.createFileExclusively(item.filePath, item.before.content, epoch, item.before.mode);
                bufferChanged = !!result.bufferChanged;
                if (result.status !== 'success') { return result; }
                bufferChanged = false;
            } finally {
                if (this.isCurrentEpoch(epoch)) {
                    this.activeWriteFiles.delete(item.filePath);
                    if (!bufferChanged) { this.pendingWriteFiles.delete(item.filePath); }
                }
            }
            this.updateTrackedDiff(item.filePath, item.before.content, { currentExists: true });
            return this.actionResult(item.filePath, 'success', undefined, true);
        }

        const document = await vscode.workspace.openTextDocument(uri);
        if (item.saveMode === 'disk' && document.isDirty) {
            return this.actionResult(item.filePath, 'conflict', 'Unsaved editor changes appeared after revert; recovery blocked');
        }
        const canRecover = async (expectedDocument: string): Promise<boolean> => {
            const disk = item.saveMode === 'disk' ? await this.readFileSnapshot(uri) : undefined;
            return this.isCurrentEpoch(epoch) && !this.validateActionTarget(item.filePath)
                && this.revision(this.fileSnapshots.get(item.filePath) ?? '', this.baselineExistingFiles.has(item.filePath)) === item.baselineRevision
                && document.getText() === expectedDocument
                && (!disk || (disk.kind === 'text' && disk.content === item.after.content));
        };
        if (!await canRecover(item.after.content) || (item.saveMode === 'disk' && document.isDirty)) {
            return this.actionResult(item.filePath, 'conflict', 'File changed while opening recovery; newer work was preserved');
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
            if (!await canRecover(item.before.content)) {
                return this.actionResult(item.filePath, 'conflict', 'Session, baseline or action target changed during recovery; buffer changed and recovery retained', true);
            }
            if (item.saveMode === 'disk') {
                if (!await canRecover(item.before.content)) {
                    return this.actionResult(item.filePath, 'conflict', 'File changed before recovery save; buffer changed but disk was preserved', true);
                }
                if (!await document.save()) {
                    return this.actionResult(item.filePath, 'failed', 'Recovery changed the buffer but saving failed', true);
                }
            }
            const savedState = item.saveMode === 'disk' ? await this.readFileSnapshot(uri) : undefined;
            if (document.getText() !== item.before.content || (savedState &&
                (savedState.kind !== 'text' || savedState.content !== item.before.content || document.isDirty))) {
                if (this.isCurrentEpoch(epoch)) {
                    this.pendingWriteFiles.delete(item.filePath);
                    this.updateTrackedDiff(item.filePath, document.getText(), { currentExists: true });
                }
                return this.actionResult(item.filePath, 'conflict', 'Recovery contents changed during save; recovery retained', true);
            }
            if (!this.isCurrentEpoch(epoch) || this.validateActionTarget(item.filePath)) {
                return this.actionResult(item.filePath, 'conflict', 'Session or action target changed during recovery; recovery retained', true);
            }
            this.pendingWriteFiles.delete(item.filePath);
            this.updateTrackedDiff(item.filePath, item.before.content, { currentExists: true });
            return this.actionResult(item.filePath, 'success', undefined, true);
        } catch {
            return this.actionResult(item.filePath, this.isCurrentEpoch(epoch) ? 'failed' : 'cancelled',
                'Recovery edit failed or its session changed; recovery retained', document.getText() !== item.after.content);
        } finally {
            if (this.isCurrentEpoch(epoch)) {
                this.activeWriteFiles.delete(item.filePath);
                this.pendingWriteFiles.delete(item.filePath);
            }
        }
    }

    public undoLastRevert(): Promise<BatchActionResult> {
        const epoch = this.sessionEpoch;
        return this.queueRecoveryAction(() => this.performUndoLastRevert(epoch));
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

    private readFileMode(filePath: string): number | undefined {
        try { return fs.statSync(filePath).mode & 0o777; } catch { return undefined; }
    }

    private ensureRestoreParentDirectories(filePath: string, epoch: number): string | undefined {
        const check = (): string | undefined => !this.isCurrentEpoch(epoch)
            ? 'Session changed before restoring parent directories' : this.validateActionTarget(filePath);
        const initialError = check();
        if (initialError) { return initialError; }
        const missing: string[] = [];
        let directory = path.dirname(filePath);
        while (true) {
            try {
                const stat = fs.lstatSync(directory);
                if (stat.isSymbolicLink() || !stat.isDirectory()) { return 'Restore parent is not an ordinary directory'; }
                break;
            } catch (error) {
                if (!this.isFileNotFound(error)) { throw error; }
                missing.push(directory);
                const parent = path.dirname(directory);
                if (parent === directory) { throw error; }
                directory = parent;
            }
        }
        // No await between validation and each mkdir. Never follow a link or
        // replace a conflicting entry, and never recursively remove parents on
        // failure: another writer may already be using an empty directory.
        for (const parent of missing.reverse()) {
            const error = check();
            if (error) { return error; }
            // Directory modes were not captured. Never widen access by inheriting
            // the usual 0777 default; existing directories are left untouched.
            try { fs.mkdirSync(parent, { mode: 0o700 }); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; } }
            const stat = fs.lstatSync(parent);
            if (stat.isSymbolicLink() || !stat.isDirectory()) { return 'Restore parent changed during directory creation'; }
        }
        return check();
    }

    private async createFileExclusively(filePath: string, content: string, epoch: number, mode?: number): Promise<ActionResult> {
        let staging: string | undefined;
        let published = false;
        try {
            const parentError = this.ensureRestoreParentDirectories(filePath, epoch);
            if (parentError) { return this.actionResult(filePath, this.isCurrentEpoch(epoch) ? 'conflict' : 'cancelled', parentError); }
            staging = await fs.promises.mkdtemp(path.join(path.dirname(filePath), '.difftracker-restore-'));
            // Active operations must remain excluded even if they outlive the
            // grace interval. Expiry starts only when their cleanup completes.
            if (!this.disposed) {
                const key = this.creationTempKey(staging);
                const previous = this.creationTempExpiryTimers.get(key);
                if (previous) { clearTimeout(previous); this.creationTempExpiryTimers.delete(key); }
                this.creationTempRoots.add(key);
            }
            if (!this.isCurrentEpoch(epoch)) { return this.actionResult(filePath, 'cancelled', 'Session changed during recovery staging'); }
            const stagingError = this.validateActionTarget(filePath);
            if (stagingError) { return this.actionResult(filePath, 'conflict', stagingError); }
            const payload = path.join(staging, 'content');
            await fs.promises.writeFile(payload, content, { flag: 'wx', mode: 0o600 });
            await fs.promises.chmod(payload, mode ?? (0o666 & ~process.umask()));
            if (!this.isCurrentEpoch(epoch)) { return this.actionResult(filePath, 'cancelled', 'Session changed before file creation'); }
            const error = this.validateActionTarget(filePath);
            if (error) { return this.actionResult(filePath, 'conflict', error); }
            // A hard link publishes fully written bytes atomically, failing if any
            // file/symlink already occupies the destination. Never overwrite it.
            await fs.promises.link(payload, filePath);
            published = true;
            const state = await this.readFileSnapshot(vscode.Uri.file(filePath));
            if (!this.isCurrentEpoch(epoch) || this.validateActionTarget(filePath) ||
                state.kind !== 'text' || state.content !== content) {
                return this.actionResult(filePath, 'conflict', 'Context or content changed during file creation; recovery retained', true);
            }
            return this.actionResult(filePath, 'success', undefined, true);
        } catch (error) {
            return this.actionResult(filePath, 'conflict', `Exclusive file creation failed; no overwrite attempted: ${error instanceof Error ? error.message : String(error)}`, published);
        } finally {
            if (staging) {
                // Only remove our payload; do not recursively delete unexpected files.
                try { fs.unlinkSync(path.join(staging, 'content')); } catch { /* Preserve the action result. */ }
                try { fs.rmdirSync(staging); } catch { /* Never delete unexpected children. */ }
                this.expireCreationTempRoot(staging);
            }
        }
    }

    private creationTempKey(filePath: string): string {
        return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
    }

    private expireCreationTempRoot(staging: string): void {
        const key = this.creationTempKey(staging);
        if (this.disposed) { this.creationTempRoots.delete(key); return; }
        const timer = setTimeout(() => {
            if (this.creationTempExpiryTimers.get(key) !== timer) { return; }
            this.creationTempExpiryTimers.delete(key);
            this.creationTempRoots.delete(key);
        }, this.creationTempGraceMs);
        timer.unref();
        this.creationTempExpiryTimers.set(key, timer);
    }

    private async restoreFileToContent(
        filePath: string,
        content: string,
        options?: { deleteIfMissingInBaseline?: boolean; review?: ReviewToken }
    ): Promise<ActionResult> {
        const epoch = this.sessionEpoch;
        const uri = vscode.Uri.file(filePath);
        const openDoc = vscode.workspace.textDocuments.find(doc => doc.uri.scheme === 'file' && this.canonicalTrackingPath(doc.uri.fsPath) === filePath);
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
                const result = await this.createFileExclusively(filePath, content, epoch, this.fileModes.get(filePath));
                bufferChanged = !!result.bufferChanged;
                return result;
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
            const afterSaveError = this.validateActionTarget(filePath);
            if (afterSaveError) { return this.actionResult(filePath, 'conflict', afterSaveError, true); }
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
        const doc = vscode.workspace.textDocuments.find(value => value.uri.scheme === 'file' && this.canonicalTrackingPath(value.uri.fsPath) === filePath);
        if (doc?.isDirty) {
            return this.actionResult(filePath, 'conflict', 'Unsaved editor changes; file skipped');
        }
        try {
            if (review && !await this.verifyReview(review)) { return this.actionResult(filePath, 'conflict', 'Review changed before deletion'); }
            const targetError = this.validateActionTarget(filePath);
            if (targetError) { return this.actionResult(filePath, 'conflict', targetError); }
            // Like recovery deletion, this cannot be guarded by an expected file
            // version across an asynchronous WorkspaceEdit. Never dispatch it.
            return this.actionResult(filePath, 'conflict', 'Revert would delete a new file. Inspect and delete it manually; review remains pending until deletion is observed');
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
        filePath = this.canonicalTrackingPath(filePath);
        return this.lineChanges.get(filePath);
    }

    public getOriginalContent(filePath: string): string | undefined {
        filePath = this.canonicalTrackingPath(filePath);
        return this.fileSnapshots.get(filePath);
    }

    public getInlineContent(filePath: string): string | undefined {
        filePath = this.canonicalTrackingPath(filePath);
        const view = this.ensureInlineView(filePath);
        if (!view) {
            return undefined;
        }

        return view.content;
    }

    public getInlineView(filePath: string): InlineDiffView | undefined {
        filePath = this.canonicalTrackingPath(filePath);
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
        filePath = this.canonicalTrackingPath(filePath);
        return this.queueRecoveryAction(() =>
            this.queueFileAction(filePath, token, review => this.revertBlockReviewed(filePath, blockRef, review)));
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
            if (targetError || !await this.verifyReview(review) || doc.isDirty || doc.getText() !== beforeText) {
                await this.removeRevertRecord(recoveryRecord);
                recoveryRecord = undefined;
                return this.actionResult(filePath, 'conflict', targetError ?? 'Review or document changed while persisting recovery');
            }
            const beforeEditError = this.validateActionTarget(filePath);
            if (beforeEditError) {
                await this.removeRevertRecord(recoveryRecord);
                recoveryRecord = undefined;
                return this.actionResult(filePath, 'conflict', beforeEditError);
            }
            this.pendingWriteFiles.add(filePath);
            this.activeWriteFiles.add(filePath);
            const success = await vscode.workspace.applyEdit(edit);
            if (!this.isCurrentEpoch(review.epoch)) {
                return this.actionResult(filePath, 'cancelled', 'Session changed during block edit', doc.getText() !== beforeText);
            }
            const afterEditError = this.validateActionTarget(filePath);
            if (afterEditError || !this.matchesReview(review)) {
                const bufferChanged = doc.getText() !== beforeText;
                if (!bufferChanged) {
                    this.pendingWriteFiles.delete(filePath);
                    await this.removeRevertRecord(recoveryRecord);
                    recoveryRecord = undefined;
                } else {
                    this.markFileUnavailable(filePath, 'Review changed after the editor buffer was modified; recovery retained');
                }
                return this.actionResult(filePath, 'conflict', afterEditError ?? 'Session or review changed during block edit', bufferChanged);
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
            const bufferChanged = !!editedDocument && beforeText !== undefined && editedDocument.getText() !== beforeText;
            if (!this.isCurrentEpoch(review.epoch)) { return this.actionResult(filePath, 'cancelled', 'Session changed during block edit', bufferChanged); }
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
            if (recoveryRecord) { this.preparedHistory.delete(recoveryRecord); }
            if (this.isCurrentEpoch(review.epoch)) { this.activeWriteFiles.delete(filePath); }
        }
    }

    /**
     * Keep a specific change block (accept the changes)
     * Updates the snapshot so this block's changes become the new baseline
     */
    public keepBlock(filePath: string, blockRef: string | number, token = this.getReviewToken(filePath)): Promise<ActionResult> {
        filePath = this.canonicalTrackingPath(filePath);
        return this.queueRecoveryAction(() => this.queueFileAction(filePath, token, review => this.keepBlockReviewed(filePath, blockRef, review)));
    }

    private beginKeepTransaction(filePath: string): BaselineTransaction {
        const content = this.fileSnapshots.get(filePath)!;
        const mode = this.fileModes.get(filePath);
        const exists = this.baselineExistingFiles.has(filePath);
        const history = this.revertHistory;
        const building = this.baselineBuilding;
        const initialized = this.snapshotInitialized;
        const transaction = this.beginBaselineTransaction(() => {
            // Callbacks may have updated or removed the review while the
            // candidate baseline was being persisted. Preserve that newer view.
            const latest = this.trackedChanges.get(filePath);
            const currentContent = latest?.currentContent ?? this.fileSnapshots.get(filePath)!;
            const currentExists = latest ? !latest.isDeleted : this.baselineExistingFiles.has(filePath);
            this.fileSnapshots.set(filePath, content);
            if (mode === undefined) { this.fileModes.delete(filePath); } else { this.fileModes.set(filePath, mode); }
            if (exists) { this.baselineExistingFiles.add(filePath); } else { this.baselineExistingFiles.delete(filePath); }
            this.revertHistory = history;
            this.baselineBuilding = building;
            this.snapshotInitialized = initialized;
            this.updateTrackedDiff(filePath, currentContent, { baselineChanged: true, currentExists });
            if (latest?.unavailableReason) { this.markFileUnavailable(filePath, latest.unavailableReason); }
        });
        transaction.valid = () => !this.validateSnapshotTarget(filePath);
        // Remove only this path's obsolete recovery items, retaining other batch members.
        this.revertHistory = history.map(record => ({ ...record, items: record.items.filter(item => item.filePath !== filePath) }))
            .filter(record => record.items.length > 0);
        const currentMode = this.readFileMode(filePath);
        if (currentMode !== undefined) { this.fileModes.set(filePath, currentMode); }
        return transaction;
    }

    private async commitKeepTransaction(filePath: string, epoch: number, transaction: BaselineTransaction): Promise<boolean> {
        let committed = false;
        try {
            committed = await this.completeBaseline(epoch, transaction) &&
                this.baselineTransaction === transaction && this.isCurrentEpoch(epoch);
            return committed;
        } catch (error) {
            if (this.isCurrentEpoch(epoch)) { this.reportPersistenceIssue('Keep transaction failed; prior baseline retained.', error); }
            return false;
        } finally {
            const invalidTarget = this.isCurrentEpoch(epoch) && transaction.valid && !transaction.valid();
            this.endBaselineTransaction(transaction, committed);
            // A candidate may already have reached disk before target validation
            // failed. Publish the rolled-back baseline before returning failure.
            if (!committed && invalidTarget) { await this.flushPendingPersistence(); }
            if (!committed && this.isCurrentEpoch(epoch)) {
                // Also cover edits with no delivered callback. A dirty buffer
                // remains unavailable, with its latest contents visible.
                const state = await this.readCurrentFileState(filePath);
                if (this.isCurrentEpoch(epoch)) {
                    const doc = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && this.canonicalTrackingPath(d.uri.fsPath) === filePath);
                    if (doc?.isDirty) { this.updateTrackedDiff(filePath, doc.getText(), { baselineChanged: true }); }
                    if (state.kind === 'unavailable') { this.markFileUnavailable(filePath, state.reason); }
                    else { this.updateTrackedDiff(filePath, state.kind === 'text' ? state.content : '', { baselineChanged: true, currentExists: state.kind === 'text' }); }
                }
            }
        }
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
        const doc = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && this.canonicalTrackingPath(d.uri.fsPath) === filePath);
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
        const finalTargetError = this.validateActionTarget(filePath);
        if (finalTargetError) { return this.actionResult(filePath, 'conflict', finalTargetError); }
        const keepEpoch = this.sessionEpoch;
        const transaction = this.beginKeepTransaction(filePath);
        this.fileSnapshots.set(filePath, newSnapshot);
        this.baselineExistingFiles.add(filePath);
        if (!await this.commitKeepTransaction(filePath, keepEpoch, transaction)) {
            return this.actionResult(filePath, 'failed', 'Keep could not be saved; review remains pending');
        }

        // Persistence awaits may admit newer editor/disk changes; never clear them
        // using the content reviewed before the write began.
        if (!this.isCurrentEpoch(keepEpoch)) { return this.actionResult(filePath, 'success', 'Keep saved before the session changed'); }
        const afterKeep = await this.readCurrentFileState(filePath);
        if (!this.isCurrentEpoch(keepEpoch)) { return this.actionResult(filePath, 'success', 'Keep saved before the session changed'); }
        if (afterKeep.kind === 'unavailable') { this.markFileUnavailable(filePath, afterKeep.reason); }
        else { this.updateTrackedDiff(filePath, afterKeep.kind === 'text' ? afterKeep.content : '', { baselineChanged: true, currentExists: afterKeep.kind === 'text' }); }
        return this.actionResult(filePath, 'success');
    }

    /**
     * Keep all changes in a file (accept all changes)
     * Updates the snapshot to match current document content
     */
    public keepAllChangesInFile(filePath: string, token = this.getReviewToken(filePath)): Promise<ActionResult> {
        filePath = this.canonicalTrackingPath(filePath);
        return this.queueRecoveryAction(() => this.queueFileAction(filePath, token, review => this.keepFileReviewed(filePath, review)));
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
        const finalTargetError = this.validateActionTarget(filePath);
        if (finalTargetError) { return this.actionResult(filePath, 'conflict', finalTargetError); }
        const keepEpoch = this.sessionEpoch;
        const transaction = this.beginKeepTransaction(filePath);
        this.fileSnapshots.set(filePath, currentContent);
        if (state.kind === 'missing') {
            this.baselineExistingFiles.delete(filePath);
        } else {
            this.baselineExistingFiles.add(filePath);
        }
        if (!await this.commitKeepTransaction(filePath, keepEpoch, transaction)) {
            return this.actionResult(filePath, 'failed', 'Keep could not be saved; review remains pending');
        }
        if (!this.isCurrentEpoch(keepEpoch)) { return this.actionResult(filePath, 'success', 'Keep saved before the session changed'); }
        this.pendingWriteFiles.delete(filePath);
        const afterKeep = await this.readCurrentFileState(filePath);
        if (!this.isCurrentEpoch(keepEpoch)) { return this.actionResult(filePath, 'success', 'Keep saved before the session changed'); }
        if (afterKeep.kind === 'unavailable') { this.markFileUnavailable(filePath, afterKeep.reason); }
        else { this.updateTrackedDiff(filePath, afterKeep.kind === 'text' ? afterKeep.content : '', { baselineChanged: true, currentExists: afterKeep.kind === 'text' }); }
        return this.actionResult(filePath, 'success');
    }

    /**
     * Get change blocks for a file (used by CodeLens)
     */
    public getChangeBlocks(filePath: string): ChangeBlock[] {
        filePath = this.canonicalTrackingPath(filePath);
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

        const filePath = this.canonicalTrackingPath(doc.uri.fsPath);
        const uri = doc.uri.scheme === 'file' ? vscode.Uri.file(this.canonicalTrackingPath(doc.uri.fsPath)) : doc.uri;
        if (this.retainCoverageGapReview(filePath)) { return; }
        if (this.restoringEpoch === epoch) {
            if (this.restoreEvents.get(filePath)?.kind !== 'create') {
                this.restoreEvents.set(filePath, { uri, kind: 'change' });
            }
            return;
        }
        if (this.deferInitialIgnoreEvent(uri)) { return; }
        this.recordBaselineTransactionEvent(uri, 'change');
        if (this.scopeApplyPreflight && this.pendingScopeExplicitlyExcludes(uri)) {
            this.preserveDeferredScopeApplyEvent(filePath);
            return;
        }
        if (this.deferPendingScopeEvent(uri)) { return; }
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
            if (this.opaqueBaselineFiles.has(filePath)) {
                this.processDocumentChange(doc);
                return;
            }
            this.ensureSnapshotForDocument(doc);
            if (!this.fileSnapshots.has(filePath)) {
                if (!this.snapshotInitialized) {
                    this.scanUncertainFiles.add(filePath);
                    this.recordUnresolvedBaseline(filePath, 'Document changed during baseline scan; before-image is unknown');
                }
                return;
            }
        }

        if (this.scopeApplyPreflight) {
            this.processDocumentChange(doc);
            return;
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

        const filePath = this.canonicalTrackingPath(doc.uri.fsPath);
        const uri = doc.uri.scheme === 'file' ? vscode.Uri.file(this.canonicalTrackingPath(doc.uri.fsPath)) : doc.uri;
        if (this.retainCoverageGapReview(filePath)) { return; }
        if (this.deferInitialIgnoreEvent(uri)) { return; }
        if (this.deferPendingScopeEvent(uri)) { return; }
        if (this.isPathIgnored(uri)) {
            return;
        }

        if (this.pendingWriteFiles.has(filePath)) { return; }
        if (this.opaqueBaselineFiles.has(filePath)) {
            if (doc.isDirty) {
                this.markFileUnavailable(filePath, 'Document changed from an unsupported baseline; original content is unavailable');
            } else {
                // Save/reload/Undo may return an opaque document to its baseline.
                // Verify bytes instead of feeding undecodable content to text diff.
                void this.readFileAndUpdate(filePath, uri).catch(() => undefined);
            }
            return;
        }
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
        filePath = this.canonicalTrackingPath(filePath);
        const tracked = this.trackedChanges.get(filePath);
        if (tracked) {
            return tracked.currentContent;
        }

        const doc = vscode.workspace.textDocuments.find(textDoc => textDoc.uri.scheme === 'file' && this.canonicalTrackingPath(textDoc.uri.fsPath) === filePath);
        return doc?.getText();
    }

    private deferInitialIgnoreEvent(uri: vscode.Uri, kind: StartupEvent['kind'] = 'change'): boolean {
        if (this.initialIgnoreEpoch !== this.sessionEpoch) { return false; }
        const previous = this.initialIgnoreEvents.get(uri.fsPath);
        // First + latest event summarize complete transient incarnations while
        // retaining uncertainty that preceded the first observed creation.
        this.initialIgnoreEvents.set(uri.fsPath, { uri, firstKind: previous?.firstKind ?? kind, kind });
        return true;
    }

    private hasScanUncertainty(filePath: string): boolean {
        for (let current = filePath; ; current = path.dirname(current)) {
            if (this.scanUncertainFiles.has(current)) { return true; }
            if (path.dirname(current) === current) { return false; }
        }
    }

    private ensureSnapshotForDocument(doc: vscode.TextDocument, useDocumentContent = false): void {
        if (!this.isRecording || this.initialIgnoreEpoch === this.sessionEpoch || this.restoringEpoch !== undefined) {
            return;
        }

        if (doc.uri.scheme !== 'file') {
            return;
        }

        const filePath = this.canonicalTrackingPath(doc.uri.fsPath);
        if (this.hasCapturedBaseline(filePath)) {
            return;
        }

        if (this.isPathIgnored(doc.uri)) {
            return;
        }

        if (this.hasScanUncertainty(filePath)) {
            this.recordUnresolvedBaseline(filePath, 'File or parent changed during baseline scan; before-image is unknown');
            return;
        }
        const unresolvedReason = this.unresolvedBaselineFiles.get(filePath);
        if (unresolvedReason ||
            (this.snapshotInitialized && (!this.scanCoverage || this.scanCoverage !== this.ignoreFingerprint))) {
            this.recordUnresolvedBaseline(filePath, 'Path was not covered by the baseline scan; before-image is unknown');
            return;
        }
        if (this.trackedChanges.get(filePath)?.unavailableReason) { return; }
        const targetError = this.validateSnapshotTarget(filePath);
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
            const diskContent = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            const content = useDocumentContent ? doc.getText() : diskContent;
            const contentBytes = useDocumentContent ? new TextEncoder().encode(content) : bytes;
            if (contentBytes.length > 5 * 1024 * 1024 || this.isLikelyBinaryContent(contentBytes)) {
                this.markFileUnavailable(filePath, 'Baseline is unsupported or exceeds the 5 MiB limit');
                return;
            }
            this.fileSnapshots.set(filePath, this.snapshotInitialized ? '' : content);
            this.fileModes.set(filePath, stat.mode & 0o777);
            if (!this.snapshotInitialized) { this.baselineExistingFiles.add(filePath); }
            else { this.updateTrackedDiff(filePath, content); }
        } catch (error) {
            if (!this.isFileNotFound(error)) {
                this.markFileUnavailable(filePath, 'Baseline cannot be read or decoded');
                return;
            }
            this.fileSnapshots.set(filePath, '');
            this.baselineExistingFiles.delete(filePath);
        }
        if (this.snapshotInitialized && this.storageUri) {
            void this.completeBaseline(this.sessionEpoch);
        } else {
            this.schedulePersistState();
        }
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
        this.creationTempExpiryTimers.forEach(timer => clearTimeout(timer));
        this.creationTempExpiryTimers.clear();
        this.creationTempRoots.clear();
        await this.flushPendingPersistence();
        this.clearExternalChangeTimers();
        this.clearDocumentChangeTimers();
        this.clearWatcherSuppressionTimers();
        this.clearAutomationSessions();
        this.disposeFileWatchers();
        this.importedDirectoryWatchers.clear();
        this.disposables.forEach(d => d.dispose());
        this._onDidChangeRecordingState.dispose();
        this._onDidTrackChanges.dispose();
        this._onDidChangeBaselineState.dispose();
    }
}
