import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { detectScopeExpansion, validateAndCanonicalizeScope } from '../out/monitoringScope.js';
import { detectLocalPathCaseSensitivity } from '../out/utils/pathIdentity.js';

export function registerPR11ReviewRegressions(h) {
    const { test, root, Uri, DiffTracker, file, pending, pause, waitUntil, vscode, document } = h;
    const scope = (includes = [], excludes = []) => {
        const checked = validateAndCanonicalizeScope({mode:'rules',includes,excludes}, h.getTracker().currentWorkspaceRootIdentities());
        assert.equal(checked.ok,true,JSON.stringify(checked.errors));
        return checked.scope;
    };
    const relative = p => path.relative(root,p).split(path.sep).join('/');

    test('PR11 subtree coverage failure publishes an immediate UI refresh signal',async()=>{
        const t=h.getTracker(),dir=file('visible-subtree-gap');fs.mkdirSync(dir);
        let fullRefreshes=0;
        const subscription=t.onDidTrackChanges(event=>{if(event.fullRefresh)fullRefreshes++;});
        try{
            const before=fullRefreshes;
            await t.markCreatedDirectoryUnavailable(
                dir,
                'Imported directory watch coverage is incomplete; repair watcher coverage',
                false,
                t.sessionEpoch
            );
            assert.equal(pending(dir),undefined);
            assert.ok(t.coverageGaps.get(dir)?.subtree);
            assert.ok(fullRefreshes>before,
                'a subtree coverage failure must immediately refresh visible Changes/status diagnostics');
        }finally{subscription.dispose();}
    });



    test('PR11 migration completion is invalidated when legacy source evidence changes',async()=>{
        const old=vscode.workspace.getConfiguration;
        let workspaceValue=['legacy-a/'];
        const state=new Map();
        vscode.workspace.getConfiguration=(section,resource)=>{
            const base=old(section,resource);
            return {...base,
                inspect:key=>key==='watchExclude'?{workspaceValue}:base.inspect?.(key),
                get:(key,fallback)=>key==='watchExclude'?workspaceValue:base.get(key,fallback)
            };
        };
        const controller=h.createScopeController({workspaceState:{get:key=>state.get(key),update:async(k,v)=>state.set(k,v)}});
        try{
            assert.equal(controller.getStatus().legacyMigrationComplete,false);
            await controller.markLegacyMigrationComplete();
            assert.equal(controller.getStatus().legacyMigrationComplete,true);
            workspaceValue=['legacy-b/'];
            assert.equal(controller.getStatus().legacyMigrationComplete,false,
                'a migration authorization must not survive a legacy source change on the same roots');
            assert.equal((await controller.applyPendingScope()).status,'needsMigration');
        }finally{controller.dispose();vscode.workspace.getConfiguration=old;}
    });

    test('PR11 direct structured edit cannot erase required legacy migration evidence',async()=>{
        const t=h.getTracker(),old=vscode.workspace.getConfiguration,state=new Map();
        let monitoringScope,watchInclude;
        let watchExclude=['legacy-direct/'];
        vscode.workspace.getConfiguration=(section,resource)=>{
            const base=old(section,resource);
            if(section!=='diffTracker') return base;
            return {...base,
                inspect:key=>{
                    if(key==='monitoringScope') return {workspaceValue:monitoringScope};
                    if(key==='watchInclude') return {workspaceValue:watchInclude};
                    if(key==='watchExclude') return {workspaceValue:watchExclude};
                    return base.inspect?.(key);
                },
                get:(key,fallback)=>{
                    if(key==='monitoringScope') return monitoringScope??fallback;
                    if(key==='watchInclude') return watchInclude??fallback;
                    if(key==='watchExclude') return watchExclude??fallback;
                    return base.get(key,fallback);
                },
                update:async(key,value)=>{
                    if(key==='monitoringScope') monitoringScope=value;
                    else if(key==='watchInclude') watchInclude=value;
                    else if(key==='watchExclude') watchExclude=value;
                }
            };
        };
        const controller=h.createScopeController({workspaceState:{get:key=>state.get(key),update:async(k,v)=>state.set(k,v)}});
        try{
            await t.refreshIgnoreMatchers();
            assert.ok(t.getCommittedLegacyCompatibilityPolicy().some(([,patterns])=>patterns.includes('legacy-direct/')),
                'precondition: the active legacyV3 matcher must retain resource-scoped compatibility evidence');
            assert.equal(controller.getStatus().legacyMigrationComplete,false);
            monitoringScope='rules';watchInclude=[];watchExclude=[];
            controller.reconcileRequestedScope();
            await t.refreshIgnoreMatchers();
            assert.equal(controller.getLegacyWatchRules().length,0,
                'the live legacy string list disappears after the direct structured settings edit');
            assert.equal(controller.getStatus().legacyMigrationComplete,false,
                'an empty live string list must not erase the migration gate while committed legacy evidence remains');
            assert.equal((await controller.applyPendingScope()).status,'needsMigration');
        }finally{controller.dispose();vscode.workspace.getConfiguration=old;}
    });

    test('PR11 manual migration completion saves and binds the reviewed editor target',async()=>{
        const t=h.getTracker(),old=vscode.workspace.getConfiguration,state=new Map();
        let monitoringScope,watchInclude;
        let watchExclude=['legacy-manual/'];
        const writes=[];
        vscode.workspace.getConfiguration=(section,resource)=>{
            const base=old(section,resource);
            if(section!=='diffTracker') return base;
            return {...base,
                inspect:key=>{
                    if(key==='monitoringScope') return {workspaceValue:monitoringScope};
                    if(key==='watchInclude') return {workspaceValue:watchInclude};
                    if(key==='watchExclude') return {workspaceValue:watchExclude};
                    return base.inspect?.(key);
                },
                get:(key,fallback)=>{
                    if(key==='monitoringScope') return monitoringScope??fallback;
                    if(key==='watchInclude') return watchInclude??fallback;
                    if(key==='watchExclude') return watchExclude??fallback;
                    return base.get(key,fallback);
                },
                update:async(key,value)=>{
                    writes.push([key,value]);
                    if(key==='monitoringScope') monitoringScope=value;
                    else if(key==='watchInclude') watchInclude=value;
                    else if(key==='watchExclude') watchExclude=value;
                }
            };
        };
        const controller=h.createScopeController({workspaceState:{get:key=>state.get(key),update:async(k,v)=>state.set(k,v)}});
        try{
            await t.refreshIgnoreMatchers();
            const reviewedTarget={mode:'rules',includes:[],excludes:[{scope:'all',pattern:'legacy-manual/**'}]};
            const blocked=await controller.saveRequestedScope(reviewedTarget);
            assert.equal(blocked.ok,false,'ordinary Save remains blocked until migration evidence is reviewed');
            assert.equal(writes.length,0);
            const outcome=await controller.completeLegacyMigrationUsingCurrentScope(reviewedTarget);
            assert.equal(outcome.status,'completed',JSON.stringify(outcome));
            assert.equal(monitoringScope,'rules');
            assert.deepEqual(watchInclude,[]);
            assert.deepEqual(watchExclude,reviewedTarget.excludes);
            const status=controller.getStatus();
            assert.equal(status.legacyGlobalRules.length,0);
            assert.ok(status.legacyCommittedRules.some(([,patterns])=>patterns.includes('legacy-manual/')),
                'the old effective legacy policy remains available until configured Apply succeeds');
            assert.equal(status.legacyMigrationComplete,true,
                'the saved target and migration record must be bound to the same Scope Revision');
            const record=state.get('diffTracker.monitoringScope.legacyMigration.v2');
            assert.equal(record?.targetScopeRevision,status.requested.scope?.scopeRevision);
            assert.match(record?.approvedLegacySourceFingerprint??'',/^[0-9a-f]{64}$/);
            assert.match(record?.currentLegacySourceFingerprint??'',/^[0-9a-f]{64}$/);
            assert.notEqual(record?.approvedLegacySourceFingerprint,record?.currentLegacySourceFingerprint,
                'manual migration evidence must distinguish the reviewed legacy source from the structured target state');
        }finally{controller.dispose();vscode.workspace.getConfiguration=old;}
    });

    test('PR11 reviewed manual migration never overwrites a concurrently changed Workspace legacy source',async()=>{
        const t=h.getTracker(),old=vscode.workspace.getConfiguration,state=new Map();
        let monitoringScope,watchInclude;
        let watchExclude=['legacy-reviewed/'];
        let releaseMonitoringScope;
        let enteredMonitoringScope;
        const entered=new Promise(resolve=>{enteredMonitoringScope=resolve;});
        const gate=new Promise(resolve=>{releaseMonitoringScope=resolve;});
        const writes=[];
        vscode.workspace.getConfiguration=(section,resource)=>{
            const base=old(section,resource);
            if(section!=='diffTracker') return base;
            return {...base,
                inspect:key=>{
                    if(key==='monitoringScope') return {workspaceValue:monitoringScope};
                    if(key==='watchInclude') return {workspaceValue:watchInclude};
                    if(key==='watchExclude') return {workspaceValue:watchExclude};
                    return base.inspect?.(key);
                },
                get:(key,fallback)=>{
                    if(key==='monitoringScope') return monitoringScope??fallback;
                    if(key==='watchInclude') return watchInclude??fallback;
                    if(key==='watchExclude') return watchExclude??fallback;
                    return base.get(key,fallback);
                },
                update:async(key,value)=>{
                    writes.push([key,value]);
                    if(key==='monitoringScope'){
                        enteredMonitoringScope();
                        await gate;
                        monitoringScope=value;
                    }else if(key==='watchInclude') watchInclude=value;
                    else if(key==='watchExclude') watchExclude=value;
                }
            };
        };
        const controller=h.createScopeController({workspaceState:{get:key=>state.get(key),update:async(k,v)=>state.set(k,v)}});
        try{
            await t.refreshIgnoreMatchers();
            const reviewedTarget={mode:'rules',includes:[],excludes:[{scope:'all',pattern:'legacy-reviewed/**'}]};
            const completing=controller.completeLegacyMigrationUsingCurrentScope(reviewedTarget);
            await entered;
            watchExclude=['legacy-reviewed/','added-during-save/'];
            releaseMonitoringScope();
            const outcome=await completing;
            assert.equal(outcome.status,'invalid',JSON.stringify(outcome));
            assert.deepEqual(watchExclude,['legacy-reviewed/','added-during-save/'],
                'the controller must not overwrite a Workspace legacy source that changed after review');
            assert.equal(writes.some(([key])=>key==='watchExclude'),false,
                'destructive watchExclude replacement must be skipped after source revalidation fails');
            assert.equal(state.has('diffTracker.monitoringScope.legacyMigration.v2'),false,
                'stale reviewed source must not publish migration evidence');
        }finally{
            releaseMonitoringScope?.();
            controller.dispose();vscode.workspace.getConfiguration=old;
        }
    });

    test('PR11 stopped empty legacy session persists committed compatibility policy evidence',async()=>{
        const old=vscode.workspace.getConfiguration;
        const storage=file('stopped-legacy-policy-storage');
        const legacy=['stopped-private/'];
        vscode.workspace.getConfiguration=(section,resource)=>{
            const base=old(section,resource);
            if(section!=='diffTracker') return base;
            return {...base,
                inspect:key=>key==='watchExclude'?{workspaceValue:legacy}:base.inspect?.(key),
                get:(key,fallback)=>key==='watchExclude'?legacy:base.get(key,fallback)
            };
        };
        let isolated=new DiffTracker(Uri.file(storage));
        try{
            assert.equal(isolated.getIsRecording(),false);
            assert.equal(await isolated.prepareLegacyCompatibilityPolicySnapshot(),true);
            const saved=JSON.parse(fs.readFileSync(path.join(storage,'session-state.json'),'utf8'));
            assert.ok(saved.legacyWatchExcludeByRoot.some(([,patterns])=>patterns.includes('stopped-private/')),
                'committed legacy policy must keep an otherwise empty stopped Session V4 durable');
            await isolated.dispose();
            isolated=new DiffTracker(Uri.file(storage));
            assert.equal(await isolated.restorePersistedState(),'incomplete',
                'a policy-only stopped state restores paused rather than being treated as a fresh workspace');
            assert.ok(isolated.getCommittedLegacyCompatibilityPolicy().some(([,patterns])=>patterns.includes('stopped-private/')));
        }finally{
            await isolated.dispose();
            vscode.workspace.getConfiguration=old;
        }
    });

    for(const kind of ['file','directory']) test(`PR11 pending exclusion persists deferred ${kind} evidence across reload`,async()=>{
        let t=h.getTracker();
        const storage=file(`pending-deferred-${kind}-storage`);
        t.storageUri=Uri.file(storage);
        t.startRecording();
        await waitUntil(()=>t.getBaselineState()==='ready');

        const target=file(`pending-deferred-${kind}`);
        const requested=scope([], [{scope:'all',pattern:relative(target)}]);
        t.setPendingMonitoringScope(requested);
        if(kind==='directory') fs.mkdirSync(target);
        else fs.writeFileSync(target,'created while exclusion is pending');
        await t.onExternalFileCreated(Uri.file(target));

        assert.equal(pending(target),undefined,
            'a resource deferred by the still-pending exclusion must not become an actionable file review');
        assert.equal(t.pendingScopeSuspendedPaths.has(target),true);
        assert.equal(await t.flushPendingPersistence(),true);

        const saved=JSON.parse(fs.readFileSync(path.join(storage,'session-state.json'),'utf8'));
        const savedGap=saved.coverageGaps.find(([filePath])=>filePath===target)?.[1];
        if(kind==='directory'){
            assert.equal(savedGap?.subtree?.reasonCode,'pending-scope-deferred-event',
                'directory deferral must persist typed subtree provenance');
        }else{
            assert.equal(savedGap?.file?.reasonCode,'pending-scope-deferred-event',
                'file deferral must persist file provenance');
        }

        await t.dispose();
        t=new DiffTracker(Uri.file(storage));h.setTracker(t);
        t.setPendingMonitoringScope(requested);
        assert.equal(await t.restorePersistedState(),'restored');
        assert.equal(t.pendingScopeSuspendedPaths.has(target),true,
            'reload must reconstruct the pending-scope suspended path from durable evidence');

        t.setPendingMonitoringScope(scope());
        if(kind==='directory'){
            assert.equal(pending(target),undefined,'directories remain diagnostics, never file reviews');
            assert.equal(t.coverageGaps.get(target)?.subtree?.reasonCode,'pending-scope-gap');
        }else{
            assert.equal(pending(target)?.reviewKind,'unknown',
                'withdrawing the pending exclusion after reload must surface the deferred file as unknown review');
            assert.equal(t.coverageGaps.get(target)?.file?.reasonCode,'pending-scope-gap');
        }
    });

    test('PR11 pending parent-only directory delete preserves descendant provenance across reload',async()=>{
        let t=h.getTracker();
        const storage=file('pending-directory-delete-storage');
        t.storageUri=Uri.file(storage);

        const dir=file('pending-delete-dir');
        const child=path.join(dir,'child.txt');
        const nested=path.join(dir,'sub');
        const grand=path.join(nested,'grand.txt');
        fs.mkdirSync(nested,{recursive:true});
        fs.writeFileSync(child,'child baseline');
        fs.writeFileSync(grand,'grand baseline');
        t.fileSnapshots.set(child,'child baseline');
        t.fileSnapshots.set(grand,'grand baseline');
        t.baselineExistingFiles.add(child);
        t.baselineExistingFiles.add(grand);
        t.isRecording=true;
        t.externalWatcherEnabled=true;
        t.snapshotInitialized=true;
        t.baselineBuilding=false;

        const requested=scope([], [{scope:'all',pattern:relative(dir)}]);
        t.setPendingMonitoringScope(requested);
        fs.rmSync(dir,{recursive:true,force:true});

        // Emulate a backend that reports only the parent deletion.
        await t.onExternalFileDeleted(Uri.file(dir));

        const parentGap=t.coverageGaps.get(dir);
        assert.equal(parentGap?.file,undefined,
            'a historically proven directory deletion must never become a phantom file gap');
        assert.equal(parentGap?.subtree?.reasonCode,'pending-scope-deferred-delete',
            'parent-only delete must persist subtree deletion provenance');
        for(const filePath of [child,grand]){
            assert.equal(t.coverageGaps.get(filePath)?.file?.reasonCode,'pending-scope-deferred-delete',
                'parent deletion must explicitly preserve each known baseline descendant');
            assert.equal(t.pendingScopeSuspendedPaths.has(filePath),true);
        }
        assert.equal(await t.flushPendingPersistence(),true);

        await t.dispose();
        t=new DiffTracker(Uri.file(storage));h.setTracker(t);
        t.setPendingMonitoringScope(requested);
        assert.equal(await t.restorePersistedState(),'restored');
        assert.equal(t.coverageGaps.get(dir)?.subtree?.reasonCode,'pending-scope-deferred-delete');
        for(const filePath of [child,grand]){
            assert.equal(t.pendingScopeSuspendedPaths.has(filePath),true,
                'reload must reconstruct descendant deletion provenance');
        }

        t.setPendingMonitoringScope(scope());
        assert.equal(pending(dir),undefined,'deleted directory itself must not become a file review');
        assert.equal(t.coverageGaps.get(dir)?.subtree?.reasonCode,'pending-scope-gap');
        for(const filePath of [child,grand]){
            assert.equal(pending(filePath)?.reviewKind,'unknown',
                'withdrawing the exclusion must surface each deleted baseline child for review');
            assert.equal(t.coverageGaps.get(filePath)?.file?.reasonCode,'pending-scope-gap');
        }
    });

    test('PR11 simulated mount-point root skips parent-boundary case probe',async()=>{
        const mount=file('case-mount-root');
        fs.mkdirSync(mount);
        const resolved=path.resolve(mount);
        const parent=path.dirname(resolved);
        const originalStat=fs.statSync;
        const parentStat=originalStat(parent);
        fs.statSync=(value,...args)=>{
            const stat=originalStat(value,...args);
            if(typeof value==='string'&&path.resolve(value)===resolved){
                return {...stat,dev:Number(parentStat.dev)+1};
            }
            return stat;
        };
        try{
            assert.equal(detectLocalPathCaseSensitivity(mount),undefined,
                'an empty mount-point root must fail closed instead of inheriting its parent filesystem case semantics');
        }finally{
            fs.statSync=originalStat;
        }
    });

    test('PR11 file-to-directory replacement preserves historical file evidence without destructive actions',async()=>{
        const t=h.getTracker(),p=file('file-to-directory');
        fs.writeFileSync(p,'baseline');
        t.fileSnapshots.set(p,'baseline');
        t.baselineExistingFiles.add(p);
        fs.rmSync(p);
        fs.mkdirSync(p);
        await t.readFileAndUpdate(p,Uri.file(p));
        const change=pending(p);
        assert.ok(change,'historical file evidence must remain reviewable when the path becomes a directory');
        assert.equal(change.reviewKind,'unknown');
        assert.match(change.unavailableReason??'',/directory/i);
        assert.equal(t.getReviewToken(p),undefined,'file actions must not obtain a text review token for a directory');
        const result=await t.revertFile(p);
        assert.equal(result.status,'conflict');
        assert.equal(fs.statSync(p).isDirectory(),true,'Revert must never recursively remove the replacement directory');
    });

    test('PR11 directory watcher failure remains a subtree diagnostic, not a file review',async()=>{
        const t=h.getTracker(),dir=file('coverage-only-directory');
        fs.mkdirSync(dir);
        const previousLimit=t.maxImportedDirectoryWatchers;
        t.maxImportedDirectoryWatchers=0;
        try{
            await t.onExternalFileCreated(Uri.file(dir));
            assert.equal(pending(dir),undefined,'a pure directory must never become an unknown file review');
            assert.equal(t.fileSnapshots.has(dir),false,'a pure directory must not receive a file snapshot sentinel');
            assert.ok(t.getCoverageGaps().some(([target])=>target===dir),
                'the watcher failure must remain visible as a coverage diagnostic');
        }finally{t.maxImportedDirectoryWatchers=previousLimit;}
    });

    test('PR11 symlink workspace root derives case identity only from inside the target',async()=>{
        const target=file('case-symlink-target');
        const link=file('case-symlink-root');
        fs.mkdirSync(target);
        fs.symlinkSync(target,link,process.platform==='win32'?'junction':'dir');

        assert.equal(detectLocalPathCaseSensitivity(link),undefined,
            'an empty symlink root must fail closed instead of inheriting the parent volume lookup semantics');

        const probe=path.join(target,'ProbeName');
        fs.mkdirSync(probe);
        const targetSemantics=detectLocalPathCaseSensitivity(probe);
        assert.equal(typeof targetSemantics,'boolean',
            'the target child must provide a concrete case-semantics probe on the test filesystem');
        assert.equal(detectLocalPathCaseSensitivity(link),targetSemantics,
            'a symlink root must derive case identity from descendant lookup inside its target');
    });

    test('PR11 insensitive lookup recognizes the unique actual multi-character entry spelling',async()=>{
        const parent=file('case-spelling-parent');
        fs.mkdirSync(parent);
        const actual=path.join(parent,'Foo');
        fs.mkdirSync(actual);
        const query=path.join(parent,'FOO');
        const names=fs.readdirSync(parent);
        if(!fs.existsSync(query)||names.includes('FOO')){
            console.log('SKIP PR11 multi-character insensitive spelling scenario on a case-sensitive root');
            return;
        }
        assert.equal(detectLocalPathCaseSensitivity(query),false,
            'the unique actual Foo entry must prove that FOO resolves through case-insensitive lookup');
    });

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

    test('PR11 parent-only delete reconciles retained child before ignored-parent short circuit',async()=>{
        const t=h.getTracker();
        assert.equal((await t.applyConfiguredMonitoringScope(scope())).status,'applied');

        const dir=file('retained-parent-delete');
        const child=path.join(dir,'child.txt');
        fs.mkdirSync(dir,{recursive:true});
        fs.writeFileSync(child,'changed');
        t.fileSnapshots.set(child,'baseline');
        t.baselineExistingFiles.add(child);
        await t.readFileAndUpdate(child,Uri.file(child));
        assert.equal(pending(child)?.reviewKind,'text');
        assert.equal(pending(child)?.isDeleted,false);

        const policy=file('.gitignore');
        fs.writeFileSync(policy,`${path.basename(dir)}\n`);
        h.setListedIgnores([Uri.file(policy)]);
        await t.refreshIgnoreMatchers();
        assert.equal(t.getRetainedReviewPaths().includes(child),true,
            'precondition: ordinary ignore retains the existing child review');
        assert.equal(t.isPathIgnored(Uri.file(dir)),true,
            'precondition: slashless ordinary ignore must trigger the parent-path short circuit under test');

        t.isRecording=true;
        t.externalWatcherEnabled=true;
        fs.rmSync(dir,{recursive:true,force:true});

        // Emulate a watcher backend that reports only the ignored parent delete.
        await t.onExternalFileDeleted(Uri.file(dir));

        const review=pending(child);
        assert.ok(review,'retained child review must survive parent-only delete');
        assert.equal(review.reviewKind,'text');
        assert.equal(review.isDeleted,true,
            'retained child must reconcile to deleted even though the parent path itself is ignored');
        assert.equal(review.currentExists,false);
        assert.equal(review.currentContent,'');
        assert.equal(pending(dir),undefined,'ignored directory must not become a file review');
    });

    for(const source of ['files.exclude','search.exclude','gitignore','git-exclude']) for(const kind of ['text','opaque','unknown']) test(`PR11 ordinary scope contraction ${source} retains ${kind} through reload`,async()=>{
        let t=h.getTracker(); const storage=file('retain-storage');t.storageUri=Uri.file(storage);
        assert.equal((await t.applyConfiguredMonitoringScope(scope())).status,'applied');
        const p=file('retained.txt');fs.writeFileSync(p,'changed');t.fileSnapshots.set(p,'baseline');t.baselineExistingFiles.add(p);
        if(kind==='opaque')fs.writeFileSync(p,Buffer.from([0,1,2]));
        if(kind==='unknown')t.coverageGaps.set(p,{file:{targetKind:'file',reasonCode:'test-historical-gap',reason:'historical uncertainty'}});
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

    for(const change of ['added','revised','stable','unbound','modal']) test(`PR11 final discard confirmation binds affected reviews (${change})`,async()=>{
        const t=h.getTracker(),dir=file('discard-set');fs.mkdirSync(dir);
        const p=path.join(dir,'shown.txt'),q=path.join(dir,'unshown.txt');
        assert.equal((await t.applyConfiguredMonitoringScope(scope())).status,'applied');
        const originalScope=t.getEffectiveMonitoringScope();
        fs.writeFileSync(p,'shown current');t.fileSnapshots.set(p,'shown baseline');t.baselineExistingFiles.add(p);
        t.updateTrackedDiff(p,'shown current');
        const excludes=[{scope:'all',pattern:relative(dir)+'/**'}];
        const oldConfig=vscode.workspace.getConfiguration,oldWarning=vscode.window.showWarningMessage;
        const oldInfo=vscode.window.showInformationMessage;
        vscode.workspace.getConfiguration=(section,resource)=>{
            const old=oldConfig(section,resource);
            return {...old,inspect:key=>key==='watchExclude'?{workspaceValue:excludes}:undefined};
        };
        const state=new Map();
        const controller=h.createScopeController({workspaceState:{get:key=>state.get(key),update:async(k,v)=>state.set(k,v)}});
        const mutate=()=>{
            if(change==='revised')t.updateTrackedDiff(p,'new unapproved projection');
            else{
                fs.writeFileSync(q,'unshown current');t.fileSnapshots.set(q,'unshown baseline');t.baselineExistingFiles.add(q);
                t.updateTrackedDiff(q,'unshown current');
            }
        };
        try{
            if(change==='modal'){
                let prompted=false;
                vscode.window.showInformationMessage=async()=>undefined;
                vscode.window.showWarningMessage=async(message,_options,...answers)=>{
                    if(answers.includes('Discard Reviews and Apply')){prompted=true;mutate();return 'Discard Reviews and Apply';}
                    return undefined;
                };
                await h.createScopePanel(controller).applyInteractively();
                assert.equal(prompted,true);assert.ok(pending(p));assert.ok(pending(q));
                assert.equal(t.getEffectiveMonitoringScope().scopeRevision,originalScope.scopeRevision);
                return;
            }
            const prompt=await controller.applyPendingScope();assert.equal(prompt.status,'needsDiscardConfirmation');
            assert.equal(typeof prompt.affectedReviewRevision,'string');
            if(change==='added'||change==='revised')mutate();
            const result=await controller.applyPendingScope({
                discardExplicitlyExcludedReviews:true,expectedScopeRevision:prompt.scopeRevision,
                expectedAffectedReviewRevision:change==='unbound'?undefined:prompt.affectedReviewRevision
            });
            if(change==='stable'){
                assert.equal(result.status,'applied',JSON.stringify(result));assert.equal(pending(p),undefined);
            }else{
                assert.equal(result.status,'conflict',JSON.stringify(result));assert.ok(pending(p));
                if(change==='added')assert.ok(pending(q));
                assert.equal(t.getEffectiveMonitoringScope().scopeRevision,originalScope.scopeRevision);
            }
        }finally{
            controller.dispose();vscode.workspace.getConfiguration=oldConfig;
            vscode.window.showWarningMessage=oldWarning;vscode.window.showInformationMessage=oldInfo;
        }
    });

    for(const kind of ['text','opaque','unknown']) test(`PR11 final unverified identity preserves ${kind} review through same-policy recovery and reload`,async()=>{
        let t=h.getTracker();const storage=file('identity-review-storage');t.storageUri=Uri.file(storage);
        assert.equal((await t.applyConfiguredMonitoringScope(scope())).status,'applied');
        const p=file('identity-review.txt');fs.writeFileSync(p,kind==='opaque'?Buffer.from([0,1,2]):'current');
        t.fileSnapshots.set(p,'baseline');t.baselineExistingFiles.add(p);
        if(kind==='unknown')t.coverageGaps.set(p,{file:{targetKind:'file',reasonCode:'test-prior-gap',reason:'prior coverage uncertainty'}});
        await t.readFileAndUpdate(p,Uri.file(p));assert.equal(pending(p)?.reviewKind,kind);
        await t.refreshIgnoreMatchers();const fingerprint=t.getPolicyFingerprint();
        const identify=t.workspaceRootIdentityForFolder;
        t.workspaceRootIdentityForFolder=folder=>({...identify.call(t,folder),caseSensitive:undefined});
        await t.refreshIgnoreMatchers();
        assert.ok(pending(p),'unverified identity must not erase pending review');
        assert.equal(pending(p).reviewKind,'unknown');assert.ok(t.getRetainedReviewPaths().includes(p));
        assert.equal(t.getReviewToken(p),undefined);
        await t.flushPendingPersistence();await t.dispose();
        t=new DiffTracker(Uri.file(storage));h.setTracker(t);
        const restoredIdentify=t.workspaceRootIdentityForFolder;
        t.workspaceRootIdentityForFolder=folder=>({...restoredIdentify.call(t,folder),caseSensitive:undefined});
        const read=vscode.workspace.fs.readFile;let unsafeReads=0;
        vscode.workspace.fs.readFile=async uri=>{if(uri.fsPath===p)unsafeReads++;return read(uri);};
        try{
            assert.equal(await t.restorePersistedState(),'restored');
            assert.ok(pending(p));assert.equal(pending(p).reviewKind,'unknown');assert.equal(unsafeReads,0);
            t.workspaceRootIdentityForFolder=restoredIdentify;
            await t.refreshIgnoreMatchers();assert.equal(t.getPolicyFingerprint(),fingerprint);
            assert.ok(pending(p));assert.equal(pending(p).reviewKind,kind);
            assert.equal(t.getOriginalContent(p),'baseline');
        }finally{vscode.workspace.fs.readFile=read;}
    });

    test('PR11 migrated Save keeps committed Workspace legacy protection until configured Apply',async()=>{
        const t=h.getTracker(),old=vscode.workspace.getConfiguration,state=new Map();
        let monitoringScope;
        let watchInclude;
        const legacyDir=file('legacy-private');
        let workspaceValue=[path.basename(legacyDir)+'/'];
        const protectedPath=path.join(legacyDir,'secret.txt');
        const storage=file('legacy-save-gap-storage');
        t.storageUri=Uri.file(storage);
        fs.mkdirSync(legacyDir,{recursive:true});
        fs.writeFileSync(protectedPath,'protected');
        vscode.workspace.getConfiguration=(section,resource)=>{
            const base=old(section,resource);
            if(section!=='diffTracker') return base;
            return {...base,
                inspect:key=>{
                    if(key==='monitoringScope') return {workspaceValue:monitoringScope};
                    if(key==='watchInclude') return {workspaceValue:watchInclude};
                    if(key==='watchExclude') return {workspaceValue};
                    return base.inspect?.(key);
                },
                get:(key,fallback)=>{
                    if(key==='monitoringScope') return monitoringScope??fallback;
                    if(key==='watchInclude') return watchInclude??fallback;
                    if(key==='watchExclude') return workspaceValue??fallback;
                    return base.get(key,fallback);
                },
                update:async(key,value)=>{
                    if(key==='monitoringScope') monitoringScope=value;
                    else if(key==='watchInclude') watchInclude=value;
                    else if(key==='watchExclude') workspaceValue=value;
                }
            };
        };
        const controller=h.createScopeController({workspaceState:{get:key=>state.get(key),update:async(k,v)=>state.set(k,v)}});
        try{
            await t.refreshIgnoreMatchers();
            assert.equal(t.testIgnorePath(protectedPath).ignored,true,'legacy Workspace rule is initially effective');
            assert.equal((await controller.completeLegacyMigrationUsingCurrentScope()).status,'completed');
            const saved=await controller.saveRequestedScope({mode:'rules',includes:[],excludes:[]});
            assert.equal(saved.ok,true,JSON.stringify(saved.errors));
            assert.equal(controller.getStatus().legacyGlobalRules.length,0,
                'the live Workspace setting is now structured, so compatibility must rely on committed legacy policy evidence');
            await t.refreshIgnoreMatchers();
            assert.equal(t.getEffectiveMonitoringScope().kind,'legacyV3','Save must not publish configured scope');
            assert.equal(t.testIgnorePath(protectedPath).ignored,true,
                'committed legacy Workspace protection must survive Save until configured scope is atomically applied');
            assert.deepEqual(
                t.committedLegacyWatchExcludeByRoot.get(vscode.workspace.workspaceFolders[0].uri.toString()),
                [path.basename(legacyDir)+'/'],
                'the committed snapshot must retain the pre-Save resource-scoped legacy rules'
            );

            assert.equal(await t.flushPendingPersistence(),true);
            const savedState=JSON.parse(fs.readFileSync(path.join(storage,'session-state.json'),'utf8'));
            assert.ok(savedState.legacyWatchExcludeByRoot.some(([rootUri,patterns])=>
                rootUri===vscode.workspace.workspaceFolders[0].uri.toString() &&
                patterns.includes(path.basename(legacyDir)+'/')),
                'the committed legacy policy must survive a crash/restart between Save and Apply');

            await t.dispose();
            const restored=new DiffTracker(Uri.file(storage));h.setTracker(restored);
            assert.equal(await restored.restorePersistedState(),'restored');
            assert.equal(restored.getEffectiveMonitoringScope().kind,'legacyV3');
            assert.equal(restored.testIgnorePath(protectedPath).ignored,true,
                'reloaded legacyV3 matcher must use persisted committed policy while settings are structured');

            const configured=scope();
            assert.equal((await restored.applyConfiguredMonitoringScope(configured)).status,'applied');
            assert.equal(restored.committedLegacyWatchExcludeByRoot.size,0,
                'successful configured publication releases the committed legacy policy snapshot');
        }finally{controller.dispose();vscode.workspace.getConfiguration=old;}
    });

    test('PR11 Save preserves active legacy Workspace strings until migration completes',async()=>{
        const t=h.getTracker(),old=vscode.workspace.getConfiguration,writes=[],state=new Map();
        const legacy=['legacy-private/'];
        vscode.workspace.getConfiguration=(section,resource)=>{
            const base=old(section,resource);
            return {...base,
                inspect:key=>key==='watchExclude'?{workspaceValue:legacy}:undefined,
                get:(key,fallback)=>key==='watchExclude'?legacy:base.get(key,fallback),
                update:async(...args)=>writes.push(args)
            };
        };
        const controller=h.createScopeController({workspaceState:{get:key=>state.get(key),update:async(k,v)=>state.set(k,v)}});
        try{
            assert.equal(t.getEffectiveMonitoringScope().kind,'legacyV3');
            const result=await controller.saveRequestedScope({
                mode:'rules',includes:[],excludes:[{scope:'all',pattern:'new-private/**'}]
            });
            assert.equal(result.ok,false);assert.match(result.errors.map(e=>e.message).join(' '),/legacy.*migration/i);
            assert.equal(writes.length,0,'Save must not shadow active Workspace legacy strings before migration');
        }finally{controller.dispose();vscode.workspace.getConfiguration=old;}
    });

    for(const source of ['external','document']) test(`PR11 scope apply drains pre-existing ${source} debounce before exclusion publication`,async()=>{
        const t=h.getTracker(),p=file(`deferred-${source}.txt`);
        fs.writeFileSync(p,'baseline');t.fileSnapshots.set(p,'baseline');t.baselineExistingFiles.add(p);
        if(source==='external'){
            fs.writeFileSync(p,'changed');await t.onExternalFileChanged(Uri.file(p));
            assert.equal(t.externalChangeTimers.has(p),true);
        }else{
            const doc=document(p);doc.text='changed';doc.isDirty=true;doc.version++;
            t.onDocumentChanged({document:doc,contentChanges:[{text:'changed'}]});
            assert.equal(t.documentChangeTimers.has(p),true);
        }
        const requested=scope([], [{scope:'all',pattern:relative(p)}]);
        const result=await t.applyConfiguredMonitoringScope(requested);
        assert.equal(result.status,'applied',JSON.stringify(result));
        assert.ok(pending(p),'event observed under the old scope must remain reviewable');
        assert.ok(t.getRetainedReviewPaths().includes(p));
        assert.equal(result.retainedReviews,1);
    });

    test('PR11 event arriving during scope transaction aborts publication and replays under committed scope',async()=>{
        const t=h.getTracker(),p=file('transaction-event.txt'),storage=file('transaction-event-storage');
        t.storageUri=Uri.file(storage);fs.writeFileSync(p,'baseline');
        t.fileSnapshots.set(p,'baseline');t.baselineExistingFiles.add(p);
        await t.flushPendingPersistence();
        const requested=scope([], [{scope:'all',pattern:relative(p)}]);
        const gate=pause(path.join(storage,'session-state.tmp.json'),'write');
        const applying=t.applyConfiguredMonitoringScope(requested);await gate.entered;
        fs.writeFileSync(p,'changed during apply');await t.onExternalFileChanged(Uri.file(p));
        gate.release();const result=await applying;
        assert.notEqual(result.status,'applied',JSON.stringify(result));
        await waitUntil(()=>!!pending(p));
        assert.notEqual(t.getEffectiveMonitoringScope().scopeRevision,requested.scopeRevision);
        assert.equal(t.getOriginalContent(p),'baseline');
    });


    test('PR11 failed compensating scope persistence enters recovery-blocked state',async()=>{
        const storage=file('scope-rollback-persist-storage');
        const isolated=new DiffTracker(Uri.file(storage));
        const makeScope=(includes=[],excludes=[])=>{
            const checked=validateAndCanonicalizeScope(
                {mode:'rules',includes,excludes},
                isolated.currentWorkspaceRootIdentities()
            );
            assert.equal(checked.ok,true,JSON.stringify(checked.errors));
            return checked.scope;
        };
        const target=file('scope-rollback-persist.txt');
        fs.writeFileSync(target,'baseline');
        isolated.startRecording();
        await waitUntil(()=>isolated.getBaselineState()==='ready');
        const initial=makeScope();
        assert.equal((await isolated.applyConfiguredMonitoringScope(initial)).status,'applied');

        const candidate=makeScope([{scope:'all',path:relative(target)}]);
        const originalFlushPersist=isolated.flushPersistState.bind(isolated);
        const originalFlushPending=isolated.flushPendingPersistence.bind(isolated);
        let candidatePersisted=false;
        isolated.flushPersistState=async(...args)=>{
            const ok=await originalFlushPersist(...args);
            if(args[1]&&ok){
                candidatePersisted=true;
                isolated.workspaceContextChanged=true;
            }
            return ok;
        };
        isolated.flushPendingPersistence=async()=>false;
        try{
            const result=await isolated.applyConfiguredMonitoringScope(candidate);
            assert.equal(candidatePersisted,true,'precondition: candidate state reached durable storage before context invalidation');
            assert.equal(result.status,'failed',JSON.stringify(result));
            assert.equal(isolated.recoveryBlocked,true,
                'failed compensating persistence must block recovery-sensitive actions in the current session');
            assert.equal(isolated.getIsRecording(),false,
                'recording must pause when durable storage may still contain a rejected candidate');
            assert.match(isolated.persistenceIssue??'',/rollback|recovery|persist/i);
            const saved=JSON.parse(fs.readFileSync(path.join(storage,'session-state.json'),'utf8'));
            assert.equal(saved.effectiveMonitoringScope.scopeRevision,candidate.scopeRevision,
                'fixture proves disk can still contain the rejected candidate when compensation is unwritable');

            const restarted=new DiffTracker(Uri.file(storage));
            try{
                assert.equal(await restarted.restorePersistedState(),'blocked',
                    'restart must reject an uncommitted candidate even when primary and backup contain valid V4 JSON');
                assert.notEqual(restarted.getEffectiveMonitoringScope().scopeRevision,candidate.scopeRevision,
                    'a rejected candidate must never become effective after restart');
            }finally{
                await restarted.dispose();
            }
        }finally{
            isolated.flushPersistState=originalFlushPersist;
            isolated.flushPendingPersistence=originalFlushPending;
            await isolated.dispose();
        }
    });

    test('PR11 multi-root folder includes collectively cover an all-roots include',async()=>{
        const roots=[
            {name:'a',uri:'file:///multi-a',caseSensitive:true},
            {name:'b',uri:'file:///multi-b',caseSensitive:true}
        ];
        const canonical=request=>{
            const checked=validateAndCanonicalizeScope(request,roots);
            assert.equal(checked.ok,true,JSON.stringify(checked.errors));
            return checked.scope;
        };
        const effective=canonical({
            mode:'rules',
            includes:[
                {scope:'folder',folder:'a',path:'src'},
                {scope:'folder',folder:'b',path:'src'}
            ],
            excludes:[]
        });
        const requested=canonical({
            mode:'rules',
            includes:[{scope:'all',path:'src'}],
            excludes:[]
        });
        const expansion=detectScopeExpansion(effective,requested);
        assert.equal(expansion.expands,false,JSON.stringify(expansion.reasons));
    });

    test('PR11 multi-root folder exclusions collectively preserve an all-roots exclusion',async()=>{
        const roots=[
            {name:'a',uri:'file:///multi-a',caseSensitive:true},
            {name:'b',uri:'file:///multi-b',caseSensitive:true}
        ];
        const canonical=request=>{
            const checked=validateAndCanonicalizeScope(request,roots);
            assert.equal(checked.ok,true,JSON.stringify(checked.errors));
            return checked.scope;
        };
        const effective=canonical({
            mode:'rules',
            includes:[],
            excludes:[{scope:'all',pattern:'private/**'}]
        });
        const requested=canonical({
            mode:'rules',
            includes:[],
            excludes:[
                {scope:'folder',folder:'a',pattern:'private/**'},
                {scope:'folder',folder:'b',pattern:'private/**'}
            ]
        });
        const expansion=detectScopeExpansion(effective,requested);
        assert.equal(expansion.expands,false,JSON.stringify(expansion.reasons));
    });

    test('PR11 scope rollback restores committed legacy matcher even when matcher rebuild fails',async()=>{
        const t=h.getTracker(),protectedPath=file('legacy-protected.txt');
        const oldConfig=vscode.workspace.getConfiguration;
        vscode.workspace.getConfiguration=(section,resource)=>{
            const base=oldConfig(section,resource);
            if(section!=='diffTracker') return base;
            return {...base,get:(key,fallback)=>key==='watchExclude'
                ? [path.basename(protectedPath)] : base.get(key,fallback)};
        };
        const originalRefresh=t.refreshIgnoreMatchers.bind(t);
        const originalCapture=t.captureConfiguredIncludeBaselines.bind(t);
        try{
            await originalRefresh();
            assert.equal(t.getEffectiveMonitoringScope().kind,'legacyV3');
            assert.equal(t.testIgnorePath(protectedPath).ignored,true,
                'precondition: committed legacy matcher must protect the path');
            let refreshCalls=0;
            t.refreshIgnoreMatchers=async(...args)=>{
                refreshCalls++;
                if(refreshCalls===2) throw new Error('simulated rollback matcher rebuild failure');
                return originalRefresh(...args);
            };
            t.captureConfiguredIncludeBaselines=async()=>{throw new Error('simulated candidate preparation failure');};
            const result=await t.applyConfiguredMonitoringScope(scope());
            assert.equal(result.status,'failed',JSON.stringify(result));
            assert.equal(t.getEffectiveMonitoringScope().kind,'legacyV3');
            assert.equal(t.testIgnorePath(protectedPath).ignored,true,
                'failed scope apply must atomically restore the committed legacy matcher');
        }finally{
            t.refreshIgnoreMatchers=originalRefresh;
            t.captureConfiguredIncludeBaselines=originalCapture;
            vscode.workspace.getConfiguration=oldConfig;
        }
    });

}
