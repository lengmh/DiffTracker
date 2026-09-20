import * as vscode from 'vscode';
import { DiffTracker } from './diffTracker';
import { MonitoringScopeController } from './monitoringScopeController';
import { MonitoringScopeRequest } from './monitoringScope';

type ScopeMessage = {
    command: string;
    mode?: unknown;
    includes?: unknown;
    excludes?: unknown;
    testPath?: string;
};

export class WatchExcludePanel {
    public static currentPanel: WatchExcludePanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private disposables: vscode.Disposable[] = [];

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        private diffTracker: DiffTracker,
        private scopeController: MonitoringScopeController
    ) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(async message => this.handleMessage(message), null, this.disposables);
        this.panel.webview.html = this.getHtmlContent();
    }

    public static createOrShow(
        extensionUri: vscode.Uri,
        diffTracker: DiffTracker,
        scopeController: MonitoringScopeController
    ): WatchExcludePanel {
        const column = vscode.window.activeTextEditor?.viewColumn;
        if (WatchExcludePanel.currentPanel) {
            WatchExcludePanel.currentPanel.panel.reveal(column);
            void WatchExcludePanel.currentPanel.postStatus();
            return WatchExcludePanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            'diffTrackerMonitoringScope',
            'Code Diff Tracker: Manage Monitoring Scope',
            column ?? vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );
        WatchExcludePanel.currentPanel = new WatchExcludePanel(panel, extensionUri, diffTracker, scopeController);
        return WatchExcludePanel.currentPanel;
    }

    private async handleMessage(message: ScopeMessage): Promise<void> {
        if (message.command === 'reload') {
            await this.postStatus();
            return;
        }

        if (message.command === 'saveRequest') {
            const request: MonitoringScopeRequest = {
                mode: message.mode === 'wholeWorkspace' ? 'wholeWorkspace' : 'rules',
                includes: Array.isArray(message.includes) ? message.includes as MonitoringScopeRequest['includes'] : [],
                excludes: Array.isArray(message.excludes) ? message.excludes as MonitoringScopeRequest['excludes'] : []
            };
            const result = await this.scopeController.saveRequestedScope(request);
            if (!result.ok) {
                void vscode.window.showWarningMessage(
                    `Code Diff Tracker: Monitoring scope was not saved. ${result.errors.map(error => error.message).join('; ')}`
                );
            } else {
                void vscode.window.showInformationMessage('Code Diff Tracker: Monitoring scope request saved. Apply it separately to make it effective.');
            }
            await this.postStatus();
            return;
        }

        if (message.command === 'apply') {
            await this.applyInteractively();
            await this.postStatus();
            return;
        }

        if (message.command === 'migrateLegacy') {
            const outcome = await this.scopeController.migrateLegacyWatchRules();
            if (outcome.status === 'migrated') {
                void vscode.window.showInformationMessage('Code Diff Tracker: Legacy Global watch rules migrated into this workspace request.');
            } else {
                void vscode.window.showWarningMessage(
                    `Code Diff Tracker: Legacy rule migration needs attention. ${outcome.reason ?? ''}${outcome.manual?.length ? ' ' + outcome.manual.join(', ') : ''}`
                );
            }
            await this.postStatus();
            return;
        }

        if (message.command === 'restoreEffective') {
            const answer = await vscode.window.showWarningMessage(
                'Restore Workspace Settings to the currently effective DiffTracker monitoring scope?',
                { modal: true },
                'Restore Effective Scope'
            );
            if (answer === 'Restore Effective Scope') {
                await this.scopeController.restoreEffectiveScopeConfiguration();
            }
            await this.postStatus();
            return;
        }

        if (message.command === 'dismissConsent') {
            const requested = this.scopeController.getRequestedScope();
            if (requested.ok && requested.scope) {
                await this.scopeController.dismissConsent(requested.scope.scopeRevision);
            }
            await this.postStatus();
            return;
        }

        if (message.command === 'testPath') {
            const result = this.diffTracker.testIgnorePath(message.testPath);
            void this.panel.webview.postMessage({ command: 'testResult', ...result });
        }
    }

    private async applyInteractively(): Promise<void> {
        let outcome = await this.scopeController.applyPendingScope();

        if (outcome.status === 'needsMigration') {
            void vscode.window.showWarningMessage('Code Diff Tracker: Migrate the legacy Global watch rules before applying the configured scope.');
            return;
        }

        if (outcome.status === 'needsConsent') {
            const answer = await vscode.window.showWarningMessage(
                'Apply this monitoring-scope expansion on this machine?',
                {
                    modal: true,
                    detail: (outcome.expansionReasons ?? []).join('\n') ||
                        'The requested scope may read files outside the previously effective scope.'
                },
                'Authorize and Apply'
            );
            if (answer !== 'Authorize and Apply') {
                const requested = this.scopeController.getRequestedScope();
                if (requested.ok && requested.scope) {
                    await this.scopeController.dismissConsent(requested.scope.scopeRevision);
                }
                return;
            }
            outcome = await this.scopeController.applyPendingScope({ grantConsent: true });
        }

        if (outcome.status === 'needsDiscardConfirmation') {
            const paths = outcome.affectedReviewPaths ?? [];
            const answer = await vscode.window.showWarningMessage(
                `The requested explicit exclusions would discard ${paths.length} pending review item(s). Workspace files will not be modified.`,
                { modal: true, detail: paths.slice(0, 20).join('\n') },
                'Discard Reviews and Apply'
            );
            if (answer !== 'Discard Reviews and Apply') { return; }
            outcome = await this.scopeController.applyPendingScope({
                grantConsent: true,
                discardExplicitlyExcludedReviews: true
            });
        }

        if (outcome.status === 'applied') {
            void vscode.window.showInformationMessage('Code Diff Tracker: Monitoring scope applied.');
        } else if (outcome.status === 'requiresS4') {
            void vscode.window.showWarningMessage(`Code Diff Tracker: ${outcome.reason ?? 'This scope requires S4-W bounded preparation and coverage.'}`);
        } else if (outcome.status !== 'needsConsent' && outcome.status !== 'needsDiscardConfirmation') {
            void vscode.window.showWarningMessage(`Code Diff Tracker: Monitoring scope was not applied. ${outcome.reason ?? outcome.status}`);
        }
    }

    private async postStatus(): Promise<void> {
        const status = this.scopeController.getStatus();
        void this.panel.webview.postMessage({
            command: 'scopeStatus',
            rawRequested: status.rawRequested,
            requested: {
                ok: status.requested.ok,
                errors: status.requested.errors,
                warnings: status.requested.warnings,
                scopeRevision: status.requested.scope?.scopeRevision
            },
            effective: status.effective,
            consented: status.consented,
            dismissed: status.dismissed,
            legacyMigrationComplete: status.legacyMigrationComplete,
            legacyGlobalRules: status.legacyGlobalRules,
            expansionReasons: status.expansionReasons,
            explicitlyExcludedPendingReviews: status.explicitlyExcludedPendingReviews,
            retainedReviewPaths: this.diffTracker.getRetainedReviewPaths(),
            coverageGaps: this.diffTracker.getCoverageGaps(),
            coverageGeneration: this.diffTracker.getCoverageGeneration(),
            policyFingerprint: this.diffTracker.getPolicyFingerprint()
        });
    }

    private getHtmlContent(): string {
        const webview = this.panel.webview;
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'webview', 'watchExcludePanel.js'));
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src ${webview.cspSource};">
<title>Manage Monitoring Scope</title>
<style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);margin:0;padding:16px}
h1,h2{font-size:14px;margin:0 0 8px} h2{margin-top:18px}
p,.hint{color:var(--vscode-descriptionForeground);font-size:12px}
label{display:block;font-size:12px;margin:8px 0 4px}
select,textarea,input{width:100%;box-sizing:border-box;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:7px;font-family:var(--vscode-editor-font-family)}
textarea{min-height:120px;resize:vertical}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:6px 10px;cursor:pointer;border-radius:2px}
button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
pre{white-space:pre-wrap;word-break:break-word;background:var(--vscode-textCodeBlock-background);padding:8px;font-size:11px}
.test{display:flex;gap:8px;align-items:center}.test input{flex:1}.test span{font-size:12px}
</style>
</head>
<body>
<h1>Manage Monitoring Scope</h1>
<p>Requested settings are separate from the effective scope. Expansions require local authorization. Whole Workspace remains pending until S4-W coverage is available.</p>
<label for="mode">Requested mode</label>
<select id="mode"><option value="rules">Rules</option><option value="wholeWorkspace">Whole Workspace</option></select>
<label for="includes">Explicit includes (JSON array)</label>
<textarea id="includes" spellcheck="false"></textarea>
<label for="excludes">Explicit excludes (JSON array)</label>
<textarea id="excludes" spellcheck="false"></textarea>
<div class="actions">
<button id="save">Save Request</button>
<button id="apply">Apply Pending Scope</button>
<button id="reload" class="secondary">Reload</button>
</div>
<div class="actions">
<button id="migrate" class="secondary">Migrate Legacy Watch Rules</button>
<button id="restore" class="secondary">Restore Effective Configuration</button>
<button id="dismiss" class="secondary">Dismiss Consent Prompt</button>
</div>
<h2>Status</h2><pre id="status">Loading…</pre>
<h2>Test effective path</h2>
<div class="test"><input id="test-path" placeholder="e.g. src/app.ts"><button id="test-btn" class="secondary">Test</button><span id="test-result"></span></div>
<script src="${scriptUri}"></script>
</body>
</html>`;
    }

    public dispose(): void {
        WatchExcludePanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            this.disposables.pop()?.dispose();
        }
    }
}
