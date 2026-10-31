const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');
const {createHash} = require('node:crypto');
const {DiffTracker} = require('../../../out/diffTracker.js');
const {MonitoringScopeController} = require('../../../out/monitoringScopeController.js');

module.exports = async function monitoringLifecycleStatusHost(workspace) {
    workspace=vscode.Uri.file(workspace).fsPath;
    const file=path.join(workspace,'lifecycle-state-host.txt');
    // Persistence callbacks use VS Code Uri.fsPath, including Windows drive
    // normalization. Match the controlled barrier on that same boundary.
    const storage=vscode.Uri.file(fs.mkdtempSync(path.join(os.tmpdir(),'difftracker-lifecycle-host-'))).fsPath;
    const primary=path.join(storage,'session-state.json'),backup=path.join(storage,'session-state.last-good.json');
    let tracker=new DiffTracker(vscode.Uri.file(storage)),controller;
    try {
        fs.writeFileSync(file,'original lifecycle baseline');
        tracker.sessionWorkspaceRoots=tracker.getWorkspaceRoots();tracker.isRecording=true;tracker.externalWatcherEnabled=true;tracker.snapshotInitialized=true;
        // A valid legacy recording committed resource-scoped policy before a
        // newer structured Workspace request was saved. Do not borrow that
        // pending request to invent the old session's policy during recovery.
        tracker.committedLegacyWatchExcludeByRoot=new Map(vscode.workspace.workspaceFolders.map(folder=>[folder.uri.toString(),[]]));
        await tracker.refreshIgnoreMatchers();
        tracker.fileSnapshots.set(file,'original lifecycle baseline');tracker.baselineExistingFiles.add(file);
        fs.writeFileSync(file,'pending lifecycle edit');await tracker.readFileAndUpdate(file,vscode.Uri.file(file));
        assert.equal(await tracker.flushPendingPersistence(),true);
        const saved=fs.readFileSync(primary);await tracker.dispose();
        fs.writeFileSync(primary,'synthetic unreadable session');fs.writeFileSync(backup,'synthetic unreadable backup');
        tracker=new DiffTracker(vscode.Uri.file(storage));
        const values=new Map();controller=new MonitoringScopeController({workspaceState:{get:key=>values.get(key),update:async(key,value)=>values.set(key,value)}},tracker);
        const observed=[];const subscription=controller.onDidChangeStatus(()=>observed.push(controller.getStatus()));
        assert.equal(await tracker.restorePersistedState(),'blocked');
        const status=controller.getStatus();
        assert.equal(status.lifecycle.recoveryBlocked,true);assert.equal(status.lifecycle.blocker.code,'recovery-blocked');
        assert.ok(status.lifecycle.persistenceIssue);
        assert.equal(status.effective.kind,'legacyV3');assert.equal(status.legacyMigrationComplete,true);
        assert.equal(status.migration.stage,'legacy-awaiting-apply','legacy compatibility plus a saved request is distinct from corrupted recovery');
        const scope=status.requested.scope;assert.ok(scope);
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).reason,status.lifecycle.blocker.reason);
        assert.equal((await tracker.preflightConfiguredMonitoringScope(scope)).reason,status.lifecycle.blocker.reason);
        const transaction=tracker.beginBaselineTransaction(()=>{});
        assert.equal(controller.getStatus().lifecycle.baselineTransactionActive,true);
        assert.equal(observed.at(-1).lifecycle.blocker.code,'baseline-transaction');
        tracker.endBaselineTransaction(transaction,false);
        assert.equal(observed.at(-1).lifecycle.baselineTransactionActive,false);
        const missingPolicy=JSON.parse(saved);missingPolicy.legacyWatchExcludeByRoot=[];
        fs.writeFileSync(backup,JSON.stringify(missingPolicy));
        const missingPolicyBytes=fs.readFileSync(backup);
        assert.equal((await tracker.retrySavedSessionRecovery()).status,'blocked');
        assert.match(tracker.getMonitoringLifecycleStatus().persistenceIssue,/Committed resource-scoped legacy watchExclude policy is unavailable/);
        assert.deepEqual(fs.readFileSync(backup),missingPolicyBytes,'retry must not invent committed legacy policy from the newer request');
        console.log('PASS HOST-LIFECYCLE-DIAGNOSTICS missing committed legacy policy stays blocked with its actual reason and preserves last-good evidence');
        fs.writeFileSync(backup,saved);
        const requestedBefore=JSON.stringify(controller.getStatus().rawRequested);
        const recovered=await tracker.retrySavedSessionRecovery();
        assert.equal(recovered.status,'recovered',JSON.stringify(recovered));
        controller.reconcileRequestedScope();
        assert.equal(tracker.getIsRecording(),false);assert.equal(tracker.isRecoveryBlocked(),false);
        assert.equal(tracker.getOriginalContent(file),'original lifecycle baseline');
        assert.equal(tracker.getTrackedChange(file)?.currentContent,'pending lifecycle edit');
        assert.equal(fs.readFileSync(file,'utf8'),'pending lifecycle edit');
        assert.equal(JSON.stringify(controller.getStatus().rawRequested),requestedBefore);
        assert.ok(observed.some(item=>item.lifecycle.recoveryRetryActive));
        assert.equal(observed.at(-1).lifecycle.recoveryRetryActive,false);
        const intent=path.join(storage,'session-state.keep-in-progress.json');
        fs.writeFileSync(path.join(storage,'session-state.pre-keep.json'),saved);
        fs.writeFileSync(intent,JSON.stringify({version:1,backupSha256:createHash('sha256').update(saved).digest('hex')}));
        const remove=tracker.deletePersistedFile.bind(tracker);let cleanupEdit=false;
        tracker.deletePersistedFile=async uri=>{
            if(uri.fsPath===intent && !cleanupEdit){
                cleanupEdit=true;fs.writeFileSync(file,'newer edit during intent cleanup');
                const deadline=Date.now()+15000;
                while(!tracker.restoreEvents.has(file)){
                    assert.ok(Date.now()<deadline,'real Host must deliver the intent-cleanup edit before its barrier is released');
                    await new Promise(resolve=>setTimeout(resolve,25));
                }
            }
            return remove(uri);
        };
        tracker.recoveryBlocked=true;
        assert.equal((await tracker.retrySavedSessionRecovery()).status,'recovered');
        tracker.deletePersistedFile=remove;
        assert.equal(cleanupEdit,true);assert.equal(tracker.getIsRecording(),false);
        assert.equal(tracker.getOriginalContent(file),'original lifecycle baseline');
        assert.equal(tracker.getTrackedChange(file)?.currentContent,'newer edit during intent cleanup');
        assert.equal(JSON.parse(fs.readFileSync(primary)).stoppedReviews.find(review=>review.filePath===file)?.currentContent,'newer edit during intent cleanup');
        console.log('PASS HOST-LIFECYCLE-DIAGNOSTICS real edit during interrupted Keep intent cleanup is reconciled before retry saves the paused review');
        subscription.dispose();
        console.log('PASS HOST-LIFECYCLE-DIAGNOSTICS distinct recovery/transaction status, valid legacy compatibility and last-good retry preserve original review in paused mode');
        await vscode.extensions.getExtension('lengmh.code-diff-tracker').activate();
        const commands=await vscode.commands.getCommands();
        assert.ok(commands.includes('diffTracker.retrySavedSessionRecovery'));assert.ok(commands.includes('diffTracker.discardSavedSessionRecovery'));
        assert.equal((await vscode.commands.executeCommand('diffTracker.retrySavedSessionRecovery')).status,'conflict');
        assert.equal(await vscode.commands.executeCommand('diffTracker.discardSavedSessionRecovery'),false);
        console.log('PASS HOST-LIFECYCLE-DIAGNOSTICS public recovery commands refuse an unrelated healthy session without mutation');
    } finally {
        controller?.dispose();await tracker.dispose();
        await fs.promises.rm(storage,{recursive:true,force:true});await fs.promises.rm(file,{force:true});
    }
};
