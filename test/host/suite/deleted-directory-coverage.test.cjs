const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');
const {DiffTracker} = require('../../../out/diffTracker.js');
const {validateAndCanonicalizeScope} = require('../../../out/monitoringScope.js');

async function until(description, predicate, tracker) {
    const deadline = Date.now() + 15000;
    while (!predicate()) {
        if (Date.now() > deadline) { throw new Error(`${description}: ${JSON.stringify({gaps:tracker.getSubtreeCoverageGaps(),reviews:tracker.getTrackedChanges().map(change=>({name:path.basename(change.filePath),kind:change.reviewKind,deleted:change.isDeleted}))})}`); }
        await new Promise(resolve=>setTimeout(resolve,25));
    }
}
module.exports = async function deletedDirectoryCoverageHost(workspace) {
    // Production watcher paths enter through VS Code Uri.fsPath (including
    // Windows drive normalization). Seed direct-owner keys on that same boundary.
    workspace = vscode.Uri.file(workspace).fsPath;
    const container = path.join(workspace,'deleted-coverage-host');
    const parent = path.join(container,'deep');
    const root = path.join(parent,'selected');
    const file = path.join(root,'review.txt');
    const sibling = path.join(workspace,'deleted-coverage-sibling-host.txt');
    const storage = fs.mkdtempSync(path.join(os.tmpdir(),'difftracker-deleted-host-'));
    let tracker = new DiffTracker(vscode.Uri.file(storage));
    try {
        fs.mkdirSync(root,{recursive:true}); fs.writeFileSync(file,'original host baseline');
        fs.writeFileSync(sibling,'original sibling baseline');
        const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));
        const requested = validateAndCanonicalizeScope({mode:'rules',includes:[{scope:'folder',folder:folder.name,path:'deleted-coverage-host/deep/selected'}],excludes:[]},tracker.currentWorkspaceRootIdentities());
        assert.equal(requested.ok,true);
        tracker.effectiveMonitoringScope = {kind:'configured',...requested.scope};
        tracker.sessionWorkspaceRoots = tracker.getWorkspaceRoots();
        tracker.isRecording = true; tracker.externalWatcherEnabled = true; tracker.snapshotInitialized = true;
        tracker.fileSnapshots.set(file,'original host baseline'); tracker.baselineExistingFiles.add(file);
        tracker.fileSnapshots.set(sibling,'original sibling baseline'); tracker.baselineExistingFiles.add(sibling);
        await tracker.installSupplementalCoverageTargets([root],tracker.sessionEpoch,true);
        tracker.commitSupplementalCoverageTargets([root]);
        assert.equal(tracker.fileWatchers.length,0,'native filesystem callbacks alone must observe this lifecycle');
        const old = tracker.supplementalDirectoryWatchers.get(root);
        // Let Windows deliver native self-delete callbacks while descendant
        // handles are removed. This is one asynchronous delete, with no retry.
        await fs.promises.rm(container,{recursive:true});
        await until('native ancestor deletion must retain review and certify reconstruction',()=>
            old.epoch === -1 && tracker.getTrackedChange(file)?.isDeleted &&
            tracker.supplementalDirectoryWatchers.get(root)?.observationDirectory === workspace &&
            !tracker.getSubtreeCoverageGaps().length,tracker);
        assert.equal(tracker.getOriginalContent(file),'original host baseline');
        fs.mkdirSync(container);
        await until('first missing ancestor reconstruction',()=>tracker.supplementalDirectoryWatchers.get(root)?.observationDirectory === container &&
            tracker.supplementalDirectoryWatchers.get(root)?.epoch === tracker.sessionEpoch,tracker);
        fs.mkdirSync(parent);
        await until('second missing ancestor reconstruction',()=>tracker.supplementalDirectoryWatchers.get(root)?.observationDirectory === parent &&
            tracker.supplementalDirectoryWatchers.get(root)?.epoch === tracker.sessionEpoch,tracker);
        fs.mkdirSync(root);
        await until('empty recreation must install a new direct owner',()=>tracker.supplementalDirectoryWatchers.get(root)?.epoch === tracker.sessionEpoch &&
            !tracker.supplementalDirectoryWatchers.get(root)?.observationDirectory && !tracker.getSubtreeCoverageGaps().length,tracker);
        fs.writeFileSync(file,'recreated host content');
        await until('edit after empty reconstruction',()=>tracker.getTrackedChange(file)?.currentContent === 'recreated host content',tracker);
        fs.writeFileSync(file,'later host edit');
        await until('continued native edit observation',()=>tracker.getTrackedChange(file)?.currentContent === 'later host edit',tracker);
        assert.equal(tracker.getOriginalContent(file),'original host baseline');
        console.log('PASS HOST-DELETED-COVERAGE native ancestor deletion, chain reconstruction, empty recreation and continued edits preserve baseline');
        // Save a certified absent state, then reconstruct its OS owner in a new
        // tracker. No live handle or missing-directory fact crosses this boundary.
        await fs.promises.rm(root,{recursive:true});
        await until('second native deletion',()=>tracker.getTrackedChange(file)?.isDeleted && !tracker.getSubtreeCoverageGaps().length &&
            tracker.supplementalDirectoryWatchers.get(root)?.observationDirectory === parent,tracker);
        assert.equal(await tracker.flushPendingPersistence(),true);
        await tracker.dispose();
        tracker = new DiffTracker(vscode.Uri.file(storage));
        const save=tracker.flushPersistState.bind(tracker);let certificationEdit=false;
        tracker.flushPersistState=async(...args)=>{
            if(tracker.missingDirectoryRetirement && !certificationEdit){
                certificationEdit=true;
                fs.writeFileSync(sibling,'sibling edited during restore certification');
                // Hold the real persistence boundary until the real Host watcher
                // reports this unrelated edit. Do not inject its callback.
                await until('native sibling notification during restore certification',()=>tracker.restoreEvents.has(sibling),tracker);
            }
            return save(...args);
        };
        assert.equal(await tracker.restorePersistedState(),'restored');
        tracker.flushPersistState=save;
        assert.equal(certificationEdit,true);
        assert.equal(tracker.getOriginalContent(sibling),'original sibling baseline');
        assert.equal(tracker.getTrackedChange(sibling)?.currentContent,'sibling edited during restore certification');
        console.log('PASS HOST-DELETED-COVERAGE real unrelated edit during restore certification is drained before recovery returns');
        assert.equal(tracker.getOriginalContent(file),'original host baseline');
        assert.equal(tracker.getTrackedChange(file)?.isDeleted,true);
        assert.deepEqual(tracker.getSubtreeCoverageGaps(),[]);
        const token = tracker.getReviewToken(file);
        const notifications=[];
        const defer=tracker.deferCoverageRecheckEvent;
        tracker.deferCoverageRecheckEvent=function(uri,kind) {
            if(this.coverageRecheckEpoch===this.sessionEpoch){notifications.push({name:path.relative(workspace,uri.fsPath),kind});}
            return defer.call(this,uri,kind);
        };
        const rechecked=await tracker.recheckObservationCoverage();
        tracker.deferCoverageRecheckEvent=defer;
        if (rechecked.status === 'limited') {
            // The real Host can deliver the preceding native deletion to a
            // newly registered recursive listener during this explicit Recheck.
            // That is real concurrent evidence: preserve its root marker. Do
            // not sleep/retry or weaken the production event barrier to force Full.
            assert.ok(notifications.length > 0);
            assert.ok(notifications.every(event=>event.name===path.relative(workspace,root) && event.kind==='delete'),JSON.stringify(notifications));
            assert.ok(tracker.getSubtreeCoverageGaps().some(gap=>gap.targetPath===workspace && gap.reasonCode==='coverage-recheck-incomplete'));
            console.log('PASS HOST-DELETED-COVERAGE public Recheck preserves Limited for real concurrent deletion callbacks');
        } else { assert.equal(rechecked.status,'rechecked',JSON.stringify({rechecked,gaps:tracker.getSubtreeCoverageGaps()})); }
        assert.deepEqual(tracker.getReviewToken(file),token);
        fs.mkdirSync(root); fs.writeFileSync(file,'populated host recreation');
        await until('populated recreation after restore',()=>tracker.getTrackedChange(file)?.currentContent === 'populated host recreation' &&
            !tracker.getSubtreeCoverageGaps().some(gap=>tracker.pathBelongsToRoot(gap.targetPath,root)),tracker);
        fs.writeFileSync(file,'after restored native handoff');
        await until('later edit after restore',()=>tracker.getTrackedChange(file)?.currentContent === 'after restored native handoff',tracker);
        assert.equal(tracker.getOriginalContent(file),'original host baseline');
        console.log('PASS HOST-DELETED-COVERAGE durable absent owner restore and populated recreation preserve deletion review');
        const batchParent=path.join(container,'parallel');fs.mkdirSync(batchParent);
        const roots=Array.from({length:7},(_,index)=>path.join(batchParent,`temporary-${index}`));
        const batchStorage=fs.mkdtempSync(path.join(os.tmpdir(),'difftracker-deleted-batch-host-'));
        const batch=new DiffTracker(vscode.Uri.file(batchStorage));
        try {
            batch.effectiveMonitoringScope=tracker.effectiveMonitoringScope;
            batch.sessionWorkspaceRoots=batch.getWorkspaceRoots();
            batch.isRecording=true;batch.externalWatcherEnabled=true;batch.snapshotInitialized=true;
            for(const directory of roots){
                fs.mkdirSync(directory);const target=path.join(directory,'review.txt');fs.writeFileSync(target,'batch baseline');
                batch.fileSnapshots.set(target,'batch baseline');batch.baselineExistingFiles.add(target);
            }
            await batch.installSupplementalCoverageTargets(roots,batch.sessionEpoch,true);batch.commitSupplementalCoverageTargets(roots);
            assert.equal(batch.fileWatchers.length,0);
            for(const directory of roots){await fs.promises.rm(directory,{recursive:true});}
            await until('seven real native deletions must all finish durable retirement',()=>roots.every(directory=>
                batch.getTrackedChange(path.join(directory,'review.txt'))?.isDeleted &&
                batch.supplementalDirectoryWatchers.get(directory)?.observationDirectory===batchParent) &&
                !batch.getSubtreeCoverageGaps().length,batch);
            assert.equal(await batch.flushPendingPersistence(),true);
            assert.equal(batch.activeDirectDirectoryWatcherCount(batch.sessionEpoch),7);
            for(const directory of roots){assert.equal(batch.getOriginalContent(path.join(directory,'review.txt')),'batch baseline');}
            console.log('PASS HOST-DELETED-COVERAGE seven concurrent native deletions retire every identity without losing review');
        } finally {await batch.dispose();fs.rmSync(batchStorage,{recursive:true,force:true});}

    } finally {
        await tracker.dispose();
        await fs.promises.rm(sibling,{force:true});
        await fs.promises.rm(container,{recursive:true,force:true}); await fs.promises.rm(storage,{recursive:true,force:true});
    }
};
