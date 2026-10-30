import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { DiffTracker, ObservationCoverageRecheckResult, ScopeOperationObservation } from './diffTracker';
import { detectLocalPathCaseSensitivity } from './utils/pathIdentity';
import {
    CanonicalMonitoringScope,
    configuredScopeExplicitlyExcludesSubtree,
    evaluateConfiguredScope,
    createLegacySourceFingerprint,
    createScopeConsentRecord,
    createScopeMigrationRecord,
    detectScopeExpansion,
    EffectiveMonitoringScope,
    MonitoringScopeRequest,
    previewLegacyWatchExcludeMigration,
    scopeConsentMatches,
    scopeMigrationMatches,
    ScopeValidationResult,
    validateAndCanonicalizeScope,
    WorkspaceRootIdentity
} from './monitoringScope';

const CONSENT_KEY = 'diffTracker.monitoringScope.consent.v1';
const DISMISSED_KEY = 'diffTracker.monitoringScope.dismissedRevision.v1';
const MIGRATION_KEY = 'diffTracker.monitoringScope.legacyMigration.v2';
const LEGACY_MIGRATION_KEY = 'diffTracker.monitoringScope.legacyMigration.v1';
const SCOPE_SETTINGS_KEYS = ['monitoringScope', 'watchInclude', 'watchExclude'] as const;
type ScopeSettings = Record<typeof SCOPE_SETTINGS_KEYS[number], unknown>;

class ScopeSettingsOwnershipConflict extends Error {}

type LegacySourceValueEvidence =
    | { kind: 'unset' }
    | { kind: 'value'; value: unknown };

interface LegacySourceSnapshot {
    model: 1;
    semanticsModel: 'legacy-watch-exclude-v1';
    roots: WorkspaceRootIdentity[];
    global: LegacySourceValueEvidence;
    workspace: LegacySourceValueEvidence;
    folders: Array<{
        root: WorkspaceRootIdentity;
        workspaceFolder: LegacySourceValueEvidence;
        effective: LegacySourceValueEvidence;
    }>;
}

export interface MonitoringScopeStatus {
    requested: ScopeValidationResult;
    rawRequested: { mode: unknown; includes: unknown; excludes: unknown };
    effective: EffectiveMonitoringScope;
    consented: boolean;
    dismissed: boolean;
    legacyMigrationComplete: boolean;
    legacyGlobalRules: string[];
    legacyCommittedRules: Array<[string, string[]]>;
    workspaceRequestPresent: boolean;
    expansionReasons: string[];
    explicitlyExcludedPendingReviews: string[];
}

export interface MonitoringScopeApplyOutcome {
    status: 'applied' | 'invalid' | 'needsMigration' | 'needsConsent' |
        'needsDiscardConfirmation' | 'requiresS4' | 'failed' | 'conflict' | 'restored' | 'partial' | 'cancelled' | 'saved';
    reason?: string;
    expansionReasons?: string[];
    affectedReviewPaths?: string[];
    affectedReviewRevision?: string;
    scopeRevision?: string;
    settingsStatus?: 'unchanged' | 'saved' | 'restored' | 'partial';
    scopeCommitted?: boolean;
    coverageStatus?: 'verified' | 'limited' | 'deferred' | 'notRun';
    unrelatedCoverageGaps?: Array<[string,string]>;
}

export interface MonitoringScopeConfirmation {
    scopeRevision: string;
    expansionReasons: readonly string[];
    affectedReviewPaths: readonly string[];
}

