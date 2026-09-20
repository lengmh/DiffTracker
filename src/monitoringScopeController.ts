import * as vscode from 'vscode';
import { DiffTracker } from './diffTracker';
import {
    CanonicalMonitoringScope,
    createScopeConsentRecord,
    createScopeMigrationRecord,
    EffectiveMonitoringScope,
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
    effective: EffectiveMonitoringScope;
    consented: boolean;
    dismissed: boolean;
    legacyMigrationComplete: boolean;
    legacyGlobalRules: string[];
}

export class MonitoringScopeController implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly tracker: DiffTracker
    ) {}

    public dispose(): void {
        for (const disposable of this.disposables.splice(0)) { disposable.dispose(); }
    }

    public getWorkspaceRoots(): WorkspaceRootIdentity[] {
        return (vscode.workspace.workspaceFolders ?? [])
            .filter(folder => folder.uri.scheme === 'file')
            .map(folder => ({ name: folder.name, uri: folder.uri.toString() }))
            .sort((a, b) => a.uri.localeCompare(b.uri) || a.name.localeCompare(b.name));
    }

    private inspectWorkspaceValue<T>(key: string): T | undefined {
        const config = vscode.workspace.getConfiguration('diffTracker');
        const inspected = typeof config.inspect === 'function' ? config.inspect<T>(key) : undefined;
        return inspected?.workspaceValue;
    }

    public getRequestedScope(): ScopeValidationResult {
        const mode = this.inspectWorkspaceValue<unknown>('monitoringScope') ?? 'rules';
        const includes = this.inspectWorkspaceValue<unknown>('watchInclude') ?? [];
        const excludes = this.inspectWorkspaceValue<unknown>('watchExclude') ?? [];
        return validateAndCanonicalizeScope({ mode, includes, excludes }, this.getWorkspaceRoots());
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
        return {
            requested,
            effective,
            consented: !!canonical && scopeConsentMatches(this.context.workspaceState.get(CONSENT_KEY), canonical),
            dismissed: !!canonical && dismissedRevision === canonical.scopeRevision,
            legacyMigrationComplete: scopeMigrationMatches(this.context.workspaceState.get(MIGRATION_KEY), this.getWorkspaceRoots()),
            legacyGlobalRules: this.getLegacyGlobalRules()
        };
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
        await this.context.workspaceState.update(MIGRATION_KEY, createScopeMigrationRecord(this.getWorkspaceRoots()));
    }

    public async clearLegacyMigration(): Promise<void> {
        await this.context.workspaceState.update(MIGRATION_KEY, undefined);
    }
}
