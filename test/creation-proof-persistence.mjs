import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Real file mutation and the production writer. Gates control only the actual
// provider await, including writes after a provisional baseline is published.
export function registerCreationProofPersistence(h, fixture) {
    const {test, Uri, DiffTracker, pause, waitUntil, document, setTracker, faults} = h;
    async function bounded(promise) {
        let timer;
        try { return await Promise.race([promise,new Promise((_,reject)=>{
            timer=setTimeout(()=>reject(new Error('Creation durability boundary did not settle')),5000);
        })]); } finally { clearTimeout(timer); }
    }
    async function assertUnknown(tracker,target) {
        const doc=document(target),before={text:doc.getText(),dirty:doc.isDirty,disk:fs.readFileSync(target,'utf8')};
        assert.equal(tracker.fileSnapshots.has(target),false);
        assert.equal(tracker.unresolvedBaselineFiles.has(target),true);
        assert.equal(tracker.getReviewToken(target),undefined);
        assert.equal((await tracker.revertBlock(target,0)).status,'conflict');
        assert.deepEqual({text:doc.getText(),dirty:doc.isDirty,disk:fs.readFileSync(target,'utf8')},before);
    }
    for (const channel of ['direct','queued']) for (const boundary of ['write','rename','copy']) for (const replace of [false,true]) {
        test(`CREATION-DURABILITY ${channel} ${boundary} replace=${replace}`,()=>fixture(async context=>{
            let tracker=context.tracker;
            const parent=path.join(context.dir,'parent');fs.mkdirSync(parent);
            const target=path.join(parent,'created.txt');fs.writeFileSync(target,'first live creation');
            const storage=tracker.storageUri;
            const barrierPath=path.join(storage.fsPath,boundary==='copy'?'session-state.json':'session-state.tmp.json');
            const gate=pause(barrierPath,boundary);
            if(channel==='queued'){tracker.restoringEpoch=tracker.sessionEpoch;tracker.queueRestoreEvent(Uri.file(target),'create');}
            const operation=channel==='direct'?tracker.onExternalFileCreatedEvent(Uri.file(target)):tracker.drainRestoreEvents(tracker.sessionEpoch);
            try {
                await bounded(gate.entered);
                assert.equal(tracker.getOriginalContent(target),'');assert.equal(tracker.getBaselineState(),'building');
                assert.equal(tracker.getReviewToken(target),undefined,'provisional creation must not grant review permission');
                if(replace){
                    fs.rmSync(parent,{recursive:true});tracker.dispatchExternalEvent(Uri.file(parent),'delete',tracker.sessionEpoch);
                    fs.mkdirSync(parent);fs.writeFileSync(target,'replacement without a new exact notification');
                    assert.equal(tracker.fileSnapshots.has(target),false,'revocation removes the provisional baseline before another observer reads it');
                    assert.equal(fs.existsSync(path.join(storage.fsPath,'session-state.unsaved')),true,'in-flight candidates retain their durable guard');
                    const reader=new DiffTracker(storage);
                    try{
                        assert.equal(await bounded(reader.restorePersistedState()),'blocked','a concurrent reload cannot accept the guarded candidate');
                        assert.equal(reader.getReviewToken(target),undefined);
                    }finally{await reader.dispose();}
                }
                gate.release();await bounded(operation);
                if(channel==='queued'){tracker.restoringEpoch=undefined;}
                await waitUntil(()=>tracker.activeExternalOperations.size===0&&tracker.externalChangeTimers.size===0,5000);
                if(replace){await assertUnknown(tracker,target);}
                else{assert.equal(tracker.getOriginalContent(target),'');assert.ok(tracker.getReviewToken(target));}
                assert.equal(await tracker.flushPendingPersistence(),true);
                for(const name of ['session-state.json','session-state.last-good.json']){
                    const saved=JSON.parse(fs.readFileSync(path.join(storage.fsPath,name),'utf8'));
                    assert.equal(saved.fileSnapshots.some(([file])=>file===target),!replace);
                    assert.equal(saved.unresolvedBaselineFiles.some(([file])=>file===target),replace);
                }
                await tracker.dispose();tracker=new DiffTracker(storage);setTracker(tracker);
                assert.equal(await tracker.restorePersistedState(),'restored');
                if(replace){await assertUnknown(tracker,target);}
                else{assert.equal(tracker.getOriginalContent(target),'');assert.ok(tracker.getReviewToken(target));}
            } finally {gate.release();await operation;}
        }));
    }
    for(const channel of ['direct','queued']) for(const activity of ['fresh-create','atomic-file','unnotified-parent','stop','epoch','save-failure','budget-failure']){
        test(`CREATION-DURABILITY ${channel} control ${activity}`,()=>fixture(async({tracker,dir})=>{
            const parent=path.join(dir,'parent');fs.mkdirSync(parent);
            const target=path.join(parent,'created.txt');fs.writeFileSync(target,'first live creation');
            const storage=tracker.storageUri;
            const gate=pause(path.join(storage.fsPath,'session-state.tmp.json'),'write');
            if(channel==='queued'){tracker.restoringEpoch=tracker.sessionEpoch;tracker.queueRestoreEvent(Uri.file(target),'create');}
            const operation=channel==='direct'?tracker.onExternalFileCreatedEvent(Uri.file(target)):tracker.drainRestoreEvents(tracker.sessionEpoch);
            let fresh;
            try {
                await bounded(gate.entered);
                if(['fresh-create','unnotified-parent','save-failure','budget-failure'].includes(activity)){
                    fs.rmSync(parent,{recursive:true});
                    if(activity!=='unnotified-parent'){tracker.dispatchExternalEvent(Uri.file(parent),'delete',tracker.sessionEpoch);}
                    fs.mkdirSync(parent);fs.writeFileSync(target,'new replacement contents');
                    if(activity==='fresh-create'){
                        if(channel==='queued'){tracker.queueRestoreEvent(Uri.file(target),'create');}
                        else{fresh=tracker.onExternalFileCreatedEvent(Uri.file(target));}
                    }
                    if(activity==='save-failure'){
                        faults.set(path.join(storage.fsPath,'session-state.json'),{copy:Object.assign(new Error('Synthetic correction copy failure'),{code:'NoPermissions'})});
                    }
                    if(activity==='budget-failure'){
                        tracker.maxPersistedSnapshots=1;
                        tracker.unresolvedBaselineFiles.set(path.join(dir,'earlier-unknown.txt'),'Synthetic historical unknown');
                    }
                } else if(activity==='atomic-file'){
                    const temporary=path.join(parent,'replacement.tmp');fs.writeFileSync(temporary,'atomic file update');fs.renameSync(temporary,target);
                } else if(activity==='stop'){tracker.stopRecording();}
                else{
                    tracker.advanceEpoch();tracker.unresolvedBaselineFiles.delete(target);tracker.postBaselineUnknownFiles.delete(target);
                    tracker.fileSnapshots.set(target,'new epoch baseline');tracker.baselineExistingFiles.add(target);
                }
                gate.release();await bounded(operation);if(fresh){await bounded(fresh);}
                if(channel==='queued'){tracker.restoringEpoch=undefined;}
                if(activity==='fresh-create'||activity==='atomic-file'){
                    assert.equal(tracker.getOriginalContent(target),'');assert.ok(tracker.getReviewToken(target));
                } else if(activity==='epoch'){
                    assert.equal(tracker.getOriginalContent(target),'new epoch baseline');
                    assert.equal(await tracker.flushPendingPersistence(),true,'new epoch remains independently persistable');
                }
                else{
                    await assertUnknown(tracker,target);
                    if(activity==='save-failure'||activity==='budget-failure'){
                        assert.equal(tracker.getIsRecording(),false);assert.equal(tracker.persistenceFailed,true);
                        assert.equal(fs.existsSync(path.join(storage.fsPath,'session-state.unsaved')),true);
                        const restored=new DiffTracker(storage);
                        try{assert.equal(await restored.restorePersistedState(),'blocked');assert.equal(restored.getReviewToken(target),undefined);}
                        finally{await restored.dispose();}
                    }else if(activity==='stop'){assert.equal(tracker.getIsRecording(),false);}
                }
            } finally {gate.release();await operation;if(fresh){await fresh;}faults.clear();}
        }));
    }
    test('CREATION-DURABILITY no-storage positive retains a usable creation',()=>fixture(async({tracker,dir})=>{
        const storage=tracker.storageUri;tracker.storageUri=undefined;
        try{
            const target=path.join(dir,'created.txt');fs.writeFileSync(target,'live creation without persistence');
            await tracker.onExternalFileCreatedEvent(Uri.file(target));
            assert.equal(tracker.getOriginalContent(target),'');assert.ok(tracker.getReviewToken(target));
        }finally{tracker.storageUri=storage;}
    }));
    for(const replace of [false,true]) test(`CREATION-DURABILITY staged archive proof replace=${replace}`,()=>fixture(async({tracker,dir})=>{
        const parent=path.join(dir,'staged');fs.mkdirSync(parent);
        const target=path.join(parent,'created.txt');fs.writeFileSync(target,'staged creation');
        tracker.archiveRestoreStaging=true;
        try{
            await tracker.onExternalFileCreatedEvent(Uri.file(target));
            assert.equal(tracker.getReviewToken(target),undefined,'staged proof cannot grant permission before its outer save');
            if(replace){
                fs.rmSync(parent,{recursive:true});tracker.dispatchExternalEvent(Uri.file(parent),'delete',tracker.sessionEpoch);
                fs.mkdirSync(parent);fs.writeFileSync(target,'replacement without new proof');
            }
        }finally{tracker.archiveRestoreStaging=false;}
        assert.equal(await tracker.completeRuntimeBaseline(tracker.sessionEpoch),true);
        if(replace){await assertUnknown(tracker,target);}
        else{assert.equal(tracker.getOriginalContent(target),'');assert.ok(tracker.getReviewToken(target));}
    }));
    test('CREATION-DURABILITY failed proof preserves independently created sibling',()=>fixture(async({tracker,dir})=>{
        const parent=path.join(dir,'parent');fs.mkdirSync(parent);
        const target=path.join(parent,'created.txt'),sibling=path.join(dir,'independent.txt');
        fs.writeFileSync(target,'first creation');const storage=tracker.storageUri;
        const gate=pause(path.join(storage.fsPath,'session-state.tmp.json'),'write');
        const first=tracker.onExternalFileCreatedEvent(Uri.file(target));let second;
        try{
            await bounded(gate.entered);
            fs.writeFileSync(sibling,'separate current creation');second=tracker.onExternalFileCreatedEvent(Uri.file(sibling));
            await waitUntil(()=>tracker.runtimeCreationPublications.has(sibling),5000);
            fs.rmSync(parent,{recursive:true});tracker.dispatchExternalEvent(Uri.file(parent),'delete',tracker.sessionEpoch);
            fs.mkdirSync(parent);fs.writeFileSync(target,'unproven replacement');
            gate.release();await bounded(Promise.all([first,second]));
            await assertUnknown(tracker,target);
            assert.equal(tracker.getOriginalContent(sibling),'');assert.ok(tracker.getReviewToken(sibling));
            assert.equal(tracker.getIsRecording(),true);assert.equal(await tracker.flushPendingPersistence(),true);
        }finally{gate.release();await first;if(second){await second;}}
    }));
    test('CREATION-DURABILITY local marker commit failure preserves the durable guard',()=>fixture(async({tracker,dir})=>{
        const target=path.join(dir,'created.txt');fs.writeFileSync(target,'current file creation');
        const marker=path.join(tracker.storageUri.fsPath,'session-state.unsaved');
        const unlink=fs.unlinkSync;
        fs.unlinkSync=function(file,...args){
            if(String(file)===marker){throw Object.assign(new Error('Synthetic local commit permission failure'),{code:'EACCES'});}
            return unlink.call(this,file,...args);
        };
        try{
            await tracker.onExternalFileCreatedEvent(Uri.file(target));
            await assertUnknown(tracker,target);
            assert.equal(tracker.getIsRecording(),false);assert.equal(fs.existsSync(marker),true);
            const reader=new DiffTracker(tracker.storageUri);
            try{assert.equal(await reader.restorePersistedState(),'blocked');assert.equal(reader.getReviewToken(target),undefined);}
            finally{await reader.dispose();}
        }finally{fs.unlinkSync=unlink;}
    }));
}
