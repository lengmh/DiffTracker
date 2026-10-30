import * as vscode from 'vscode';
import { DiffTracker } from './diffTracker';
import { MonitoringScopeApplyOutcome, MonitoringScopeConfirmation, MonitoringScopeController } from './monitoringScopeController';
import { MonitoringScopeRequest } from './monitoringScope';

type ScopeMessage = {
    command: string;
    mode?: unknown;
    includes?: unknown;
    excludes?: unknown;
    testPath?: string;
    baseVersion?: string;
    draftRevision?: number;
    actionId?: number;
    dirty?: boolean;
    leaseId?: number;
};

export class WatchExcludePanel {
    public static currentPanel: WatchExcludePanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private disposables: vscode.Disposable[] = [];
    private draftDirty = true;
    private draftKnown = false;
    private draftRevision = 0;
    private actionInProgress = false;
    private activeActionId?: number;
    private disposed = false;
    private nextLease = 0;
    private editorLease?: {id:number;resolve:(clean:boolean)=>void;timer:ReturnType<typeof setTimeout>};

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
        if (this.disposed) { return; }
        if (message.command === 'draftLockAck') {
            const lease = this.editorLease;
            if (lease && lease.id === message.leaseId) {
                const current = typeof message.draftRevision === 'number' && message.draftRevision >= this.draftRevision;
                if (current) {
                    this.draftRevision = message.draftRevision!;
                    this.draftDirty = message.dirty !== false;
                    this.draftKnown = true;
                }
                clearTimeout(lease.timer);
                lease.resolve(current && !this.draftDirty);
            }
            return;
        }
        if (message.command === 'draftChanged') {
            if (typeof message.draftRevision === 'number' && message.draftRevision >= this.draftRevision) {
                this.draftRevision = message.draftRevision;
                this.draftDirty = message.dirty !== false;
                this.draftKnown = true;
            }
            return;
        }
        if (message.command === 'reload') {
            await this.postStatus();
            return;
        }
        if (['saveAndApply','saveRequest','completeLegacyMigration'].includes(message.command) &&
            typeof message.draftRevision === 'number' && message.draftRevision < this.draftRevision) {
            void this.panel.webview.postMessage({command:'scopeOperation',actionId:message.actionId,
                outcome:{status:'conflict',reason:'A newer editor draft exists. The older save was not performed.'}});
            return;
        }
        if (this.actionInProgress && message.command !== 'testPath') {
            if (message.actionId !== this.activeActionId) {
                void this.panel.webview.postMessage({command:'scopeOperation',actionId:message.actionId,
                    outcome:{status:'conflict',reason:'Another scope action is in progress; your draft is preserved.'}});
            }
            return;
        }

        if (message.command === 'saveAndApply') {
            const revision = message.draftRevision;
            if (this.actionInProgress || typeof revision !== 'number' || revision < this.draftRevision || !message.baseVersion) {
                void this.panel.webview.postMessage({command:'scopeOperation',actionId:message.actionId,
                    outcome:{status:'conflict',reason:'The editor draft or another scope operation changed. Your draft is preserved.'}});
                return;
            }
            this.draftRevision = revision;
            this.draftDirty = true;
            this.draftKnown = true;
            this.actionInProgress = true;
            this.activeActionId = message.actionId;
            let outcome: MonitoringScopeApplyOutcome;
            try {
                const request = {mode:message.mode,includes:message.includes,excludes:message.excludes} as MonitoringScopeRequest;
                outcome = await this.scopeController.saveAndApplyScope(request,
                    proposal=>this.confirmScopeProposal(proposal),message.baseVersion,
                    ()=>!this.disposed && this.draftRevision === revision);
            } catch (error) {
                outcome = {status:'failed',reason:`Scope operation interrupted: ${String(error)} Check the effective scope in Status; your draft is preserved.`};
            } finally { this.actionInProgress = false; this.activeActionId = undefined; }
            const acceptDraft = outcome.scopeCommitted === true && outcome.settingsStatus === 'saved' && this.draftRevision === revision;
            await this.finishEditorAction(message,outcome,acceptDraft);
            return;
        }

