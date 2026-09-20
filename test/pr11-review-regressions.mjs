import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateAndCanonicalizeScope } from '../out/monitoringScope.js';

export function registerPR11ReviewRegressions(h) {
    const { test, root, Uri, DiffTracker, file, pending, pause, waitUntil, vscode } = h;
    const scope = (includes = [], excludes = []) => {
        const checked = validateAndCanonicalizeScope({mode:'rules',includes,excludes}, h.getTracker().currentWorkspaceRootIdentities());
        assert.equal(checked.ok,true,JSON.stringify(checked.errors));
        return checked.scope;
    };
    const relative = p => path.relative(root,p).split(path.sep).join('/');

    for(const phase of ['read','write']) for(const committedAffected of [false,true]) {
        test(`PR11 candidate coverage callback ${phase} (committedAffected=${committedAffected})`,async()=>{
            const t=h.getTracker(), old=file('committed.txt'), fresh=file('candidate.txt');
            t.startRecording();await waitUntil(()=>t.getBaselineState()==='ready');
            fs.writeFileSync(old,'old baseline');fs.writeFileSync(fresh,'candidate baseline');
            const storage=file('coverage-storage'); t.storageUri=Uri.file(storage);
            const initial=scope([{scope:'all',path:relative(old)}]);
            assert.equal((await t.applyConfiguredMonitoringScope(initial)).status,'applied');
            await t.flushPendingPersistence();
            const beforeEpoch=t.sessionEpoch;
            const beforeWatchers=[...t.fileWatchers];
            const beforeFlags=[t.getIsRecording(),t.snapshotInitialized,t.baselineBuilding,t.externalWatcherEnabled];
            const candidate=scope([...initial.includes,{scope:'all',path:relative(fresh)}]);
            const gate=pause(phase==='read'?fresh:path.join(storage,'session-state.tmp.json'),phase);
            const op=t.applyConfiguredMonitoringScope(candidate); await gate.entered;
            const publicRevision=t.getEffectiveMonitoringScope().scopeRevision;
            h.setVsCodeExcludes({'files.watcherExclude':{
                [`**/${path.basename(committedAffected?old:fresh)}`]:true
            }});
            h.fireConfigurationChanged('files.watcherExclude');
            gate.release(); const result=await op;
            assert.notEqual(result.status,'applied');
            assert.equal(publicRevision,initial.scopeRevision,'candidate must not leak through public effective scope');
            assert.equal(t.getEffectiveMonitoringScope().scopeRevision,initial.scopeRevision);
            assert.equal(t.getOriginalContent(fresh),undefined);
            if(committedAffected){
                assert.equal(t.getIsRecording(),false); assert.equal(t.baselineBuilding,true);
            }else{
                assert.deepEqual([t.getIsRecording(),t.snapshotInitialized,t.baselineBuilding,t.externalWatcherEnabled],beforeFlags);
                assert.equal(t.sessionEpoch,beforeEpoch);assert.deepEqual(t.fileWatchers,beforeWatchers);
                assert.ok(beforeWatchers.every(watcher=>watcher.active));
            }
        });
    }

    for(const priorBaseline of [false,true]) test(`PR11 stopped apply defers new include baseline (prior=${priorBaseline})`,async()=>{
        let t=h.getTracker(); const storage=file('stopped-storage');
        await t.dispose();t=new DiffTracker(Uri.file(storage));h.setTracker(t);
        if(priorBaseline){
            const p=file('prior.txt');fs.writeFileSync(p,'pending');
            t.fileSnapshots.set(p,'prior');t.baselineExistingFiles.add(p);t.snapshotInitialized=true;
        }
        const dir=file('stopped-include');fs.mkdirSync(dir);const target=path.join(dir,'new.txt');fs.writeFileSync(target,'not yet recorded');
        let reads=0;const original=vscode.workspace.fs.readFile;
        vscode.workspace.fs.readFile=async uri=>{if(uri.fsPath===target)reads++;return original(uri);};
        try{
            const result=await t.applyConfiguredMonitoringScope(scope([{scope:'all',path:relative(dir)}]));
            assert.equal(result.status,'applied',JSON.stringify(result));assert.equal(result.capturedBaselines,0);
            assert.equal(reads,0);assert.equal(t.getOriginalContent(target),undefined);
            assert.equal(t.getIsRecording(),false);
            assert.equal(t.baselineBuilding,false);assert.equal(t.scanCoverage,undefined);
            await t.flushPendingPersistence();await t.dispose();
            t=new DiffTracker(Uri.file(storage));h.setTracker(t);
            assert.equal(await t.restorePersistedState(),priorBaseline?'restored':'absent');
            assert.equal(t.getOriginalContent(target),undefined);
            assert.equal(pending(target),undefined);
            if(!priorBaseline) assert.equal((await t.applyConfiguredMonitoringScope(scope([{scope:'all',path:relative(dir)}]))).status,'applied');
            h.setListedFiles([Uri.file(target)]);t.startRecording();
            await waitUntil(()=>t.getBaselineState()==='ready');
            assert.equal(t.getOriginalContent(target),'not yet recorded');
        } finally {vscode.workspace.fs.readFile=original;}
    });

    for(const source of ['files.exclude','search.exclude','gitignore','git-exclude']) for(const kind of ['text','opaque','unknown']) test(`PR11 ordinary scope contraction ${source} retains ${kind} through reload`,async()=>{
        let t=h.getTracker(); const storage=file('retain-storage');t.storageUri=Uri.file(storage);
        assert.equal((await t.applyConfiguredMonitoringScope(scope())).status,'applied');
        const p=file('retained.txt');fs.writeFileSync(p,'changed');t.fileSnapshots.set(p,'baseline');t.baselineExistingFiles.add(p);
        if(kind==='opaque')fs.writeFileSync(p,Buffer.from([0,1,2]));
        if(kind==='unknown')t.coverageGaps.set(p,'historical uncertainty');
        await t.readFileAndUpdate(p,Uri.file(p));assert.equal(pending(p)?.reviewKind,kind);
        let policy;
        if(source==='gitignore'){
            policy=file('.gitignore');fs.writeFileSync(policy,path.basename(p)+'\n');h.setListedIgnores([Uri.file(policy)]);
        }else if(source==='git-exclude'){
            policy=path.join(root,'.git','info','exclude');fs.mkdirSync(path.dirname(policy),{recursive:true});fs.writeFileSync(policy,path.basename(p)+'\n');
        }else h.setVsCodeExcludes({[source]:{[`**/${path.basename(p)}`]:true}});
        await t.refreshIgnoreMatchers();
        assert.ok(pending(p),'ordinary policy must not acknowledge pending review');assert.ok(t.getRetainedReviewPaths().includes(p));
        await t.flushPendingPersistence();await t.dispose();t=new DiffTracker(Uri.file(storage));h.setTracker(t);
        assert.equal(await t.restorePersistedState(),'restored');assert.equal(pending(p)?.reviewKind,kind);
        assert.ok(t.getRetainedReviewPaths().includes(p));
        h.setVsCodeExcludes({});h.setListedIgnores([]);if(policy)fs.rmSync(policy);await t.refreshIgnoreMatchers();
        assert.equal(t.getRetainedReviewPaths().includes(p),false,'rule withdrawal returns review to normal scope');
        if(kind==='text'){
            assert.equal((await t.keepAllChangesInFile(p)).status,'success');
            assert.equal(t.getOriginalContent(p),'changed','ordinary baseline must not be released after retained status ends');
        }
    });

    for(const folderOverride of [false,true]) test(`PR11 V3 restore preserves resource legacy precedence (folder=${folderOverride})`,async()=>{
        const oldConfig=vscode.workspace.getConfiguration;let t=h.getTracker();
        const storage=file('legacy-storage');t.storageUri=Uri.file(storage);
        const globalFile=file('global.txt'),workspaceFile=file('workspace.txt'),folderFile=file('folder.txt');
        for(const p of [globalFile,workspaceFile,folderFile])fs.writeFileSync(p,'hidden baseline');
        const globalValue=[path.basename(globalFile)], workspaceValue=[path.basename(workspaceFile)], folderValue=[path.basename(folderFile)];
        const base=file('known.txt');fs.writeFileSync(base,'baseline');t.fileSnapshots.set(base,'baseline');t.baselineExistingFiles.add(base);
        await t.flushPendingPersistence();let state=JSON.parse(fs.readFileSync(path.join(storage,'session-state.json'),'utf8'));
        state.version=3;delete state.effectiveMonitoringScope;delete state.retainedReviewPaths;delete state.coverageGaps;
        await t.dispose();fs.writeFileSync(path.join(storage,'session-state.json'),JSON.stringify(state));
        vscode.workspace.getConfiguration=(section,resource)=>{
            const old=oldConfig(section,resource);
            return {...old,
                inspect:key=>key==='watchExclude'?{globalValue,workspaceValue,workspaceFolderValue:resource&&folderOverride?folderValue:undefined}:undefined,
                get:(key,fallback)=>key==='watchExclude'?(resource&&folderOverride?folderValue:workspaceValue):old.get(key,fallback)
            };
        };
        try{
            h.setListedFiles([globalFile,workspaceFile,folderFile,base].map(Uri.file));
            t=new DiffTracker(Uri.file(storage));h.setTracker(t);
            assert.equal(await t.restorePersistedState(),'restored');
            const hidden=folderOverride?folderFile:workspaceFile;
            assert.equal(t.testIgnorePath(hidden).ignored,true);
            assert.equal(t.getOriginalContent(hidden),undefined);assert.equal(pending(hidden),undefined);
            assert.equal(t.testIgnorePath(globalFile).ignored,false,'higher-scope array overrides rather than unions Global');
        }finally{vscode.workspace.getConfiguration=oldConfig;}
    });

    test('PR11 legacy mixed configuration rejects discovery rather than dropping strings',async()=>{
        const old=vscode.workspace.getConfiguration;
        vscode.workspace.getConfiguration=(...args)=>{const config=old(...args);return {...config,get:(key,fallback)=>key==='watchExclude'?['private/',{scope:'all',pattern:'other/'}]:config.get(key,fallback)};};
        try{await assert.rejects(h.getTracker().refreshIgnoreMatchers(),/legacy|watchExclude/i);}
        finally{vscode.workspace.getConfiguration=old;}
    });

    test('PR11 canonical spelling comes from directory entries, not realpath input casing',async()=>{
        const t=h.getTracker(),dir=file('SpellingDir');fs.mkdirSync(dir);
        const actual=path.join(dir,'MixedName.txt');fs.writeFileSync(actual,'baseline');
        const alias=path.join(root,path.basename(dir).toUpperCase(),'mixedname.TXT');
        const identify=t.workspaceRootIdentityForFolder,validate=t.validateResourceTarget;
        const realpath=fs.realpathSync.native;
        // Emulate a case-insensitive resource boundary on every test platform.
        // Windows realpath can preserve the requested spelling; it is not a
        // directory-entry-casing oracle. The production resolver must enumerate.
        t.workspaceRootIdentityForFolder=folder=>({...identify.call(t,folder),caseSensitive:false});
        t.validateResourceTarget=()=>undefined;
        fs.realpathSync.native=value=>value;
        try{
            assert.equal(t.canonicalTrackingPath(alias),actual);
            assert.equal(t.canonicalTrackingPath(actual),actual);
        }finally{
            t.workspaceRootIdentityForFolder=identify;t.validateResourceTarget=validate;
            fs.realpathSync.native=realpath;
        }
    });

    test('PR11 case-insensitive directory include captures descendants with actual spelling',async()=>{
        const t=h.getTracker();
        if(t.currentWorkspaceRootIdentities()[0].caseSensitive!==false) {console.log('SKIP PR11 case-insensitive directory scenario on a case-sensitive root');return;}
        const dir=file('MixedDirectory');fs.mkdirSync(dir);
        const actual=path.join(dir,'MixedChild.txt');fs.writeFileSync(actual,'directory baseline');
        const aliasDir=path.join(root,path.basename(dir).toUpperCase());
        const result=await t.applyConfiguredMonitoringScope(scope([{scope:'all',path:relative(aliasDir)}]));
        assert.equal(result.status,'applied',JSON.stringify(result));
        assert.equal(t.getOriginalContent(actual),'directory baseline');
        fs.writeFileSync(actual,'directory edit');await t.onExternalFileChanged(Uri.file(actual));
        await waitUntil(()=>t.getTrackedChanges().length===1);
        assert.equal(t.getTrackedChanges()[0].reviewKind,'text');
        assert.ok(t.getReviewToken(path.join(aliasDir,'mixedchild.TXT')));
    });

    test('PR11 case-insensitive explicit file uses one identity for capture lookup actions and restore',async()=>{
        let t=h.getTracker();
        if(t.currentWorkspaceRootIdentities()[0].caseSensitive!==false) {console.log('SKIP PR11 Windows case-insensitive filesystem scenario on a case-sensitive root');return;}
        const dir=file('CaseDir');fs.mkdirSync(dir);const actual=path.join(dir,'MixedName.txt');fs.writeFileSync(actual,'baseline');
        const alias=path.join(dir.toUpperCase(),'mixedname.TXT');const storage=file('case-storage');t.storageUri=Uri.file(storage);
        assert.equal((await t.applyConfiguredMonitoringScope(scope([{scope:'all',path:relative(alias)}]))).status,'applied');
        assert.equal(t.getOriginalContent(actual),'baseline');assert.equal(t.getOriginalContent(alias),'baseline');
        fs.writeFileSync(actual,'changed');await t.readFileAndUpdate(actual,Uri.file(actual));
        assert.equal(t.getTrackedChanges().length,1);assert.equal(t.getTrackedChanges()[0].reviewKind,'text');
        const token=t.getReviewToken(alias);assert.ok(token);
        assert.equal((await t.keepAllChangesInFile(alias,token)).status,'success');
        assert.equal(t.getOriginalContent(actual),'changed');assert.equal(t.getTrackedChanges().length,0);
        await t.flushPendingPersistence();await t.dispose();t=new DiffTracker(Uri.file(storage));h.setTracker(t);
        assert.equal(await t.restorePersistedState(),'restored');
        fs.writeFileSync(actual,'changed again');await t.readFileAndUpdate(alias,Uri.file(alias));
        assert.equal(t.getTrackedChanges().length,1);assert.equal(t.getTrackedChanges()[0].reviewKind,'text');
        assert.equal(t.getOriginalContent(alias),'changed');
    });

    test('PR11 controller recognizes Workspace and Folder legacy strings without treating them as malformed structured rules',async()=>{
        const old=vscode.workspace.getConfiguration;
        const workspaceValue=['workspace-private/'],workspaceFolderValue=['folder-private/'];
        const writes=[]; const state=new Map();
        vscode.workspace.getConfiguration=(section,resource)=>({
            ...old(section,resource),
            inspect:key=>key==='watchExclude'?{workspaceValue,workspaceFolderValue:resource?workspaceFolderValue:undefined}:undefined,
            get:(key,fallback)=>key==='watchExclude'?(resource?workspaceFolderValue:workspaceValue):old(section,resource).get(key,fallback),
            update:async(...args)=>writes.push(args)
        });
        const controller=h.createScopeController({workspaceState:{get:key=>state.get(key),update:async(k,v)=>state.set(k,v)}});
        try{
            const status=controller.getStatus();assert.equal(status.requested.ok,true);
            assert.equal(status.workspaceRequestPresent,false);assert.equal(status.legacyMigrationComplete,false);
            assert.deepEqual(new Set(controller.getLegacyWatchRules()),new Set([...workspaceValue,...workspaceFolderValue]));
            assert.equal((await controller.applyPendingScope()).status,'needsMigration');
            assert.equal((await controller.migrateLegacyWatchRules()).status,'manual');
            await controller.restoreEffectiveScopeConfiguration();
            assert.equal(writes.some(([key])=>key==='watchExclude'),false,'restoring legacy compatibility must not delete legacy Workspace rules');
        } finally {controller.dispose();vscode.workspace.getConfiguration=old;}
    });

    for(const transition of ['stop','workspace','dispose']) test(`PR11 candidate rollback preserves concurrent ${transition}`,async()=>{
        const t=h.getTracker(),p=file('concurrent.txt');fs.writeFileSync(p,'candidate');
        const initial=scope();assert.equal((await t.applyConfiguredMonitoringScope(initial)).status,'applied');
        const gate=pause(p,'read'),op=t.applyConfiguredMonitoringScope(scope([{scope:'all',path:relative(p)}]));await gate.entered;
        let disposing;
        if(transition==='dispose') disposing=t.dispose();
        else {t.stopRecording();if(transition==='workspace')t.workspaceContextChanged=true;}
        gate.release();assert.notEqual((await op).status,'applied');
        if(disposing){await disposing;assert.equal(t.disposed,true);assert.equal(t.fileWatchers.length,0);}
        else assert.equal(t.getIsRecording(),false);
        assert.equal(t.getEffectiveMonitoringScope().scopeRevision,initial.scopeRevision);
        assert.equal(t.getOriginalContent(p),undefined);
        if(transition==='workspace') assert.equal(t.workspaceContextChanged,true);
    });
}
