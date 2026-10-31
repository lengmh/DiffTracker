import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export function registerMonitoringLifecycleDiagnostics(h,fixture) {
    const {test,Uri,waitUntil}=h;
    for(const cause of ['disposed','recoveryBlocked','transaction','all']) test(`LIFECYCLE-DIAGNOSTICS distinguishes ${cause} without changing state`,()=>fixture(async({tracker,scope})=>{
        const original={disposed:tracker.disposed,recoveryBlocked:tracker.recoveryBlocked};
        const transaction=cause==='transaction'||cause==='all'?tracker.beginBaselineTransaction(()=>{}):undefined;
        tracker.disposed=cause==='disposed'||cause==='all';tracker.recoveryBlocked=cause==='recoveryBlocked'||cause==='all';
        tracker.persistenceIssue='Synthetic saved review is unreadable';
        try {
            const status=tracker.getMonitoringLifecycleStatus();
            assert.equal(status.disposed,tracker.disposed);assert.equal(status.recoveryBlocked,tracker.recoveryBlocked);
            assert.equal(status.baselineTransactionActive,!!transaction);
            const code=cause==='all'||cause==='disposed'?'disposed':cause==='recoveryBlocked'?'recovery-blocked':'baseline-transaction';
            assert.equal(status.blocker.code,code);
            const before=[...tracker.fileSnapshots];
            const result=await tracker.applyConfiguredMonitoringScope(scope);
            const preflight=await tracker.preflightConfiguredMonitoringScope(scope);
            assert.equal(result.status,'conflict');assert.equal(result.reason,status.blocker.reason);
            assert.equal(preflight.status,'conflict');assert.equal(preflight.reason,status.blocker.reason);
            assert.deepEqual([...tracker.fileSnapshots],before);
        } finally {
            tracker.disposed=original.disposed;tracker.recoveryBlocked=original.recoveryBlocked;
            if(transaction)tracker.endBaselineTransaction(transaction,false);
        }
    }));
    test('LIFECYCLE-DIAGNOSTICS transaction start end and interrupted preparation publish distinct status',()=>fixture(async({tracker})=>{
        const events=[];const subscription=tracker.onDidChangeLifecycleState(()=>events.push(tracker.getMonitoringLifecycleStatus()));
        const transaction=tracker.beginBaselineTransaction(()=>{});
        assert.equal(events.at(-1).baselineTransactionActive,true);
        tracker.endBaselineTransaction(transaction,false);assert.equal(events.at(-1).baselineTransactionActive,false);
        const prepared=tracker.beginBaselineTransaction(()=>{});prepared.baselineRecovery={prepared:true};
        tracker.advanceEpoch();
        assert.equal(tracker.getMonitoringLifecycleStatus().recoveryRequiresReload,true);
        assert.equal(tracker.getMonitoringLifecycleStatus().blocker.code,'recovery-reload-required');
        assert.equal((await tracker.retrySavedSessionRecovery()).status,'conflict');
        assert.match(tracker.getMonitoringLifecycleStatus().blocker.reason,/reload/i);
        subscription.dispose();
    }));
    test('LIFECYCLE-DIAGNOSTICS retry restores original saved review and Undo in paused mode',()=>fixture(async({tracker,dir,scope})=>{
        const file=path.join(dir,'review.txt');fs.writeFileSync(file,'original');
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status,'applied');
        fs.writeFileSync(file,'edited');await tracker.readFileAndUpdate(file,Uri.file(file));
        assert.equal((await tracker.revertFile(file)).status,'success');
        fs.writeFileSync(file,'later pending');await tracker.readFileAndUpdate(file,Uri.file(file));
        const history=structuredClone(tracker.revertHistory);
        assert.equal(await tracker.flushPendingPersistence(),true);
        tracker.isRecording=false;tracker.disposeFileWatchers();tracker.recoveryBlocked=true;
        tracker.persistenceIssue='Synthetic previous read failure';
        const result=await tracker.retrySavedSessionRecovery();
        assert.equal(result.status,'restored',JSON.stringify(result));
        assert.equal(tracker.getIsRecording(),false);assert.equal(tracker.isRecoveryBlocked(),false);
        assert.equal(tracker.getOriginalContent(file),'original');assert.equal(tracker.getTrackedChange(file)?.currentContent,'later pending');
        assert.deepEqual(tracker.revertHistory,history);assert.equal(fs.readFileSync(file,'utf8'),'later pending');
    }));
    test('LIFECYCLE-DIAGNOSTICS failed and duplicate recovery retry preserve original storage',()=>fixture(async({tracker})=>{
        const state=path.join(tracker.storageUri.fsPath,'session-state.json');fs.mkdirSync(tracker.storageUri.fsPath,{recursive:true});
        fs.writeFileSync(state,'synthetic unreadable session');tracker.isRecording=false;tracker.recoveryBlocked=true;
        const gate=h.pause(state,'read');const retry=tracker.retrySavedSessionRecovery();
        try {
            await gate.entered;assert.equal(tracker.getMonitoringLifecycleStatus().recoveryRetryActive,true);
            assert.equal((await tracker.retrySavedSessionRecovery()).status,'conflict');
            gate.release();const result=await retry;assert.equal(result.status,'blocked');
            assert.equal(fs.readFileSync(state,'utf8'),'synthetic unreadable session');assert.equal(tracker.isRecoveryBlocked(),true);
        } finally {gate.release();await retry;}
    }));
    test('LIFECYCLE-DIAGNOSTICS a late recovery retry cannot stop or block a newer epoch',()=>fixture(async({tracker,dir,scope})=>{
        const file=path.join(dir,'review.txt');fs.writeFileSync(file,'original');
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status,'applied');await tracker.flushPendingPersistence();
        tracker.isRecording=false;tracker.disposeFileWatchers();tracker.recoveryBlocked=true;
        const state=path.join(tracker.storageUri.fsPath,'session-state.json');const gate=h.pause(state,'read');
        const retry=tracker.retrySavedSessionRecovery();
        try {
            await gate.entered;tracker.advanceEpoch();const epoch=tracker.sessionEpoch;
            gate.release();assert.equal((await retry).status,'conflict');
            assert.equal(tracker.sessionEpoch,epoch);assert.equal(tracker.getIsRecording(),false);
        } finally {gate.release();await retry;}
    }));
    test('LIFECYCLE-DIAGNOSTICS Stop and dispose wait for a complete paused recovered projection',()=>fixture(async({tracker,dir,scope})=>{
        const file=path.join(dir,'review.txt');fs.writeFileSync(file,'original');
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status,'applied');
        fs.writeFileSync(file,'pending');await tracker.readFileAndUpdate(file,Uri.file(file));await tracker.flushPendingPersistence();
        tracker.isRecording=false;tracker.disposeFileWatchers();tracker.recoveryBlocked=true;
        const state=path.join(tracker.storageUri.fsPath,'session-state.json');const gate=h.pause(state,'read');
        const retry=tracker.retrySavedSessionRecovery();let disposal;
        try {
            await gate.entered;tracker.stopRecording();disposal=tracker.dispose();
            gate.release();assert.equal((await retry).status,'restored');await disposal;
            const saved=JSON.parse(fs.readFileSync(state,'utf8'));
            assert.equal(saved.isRecording,false);assert.equal(new Map(saved.fileSnapshots).get(file),'original');
            assert.equal(saved.stoppedReviews.find(review=>review.filePath===file)?.currentContent,'pending');
            assert.equal(fs.readFileSync(file,'utf8'),'pending');
        } finally {gate.release();await retry;await disposal;}
    }));
    test('LIFECYCLE-DIAGNOSTICS failed explicit discard preserves recovery evidence and reports the storage cause',()=>fixture(async({tracker})=>{
        const state=path.join(tracker.storageUri.fsPath,'session-state.json');fs.mkdirSync(tracker.storageUri.fsPath,{recursive:true});
        fs.writeFileSync(state,'synthetic unreadable session');tracker.isRecording=false;tracker.recoveryBlocked=true;
        h.faults.set(state,{delete:Object.assign(new Error('synthetic denied delete'),{code:'NoPermissions'})});
        try {
            assert.equal(await tracker.discardRecoveryState(),false);
            assert.equal(tracker.isRecoveryBlocked(),true);assert.equal(fs.readFileSync(state,'utf8'),'synthetic unreadable session');
            assert.match(tracker.getMonitoringLifecycleStatus().persistenceIssue,/Failed to discard/);
            assert.equal(tracker.getMonitoringLifecycleStatus().persistenceFailed,true);
        } finally {h.faults.clear();}
    }));

}