        if (message.command === 'saveRequest') {
            const request = {mode:message.mode,includes:message.includes,excludes:message.excludes} as MonitoringScopeRequest;
            const revision = message.draftRevision ?? this.draftRevision;
            this.draftRevision = Math.max(this.draftRevision,revision);
            this.draftDirty = true;
            this.draftKnown = true;
            this.actionInProgress = true;
            this.activeActionId = message.actionId;
            let outcome: MonitoringScopeApplyOutcome;
            try {
                const result = message.baseVersion
                    ? await this.scopeController.saveRequestedScope(request,{expectedRequestVersion:message.baseVersion})
                    : {ok:false,errors:[{message:'Reload the saved settings before saving this draft.'}]};
                outcome = result.ok ? {status:'saved',settingsStatus:'saved',scopeCommitted:false,coverageStatus:'notRun',
                    reason:'Monitoring scope request saved only. It is pending until applied; excluded paths may pause reads.'}
                    : {status:'conflict',reason:result.errors.map(error=>error.message).join('; ')};
            } catch (error) {outcome={status:'failed',reason:`Request save did not complete: ${String(error)} Your draft is preserved.`};}
            finally {this.actionInProgress=false;this.activeActionId=undefined;}
            await this.finishEditorAction({...message,draftRevision:revision},outcome,outcome.status==='saved' && this.draftRevision===revision);
            return;
        }

