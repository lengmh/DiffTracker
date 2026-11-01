import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export function registerDirectoryPublicationSafety(h,fixture){
    const {test,Uri,DiffTracker,pause,document,faults,setTracker,waitUntil}=h;
    async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(new Error('Directory publication boundary did not settle')),5000);
    })]);}finally{clearTimeout(timer);}}
    async function seed(tracker,dir,count=3){
        const container=path.join(dir,'container'),root=path.join(container,'new-directory');fs.mkdirSync(container);
        const known=path.join(container,'known.txt');fs.writeFileSync(known,'original known file');
        tracker.fileSnapshots.set(known,'original known file');tracker.baselineExistingFiles.add(known);
        assert.equal(await tracker.resetBaselineToCurrentState(),true);
        assert.ok(tracker.scanCoverage,'the pre-directory baseline has actual completed scan coverage');
        const historical=path.join(root,'historical.txt');tracker.recordUnresolvedBaseline(historical,'Historical unknown before-image');
        assert.equal(await tracker.flushPendingPersistence(),true);
        fs.mkdirSync(root);fs.mkdirSync(path.join(root,'nested'));
        const children=Array.from({length:count},(_,index)=>path.join(index===count-1?path.join(root,'nested'):root,`child-${index}.txt`));
        for(const file of children){fs.writeFileSync(file,'first independently observed directory contents');}
        fs.writeFileSync(historical,'historical unknown remains protected');
        return {container,root,known,historical,children};
    }
    async function unknown(tracker,file){
        const doc=document(file),before={text:doc.getText(),dirty:doc.isDirty,disk:fs.readFileSync(file,'utf8')};
        assert.equal(tracker.getOriginalContent(file),undefined,path.basename(file));assert.equal(tracker.getReviewToken(file),undefined);
        assert.equal(tracker.unresolvedBaselineFiles.has(file),true,path.basename(file));
        assert.equal((await tracker.revertBlock(file,0)).status,'conflict');
        assert.deepEqual({text:doc.getText(),dirty:doc.isDirty,disk:fs.readFileSync(file,'utf8')},before);
    }
    for(const boundary of ['write','rename','copy'])for(const replace of [false,true]){
        test(`DIRECTORY-PUBLICATION ${boundary} replace=${replace}`,()=>fixture(async context=>{
            let tracker=context.tracker;const seeded=await seed(tracker,context.dir),{root,known,historical,children}=seeded;
            const storage=tracker.storageUri;
            const gate=pause(path.join(storage.fsPath,boundary==='copy'?'session-state.json':'session-state.tmp.json'),boundary);
            const operation=tracker.onExternalFileCreatedEvent(Uri.file(root));
            try{
                await bounded(gate.entered);
                const exported=tracker.buildPersistedState();const recovery=JSON.parse(Buffer.from(tracker.captureBaselineAcceptanceRecovery(true).payload).toString('utf8'));
                for(const child of children){
                    assert.equal(tracker.getOriginalContent(child),'');assert.equal(tracker.getReviewToken(child),undefined);
                    for(const state of [exported,recovery]){
                        assert.equal(new Map(state.fileSnapshots).has(child),false,'unguarded recovery/export cannot copy an unaccepted child baseline');
                        assert.equal(new Map(state.unresolvedBaselineFiles).has(child),true);
                    }
                }
                if(replace){
                    fs.rmSync(root,{recursive:true});tracker.dispatchExternalEvent(Uri.file(root),'delete',tracker.sessionEpoch);
                    fs.mkdirSync(root);fs.mkdirSync(path.join(root,'nested'));
                    for(const child of children){fs.writeFileSync(child,'replacement without a new child create');}
                    fs.writeFileSync(historical,'historical replacement');
                }
                gate.release();await bounded(operation);
                await waitUntil(()=>tracker.activeExternalOperations.size===0&&tracker.externalChangeTimers.size===0,5000);
                for(const child of children){
                    await tracker.readFileAndUpdate(child,Uri.file(child));
                    if(replace){await unknown(tracker,child);}
                    else{assert.equal(tracker.getOriginalContent(child),'');assert.ok(tracker.getReviewToken(child));}
                }
                assert.equal(tracker.getOriginalContent(known),'original known file');
                assert.equal(tracker.unresolvedBaselineFiles.has(historical),true);assert.equal(tracker.getReviewToken(historical),undefined);
                assert.equal(await tracker.flushPendingPersistence(),true);
                for(const name of ['session-state.json','session-state.last-good.json']){
                    const saved=JSON.parse(fs.readFileSync(path.join(storage.fsPath,name),'utf8'));
                    for(const child of children){assert.equal(new Map(saved.fileSnapshots).has(child),!replace);}
                }
                await tracker.dispose();tracker=new DiffTracker(storage);setTracker(tracker);
                assert.equal(await tracker.restorePersistedState(),'restored');
                for(const child of children){if(replace){await unknown(tracker,child);}else{assert.equal(tracker.getOriginalContent(child),'');assert.ok(tracker.getReviewToken(child));}}
            }finally{gate.release();await operation;}
        }));
    }
    for(const activity of ['ancestor-delete','fresh-child','stop','epoch','save-failure']){
        test(`DIRECTORY-PUBLICATION control ${activity}`,()=>fixture(async({tracker,dir})=>{
            const {container,root,known,children}=await seed(tracker,dir);
            let history;
            if(activity==='ancestor-delete'){
                fs.writeFileSync(known,'updated known file');await tracker.readFileAndUpdate(known,Uri.file(known));
                assert.equal((await tracker.revertBlock(known,0)).status,'success');
                history=JSON.stringify(tracker.revertHistory);assert.ok(tracker.revertHistory.length>0);
            }
            const storage=tracker.storageUri,gate=pause(path.join(storage.fsPath,'session-state.tmp.json'),'write');
            const operation=tracker.onExternalFileCreatedEvent(Uri.file(root));let fresh;
            try{
                await bounded(gate.entered);
                if(activity==='ancestor-delete'||activity==='fresh-child'){
                    const deleted=activity==='ancestor-delete'?container:root;
                    fs.rmSync(deleted,{recursive:true});tracker.dispatchExternalEvent(Uri.file(deleted),'delete',tracker.sessionEpoch);
                    fs.mkdirSync(path.join(root,'nested'),{recursive:true});
                    for(const child of children){fs.writeFileSync(child,'unproven replacement');}
                    if(activity==='ancestor-delete'){fs.writeFileSync(known,'replacement known file');}
                    else{fresh=tracker.onExternalFileCreatedEvent(Uri.file(children[0]));}
                }else if(activity==='stop'){tracker.stopRecording();}
                else if(activity==='epoch'){
                    tracker.advanceEpoch();tracker.unresolvedBaselineFiles.delete(children[0]);tracker.postBaselineUnknownFiles.delete(children[0]);
                    tracker.fileSnapshots.set(children[0],'new epoch baseline');tracker.baselineExistingFiles.add(children[0]);
                }else{faults.set(path.join(storage.fsPath,'session-state.json'),{copy:Object.assign(new Error('Synthetic directory copy failure'),{code:'NoPermissions'})});}
                gate.release();await bounded(operation);if(fresh){await bounded(fresh);}
                assert.equal(tracker.getOriginalContent(known),'original known file');
                if(history){assert.equal(JSON.stringify(tracker.revertHistory),history,'ancestor reconciliation preserves the independent Undo record');}
                for(const [index,child] of children.entries()){
                    if(index===0&&activity==='epoch'){assert.equal(tracker.getOriginalContent(child),'new epoch baseline');}
                    else if(index===0&&activity==='fresh-child'){assert.equal(tracker.getOriginalContent(child),'');assert.ok(tracker.getReviewToken(child));}
                    else{await unknown(tracker,child);}
                }
                if(activity==='save-failure'){
                    assert.equal(tracker.persistenceFailed,true);assert.equal(fs.existsSync(path.join(storage.fsPath,'session-state.unsaved')),true);
                    const reader=new DiffTracker(storage);try{assert.equal(await reader.restorePersistedState(),'blocked');}finally{await reader.dispose();}
                }
                faults.clear();assert.equal(await tracker.flushPendingPersistence(),true);
            }finally{gate.release();await operation;if(fresh){await fresh;}faults.clear();}
        }));
    }
    for(const limit of ['entries','snapshots'])test(`DIRECTORY-PUBLICATION exhausted ${limit}`,()=>fixture(async({tracker,dir})=>{
        const {root,known,children}=await seed(tracker,dir);
        if(limit==='entries'){tracker.maxScopePreflightEntries=1;}else{tracker.maxPersistedSnapshots=2;}
        try{
            await bounded(tracker.onExternalFileCreatedEvent(Uri.file(root)));
            assert.equal(tracker.getOriginalContent(known),'original known file');
            for(const child of children){assert.equal(tracker.fileSnapshots.has(child),false);assert.equal(tracker.getReviewToken(child),undefined);}
            assert.ok(tracker.getCoverageGaps().length>0||tracker.persistenceFailed,'an incomplete batch must retain explicit uncertainty');
        }finally{tracker.maxScopePreflightEntries=10000;tracker.maxPersistedSnapshots=10000;}
    }));
    test('DIRECTORY-PUBLICATION mixed metadata tokens wait for acceptance',()=>fixture(async({tracker,dir})=>{
        const {root}=await seed(tracker,dir,0);
        const binary=path.join(root,'binary.bin'),large=path.join(root,'large.txt');
        fs.writeFileSync(binary,Buffer.from([0,1,2,3]));fs.writeFileSync(large,'');fs.truncateSync(large,64*1024*1024+1);
        const gate=pause(path.join(tracker.storageUri.fsPath,'session-state.tmp.json'),'write');
        const operation=tracker.onExternalFileCreatedEvent(Uri.file(root));
        try{
            await bounded(gate.entered);
            assert.equal(tracker.getOpaqueReviewToken(binary),undefined);
            assert.equal(tracker.getLargeFileReminderToken(large),undefined);
            gate.release();await bounded(operation);
            assert.ok(tracker.getOpaqueReviewToken(binary));assert.ok(tracker.getLargeFileReminderToken(large));
        }finally{gate.release();await operation;}
    }));
    test('DIRECTORY-PUBLICATION partial read failure recovers without changing before-images',()=>fixture(async({tracker,dir})=>{
        const {root,children}=await seed(tracker,dir);
        faults.set(children[1],{read:Object.assign(new Error('Synthetic partial read failure'),{code:'NoPermissions'})});
        try{
            await bounded(tracker.onExternalFileCreatedEvent(Uri.file(root)));
            assert.equal(tracker.getOriginalContent(children[0]),'');assert.ok(tracker.getReviewToken(children[0]));
            assert.equal(tracker.getOriginalContent(children[1]),'');assert.equal(tracker.getReviewToken(children[1]),undefined);
            faults.clear();await tracker.readFileAndUpdate(children[1],Uri.file(children[1]));
            assert.equal(tracker.getOriginalContent(children[1]),'');assert.ok(tracker.getReviewToken(children[1]));
        }finally{faults.clear();}
    }));
    test('DIRECTORY-PUBLICATION unresolved allowance failure retains an incomplete-write guard',()=>fixture(async({tracker,dir})=>{
        const {root,known,children}=await seed(tracker,dir,2),storage=tracker.storageUri;
        const allowance=tracker.fileSnapshots.size+children.length;tracker.maxPersistedSnapshots=allowance;
        const gate=pause(path.join(storage.fsPath,'session-state.tmp.json'),'write');
        const operation=tracker.onExternalFileCreatedEvent(Uri.file(root));
        try{
            await bounded(gate.entered);
            assert.equal(children.filter(file=>tracker.runtimeCreationPublications.has(file)).length,children.length);
            for(let index=tracker.unresolvedBaselineFiles.size;index<allowance;index++){
                tracker.recordUnresolvedBaseline(path.join(dir,`concurrent-${index}.txt`),'Concurrent unknown observation');
            }
            fs.rmSync(root,{recursive:true});tracker.dispatchExternalEvent(Uri.file(root),'delete',tracker.sessionEpoch);
            fs.mkdirSync(path.join(root,'nested'),{recursive:true});for(const child of children){fs.writeFileSync(child,'unproven replacement');}
            gate.release();await bounded(operation);
            for(const child of children){await unknown(tracker,child);}
            assert.equal(tracker.getOriginalContent(known),'original known file');
            assert.equal(await tracker.flushPendingPersistence(),false);assert.equal(tracker.persistenceFailed,true);
            assert.equal(fs.existsSync(path.join(storage.fsPath,'session-state.unsaved')),true);
            const reader=new DiffTracker(storage);try{assert.equal(await reader.restorePersistedState(),'blocked');}finally{await reader.dispose();}
        }finally{gate.release();await operation;tracker.maxPersistedSnapshots=10000;}
    }));
    for(const cancel of [false,true])test(`DIRECTORY-PUBLICATION another save waits for a complete batch cancel=${cancel}`,()=>fixture(async({tracker,dir})=>{
        const {root,children}=await seed(tracker,dir),storage=tracker.storageUri;
        const gates=children.map(child=>pause(child,'stat'));
        const operation=tracker.onExternalFileCreatedEvent(Uri.file(root));let saving,release,held=false;
        const entered=new Promise(resolve=>{release=resolve;});
        let holdRelease;const hold=new Promise(resolve=>{holdRelease=resolve;});
        const flush=tracker.flushPendingPersistence.bind(tracker);
        try{
            const first=await bounded(Promise.race(gates.map((gate,index)=>gate.entered.then(()=>index))));
            gates[first].release();
            await bounded(Promise.race(gates.filter((_,index)=>index!==first).map(gate=>gate.entered)));
            let settled=false;saving=tracker.flushPendingPersistence();void saving.then(()=>{settled=true;});
            await new Promise(resolve=>setImmediate(resolve));
            assert.equal(settled,false,'a different writer cannot accept an unfinished directory projection');
            assert.equal(tracker.getReviewToken(children[first]),undefined);
            if(cancel){
                tracker.flushPendingPersistence=async(...args)=>{
                    const result=await flush(...args);
                    if(!held){held=true;release();await hold;}
                    return result;
                };
                fs.rmSync(root,{recursive:true});tracker.dispatchExternalEvent(Uri.file(root),'delete',tracker.sessionEpoch);
                fs.mkdirSync(path.join(root,'nested'),{recursive:true});for(const child of children){fs.writeFileSync(child,'replacement without fresh proof');}
            }
            for(const gate of gates){gate.release();}
            if(cancel){
                await bounded(Promise.race([entered,operation]));await bounded(saving);
                const reader=new DiffTracker(storage);
                try{
                    assert.equal(await reader.restorePersistedState(),'restored');
                    for(const child of children){await unknown(reader,child);}
                    const rechecked=await reader.recheckObservationCoverage();
                    assert.equal(rechecked.status,'rechecked',JSON.stringify(rechecked));
                    assert.deepEqual(reader.getCoverageGaps(),[],'verified recovery must retire the interrupted batch obligation');
                    for(const child of children){await unknown(reader,child);}
                }finally{await reader.dispose();}
                holdRelease();
            }
            await bounded(operation);assert.equal(await bounded(saving),true);
            if(!cancel){for(const child of children){assert.equal(tracker.getOriginalContent(child),'');assert.ok(tracker.getReviewToken(child));}}
        }finally{tracker.flushPendingPersistence=flush;for(const gate of gates){gate.release();}holdRelease();await operation;if(saving){await saving;}}
    }));
    for(const storage of [false,true])for(const replace of [false,true])
    test(`DIRECTORY-PUBLICATION overlapping batch storage=${storage} replace=${replace}`,()=>fixture(async({tracker,dir})=>{
        const a=await seed(tracker,dir,2);
        const root=path.join(a.container,'second-directory');fs.mkdirSync(root);
        const files=[0,1].map(index=>path.join(root,`second-${index}.txt`));
        for(const file of files){fs.writeFileSync(file,'independent second directory contents');}
        if(!storage){tracker.storageUri=undefined;}
        const ag=a.children.map(file=>pause(file,'stat')),bg=files.map(file=>pause(file,'stat'));
        const first=tracker.onExternalFileCreatedEvent(Uri.file(a.root));let second,saving;
        try{
            const i=await bounded(Promise.race(ag.map((gate,index)=>gate.entered.then(()=>index))));
            ag[i].release();await bounded(ag[1-i].entered);
            assert.ok(tracker.runtimeCreationPublications.has(a.children[i]));
            saving=tracker.flushPendingPersistence();
            second=tracker.onExternalFileCreatedEvent(Uri.file(root));
            const j=await bounded(Promise.race(bg.map((gate,index)=>gate.entered.then(()=>index))));
            bg[j].release();await bounded(bg[1-j].entered);
            for(const gate of ag){gate.release();}
            assert.equal(await bounded(saving),true);
            const premature=tracker.getReviewToken(files[j]);
            if(replace){
                fs.rmSync(root,{recursive:true});tracker.dispatchExternalEvent(Uri.file(root),'delete',tracker.sessionEpoch);
                fs.mkdirSync(root);for(const file of files){fs.writeFileSync(file,'unproven replacement contents');}
            }
            for(const gate of bg){gate.release();}
            await bounded(first);await bounded(second);
            for(const file of files){await tracker.readFileAndUpdate(file,Uri.file(file));}
            // Check the modifying boundary before token assertions, so the red
            // replacement control also demonstrates the buffer-safety effect.
            if(replace){await unknown(tracker,files[j]);}
            else{for(const file of files){assert.equal(tracker.getOriginalContent(file),'');assert.ok(tracker.getReviewToken(file));}}
            assert.equal(premature,undefined,'an earlier writer cannot accept a newer unfinished batch');
            assert.equal(tracker.getOriginalContent(a.known),'original known file');
        }finally{for(const gate of [...ag,...bg]){gate.release();}await first;if(second){await second;}if(saving){await saving;}}
    }));
    test('DIRECTORY-PUBLICATION opening an unseen file respects deferred directory provenance',()=>fixture(async({tracker,dir})=>{
        const {root}=await seed(tracker,dir,0);
        tracker.retainDirectoryPublicationUncertainty(root);
        const target=path.join(root,'unobserved.txt');fs.writeFileSync(target,'unproven directory contents');
        const doc=document(target);tracker.onDocumentOpened(doc);
        await unknown(tracker,target);
        assert.equal(await tracker.flushPendingPersistence(),true);
    }));
}
