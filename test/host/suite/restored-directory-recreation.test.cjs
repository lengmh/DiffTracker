const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createHash}=require('node:crypto');
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
        const unknown=path.join(root,'unproven.txt'),proven=path.join(root,`proven-${retry?'retry':'restore'}.txt`);
        const storage=vscode.Uri.file(fs.mkdtempSync(path.join(os.tmpdir(),'difftracker-restored-directory-host-')));
        let tracker=new DiffTracker(storage);
        const exactCreates=[];
        const created=vscode.workspace.onDidCreateFiles(event=>{for(const uri of event.files){exactCreates.push(uri.fsPath);}});
        try{
            fs.mkdirSync(root);fs.writeFileSync(file,'original host baseline');
            const requested=validateAndCanonicalizeScope({mode:'rules',includes:[{scope:'all',path:'restored-recreate-host'}],
                excludes:[{scope:'all',pattern:'/.vscode/'}]},tracker.currentWorkspaceRootIdentities());
            assert.equal(requested.ok,true);
            tracker.effectiveMonitoringScope={kind:'configured',...requested.scope};
            tracker.sessionWorkspaceRoots=tracker.getWorkspaceRoots();tracker.isRecording=true;
            tracker.externalWatcherEnabled=true;tracker.snapshotInitialized=true;
            tracker.fileSnapshots.set(file,'original host baseline');tracker.baselineExistingFiles.add(file);
            tracker.recordUnresolvedBaseline(unknown,'Historical child before-image was not recorded');
            tracker.supplementalCoverageRoots.add(root);
            await fs.promises.rm(root,{recursive:true});
            tracker.setSubtreeCoverageGap(root,'supplemental-watcher-target-missing-gap','Synthetic historical missing directory');
            assert.equal(await tracker.flushPendingPersistence(),true);await tracker.dispose();
            tracker=new DiffTracker(storage);if(retry)tracker.recoveryBlocked=true;
            const notifications=[],dispatch=tracker.dispatchExternalEvent;
            tracker.dispatchExternalEvent=function(uri,kind,epoch,...metadata){
                if(notifications.length<32&&path.dirname(uri.fsPath)===root){
                    notifications.push({name:path.basename(uri.fsPath),kind,retirement:!!this.missingDirectoryRetirement});
                }
                return dispatch.call(this,uri,kind,epoch,...metadata);
            };
            const save=tracker.flushPersistState.bind(tracker);let reconstructed=false;
            tracker.flushPersistState=async(...args)=>{
                if(tracker.missingDirectoryRetirement&&!reconstructed){
                    reconstructed=true;fs.mkdirSync(root);
                    fs.writeFileSync(file,'reconstructed during host certification');
                    fs.writeFileSync(unknown,'unproven child before-image');
                    const edit=new vscode.WorkspaceEdit();edit.createFile(vscode.Uri.file(proven));
                    assert.equal(await vscode.workspace.applyEdit(edit),true);
                    await vscode.workspace.fs.writeFile(vscode.Uri.file(proven),Buffer.from('independently created during certification'));
                    await until('real onDidCreateFiles must deliver exact file proof during retirement',()=>exactCreates.includes(proven));
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
            assert.equal(tracker.getOriginalContent(proven),'','actual independent file-create proof must survive retirement');
            assert.equal(tracker.unresolvedBaselineFiles.has(proven),false);assert.ok(tracker.getReviewToken(proven));
            assert.equal(tracker.getTrackedChange(proven)?.currentContent,'independently created during certification');
            assert.equal(tracker.unresolvedBaselineFiles.has(unknown),true,JSON.stringify({
                reason:'historical Unknown must survive any later file-create notification',notifications,
                adoptedBaseline:tracker.fileSnapshots.has(unknown),baselineExisted:tracker.baselineExistingFiles.has(unknown)
            }));
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
            console.log(`PASS HOST-RESTORE-RECREATE retry=${retry} real reconstruction reconciles known review and preserves historical Unknown; childCreates=${notifications.filter(item=>item.name==='unproven.txt'&&item.kind==='create').length}`);
        }finally{
            created.dispose();await tracker.dispose();await fs.promises.rm(root,{recursive:true,force:true});
            await fs.promises.rm(storage.fsPath,{recursive:true,force:true});
        }
    }
    for(const operation of ['keep','restore'])for(const retry of [false,true]){
        const root=path.join(workspace,'restored-recreate-host'),file=path.join(root,'review.txt');
        const child=path.join(root,`unproven-${operation}-${retry?'retry':'restore'}.txt`);
        const ignored=path.join(workspace,`ignored-${operation}-${retry?'retry':'restore'}`);
        const observeIgnored=operation==='keep'&&!retry;
        const storage=vscode.Uri.file(fs.mkdtempSync(path.join(os.tmpdir(),'difftracker-cleanup-provenance-host-')));
        const stage=fs.mkdtempSync(path.join(workspace,'.vscode','cleanup-stage-'));
        let tracker=new DiffTracker(storage);
        try{
            fs.mkdirSync(root);fs.writeFileSync(file,'original cleanup baseline');
            const requested=validateAndCanonicalizeScope({mode:'rules',includes:[{scope:'all',path:'restored-recreate-host'}],
                excludes:[{scope:'all',pattern:'/.vscode/'},{scope:'all',pattern:`/${path.basename(ignored)}/`}]},tracker.currentWorkspaceRootIdentities());
            assert.equal(requested.ok,true);
            tracker.effectiveMonitoringScope={kind:'configured',...requested.scope};
            tracker.sessionWorkspaceRoots=tracker.getWorkspaceRoots();tracker.isRecording=true;
            tracker.externalWatcherEnabled=true;tracker.snapshotInitialized=true;
            tracker.fileSnapshots.set(file,'original cleanup baseline');tracker.baselineExistingFiles.add(file);
            tracker.supplementalCoverageRoots.add(root);
            await fs.promises.rm(root,{recursive:true});
            tracker.setSubtreeCoverageGap(root,'supplemental-watcher-target-missing-gap','Synthetic interrupted-operation directory');
            assert.equal(await tracker.flushPendingPersistence(),true);await tracker.dispose();
            const saved=fs.readFileSync(path.join(storage.fsPath,'session-state.json'));
            const intent=path.join(storage.fsPath,`session-state.${operation}-in-progress.json`);
            fs.writeFileSync(path.join(storage.fsPath,`session-state.pre-${operation}.json`),saved);
            fs.writeFileSync(intent,JSON.stringify({version:1,backupSha256:createHash('sha256').update(saved).digest('hex')}));
            fs.writeFileSync(path.join(stage,'review.txt'),'reconstructed during intent cleanup');
            fs.writeFileSync(path.join(stage,path.basename(child)),'unproven contents');
            tracker=new DiffTracker(storage);if(retry)tracker.recoveryBlocked=true;
            const notifications=[],dispatch=tracker.dispatchExternalEvent;
            tracker.dispatchExternalEvent=function(uri,kind,epoch,...metadata){
                if(notifications.length<32&&(uri.fsPath===root||uri.fsPath===ignored||path.dirname(uri.fsPath)===root)){
                    notifications.push({name:path.basename(uri.fsPath),kind,observationOnly:!!metadata[0]});
                }
                return dispatch.call(this,uri,kind,epoch,...metadata);
            };
            const remove=tracker.deletePersistedFile.bind(tracker);let reconstructed=false;
            tracker.deletePersistedFile=async uri=>{
                if(uri.fsPath===intent&&!reconstructed){
                    reconstructed=true;assert.equal(tracker.missingDirectoryRetirement,undefined);
                    // Move an already populated tree under a real watcher-excluded
                    // root. No installed child owner can see individual creations.
                    fs.renameSync(stage,root);
                    if(observeIgnored){
                        fs.mkdirSync(ignored);fs.writeFileSync(path.join(ignored,'unread.txt'),'excluded contents');
                        await until('real directory-ignored Host create must arrive during intent cleanup',()=>tracker.restoreEvents.has(ignored));
                        assert.equal(tracker.isPathIgnored(vscode.Uri.file(ignored),true),true);
                        assert.equal(tracker.isPathIgnored(vscode.Uri.file(ignored)),false);
                    }
                    await until('real parent notification must arrive during intent cleanup',()=>tracker.restoreEvents.has(root));
                }
                return remove(uri);
            };
            const result=retry?await tracker.retrySavedSessionRecovery():await tracker.restorePersistedState();
            tracker.deletePersistedFile=remove;
            assert.equal(retry?result.status:result,'recovered',JSON.stringify(result));assert.equal(reconstructed,true);
            assert.equal(notifications.some(item=>item.name===path.basename(child)&&item.kind==='create'),false,
                `this regression requires only a coarse directory notification: ${JSON.stringify(notifications)}`);
            assert.equal(tracker.getOriginalContent(file),'original cleanup baseline');
            assert.equal(tracker.getTrackedChange(file)?.currentContent,'reconstructed during intent cleanup');
            const document=await vscode.workspace.openTextDocument(child);
            assert.equal(document.getText(),'unproven contents');assert.equal(document.isDirty,false);
            const blockResult=await tracker.revertBlock(child,0);
            assert.equal(blockResult.status,'conflict',JSON.stringify({
                reason:'parent-only reconstruction must not permit a block Revert against an invented empty baseline',
                operation,retry,notifications,adoptedBaseline:tracker.fileSnapshots.get(child),
                unresolved:tracker.unresolvedBaselineFiles.has(child),buffer:document.getText()
            }));
            assert.equal(document.getText(),'unproven contents');assert.equal(document.isDirty,false);
            assert.equal(fs.readFileSync(child,'utf8'),'unproven contents');
            assert.equal(tracker.unresolvedBaselineFiles.has(child),true);assert.equal(tracker.getReviewToken(child),undefined);
            if(observeIgnored){
                const excludedChild=path.join(ignored,'unread.txt');
                assert.equal(tracker.fileSnapshots.has(excludedChild),false);assert.equal(tracker.unresolvedBaselineFiles.has(excludedChild),false);
                assert.equal(tracker.supplementalDirectoryWatchers.has(ignored),false);assert.equal(tracker.importedDirectoryWatchers.has(ignored),false);
                console.log('PASS HOST-IGNORED-DIRECTORY real directory-only excluded create cannot block preserved-review recovery');
            }
            if(retry){
                const paused=JSON.parse(fs.readFileSync(path.join(storage.fsPath,'session-state.json')));
                assert.ok(new Map(paused.unresolvedBaselineFiles).has(child));
                assert.equal(new Map(paused.fileSnapshots).has(child),false);assert.equal(paused.isRecording,false);
            }
            console.log(`PASS HOST-INTENT-PROVENANCE operation=${operation} retry=${retry} real parent-only notification preserves Unknown and block Revert leaves buffer/disk unchanged`);
        }finally{
            await tracker.dispose();await fs.promises.rm(root,{recursive:true,force:true});
            await fs.promises.rm(stage,{recursive:true,force:true});await fs.promises.rm(ignored,{recursive:true,force:true});
            await fs.promises.rm(storage.fsPath,{recursive:true,force:true});
        }
    }

};
