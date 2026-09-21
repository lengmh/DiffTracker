import * as vscode from 'vscode';
import { DiffTracker } from './diffTracker';
import { detectLocalPathCaseSensitivity } from './utils/pathIdentity';
import {
    CanonicalMonitoringScope,
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
        'needsDiscardConfirmation' | 'requiresS4' | 'failed' | 'conflict';
    reason?: string;
    expansionReasons?: string[];
    affectedReviewPaths?: string[];
    affectedReviewRevision?: string;
    scopeRevision?: string;
}

export class MonitoringScopeController implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];

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
        const requested = this.getRequestedScope();
        const effective = this.tracker.getEffectiveMonitoringScope();
        const scope = requested.ok ? requested.scope : undefined;
        const pending = scope && (effective.kind !== 'configured' || effective.scopeRevision !== scope.scopeRevision)
            ? scope
            : undefined;
        this.tracker.setPendingMonitoringScope(pending);
    }

    public dispose(): void {
        for (const disposable of this.disposables.splice(0)) { disposable.dispose(); }
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
        return Array.isArray(value) && value.length > 0 && value.every(entry => typeof entry === 'string');
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

    private migrationUnaffectedSourcesMatch(before: LegacySourceSnapshot, after: LegacySourceSnapshot): boolean {
        const projection = (snapshot: LegacySourceSnapshot) => ({
            model: snapshot.model,
            semanticsModel: snapshot.semanticsModel,
            roots: snapshot.roots,
            global: snapshot.global,
            folders: snapshot.folders.map(folder => ({
                root: folder.root,
                workspaceFolder: folder.workspaceFolder
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

    public async saveRequestedScope(
        request: MonitoringScopeRequest,
        options?: {
            allowLegacyMigrationWrite?: boolean;
            expectedLegacySourceFingerprint?: string;
        }
    ): Promise<ScopeValidationResult> {
        const validated = validateAndCanonicalizeScope(request, this.getWorkspaceRoots());
        if (!validated.ok || !validated.scope) { return validated; }
        const validatedScope = validated.scope;
        const effective = this.tracker.getEffectiveMonitoringScope();
        const legacyRules = this.getLegacyWatchRules();
        const committedRules = this.getCommittedLegacyRules();
        const migrationRequired = effective.kind === 'legacyV3' &&
            (legacyRules.length > 0 || committedRules.some(([, patterns]) => patterns.length > 0));
        const migrationComplete = !migrationRequired ||
            this.migrationRecordMatches(validatedScope.scopeRevision);
        const expectedLegacySourceFingerprint = effective.kind === 'legacyV3' && legacyRules.length > 0
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
        await config.update('monitoringScope', validatedScope.mode, vscode.ConfigurationTarget.Workspace);
        if (!legacySourceStillCurrent()) { return sourceConflict(); }

        await config.update('watchInclude', validatedScope.includes, vscode.ConfigurationTarget.Workspace);
        if (!legacySourceStillCurrent()) { return sourceConflict(); }

        // This is the destructive legacy-source replacement. Every await before
        // it is bound to the exact source fingerprint reviewed by migration.
        await config.update('watchExclude', validatedScope.excludes, vscode.ConfigurationTarget.Workspace);
        return validated;
    }

    public async applyPendingScope(options?: {
        grantConsent?: boolean;
        discardExplicitlyExcludedReviews?: boolean;
        expectedScopeRevision?: string;
        expectedAffectedReviewRevision?: string;
    }): Promise<MonitoringScopeApplyOutcome> {
        const status = this.getStatus();
        const scope = status.requested.scope;
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
        if (options?.discardExplicitlyExcludedReviews &&
            options.expectedAffectedReviewRevision !== affectedReviewRevision) {
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
            options?.expectedAffectedReviewRevision
        );
        if (applied.status === 'applied') {
            await this.clearDismissedConsent();
            this.reconcileRequestedScope();
            return { status: 'applied', scopeRevision: scope.scopeRevision };
        }
        if (applied.status === 'requiresS4') { return { status: 'requiresS4', reason: applied.reason }; }
        return { status: applied.status === 'conflict' ? 'conflict' : 'failed', reason: applied.reason };
    }

    public async migrateLegacyWatchRules(): Promise<{ status: 'migrated' | 'manual' | 'conflict'; reason?: string; manual?: string[] }> {
        const approvedSource = this.getLegacySourceSnapshot();
        const approvedSourceFingerprint = createLegacySourceFingerprint(approvedSource);
        const preview = previewLegacyWatchExcludeMigration(this.getLegacyWatchRules());
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
        const validated = await this.saveRequestedScope({
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
            latestRequested.scope.scopeRevision !== validatedScope.scopeRevision ||
            !this.migrationUnaffectedSourcesMatch(approvedSource, currentSource)) {
            return { status: 'conflict', reason: 'Legacy rule sources or the migration target changed while settings were being written; review the current migration again.' };
        }
        try {
            await this.markLegacyMigrationComplete({
                approvedSourceFingerprint,
                decision: 'automatic',
                expectedScopeRevision: validatedScope.scopeRevision
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

    public async completeLegacyMigrationUsingCurrentScope(
        reviewedTarget?: MonitoringScopeRequest
    ): Promise<{ status: 'completed' | 'invalid'; reason?: string }> {
        const roots = this.getWorkspaceRoots();
        const approvedSource = this.getLegacySourceSnapshot(roots);
        const approvedSourceFingerprint = this.getManualApprovedSourceFingerprint(roots);
        let requested: ScopeValidationResult;

        if (reviewedTarget) {
            try {
                requested = await this.saveRequestedScope(reviewedTarget, {
                    allowLegacyMigrationWrite: true,
                    expectedLegacySourceFingerprint: this.getLegacyWatchRules().length > 0
                        ? createLegacySourceFingerprint(approvedSource)
                        : undefined
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
                !this.migrationUnaffectedSourcesMatch(approvedSource, currentSource)) {
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

    public async restoreEffectiveScopeConfiguration(): Promise<void> {
        const config = vscode.workspace.getConfiguration('diffTracker');
        const effective = this.tracker.getEffectiveMonitoringScope();
        if (effective.kind === 'configured') {
            await config.update('monitoringScope', effective.mode, vscode.ConfigurationTarget.Workspace);
            await config.update('watchInclude', effective.includes, vscode.ConfigurationTarget.Workspace);
            await config.update('watchExclude', effective.excludes, vscode.ConfigurationTarget.Workspace);
            return;
        }
        await config.update('monitoringScope', undefined, vscode.ConfigurationTarget.Workspace);
        await config.update('watchInclude', undefined, vscode.ConfigurationTarget.Workspace);
        if (!this.isLegacyStringArray(this.inspectWorkspaceValue<unknown>('watchExclude'))) {
            await config.update('watchExclude', undefined, vscode.ConfigurationTarget.Workspace);
        }
        await this.clearLegacyMigration();
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
