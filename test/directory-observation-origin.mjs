import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function deferred() { let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve}; }
async function bounded(promise) {
    let timer;
    try { return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Directory observation boundary was not reached')),6000);})]); }
    finally { clearTimeout(timer); }
}

export function registerDirectoryObservationOrigin(h,fixture) {
    const {test,Uri,vscode,DiffTracker,setTracker}=h;
    test('DIRECTORY-ORIGIN source-only records retain the existing persistence count budget',()=>fixture(async({tracker,dir,scope})=>{
        const known=path.join(dir,'known.txt');fs.writeFileSync(known,'original');h.setListedFiles([Uri.file(known)]);
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status,'applied');
        tracker.coverageGaps.set(path.join(dir,'observed'),{unprovenDirectoryObservation:true});
        const limit=tracker.maxPersistedSnapshots;tracker.maxPersistedSnapshots=1;
        try {
            const budget=tracker.createCandidatePersistenceBudget();
            assert.equal(budget.coverageGaps,1,'source-only records occupy a real persisted array entry');
            assert.throws(()=>tracker.reserveCandidateCoverageGap(path.join(dir,'another'),
                {targetKind:'subtree',reasonCode:'coverage-recheck-incomplete',reason:'Synthetic new observation'},budget,false,true),
                /coverage-gap capacity/);
            assert.equal(tracker.coverageGaps.size,1);assert.equal(tracker.getOriginalContent(known),'original');
        } finally {tracker.maxPersistedSnapshots=limit;}
    }));
    for(const origin of [false,true]) test(`DIRECTORY-ORIGIN ordinary control recovery origin=${origin}`,()=>fixture(async({tracker,dir,scope})=>{
        const root=path.join(dir,'already-observed'),known=path.join(root,'known.txt');
        fs.mkdirSync(root);fs.writeFileSync(known,'original');h.setListedFiles([Uri.file(known)]);
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status,'applied');
        fs.writeFileSync(known,'pending');await tracker.readFileAndUpdate(known,Uri.file(known));
        tracker.setCoverageGap(root,{targetKind:'subtree',reasonCode:'scope-recheck-incomplete',reason:'Synthetic withdrawn control gap'});
        if(origin){tracker.coverageGaps.set(root,{...tracker.coverageGaps.get(root),unprovenDirectoryObservation:true});}
        for(let n=0;n<3;n++){assert.equal((await tracker.recheckObservationCoverage()).status,'rechecked');}
        assert.equal(tracker.getOriginalContent(known),'original');
        assert.equal(tracker.getTrackedChange(known)?.currentContent,'pending');
        assert.equal(tracker.supplementalDirectoryWatchers.size,0,'origin alone does not require an independent owner');
        assert.deepEqual(tracker.getCoverageGaps(),[]);
        assert.equal(tracker.coverageGaps.get(root)?.unprovenDirectoryObservation,origin?true:undefined);
    }));
    for(const variant of ['quota-late-child','quota-file','kind-unavailable','missing-file','exact-child',
        'historical-unknown','reload-before-repair','import-rollback','scope-rollback'])
    test(`DIRECTORY-ORIGIN ${variant}`,()=>fixture(async({tracker:initialTracker,dir,scope})=>{
        let tracker=initialTracker;
        const known=path.join(dir,'known.txt'),lead=path.join(dir,'lead.txt'),root=path.join(dir,'observed');
        const child=path.join(root,'original-unproven.txt'),late=path.join(root,'later.txt');
        fs.writeFileSync(known,'known baseline');fs.writeFileSync(lead,'lead baseline');
        h.setVsCodeExcludes({});h.setListedFiles([known,lead].map(Uri.file));
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status,'applied');
        fs.writeFileSync(known,'retained edit');await tracker.readFileAndUpdate(known,Uri.file(known));
        if(variant==='historical-unknown'){tracker.recordUnresolvedBaseline(late,'Historical unknown before-image');}
        assert.equal(await tracker.flushPendingPersistence(),true);
        tracker.activateExternalWatchers(tracker.createExternalWatchers(tracker.sessionEpoch));
        const storage=tracker.storageUri,allowance=tracker.maxScopePreflightEntries;
        const previousGaps=new Map(tracker.coverageGaps),previousImport=tracker.captureImportedDirectoryRollbackState(root);
        const firstSave=h.pause(path.join(storage.fsPath,'session-state.tmp.json'),'write');
        const replayEntered=deferred(),releaseReplay=deferred();let armed=false,replayTaken=false,unavailable=false;
        const originalStat=vscode.workspace.fs.stat,originalLstat=fs.lstatSync;
        vscode.workspace.fs.stat=async function(uri){
            if(armed&&!replayTaken&&uri.fsPath===lead&&tracker.restoringEpoch===undefined&&tracker.coverageRecheckEpoch===tracker.sessionEpoch){
                replayTaken=true;replayEntered.resolve();await releaseReplay.promise;
            }
            return originalStat.call(this,uri);
        };
        if(variant==='kind-unavailable'){
            fs.lstatSync=function(value,...args){
                if(unavailable&&String(value)===root){throw Object.assign(new Error('Synthetic type-read failure'),{code:'EACCES'});}
                return originalLstat(value,...args);
            };
        }
        const operation=tracker.recheckObservationCoverage();
        try {
            await bounded(firstSave.entered);
            const watcher=tracker.fileWatchers.find(w=>(typeof w.pattern==='string'?w.pattern:w.pattern?.pattern)==='**/*');
            assert.ok(watcher);
            fs.writeFileSync(lead,'lead pending');watcher.emit('change',Uri.file(lead));
            fs.mkdirSync(root);fs.writeFileSync(child,'unproven original child');watcher.emit('create',Uri.file(root));
            armed=true;firstSave.release();
            await bounded(replayEntered.promise);
            assert.equal(tracker.restoreEvents.get(root)?.reconcileDirectory,true);
            assert.equal(tracker.restoreEvents.get(root)?.creationCurrent,undefined);
            if(variant==='kind-unavailable'){fs.rmSync(root,{recursive:true});fs.writeFileSync(root,'replacement file');unavailable=true;}
            if(variant==='missing-file'){fs.rmSync(root,{recursive:true});}
            tracker.maxScopePreflightEntries=0;releaseReplay.resolve();
            assert.notEqual((await operation).status,'rechecked');
            tracker.maxScopePreflightEntries=allowance;
            if(variant==='missing-file'){
                await tracker.recheckObservationCoverage();fs.writeFileSync(root,'replacement file');
            }else if(variant==='kind-unavailable'){
                assert.notEqual((await tracker.recheckObservationCoverage()).status,'rechecked');unavailable=false;
            }else{
                const cap=tracker.maxImportedDirectoryWatchers;tracker.maxImportedDirectoryWatchers=0;
                try{assert.notEqual((await tracker.recheckObservationCoverage()).status,'rechecked');}
                finally{tracker.maxImportedDirectoryWatchers=cap;}
                if(variant==='quota-file'){fs.rmSync(root,{recursive:true});fs.writeFileSync(root,'replacement file');}
                else{
                    fs.writeFileSync(late,'unproven late child');
                    if(variant==='exact-child'||variant==='historical-unknown'){
                        const current=tracker.fileWatchers.find(w=>(typeof w.pattern==='string'?w.pattern:w.pattern?.pattern)==='**/*');
                        assert.ok(current);current.emit('create',Uri.file(late));
                        if(variant==='exact-child'){await bounded(h.waitUntil(()=>!!tracker.getReviewToken(late)));}
                    }
                }
            }
            if(variant==='import-rollback'){tracker.restoreImportedDirectoryRollbackState(root,previousImport);}
            if(variant==='scope-rollback'){tracker.restoreCoverageGapsPreservingSupplemental(previousGaps,new Set());}
            if(variant==='reload-before-repair'){
                assert.equal(await tracker.flushPendingPersistence(),true);await tracker.dispose();
                tracker=new DiffTracker(storage);setTracker(tracker);assert.equal(await tracker.restorePersistedState(),'restored');
            }
            for(let n=0;n<3;n++){await tracker.recheckObservationCoverage();}
            const examined=['quota-file','kind-unavailable','missing-file'].includes(variant)?root:late;
            const contents=fs.readFileSync(examined,'utf8'),doc=h.document(examined),before=doc.getText(),dirty=doc.isDirty;
            if(variant==='exact-child'){
                assert.equal(tracker.getOriginalContent(examined),'');assert.ok(tracker.getReviewToken(examined));
            }else{
                assert.equal((await tracker.revertBlock(examined,0)).status,'conflict','an unproven before-image cannot authorize a buffer mutation');
                assert.equal(doc.getText(),before);assert.equal(doc.isDirty,dirty);
                assert.equal(tracker.fileSnapshots.has(examined),false);assert.equal(tracker.getReviewToken(examined),undefined);
                assert.equal(tracker.unresolvedBaselineFiles.has(examined),true);
            }
            assert.equal(fs.readFileSync(examined,'utf8'),contents);
            assert.equal((await tracker.recheckObservationCoverage()).status,'rechecked');
            assert.deepEqual(tracker.getCoverageGaps(),[]);
            assert.equal(tracker.coverageGaps.get(root)?.unprovenDirectoryObservation,true,'source survives retirement independently of diagnostics');
            assert.equal(tracker.getOriginalContent(known),'known baseline');assert.equal(tracker.getTrackedChange(known)?.currentContent,'retained edit');
            assert.equal(await tracker.flushPendingPersistence(),true);
            for(const name of ['session-state.json','session-state.last-good.json']){
                const saved=JSON.parse(fs.readFileSync(path.join(storage.fsPath,name)));
                assert.equal(new Map(saved.coverageGaps).get(root)?.unprovenDirectoryObservation,true);
                assert.equal(new Map(saved.fileSnapshots).has(examined),variant==='exact-child');
            }
            await tracker.dispose();tracker=new DiffTracker(storage);setTracker(tracker);
            assert.equal(await tracker.restorePersistedState(),'restored');
            for(let n=0;n<3;n++){await tracker.recheckObservationCoverage();}
            assert.equal((await tracker.recheckObservationCoverage()).status,'rechecked');
            if(variant==='exact-child'){assert.equal(tracker.getOriginalContent(examined),'');assert.ok(tracker.getReviewToken(examined));}
            else{
                const reopened=h.document(examined),text=reopened.getText();
                assert.equal((await tracker.revertBlock(examined,0)).status,'conflict');assert.equal(reopened.getText(),text);
                assert.equal(tracker.fileSnapshots.has(examined),false);assert.equal(tracker.getReviewToken(examined),undefined);
            }
            assert.equal(fs.readFileSync(examined,'utf8'),contents);
        } finally {
            firstSave.release();releaseReplay.resolve();await operation;tracker.maxScopePreflightEntries=allowance;
            vscode.workspace.fs.stat=originalStat;fs.lstatSync=originalLstat;
        }
    }));
}
