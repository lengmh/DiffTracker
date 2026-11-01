import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createLegacyEffectiveScope } from '../out/monitoringScope.js';

export function registerLegacyCreationProof(h,fixture){
    const {test,Uri,DiffTracker,pause,document,waitUntil,setTracker,setListedFiles,faults}=h;
    async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(new Error('Legacy creation boundary did not settle')),5000);
    })]);}finally{clearTimeout(timer);}}
    const legacy=tracker=>{tracker.effectiveMonitoringScope=createLegacyEffectiveScope(tracker.currentWorkspaceRootIdentities(),[]);};
    async function unknown(tracker,target){
        const doc=document(target),before={text:doc.getText(),dirty:doc.isDirty,disk:fs.readFileSync(target,'utf8')};
        assert.equal((await tracker.revertBlock(target,0)).status,'conflict');
        assert.equal(tracker.getOriginalContent(target),undefined);
        assert.equal(tracker.getReviewToken(target),undefined);
        assert.equal(tracker.unresolvedBaselineFiles.has(target),true);
        assert.deepEqual({text:doc.getText(),dirty:doc.isDirty,disk:fs.readFileSync(target,'utf8')},before);
    }
    for(const activity of ['unchanged','parent-replace','historical-unknown','file-to-directory','directory-only','directory-with-proof',
        'stop','epoch','save-failure','budget'])
    test(`LEGACY-PROOF real restore ${activity}`,()=>fixture(async context=>{
        let tracker=context.tracker;legacy(tracker);tracker.sessionWorkspaceRoots=tracker.getWorkspaceRoots();
        const known=path.join(context.dir,'known.txt');fs.writeFileSync(known,'original known baseline');
        tracker.fileSnapshots.set(known,'original known baseline');tracker.baselineExistingFiles.add(known);
        const parent=path.join(context.dir,'new-parent'),target=path.join(parent,'created.txt');
        if(activity==='historical-unknown'){tracker.recordUnresolvedBaseline(target,'Historical unknown before-image');}
        setListedFiles([Uri.file(known)]);const storage=tracker.storageUri;
        assert.equal(await tracker.flushPendingPersistence(),true);await tracker.dispose();
        tracker=new DiffTracker(storage);setTracker(tracker);
        const knownRead=pause(known,'read'),classification=pause(target,'stat');
        const restoration=tracker.restorePersistedState();let reviewed=target;
        try{
            await bounded(knownRead.entered);
            assert.equal(tracker.restoringEpoch,tracker.sessionEpoch);
            assert.ok(tracker.fileWatchers.length>0,'restore listeners are installed before the real file creation');
            assert.equal(fs.existsSync(target),false);
            fs.mkdirSync(parent);fs.writeFileSync(target,'independent creation after listener registration');
            if(activity.startsWith('directory-')){tracker.dispatchExternalEvent(Uri.file(parent),'create',tracker.sessionEpoch);}
            if(activity!=='directory-only'){tracker.dispatchExternalEvent(Uri.file(target),'create',tracker.sessionEpoch);}
            setListedFiles([known,target].map(Uri.file));
            knownRead.release();await bounded(classification.entered);
            if(activity==='parent-replace'){
                fs.rmSync(parent,{recursive:true});tracker.dispatchExternalEvent(Uri.file(parent),'delete',tracker.sessionEpoch);
                fs.mkdirSync(parent);fs.writeFileSync(target,'replacement without a new creation proof');
            }else if(activity==='file-to-directory'){
                fs.unlinkSync(target);fs.mkdirSync(target);reviewed=path.join(target,'unproven.txt');
                fs.writeFileSync(reviewed,'replacement directory child without creation proof');
                setListedFiles([known,reviewed].map(Uri.file));
            }else if(activity==='stop'){tracker.stopRecording();}
            else if(activity==='epoch'){
                tracker.advanceEpoch();tracker.isRecording=false;
                tracker.fileSnapshots.set(target,'new epoch baseline');tracker.baselineExistingFiles.add(target);
            }else if(activity==='save-failure'){
                faults.set(path.join(storage.fsPath,'session-state.json'),{copy:Object.assign(new Error('Synthetic legacy save failure'),{code:'NoPermissions'})});
            }else if(activity==='budget'){tracker.maxPersistedSnapshots=tracker.fileSnapshots.size;}
            classification.release();const outcome=await bounded(restoration);
            assert.equal(tracker.getOriginalContent(known),'original known baseline');
            if(['stop','epoch','save-failure','budget'].includes(activity)){
                assert.equal(outcome,'blocked');assert.equal(tracker.getReviewToken(target),undefined);
                if(activity==='epoch'){assert.equal(tracker.getOriginalContent(target),'new epoch baseline');}
                else{assert.equal(tracker.fileSnapshots.has(target),false);}
                if(activity==='stop'){assert.equal(tracker.getIsRecording(),false);}
                if(activity==='save-failure'){
                    assert.ok(tracker.getPersistenceIssue());
                    assert.equal(fs.existsSync(path.join(storage.fsPath,'session-state.unsaved')),true);
                    const reader=new DiffTracker(storage);
                    try{assert.equal(await reader.restorePersistedState(),'blocked');assert.equal(reader.getReviewToken(target),undefined);}
                    finally{await reader.dispose();}
                }
                return;
            }
            assert.equal(outcome,'restored');assert.equal(tracker.getIsRecording(),true,'legacy recording remains available');
            const proven=activity==='unchanged'||activity==='directory-with-proof';
            if(proven){assert.equal(tracker.getOriginalContent(reviewed),'');assert.ok(tracker.getReviewToken(reviewed));}
            else{await unknown(tracker,reviewed);}
            assert.equal(await tracker.flushPendingPersistence(),true);
            for(const name of ['session-state.json','session-state.last-good.json']){
                const saved=JSON.parse(fs.readFileSync(path.join(storage.fsPath,name),'utf8'));
                assert.equal(new Map(saved.fileSnapshots).get(reviewed),proven?'':undefined);
                assert.equal(new Map(saved.unresolvedBaselineFiles).has(reviewed),!proven);
            }
            await tracker.dispose();const reader=new DiffTracker(storage);setTracker(reader);
            assert.equal(await reader.restorePersistedState(),'restored');
            if(proven){assert.equal(reader.getOriginalContent(reviewed),'');assert.ok(reader.getReviewToken(reviewed));}
            else{await unknown(reader,reviewed);}
        }finally{knownRead.release();classification.release();await restoration;faults.clear();}
    }));
    for(const boundary of ['read','write'])for(const configured of [false,true])for(const revoke of [false,true])
    test(`LEGACY-PROOF directory child ${boundary} retains only current proof configured=${configured} revoke=${revoke}`,()=>fixture(async({tracker,dir})=>{
        if(!configured){legacy(tracker);}
        tracker.sessionWorkspaceRoots=tracker.getWorkspaceRoots();
        tracker.restoringEpoch=tracker.sessionEpoch;
        tracker.activateExternalWatchers(tracker.createExternalWatchers(tracker.sessionEpoch));
        assert.ok(tracker.fileWatchers.length>0);
        const notify=(kind,uri)=>{for(const watcher of tracker.fileWatchers){watcher.emit(kind,uri);}};
        const root=path.join(dir,'queued-directory');fs.mkdirSync(root);
        const child=path.join(root,'created.txt');fs.writeFileSync(child,'independent file creation');setListedFiles([Uri.file(child)]);
        notify('create',Uri.file(root));notify('create',Uri.file(child));
        const storage=tracker.storageUri;
        const gate=pause(boundary==='read'?child:path.join(storage.fsPath,'session-state.tmp.json'),boundary);
        const operation=tracker.drainRestoreEvents(tracker.sessionEpoch);
        try{
            await bounded(gate.entered);
            if(revoke){
                fs.unlinkSync(child);notify('delete',Uri.file(child));
                fs.writeFileSync(child,'replacement without renewed independent proof');
            }
            gate.release();const reconciled=await bounded(operation);
            if(!reconciled){assert.equal(revoke,true);assert.ok(tracker.isRecoveryBlocked()||tracker.getSubtreeCoverageGaps().length>0);}
            tracker.restoringEpoch=undefined;
            await tracker.readFileAndUpdate(child,Uri.file(child));
            if(revoke){await unknown(tracker,child);}
            else{assert.equal(tracker.getOriginalContent(child),'');assert.ok(tracker.getReviewToken(child));}
            if(boundary==='write'){
                const reader=new DiffTracker(storage);
                try{
                    const restored=await reader.restorePersistedState();
                    if(restored==='restored'){
                        if(revoke){await unknown(reader,child);}else{assert.equal(reader.getOriginalContent(child),'');assert.ok(reader.getReviewToken(child));}
                    }else{
                        assert.equal(revoke,true);assert.ok(['blocked','incomplete'].includes(restored));
                        assert.equal(reader.fileSnapshots.has(child),false);assert.equal(reader.getReviewToken(child),undefined);
                    }
                }finally{await reader.dispose();}
            }
        }finally{gate.release();await operation;}
    }));
    for(const replace of [false,true])
    test(`LEGACY-PROOF queued directory verifies its existing owner replace=${replace}`,()=>fixture(async({tracker,dir})=>{
        legacy(tracker);const root=path.join(dir,'observed-directory');fs.mkdirSync(root);
        await tracker.onExternalFileCreatedEvent(Uri.file(root));
        const old=tracker.importedDirectoryWatchers.get(root);assert.ok(old);
        tracker.maxImportedDirectoryWatchers=1;
        if(replace){fs.rmSync(root,{recursive:true});fs.mkdirSync(root);}
        const child=path.join(root,'unproven.txt');fs.writeFileSync(child,'coarse directory observation without file creation');
        setListedFiles([Uri.file(child)]);
        tracker.queueRestoreEvent(Uri.file(root),replace?'create':'change',!replace);
        assert.equal(await bounded(tracker.drainRestoreEvents(tracker.sessionEpoch)),true);
        assert.equal(tracker.getIsRecording(),true);
        assert.equal(tracker.importedDirectoryWatchers.size,1,'replacement consumes the existing watcher slot');
        assert.equal(tracker.importedDirectoryWatchers.get(root)===old,!replace);
        assert.deepEqual(tracker.getSubtreeCoverageGaps(),[]);
        await unknown(tracker,child);
    }));
    test('LEGACY-PROOF queued directory budget gap recovers without accepting Unknown',()=>fixture(async({tracker,dir})=>{
        legacy(tracker);const root=path.join(dir,'budget-directory');fs.mkdirSync(root);
        const child=path.join(root,'unproven.txt');fs.writeFileSync(child,'no independent creation proof');setListedFiles([Uri.file(child)]);
        tracker.maxImportedDirectoryWatchers=0;tracker.queueRestoreEvent(Uri.file(root),'create');
        assert.equal(await bounded(tracker.drainRestoreEvents(tracker.sessionEpoch)),false);
        assert.equal(tracker.getIsRecording(),true,'runtime coverage refusal remains Limited without disabling legacy recording');
        assert.equal(tracker.isRecoveryBlocked(),false);
        assert.ok(tracker.getSubtreeCoverageGaps().length>0);await unknown(tracker,child);
        assert.equal(await tracker.flushPendingPersistence(),true);
        const saved=JSON.parse(fs.readFileSync(path.join(tracker.storageUri.fsPath,'session-state.json'),'utf8'));
        assert.equal(new Map(saved.fileSnapshots).has(child),false);
        assert.equal(new Map(saved.unresolvedBaselineFiles).has(child),true);
        tracker.maxImportedDirectoryWatchers=1000;
        for(let pass=0;pass<2;pass++){
            tracker.queueRestoreEvent(Uri.file(root),'change',true);
            assert.equal(await bounded(tracker.drainRestoreEvents(tracker.sessionEpoch)),true);
            assert.deepEqual(tracker.getSubtreeCoverageGaps(),[]);await unknown(tracker,child);
        }
    }));
    for(const storage of [false,true])for(const channel of ['direct','queued'])for(const activity of ['unchanged','parent-replace','file-to-directory'])
    test(`LEGACY-PROOF metadata ${channel} storage=${storage} ${activity}`,()=>fixture(async({tracker,dir})=>{
        legacy(tracker);if(!storage){tracker.storageUri=undefined;}
        const parent=path.join(dir,'parent');fs.mkdirSync(parent);
        const target=path.join(parent,'created.txt');fs.writeFileSync(target,'first independent creation');
        const gate=pause(target,'stat');
        if(channel==='queued'){tracker.restoringEpoch=tracker.sessionEpoch;tracker.dispatchExternalEvent(Uri.file(target),'create',tracker.sessionEpoch);}
        const operation=channel==='direct'?tracker.onExternalFileCreatedEvent(Uri.file(target)):tracker.drainRestoreEvents(tracker.sessionEpoch);
        let reviewed=target;
        try{
            await bounded(gate.entered);
            if(activity==='parent-replace'){
                fs.rmSync(parent,{recursive:true});tracker.dispatchExternalEvent(Uri.file(parent),'delete',tracker.sessionEpoch);
                fs.mkdirSync(parent);fs.writeFileSync(target,'replacement without renewed creation proof');
            }else if(activity==='file-to-directory'){
                fs.unlinkSync(target);fs.mkdirSync(target);reviewed=path.join(target,'unproven.txt');
                fs.writeFileSync(reviewed,'replacement child without independent proof');setListedFiles([Uri.file(reviewed)]);
            }
            gate.release();const result=await bounded(operation);
            if(channel==='queued'){assert.equal(result,true,'successful bounded reconciliation must finish the queue');tracker.restoringEpoch=undefined;}
            await waitUntil(()=>tracker.activeExternalOperations.size===0&&tracker.externalChangeTimers.size===0,5000);
            assert.equal(tracker.getIsRecording(),true);
            if(activity==='unchanged'){assert.equal(tracker.getOriginalContent(target),'');assert.ok(tracker.getReviewToken(target));}
            else{await tracker.readFileAndUpdate(reviewed,Uri.file(reviewed));await unknown(tracker,reviewed);}
        }finally{gate.release();await operation;}
    }));
}
