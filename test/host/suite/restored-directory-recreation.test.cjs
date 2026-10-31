const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vscode=require('vscode');
const {DiffTracker}=require('../../../out/diffTracker.js');
const {validateAndCanonicalizeScope}=require('../../../out/monitoringScope.js');

async function until(description,predicate){
    const deadline=Date.now()+15000;
    while(!predicate()){
        assert.ok(Date.now()<deadline,description);
        await new Promise(resolve=>setTimeout(resolve,25));
    }
}

module.exports=async function restoredDirectoryRecreationHost(workspace){
    workspace=vscode.Uri.file(workspace).fsPath;
    assert.equal(vscode.workspace.getConfiguration('files').get('watcherExclude')['restored-recreate-host/**'],true);
    for(const retry of [false,true]){
        const root=path.join(workspace,'restored-recreate-host'),file=path.join(root,'review.txt');
        const unknown=path.join(root,'unproven.txt');
        const storage=vscode.Uri.file(fs.mkdtempSync(path.join(os.tmpdir(),'difftracker-restored-directory-host-')));
        let tracker=new DiffTracker(storage);
        try{
            fs.mkdirSync(root);fs.writeFileSync(file,'original host baseline');
            const requested=validateAndCanonicalizeScope({mode:'rules',includes:[{scope:'all',path:'restored-recreate-host'}],
                excludes:[{scope:'all',pattern:'/.vscode/'}]},tracker.currentWorkspaceRootIdentities());
            assert.equal(requested.ok,true);
            tracker.effectiveMonitoringScope={kind:'configured',...requested.scope};
            tracker.sessionWorkspaceRoots=tracker.getWorkspaceRoots();tracker.isRecording=true;
            tracker.externalWatcherEnabled=true;tracker.snapshotInitialized=true;
            tracker.fileSnapshots.set(file,'original host baseline');tracker.baselineExistingFiles.add(file);
            tracker.supplementalCoverageRoots.add(root);
            await fs.promises.rm(root,{recursive:true});
            tracker.setSubtreeCoverageGap(root,'supplemental-watcher-target-missing-gap','Synthetic historical missing directory');
            assert.equal(await tracker.flushPendingPersistence(),true);await tracker.dispose();
            tracker=new DiffTracker(storage);if(retry)tracker.recoveryBlocked=true;
            const save=tracker.flushPersistState.bind(tracker);let reconstructed=false;
            tracker.flushPersistState=async(...args)=>{
                if(tracker.missingDirectoryRetirement&&!reconstructed){
                    reconstructed=true;fs.mkdirSync(root);
                    fs.writeFileSync(file,'reconstructed during host certification');
                    fs.writeFileSync(unknown,'unproven child before-image');
                    // The workspace Host cannot see this watcher-excluded tree.
                    // Wait for the installed native parent owner's real callback.
                    await until('real reconstruction notification must reach the certification barrier',()=>
                        tracker.missingDirectoryRetirement?.dirty.size>0);
                }
                return save(...args);
            };
            const result=retry?await tracker.retrySavedSessionRecovery():await tracker.restorePersistedState();
            tracker.flushPersistState=save;
            assert.equal(retry?result.status:result,'restored',JSON.stringify(result));assert.equal(reconstructed,true);
            assert.equal(tracker.getOriginalContent(file),'original host baseline');
            assert.equal(tracker.getTrackedChange(file)?.currentContent,'reconstructed during host certification');
            assert.equal(tracker.getTrackedChange(file)?.isDeleted,false);
            assert.equal(tracker.unresolvedBaselineFiles.has(unknown),true,'native directory signal does not prove child absence');
            if(retry){
                assert.equal(tracker.getIsRecording(),false);
                const paused=JSON.parse(fs.readFileSync(path.join(storage.fsPath,'session-state.json')));
                const review=paused.stoppedReviews.find(item=>item.filePath===file);
                assert.equal(review?.currentContent,'reconstructed during host certification');assert.equal(review?.isDeleted,false);
            }else{
                assert.equal(tracker.supplementalDirectoryWatchers.get(root)?.epoch,tracker.sessionEpoch);
                assert.equal(tracker.supplementalDirectoryWatchers.get(root)?.observationDirectory,undefined);
                fs.writeFileSync(file,'later native host edit');
                await until('new persistent owner must observe later edits in the blind subtree',()=>
                    tracker.getTrackedChange(file)?.currentContent==='later native host edit');
            }
            console.log(`PASS HOST-RESTORE-RECREATE retry=${retry} real blind-subtree reconstruction is reconciled before recovery returns or saves paused review`);
        }finally{
            await tracker.dispose();await fs.promises.rm(root,{recursive:true,force:true});
            await fs.promises.rm(storage.fsPath,{recursive:true,force:true});
        }
    }
};
