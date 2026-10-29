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

    for(const fault of ['persisted-rejection','compensation-failure'])
    test(`A5 SCOPE three-key save handles ${fault} without overwriting review`,()=>fixture(async({tracker,dir,scope})=>{
        const target=path.join(dir,'tracked.txt');fs.writeFileSync(target,'original');
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status,'applied');
        fs.writeFileSync(target,'pending');await tracker.readFileAndUpdate(target,Uri.file(target));
        assert.equal(tracker.getOriginalContent(target),'original');
        const before=structuredClone(tracker.getTrackedChanges()),revision=tracker.getEffectiveMonitoringScope().scopeRevision;
        await withController(tracker,scope,async({controller,config,hooks})=>{
            const settings=structuredClone(config);let failed=false;
            if(fault==='persisted-rejection')hooks.afterWrite=key=>{if(key==='monitoringScope'&&!failed){failed=true;throw new Error('Settings persisted before rejecting');}};
            else hooks.beforeWrite=(key,value)=>{
                if(key==='watchInclude'){failed=true;throw new Error('Include write refused');}
                if(key==='monitoringScope'&&failed&&value===settings.monitoringScope)throw new Error('Compensation refused');
            };
            const outcome=await controller.saveAndApplyScope({mode:'rules',includes:[],excludes:[]},async()=>true);
            assert.equal(outcome.status,fault==='persisted-rejection'?'failed':'partial',JSON.stringify(outcome));
            assert.equal(outcome.scopeCommitted,false);
            if(fault==='persisted-rejection'){assert.deepEqual(config,settings);assert.equal(outcome.settingsStatus,'restored');}
            else{assert.equal(outcome.settingsStatus,'partial');assert.equal(config.monitoringScope,'rules');}
            assert.equal(tracker.getEffectiveMonitoringScope().scopeRevision,revision);
            assert.deepEqual(tracker.getTrackedChanges(),before);
            assert.equal(fs.readFileSync(target,'utf8'),'pending');assert.equal(tracker.getOriginalContent(target),'original');
        });
    }));

    test('A5 SCOPE regional Restore respects nested roots with duplicate names',()=>fixture(async({tracker,dir,folder})=>{
        const needed=path.join(dir,'needed'),nested=path.join(needed,'nested');fs.mkdirSync(nested,{recursive:true});
        const target=path.join(needed,'tracked.txt'),other=path.join(nested,'tracked.txt');
        fs.writeFileSync(target,'parent original');fs.writeFileSync(other,'nested original');
        const oldFolders=h.vscode.workspace.workspaceFolders,oldGet=h.vscode.workspace.getWorkspaceFolder;
        const parentFolder={...folder,name:'same'},nestedFolder={uri:Uri.file(nested),name:'same',index:1};
        h.vscode.workspace.workspaceFolders=[parentFolder,nestedFolder];
        h.vscode.workspace.getWorkspaceFolder=uri=>[nestedFolder,parentFolder].find(item=>{
            const relative=path.relative(item.uri.fsPath,uri.fsPath);
            return relative===''||relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative);
        });
        const open=fs.promises.opendir;
        try{
            const scope=scopeFor(tracker);
            assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status,'applied');
            tracker.setPendingMonitoringScope(scopeFor(tracker,'wholeWorkspace',[{scope:'all',pattern:'/needed/'}]));
            fs.writeFileSync(target,'parent paused');tracker.setPendingMonitoringScope(undefined);
            fs.writeFileSync(other,'nested pending');await tracker.readFileAndUpdate(other,Uri.file(other));
            tracker.setSubtreeCoverageGap(needed,'pending-scope-gap','Required parent interval');
            const token=tracker.getReviewToken(other);assert.ok(token);
            fs.promises.opendir=async(directory,...args)=>{
                assert.notEqual(path.resolve(String(directory)),nested,'parent recovery cannot enumerate a different workspace owner');
                return open(directory,...args);
            };
            await withController(tracker,scope,async({controller})=>{
                const outcome=await controller.restoreEffectiveScopeConfiguration();
                assert.equal(outcome.status,'restored',JSON.stringify(outcome));
                assert.equal(tracker.getOriginalContent(target),'parent original');
                assert.equal(tracker.getTrackedChange(target)?.currentContent,'parent paused');
                assert.deepEqual(tracker.getReviewToken(other),token);
                assert.equal(tracker.getOriginalContent(other),'nested original');
                assert.equal(tracker.getTrackedChange(other)?.currentContent,'nested pending');
                assert.equal(tracker.importedDirectoryWatchers.has(nested),false);
            });
        }finally{fs.promises.opendir=open;h.vscode.workspace.workspaceFolders=oldFolders;h.vscode.workspace.getWorkspaceFolder=oldGet;}
    }));

    for(const nativeFailure of [false,true])
    test(`A5 SCOPE legacy expansion classifies its required owner failure (failure=${nativeFailure})`,()=>fixture(async({tracker,dir})=>{
        const blind=path.join(dir,'.aws');fs.mkdirSync(blind);
        const target=path.join(blind,'tracked.txt'),other=path.join(dir,'other.txt');
        fs.writeFileSync(target,'new authorized baseline');fs.writeFileSync(other,'other original');
        tracker.effectiveMonitoringScope=tracker.createLegacyEffectiveScopeForRoots(tracker.getWorkspaceRoots());
        await tracker.refreshIgnoreMatchers();
        tracker.fileSnapshots.set(other,'other original');tracker.baselineExistingFiles.add(other);
        tracker.setFileCoverageGap(other,'file-read-failed','Independent old read failure');tracker.markFileUnavailable(other,'Independent old read failure');
        const otherBefore=structuredClone(tracker.getTrackedChange(other));
        h.setVsCodeExcludes({'files.watcherExclude':{'.aws/**':true}});
        const watch=fs.watch;
        if(nativeFailure)fs.watch=(directory,...args)=>{if(path.resolve(String(directory))===blind)throw Object.assign(new Error('Required new owner ENOSPC'),{code:'ENOSPC'});return watch(directory,...args);};
        const proposal={mode:'wholeWorkspace',includes:[],excludes:[]};
        try{await withController(tracker,proposal,async({controller})=>{
            const outcome=await controller.saveAndApplyScope(proposal,async()=>true);
            assert.equal(outcome.status,nativeFailure?'partial':'applied',JSON.stringify(outcome));
            assert.equal(outcome.coverageStatus,nativeFailure?'limited':'verified');
            assert.equal(outcome.scopeCommitted,true);
            assert.deepEqual({...tracker.getTrackedChange(other),timestamp:undefined},{...otherBefore,timestamp:undefined});
            assert.ok(outcome.unrelatedCoverageGaps.some(([file])=>file===other));
            if(nativeFailure){
                assert.ok(tracker.getCoverageGaps().some(([file])=>file===blind));
                assert.equal(outcome.unrelatedCoverageGaps.some(([file])=>file===blind),false,'new required failure belongs to this expansion');
            }
            assert.equal(tracker.getOriginalContent(target),'new authorized baseline');
            assert.equal(fs.readFileSync(target,'utf8'),'new authorized baseline');
        });}finally{fs.watch=watch;}
    }));

    test('A5 SCOPE root change during combined approval rejects every settings write',()=>fixture(async({tracker,dir,scope})=>{
        const selected=path.join(dir,'selected');fs.mkdirSync(selected);
        const target=path.join(selected,'tracked.txt');fs.writeFileSync(target,'original');
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status,'applied');
        fs.writeFileSync(target,'pending');await tracker.readFileAndUpdate(target,Uri.file(target));
        const token=tracker.getReviewToken(target),folders=h.vscode.workspace.workspaceFolders;
        try{await withController(tracker,scope,async({controller,writes})=>{
            let prompts=0;
            const outcome=await controller.saveAndApplyScope({mode:'wholeWorkspace',includes:[],excludes:[{scope:'all',pattern:'/selected/'}]},async()=>{
                prompts++;h.vscode.workspace.workspaceFolders=[];return true;
            });
            assert.equal(prompts,1);assert.equal(outcome.status,'conflict');assert.deepEqual(writes,[]);
            assert.equal(tracker.getOriginalContent(target),'original');assert.deepEqual(tracker.getReviewToken(target),token);
            assert.equal(fs.readFileSync(target,'utf8'),'pending');
        });}finally{h.vscode.workspace.workspaceFolders=folders;}
    }));

    for(const stopped of [false,true])
    test(`A5 SCOPE legacy Restore preserves its readiness guard (stopped=${stopped})`,()=>fixture(async({tracker,dir})=>{
        const target=path.join(dir,'tracked.txt');fs.writeFileSync(target,'current bytes');
        tracker.effectiveMonitoringScope=tracker.createLegacyEffectiveScopeForRoots(tracker.getWorkspaceRoots());
        tracker.fileSnapshots.set(target,'legacy original');tracker.baselineExistingFiles.add(target);
        if(stopped)tracker.stopRecording();
        let checks=0;tracker.recheckObservationCoverage=async()=>{checks++;throw new Error('Legacy scope cannot be implicitly verified');};
        await withController(tracker,{mode:'wholeWorkspace',includes:[],excludes:[]},async({controller})=>{
            const outcome=await controller.restoreEffectiveScopeConfiguration();
            assert.equal(outcome.status,stopped?'restored':'partial',JSON.stringify(outcome));
            assert.equal(outcome.coverageStatus,stopped?'deferred':'notRun');
            assert.equal(checks,0);assert.equal(tracker.getIsRecording(),!stopped);
            assert.equal(tracker.getEffectiveMonitoringScope().kind,'legacyV3');
            assert.equal(tracker.getOriginalContent(target),'legacy original');assert.equal(fs.readFileSync(target,'utf8'),'current bytes');
        },{expectBlockedPolicy:true});
    }));

    test('A5 SCOPE quick exclusion refuses a symlink alias without retiring its real target',()=>fixture(async({tracker,dir,scope})=>{
        const actual=path.join(dir,'actual'),alias=path.join(dir,'alias');fs.mkdirSync(actual);
        const target=path.join(actual,'tracked.txt');fs.writeFileSync(target,'original');
        fs.symlinkSync(actual,alias,process.platform==='win32'?'junction':'dir');
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status,'applied');
        tracker.setSubtreeCoverageGap(actual,'supplemental-watcher-directory-change-gap','Real target interval');
        const evidence=tracker.coverageGaps.get(actual).subtree;
        await withController(tracker,scope,async({controller,writes})=>{
            const outcome=await controller.excludeResource(alias,true,async()=>{throw new Error('Unsupported alias must be rejected before approval');});
            assert.equal(outcome.status,'blocked');assert.deepEqual(writes,[]);
            assert.equal(tracker.coverageGaps.get(actual)?.subtree,evidence);
            assert.equal(tracker.getOriginalContent(target),'original');assert.equal(fs.readFileSync(target,'utf8'),'original');
        });
    }));

    test('A5 SCOPE physical case alias excludes only its exact directory and keeps prefix siblings observable',()=>fixture(async({tracker,dir,scope})=>{
        const actual=path.join(dir,'CaseName'),sibling=path.join(dir,'CaseName-sibling');fs.mkdirSync(actual);fs.mkdirSync(sibling);
        const target=path.join(actual,'tracked.txt'),other=path.join(sibling,'tracked.txt');fs.writeFileSync(target,'original');fs.writeFileSync(other,'sibling original');
        h.setVsCodeExcludes({'files.watcherExclude':{'CaseName/**':true,'CaseName-sibling/**':true}});
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status,'applied');
        tracker.setSubtreeCoverageGap(actual,'supplemental-watcher-directory-change-gap','Selected interval');
        const input=scope.roots[0].caseSensitive?actual:path.join(dir,'casename');
        await withController(tracker,scope,async({controller})=>{
            const outcome=await controller.excludeResource(input,true,async()=>true);
            assert.equal(outcome.status,'applied',JSON.stringify(outcome));
            assert.equal(tracker.getCoverageGaps().some(([file])=>file===actual),false);
            assert.equal(tracker.getOriginalContent(other),'sibling original');
            const owner=[...h.nativeDirectoryWatchers].reverse().find(item=>item.active&&path.resolve(String(item.directory))===sibling);
            assert.ok(owner);fs.writeFileSync(other,'native sibling edit');owner.listener('change','tracked.txt');
            await h.waitUntil(()=>tracker.getTrackedChange(other)?.currentContent==='native sibling edit');
            assert.equal(tracker.getOriginalContent(other),'sibling original');
        });
    }));

    for(const guard of ['building','recovery','git-initializing'])
    test(`A5 SCOPE combined exclusion retains ${guard} protection`,()=>fixture(async({tracker,dir,scope})=>{
        const selected=path.join(dir,'selected');fs.mkdirSync(selected);
        const target=path.join(selected,'tracked.txt');fs.writeFileSync(target,'original');
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status,'applied');
        fs.writeFileSync(target,'pending');await tracker.readFileAndUpdate(target,Uri.file(target));
        if(guard==='building')tracker.baselineBuilding=true;
        if(guard==='recovery')tracker.recoveryBlocked=true;
        if(guard==='git-initializing')tracker.setGitContextPending(true);
        try{await withController(tracker,scope,async({controller,config})=>{
            const settings=structuredClone(config);
            const outcome=await controller.saveAndApplyScope({mode:'wholeWorkspace',includes:[],excludes:[{scope:'all',pattern:'/selected/'}]},async()=>true);
            assert.notEqual(outcome.status,'applied',JSON.stringify(outcome));
            assert.equal(outcome.scopeCommitted,false);assert.deepEqual(config,settings);
            assert.equal(tracker.getEffectiveMonitoringScope().scopeRevision,scope.scopeRevision);
            assert.equal(tracker.getOriginalContent(target),'original');assert.equal(tracker.getTrackedChange(target)?.currentContent,'pending');
            assert.equal(tracker.getIsRecording(),true);assert.equal(fs.readFileSync(target,'utf8'),'pending');
        });}finally{tracker.baselineBuilding=false;tracker.recoveryBlocked=false;tracker.setGitContextPending(false);}
    }));

    test('A5 SCOPE unrelated directory failure during approval stays outside this exclusion',()=>fixture(async({tracker,dir,scope})=>{
        const selected=path.join(dir,'selected');fs.mkdirSync(selected);
        const target=path.join(selected,'tracked.txt'),other=path.join(dir,'other-import');fs.writeFileSync(target,'original');
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status,'applied');
        fs.writeFileSync(target,'pending');await tracker.readFileAndUpdate(target,Uri.file(target));
        const watch=fs.watch;let failing=false,beforeOther;
        let recoveryCalls=0;const recovery=tracker.recheckScopeOperationCoverage.bind(tracker);
        tracker.recheckScopeOperationCoverage=(...args)=>{recoveryCalls++;return recovery(...args);};
        fs.watch=(directory,...args)=>{if(failing&&path.resolve(String(directory))===other)throw Object.assign(new Error('Independent imported owner failure'),{code:'ENOSPC'});return watch(directory,...args);};
        try{await withController(tracker,scope,async({controller})=>{
            const outcome=await controller.saveAndApplyScope({mode:'wholeWorkspace',includes:[],excludes:[{scope:'all',pattern:'/selected/'}]},async()=>{
                fs.mkdirSync(other);fs.writeFileSync(path.join(other,'tracked.txt'),'independent current');
                await tracker.onExternalFileCreated(Uri.file(other));
                const owner=[...h.nativeDirectoryWatchers].reverse().find(item=>item.active&&path.resolve(String(item.directory))===other);
                assert.ok(owner);failing=true;owner.error(Object.assign(new Error('Independent runtime owner failure'),{code:'ENOSPC'}));
                assert.ok(tracker.getCoverageGaps().some(([file])=>file===other));
                beforeOther={original:tracker.getOriginalContent(path.join(other,'tracked.txt')),change:structuredClone(tracker.getTrackedChange(path.join(other,'tracked.txt')))};
                return true;
            });
            assert.equal(outcome.status,'applied',JSON.stringify(outcome));
            assert.ok(outcome.unrelatedCoverageGaps.some(([file])=>file===other));
            assert.equal(recoveryCalls,0);assert.ok(tracker.getCoverageGaps().some(([file])=>file===other));
            assert.equal(tracker.getOriginalContent(path.join(other,'tracked.txt')),beforeOther.original);
            assert.deepEqual({...tracker.getTrackedChange(path.join(other,'tracked.txt')),timestamp:undefined},{...beforeOther.change,timestamp:undefined});
            assert.equal(tracker.getTrackedChange(target),undefined);assert.equal(fs.readFileSync(target,'utf8'),'pending');
        });}finally{fs.watch=watch;}
    }));

}
