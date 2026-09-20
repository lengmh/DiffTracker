import * as vscode from 'vscode';
import { DiffTracker } from './diffTracker';
import { detectLocalPathCaseSensitivity } from './utils/pathIdentity';
import {
    CanonicalMonitoringScope,
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
const MIGRATION_KEY = 'diffTracker.monitoringScope.legacyMigration.v1';

export interface MonitoringScopeStatus {
    requested: ScopeValidationResult;
    rawRequested: { mode: unknown; includes: unknown; excludes: unknown };
    effective: EffectiveMonitoringScope;
    consented: boolean;
    dismissed: boolean;
    legacyMigrationComplete: boolean;
    legacyGlobalRules: string[];
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
        return {
            requested,
            rawRequested: this.getRequestedRawScope(),
            effective,
            consented: !!canonical && scopeConsentMatches(this.context.workspaceState.get(CONSENT_KEY), canonical),
            dismissed: !!canonical && dismissedRevision === canonical.scopeRevision,
            legacyMigrationComplete: legacyGlobalRules.length === 0 ||
                scopeMigrationMatches(this.context.workspaceState.get(MIGRATION_KEY), this.getWorkspaceRoots()),
            legacyGlobalRules,
            workspaceRequestPresent: this.hasWorkspaceScopeRequest(),
            expansionReasons,
            explicitlyExcludedPendingReviews: canonical ? this.tracker.getExplicitlyExcludedPendingReviewPaths(canonical) : []
        };
    }

    public async saveRequestedScope(request: MonitoringScopeRequest): Promise<ScopeValidationResult> {
        const validated = validateAndCanonicalizeScope(request, this.getWorkspaceRoots());
        if (!validated.ok || !validated.scope) { return validated; }
        const config = vscode.workspace.getConfiguration('diffTracker');
        await config.update('monitoringScope', validated.scope.mode, vscode.ConfigurationTarget.Workspace);
        await config.update('watchInclude', validated.scope.includes, vscode.ConfigurationTarget.Workspace);
        await config.update('watchExclude', validated.scope.excludes, vscode.ConfigurationTarget.Workspace);
        return validated;
    }

    public async applyPendingScope(options?: {
        grantConsent?: boolean;
        discardExplicitlyExcludedReviews?: boolean;
        expectedScopeRevision?: string;
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
        if (status.explicitlyExcludedPendingReviews.length > 0 && !options?.discardExplicitlyExcludedReviews) {
            return {
                status: 'needsDiscardConfirmation',
                affectedReviewPaths: status.explicitlyExcludedPendingReviews,
                scopeRevision: scope.scopeRevision,
                reason: 'Explicit exclusions would discard pending review for these paths.'
            };
        }

        const expectedRevision = scope.scopeRevision;
        const requestStillCurrent = (): boolean => {
            const latest = this.getRequestedScope();
            return latest.ok && latest.scope?.scopeRevision === expectedRevision;
        };
        const applied = await this.tracker.applyConfiguredMonitoringScope(
            scope,
            options?.discardExplicitlyExcludedReviews === true,
            requestStillCurrent
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
        });
        if (!validated.ok || !validated.scope) {
            return { status: 'conflict', reason: validated.errors.map(error => error.message).join('; ') };
        }
        await this.markLegacyMigrationComplete();
        // Migration preserves the old legacy semantics; treat the resulting
        // canonical scope as locally authorized on this host.
        await this.grantConsent(validated.scope);
        this.reconcileRequestedScope();
        return { status: 'migrated' };
    }

    public async completeLegacyMigrationUsingCurrentScope(): Promise<{ status: 'completed' | 'invalid'; reason?: string }> {
        const requested = this.getRequestedScope();
        if (!requested.ok || !requested.scope) {
            return { status: 'invalid', reason: requested.errors.map(error => error.message).join('; ') };
        }
        await this.markLegacyMigrationComplete();
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

    public async markLegacyMigrationComplete(): Promise<void> {
        const requested = this.getRequestedScope();
        if (!requested.ok || !requested.scope) {
            throw new Error('Cannot mark legacy migration complete while workspace path identity is unverified.');
        }
        await this.context.workspaceState.update(MIGRATION_KEY, createScopeMigrationRecord(requested.scope.roots));
    }

    public async clearLegacyMigration(): Promise<void> {
        await this.context.workspaceState.update(MIGRATION_KEY, undefined);
    }
}
