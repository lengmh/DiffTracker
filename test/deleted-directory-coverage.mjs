import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {validateAndCanonicalizeScope} from '../out/monitoringScope.js';

export function registerDeletedDirectoryCoverage(h, fixture) {
    const { test, Uri, waitUntil, nativeDirectoryWatchers, DiffTracker, setTracker } = h;
    const currentOwner = (tracker, root) => tracker.supplementalDirectoryWatchers.get(root);
    const notify = (directory, name) => process.env.DT_REAL_DIRECTORY_WATCH ? undefined : [...nativeDirectoryWatchers].reverse()
        .find(owner => owner.active && path.resolve(String(owner.directory)) === path.resolve(directory))?.listener('rename', name);
    test('DELETED-COVERAGE normal deletion preserves review and observes same-path reconstruction', () => fixture(async ({tracker, dir, scope}) => {
        const root = path.join(dir, 'temporary'); fs.mkdirSync(root);
        const file = path.join(root, 'review.txt'); fs.writeFileSync(file, 'original');
        h.setVsCodeExcludes({'files.watcherExclude': {'temporary/**':true}});
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status, 'applied');
        const old = currentOwner(tracker, root);
        fs.rmSync(root, {recursive:true});
        await tracker.onExternalFileDeleted(Uri.file(root));
        assert.equal(old.epoch, -1);
        assert.equal(tracker.getOriginalContent(file), 'original');
        assert.equal(tracker.getTrackedChange(file)?.isDeleted, true);
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
        const token = tracker.getReviewToken(file);
        assert.equal((await tracker.recheckObservationCoverage()).status, 'rechecked');
        assert.deepEqual(tracker.getReviewToken(file), token);
        assert.equal((await tracker.recheckObservationCoverage()).status, 'rechecked');
        fs.mkdirSync(root); fs.writeFileSync(file, 'new incarnation');
        notify(dir, 'temporary');
        await waitUntil(() => tracker.getTrackedChange(file)?.currentContent === 'new incarnation');
        await waitUntil(() => tracker.getSubtreeCoverageGaps().length === 0);
        assert.equal(tracker.getOriginalContent(file), 'original');
        assert.notEqual(currentOwner(tracker, root), old);
        fs.writeFileSync(file, 'follow-up'); notify(root, 'review.txt');
        await waitUntil(() => tracker.getTrackedChange(file)?.currentContent === 'follow-up');
    }));
    test('DELETED-COVERAGE reload revalidates wrapped imported missing obligation without Reset', () => fixture(async ({tracker, dir}) => {
        const root = path.join(dir, 'imported'); fs.mkdirSync(root);
        const file = path.join(root, 'review.txt'); fs.writeFileSync(file, 'accepted import');
        await tracker.onExternalFileCreated(Uri.file(root));
        assert.equal((await tracker.keepAllChangesInFile(file)).status, 'success');
        fs.rmSync(root, {recursive:true});
        // A released-version session wraps its missing diagnostic at save.
        tracker.setSubtreeCoverageGap(root, 'supplemental-watcher-target-missing-gap', 'Prior deletion');
        const storage = tracker.storageUri;
        assert.equal(await tracker.flushPendingPersistence(), true);
        await tracker.dispose();
        tracker = new DiffTracker(storage); setTracker(tracker);
        assert.equal(await tracker.restorePersistedState(), 'restored');
        assert.equal(tracker.getOriginalContent(file), 'accepted import');
        assert.equal(tracker.getTrackedChange(file)?.isDeleted, true);
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
        assert.equal((await tracker.recheckObservationCoverage()).status, 'rechecked');
        fs.mkdirSync(root); fs.writeFileSync(file, 'recreated after reload'); notify(dir, 'imported');
        await waitUntil(() => tracker.getTrackedChange(file)?.currentContent === 'recreated after reload');
    }));
    async function seed(tracker,dir,scope,relative='temporary') {
        const root = path.join(dir,relative); fs.mkdirSync(root,{recursive:true});
        const file = path.join(root,'review.txt'); fs.writeFileSync(file,'original');
        h.setVsCodeExcludes({'files.watcherExclude':{[`${relative}/**`]:true}});
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status,'applied');
        return {root,file};
    }
    test('DELETED-COVERAGE last-file deletion keeps the existing directory owner', () => fixture(async ({tracker,dir,scope}) => {
        const {root,file} = await seed(tracker,dir,scope);
        const owner = currentOwner(tracker,root);
        fs.unlinkSync(file); await tracker.onExternalFileDeleted(Uri.file(file));
        assert.equal(currentOwner(tracker,root),owner);
        assert.equal(owner.observationDirectory,undefined);
        assert.equal(tracker.getTrackedChange(file)?.isDeleted,true);
        assert.deepEqual(tracker.getSubtreeCoverageGaps(),[]);
    }));
    test('DELETED-COVERAGE empty recreation installs a fresh owner before later file creation', () => fixture(async ({tracker,dir,scope}) => {
        const {root,file} = await seed(tracker,dir,scope);
        fs.rmSync(root,{recursive:true}); await tracker.onExternalFileDeleted(Uri.file(root));
        fs.mkdirSync(root); notify(dir,'temporary');
        await waitUntil(() => currentOwner(tracker,root)?.epoch === tracker.sessionEpoch &&
            !currentOwner(tracker,root)?.observationDirectory && !tracker.getSubtreeCoverageGaps().length);
        fs.writeFileSync(file,'new bytes'); notify(root,'review.txt');
        await waitUntil(() => tracker.getTrackedChange(file)?.currentContent === 'new bytes');
        assert.equal(tracker.getOriginalContent(file),'original');
    }));
    test('DELETED-COVERAGE ancestor-chain deletion advances only the reconstruction path', () => fixture(async ({tracker,dir,scope}) => {
        const {root,file} = await seed(tracker,dir,scope,'container/deep/temporary');
        const container = path.join(dir,'container'), deep = path.join(container,'deep');
        fs.rmSync(container,{recursive:true}); await tracker.onExternalFileDeleted(Uri.file(container));
        assert.equal(currentOwner(tracker,root)?.observationDirectory,dir);
        assert.deepEqual(tracker.getSubtreeCoverageGaps(),[]);
        const opens = fs.promises.opendir;
        let siblingReads = 0;
        fs.promises.opendir = (target,...args) => {
            if ([dir,container,deep].includes(String(target))) { siblingReads++; }
            return opens(target,...args);
        };
        try {
            fs.mkdirSync(container); notify(dir,'container');
            await waitUntil(() => currentOwner(tracker,root)?.epoch === tracker.sessionEpoch && currentOwner(tracker,root)?.observationDirectory === container);
            fs.mkdirSync(deep); notify(container,'deep');
            await waitUntil(() => currentOwner(tracker,root)?.epoch === tracker.sessionEpoch && currentOwner(tracker,root)?.observationDirectory === deep);
            assert.equal(siblingReads,0,'chain advancement uses metadata, never sibling enumeration');
        } finally { fs.promises.opendir = opens; }
        fs.mkdirSync(root); fs.writeFileSync(file,'chain recreated'); notify(deep,'temporary');
        await waitUntil(() => tracker.getTrackedChange(file)?.currentContent === 'chain recreated');
        await waitUntil(() => !tracker.getSubtreeCoverageGaps().length);
        assert.equal(tracker.getOriginalContent(file),'original');
    }));
    test('DELETED-COVERAGE native self-delete retires an interior owner without scanning siblings', () => fixture(async ({tracker,dir,scope}) => {
        const {root} = await seed(tracker,dir,scope);
        const child = path.join(root,'child'); fs.mkdirSync(child);
        const file = path.join(child,'known.txt'); fs.writeFileSync(file,'child baseline');
        await tracker.onExternalFileCreated(Uri.file(child));
        assert.equal((await tracker.keepAllChangesInFile(file)).status,'success');
        const old = [...nativeDirectoryWatchers].reverse().find(item => item.active && item.directory === child);
        fs.rmSync(child,{recursive:true}); old.listener('rename','child');
        await waitUntil(() => tracker.getTrackedChange(file)?.isDeleted === true && !tracker.getSubtreeCoverageGaps().length);
        assert.equal(old.active,false);
        fs.mkdirSync(child); fs.writeFileSync(file,'recreated child'); notify(root,'child');
        await waitUntil(() => tracker.getTrackedChange(file)?.currentContent === 'recreated child');
        assert.equal(tracker.getOriginalContent(file),'child baseline');
    }));
    for (const failure of ['EACCES','ENOSPC']) test(`DELETED-COVERAGE ${failure} remains Limited until reliable proof exists`, () => fixture(async ({tracker,dir,scope}) => {
        const {root,file} = await seed(tracker,dir,scope);
        fs.rmSync(root,{recursive:true});
        const lstat = fs.lstatSync, watch = fs.watch;
        if (failure === 'EACCES') fs.lstatSync = (target,...args) => {
            if (String(target) === root) { throw Object.assign(new Error('synthetic permission failure'),{code:'EACCES'}); }
            return lstat(target,...args);
        };
        else fs.watch = (directory,...args) => {
            if (String(directory) === dir) { throw Object.assign(new Error('synthetic quota failure'),{code:'ENOSPC'}); }
            return watch(directory,...args);
        };
        try { await tracker.onExternalFileDeleted(Uri.file(root)); }
        finally { fs.lstatSync = lstat; fs.watch = watch; }
        assert.ok(tracker.getSubtreeCoverageGaps().length,'unproven coverage is visible');
        assert.equal(tracker.getOriginalContent(file),'original');
        assert.equal((await tracker.recheckObservationCoverage()).status,'rechecked');
        assert.deepEqual(tracker.getSubtreeCoverageGaps(),[]);
        assert.equal(currentOwner(tracker,root)?.observationDirectory,dir);
    }));
    for (const boundary of ['recreate','stop','save-failure']) test(`DELETED-COVERAGE final durable barrier rejects ${boundary}`, () => fixture(async ({tracker,dir,scope}) => {
        const {root,file} = await seed(tracker,dir,scope);
        const history = structuredClone(tracker.revertHistory);
        fs.rmSync(root,{recursive:true});
        const gate = h.pause(path.join(tracker.storageUri.fsPath,'session-state.tmp.json'),'write');
        const deleted = tracker.onExternalFileDeleted(Uri.file(root));
        await gate.entered;
        try {
            if (boundary === 'recreate') { fs.mkdirSync(root); fs.writeFileSync(file,'raced reconstruction'); }
            else if (boundary === 'stop') { tracker.stopRecording(); }
            else { h.faults.set(path.join(tracker.storageUri.fsPath,'session-state.json'),{copy:Object.assign(new Error('synthetic persistence failure'),{code:'NoPermissions'})}); }
            gate.release(); await deleted;
            assert.equal(tracker.getOriginalContent(file),'original');
            assert.deepEqual(tracker.revertHistory,history);
            if (boundary === 'stop') {
                assert.equal(tracker.getIsRecording(),false);
                assert.equal(nativeDirectoryWatchers.some(item => item.active),false);
            } else {
                assert.ok(tracker.getSubtreeCoverageGaps().length,'stale/failed certification restores uncertainty');
                if (boundary === 'recreate') {
                    notify(dir,'temporary');
                    await waitUntil(() => tracker.getTrackedChange(file)?.currentContent === 'raced reconstruction');
                    await waitUntil(() => !tracker.getSubtreeCoverageGaps().length);
                } else { assert.equal(tracker.getIsRecording(),false,'unsavable failure evidence safely pauses recording'); }
            }
        } finally { gate.release(); h.faults.clear(); await deleted; }
    }));
    test('DELETED-COVERAGE Revert and Undo keep the old baseline and future observation', () => fixture(async ({tracker,dir,scope}) => {
        const {root,file} = await seed(tracker,dir,scope);
        fs.rmSync(root,{recursive:true}); await tracker.onExternalFileDeleted(Uri.file(root));
        assert.equal((await tracker.revertFile(file)).status,'success');
        assert.equal(fs.readFileSync(file,'utf8'),'original');
        notify(dir,'temporary');
        await waitUntil(() => currentOwner(tracker,root)?.epoch === tracker.sessionEpoch && !currentOwner(tracker,root)?.observationDirectory);
        await waitUntil(() => !tracker.directoryObservations.size && !tracker.baselineTransaction && !tracker.runtimeBaselinePublications.size);
        const undone = await tracker.undoLastRevert();
        assert.equal(undone.succeeded,0,'existing Undo refuses an implicit delete of a restored file');
        assert.match(undone.results[0].reason,/record is retained/);
        assert.equal(tracker.revertHistory.length,1);
        fs.unlinkSync(file);
        assert.equal((await tracker.undoLastRevert()).succeeded,1);
        assert.equal(fs.existsSync(file),false);
        await tracker.onExternalFileDeleted(Uri.file(file));
        assert.equal(tracker.getTrackedChange(file)?.isDeleted,true);
        assert.equal(tracker.getOriginalContent(file),'original');
        assert.equal((await tracker.keepAllChangesInFile(file)).status,'success');
        fs.writeFileSync(file,'after accepting deletion'); notify(root,'review.txt');
        await waitUntil(() => tracker.getTrackedChange(file)?.currentContent === 'after accepting deletion');
        assert.equal(tracker.getTrackedChange(file)?.baselineExists,false);
    }));
    test('DELETED-COVERAGE scoped Recheck certifies only its missing subtree', () => fixture(async ({tracker,dir,scope}) => {
        const {root,file} = await seed(tracker,dir,scope);
        fs.rmSync(root,{recursive:true});
        const evidence = {targetKind:'subtree',reasonCode:'scope-recheck-incomplete',reason:'Synthetic operation recovery',scopeOperationRevision:scope.scopeRevision};
        tracker.setCoverageGap(root,evidence);
        const unrelated = path.join(dir,'unrelated');
        tracker.setSubtreeCoverageGap(unrelated,'directory-runtime-coverage-gap','Unrelated uncertainty');
        const result = await tracker.recheckScopeOperationCoverage([{path:root,kind:'subtree',workspaceRoot:Uri.file(dir).toString()}],scope.scopeRevision);
        assert.equal(result.status,'rechecked',JSON.stringify({result,gaps:tracker.getSubtreeCoverageGaps()}));
        assert.equal(tracker.coverageGaps.get(root)?.subtree,undefined);
        assert.ok(tracker.coverageGaps.get(unrelated)?.subtree);
        assert.equal(tracker.getOriginalContent(file),'original');
        assert.equal(tracker.getTrackedChange(file)?.isDeleted,true);
    }));

    test('DELETED-COVERAGE literal watcher requirement survives reload after successful deletion certification', () => fixture(async ({tracker,dir,scope}) => {
        const {root,file} = await seed(tracker,dir,scope);
        fs.rmSync(root,{recursive:true}); await tracker.onExternalFileDeleted(Uri.file(root));
        assert.deepEqual(tracker.getSubtreeCoverageGaps(),[]);
        const storage=tracker.storageUri;
        await tracker.dispose(); tracker=new DiffTracker(storage); setTracker(tracker);
        assert.equal(await tracker.restorePersistedState(),'restored');
        assert.equal(tracker.getIsRecording(),true);
        assert.equal(tracker.getOriginalContent(file),'original');
        assert.equal(tracker.getTrackedChange(file)?.isDeleted,true);
        assert.deepEqual(tracker.getSubtreeCoverageGaps(),[]);
        fs.mkdirSync(root); fs.writeFileSync(file,'literal reload creation'); notify(dir,'temporary');
        await waitUntil(()=>tracker.getTrackedChange(file)?.currentContent==='literal reload creation');
    }));

    for (const replacement of ['file','symlink']) test(`DELETED-COVERAGE directory to ${replacement} never certifies absence`, () => fixture(async ({tracker,dir,scope}) => {
        if (replacement === 'symlink' && process.platform === 'win32') { console.log('SKIP synthetic symlink replacement on Windows without link privileges'); return; }
        const {root,file} = await seed(tracker,dir,scope);
        const other=path.join(dir,'other');fs.mkdirSync(other);
        fs.rmSync(root,{recursive:true});
        if (replacement === 'file') { fs.writeFileSync(root,'replacement file'); }
        else { fs.symlinkSync(other,root,'dir'); }
        await tracker.onExternalFileDeleted(Uri.file(root));
        assert.ok(tracker.getSubtreeCoverageGaps().length);
        assert.equal(tracker.getOriginalContent(file),'original');
        assert.equal(currentOwner(tracker,root)?.observationDirectory,undefined);
        assert.equal(fs.lstatSync(root).isSymbolicLink(),replacement === 'symlink');
    }));
    test('DELETED-COVERAGE rename and move back preserve source baseline without transferring it', () => fixture(async ({tracker,dir,scope}) => {
        const {root,file} = await seed(tracker,dir,scope);
        const moved=path.join(dir,'moved');fs.renameSync(root,moved);
        await tracker.onExternalFileDeleted(Uri.file(root));
        assert.equal(tracker.getTrackedChange(file)?.isDeleted,true);
        assert.deepEqual(tracker.getSubtreeCoverageGaps(),[]);
        assert.equal(tracker.getOriginalContent(path.join(moved,'review.txt')),undefined);
        fs.writeFileSync(path.join(moved,'review.txt'),'moved content');fs.renameSync(moved,root);notify(dir,'temporary');
        await waitUntil(()=>tracker.getTrackedChange(file)?.currentContent==='moved content' && !tracker.getSubtreeCoverageGaps().length);
        assert.equal(tracker.getOriginalContent(file),'original');
    }));
    test('DELETED-COVERAGE missing nested workspace cannot borrow an outer reconstruction owner', () => fixture(async ({tracker,dir}) => {
        const nestedRoot=path.join(dir,'container','nested');fs.mkdirSync(nestedRoot,{recursive:true});
        fs.writeFileSync(path.join(nestedRoot,'ProbeName'),'synthetic owner identity');
        const {vscode}=h;
        const folders=vscode.workspace.workspaceFolders, getFolder=vscode.workspace.getWorkspaceFolder;
        const nested={uri:Uri.file(nestedRoot),name:'nested-owner'};
        vscode.workspace.workspaceFolders=[...folders,nested];
        vscode.workspace.getWorkspaceFolder=uri=>tracker.pathBelongsToRoot(uri.fsPath,nestedRoot)?nested:getFolder(uri);
        try {
            tracker.sessionWorkspaceRoots=tracker.getWorkspaceRoots();
            const checked=validateAndCanonicalizeScope({mode:'wholeWorkspace',includes:[],excludes:[]},tracker.currentWorkspaceRootIdentities());
            assert.equal(checked.ok,true);tracker.effectiveMonitoringScope={kind:'configured',...checked.scope};
            const root=path.join(nestedRoot,'imported');fs.mkdirSync(root);
            const file=path.join(root,'review.txt');fs.writeFileSync(file,'nested baseline');
            await tracker.onExternalFileCreated(Uri.file(root));
            assert.equal((await tracker.keepAllChangesInFile(file)).status,'success');
            fs.rmSync(path.join(dir,'container'),{recursive:true});
            await tracker.onExternalFileDeleted(Uri.file(path.join(dir,'container')));
            assert.ok(tracker.getSubtreeCoverageGaps().some(gap=>gap.targetPath===root));
            assert.equal(tracker.supplementalDirectoryWatchers.get(root)?.observationDirectory,undefined);
            assert.equal(tracker.getOriginalContent(file),'nested baseline');
            assert.equal(nativeDirectoryWatchers.some(owner=>owner.active && [dir,path.dirname(nestedRoot)].includes(String(owner.directory))),false);
        } finally {vscode.workspace.workspaceFolders=folders;vscode.workspace.getWorkspaceFolder=getFolder;}
    }));
    test('DELETED-COVERAGE replacement guards stay within the existing direct watcher budget', () => fixture(async ({tracker,dir,scope}) => {
        const {root} = await seed(tracker,dir,scope);
        tracker.maxImportedDirectoryWatchers=1;
        fs.rmSync(root,{recursive:true});await tracker.onExternalFileDeleted(Uri.file(root));
        for (let index=0;index<3;index++) {
            await tracker.onExternalFileDeleted(Uri.file(root));
            assert.equal((await tracker.recheckObservationCoverage()).status,'rechecked');
            assert.equal(tracker.activeDirectDirectoryWatcherCount(tracker.sessionEpoch),1);
            assert.equal(nativeDirectoryWatchers.filter(owner=>owner.active).length,1);
        }
    }));
    test('DELETED-COVERAGE Stop then fresh Start retains literal reconstruction scope across reload', () => fixture(async ({tracker,dir,scope}) => {
        const {root} = await seed(tracker,dir,scope);
        fs.rmSync(root,{recursive:true});await tracker.onExternalFileDeleted(Uri.file(root));
        tracker.stopRecording();assert.equal(tracker.startRecording(),true);
        await waitUntil(()=>tracker.getBaselineState()==='ready');
        const storage=tracker.storageUri;await tracker.dispose();
        tracker=new DiffTracker(storage);setTracker(tracker);
        assert.equal(await tracker.restorePersistedState(),'restored');
        assert.equal(tracker.getIsRecording(),true);
        assert.equal(tracker.supplementalDirectoryWatchers.get(root)?.observationDirectory,dir);
        assert.deepEqual(tracker.getSubtreeCoverageGaps(),[]);
    }));

    test('DELETED-COVERAGE reconstruction notification during retirement automatically reconciles once the barrier releases', () => fixture(async ({tracker,dir,scope}) => {
        const {root,file}=await seed(tracker,dir,scope);
        fs.rmSync(root,{recursive:true});
        const gate=h.pause(path.join(tracker.storageUri.fsPath,'session-state.tmp.json'),'write');
        const deleted=tracker.onExternalFileDeleted(Uri.file(root));
        try {
            await gate.entered;
            fs.mkdirSync(root);fs.writeFileSync(file,'concurrent recreation');
            const unknown=path.join(root,'unproven.txt');fs.writeFileSync(unknown,'unproven contents');
            tracker.dispatchExternalEvent(Uri.file(root),'create',tracker.sessionEpoch);
            assert.equal(tracker.missingDirectoryRetirement.dirty.size,1);
            gate.release();await deleted;
            await waitUntil(()=>tracker.getTrackedChange(file)?.currentContent==='concurrent recreation' && !tracker.getSubtreeCoverageGaps().length);
            assert.equal(tracker.getOriginalContent(file),'original');
            assert.equal(tracker.getOriginalContent(unknown),undefined);
            assert.ok(tracker.getUnknownReviewToken(unknown),'coalesced notification cannot invent child before-images');
        } finally {gate.release();await deleted;}
    }));

    test('DELETED-COVERAGE ancestor absence retires descendant health gaps under the same reconstruction guard', () => fixture(async ({tracker,dir,scope}) => {
        const {root,file}=await seed(tracker,dir,scope);
        const child=path.join(root,'previous-child');fs.mkdirSync(child);
        tracker.setSubtreeCoverageGap(child,'supplemental-watcher-runtime-gap','Earlier direct owner uncertainty');
        fs.rmSync(root,{recursive:true});await tracker.onExternalFileDeleted(Uri.file(root));
        assert.deepEqual(tracker.getSubtreeCoverageGaps(),[]);
        assert.equal(tracker.getOriginalContent(file),'original');
        assert.equal(tracker.getTrackedChange(file)?.isDeleted,true);
    }));
    test('DELETED-COVERAGE failed imported handoff still replaces its deleted bridge with reconstruction coverage', () => fixture(async ({tracker,dir}) => {
        const root=path.join(dir,'failed-import');fs.mkdirSync(root);
        const file=path.join(root,'review.txt');fs.writeFileSync(file,'new import');
        tracker.maxImportedDirectoryWatchers=1;
        await tracker.onExternalFileCreated(Uri.file(root));
        assert.ok(tracker.getSubtreeCoverageGaps().length);
        assert.equal(tracker.importedCoverageObligations.has(root),true);
        const original=tracker.getOriginalContent(file);
        fs.rmSync(root,{recursive:true});await tracker.onExternalFileDeleted(Uri.file(root));
        assert.deepEqual(tracker.getSubtreeCoverageGaps(),[]);
        assert.equal(tracker.getOriginalContent(file),original);
        assert.equal(tracker.supplementalDirectoryWatchers.get(root)?.observationDirectory,dir);
        assert.equal(tracker.activeDirectDirectoryWatcherCount(tracker.sessionEpoch),1);
    }));

    test('DELETED-COVERAGE concurrent deletion of seven independent roots retires every verified obligation', () => fixture(async ({tracker,dir,scope}) => {
        const roots=Array.from({length:7},(_,index)=>path.join(dir,`temporary-${index}`));
        for (const root of roots) {fs.mkdirSync(root);fs.writeFileSync(path.join(root,'review.txt'),'original');}
        h.setVsCodeExcludes({'files.watcherExclude':{[`{${roots.map(root=>path.basename(root)).join(',')}}/**`]:true}});
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status,'applied');
        const gate=h.pause(path.join(tracker.storageUri.fsPath,'session-state.tmp.json'),'write');
        fs.rmSync(roots[0],{recursive:true});const first=tracker.onExternalFileDeleted(Uri.file(roots[0]));
        const remaining=[];
        try {
            await gate.entered;
            for (const root of roots.slice(1)) {fs.rmSync(root,{recursive:true});remaining.push(tracker.onExternalFileDeleted(Uri.file(root)));}
            gate.release();await Promise.all([first,...remaining]);
            assert.deepEqual(tracker.getSubtreeCoverageGaps(),[]);
            assert.equal(tracker.activeDirectDirectoryWatcherCount(tracker.sessionEpoch),7);
            for (const root of roots) {
                assert.equal(tracker.getTrackedChange(path.join(root,'review.txt'))?.isDeleted,true);
                assert.equal(tracker.getOriginalContent(path.join(root,'review.txt')),'original');
            }
        } finally {gate.release();await Promise.all([first,...remaining]);}
    }));

    for(const regional of [false,true]) test(`DELETED-COVERAGE Recheck repairs a dead interior owner before any native delete notification (regional=${regional})`, () => fixture(async ({tracker,dir,scope}) => {
        const {root}=await seed(tracker,dir,scope);
        const child=path.join(root,'child');fs.mkdirSync(child);
        const file=path.join(child,'known.txt');fs.writeFileSync(file,'child baseline');
        await tracker.onExternalFileCreated(Uri.file(child));
        assert.equal((await tracker.keepAllChangesInFile(file)).status,'success');
        const old=currentOwner(tracker,child);assert.ok(old);
        fs.rmSync(child,{recursive:true});
        tracker.setCoverageGap(child,{targetKind:'subtree',reasonCode:'scope-recheck-incomplete',reason:'Synthetic operation recovery',scopeOperationRevision:scope.scopeRevision});
        const result=regional?await tracker.recheckScopeOperationCoverage([{path:child,kind:'subtree',workspaceRoot:Uri.file(dir).toString()}],scope.scopeRevision):await tracker.recheckObservationCoverage();
        assert.equal(result.status,'rechecked',JSON.stringify({result,gaps:tracker.getSubtreeCoverageGaps()}));
        assert.equal(old.epoch,-1);
        assert.equal(tracker.getTrackedChange(file)?.isDeleted,true);
        assert.equal(tracker.getOriginalContent(file),'child baseline');
        assert.deepEqual(tracker.getSubtreeCoverageGaps(),[]);
    }));

    test('DELETED-COVERAGE ancestor deletion during retirement preserves sibling deletion review', () => fixture(async ({tracker,dir,scope}) => {
        const {root,file}=await seed(tracker,dir,scope,'container/temporary');
        const container=path.dirname(root),sibling=path.join(container,'sibling.txt');
        fs.writeFileSync(sibling,'sibling baseline');await tracker.onExternalFileCreated(Uri.file(sibling));
        assert.equal((await tracker.keepAllChangesInFile(sibling)).status,'success');
        fs.rmSync(root,{recursive:true});
        const gate=h.pause(path.join(tracker.storageUri.fsPath,'session-state.tmp.json'),'write');
        const deleted=tracker.onExternalFileDeleted(Uri.file(root));
        try {
            await gate.entered;fs.rmSync(container,{recursive:true});
            tracker.dispatchExternalEvent(Uri.file(container),'delete',tracker.sessionEpoch);
            gate.release();await deleted;
            assert.equal(tracker.getTrackedChange(sibling)?.isDeleted,true);
            assert.equal(tracker.getOriginalContent(sibling),'sibling baseline');
            assert.equal(tracker.getTrackedChange(file)?.isDeleted,true);
            assert.deepEqual(tracker.getSubtreeCoverageGaps(),[]);
        } finally {gate.release();await deleted;}
    }));

    for(const retry of [false,true]) for(const kind of ['change','delete'])
    test(`DELETED-COVERAGE restore certification drains sibling ${kind} before completion (retry=${retry})`,()=>fixture(async({tracker,dir,scope})=>{
        const sibling=path.join(dir,'sibling.txt');fs.writeFileSync(sibling,'sibling baseline');
        const {root}=await seed(tracker,dir,scope);
        fs.rmSync(root,{recursive:true});
        tracker.setSubtreeCoverageGap(root,'supplemental-watcher-target-missing-gap','Prior deletion');
        assert.equal(await tracker.flushPendingPersistence(),true);
        const storage=tracker.storageUri;await tracker.dispose();
        tracker=new DiffTracker(storage);setTracker(tracker);
        if(retry)tracker.recoveryBlocked=true;
        const gate=h.pause(path.join(storage.fsPath,'session-state.tmp.json'),'write');
        const restoration=retry?tracker.retrySavedSessionRecovery():tracker.restorePersistedState();
        try {
            await gate.entered;
            assert.ok(tracker.missingDirectoryRetirement,'the real missing-directory certification owns this persistence barrier');
            if(kind==='delete')fs.unlinkSync(sibling);else fs.writeFileSync(sibling,'edited during certification');
            tracker.dispatchExternalEvent(Uri.file(sibling),kind,tracker.sessionEpoch);
            assert.equal(tracker.restoreEvents.size,1,'unrelated notification waits in the restore queue');
            gate.release();const result=await restoration;
            assert.equal(retry?result.status:result,'restored');
            const change=tracker.getTrackedChange(sibling);
            assert.ok(change,'restore must reconcile the sibling notification before returning or freezing review');
            assert.equal(change.isDeleted,kind==='delete');
            if(kind==='change')assert.equal(change.currentContent,'edited during certification');
            assert.equal(tracker.getOriginalContent(sibling),'sibling baseline');
            assert.equal(tracker.restoreEvents.size,0);
            if(retry){
                assert.equal(tracker.getIsRecording(),false);
                const saved=JSON.parse(fs.readFileSync(path.join(storage.fsPath,'session-state.json'),'utf8'));
                assert.ok(saved.stoppedReviews.some(review=>review.filePath===sibling));
            }
        } finally {gate.release();await restoration;}
    }));

    for(const retry of [false,true]) test(`P2-RESTORE-RECREATE retry=${retry}`,()=>fixture(async({tracker,dir,scope})=>{
        const {root,file}=await seed(tracker,dir,scope);
        fs.rmSync(root,{recursive:true});
        tracker.setSubtreeCoverageGap(root,'supplemental-watcher-target-missing-gap','Synthetic old missing-root record');
        assert.equal(await tracker.flushPendingPersistence(),true);
        const storage=tracker.storageUri;await tracker.dispose();
        tracker=new DiffTracker(storage);setTracker(tracker);
        if(retry)tracker.recoveryBlocked=true;
        const gate=h.pause(path.join(storage.fsPath,'session-state.tmp.json'),'write');
        const restoration=retry?tracker.retrySavedSessionRecovery():tracker.restorePersistedState();
        try{
            await gate.entered;assert.ok(tracker.missingDirectoryRetirement);
            fs.mkdirSync(root);fs.writeFileSync(file,'recreated during certification');
            const unknown=path.join(root,'unproven.txt');fs.writeFileSync(unknown,'no proven before-image');
            const parent=[...nativeDirectoryWatchers].reverse().find(owner=>owner.active&&path.resolve(String(owner.directory))===path.resolve(dir));
            assert.ok(parent);parent.listener('rename',path.basename(root));
            assert.equal(tracker.missingDirectoryRetirement.dirty.size,1);
            gate.release();const outcome=await restoration;
            assert.equal(retry?outcome.status:outcome,'restored');
            assert.equal(tracker.getOriginalContent(file),'original');
            assert.equal(tracker.getTrackedChange(file)?.currentContent,'recreated during certification',
                'delivered reconstruction must be reconciled before recovery completes');
            assert.equal(tracker.getTrackedChange(file)?.isDeleted,false);
            assert.equal(tracker.unresolvedBaselineFiles.has(unknown),true,'reconstruction does not prove child absence');
            if(retry){
                assert.equal(tracker.getIsRecording(),false);
                const saved=JSON.parse(fs.readFileSync(path.join(storage.fsPath,'session-state.json'),'utf8'));
                assert.equal(saved.stoppedReviews.find(item=>item.filePath===file)?.currentContent,'recreated during certification');
                assert.equal(saved.stoppedReviews.find(item=>item.filePath===file)?.isDeleted,false);
            }else{
                assert.equal(tracker.supplementalDirectoryWatchers.get(root)?.epoch,tracker.sessionEpoch);
                assert.equal(tracker.supplementalDirectoryWatchers.get(root)?.observationDirectory,undefined);
            }
        }finally{gate.release();await restoration;}
    }));

    for(const failure of ['quota','budget','stop','late-epoch']) test(`P2-RESTORE-RECREATE failure=${failure}`,()=>fixture(async({tracker,dir,scope})=>{
        const {root,file}=await seed(tracker,dir,scope);fs.rmSync(root,{recursive:true});
        tracker.setSubtreeCoverageGap(root,'supplemental-watcher-target-missing-gap','Synthetic historical gap');
        await tracker.flushPendingPersistence();const storage=tracker.storageUri;await tracker.dispose();
        tracker=new DiffTracker(storage);setTracker(tracker);
        const gate=h.pause(path.join(storage.fsPath,'session-state.tmp.json'),'write');
        let classification;
        const restoration=tracker.restorePersistedState();
        try{
            await gate.entered;fs.mkdirSync(root);fs.writeFileSync(file,'recreated despite interruption');
            const parent=[...nativeDirectoryWatchers].reverse().find(owner=>owner.active&&path.resolve(String(owner.directory))===path.resolve(dir));
            assert.ok(parent);parent.listener('rename',path.basename(root));
            if(failure==='late-epoch')classification=h.pause(root,'stat');
            else if(failure==='quota')tracker.maxImportedDirectoryWatchers=0;
            else if(failure==='budget')tracker.restoreDirectoryBudget={remainingEntries:0};
            else tracker.stopRecording();
            gate.release();
            if(classification){
                await classification.entered;tracker.advanceEpoch();tracker.isRecording=false;tracker.recoveryBlocked=false;
                tracker.coverageGaps.clear();classification.release();
            }
            assert.equal(await restoration,'blocked');
            assert.equal(tracker.getOriginalContent(file),'original');assert.equal(tracker.getIsRecording(),false);
            if(failure==='late-epoch'){
                assert.equal(tracker.coverageGaps.size,0,'old directory classification cannot publish into a newer epoch');
                assert.equal(tracker.restoreDirectoryAttempts.size,0);assert.equal(tracker.isRecoveryBlocked(),false);
            }else if(failure!=='stop'){
                assert.equal(tracker.isRecoveryBlocked(),true);assert.ok(tracker.getSubtreeCoverageGaps().length);
                tracker.maxImportedDirectoryWatchers=256;
                assert.equal((await tracker.retrySavedSessionRecovery()).status,'restored');
                assert.equal(tracker.getTrackedChange(file)?.currentContent,'recreated despite interruption');
                assert.equal(tracker.getOriginalContent(file),'original');
            }
        }finally{gate.release();classification?.release();await restoration;}
    }));

    for(const sameIdentity of [true,false]) test(`DELETED-COVERAGE missing target validates alternate real-root spelling by physical identity (same=${sameIdentity})`,()=>fixture(async({tracker,dir})=>{
        const missing=path.join(dir,'missing','temporary');
        const other=path.join(dir,'other');fs.mkdirSync(other);
        const alias=path.join(path.dirname(dir),'synthetic-root-spelling');
        const realpath=fs.realpathSync,stat=fs.statSync;let rootReads=0;
        fs.realpathSync=(target,...args)=>String(target)===dir && ++rootReads%2===0?alias:realpath(target,...args);
        fs.statSync=(target,...args)=>stat(String(target)===alias?(sameIdentity?dir:other):target,...args);
        try {
            const issue=tracker.validateResourceTarget(missing);
            if(sameIdentity)assert.equal(issue,undefined);
            else assert.match(issue??'',/outside the workspace/);
        } finally {fs.realpathSync=realpath;fs.statSync=stat;}
    }));

}