export class MonitoringScopeController implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];
    private scopeSettingsWriteQueue: Promise<void> = Promise.resolve();
    private pendingScopeSettingsWrites = 0;
    private scopeActionInProgress = false;
    private confirmedQuickScopeRevision?: string;
    private confirmedSettings?: {expected:ScopeSettings; roots:string; effective:string};
    private disposed = false;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly tracker: DiffTracker
    ) {
        this.reconcileRequestedScope();
        this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
            if (
                event.affectsConfiguration('diffTracker.monitoringScope') ||
                event.affectsConfiguration('diffTracker.watchInclude') ||
                event.affectsConfiguration('diffTracker.watchExclude')
            ) {
                this.reconcileRequestedScope();
            }
        }));
    }

    public reconcileRequestedScope(): void {
        if (this.disposed) { return; }
        const requested = this.getRequestedScope();
        const effective = this.tracker.getEffectiveMonitoringScope();
        const scope = requested.ok ? requested.scope : undefined;
        const pending = scope && (effective.kind !== 'configured' || effective.scopeRevision !== scope.scopeRevision)
            ? scope
            : undefined;
        // A confirmed quick action owns its exact request until Apply settles.
        // It is not a manual, unconfirmed settings edit: keep the old effective
        // observation live instead of manufacturing Unknown before committing.
        if (pending?.scopeRevision === this.confirmedQuickScopeRevision && this.confirmedQuickScopeRevision) { return; }
        const owned = this.confirmedSettings;
        if (owned && this.settingsFingerprint() === this.settingsFingerprint(owned.expected) &&
            JSON.stringify(this.getWorkspaceRoots()) === owned.roots &&
            createLegacySourceFingerprint(effective) === owned.effective) { return; }
        this.tracker.setPendingMonitoringScope(pending);
    }

    public dispose(): void {
        this.disposed = true;
        for (const disposable of this.disposables.splice(0)) { disposable.dispose(); }
    }

    public recheckObservationCoverage(): Promise<ObservationCoverageRecheckResult> {
        this.reconcileRequestedScope();
        const requested = this.getRequestedScope();
        if (!requested.ok) {
            return Promise.resolve({ status: 'conflict', reason: 'Correct the invalid monitoring-scope request before rechecking observation coverage.' });
        }
        return this.tracker.recheckObservationCoverage();
    }

    public getWorkspaceRoots(): WorkspaceRootIdentity[] {
        return (vscode.workspace.workspaceFolders ?? [])
            .filter(folder => folder.uri.scheme === 'file')
            .map(folder => ({
                name: folder.name,
                uri: folder.uri.toString(),
                caseSensitive: detectLocalPathCaseSensitivity(folder.uri.fsPath)
            }))
            .sort((a, b) => a.uri.localeCompare(b.uri) || a.name.localeCompare(b.name));
    }

    private inspectWorkspaceValue<T>(key: string): T | undefined {
        const config = vscode.workspace.getConfiguration('diffTracker');
        const inspected = typeof config.inspect === 'function' ? config.inspect<T>(key) : undefined;
        return inspected?.workspaceValue;
    }

    private hasWorkspaceScopeRequest(): boolean {
        return this.inspectWorkspaceValue<unknown>('monitoringScope') !== undefined ||
            this.inspectWorkspaceValue<unknown>('watchInclude') !== undefined ||
            (this.inspectWorkspaceValue<unknown>('watchExclude') !== undefined &&
                !this.isLegacyStringArray(this.inspectWorkspaceValue<unknown>('watchExclude')));
    }

    private isLegacyStringArray(value: unknown): value is string[] {
        return Array.isArray(value) && value.every(entry => typeof entry === 'string');
    }

    public getLegacyWatchRules(): string[] {
        // This aggregate is only for migration UI/gating. Matching itself uses
        // each resource's merged configuration, never this union.
        const rules = new Set(this.getLegacyGlobalRules());
        const workspace = this.inspectWorkspaceValue<unknown>('watchExclude');
        if (this.isLegacyStringArray(workspace)) { workspace.forEach(rule => rules.add(rule)); }
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const config = vscode.workspace.getConfiguration('diffTracker', folder.uri);
            const value = typeof config.inspect === 'function' ? config.inspect<unknown>('watchExclude')?.workspaceFolderValue : undefined;
            if (this.isLegacyStringArray(value)) { value.forEach(rule => rules.add(rule)); }
        }
        return [...rules];
    }

    private getCommittedLegacyRules(): Array<[string, string[]]> {
        return this.tracker.getCommittedLegacyCompatibilityPolicy();
    }

    private legacyMigrationRequired(
        liveRules = this.getLegacyWatchRules(),
        committedRules = this.getCommittedLegacyRules()
    ): boolean {
        return this.tracker.getEffectiveMonitoringScope().kind === 'legacyV3' &&
            (liveRules.length > 0 || committedRules.some(([, patterns]) => patterns.length > 0));
    }

    private getManualApprovedSourceFingerprint(roots = this.getWorkspaceRoots()): string {
        if (this.getLegacyWatchRules().length > 0) {
            return this.getLegacySourceFingerprint(roots);
        }
        const committedRules = this.getCommittedLegacyRules()
            .filter(([, patterns]) => patterns.length > 0);
        if (committedRules.length === 0) {
            return this.getLegacySourceFingerprint(roots);
        }
        return createLegacySourceFingerprint({
            model: 1,
            semanticsModel: 'legacy-watch-exclude-v1',
            evidenceKind: 'committed-effective-policy-after-source-replacement',
            roots: roots.map(root => ({ ...root })),
            effectiveByRoot: committedRules.map(([rootUri, patterns]) => ({
                rootUri,
                patterns: [...patterns]
            }))
        });
    }

    private legacySourceValue(value: unknown): LegacySourceValueEvidence {
        return value === undefined ? { kind: 'unset' } : { kind: 'value', value };
    }

    private getLegacySourceSnapshot(roots = this.getWorkspaceRoots()): LegacySourceSnapshot {
        const config = vscode.workspace.getConfiguration('diffTracker');
        const inspected = typeof config.inspect === 'function'
            ? config.inspect<unknown>('watchExclude')
            : undefined;
        const folders = roots.map(root => {
            const folder = (vscode.workspace.workspaceFolders ?? [])
                .find(candidate => candidate.uri.toString() === root.uri);
            if (!folder) {
                return {
                    root: { ...root },
                    workspaceFolder: this.legacySourceValue(undefined),
                    effective: this.legacySourceValue(undefined)
                };
            }
            const scoped = vscode.workspace.getConfiguration('diffTracker', folder.uri);
            const scopedInspected = typeof scoped.inspect === 'function'
                ? scoped.inspect<unknown>('watchExclude')
                : undefined;
            return {
                root: { ...root },
                workspaceFolder: this.legacySourceValue(scopedInspected?.workspaceFolderValue),
                effective: this.legacySourceValue(scoped.get<unknown>('watchExclude'))
            };
        });
        return {
            model: 1,
            semanticsModel: 'legacy-watch-exclude-v1',
            roots: roots.map(root => ({ ...root })),
            global: this.legacySourceValue(inspected?.globalValue),
            workspace: this.legacySourceValue(inspected?.workspaceValue),
            folders
        };
    }

    private getLegacySourceFingerprint(roots = this.getWorkspaceRoots()): string {
        return createLegacySourceFingerprint(this.getLegacySourceSnapshot(roots));
    }

    private migrationUnaffectedSourcesMatch(before: LegacySourceSnapshot, after: LegacySourceSnapshot, workspaceFile: string | undefined): boolean {
        if (vscode.workspace.workspaceFile?.toString() !== workspaceFile) { return false; }
        const aliasesWorkspace = !workspaceFile && before.roots.length === 1 && after.roots.length === 1 &&
            before.folders.length === 1 && after.folders.length === 1 &&
            before.folders[0].root.uri === after.folders[0].root.uri &&
            [before,after].every(snapshot => createLegacySourceFingerprint(snapshot.folders[0].workspaceFolder) ===
                createLegacySourceFingerprint(snapshot.workspace));
        const projection = (snapshot: LegacySourceSnapshot) => ({
            model: snapshot.model,
            semanticsModel: snapshot.semanticsModel,
            roots: snapshot.roots,
            global: snapshot.global,
            folders: snapshot.folders.map(folder => ({
                root: folder.root,
                // In a single-folder window VS Code exposes the same source
                // as Workspace and Folder configuration. Its owned Workspace
                // update is not an independent Folder edit. A workspace file,
                // multiple roots, or differing values keep the strict guard.
                workspaceFolder: aliasesWorkspace ? {kind:'workspaceAlias'} : folder.workspaceFolder
            }))
        });
        return createLegacySourceFingerprint(projection(before)) ===
            createLegacySourceFingerprint(projection(after));
    }

    private migrationRecordMatches(scopeRevision: string, roots = this.getWorkspaceRoots()): boolean {
        return scopeMigrationMatches(
            this.context.workspaceState.get(MIGRATION_KEY),
            roots,
            this.getLegacySourceFingerprint(roots),
            scopeRevision
        );
    }

    public getRequestedRawScope(): { mode: unknown; includes: unknown; excludes: unknown } {
        const mode = this.inspectWorkspaceValue<unknown>('monitoringScope');
        const includes = this.inspectWorkspaceValue<unknown>('watchInclude');
        const excludes = this.inspectWorkspaceValue<unknown>('watchExclude');
        return {
            mode: mode === undefined ? 'rules' : mode,
            includes: includes === undefined ? [] : includes,
            excludes: excludes === undefined ||
                (this.tracker.getEffectiveMonitoringScope().kind === 'legacyV3' && this.isLegacyStringArray(excludes))
                ? [] : excludes
        };
    }

    public getRequestedScope(): ScopeValidationResult {
        return validateAndCanonicalizeScope(this.getRequestedRawScope(), this.getWorkspaceRoots());
    }

    public getLegacyGlobalRules(): string[] {
        const config = vscode.workspace.getConfiguration('diffTracker');
        const inspected = typeof config.inspect === 'function' ? config.inspect<unknown[]>('watchExclude') : undefined;
        const raw = inspected?.globalValue ?? [];
        if (!Array.isArray(raw)) { return []; }
        return raw.filter((entry): entry is string => typeof entry === 'string');
    }

    public getStatus(): MonitoringScopeStatus {
        const requested = this.getRequestedScope();
        const effective = this.tracker.getEffectiveMonitoringScope();
        const canonical = requested.ok ? requested.scope : undefined;
        const dismissedRevision = this.context.workspaceState.get<string>(DISMISSED_KEY);
        const expansionReasons = canonical
            ? effective.kind === 'configured'
                ? detectScopeExpansion(effective, canonical).reasons
                : [
                    ...(canonical.mode === 'wholeWorkspace' ? ['Whole Workspace mode requires expanded monitoring coverage.'] : []),
                    ...canonical.includes.map(rule => `Explicit include requires local authorization: ${rule.scope === 'folder' ? rule.folder + ':' : ''}${rule.path}`)
                ]
            : [];
        const legacyGlobalRules = this.getLegacyWatchRules();
        const legacyCommittedRules = this.getCommittedLegacyRules();
        const migrationRequired = effective.kind === 'legacyV3' &&
            (legacyGlobalRules.length > 0 || legacyCommittedRules.some(([, patterns]) => patterns.length > 0));
        return {
            requested,
            rawRequested: this.getRequestedRawScope(),
            effective,
            consented: !!canonical && scopeConsentMatches(this.context.workspaceState.get(CONSENT_KEY), canonical),
            dismissed: !!canonical && dismissedRevision === canonical.scopeRevision,
            legacyMigrationComplete: !migrationRequired ||
                (!!canonical && this.migrationRecordMatches(canonical.scopeRevision)),
            legacyGlobalRules,
            legacyCommittedRules,
            workspaceRequestPresent: this.hasWorkspaceScopeRequest(),
            expansionReasons,
            explicitlyExcludedPendingReviews: canonical ? this.tracker.getExplicitlyExcludedPendingReviewPaths(canonical) : []
        };
    }

    public hasPendingScopeSettingsWrites(): boolean {
        return this.pendingScopeSettingsWrites > 0;
    }

    public hasActiveScopeAction(): boolean {
        return this.disposed || this.scopeActionInProgress || this.hasPendingScopeSettingsWrites();
    }

    private enqueueScopeSettingsWrite<T>(write: () => Promise<T>): Promise<T> {
        // Ownership starts before the queue runs and lasts through settlement,
        // including after an editor closes while its settings save is pending.
        this.pendingScopeSettingsWrites++;
        const operation = this.scopeSettingsWriteQueue.then(write).finally(() => {
            this.pendingScopeSettingsWrites--;
        });
        this.scopeSettingsWriteQueue = operation.then(() => undefined, () => undefined);
        return operation;
    }

    private async updateOwnedScopeSetting(
        config: vscode.WorkspaceConfiguration,
        key: typeof SCOPE_SETTINGS_KEYS[number],
        value: unknown,
        before: ScopeSettings,
        expected: ScopeSettings
    ): Promise<void> {
        const beforeFingerprint = this.settingsFingerprint(before);
        const expectedFingerprint = this.settingsFingerprint(expected);
        let responded = false;
        let settled = false;
        let observedExpected = false;
        let conflict: Error | undefined;
        let finish!: (error?: Error) => void;
        const publication = new Promise<Error | undefined>(resolve => {
            finish = error => {
                if (settled) { return; }
                settled = true;
                resolve(error);
            };
        });
        const inspect = () => {
            if (settled) { return; }
            try {
                const current = this.settingsFingerprint();
                if (current !== expectedFingerprint && (current !== beforeFingerprint || observedExpected)) {
                    conflict ??= new ScopeSettingsOwnershipConflict('Workspace settings changed during the save while its publication was settling; their current values were preserved.');
                }
                if (current === expectedFingerprint) { observedExpected = true; }
                if (responded && (conflict || current === expectedFingerprint)) { finish(conflict); }
            } catch (error) {
                conflict ??= new Error(`Scope settings readback could not be verified: ${String(error)}`);
                if (responded) { finish(conflict); }
            }
        };
        // Configuration update acknowledgement and the observable configuration
        // cache are separate boundaries. Watch before writing, so an owned
        // delayed notification is not mistaken for an external replacement.
        const listener = vscode.workspace.onDidChangeConfiguration(event => {
            if (SCOPE_SETTINGS_KEYS.some(setting => event.affectsConfiguration(`diffTracker.${setting}`))) { inspect(); }
        });
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            await config.update(key, value, vscode.ConfigurationTarget.Workspace);
            responded = true;
            inspect();
            if (!settled) {
                // A deadline bounds missing publication; it is not a delay or a
                // retry. A matching event completes immediately, with one write.
                timeout = setTimeout(() => finish(new Error(
                    'The settings update was acknowledged, but its saved request could not be verified. Review the current Workspace request before retrying.'
                )), 2000);
            }
            const error = await publication;
            if (error) { throw error; }
        } finally {
            if (timeout) { clearTimeout(timeout); }
            listener.dispose();
        }
    }

    /**
     * Stages a directory-only exclusion in Workspace Settings, never Applies it.
     * The UI must refuse to call this while a scope-editor draft may be unsaved.
     */
    public requestExcludeCoverageSubtree(targetPath: string): Promise<{ status: 'saved' | 'alreadyExcluded' | 'blocked'; reason?: string }> {
        // Merge only after all earlier scope-setting writes have finished.
        return this.enqueueScopeSettingsWrite(() => this.saveCoverageSubtreeExclusion(targetPath));
    }

    public requestExcludeResource(targetPath: string, directory: boolean): Promise<{ status: 'saved' | 'alreadyExcluded' | 'blocked'; reason?: string }> {
        return this.enqueueScopeSettingsWrite(() => this.saveCoverageSubtreeExclusion(targetPath, false, directory));
    }

    public excludeCoverageSubtree(
        targetPath: string, confirm: (affectedReviewPaths: readonly string[]) => Promise<boolean>,
        stillCurrent: () => boolean = () => true
    ): ReturnType<MonitoringScopeController['excludeResource']> {
        return this.excludeResource(targetPath, true, confirm, true, stillCurrent);
    }

    /** Confirm a quick exclusion before saving settings or pausing any reads. */
    public async excludeResource(
        targetPath: string,
        directory: boolean,
        confirm: (affectedReviewPaths: readonly string[]) => Promise<boolean>,
        requireCoverage = false,
        stillCurrent: () => boolean = () => true
    ): Promise<MonitoringScopeApplyOutcome | { status: 'cancelled' | 'alreadyExcluded' | 'blocked'; reason?: string }> {
        const conflict = (reason: string): MonitoringScopeApplyOutcome => ({ status: 'conflict', reason });
        if (this.hasActiveScopeAction() || !stillCurrent()) {
            return conflict('Another monitoring-scope action is in progress; retry after it finishes.');
        }
        const initial = this.getStatus();
        let observationBefore: ScopeOperationObservation | undefined;
        let settingsOwnershipLost = false;
        if (!initial.requested.ok || !initial.requested.scope || initial.effective.kind !== 'configured' ||
            initial.requested.scope.scopeRevision !== initial.effective.scopeRevision) {
            return conflict('Apply or restore the existing monitoring-scope request in Manage Monitoring Scope before using a quick exclusion.');
        }
        const proposal = this.prepareResourceExclusion(targetPath, requireCoverage, directory);
        if (proposal.status !== 'ready') { return proposal; }
        const scope = proposal.scope;
        const affectedReviewPaths = this.tracker.getExplicitlyExcludedPendingReviewPaths(scope);
        const approvedReviewRevision = this.tracker.getExplicitlyExcludedReviewRevision(scope);
        const rawExcludes = this.inspectWorkspaceValue<unknown>('watchExclude');
        const previousExcludes = rawExcludes === undefined ? undefined : JSON.parse(JSON.stringify(rawExcludes));
        this.scopeActionInProgress = true;
        try {
            if (affectedReviewPaths.length > 0 && !await confirm(affectedReviewPaths)) { return { status: 'cancelled' }; }
            return await this.enqueueScopeSettingsWrite(async () => {
                const latest = this.getStatus();
                const fresh = this.prepareResourceExclusion(targetPath, requireCoverage, directory);
                if (this.disposed || !stillCurrent() || latest.effective.kind !== 'configured' || latest.effective.scopeRevision !== initial.effective.scopeRevision ||
                    latest.requested.scope?.scopeRevision !== proposal.current.scopeRevision ||
                    fresh.status !== 'ready' || fresh.scope.scopeRevision !== scope.scopeRevision ||
                    this.tracker.getExplicitlyExcludedReviewRevision(scope) !== approvedReviewRevision) {
                    return conflict('Scope, workspace or affected review changed during confirmation; nothing was excluded. Review the current state and retry.');
                }
                this.confirmedQuickScopeRevision = scope.scopeRevision;
                let outcome: MonitoringScopeApplyOutcome = { status: 'failed' };
                try {
                    const saved = await this.saveCoverageSubtreeExclusion(targetPath, requireCoverage, directory);
                    if (saved.status !== 'saved') {
                        settingsOwnershipLost = saved.settingsOwnershipLost === true;
                        outcome = settingsOwnershipLost
                            ? {status:'partial',settingsStatus:'partial',scopeCommitted:false,coverageStatus:'notRun',
                                reason:`The exclusion was not applied. Current Workspace settings were preserved after an observed competing change. ${saved.reason ?? ''}`}
                            : conflict(saved.reason ?? 'The exclusion request changed before it could be saved.');
                    } else {
                        observationBefore = this.tracker.captureScopeOperationObservation();
                        outcome = await this.performPendingScopeApply({
                            discardExplicitlyExcludedReviews: affectedReviewPaths.length > 0,
                            expectedScopeRevision: scope.scopeRevision,
                            expectedAffectedReviewRevision: approvedReviewRevision,
                            requestGuard:stillCurrent,
                            scopeOperation:observationBefore
                        });
                    }
                } catch (error) {
                    outcome = { status: 'failed', reason: `Quick exclusion failed: ${error instanceof Error ? error.message : String(error)}` };
                } finally {
                    try {
                        // Compensate only our still-current request. An external
                        // settings edit must not be overwritten by old values.
                        const effective = this.tracker.getEffectiveMonitoringScope();
                        if (!settingsOwnershipLost && outcome.status !== 'applied' && effective.scopeRevision === initial.effective.scopeRevision &&
                            this.getRequestedScope().scope?.scopeRevision === scope.scopeRevision) {
                            await vscode.workspace.getConfiguration('diffTracker').update(
                                'watchExclude', previousExcludes, vscode.ConfigurationTarget.Workspace);
                        }
                    } catch (error) {
                        outcome = { status: 'failed', reason: `Exclusion was not applied and its settings could not be restored. Use Restore Effective Scope Configuration, then Recheck Observation Coverage. ${String(error)}` };
                    } finally {
                        this.confirmedQuickScopeRevision = undefined;
                        this.reconcileRequestedScope();
                    }
                }
                return outcome.status === 'applied' ? this.finalizeScopeOperation({...outcome,settingsStatus:'saved',scopeCommitted:true},initial.effective,initial.requested.scope,false,observationBefore) : outcome;
            });
        } finally {
            if (observationBefore) { observationBefore.activity.active = false; }
            this.scopeActionInProgress = false;
        }
    }

    private prepareResourceExclusion(targetPath: string, requireCoverage: boolean, directory: boolean) {
        const blocked = (reason: string) => ({ status: 'blocked' as const, reason });
        if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath)) {
            return blocked('Choose a valid absolute monitored directory.');
        }
        const canonicalPath = path.resolve(targetPath);
        if (!requireCoverage) {
            try {
                const stat = fs.lstatSync(canonicalPath);
                if (stat.isSymbolicLink() || stat.isDirectory() !== directory || (!stat.isDirectory() && !stat.isFile())) {
                    return blocked('The selected resource kind changed or is unsupported; refresh and choose the intended file or folder again.');
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    return blocked('The selected resource identity could not be verified; refresh before excluding it.');
                }
                // Deleted review paths remain valid literal scope targets.
            }
        }
        if (requireCoverage && !this.tracker.getSubtreeCoverageGaps().some(gap => path.resolve(gap.targetPath) === canonicalPath)) {
            return blocked('The coverage warning no longer exists. Refresh Change Recording.');
        }
        const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(canonicalPath));
        if (!folder || folder.uri.scheme !== 'file') {
            return blocked('The warned directory is outside the active local workspace.');
        }
        const relative = path.relative(folder.uri.fsPath, canonicalPath).split(path.sep).join('/');
        if (!relative || relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) {
            return blocked('Cannot exclude the entire workspace root or a directory outside it.');
        }
        // A literal path must not be interpreted as a glob or ignore comment.
        if (relative.split('/').some(segment => !segment || segment === '.' || segment === '..' ||
            /^[#!]/.test(segment) || segment.trim() !== segment || /[\\*?\[\]{}]/.test(segment))) {
            return blocked('This directory name cannot be expressed as an exact exclusion without glob expansion.');
        }

        const status = this.getStatus();
        if (!status.requested.ok || !status.requested.scope) {
            return blocked('The requested monitoring scope is invalid. Fix it in Manage Monitoring Scope first.');
        }
        if (!status.legacyMigrationComplete) {
            return blocked('Finish legacy watch-rule migration before adding a structured exclusion.');
        }
        const roots = this.getWorkspaceRoots();
        if (roots.filter(root => root.name === folder.name).length !== 1) {
            return blocked('Workspace folder names are ambiguous; rename the roots before creating a folder-scoped exclusion.');
        }
        const identity = roots.find(root => root.uri === folder.uri.toString() && root.name === folder.name);
        if (!identity) { return blocked('The owning workspace folder changed. Refresh the scope manager.'); }
        const current = status.requested.scope;
        const excludesTarget = (scope: CanonicalMonitoringScope): boolean => directory
            ? configuredScopeExplicitlyExcludesSubtree(scope, identity, relative)
            : evaluateConfiguredScope(scope, identity, relative, false, false).source === 'explicitExclude';
        if (excludesTarget(current)) {
            return { status: 'alreadyExcluded' as const };
        }
        const rule = roots.length === 1
            ? { scope: 'all' as const, pattern: `/${relative}${directory ? '/' : ''}` }
            : { scope: 'folder' as const, folder: folder.name, pattern: `/${relative}${directory ? '/' : ''}` };
        const next: MonitoringScopeRequest = {
            mode: current.mode, includes: current.includes,
            excludes: [...current.excludes, rule]
        };
        const checked = validateAndCanonicalizeScope(next, roots);
        if (!checked.ok || !checked.scope ||
            !excludesTarget(checked.scope)) {
            return blocked('The exact directory exclusion cannot be validated for this workspace.');
        }
        return { status: 'ready' as const, canonicalPath, folder, current, scope: checked.scope, baseStatus: status };
    }

    private async saveCoverageSubtreeExclusion(targetPath: string, requireCoverage = true, directory = true): Promise<{ status: 'saved' | 'alreadyExcluded' | 'blocked'; reason?: string; settingsOwnershipLost?: boolean }> {
        const blocked = (reason: string) => ({ status: 'blocked' as const, reason });
        const proposal = this.prepareResourceExclusion(targetPath, requireCoverage, directory);
        if (proposal.status !== 'ready') { return proposal; }
        const { canonicalPath, folder, current, baseStatus: status } = proposal;
        const checked = { scope: proposal.scope };
        try {
            if (status.effective.kind === 'legacyV3' &&
                !await this.tracker.prepareLegacyCompatibilityPolicySnapshot()) {
                return blocked('Cannot persist the committed legacy monitoring policy before replacing Workspace settings. The legacy configuration remains unchanged.');
            }
            // Snapshot preparation can yield. Recheck migration, the warning,
            // and root ownership before touching the current request.
            const latest = this.getStatus();
            if (!latest.legacyMigrationComplete ||
                (latest.effective.kind === 'legacyV3' &&
                    this.legacyMigrationRequired(latest.legacyGlobalRules, latest.legacyCommittedRules) &&
                    !this.migrationRecordMatches(checked.scope.scopeRevision))) {
                return blocked('Finish legacy watch-rule migration before adding a structured exclusion.');
            }
            if (requireCoverage && !this.tracker.getSubtreeCoverageGaps().some(gap => path.resolve(gap.targetPath) === canonicalPath)) {
                return blocked('The coverage warning no longer exists. Refresh Change Recording.');
            }
            const owningFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(canonicalPath));
            if (!owningFolder || owningFolder.name !== folder.name ||
                owningFolder.uri.toString() !== folder.uri.toString()) {
                return blocked('The owning workspace folder changed. Refresh the scope manager.');
            }
            const config = vscode.workspace.getConfiguration('diffTracker');
            if (this.getRequestedScope().scope?.scopeRevision !== current.scopeRevision) {
                return blocked('The requested monitoring scope changed. Review it before adding the exclusion.');
            }
            // Only edit exclusions: rewriting mode/includes across awaits can
            // overwrite an external settings edit with the old request. VS Code
            // has no conditional update, so also check for conflicts afterward.
            const before = this.scopeSettings();
            await this.updateOwnedScopeSetting(config,'watchExclude',checked.scope.excludes,before,
                {...before,watchExclude:checked.scope.excludes});
            const now = this.getRequestedScope();
            if (!now.ok || now.scope?.scopeRevision !== checked.scope.scopeRevision) {
                return blocked('Workspace Settings changed during the save; inspect the requested scope before applying.');
            }
            this.reconcileRequestedScope();
            return { status: 'saved' };
        } catch (error) {
            return {...blocked(`Could not save the explicit exclusion: ${error instanceof Error ? error.message : String(error)}`),
                settingsOwnershipLost:error instanceof ScopeSettingsOwnershipConflict};
        }
    }

    public saveRequestedScope(
        request: MonitoringScopeRequest,
        options?: {
            allowLegacyMigrationWrite?: boolean;
            expectedLegacySourceFingerprint?: string;
            expectedRequestVersion?: string;
        }
    ): Promise<ScopeValidationResult> {
        return this.enqueueScopeSettingsWrite(() => this.saveRequestedScopeNow(request, options));
    }

    public getRequestVersion(): string {
        return createLegacySourceFingerprint({settings:this.scopeSettings(),roots:this.getWorkspaceRoots(),
            legacy:this.getLegacySourceSnapshot()});
    }

    /** Validate and confirm the complete editor proposal before any settings write. */
    public async saveAndApplyScope(
        request: MonitoringScopeRequest,
        confirm: (proposal: MonitoringScopeConfirmation) => Promise<boolean>,
        expectedRequestVersion = this.getRequestVersion(),
        proposalStillCurrent: () => boolean = () => true
    ): Promise<MonitoringScopeApplyOutcome> {
        const conflict = (reason: string): MonitoringScopeApplyOutcome => ({status:'conflict',reason,
            settingsStatus:'unchanged',scopeCommitted:false,coverageStatus:'notRun'});
        if (this.hasActiveScopeAction()) { return conflict('Another monitoring-scope action is in progress.'); }
        if (expectedRequestVersion !== this.getRequestVersion()) {
            return conflict('Settings changed after this editor draft was loaded. Your draft is preserved; review the current settings before retrying.');
        }
        const checked = validateAndCanonicalizeScope(request,this.getWorkspaceRoots());
        if (!checked.ok || !checked.scope) {
            return {status:'invalid',reason:checked.errors.map(error=>error.message).join('; '),settingsStatus:'unchanged',scopeCommitted:false};
        }
        const scope = checked.scope;
        const effective = this.tracker.getEffectiveMonitoringScope();
        const requestedBefore = this.getRequestedScope().scope;
        let observationBefore: ScopeOperationObservation | undefined;
        if (effective.kind === 'legacyV3' && this.legacyMigrationRequired() && !this.migrationRecordMatches(scope.scopeRevision)) {
            return {status:'needsMigration',reason:'Review and complete legacy migration for this exact target before applying it.',settingsStatus:'unchanged',scopeCommitted:false};
        }
        const expansionReasons = scopeConsentMatches(this.context.workspaceState.get(CONSENT_KEY),scope) ? []
            : effective.kind === 'configured' ? detectScopeExpansion(effective,scope).reasons
                : [...(scope.mode === 'wholeWorkspace' ? ['Whole Workspace mode requires expanded monitoring coverage.'] : []),
                    ...scope.includes.map(rule=>`Explicit include requires local authorization: ${rule.path}`)];
        const affectedReviewPaths = this.tracker.getExplicitlyExcludedPendingReviewPaths(scope);
        const affectedReviewRevision = this.tracker.getExplicitlyExcludedReviewRevision(scope);
        const before = this.scopeSettings();
        const expected = this.scopeSettings();
        const roots = JSON.stringify(this.getWorkspaceRoots());
        const effectiveFingerprint = createLegacySourceFingerprint(effective);
        const legacy = this.getLegacySourceSnapshot();
        const workspaceFile = vscode.workspace.workspaceFile?.toString();
        let settingsOwnershipLost = false;
        const current = () => !settingsOwnershipLost && !this.disposed && this.settingsFingerprint() === this.settingsFingerprint(expected) &&
            JSON.stringify(this.getWorkspaceRoots()) === roots &&
            createLegacySourceFingerprint(this.tracker.getEffectiveMonitoringScope()) === effectiveFingerprint &&
            this.migrationUnaffectedSourcesMatch(legacy,this.getLegacySourceSnapshot(),workspaceFile);
        const reviewCurrent = () => this.tracker.getExplicitlyExcludedReviewRevision(scope) === affectedReviewRevision;
        this.scopeActionInProgress = true;
        try {
            if ((expansionReasons.length > 0 || affectedReviewPaths.length > 0) &&
                !await confirm({scopeRevision:scope.scopeRevision,expansionReasons:[...expansionReasons],affectedReviewPaths:[...affectedReviewPaths]})) {
                return {status:'cancelled',settingsStatus:'unchanged',scopeCommitted:false,coverageStatus:'notRun'};
            }
            return await this.enqueueScopeSettingsWrite(async () => {
                if (!current() || !reviewCurrent() || !proposalStillCurrent()) { return conflict('Scope, workspace, settings or affected review changed during confirmation. Your draft is preserved.'); }
                this.confirmedSettings = {expected,roots,effective:effectiveFingerprint};
                let outcome: MonitoringScopeApplyOutcome = {status:'failed',scopeCommitted:false,coverageStatus:'notRun'};
                let attempted = false;
                try {
                    const values: ScopeSettings = {monitoringScope:scope.mode,watchInclude:scope.includes,watchExclude:scope.excludes};
                    const config = vscode.workspace.getConfiguration('diffTracker');
                    for (const key of SCOPE_SETTINGS_KEYS) {
                        if (!current() || !reviewCurrent() || !proposalStillCurrent()) { throw new Error('Settings, scope, draft or affected review changed during the save.'); }
                        const previous = expected[key];
                        expected[key] = values[key];
                        attempted = true;
                        try { await this.updateOwnedScopeSetting(config,key,values[key],{...expected,[key]:previous},expected); }
                        catch (error) {
                            // update may reject before changing anything or after
                            // persisting. Read back before deciding what we own.
                            const unchanged = {...expected,[key]:previous};
                            if (this.settingsFingerprint() === this.settingsFingerprint(unchanged)) { expected[key] = previous; }
                            throw error;
                        }
                        if (!current() || !reviewCurrent() || !proposalStillCurrent()) { throw new Error('Settings, scope, draft or affected review changed during the save.'); }
                    }
                    // Approval can outlive independent directory activity. Pin
                    // attribution at Apply, after owned settings have settled.
                    observationBefore = this.tracker.captureScopeOperationObservation();
                    outcome = await this.performPendingScopeApply({grantConsent:true,
                        discardExplicitlyExcludedReviews:affectedReviewPaths.length > 0,
                        expectedScopeRevision:scope.scopeRevision,expectedAffectedReviewRevision:affectedReviewRevision,
                        requestGuard:()=>current() && proposalStillCurrent(),scopeOperation:observationBefore});
                    if (outcome.status === 'applied') {
                        outcome = {...outcome,scopeCommitted:true,settingsStatus:'saved'};
                    }
                } catch (error) {
                    if (error instanceof ScopeSettingsOwnershipConflict) { settingsOwnershipLost = true; }
                    outcome = {status:'failed',scopeCommitted:false,coverageStatus:'notRun',reason:String(error)};
                }
                finally {
                    // A committed scope owns its settings even if later verification fails.
                    // Compensate only the exact uncommitted request still owned here.
                    if (outcome.status !== 'applied' && attempted) {
                        try {
                            if (!current()) { throw new Error('Newer settings or workspace state must be preserved.'); }
                            const unchanged = this.settingsFingerprint(expected) === this.settingsFingerprint(before);
                            const config = vscode.workspace.getConfiguration('diffTracker');
                            for (const key of [...SCOPE_SETTINGS_KEYS].reverse()) {
                                if (!current()) { throw new Error('Settings changed during compensation.'); }
                                if (createLegacySourceFingerprint(expected[key]) === createLegacySourceFingerprint(before[key])) { continue; }
                                const previous = expected[key];
                                expected[key] = before[key];
                                await this.updateOwnedScopeSetting(config,key,before[key],{...expected,[key]:previous},expected);
                                if (!current()) { throw new Error('Settings changed during compensation.'); }
                            }
                            outcome = {...outcome,settingsStatus:unchanged ? 'unchanged' : 'restored',scopeCommitted:false};
                        } catch (error) {
                            outcome = {...outcome,status:'partial',settingsStatus:'partial',scopeCommitted:false,
                                reason:`Scope was not applied. Settings could not be fully restored: ${String(error)} ${outcome.reason ?? ''}`};
                        }
                    }
                    this.confirmedSettings = undefined;
                    this.reconcileRequestedScope();
                }
                return outcome.status === 'applied' ? this.finalizeScopeOperation(outcome,effective,requestedBefore,false,observationBefore) : outcome;
            });
        } finally {
            if (observationBefore) { observationBefore.activity.active = false; }
            this.scopeActionInProgress = false;
        }
    }

    // Migration already owns the queue; its nested save must not enqueue again.
    private async saveRequestedScopeNow(
        request: MonitoringScopeRequest,
        options?: {
            allowLegacyMigrationWrite?: boolean;
            expectedLegacySourceFingerprint?: string;
            expectedRequestVersion?: string;
        }
    ): Promise<ScopeValidationResult> {
        const validated = validateAndCanonicalizeScope(request, this.getWorkspaceRoots());
        if (!validated.ok || !validated.scope) { return validated; }
        const validatedScope = validated.scope;
        const expected = options?.expectedRequestVersion ? this.scopeSettings() : undefined;
        const roots = JSON.stringify(this.getWorkspaceRoots());
        const settingsStillCurrent = () => !this.disposed && (!expected ||
            (JSON.stringify(this.getWorkspaceRoots()) === roots && this.settingsFingerprint() === this.settingsFingerprint(expected)));
        const draftConflict = (): ScopeValidationResult => ({ok:false,warnings:validated.warnings,
            errors:[{field:'exclude',message:'Workspace Settings changed after the draft was loaded or during its save. Your draft and newer settings are preserved.'}]});
        if (options?.expectedRequestVersion && options.expectedRequestVersion !== this.getRequestVersion()) { return draftConflict(); }
        const effective = this.tracker.getEffectiveMonitoringScope();
        const legacyRules = this.getLegacyWatchRules();
        const committedRules = this.getCommittedLegacyRules();
        const migrationRequired = effective.kind === 'legacyV3' &&
            (legacyRules.length > 0 || committedRules.some(([, patterns]) => patterns.length > 0));
        const migrationComplete = !migrationRequired ||
            this.migrationRecordMatches(validatedScope.scopeRevision);
        // Any legacyV3 migration that can replace Workspace watchExclude
        // is a destructive source transition. Bind it to the exact Workspace
        // source snapshot even when only committed compatibility evidence
        // survives and the live legacy string list is currently empty.
        const expectedLegacySourceFingerprint = effective.kind === 'legacyV3' && migrationRequired
            ? options?.expectedLegacySourceFingerprint ?? this.getLegacySourceFingerprint(validatedScope.roots)
            : undefined;
        const legacySourceStillCurrent = (): boolean =>
            !expectedLegacySourceFingerprint ||
            this.getLegacySourceFingerprint(validatedScope.roots) === expectedLegacySourceFingerprint;
        const sourceConflict = (): ScopeValidationResult => ({
            ok: false,
            errors: [{
                field: 'exclude',
                message: 'Legacy watchExclude source changed while the reviewed migration target was being saved. The legacy Workspace rule was not replaced; review the current source again.'
            }],
            warnings: validated.warnings
        });
        if (!options?.allowLegacyMigrationWrite && effective.kind === 'legacyV3' &&
            !migrationComplete) {
            return {
                ok: false,
                errors: [{
                    field: 'exclude',
                    message: 'Legacy monitoring policy still requires migration evidence. Complete or explicitly resolve legacy migration before saving structured monitoring-scope settings.'
                }],
                warnings: validated.warnings
            };
        }
        if (effective.kind === 'legacyV3' &&
            !await this.tracker.prepareLegacyCompatibilityPolicySnapshot()) {
            return {
                ok: false,
                errors: [{
                    field: 'exclude',
                    message: 'Cannot persist the committed legacy monitoring policy before replacing Workspace settings. The legacy configuration remains unchanged.'
                }],
                warnings: validated.warnings
            };
        }
        if (!legacySourceStillCurrent()) { return sourceConflict(); }

        const config = vscode.workspace.getConfiguration('diffTracker');
        if (!settingsStillCurrent()) { return draftConflict(); }
        if (expected) { expected.monitoringScope = validatedScope.mode; }
        await config.update('monitoringScope', validatedScope.mode, vscode.ConfigurationTarget.Workspace);
        if (!settingsStillCurrent()) { return draftConflict(); }
        if (!legacySourceStillCurrent()) { return sourceConflict(); }

        if (expected) { expected.watchInclude = validatedScope.includes; }
        await config.update('watchInclude', validatedScope.includes, vscode.ConfigurationTarget.Workspace);
        if (!settingsStillCurrent()) { return draftConflict(); }
        if (!legacySourceStillCurrent()) { return sourceConflict(); }

        // This is the destructive legacy-source replacement. Every await before
        // it is bound to the exact source fingerprint reviewed by migration.
        if (expected) { expected.watchExclude = validatedScope.excludes; }
        await config.update('watchExclude', validatedScope.excludes, vscode.ConfigurationTarget.Workspace);
        if (!settingsStillCurrent()) { return draftConflict(); }
        return validated;
    }

    public async applyPendingScope(options?: {
        grantConsent?: boolean;
        discardExplicitlyExcludedReviews?: boolean;
        expectedScopeRevision?: string;
        expectedAffectedReviewRevision?: string;
    }): Promise<MonitoringScopeApplyOutcome> {
        if (this.scopeActionInProgress) {
            return { status: 'conflict', reason: 'A monitoring-scope action is awaiting confirmation or being applied; finish it before applying another scope.' };
        }
        return this.performPendingScopeApply(options);
    }

    private async performPendingScopeApply(options?: {
        grantConsent?: boolean;
        discardExplicitlyExcludedReviews?: boolean;
        expectedScopeRevision?: string;
        expectedAffectedReviewRevision?: string;
        requestGuard?: () => boolean;
        scopeOperation?: ScopeOperationObservation;
    }): Promise<MonitoringScopeApplyOutcome> {
        const status = this.getStatus();
        const scope = status.requested.scope;
        if (options?.requestGuard && !options.requestGuard()) {
            return {status:'conflict',reason:'The confirmed settings or workspace changed before Apply.'};
        }
        if (!status.requested.ok || !scope) {
            return { status: 'invalid', reason: status.requested.errors.map(error => error.message).join('; ') };
        }
        if (options?.expectedScopeRevision && options.expectedScopeRevision !== scope.scopeRevision) {
            return {
                status: 'conflict',
                scopeRevision: scope.scopeRevision,
                reason: 'Monitoring scope request changed after the confirmation was shown; review the new request before applying.'
            };
        }
        if (status.effective.kind === 'legacyV3' && !status.legacyMigrationComplete) {
            return { status: 'needsMigration', reason: 'Legacy watch rules must be migrated before configured scope can become effective.' };
        }
        if (status.expansionReasons.length > 0 && !status.consented) {
            if (!options?.grantConsent) {
                return {
                    status: 'needsConsent',
                    expansionReasons: status.expansionReasons,
                    scopeRevision: scope.scopeRevision
                };
            }
            await this.grantConsent(scope);
        }
        const affectedReviewPaths = this.tracker.getExplicitlyExcludedPendingReviewPaths(scope);
        const affectedReviewRevision = this.tracker.getExplicitlyExcludedReviewRevision(scope);
        if ((options?.expectedAffectedReviewRevision && options.expectedAffectedReviewRevision !== affectedReviewRevision) ||
            (options?.discardExplicitlyExcludedReviews && !options.expectedAffectedReviewRevision)) {
            return { status: 'conflict', scopeRevision: scope.scopeRevision,
                reason: 'Affected review changed or discard approval is unbound; confirm the current review set again.' };
        }
        if (affectedReviewPaths.length > 0 && !options?.discardExplicitlyExcludedReviews) {
            return {
                status: 'needsDiscardConfirmation',
                affectedReviewPaths,
                affectedReviewRevision,
                scopeRevision: scope.scopeRevision,
                reason: 'Explicit exclusions would discard pending review for these paths.'
            };
        }

        const expectedRevision = scope.scopeRevision;
        const migrationEvidenceRequired = status.effective.kind === 'legacyV3' &&
            (status.legacyGlobalRules.length > 0 ||
                status.legacyCommittedRules.some(([, patterns]) => patterns.length > 0));
        const expectedLegacySourceFingerprint = status.effective.kind === 'legacyV3'
            ? this.getLegacySourceFingerprint()
            : undefined;
        const requestStillCurrent = (): boolean => {
            if (options?.requestGuard && !options.requestGuard()) { return false; }
            const latest = this.getRequestedScope();
            if (!latest.ok || latest.scope?.scopeRevision !== expectedRevision) { return false; }
            if (!expectedLegacySourceFingerprint) { return true; }
            const roots = this.getWorkspaceRoots();
            const latestSourceFingerprint = this.getLegacySourceFingerprint(roots);
            if (latestSourceFingerprint !== expectedLegacySourceFingerprint) { return false; }
            return !migrationEvidenceRequired ||
                scopeMigrationMatches(
                    this.context.workspaceState.get(MIGRATION_KEY),
                    roots,
                    latestSourceFingerprint,
                    expectedRevision
                );
        };
        const applied = await this.tracker.applyConfiguredMonitoringScope(
            scope,
            options?.discardExplicitlyExcludedReviews === true,
            requestStillCurrent,
            options?.expectedAffectedReviewRevision,
            options?.scopeOperation
        );
        if (applied.status === 'applied') {
            let reason: string | undefined;
            try { await this.clearDismissedConsent(); }
            catch { reason = 'Monitoring scope was applied, but its dismissed-notification preference could not be cleared.'; }
            this.reconcileRequestedScope();
            return { status: 'applied', scopeRevision: scope.scopeRevision, reason };
        }
        if (applied.status === 'requiresS4') { return { status: 'requiresS4', reason: applied.reason }; }
        return { status: applied.status === 'conflict' ? 'conflict' : 'failed', reason: applied.reason };
    }

    public migrateLegacyWatchRules(): Promise<{ status: 'migrated' | 'manual' | 'conflict'; reason?: string; manual?: string[] }> {
        return this.enqueueScopeSettingsWrite(() => this.migrateLegacyWatchRulesNow());
    }

    private async migrateLegacyWatchRulesNow(): Promise<{ status: 'migrated' | 'manual' | 'conflict'; reason?: string; manual?: string[] }> {
        const approvedSource = this.getLegacySourceSnapshot();
        const workspaceFile = vscode.workspace.workspaceFile?.toString();
        const approvedSourceFingerprint = createLegacySourceFingerprint(approvedSource);
        const liveRules = this.getLegacyWatchRules();
        const committedRules = this.getCommittedLegacyRules()
            .filter(([, patterns]) => patterns.length > 0);
        // If the live legacy source has already disappeared but committed
        // compatibility policy still protects paths, there is no trustworthy
        // automatic source-to-target translation. Require the user to review
        // the structured target explicitly instead of synthesizing an empty one.
        if (liveRules.length === 0 && committedRules.length > 0) {
            return {
                status: 'manual',
                manual: committedRules.flatMap(([, patterns]) => patterns),
                reason: 'Committed legacy monitoring policy survives after the live Workspace source changed; review and save the structured migration target explicitly.'
            };
        }
        const preview = previewLegacyWatchExcludeMigration(liveRules);
        if (preview.manual.length > 0) {
            return { status: 'manual', manual: preview.manual, reason: 'Some legacy watch rules require manual migration to preserve downstream policy semantics.' };
        }
        const hasWorkspaceRules =
            this.inspectWorkspaceValue<unknown>('monitoringScope') !== undefined ||
            this.inspectWorkspaceValue<unknown>('watchInclude') !== undefined ||
            this.inspectWorkspaceValue<unknown>('watchExclude') !== undefined;
        if (hasWorkspaceRules) {
            return { status: 'conflict', reason: 'Workspace monitoring-scope settings already exist; migration will not overwrite them automatically.' };
        }
        const validated = await this.saveRequestedScopeNow({
            mode: 'rules',
            includes: preview.includes,
            excludes: preview.excludes
        }, {
            allowLegacyMigrationWrite: true,
            expectedLegacySourceFingerprint: approvedSourceFingerprint
        });
        if (!validated.ok || !validated.scope) {
            return { status: 'conflict', reason: validated.errors.map(error => error.message).join('; ') };
        }
        const latestRequested = this.getRequestedScope();
        const currentSource = this.getLegacySourceSnapshot();
        if (!latestRequested.ok || !latestRequested.scope ||
            latestRequested.scope.scopeRevision !== validated.scope.scopeRevision ||
            !this.migrationUnaffectedSourcesMatch(approvedSource, currentSource,workspaceFile)) {
            return { status: 'conflict', reason: 'Legacy rule sources or the migration target changed while settings were being written; review the current migration again.' };
        }
        try {
            await this.markLegacyMigrationComplete({
                approvedSourceFingerprint,
                decision: 'automatic',
                expectedScopeRevision: validated.scope.scopeRevision
            });
        } catch (error) {
            return { status: 'conflict', reason: error instanceof Error ? error.message : 'Legacy migration evidence changed before publication.' };
        }
        // Migration preserves the old legacy semantics; treat the resulting
        // canonical scope as locally authorized on this host.
        await this.grantConsent(validated.scope);
        this.reconcileRequestedScope();
        return { status: 'migrated' };
    }

    public completeLegacyMigrationUsingCurrentScope(
        reviewedTarget?: MonitoringScopeRequest
    ): Promise<{ status: 'completed' | 'invalid'; reason?: string }> {
        return this.enqueueScopeSettingsWrite(() => this.completeLegacyMigrationUsingCurrentScopeNow(reviewedTarget));
    }

    private async completeLegacyMigrationUsingCurrentScopeNow(
        reviewedTarget?: MonitoringScopeRequest
    ): Promise<{ status: 'completed' | 'invalid'; reason?: string }> {
        const roots = this.getWorkspaceRoots();
        const approvedSource = this.getLegacySourceSnapshot(roots);
        const workspaceFile = vscode.workspace.workspaceFile?.toString();
        const approvedSourceFingerprint = this.getManualApprovedSourceFingerprint(roots);
        let requested: ScopeValidationResult;

        if (reviewedTarget) {
            try {
                requested = await this.saveRequestedScopeNow(reviewedTarget, {
                    allowLegacyMigrationWrite: true,
                    // The approved source may be committed-only, but the
                    // mutable Workspace value still has to remain exactly as
                    // reviewed until its destructive replacement.
                    expectedLegacySourceFingerprint: createLegacySourceFingerprint(approvedSource)
                });
            } catch (error) {
                return {
                    status: 'invalid',
                    reason: error instanceof Error ? error.message : 'The reviewed migration target could not be saved.'
                };
            }
            if (!requested.ok || !requested.scope) {
                return { status: 'invalid', reason: requested.errors.map(error => error.message).join('; ') };
            }
            const latestRequested = this.getRequestedScope();
            const currentSource = this.getLegacySourceSnapshot();
            if (!latestRequested.ok || !latestRequested.scope ||
                latestRequested.scope.scopeRevision !== requested.scope.scopeRevision ||
                !this.migrationUnaffectedSourcesMatch(approvedSource, currentSource,workspaceFile)) {
                return {
                    status: 'invalid',
                    reason: 'Legacy rule sources or the reviewed migration target changed while settings were being saved; review the current migration again.'
                };
            }
        } else {
            requested = this.getRequestedScope();
            if (!requested.ok || !requested.scope) {
                return { status: 'invalid', reason: requested.errors.map(error => error.message).join('; ') };
            }
        }

        try {
            await this.markLegacyMigrationComplete({
                approvedSourceFingerprint,
                decision: 'manual',
                expectedScopeRevision: requested.scope.scopeRevision
            });
        } catch (error) {
            return { status: 'invalid', reason: error instanceof Error ? error.message : 'Legacy migration evidence changed before publication.' };
        }
        this.reconcileRequestedScope();
        return { status: 'completed' };
    }

    private scopeSettings(): ScopeSettings {
        return Object.fromEntries(SCOPE_SETTINGS_KEYS.map(key => {
            const value = this.inspectWorkspaceValue<unknown>(key);
            return [key, value === undefined ? undefined : JSON.parse(JSON.stringify(value))];
        })) as ScopeSettings;
    }

    private settingsFingerprint(settings = this.scopeSettings()): string {
        return createLegacySourceFingerprint(SCOPE_SETTINGS_KEYS.map(key => this.legacySourceValue(settings[key])));
    }

    private async finalizeScopeOperation(
        outcome: MonitoringScopeApplyOutcome, previous: EffectiveMonitoringScope,
        requested?: CanonicalMonitoringScope, restoring = false, observationBefore?: ScopeOperationObservation
    ): Promise<MonitoringScopeApplyOutcome> {
        const completed = outcome.status === 'applied' ? 'Monitoring scope applied' : 'Configuration restored';
        if (!this.tracker.getIsRecording()) {
            return {...outcome, coverageStatus:'deferred', reason: outcome.reason ??
                `${completed}. Recording remains stopped; no observation scan was run.`};
        }
        if (this.tracker.getEffectiveMonitoringScope().scopeRevision !== outcome.scopeRevision) {
            return {...outcome, status:'partial', coverageStatus:'notRun',
                reason:'Configuration completed, but the effective scope changed before observation verification.'};
        }
        if (this.tracker.getBaselineState() !== 'ready' || this.tracker.getEffectiveMonitoringScope().kind !== 'configured') {
            return {...outcome,status:'partial',coverageStatus:'notRun',
                reason:'Configuration completed. Observation verification requires an active, ready configured scope; existing review is preserved.'};
        }
        const targets = this.tracker.getScopeOperationRecoveryTargets(previous,requested,restoring,observationBefore);
        const complete = (): MonitoringScopeApplyOutcome => {
            const others = this.tracker.getScopeOperationCoverageGaps(targets).unrelated;
            return {...outcome,coverageStatus:'verified',unrelatedCoverageGaps:others,
                reason:others.length?`${completed}. Related observation work is complete; other coverage problems remain at ${others.slice(0,5).map(([target])=>target).join(', ')}. ${outcome.reason??''}`:outcome.reason};
        };
        if (targets.length === 0) { return complete(); }
        let result: ObservationCoverageRecheckResult;
        try {
            if (!await this.tracker.retainScopeOperationRecovery(targets, outcome.scopeRevision!)) {
                throw new Error('Recovery ownership could not be saved.');
            }
            result = await this.tracker.recheckScopeOperationCoverage(targets,outcome.scopeRevision!);
        }
        catch (error) { result = {status:'failed',reason:String(error)}; }
        if (this.tracker.getEffectiveMonitoringScope().scopeRevision !== outcome.scopeRevision) {
            return {...outcome,status:'partial',coverageStatus:'notRun',
                reason:`${completed}, then the effective scope changed during observation verification. The newer scope is preserved.`};
        }
        if ((result.status === 'rechecked' || result.status === 'limited') &&
            this.tracker.getScopeOperationCoverageGaps(targets).related.length === 0) { return complete(); }
        try { await this.tracker.retainScopeOperationRecovery(targets, outcome.scopeRevision!); }
        catch { /* Retain the original failure if ownership storage also fails. */ }
        return {...outcome, status:'partial', coverageStatus:'limited',
                unrelatedCoverageGaps:this.tracker.getScopeOperationCoverageGaps(targets).unrelated,
                reason:`${completed}; its effective scope is retained. Observation verification is incomplete: ${result.reason ?? result.status}`};
    }

    public restoreEffectiveScopeConfiguration(options?: {expectedRequestVersion:string;expectedScopeRevision?:string}): Promise<MonitoringScopeApplyOutcome> {
        return this.enqueueScopeSettingsWrite(() => this.restoreEffectiveScopeConfigurationNow(options));
    }

    private async restoreEffectiveScopeConfigurationNow(options?: {expectedRequestVersion:string;expectedScopeRevision?:string}): Promise<MonitoringScopeApplyOutcome> {
        const config = vscode.workspace.getConfiguration('diffTracker');
        const effective = this.tracker.getEffectiveMonitoringScope();
        const requestedBefore=this.getRequestedScope().scope;
        if (options && (options.expectedRequestVersion !== this.getRequestVersion() ||
            (options.expectedScopeRevision !== undefined && options.expectedScopeRevision !== effective.scopeRevision))) {
            return {status:'conflict',settingsStatus:'unchanged',scopeCommitted:false,coverageStatus:'notRun',
                reason:'Scope or settings changed during Restore confirmation. Newer settings and existing review are preserved.'};
        }
        const roots = JSON.stringify(this.getWorkspaceRoots());
        const expected = this.scopeSettings();
        const before = this.settingsFingerprint(expected);
        const restored: ScopeSettings = effective.kind === 'configured' ? {
            monitoringScope:effective.mode, watchInclude:effective.includes, watchExclude:effective.excludes
        } : {monitoringScope:undefined, watchInclude:undefined,
            watchExclude:this.isLegacyStringArray(expected.watchExclude) ? expected.watchExclude : undefined};
        const current = () => !this.disposed && createLegacySourceFingerprint(this.tracker.getEffectiveMonitoringScope()) === createLegacySourceFingerprint(effective) &&
            JSON.stringify(this.getWorkspaceRoots()) === roots && this.settingsFingerprint() === this.settingsFingerprint(expected);
        try {
            const keys = effective.kind === 'legacyV3' && this.isLegacyStringArray(expected.watchExclude)
                ? SCOPE_SETTINGS_KEYS.slice(0,2) : SCOPE_SETTINGS_KEYS;
            for (const key of keys) {
                if (!current()) { throw new Error('Workspace, effective scope or settings changed during Restore; newer settings were preserved.'); }
                expected[key] = restored[key];
                await config.update(key, restored[key], vscode.ConfigurationTarget.Workspace);
                if (!current()) { throw new Error('Workspace, effective scope or settings changed during Restore; newer settings were preserved.'); }
            }
            if (effective.kind !== 'configured') { await this.clearLegacyMigration(); }
            if (!current()) { throw new Error('Workspace, effective scope or settings changed before Restore completed.'); }
            this.reconcileRequestedScope();
            const observationBefore = this.tracker.captureScopeOperationObservation();
            return this.finalizeScopeOperation({status:'restored',settingsStatus:'restored',scopeCommitted:true,
                scopeRevision:effective.scopeRevision},effective,requestedBefore,true,observationBefore);
        } catch (error) {
            this.reconcileRequestedScope();
            const changed = this.settingsFingerprint() !== before;
            return {status:changed ? 'partial' : 'failed',settingsStatus:changed ? 'partial' : 'unchanged',
                scopeCommitted:false,coverageStatus:'notRun',reason:`Configuration Restore did not complete: ${String(error)}`};
        }
    }

    public async grantConsent(scope: CanonicalMonitoringScope): Promise<void> {
        await this.context.workspaceState.update(CONSENT_KEY, createScopeConsentRecord(scope));
        if (this.context.workspaceState.get<string>(DISMISSED_KEY) === scope.scopeRevision) {
            await this.context.workspaceState.update(DISMISSED_KEY, undefined);
        }
    }

    public async dismissConsent(scopeRevision: string): Promise<void> {
        await this.context.workspaceState.update(DISMISSED_KEY, scopeRevision);
    }

    public async clearDismissedConsent(): Promise<void> {
        await this.context.workspaceState.update(DISMISSED_KEY, undefined);
    }

    public async markLegacyMigrationComplete(options?: {
        approvedSourceFingerprint?: string;
        decision?: 'automatic' | 'manual';
        expectedScopeRevision?: string;
    }): Promise<void> {
        const requested = this.getRequestedScope();
        if (!requested.ok || !requested.scope) {
            throw new Error('Cannot mark legacy migration complete while workspace path identity is unverified.');
        }
        if (options?.expectedScopeRevision && options.expectedScopeRevision !== requested.scope.scopeRevision) {
            throw new Error('Monitoring scope target changed before legacy migration could be recorded.');
        }
        const currentSourceFingerprint = this.getLegacySourceFingerprint(requested.scope.roots);
        const approvedSourceFingerprint = options?.approvedSourceFingerprint ?? currentSourceFingerprint;
        const record = createScopeMigrationRecord(
            requested.scope.roots,
            approvedSourceFingerprint,
            currentSourceFingerprint,
            requested.scope.scopeRevision,
            options?.decision ?? 'manual'
        );
        await this.context.workspaceState.update(MIGRATION_KEY, record);

        const latest = this.getRequestedScope();
        const roots = this.getWorkspaceRoots();
        const latestFingerprint = this.getLegacySourceFingerprint(roots);
        if (!latest.ok || !latest.scope ||
            !scopeMigrationMatches(record, roots, latestFingerprint, latest.scope.scopeRevision)) {
            await this.context.workspaceState.update(MIGRATION_KEY, undefined);
            throw new Error('Legacy rule sources or the migration target changed before migration evidence was published.');
        }
        await this.context.workspaceState.update(LEGACY_MIGRATION_KEY, undefined);
    }

    public async clearLegacyMigration(): Promise<void> {
        await this.context.workspaceState.update(MIGRATION_KEY, undefined);
        await this.context.workspaceState.update(LEGACY_MIGRATION_KEY, undefined);
    }
}
