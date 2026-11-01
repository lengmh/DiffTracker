import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {validateAndCanonicalizeScope} from '../out/monitoringScope.js';

// Real filesystem and production publication/recovery logic. Only delivery of
// notifications and the provider stat await are controlled; candidate order is dynamic.
export function registerCreationProofLifecycle(h,fixture) {
    const {test, Uri, DiffTracker, pause, document,
        setTracker, setVsCodeExcludes, faults} = h;

    const beforeCompletion = (gate, restore, description) => Promise.race([
        gate,
        restore.then(outcome => {
            throw new Error(`Restore completed before ${description}: ${outcome}`);
        })
    ]);

    for (const mode of ['revoked-plan', 'revoked-block', 'revoked-file-guard',
        'late-proof', 'late-proof-reload', 'control', 'revoked-reload',
        'late-proof-budget', 'revoked-budget', 'stop', 'new-epoch', 'save-failure']) {
        test(`CREATION-PROOF restore ${mode}`, () => fixture(async context => {
            let tracker = context.tracker;
            const {dir, scope} = context;
            const root = path.join(dir, 'temporary');
            const known = path.join(root, 'known.txt');
            const candidates = [path.join(root, 'new-a.txt'), path.join(root, 'new-b.txt')];
            fs.mkdirSync(root);
            fs.writeFileSync(known, 'original');
            setVsCodeExcludes({'files.watcherExclude': {'temporary/**': true}});
            assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status, 'applied');
            assert.equal(await tracker.flushPendingPersistence(), true);
            for (const candidate of candidates) {
                assert.equal(fs.existsSync(candidate), false);
                assert.equal(tracker.getOriginalContent(candidate), undefined);
                assert.equal(tracker.baselineExistingFiles.has(candidate), false);
                assert.equal(tracker.unresolvedBaselineFiles.has(candidate), false);
            }

            const storage = tracker.storageUri;
            await tracker.dispose();
            tracker = new DiffTracker(storage);
            setTracker(tracker);
            const activate = tracker.activateExternalWatchers.bind(tracker);
            let createdWithLiveRestoreWatchers = false;
            tracker.activateExternalWatchers = (...args) => {
                const result = activate(...args);
                if (!createdWithLiveRestoreWatchers) {
                    assert.equal(tracker.restoringEpoch, tracker.sessionEpoch);
                    assert.equal(tracker.externalWatcherEnabled, true);
                    assert.ok(tracker.fileWatchers.length > 0, 'real tracker watcher registration precedes file creation');
                    // Make the parent notification a real directory incarnation
                    // change too: the initial known parent is physically removed
                    // and recreated only after the general restore watcher is live.
                    // Its delayed delete/create notifications are delivered below.
                    fs.rmSync(root, {recursive: true});
                    fs.mkdirSync(root);
                    fs.writeFileSync(known, 'original');
                    for (const candidate of candidates) {
                        assert.equal(fs.existsSync(candidate), false);
                        assert.equal(tracker.getOriginalContent(candidate), undefined);
                        fs.writeFileSync(candidate, 'independent newly created file');
                    }
                    createdWithLiveRestoreWatchers = true;
                }
                return result;
            };

            const gates = candidates.map(candidate => pause(candidate, 'stat'));
            const restoration = tracker.restorePersistedState();
            let first;
            try {
                const firstIndex = await beforeCompletion(Promise.race(gates.map((gate, index) =>
                    gate.entered.then(() => index))), restoration, 'first candidate metadata gate');
                const secondIndex = 1 - firstIndex;
                first = candidates[firstIndex];
                assert.equal(createdWithLiveRestoreWatchers, true);
                assert.equal(tracker.getOriginalContent(first), undefined);
                tracker.dispatchExternalEvent(Uri.file(root), 'delete', tracker.sessionEpoch);
                tracker.dispatchExternalEvent(Uri.file(root), 'create', tracker.sessionEpoch);
                if (mode.startsWith('revoked') || ['control','stop','new-epoch','save-failure'].includes(mode)) {
                    tracker.dispatchExternalEvent(Uri.file(first), 'create', tracker.sessionEpoch);
                }
                gates[firstIndex].release();
                await beforeCompletion(gates[secondIndex].entered, restoration, 'second candidate metadata gate');

                if (mode.startsWith('late-proof')) {
                    // This notification describes the same live-session file
                    // creation above; no further replacement or ancestor delete
                    // occurs after the first candidate's plan is computed.
                    tracker.dispatchExternalEvent(Uri.file(first), 'create', tracker.sessionEpoch);
                } else if (mode.startsWith('revoked')) {
                    fs.rmSync(root, {recursive: true});
                    tracker.dispatchExternalEvent(Uri.file(root), 'delete', tracker.sessionEpoch);
                    fs.mkdirSync(root);
                    fs.writeFileSync(known, 'recreated known');
                    for (const candidate of candidates) {
                        fs.writeFileSync(candidate, 'replacement without renewed exact proof');
                    }
                    tracker.dispatchExternalEvent(Uri.file(root), 'create', tracker.sessionEpoch);
                }
                if(mode.endsWith('budget')){tracker.maxPersistedSnapshots=tracker.fileSnapshots.size;}
                if(mode==='stop'){tracker.stopRecording();}
                if(mode==='new-epoch'){
                    tracker.advanceEpoch();tracker.isRecording=false;
                    tracker.fileSnapshots.set(first,'new epoch baseline');tracker.baselineExistingFiles.add(first);
                }
                if(mode==='save-failure'){faults.set(path.join(storage.fsPath,'session-state.json'),{copy:Object.assign(new Error('Synthetic copy failure'),{code:'NoPermissions'})});}
                gates[secondIndex].release();
                const outcome=await restoration;
                if(['stop','new-epoch','late-proof-budget','save-failure'].includes(mode)){
                    assert.equal(outcome,'blocked');assert.equal(tracker.getOriginalContent(known),'original');
                    if(mode==='new-epoch'){assert.equal(tracker.getOriginalContent(first),'new epoch baseline');}
                    else if(mode==='stop'||mode==='late-proof-budget'){assert.equal(tracker.fileSnapshots.has(first),false);assert.equal(tracker.getReviewToken(first),undefined);}
                    else{assert.equal(tracker.isRecoveryBlocked(),true);assert.equal((await tracker.revertBlock(first,0)).status,'conflict');}
                    return;
                }
                assert.equal(outcome, 'restored');
                assert.equal(tracker.getOriginalContent(known), 'original');
                assert.deepEqual(tracker.getCoverageGaps(), []);
                assert.equal(tracker.restoreEvents.size, 0);

                if (mode === 'late-proof-reload' || mode==='revoked-reload') {
                    assert.equal(await tracker.flushPendingPersistence(), true);
                    await tracker.dispose();
                    tracker = new DiffTracker(storage);
                    setTracker(tracker);
                    assert.equal(await tracker.restorePersistedState(), 'restored');
                }

                if (['revoked-plan','revoked-reload','revoked-budget'].includes(mode)) {
                    console.log('CREATION-PROOF restore revoked-plan observation', JSON.stringify({
                        baseline: tracker.getOriginalContent(first),
                        unknown: tracker.unresolvedBaselineFiles.has(first),
                        token: !!tracker.getReviewToken(first)
                    }));
                    assert.equal(tracker.getOriginalContent(first), undefined, 'revoked proof must not publish its stale empty baseline');
                    assert.equal(tracker.getReviewToken(first), undefined);
                    assert.equal(tracker.unresolvedBaselineFiles.has(first), true);
                } else if (mode === 'revoked-file-guard') {
                    const before = fs.readFileSync(first, 'utf8');
                    const action = await tracker.revertFile(first);
                    console.log('CREATION-PROOF restore revoked-file-guard observation', JSON.stringify({
                        baseline: tracker.getOriginalContent(first), action,
                        exists: fs.existsSync(first), disk: fs.readFileSync(first, 'utf8')
                    }));
                    assert.equal(action.status, 'conflict', 'whole-file Revert must continue to refuse deleting a new file');
                    assert.equal(fs.readFileSync(first, 'utf8'), before);
                } else if (mode === 'revoked-block') {
                    const doc = document(first);
                    const before = {text: doc.getText(), dirty: doc.isDirty, disk: fs.readFileSync(first, 'utf8')};
                    assert.equal(before.dirty, false);
                    const action = await tracker.revertBlock(first, 0);
                    console.log('CREATION-PROOF restore revoked observation', JSON.stringify({
                        baseline: tracker.getOriginalContent(first), token: !!tracker.getReviewToken(first),
                        before, action, after: {text: doc.getText(), dirty: doc.isDirty,
                            disk: fs.readFileSync(first, 'utf8')}
                    }));
                    assert.equal(action.status, 'conflict', 'revoked absence proof must reject block Revert');
                    assert.equal(doc.getText(), before.text);
                    assert.equal(doc.isDirty, before.dirty);
                    assert.equal(fs.readFileSync(first, 'utf8'), before.disk);
                    assert.equal(tracker.getOriginalContent(first), undefined);
                    assert.equal(tracker.getReviewToken(first), undefined);
                } else {
                    console.log(`CREATION-PROOF restore ${mode} observation`, JSON.stringify({
                        baseline: tracker.getOriginalContent(first),
                        unknown: tracker.unresolvedBaselineFiles.has(first),
                        token: !!tracker.getReviewToken(first)
                    }));
                    assert.equal(tracker.getOriginalContent(first), '', 'valid exact creation proof must survive discovery publication');
                    assert.equal(tracker.unresolvedBaselineFiles.has(first), false);
                    assert.ok(tracker.getReviewToken(first));
                }
            } finally {
                for (const gate of gates) { gate.release(); }
                await restoration;faults.clear();
            }
        }));
    }
    const {waitUntil}=h;