        if (message.command === 'apply') {
            let outcome: MonitoringScopeApplyOutcome;
            if(message.baseVersion && message.baseVersion!==this.scopeController.getRequestVersion()){
                outcome={status:'conflict',reason:'Saved settings changed after this editor loaded. Review the current settings; your draft is preserved.'};
                this.showOutcome(outcome);
            }else{outcome=await this.applyInteractively();}
            void this.panel.webview.postMessage({command:'scopeOperation',actionId:message.actionId,
                draftRevision:message.draftRevision,acceptDraft:false,outcome});
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

        if (message.command === 'completeLegacyMigration') {
            const request = {mode:message.mode,includes:message.includes,excludes:message.excludes} as MonitoringScopeRequest;
            const answer = await vscode.window.showWarningMessage(
                'Save this editor target and mark the legacy monitoring migration as reviewed?',
                {
                    modal: true,
                    detail: 'The exact editor target is validated and saved first, then migration evidence is bound to that Scope Revision. The committed legacy policy remains effective until Apply succeeds.'
                },
                'Save and Mark Migration Complete'
            );
            if (answer === 'Save and Mark Migration Complete') {
                const outcome = await this.scopeController.completeLegacyMigrationUsingCurrentScope(request);
                if (outcome.status !== 'completed') {
                    void vscode.window.showWarningMessage(`Code Diff Tracker: ${outcome.reason ?? 'Current scope is invalid.'}`);
                }
            }
            await this.postStatus();
            return;
        }

        if (message.command === 'restoreEffective') {
            const expectedRequestVersion = this.scopeController.getRequestVersion();
            const expectedScopeRevision = this.diffTracker.getEffectiveMonitoringScope().scopeRevision;
            this.actionInProgress=true;
            this.activeActionId=message.actionId;
            let outcome: MonitoringScopeApplyOutcome = {status:'cancelled'};
            try {
                const answer = await vscode.window.showWarningMessage(
                    'Restore Workspace Settings to the currently effective DiffTracker monitoring scope?',
                    { modal: true },
                    'Restore Effective Scope'
                );
                if (answer === 'Restore Effective Scope') {
                    outcome = await this.scopeController.restoreEffectiveScopeConfiguration({expectedRequestVersion,expectedScopeRevision});
                }
            } catch(error) {outcome={status:'failed',reason:`Restore did not complete: ${String(error)}`};}
            finally {this.actionInProgress=false;this.activeActionId=undefined;}
            await this.finishEditorAction(message,outcome);
            return;
        }

        if (message.command === 'discardDraft') {
            const revision=this.draftRevision;
            this.actionInProgress=true;this.activeActionId=message.actionId;
            let outcome: MonitoringScopeApplyOutcome={status:'cancelled'};
            let acceptDraft=false;
            try {
                const answer=!this.draftDirty || await vscode.window.showWarningMessage('Discard the unsaved monitoring-scope draft?',
                    {modal:true,detail:'Only the editor draft will be replaced by current Workspace Settings. No settings, review or workspace files will be modified.'},
                    'Discard Draft and Reload')==='Discard Draft and Reload';
                if(answer && this.draftRevision===revision && !this.disposed){
                    acceptDraft=true;
                    outcome={status:'restored',settingsStatus:'unchanged',scopeCommitted:false,coverageStatus:'notRun',
                        reason:'Unsaved draft discarded. Current Workspace settings reloaded.'};
                }else if(answer){outcome={status:'conflict',reason:'The draft changed during confirmation and has been preserved.'};}
            }finally{this.actionInProgress=false;this.activeActionId=undefined;}
            await this.finishEditorAction({...message,draftRevision:revision},outcome,acceptDraft);
            return;
        }

        if (message.command === 'reviewConflict') {
            const revision=this.draftRevision;
            const version=this.scopeController.getRequestVersion();
            this.actionInProgress=true;this.activeActionId=message.actionId;
            let outcome: MonitoringScopeApplyOutcome={status:'cancelled'};
            try {
                const answer=await vscode.window.showWarningMessage('Keep this draft and use the current settings as its reviewed base?',
                    {modal:true,detail:`Current Workspace monitoring request:\n${JSON.stringify(this.scopeController.getRequestedRawScope(),null,2)}\n\nYour editor text will be preserved. No settings or review will change. Save and Apply will validate this draft against this exact version before applying it.`},
                    'Keep Draft and Use Current Base');
                if(answer==='Keep Draft and Use Current Base'){
                    if(!this.disposed && this.draftRevision===revision && this.scopeController.getRequestVersion()===version){
                        void this.panel.webview.postMessage({command:'draftBaseAccepted',actionId:message.actionId,draftRevision:revision,baseVersion:version});
                        outcome={status:'restored',settingsStatus:'unchanged',scopeCommitted:false,coverageStatus:'notRun',
                            reason:'Current settings reviewed. The draft is unchanged and can now be validated against this exact settings version.'};
                    }else{outcome={status:'conflict',reason:'Draft or settings changed during conflict review; the draft is preserved.'};}
                }
            }finally{this.actionInProgress=false;this.activeActionId=undefined;}
            await this.finishEditorAction({...message,draftRevision:revision},outcome);
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

    public reveal(): void {
        try { if (!this.disposed) {this.panel.reveal();} }
        catch { /* The webview may close before its disposal notification arrives. */ }
    }

    /** One bounded editor handshake; a clean draft stays locked through the quick action. */
    public async acquireQuickExclusion(): Promise<{current:()=>boolean;release:()=>Promise<void>} | undefined> {
        if (this.disposed || this.actionInProgress || !this.draftKnown || this.draftDirty) { return undefined; }
        const id = ++this.nextLease;
        this.actionInProgress = true;
        const clean = await new Promise<boolean>(resolve => {
            const timer = setTimeout(()=>resolve(false),2000);
            this.editorLease = {id,resolve,timer};
            try {
                Promise.resolve(this.panel.webview.postMessage({command:'lockDraft',leaseId:id}))
                    .then(sent=>{if(sent===false)resolve(false);},()=>resolve(false));
            }catch{resolve(false);}
        });
        if (!clean || this.disposed) { await this.releaseQuickExclusion(id);return undefined; }
        const revision = this.draftRevision;
        return {current:()=>!this.disposed && this.editorLease?.id === id && this.draftRevision === revision && !this.draftDirty,
            release:()=>this.releaseQuickExclusion(id)};
    }

    private async releaseQuickExclusion(id: number): Promise<void> {
        const lease = this.editorLease;
        if (!lease || lease.id !== id) { return; }
        clearTimeout(lease.timer);
        lease.resolve(false);
        this.editorLease = undefined;
        this.actionInProgress = false;
        if (!this.disposed) {
            try {
                await this.panel.webview.postMessage({command:'unlockDraft',leaseId:id});
                await this.postStatus();
            }catch{ /* Ownership is released even if the editor transport has closed. */ }
        }
    }

    private async finishEditorAction(message: ScopeMessage,outcome: MonitoringScopeApplyOutcome,acceptDraft=false): Promise<void> {
        if (this.disposed) { return; }
        if (acceptDraft && this.draftRevision === message.draftRevision) {this.draftDirty=false;}
        this.showOutcome(outcome);
        void this.panel.webview.postMessage({command:'scopeOperation',actionId:message.actionId,
            draftRevision:message.draftRevision,acceptDraft,outcome});
        await this.postStatus();
    }

    private async confirmScopeProposal(proposal: MonitoringScopeConfirmation): Promise<boolean> {
        const detail = [
            ...(proposal.expansionReasons.length ? ['Expanded file access:',...proposal.expansionReasons] : []),
            ...(proposal.affectedReviewPaths.length ? [`Discard ${proposal.affectedReviewPaths.length} pending review item(s):`,
                ...proposal.affectedReviewPaths.slice(0,20)] : []),
            'Workspace files will not be modified. Other reviews and original baselines are preserved.'
        ].join('\n');
        const answer = await vscode.window.showWarningMessage('Save and apply this monitoring scope?',
            {modal:true,detail},'Confirm and Apply');
        return answer === 'Confirm and Apply';
    }

    private showOutcome(outcome: MonitoringScopeApplyOutcome): void {
        this.scopeController.recordOperationOutcome(outcome);
        if (outcome.status === 'cancelled') { return; }
        const text = `Code Diff Tracker: ${outcome.reason ?? (outcome.status === 'applied'
            ? 'Monitoring scope applied and observation coverage verified.' : outcome.status)}`;
        if (outcome.status === 'applied' || outcome.status === 'restored' || outcome.status === 'saved') { void vscode.window.showInformationMessage(text); }
        else { void vscode.window.showWarningMessage(text); }
    }

    public async applyInteractively(): Promise<MonitoringScopeApplyOutcome> {
        if (this.actionInProgress || (this.draftKnown && this.draftDirty)) {
            const outcome: MonitoringScopeApplyOutcome = {status:'conflict',
                reason:'An unsaved draft or another scope action is open. Use Save and Apply for this draft; it has been preserved.'};
            this.showOutcome(outcome);
            return outcome;
        }
        const revision = this.draftRevision;
        this.actionInProgress = true;
        try {
            const outcome = await this.scopeController.saveAndApplyScope(
                this.scopeController.getRequestedRawScope() as MonitoringScopeRequest,
                proposal=>this.confirmScopeProposal(proposal),this.scopeController.getRequestVersion(),
                ()=>!this.disposed && this.draftRevision === revision);
            if (!this.disposed) { this.showOutcome(outcome); await this.postStatus(); }
            return outcome;
        } finally { this.actionInProgress = false; }
    }

    private async postStatus(): Promise<void> {
        const status = this.scopeController.getStatus();
        void this.panel.webview.postMessage({
            command: 'scopeStatus',
            requestVersion: this.scopeController.getRequestVersion(),
            operationOutcome: status.operationOutcome,
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
            legacyCommittedRules: status.legacyCommittedRules,
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
<p>Save and Apply validates this draft, confirms expanded access and review discards together, and verifies the resulting observation state. Workspace files are not modified.</p>
<label for="mode">Requested mode</label>
<select id="mode"><option value="rules">Rules</option><option value="wholeWorkspace">Whole Workspace</option></select>
<label for="includes">Explicit includes (JSON array)</label>
<textarea id="includes" spellcheck="false"></textarea>
<label for="excludes">Explicit excludes (JSON array)</label>
<textarea id="excludes" spellcheck="false"></textarea>
<div class="actions">
<button id="save-apply">Save and Apply</button>
<button id="save" class="secondary">Save Request Only</button>
<button id="apply" class="secondary">Apply Saved Request</button>
<button id="reload" class="secondary">Reload</button>
<button id="discard-draft" class="secondary">Discard Draft and Reload</button>
<button id="review-conflict" class="secondary">Review Settings Conflict</button>
</div>
<p id="draft-state" role="status"></p>
<div class="actions">
<button id="migrate" class="secondary">Migrate Legacy Watch Rules</button>
<button id="complete-migration" class="secondary">Mark Manual Migration Complete</button>
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
        if (this.disposed) { return; }
        this.disposed = true;
        if (this.editorLease) { void this.releaseQuickExclusion(this.editorLease.id); }
        WatchExcludePanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            this.disposables.pop()?.dispose();
        }
    }
}
