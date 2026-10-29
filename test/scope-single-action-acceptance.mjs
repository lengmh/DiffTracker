import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Existing acceptance seams: production controller/tracker public operations,
// actual temporary files, mocked VS Code/native notifications and storage faults.
export function registerScopeSingleActionAcceptance(h,fixture,scopeFor,withController) {
    const {test,Uri}=h;

    for(const entry of ['resource','coverage','editor'])
    test(`A5 SCOPE ${entry} exclusion completes locally without rechecking an unrelated dirty failure`,()=>fixture(async({tracker,dir,scope})=>{
        const selected=path.join(dir,'selected');fs.mkdirSync(selected);
        const target=path.join(selected,'tracked.txt'),other=path.join(dir,'other.txt');
        fs.writeFileSync(target,'selected baseline');fs.writeFileSync(other,'other baseline');
        h.setVsCodeExcludes({'files.watcherExclude':{'selected/**':true}});
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status,'applied');
        tracker.setSubtreeCoverageGap(selected,'supplemental-watcher-directory-change-gap','Selected interval');
        tracker.setFileCoverageGap(other,'file-read-failed','Independent read failure');
        tracker.markFileUnavailable(other,'Independent read failure');
        const otherBefore=structuredClone(tracker.getTrackedChange(other));
        const recheck=tracker.recheckObservationCoverage.bind(tracker);let rechecks=0;
        tracker.recheckObservationCoverage=(...args)=>{rechecks++;return recheck(...args);};
        const dirty={uri:Uri.file(other),isDirty:true};h.vscode.workspace.textDocuments.push(dirty);
        try{await withController(tracker,scope,async({controller,config})=>{
            const outcome=entry==='resource'?await controller.excludeResource(selected,true,async()=>true)
                :entry==='coverage'?await controller.excludeCoverageSubtree(selected,async()=>true)
                    :await controller.saveAndApplyScope({mode:'wholeWorkspace',includes:[],excludes:[{scope:'all',pattern:'/selected/'}]},async()=>true);
            assert.equal(outcome.status,'applied',JSON.stringify(outcome));
            assert.equal(rechecks,0,'an unrelated fault must not cause a full-scope recovery action');
            assert.ok(config.watchExclude.some(rule=>rule.pattern==='/selected/'));
            assert.equal(tracker.getSubtreeCoverageGaps().some(gap=>gap.targetPath===selected),false);
            assert.equal(tracker.coverageGaps.get(other)?.file?.reasonCode,'file-read-failed');
            assert.deepEqual(tracker.getTrackedChange(other),otherBefore);
            assert.ok(outcome.unrelatedCoverageGaps?.some(([file])=>file===other),'other active failures remain explicit');
            assert.equal(fs.readFileSync(target,'utf8'),'selected baseline');
        });}finally{h.vscode.workspace.textDocuments.splice(h.vscode.workspace.textDocuments.indexOf(dirty),1);}
    }));

    for(const approved of [false,true])
    test(`A5 SCOPE mixed review ${approved?'Apply':'Cancel'} preserves unrelated public Undo`,()=>fixture(async({tracker,dir,scope})=>{
        const selected=path.join(dir,'selected');fs.mkdirSync(selected);
        const text=path.join(selected,'text.txt'),opaque=path.join(selected,'opaque.bin'),large=path.join(selected,'large.txt');
        const undo=path.join(dir,'undo.txt');
        fs.writeFileSync(text,'text baseline');fs.writeFileSync(opaque,Buffer.from([0,1,2]));
        fs.writeFileSync(large,'large baseline');fs.writeFileSync(undo,'undo baseline');
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status,'applied');
        fs.writeFileSync(text,'text pending');await tracker.readFileAndUpdate(text,Uri.file(text));
        const opaquePending=Buffer.from([0,3,4]);fs.writeFileSync(opaque,opaquePending);await tracker.readFileAndUpdate(opaque,Uri.file(opaque));
        fs.truncateSync(large,64*1024*1024+1);await tracker.readFileAndUpdate(large,Uri.file(large));
        const unknown=path.join(selected,'unknown.txt');fs.writeFileSync(unknown,'unknown current');
        await tracker.readFileAndUpdate(unknown,Uri.file(unknown));
        assert.equal(tracker.getTrackedChange(text)?.reviewKind,'text');
        assert.equal(tracker.getTrackedChange(opaque)?.reviewKind,'opaque');
        assert.equal(tracker.getTrackedChange(unknown)?.reviewKind,'unknown');
        assert.equal(tracker.getTrackedChange(large)?.largeFileReminder?.pending,true);
        fs.writeFileSync(undo,'undo pending');await tracker.readFileAndUpdate(undo,Uri.file(undo));
        assert.equal((await tracker.revertFile(undo,tracker.getReviewToken(undo))).status,'success');
        assert.equal(fs.readFileSync(undo,'utf8'),'undo baseline');
        const before=structuredClone(tracker.getTrackedChanges());
        await withController(tracker,scope,async({controller,config,writes})=>{
            let confirmations=0;
            const outcome=await controller.saveAndApplyScope({mode:'wholeWorkspace',includes:[],excludes:[{scope:'all',pattern:'/selected/'}]},async proposal=>{
                confirmations++;
                assert.deepEqual([...proposal.affectedReviewPaths].sort(),[text,opaque,unknown,large].sort());
                assert.equal(writes.length,0);
                return approved;
            });
            assert.equal(confirmations,1);
            assert.equal(outcome.status,approved?'applied':'cancelled',JSON.stringify(outcome));
            assert.equal(config.watchExclude.some(rule=>rule.pattern==='/selected/'),approved);
            if(approved){for(const file of [text,opaque,unknown,large])assert.equal(tracker.getTrackedChange(file),undefined);}
            else{assert.equal(writes.length,0);assert.deepEqual(tracker.getTrackedChanges(),before);}
            assert.equal(fs.readFileSync(text,'utf8'),'text pending');
            assert.deepEqual(fs.readFileSync(opaque),opaquePending);
            assert.equal(fs.readFileSync(unknown,'utf8'),'unknown current');
            assert.equal(fs.statSync(large).size,64*1024*1024+1);
            assert.equal(fs.readFileSync(undo,'utf8'),'undo baseline','scope operation must never execute Undo itself');
            const undone=await tracker.undoLastRevert();
            assert.equal(undone.succeeded,1,JSON.stringify(undone));
            assert.equal(fs.readFileSync(undo,'utf8'),'undo pending');
            assert.equal(tracker.getOriginalContent(undo),'undo baseline');
            assert.equal(tracker.getTrackedChange(undo)?.currentContent,'undo pending');
        });
    }));

    test('A5 SCOPE committed exclusion stays effective when required reinclude verification fails and retries',()=>fixture(async({tracker,dir,scope})=>{
        const selected=path.join(dir,'selected'),needed=path.join(dir,'needed');fs.mkdirSync(selected);fs.mkdirSync(needed);
        const target=path.join(selected,'tracked.txt'),reinclude=path.join(needed,'tracked.txt');
        fs.writeFileSync(target,'selected baseline');fs.writeFileSync(reinclude,'old released baseline');
        h.setVsCodeExcludes({'files.watcherExclude':{'needed/**':true}});
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status,'applied');
        const excluded=scopeFor(tracker,'wholeWorkspace',[{scope:'all',pattern:'/needed/'}]);
        assert.equal((await tracker.applyConfiguredMonitoringScope(excluded)).status,'applied');
        fs.writeFileSync(target,'selected pending');await tracker.readFileAndUpdate(target,Uri.file(target));
        fs.writeFileSync(reinclude,'fresh included baseline');
        tracker.setSubtreeCoverageGap(needed,'supplemental-watcher-directory-change-gap','Unverified excluded interval');
        const open=fs.promises.opendir;
        await withController(tracker,excluded,async({controller,config})=>{
            let approvals=0;
            const proposal={mode:'wholeWorkspace',includes:[],excludes:[{scope:'all',pattern:'/selected/'}]};
            fs.promises.opendir=async(directory,...args)=>{
                if(path.resolve(String(directory))===needed && tracker.getEffectiveMonitoringScope().excludes.some(rule=>rule.pattern==='/selected/')){
                    throw Object.assign(new Error('Required subtree temporarily unreadable'),{code:'EACCES'});
                }
                return open(directory,...args);
            };
            let outcome;
            try{outcome=await controller.saveAndApplyScope(proposal,async()=>{approvals++;return true;});}
            finally{fs.promises.opendir=open;}
            assert.equal(outcome.status,'partial',JSON.stringify(outcome));assert.equal(outcome.scopeCommitted,true);
            assert.ok(config.watchExclude.some(rule=>rule.pattern==='/selected/'));
            assert.equal(tracker.getTrackedChange(target),undefined);
            assert.equal(approvals,1);
            const revision=tracker.getEffectiveMonitoringScope().scopeRevision;
            assert.equal(await tracker.flushPendingPersistence(),true);
            const saved=JSON.parse(fs.readFileSync(path.join(tracker.storageUri.fsPath,'session-state.json'),'utf8'));
            assert.equal(new Map(saved.coverageGaps).get(needed)?.subtree?.scopeOperationRevision,revision,'required unfinished work is durable and revision-bound');
            const retry=await controller.saveAndApplyScope(proposal,async()=>{throw new Error('Previously discarded review must not be approved again');});
            assert.equal(retry.status,'applied',JSON.stringify(retry));
            assert.equal(tracker.getOriginalContent(reinclude),'fresh included baseline');
            const owner=[...h.nativeDirectoryWatchers].reverse().find(item=>item.active&&path.resolve(String(item.directory))===needed);
            assert.ok(owner);fs.writeFileSync(reinclude,'native edit after required recovery');owner.listener('change','tracked.txt');
            await h.waitUntil(()=>tracker.getTrackedChange(reinclude)?.currentContent==='native edit after required recovery');
            assert.equal(tracker.getOriginalContent(reinclude),'fresh included baseline');
            assert.equal(fs.readFileSync(target,'utf8'),'selected pending');
        });
    }));
    for(const kind of ['file','subtree'])
    test(`A5 SCOPE Restore verifies only required ${kind} while another path is dirty and failed`,()=>fixture(async({tracker,dir,scope})=>{
        const needed=path.join(dir,'needed');fs.mkdirSync(needed);
        const target=path.join(needed,'tracked.txt'),other=path.join(dir,'other.txt');
        fs.writeFileSync(target,'original');fs.writeFileSync(other,'other baseline');
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status,'applied');
        const pattern=kind==='file'?'/needed/tracked.txt':'/needed/';
        tracker.setPendingMonitoringScope(scopeFor(tracker,'wholeWorkspace',[{scope:'all',pattern}]));
        fs.writeFileSync(target,'changed during pending exclusion');
        tracker.setPendingMonitoringScope(undefined);
        if(kind==='subtree')tracker.setSubtreeCoverageGap(needed,'pending-scope-gap','Required paused directory interval');
        tracker.setFileCoverageGap(other,'file-read-failed','Unrelated read failure');tracker.markFileUnavailable(other,'Unrelated read failure');
        const otherBefore=structuredClone(tracker.getTrackedChange(other));
        const dirty={uri:Uri.file(other),isDirty:true};h.vscode.workspace.textDocuments.push(dirty);
        const read=tracker.readFileAndUpdate.bind(tracker),open=fs.promises.opendir;
        const visited=[];let fullRechecks=0;
        tracker.readFileAndUpdate=async(file,...args)=>{assert.notEqual(file,other,'required verification must not read an unrelated fault');return read(file,...args);};
        fs.promises.opendir=async(directory,...args)=>{visited.push(String(directory));assert.notEqual(path.resolve(String(directory)),dir,'do not walk the workspace for a local proof');return open(directory,...args);};
        tracker.recheckObservationCoverage=async()=>{fullRechecks++;throw new Error('Full Recheck is unnecessary');};
        try{await withController(tracker,scope,async({controller})=>{
            const outcome=await controller.restoreEffectiveScopeConfiguration();
            assert.equal(outcome.status,'restored',JSON.stringify(outcome));assert.equal(fullRechecks,0);
            assert.ok(outcome.unrelatedCoverageGaps?.some(([file])=>file===other));
            assert.equal(tracker.getOriginalContent(target),'original');
            assert.equal(tracker.getTrackedChange(target)?.currentContent,'changed during pending exclusion');
            assert.deepEqual(tracker.getTrackedChange(other),otherBefore);
            if(kind==='file')assert.deepEqual(visited,[],'file recovery never enumerates its parent');
            else assert.ok(visited.includes(needed),'required subtree was actually verified');
            assert.equal(await tracker.flushPendingPersistence(),true);
            const state=JSON.parse(fs.readFileSync(path.join(tracker.storageUri.fsPath,'session-state.json'),'utf8'));
            assert.ok(tracker.parsePersistedState(state),'regional proof leaves a valid durable session');
            const parent=path.dirname(target),owner=[...h.nativeDirectoryWatchers].reverse().find(item=>item.active&&path.resolve(String(item.directory))===parent);
            assert.ok(owner);fs.writeFileSync(target,'future native edit');owner.listener('change','tracked.txt');
            await h.waitUntil(()=>tracker.getTrackedChange(target)?.currentContent==='future native edit');
            assert.equal(tracker.getOriginalContent(target),'original');
        });}finally{fs.promises.opendir=open;tracker.readFileAndUpdate=read;h.vscode.workspace.textDocuments.splice(h.vscode.workspace.textDocuments.indexOf(dirty),1);}
    }));

    for(const fault of ['dirty','git','identity','activity','copy','new-evidence'])
    test(`A5 SCOPE required recovery preserves evidence at ${fault} boundary`,()=>fixture(async({tracker,dir,scope})=>{
        const needed=path.join(dir,'needed');fs.mkdirSync(needed);
        const target=path.join(needed,'tracked.txt');fs.writeFileSync(target,'original');
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status,'applied');
        tracker.setPendingMonitoringScope(scopeFor(tracker,'wholeWorkspace',[{scope:'all',pattern:'/needed/'}]));
        fs.writeFileSync(target,'pending original review');tracker.setPendingMonitoringScope(undefined);
        tracker.setSubtreeCoverageGap(needed,'pending-scope-gap','Required paused directory interval');
        const unknown=path.join(needed,'unknown.txt');fs.writeFileSync(unknown,'unknown current');tracker.recordUnresolvedBaseline(unknown,'Unknown before-image');
        const dirty={uri:Uri.file(target),isDirty:true};
        if(fault==='dirty')h.vscode.workspace.textDocuments.push(dirty);
        if(fault==='git')tracker.pausedGitRepositories.set(dir,'Git operation in progress');
        const prepare=tracker.prepareImportedCoverageHandoff.bind(tracker),open=fs.promises.opendir,copy=h.vscode.workspace.fs.copy;
        let armed=false,used=false;
        tracker.prepareImportedCoverageHandoff=async(...args)=>{const handoff=await prepare(...args);armed=true;return handoff;};
        fs.promises.opendir=async(directory,...args)=>{
            const handle=await open(directory,...args);
            if(armed&&!used&&String(directory)===needed&&['identity','activity'].includes(fault)){
                used=true;
                if(fault==='identity'){fs.renameSync(needed,needed+'-old');fs.mkdirSync(needed);fs.writeFileSync(target,'replacement');}
                else{fs.writeFileSync(target,'activity during proof');tracker.dispatchExternalEvent(Uri.file(target),'change',tracker.sessionEpoch);}
            }
            return handle;
        };
        h.vscode.workspace.fs.copy=async(...args)=>{
            if(tracker.baselineTransaction&&armed&&!used){
                used=true;
                if(fault==='copy')throw new Error('Injected regional certification-copy failure');
                if(fault==='new-evidence')tracker.setSubtreeCoverageGap(needed,'directory-runtime-coverage-gap','New exact uncertainty at copy');
            }
            return copy(...args);
        };
        try{await withController(tracker,scope,async({controller})=>{
            const outcome=await controller.restoreEffectiveScopeConfiguration();
            assert.equal(outcome.status,'partial',JSON.stringify(outcome));
            assert.equal(tracker.getOriginalContent(target),'original');
            assert.equal(tracker.getOriginalContent(unknown),undefined);
            assert.equal(tracker.getTrackedChange(unknown)?.reviewKind,'unknown');
            assert.ok(tracker.getCoverageGaps().some(([file])=>file===needed));
            if(fault==='new-evidence')assert.equal(tracker.coverageGaps.get(needed)?.subtree?.reason,'New exact uncertainty at copy');
            if(fault==='dirty'||fault==='git')assert.equal(armed,false,'guards run before observing the required subtree');
            assert.equal(await tracker.flushPendingPersistence(),true);
            const state=JSON.parse(fs.readFileSync(path.join(tracker.storageUri.fsPath,'session-state.json'),'utf8'));
            assert.ok(tracker.parsePersistedState(state));
            assert.ok(state.coverageGaps.some(([file])=>file===needed));
        });}finally{
            fs.promises.opendir=open;h.vscode.workspace.fs.copy=copy;tracker.prepareImportedCoverageHandoff=prepare;
            if(fault==='dirty')h.vscode.workspace.textDocuments.splice(h.vscode.workspace.textDocuments.indexOf(dirty),1);
            tracker.pausedGitRepositories.delete(dir);
        }
    }));


    test('A5 SCOPE Restore verifies a single file directly under the workspace root',()=>fixture(async({tracker,dir,scope})=>{
        tracker.activateExternalWatchers(tracker.createExternalWatchers(tracker.sessionEpoch));
        const target=path.join(dir,'tracked.txt');fs.writeFileSync(target,'original');
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status,'applied');
        tracker.setPendingMonitoringScope(scopeFor(tracker,'wholeWorkspace',[{scope:'all',pattern:'/tracked.txt'}]));
        fs.writeFileSync(target,'current review');tracker.setPendingMonitoringScope(undefined);
        await withController(tracker,scope,async({controller})=>{
            const outcome=await controller.restoreEffectiveScopeConfiguration();
            assert.equal(outcome.status,'restored',JSON.stringify(outcome));
            assert.equal(tracker.getOriginalContent(target),'original');
            assert.equal(tracker.getTrackedChange(target)?.currentContent,'current review');
            assert.equal(tracker.getCoverageGaps().length,0);
            const state=JSON.parse(fs.readFileSync(path.join(tracker.storageUri.fsPath,'session-state.json'),'utf8'));
            assert.ok(tracker.parsePersistedState(state));
        });
    }));

}