async function bounded(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' did not enter')),5000);})]);}finally{clearTimeout(timer);}}

async function inspectAndAttemptBlock(tracker,target){
 const doc=document(target),before=doc.getText();
 const evidence={baseline:tracker.getOriginalContent(target),unknown:tracker.unresolvedBaselineFiles.has(target),token:!!tracker.getReviewToken(target)};
 const result=await tracker.revertBlock(target,0);
 assert.equal(evidence.baseline,undefined,'no current before-image proof may publish an empty baseline');
 assert.equal(evidence.token,false);assert.equal(result.status,'conflict');assert.equal(doc.getText(),before);assert.equal(doc.isDirty,false);
}

test('CREATION-PROOF runtime: ancestor deletion revokes in-flight direct file-create proof',()=>fixture(async({tracker,dir})=>{
 const parent=path.join(dir,'parent');fs.mkdirSync(parent);
 const target=path.join(parent,'new.txt');
 fs.writeFileSync(target,'first live creation'); // Real creation in the active tracking epoch.
 const gate=pause(target,'stat');
 const creating=tracker.onExternalFileCreatedEvent(Uri.file(target)); // Deliver that exact creation once.
 try{
  await bounded(gate.entered,'workspace.fs.stat(new.txt)');
  fs.rmSync(parent,{recursive:true});
  tracker.dispatchExternalEvent(Uri.file(parent),'delete',tracker.sessionEpoch);
  fs.mkdirSync(parent);fs.writeFileSync(target,'replacement with no exact create notification');
  gate.release();await creating;
  await waitUntil(()=>tracker.activeExternalOperations.size===0&&tracker.externalChangeTimers.size===0,5000);
  await inspectAndAttemptBlock(tracker,target);
 }finally{gate.release();await creating;}
}));

test('CREATION-PROOF runtime: file-to-directory replacement cannot authorize child before-images',()=>fixture(async({tracker,dir})=>{
 const target=path.join(dir,'new-path');fs.writeFileSync(target,'first live file creation');
 const gate=pause(target,'stat');
 const creating=tracker.onExternalFileCreatedEvent(Uri.file(target));
 try{
  await bounded(gate.entered,'workspace.fs.stat(new-path)');
  fs.unlinkSync(target);fs.mkdirSync(target);
  const child=path.join(target,'unproven.txt');fs.writeFileSync(child,'replacement child with no exact create notification');
  gate.release();await creating;
  await inspectAndAttemptBlock(tracker,child);
 }finally{gate.release();await creating;}
}));

test('CREATION-PROOF runtime: ordinary independent file-create positive control',()=>fixture(async({tracker,dir})=>{
 const target=path.join(dir,'ordinary.txt');fs.writeFileSync(target,'created while tracker is live');
 await tracker.onExternalFileCreatedEvent(Uri.file(target));
 assert.equal(tracker.getOriginalContent(target),'');assert.ok(tracker.getReviewToken(target));
 assert.equal(tracker.getTrackedChange(target)?.reviewKind,'text');
}));

for(const activity of ['fresh-proof','atomic-file','unnotified-ancestor','pending-exclude','stop','new-epoch'])
test(`CREATION-PROOF runtime control ${activity}`,()=>fixture(async({tracker,dir})=>{
    const parent=path.join(dir,'live-parent');fs.mkdirSync(parent);const target=path.join(parent,'created.txt');
    fs.writeFileSync(target,'first creation');const gate=pause(target,'stat');
    const creating=tracker.onExternalFileCreatedEvent(Uri.file(target));
    try{
        await bounded(gate.entered,'runtime control metadata');
        if(activity==='fresh-proof'||activity==='unnotified-ancestor'){
            fs.rmSync(parent,{recursive:true});
            if(activity==='fresh-proof'){tracker.dispatchExternalEvent(Uri.file(parent),'delete',tracker.sessionEpoch);}
            fs.mkdirSync(parent);fs.writeFileSync(target,'replacement creation');
            if(activity==='fresh-proof'){await tracker.onExternalFileCreatedEvent(Uri.file(target));}
        }else if(activity==='atomic-file'){
            const temporary=path.join(parent,'replacement.tmp');fs.writeFileSync(temporary,'atomic file update');fs.renameSync(temporary,target);
        }else if(activity==='pending-exclude'){
            const pending=validateAndCanonicalizeScope({mode:'wholeWorkspace',includes:[],excludes:[{scope:'all',pattern:'/live-parent/'}]},tracker.currentWorkspaceRootIdentities());
            assert.equal(pending.ok,true);tracker.setPendingMonitoringScope(pending.scope);
        }else if(activity==='stop'){tracker.stopRecording();}
        else{tracker.advanceEpoch();tracker.isRecording=false;tracker.fileSnapshots.set(target,'new epoch baseline');tracker.baselineExistingFiles.add(target);}
        gate.release();await creating;
        if(activity==='fresh-proof'||activity==='atomic-file'){assert.equal(tracker.getOriginalContent(target),'');assert.ok(tracker.getReviewToken(target));}
        else if(activity==='unnotified-ancestor'){await inspectAndAttemptBlock(tracker,target);}
        else if(activity==='pending-exclude'){
            assert.equal(tracker.fileSnapshots.has(target),false);
            assert.equal(tracker.coverageGaps.get(target)?.file?.reasonCode,'pending-scope-deferred-event','an invalidated creation retains its pending-scope observation obligation');
        }
        else if(activity==='stop'){assert.equal(tracker.fileSnapshots.has(target),false);assert.equal(tracker.getIsRecording(),false);}
        else{assert.equal(tracker.getOriginalContent(target),'new epoch baseline');}
    }finally{gate.release();await creating;}
}));

}
