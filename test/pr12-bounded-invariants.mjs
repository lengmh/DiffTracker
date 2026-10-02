import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { evaluateConfiguredScope, validateAndCanonicalizeScope } from '../out/monitoringScope.js';
import { withLookups } from './pr11-final-scope-regressions.mjs';
import { detectLocalPathCaseSensitivity, resolveRelativePathIdentity } from '../out/utils/pathIdentity.js';

export function registerPR12BoundedInvariants(h) {
    const {
        test, vscode, Uri, DiffTracker, file, document, getTracker, setTracker,
        setVsCodeExcludes, fireConfigurationChanged
    } = h;
    function scopeFor(tracker, mode='wholeWorkspace', excludes=[]) {
        const scope={kind:'configured',mode,roots:tracker.currentWorkspaceRootIdentities(),includes:[],excludes,scopeRevision:''};
        scope.scopeRevision=createHash('sha256').update(JSON.stringify({model:1,mode,roots:scope.roots,includes:[],excludes})).digest('hex');
        return scope;
    }
    async function fixture(run, mode='wholeWorkspace', excludes=[]) {
        const previousFolders=vscode.workspace.workspaceFolders;
        const previousGet=vscode.workspace.getWorkspaceFolder;
        const dir=file('pr12-audit'); fs.mkdirSync(dir,{recursive:true});
        fs.writeFileSync(path.join(dir,'ProbeName'),'probe');
        const folder={uri:Uri.file(dir),name:'pr12-audit'};
        try {
            await getTracker().dispose();
            vscode.workspace.workspaceFolders=[folder];
            vscode.workspace.getWorkspaceFolder=uri=>{
                const relative=path.relative(dir,uri.fsPath);
                return relative===''||relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative)?folder:undefined;
            };
            const tracker=new DiffTracker(Uri.file(file('pr12-audit-storage'))); setTracker(tracker);
            tracker.isRecording=true;tracker.externalWatcherEnabled=true;tracker.snapshotInitialized=true;
            const scope=scopeFor(tracker,mode,excludes); tracker.effectiveMonitoringScope=scope;
            await run({tracker,scope,dir,folder});
        } finally {
            await getTracker().dispose();
            vscode.workspace.workspaceFolders=previousFolders;
            vscode.workspace.getWorkspaceFolder=previousGet;
        }
    }
    const serialized=tracker=>Buffer.byteLength(JSON.stringify(tracker.buildPersistedState()),'utf8');
    const unresolvedPlan=reason=>({kind:'unresolved',reason});

    test('PR12 AUDIT universal exclusion skips all policy discovery in preflight and refresh',()=>fixture(async({tracker,scope,dir})=>{
        const oldFind=vscode.workspace.findFiles, oldOpen=fs.promises.opendir;
        let searches=0, opens=0;
        vscode.workspace.findFiles=async()=>{searches++;throw Error('unbounded policy search');};
        fs.promises.opendir=async(...args)=>{if(path.resolve(String(args[0]))===dir)opens++;return oldOpen(...args);};
        try {
            const result=await tracker.preflightConfiguredMonitoringScope(scope,()=>true);
            assert.equal(result.status,'ready',JSON.stringify(result));assert.equal(result.inspectedEntries,0);
            await tracker.refreshIgnoreMatchers();
            assert.equal(searches,0);assert.equal(opens,0);
        } finally {vscode.workspace.findFiles=oldFind;fs.promises.opendir=oldOpen;}
    },'wholeWorkspace',[{scope:'all',pattern:'**'}]));

    test('PR12 AUDIT excluded policy subtree is pruned before directory search or content read',()=>fixture(async({tracker,scope,dir})=>{
        const excluded=path.join(dir,'excluded');fs.mkdirSync(excluded);
        fs.writeFileSync(path.join(excluded,'.gitignore'),'private/\n');
        const oldFind=vscode.workspace.findFiles,oldOpen=fs.promises.opendir;
        let searches=0, excludedOpens=0;
        vscode.workspace.findFiles=async()=>{searches++;throw Error('unbounded policy search');};
        fs.promises.opendir=async(...args)=>{if(path.resolve(String(args[0]))===excluded){excludedOpens++;throw Error('excluded directory opened');}return oldOpen(...args);};
        try {
            const result=await tracker.preflightConfiguredMonitoringScope(scope,()=>true);
            assert.equal(result.status,'ready',JSON.stringify(result));assert.equal(result.unreadableDirectoryCount,0);
            await tracker.refreshIgnoreMatchers();assert.equal(searches,0);assert.equal(excludedOpens,0);
        } finally {vscode.workspace.findFiles=oldFind;fs.promises.opendir=oldOpen;}
    },'rules',[{scope:'all',pattern:'excluded/**'}]));

    test('PR12 AUDIT policy discovery consumes the preflight entry budget without findFiles',()=>fixture(async({tracker,scope,dir})=>{
        for(let i=0;i<8;i++){const child=path.join(dir,`tree-${i}`);fs.mkdirSync(child);fs.writeFileSync(path.join(child,'.gitignore'),'x/\n');}
        tracker.maxScopePreflightEntries=3;
        const oldFind=vscode.workspace.findFiles;let searches=0;
        vscode.workspace.findFiles=async()=>{searches++;return [];};
        try {
            const result=await tracker.preflightConfiguredMonitoringScope(scope,()=>true);
            assert.equal(result.truncated,true,JSON.stringify(result));assert.ok(result.inspectedEntries<=3);
            assert.equal(searches,0,'configured metadata discovery must not materialize global search results');
            await assert.rejects(()=>tracker.refreshIgnoreMatchers(),/preparation.*budget|discovery.*limit/i);
        } finally {vscode.workspace.findFiles=oldFind;}
    },'rules'));

    test('PR12 AUDIT policy content has a cumulative byte bound before matcher publication',()=>fixture(async({tracker,scope,dir})=>{
        const target=path.join(dir,'.gitignore');fs.writeFileSync(target,'x'.repeat(512));
        h.setListedIgnores([Uri.file(target)]);tracker.maxPersistedBytes=128;
        const before=tracker.ignoreMatchers;
        try {
            const result=await tracker.preflightConfiguredMonitoringScope(scope,()=>true);
            assert.equal(result.status,'failed',JSON.stringify(result));assert.match(result.reason??'',/byte/i);
            assert.equal(tracker.ignoreMatchers,before);
        } finally {h.setListedIgnores([]);}
    },'rules'));

    test('PR12 AUDIT Start uses bounded configured policy discovery rather than a search fallback',()=>fixture(async({tracker,scope,dir})=>{
        fs.writeFileSync(path.join(dir,'candidate.txt'),'baseline');
        const oldFind=vscode.workspace.findFiles;let searches=0;
        vscode.workspace.findFiles=async()=>{searches++;throw Error('unexpected policy search during Start');};
        try {
            tracker.snapshotInitialized=false;tracker.baselineBuilding=true;
            await tracker.initializeWorkspaceSnapshots();
            assert.equal(tracker.getBaselineState(),'ready');assert.equal(searches,0);
            assert.equal(tracker.getOriginalContent(path.join(dir,'candidate.txt')),'baseline');
        } finally {vscode.workspace.findFiles=oldFind;}
    }));

    test('PR12 AUDIT late unresolved entry receives a full charge instead of replacement credit',()=>fixture(async({tracker,dir})=>{
        const p=path.join(dir,'late.txt');fs.writeFileSync(p,'late');
        const budget=tracker.createCandidatePersistenceBudget();const before=budget.remainingBytes;
        tracker.recordUnresolvedBaseline(p,'late watcher evidence');
        tracker.recordScannedBaseline(p,{kind:'unavailable',reason:'late watcher evidence'},'workspace',budget);
        assert.equal(budget.unresolvedBaselineFiles,tracker.unresolvedBaselineFiles.size);
        assert.ok(budget.remainingBytes<before,'late evidence was not present in the budget seed');
        assert.equal(budget.remainingBytes,tracker.maxPersistedBytes-serialized(tracker));
    }));

    test('PR12 AUDIT late off-candidate unresolved evidence is also charged before retention',()=>fixture(async({tracker,dir})=>{
        const p=path.join(dir,'candidate.txt'),q=path.join(dir,'late-other.txt');
        const budget=tracker.createCandidatePersistenceBudget();
        tracker.recordUnresolvedBaseline(q,'event for another path');
        tracker.recordScannedBaseline(p,{kind:'text',content:'candidate'},'workspace',budget);
        assert.equal(budget.unresolvedBaselineFiles,1);
        assert.equal(budget.remainingBytes,tracker.maxPersistedBytes-serialized(tracker));
    }));

    test('PR12 AUDIT late unresolved capacity overflow seals the budget before another baseline is retained',()=>fixture(async({tracker,dir})=>{
        tracker.maxPersistedSnapshots=1;
        const p=path.join(dir,'seed.txt'),q=path.join(dir,'late.txt'),r=path.join(dir,'candidate.txt');
        tracker.unresolvedBaselineFiles.set(p,'seed');
        const budget=tracker.createCandidatePersistenceBudget();tracker.recordUnresolvedBaseline(q,'late');
        assert.throws(()=>tracker.recordScannedBaseline(r,{kind:'text',content:'must not be retained'},'workspace',budget),/unresolved.*capacity/i);
        assert.equal(tracker.fileSnapshots.has(r),false);
        assert.ok(budget.failedReason);
    }));

    test('PR12 AUDIT replacement credit uses the accounted reason rather than a mutated live reason',()=>fixture(async({tracker,dir})=>{
        const p=path.join(dir,'changing-reason.txt');tracker.unresolvedBaselineFiles.set(p,'a');
        const budget=tracker.createCandidatePersistenceBudget();
        const expanded='late evidence '.repeat(30);tracker.unresolvedBaselineFiles.set(p,expanded);
        tracker.recordScannedBaseline(p,{kind:'unavailable',reason:expanded},'workspace',budget);
        assert.equal(budget.unresolvedBaselineFiles,1);
        assert.equal(budget.remainingBytes,tracker.maxPersistedBytes-serialized(tracker));
    }));

    test('PR12 AUDIT reserved restore additions are not mistaken for deleted live entries',()=>fixture(async({tracker,dir})=>{
        const budget=tracker.createCandidatePersistenceBudget();
        tracker.consumeCandidatePersistenceBudget(path.join(dir,'one.txt'),unresolvedPlan('one'),budget);
        tracker.consumeCandidatePersistenceBudget(path.join(dir,'two.txt'),unresolvedPlan('two'),budget);
        assert.equal(budget.unresolvedBaselineFiles,2);assert.equal(tracker.unresolvedBaselineFiles.size,0);
    }));

    for(const reason of ['Binary content is unsupported','UTF-8 BOM files require encoding preservation and are read-only in this version','Unsupported text encoding (expected UTF-8)','File exceeds the 5 MiB limit']) {
        test(`PR12 AUDIT dirty unsupported plan matches actual unresolved publication: ${reason}`,()=>fixture(async({tracker,dir})=>{
            const p=path.join(dir,'dirty.dat'),other=path.join(dir,'other.bin');fs.writeFileSync(p,Buffer.from([0,1,2]));
            document(p).isDirty=true;tracker.unresolvedBaselineFiles.set(p,'Unsaved editor changes require review');
            tracker.maxPersistedSnapshots=1;
            tracker.opaqueBaselineFiles.set(other,{reason:'Binary content is unsupported',size:3,mtime:1,fingerprint:'a'.repeat(64)});
            const state={kind:'unavailable',reason,size:3,mtime:1,fingerprint:'b'.repeat(64)};
            const plan=tracker.planScannedBaseline(p,state,'workspace');
            assert.equal(plan.kind,'unresolved');
            const budget=tracker.createCandidatePersistenceBudget();
            tracker.recordScannedBaseline(p,state,'workspace',budget);
            assert.equal(tracker.opaqueBaselineFiles.has(p),false);assert.equal(budget.opaqueBaselineFiles,1);
            assert.equal(budget.unresolvedBaselineFiles,1);
            assert.equal(budget.remainingBytes,tracker.maxPersistedBytes-serialized(tracker));
        }));
    }

    test('PR12 AUDIT ignored post-read candidate cannot consume budget in the shared publication boundary',()=>fixture(async({tracker,dir})=>{
        const p=path.join(dir,'excluded.txt');
        const budget=tracker.createCandidatePersistenceBudget();const before=budget.remainingBytes;
        tracker.pendingMonitoringScope=scopeFor(tracker,'wholeWorkspace',[{scope:'all',pattern:'excluded.txt'}]);
        tracker.recordScannedBaseline(p,{kind:'text',content:'x'.repeat(2000)},'repository',budget);
        assert.equal(budget.remainingBytes,before);assert.equal(tracker.fileSnapshots.has(p),false);
    }));

    test('PR12 AUDIT worker failure drains in-flight work before rollback can begin',async()=>{
        const tracker=getTracker();let release;const gate=new Promise(resolve=>{release=resolve;});
        let settled=false,lateCompleted=false;
        const operation=tracker.runWithConcurrency([0,1,2],2,async index=>{
            if(index===0){await Promise.resolve();throw Error('first failure');}
            if(index===1){await gate;lateCompleted=true;}
            else assert.fail('no new worker may start after failure');
        });
        const observed=operation.then(()=>{settled=true;},()=>{settled=true;});
        try {
            await new Promise(resolve=>setTimeout(resolve,15));
            assert.equal(settled,false,'rollback must not observe failure while a sibling can still publish');
        } finally {release();await observed;}
        await assert.rejects(operation,/first failure/);assert.equal(lateCompleted,true);
    });
    test('PR12 AUDIT matcher refresh cannot recursively persist restore candidates inside an active transaction',()=>fixture(async({tracker,dir})=>{
        const policy=path.join(dir,'.gitignore');fs.writeFileSync(policy,'first.txt\n');h.setListedIgnores([Uri.file(policy)]);
        let transaction;const original=tracker.discoverRestoredFiles.bind(tracker);let discoveries=0;
        try {
            await tracker.refreshIgnoreMatchers();
            transaction=tracker.beginBaselineTransaction(()=>{});
            tracker.discoverRestoredFiles=async()=>{discoveries++;throw Error('restore discovery must not persist within the enclosing scope transaction');};
            fs.writeFileSync(policy,'second.txt\n');
            await tracker.refreshIgnoreMatchers();
            assert.equal(discoveries,0);
        } finally {
            if(transaction)tracker.endBaselineTransaction(transaction,false);
            tracker.discoverRestoredFiles=original;h.setListedIgnores([]);
        }
    }));

    test('PR12 AUDIT path identity discovery probes only a bounded prefix of a large root',async()=>{
        const dir=file('identity-bounded');fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'ProbeName'),'probe');
        const oldOpen=fs.opendirSync,oldRead=fs.readdirSync;
        let reads=0,listings=0,closed=false;
        fs.opendirSync=(target,...args)=>path.resolve(String(target))===dir?{
            readSync(){
                reads++;
                if(reads===1)return {name:'ProbeName',isSymbolicLink:()=>false};
                return reads<=10001?{name:`entry-${reads}`,isSymbolicLink:()=>false}:null;
            },
            closeSync(){closed=true;}
        }:oldOpen(target,...args);
        fs.readdirSync=(target,...args)=>{if(path.resolve(String(target))===dir)listings++;return oldRead(target,...args);};
        try {
            assert.equal(typeof detectLocalPathCaseSensitivity(dir),'boolean',
                'a real entry in the bounded prefix must establish case semantics without reading the complete large root');
            assert.equal(listings,0);assert.ok(reads<=128);assert.equal(closed,true);
        } finally {fs.opendirSync=oldOpen;fs.readdirSync=oldRead;}
    });


    test('PR12 AUDIT runtime path identity streams entries beyond the cache bound',async()=>{
        const dir=file('identity-runtime-large');fs.mkdirSync(dir);
        const target=path.join(dir,'late-entry.txt');fs.writeFileSync(target,'tracked');
        const originalOpen=fs.opendirSync;
        let opens=0,totalReads=0;
        fs.opendirSync=(value,...args)=>{
            if(path.resolve(String(value))!==path.resolve(dir)) return originalOpen(value,...args);
            opens++;
            let index=0;
            return {
                readSync(){
                    index++;totalReads++;
                    if(index<=10000) return {name:`synthetic-${index}.txt`};
                    if(index===10001) return {name:'late-entry.txt'};
                    return null;
                },
                closeSync(){}
            };
        };
        try {
            const first=resolveRelativePathIdentity(dir,'late-entry.txt',false);
            assert.equal(first.unavailable,false,
                'an existing path after the cache prefix must not become identityUnknown on a fallback-requiring root');
            assert.equal(first.identity,'late-entry.txt');
            assert.equal(first.verifiedPrefixLength,1);
            const readsAfterFirst=totalReads;
            const second=resolveRelativePathIdentity(dir,'late-entry.txt',false);
            assert.equal(second.unavailable,false);
            assert.equal(second.identity,'late-entry.txt');
            assert.equal(opens,3,
                'first lookup may build the bounded prefix plus fallback; second must reuse the prefix and open only one fallback scan');
            assert.ok(totalReads-readsAfterFirst<=10002,
                'cached incomplete prefix must prevent rereading the first 10k entries on every lookup');
        } finally {fs.opendirSync=originalOpen;}
    });


    test('PR12 AUDIT no-op matcher refresh does not invalidate bounded preflight',()=>fixture(async({tracker,scope})=>{
        await tracker.refreshIgnoreMatchers();
        const beforeFingerprint=tracker.ignoreFingerprint;
        const originalBuild=tracker.buildIgnoreMatcher.bind(tracker);
        let injected=false;
        tracker.buildIgnoreMatcher=async(...args)=>{
            const matcher=await originalBuild(...args);
            if(!injected){
                injected=true;
                await tracker.refreshIgnoreMatchers();
            }
            return matcher;
        };
        try {
            const result=await tracker.preflightConfiguredMonitoringScope(scope);
            assert.equal(result.status,'ready',JSON.stringify(result));
            assert.equal(tracker.ignoreFingerprint,beforeFingerprint,
                'injected refresh is intentionally policy-equivalent');
        } finally {
            tracker.buildIgnoreMatcher=originalBuild;
        }
    },'rules'));

    test('PR12 AUDIT broader Rules include is routed through bounded expansion preparation',()=>fixture(async({tracker,scope,dir})=>{
        const included=path.join(dir,'broad-include');
        fs.mkdirSync(included);
        fs.writeFileSync(path.join(included,'child.txt'),'baseline');

        const requested=scopeFor(tracker,'rules',[]);
        requested.includes=[{scope:'all',path:'broad-include'}];
        requested.scopeRevision=createHash('sha256').update(JSON.stringify({
            model:1,
            mode:requested.mode,
            roots:requested.roots,
            includes:requested.includes,
            excludes:requested.excludes
        })).digest('hex');

        assert.equal(scope.includes.length,0,'fixture starts from a narrower Rules scope');
        tracker.maxScopePreflightEntries=0;

        const result=await tracker.applyConfiguredMonitoringScope(requested);
        assert.equal(result.status,'failed',
            'broader include must fail under the zero bounded-preparation budget instead of using legacy unbounded capture');
        assert.match(result.reason??'',/preparation|budget|capacity|entries/i);
        assert.equal(tracker.getEffectiveMonitoringScope().scopeRevision,scope.scopeRevision,
            'failed bounded preparation must preserve the previously committed scope');
        assert.equal(tracker.fileSnapshots.has(path.join(included,'child.txt')),false,
            'rejected broad include must not retain candidate baselines');
    },'rules'));

    // Exercise public Apply across source-scope transitions. Helper-only tests
    // cannot establish that every acquisition route actually consumes a budget.
    function includeScope(tracker, mode, includes, excludes=[]) {
        const checked=validateAndCanonicalizeScope({mode,
            includes:includes.map(value=>typeof value==='string'?{scope:'all',path:value}:value),excludes
        },tracker.currentWorkspaceRootIdentities());
        assert.equal(checked.ok,true,JSON.stringify(checked.errors));
        return {kind:'configured',...checked.scope};
    }
    async function sourceScope(tracker, scope, legacy) {
        if(legacy) {
            tracker.effectiveMonitoringScope=tracker.createLegacyEffectiveScopeForRoots(tracker.getWorkspaceRoots());
        } else { tracker.effectiveMonitoringScope=scope; }
        await tracker.refreshIgnoreMatchers();
        assert.equal(await tracker.flushPendingPersistence(),true);
        return JSON.parse(JSON.stringify(tracker.getEffectiveMonitoringScope()));
    }

    for(const source of ['legacy','configured-repeat','configured-expansion']) {
        test(`PR12 MIGRATION ${source} cannot bypass the include traversal budget`,()=>fixture(async({tracker,dir})=>{
            const target=path.join(dir,'included');fs.mkdirSync(target);
            fs.writeFileSync(path.join(target,'child.txt'),'baseline');
            const requested=includeScope(tracker,'rules',['included']);
            const before=await sourceScope(tracker,source==='configured-repeat'?requested:scopeFor(tracker,'rules'),source==='legacy');
            tracker.maxScopePreflightEntries=0;
            const originalPreflight=tracker.preflightConfiguredMonitoringScope.bind(tracker);
            let preflights=0;
            tracker.preflightConfiguredMonitoringScope=async(...args)=>{preflights++;return originalPreflight(...args);};
            const originalRead=tracker.readCurrentFileState.bind(tracker);
            let reads=0;
            tracker.readCurrentFileState=async target=>{reads++;return originalRead(target);};
            try {
                const outcome=await tracker.applyConfiguredMonitoringScope(requested);
                assert.equal(preflights,source==='configured-repeat'?0:1,'migration and expansion must reach bounded preflight');
                assert.notEqual(outcome.status,'applied','every include acquisition must be bounded, regardless of source kind');
                assert.match(outcome.reason??'',/budget|preparation|capacity/i);
                assert.equal(reads,0,'work rejection must happen before content acquisition');
                assert.deepEqual(tracker.getEffectiveMonitoringScope(),before);
                assert.equal(tracker.fileSnapshots.has(path.join(target,'child.txt')),false);
            } finally {tracker.readCurrentFileState=originalRead;tracker.preflightConfiguredMonitoringScope=originalPreflight;}
        },'rules'));
    }

    test('PR12 MIGRATION initial Rules cannot accept unrelated files or certify a full scan',()=>fixture(async({tracker,dir})=>{
        fs.writeFileSync(path.join(dir,'ordinary.txt'),'current');
        await sourceScope(tracker,undefined,true);
        const outcome=await tracker.applyConfiguredMonitoringScope(scopeFor(tracker,'rules'));
        assert.equal(outcome.status,'applied',JSON.stringify(outcome));
        assert.equal(tracker.getOriginalContent(path.join(dir,'ordinary.txt')),undefined,
            'Rules migration must not silently accept unrelated post-scan creations');
        assert.equal(tracker.scanCoverage,undefined,
            'include-only migration cannot certify full workspace absence provenance');
    },'rules'));

    for(const legacy of [true,false]) {
        test(`PR12 MIGRATION include byte failure aborts later reads and rolls back (legacy=${legacy})`,()=>fixture(async({tracker,dir})=>{
            const imported=path.join(dir,'bytes');fs.mkdirSync(imported);
            const children=['a.txt','b.txt','c.txt'].map(name=>path.join(imported,name));
            for(const child of children)fs.writeFileSync(child,'x'.repeat(4096));
            const requested=includeScope(tracker,'rules',['bytes']);
            const before=await sourceScope(tracker,requested,legacy);
            tracker.maxPersistedBytes=serialized(tracker)+2048;
            const original=tracker.readCurrentFileState.bind(tracker);let candidateReads=0;
            tracker.readCurrentFileState=async target=>{
                if(children.includes(target))candidateReads++;
                return original(target);
            };
            try {
                const outcome=await tracker.applyConfiguredMonitoringScope(requested);
                assert.notEqual(outcome.status,'applied');
                assert.equal(candidateReads,1,'sealed byte budget must stop before the next include read');
                assert.deepEqual(tracker.getEffectiveMonitoringScope(),before);
                assert.ok(children.every(child=>!tracker.fileSnapshots.has(child)));
                const saved=JSON.parse(fs.readFileSync(path.join(tracker.storageUri.fsPath,'session-state.json'),'utf8'));
                assert.deepEqual(saved.effectiveMonitoringScope,before,'durable scope must roll back too');
            } finally {tracker.readCurrentFileState=original;}
        },'rules'));
    }

    for(const mode of ['rules']) {
        test(`PR12 MIGRATION missing explicit targets preserve known absence (${mode})`,()=>fixture(async({tracker,dir})=>{
            await sourceScope(tracker,undefined,true);
            const target=path.join(dir,'missing.txt');
            const outcome=await tracker.applyConfiguredMonitoringScope(includeScope(tracker,mode,['missing.txt']));
            assert.equal(outcome.status,'applied',JSON.stringify(outcome));
            assert.equal(tracker.getOriginalContent(target),'','missing explicit target must retain its absence sentinel');
            assert.equal(tracker.baselineExistingFiles.has(tracker.canonicalTrackingPath(target)),false);
            assert.equal(tracker.unresolvedBaselineFiles.has(tracker.canonicalTrackingPath(target)),false);
        },'rules'));
    }

    test('PR12 MIGRATION missing targets obey text capacity even with spare opaque capacity',()=>fixture(async({tracker,dir})=>{
        await sourceScope(tracker,undefined,true);
        tracker.maxPersistedSnapshots=1;
        const before=tracker.getEffectiveMonitoringScope();
        const requested=includeScope(tracker,'rules',['one.txt','two.txt'],[{scope:'all',pattern:'ProbeName'}]);
        const outcome=await tracker.applyConfiguredMonitoringScope(requested);
        assert.notEqual(outcome.status,'applied');
        assert.deepEqual(tracker.getEffectiveMonitoringScope(),before);
        assert.equal(tracker.fileSnapshots.size,0,'partial absent-sentinel capture must roll back');
    },'rules'));

    test('PR12 MIGRATION excluded missing includes are not captured or charged',()=>fixture(async({tracker,dir})=>{
        const requested=includeScope(tracker,'rules',['missing.txt'],[{scope:'all',pattern:'missing.txt'}]);
        await sourceScope(tracker,requested,false);
        tracker.maxPersistedSnapshots=0;
        const outcome=await tracker.applyConfiguredMonitoringScope(requested);
        assert.equal(outcome.status,'applied',JSON.stringify(outcome));
        assert.equal(tracker.getOriginalContent(path.join(dir,'missing.txt')),undefined);
    },'rules'));

    test('PR12 MIGRATION include cancellation stops later reads while preserving prior review',()=>fixture(async({tracker,dir})=>{
        const target=path.join(dir,'race');fs.mkdirSync(target);
        const children=['a.txt','b.txt'].map(name=>path.join(target,name));
        for(const child of children)fs.writeFileSync(child,'candidate');
        const before=await sourceScope(tracker,undefined,true);
        const original=tracker.readCurrentFileState.bind(tracker);let candidateReads=0;
        tracker.readCurrentFileState=async target=>{
            const state=await original(target);
            if(children.includes(target)){
                candidateReads++;
                tracker.recordBaselineTransactionEvent(Uri.file(target),'change');
            }
            return state;
        };
        try {
            const outcome=await tracker.applyConfiguredMonitoringScope(includeScope(tracker,'rules',['race']));
            assert.notEqual(outcome.status,'applied');
            assert.equal(candidateReads,1,'invalidated migration must not read the next candidate');
            assert.deepEqual(tracker.getEffectiveMonitoringScope(),before);
            assert.ok(children.every(child=>!tracker.fileSnapshots.has(child)));
        } finally {tracker.readCurrentFileState=original;}
    },'rules'));

    test('PR12 MIGRATION stopped Apply performs no candidate content acquisition',()=>fixture(async({tracker,dir})=>{
        const target=path.join(dir,'stopped');fs.mkdirSync(target);fs.writeFileSync(path.join(target,'a.txt'),'current');
        await sourceScope(tracker,undefined,true);
        tracker.isRecording=false;tracker.externalWatcherEnabled=false;
        const original=tracker.readCurrentFileState.bind(tracker);let reads=0;
        tracker.readCurrentFileState=async()=>{reads++;throw Error('stopped content capture');};
        try {
            const outcome=await tracker.applyConfiguredMonitoringScope(includeScope(tracker,'rules',['stopped','missing.txt']));
            assert.equal(outcome.status,'applied',JSON.stringify(outcome));
            assert.equal(reads,0);assert.equal(tracker.fileSnapshots.size,0);
        } finally {tracker.readCurrentFileState=original;}
    },'rules'));

    test('PR12 MIGRATION overlapping repeat includes share one directory traversal',()=>fixture(async({tracker,dir})=>{
        const parent=path.join(dir,'overlap'),nested=path.join(parent,'nested');fs.mkdirSync(nested,{recursive:true});
        const files=[path.join(parent,'a.txt'),path.join(nested,'b.txt')];for(const file of files)fs.writeFileSync(file,'baseline');
        const requested=includeScope(tracker,'rules',['overlap','overlap/nested']);await sourceScope(tracker,requested,false);
        const originalEnumerate=tracker.enumerateConfiguredCandidateFiles.bind(tracker),originalOpen=fs.promises.opendir;
        let enumerating=false;const opens=[];
        tracker.enumerateConfiguredCandidateFiles=async(...args)=>{enumerating=true;try{return await originalEnumerate(...args);}finally{enumerating=false;}};
        fs.promises.opendir=async(target,...args)=>{if(enumerating)opens.push(path.resolve(String(target)));return originalOpen(target,...args);};
        try {
            const outcome=await tracker.applyConfiguredMonitoringScope(requested);
            assert.equal(outcome.status,'applied',JSON.stringify(outcome));
            assert.equal(opens.filter(value=>value===nested).length,1,'overlapping includes must not charge or rescan descendants twice');
            for(const file of files)assert.equal(tracker.getOriginalContent(file),'baseline');
        } finally {tracker.enumerateConfiguredCandidateFiles=originalEnumerate;fs.promises.opendir=originalOpen;}
    },'rules'));

    test('PR12 MIGRATION absent includes reserve bytes before any baseline retention',()=>fixture(async({tracker,dir})=>{
        const requested=includeScope(tracker,'rules',['missing.txt']);await sourceScope(tracker,requested,false);
        const original=tracker.createCandidatePersistenceBudget.bind(tracker);let budgets=0;
        tracker.createCandidatePersistenceBudget=(...args)=>{budgets++;return {...original(...args),remainingBytes:0};};
        try {
            const result=await tracker.applyConfiguredMonitoringScope(requested);
            assert.notEqual(result.status,'applied','absence is durable text metadata, not free capacity');
            assert.equal(budgets,1,'even no-expansion Rules Apply must create the acquisition budget');
            assert.equal(tracker.getOriginalContent(path.join(dir,'missing.txt')),undefined);
        } finally {tracker.createCandidatePersistenceBudget=original;}
    },'rules'));

    test('PR12 MIGRATION repeated Rules include classifies unknown Dirents through bounded discovery',()=>fixture(async({tracker,dir})=>{
        const included=path.join(dir,'unknown'),nested=path.join(included,'nested');fs.mkdirSync(nested,{recursive:true});
        const child=path.join(nested,'child.txt');fs.writeFileSync(child,'included');
        const requested=includeScope(tracker,'rules',['unknown']);await sourceScope(tracker,requested,false);
        const originalOpen=fs.promises.opendir,originalRead=fs.promises.readdir;
        fs.promises.readdir=async()=>{throw Error('unbounded include readdir');};
        fs.promises.opendir=async(...args)=>{
            const handle=await originalOpen(...args);
            const read=handle.readSync.bind(handle);
            handle.readSync=()=>{
                const entry=read();
                if(!entry)return null;
                return {name:entry.name,isFile:()=>false,isDirectory:()=>false,isSymbolicLink:()=>false};
            };
            return handle;
        };
        try {
            const outcome=await tracker.applyConfiguredMonitoringScope(requested);
            assert.equal(outcome.status,'applied',JSON.stringify(outcome));
            assert.equal(tracker.getOriginalContent(child),'included');
        } finally {fs.promises.opendir=originalOpen;fs.promises.readdir=originalRead;}
    },'rules'));

    test('PR12 AUDIT Whole Workspace Start budgets open-document baselines before retention',()=>fixture(async({tracker,dir})=>{
        const first=path.join(dir,'open-first.txt'),second=path.join(dir,'open-second.txt');
        fs.writeFileSync(first,'a'.repeat(800));fs.writeFileSync(second,'b'.repeat(800));
        document(first);document(second);
        tracker.snapshotInitialized=false;tracker.baselineBuilding=true;
        tracker.initialIgnoreEpoch=tracker.sessionEpoch;
        await tracker.refreshIgnoreMatchers();
        const projected=tracker.ignoreFingerprint;
        const state=tracker.buildPersistedState();
        state.scanCoverage=projected;
        const baseBytes=Buffer.byteLength(JSON.stringify(state),'utf8');
        tracker.maxPersistedBytes=baseBytes+1500;

        await assert.rejects(
            ()=>tracker.initializeWorkspaceSnapshots(),
            /persisted byte capacity|exceed.*bytes/i
        );
        assert.ok(tracker.fileSnapshots.size<2,
            'open documents must stop being retained as soon as the durable byte budget is exhausted');
        assert.equal(tracker.unresolvedBaselineFiles.has(second),false,
            'a persistence-budget exception must escape editor capture instead of being converted into unreadable baseline evidence');
        assert.equal(tracker.getTrackedChanges().some(change=>change.filePath===second),false,
            'budget failure must not manufacture a review for the rejected editor baseline');
        assert.ok(serialized(tracker)<=tracker.maxPersistedBytes,
            'failed startup document capture must never retain a state beyond the configured durable byte limit');
        assert.equal(tracker.getBaselineState(),'building');
    }));

    test('PR12 AUDIT Whole Workspace Start reconciles watcher evidence after the final yield',()=>fixture(async({tracker,dir})=>{
        const candidate=path.join(dir,'final-yield-candidate.txt');
        const late=path.join(dir,'final-yield-late.txt');
        fs.writeFileSync(candidate,'candidate baseline');
        tracker.snapshotInitialized=false;tracker.baselineBuilding=true;
        await tracker.refreshIgnoreMatchers();
        const state=tracker.buildPersistedState();
        state.scanCoverage=tracker.ignoreFingerprint;
        const baseBytes=Buffer.byteLength(JSON.stringify(state),'utf8');
        tracker.maxPersistedBytes=baseBytes+900;

        const originalYield=tracker.yieldToEventLoop.bind(tracker);
        let injected=false;
        tracker.yieldToEventLoop=async()=>{
            if(!injected){
                injected=true;
                tracker.recordUnresolvedBaseline(late,'late watcher evidence '.repeat(80));
                return;
            }
            await originalYield();
        };
        try {
            await assert.rejects(
                ()=>tracker.initializeWorkspaceSnapshots(),
                /persisted byte capacity.*concurrent evidence|capacity exceeded by concurrent evidence/i
            );
            assert.equal(injected,true);
            assert.equal(tracker.getBaselineState(),'building',
                'late watcher evidence must be rejected before the Ready persistence barrier');
        } finally {
            tracker.yieldToEventLoop=originalYield;
        }
    }));


    test('PR12 AUDIT Whole Workspace completion resynchronizes evidence added during pending-event processing',()=>fixture(async({tracker,dir})=>{
        const candidate=path.join(dir,'completion-candidate.txt');
        const late=path.join(dir,'completion-late.txt');
        fs.writeFileSync(candidate,'candidate');
        tracker.snapshotInitialized=false;tracker.baselineBuilding=true;
        await tracker.refreshIgnoreMatchers();
        const state=tracker.buildPersistedState();
        state.scanCoverage=tracker.ignoreFingerprint;
        const baseBytes=Buffer.byteLength(JSON.stringify(state),'utf8');
        tracker.maxPersistedBytes=baseBytes+900;

        const originalProcess=tracker.processPendingExternalChanges.bind(tracker);
        let injected=false;
        tracker.processPendingExternalChanges=async()=>{
            await originalProcess();
            if(!injected){
                injected=true;
                tracker.recordUnresolvedBaseline(late,'completion watcher evidence '.repeat(80));
            }
        };
        try {
            await assert.rejects(
                ()=>tracker.initializeWorkspaceSnapshots(),
                /persisted byte capacity.*concurrent evidence|capacity exceeded by concurrent evidence/i
            );
            assert.equal(injected,true);
            assert.equal(tracker.getBaselineState(),'building',
                'completion-time evidence must be budgeted before the Ready persistence write');
        } finally {
            tracker.processPendingExternalChanges=originalProcess;
        }
    }));

    test('PR12 AUDIT Whole Workspace completion budgets concurrent coverage-gap evidence before Ready write',()=>fixture(async({tracker,dir})=>{
        const candidate=path.join(dir,'coverage-gap-candidate.txt');
        const gapPath=path.join(dir,'coverage-gap-directory');
        fs.writeFileSync(candidate,'candidate baseline');
        tracker.snapshotInitialized=false;tracker.baselineBuilding=true;
        await tracker.refreshIgnoreMatchers();
        const state=tracker.buildPersistedState();
        state.scanCoverage=tracker.ignoreFingerprint;
        const baseBytes=Buffer.byteLength(JSON.stringify(state),'utf8');
        tracker.maxPersistedBytes=baseBytes+900;

        const originalProcess=tracker.processPendingExternalChanges.bind(tracker);
        const originalFlush=tracker.flushPersistState.bind(tracker);
        let injected=false,flushes=0;
        tracker.processPendingExternalChanges=async()=>{
            await originalProcess();
            if(!injected){
                injected=true;
                tracker.setSubtreeCoverageGap(
                    gapPath,
                    'test-concurrent-gap',
                    'coverage gap evidence '.repeat(80)
                );
            }
        };
        tracker.flushPersistState=async(...args)=>{flushes++;return originalFlush(...args);};
        try {
            await assert.rejects(
                ()=>tracker.initializeWorkspaceSnapshots(),
                /persistence projection|coverage|persisted byte capacity|schema.*limit/i
            );
            assert.equal(injected,true);
            assert.equal(flushes,0,
                'completion budget must reject oversized concurrent coverage evidence before the Ready persistence write');
            assert.equal(tracker.getBaselineState(),'building');
        } finally {
            tracker.processPendingExternalChanges=originalProcess;
            tracker.flushPersistState=originalFlush;
        }
    }));

    test('PR12 AUDIT repository rebuild budgets against history after owned items are removed',()=>fixture(async({tracker,dir})=>{
        const historyTarget=path.join(dir,'history-source.txt');
        const replacement=path.join(dir,'history-rebuild.txt');
        fs.writeFileSync(historyTarget,'history current');
        fs.writeFileSync(replacement,'branch baseline '.repeat(220));
        tracker.fileSnapshots.set(historyTarget,'history baseline');
        tracker.baselineExistingFiles.add(historyTarget);
        tracker.updateTrackedDiff(historyTarget,'history current');
        tracker.fileSnapshots.set(replacement,'old replacement baseline');
        tracker.baselineExistingFiles.add(replacement);
        const item=tracker.createFileRevertItem(historyTarget);
        assert.ok(item);
        tracker.revertHistory=[{
            id:'repo-history-large',
            createdAt:new Date().toISOString(),
            items:[{
                ...item,
                before:{...item.before,content:'history-before '.repeat(900)},
                after:{...item.after,content:'history-after '.repeat(900)}
            }]
        }];

        const base={repoRoot:dir,kind:'repository',headName:'main',headCommit:'aaa',detached:false,inProgress:false};
        const current={...base,headName:'feature',headCommit:'bbb'};
        tracker.setBaselineGitContexts([base]);
        tracker.observeGitContext(current);
        assert.equal(await tracker.flushPendingPersistence(),true);
        const currentBytes=serialized(tracker);
        tracker.maxPersistedBytes=currentBytes+1200;

        assert.equal(await tracker.rebuildRepositoryBaseline(dir,current),true,
            'history that is guaranteed to be removed must not consume replacement-baseline budget');
        assert.equal(tracker.getOriginalContent(replacement),fs.readFileSync(replacement,'utf8'),
            'replacement baseline must still be captured while obsolete history is projected out');
        assert.equal(tracker.revertHistory.some(record=>record.items.some(historyItem=>historyItem.filePath===historyTarget)),false);
        assert.ok(serialized(tracker)<=tracker.maxPersistedBytes);
    }));


    test('PR12 AUDIT Whole Workspace preserves coverage across irrelevant ordinary exclude settings',()=>fixture(async({tracker,dir})=>{
        setVsCodeExcludes({});
        await tracker.refreshIgnoreMatchers();
        const fingerprint=tracker.ignoreFingerprint;
        tracker.scanCoverage=fingerprint;

        setVsCodeExcludes({'files.exclude':{'hidden/**':true}});
        fireConfigurationChanged('files.exclude');
        assert.equal(tracker.scanCoverage,fingerprint,
            'files.exclude must not retire Whole Workspace coverage');
        await tracker.ignoreRefreshPromise;
        assert.equal(tracker.ignoreFingerprint,fingerprint,
            'files.exclude must not change the Whole Workspace coverage fingerprint');
        assert.equal(tracker.scanCoverage,fingerprint);

        setVsCodeExcludes({'search.exclude':{'search-only/**':true}});
        fireConfigurationChanged('search.exclude');
        assert.equal(tracker.scanCoverage,fingerprint,
            'search.exclude must not retire Whole Workspace coverage');
        await tracker.ignoreRefreshPromise;
        assert.equal(tracker.ignoreFingerprint,fingerprint,
            'search.exclude must not change the Whole Workspace coverage fingerprint');
        assert.equal(tracker.scanCoverage,fingerprint);

        const policy=path.join(dir,'.gitignore');
        fs.writeFileSync(policy,'ordinary/**\n');
        tracker.restoringEpoch=tracker.sessionEpoch;
        try {
            tracker.dispatchExternalEvent(Uri.file(policy),'change',tracker.sessionEpoch);
            assert.equal(tracker.scanCoverage,fingerprint,
                '.gitignore events must not retire Whole Workspace coverage');
            await tracker.ignoreRefreshPromise;
            assert.equal(tracker.ignoreFingerprint,fingerprint,
                '.gitignore contents are not part of the Whole Workspace coverage fingerprint');
            assert.equal(tracker.scanCoverage,fingerprint);
        } finally {
            tracker.restoringEpoch=undefined;
            tracker.restoreEvents.clear();
        }

        setVsCodeExcludes({'files.watcherExclude':{'blind/**':true}});
        fireConfigurationChanged('files.watcherExclude');
        assert.equal(tracker.scanCoverage,undefined,
            'watcher exclusions remain a real Whole Workspace coverage invalidation');
    }));

    test('PR12 AUDIT Rules .gitignore events still invalidate ordinary-policy coverage',()=>fixture(async({tracker,dir})=>{
        const policy=path.join(dir,'.gitignore');
        fs.writeFileSync(policy,'first/**\n');
        await tracker.refreshIgnoreMatchers();
        const fingerprint=tracker.ignoreFingerprint;
        tracker.scanCoverage=fingerprint;

        fs.writeFileSync(policy,'second/**\n');
        tracker.restoringEpoch=tracker.sessionEpoch;
        try {
            tracker.dispatchExternalEvent(Uri.file(policy),'change',tracker.sessionEpoch);
            assert.equal(tracker.scanCoverage,undefined,
                'Rules coverage must retire immediately when .gitignore policy changes');
            await tracker.ignoreRefreshPromise;
            assert.notEqual(tracker.ignoreFingerprint,fingerprint,
                'Rules policy fingerprint must reflect the changed .gitignore contents');
        } finally {
            tracker.restoringEpoch=undefined;
            tracker.restoreEvents.clear();
        }
    },'rules'));

    test('PR12 AUDIT live Rules policy refresh fails closed when bounded discovery cannot complete',()=>fixture(async({tracker,dir})=>{
        const policy=path.join(dir,'.gitignore');
        fs.writeFileSync(policy,'first/**\n');
        await tracker.refreshIgnoreMatchers();
        tracker.scanCoverage=tracker.ignoreFingerprint;
        const epoch=tracker.sessionEpoch;

        // Force the next committed live-policy refresh to exceed its bounded
        // discovery allowance while the previously valid matcher is still live.
        tracker.maxScopePreflightEntries=1;
        for(let i=0;i<4;i++)fs.mkdirSync(path.join(dir,`live-policy-${i}`));
        setVsCodeExcludes({'files.exclude':{'newly-excluded/**':true}});
        fireConfigurationChanged('files.exclude');

        await tracker.ignoreRefreshPromise.catch(()=>undefined);
        for(let i=0;i<20&&tracker.sessionEpoch===epoch;i++){
            await new Promise(resolve=>setImmediate(resolve));
        }
        await tracker.persistStateWriteQueue.catch(()=>undefined);

        assert.ok(tracker.sessionEpoch>epoch,
            'failed live policy refresh must invalidate the generation using the stale matcher');
        assert.equal(tracker.isRecording,false,
            'Rules recording must pause instead of continuing with a stale matcher');
        assert.equal(tracker.externalWatcherEnabled,false);
        assert.equal(tracker.baselineBuilding,true);
        assert.equal(tracker.snapshotInitialized,false);
        assert.equal(tracker.scanCoverage,undefined);
        assert.match(tracker.persistenceIssue??'',/policy refresh.*paused|recording is paused/i);
    },'rules'));

    test('PR12 AUDIT Whole Workspace may explicitly exclude .gitignore without requiring ordinary policy',()=>fixture(async({tracker,scope,dir})=>{
        fs.writeFileSync(path.join(dir,'.gitignore'),'ignored.txt\n');
        fs.writeFileSync(path.join(dir,'ignored.txt'),'still in Whole Workspace');
        const requested=scopeFor(tracker,'wholeWorkspace',[{scope:'all',pattern:'.gitignore'}]);
        const preflight=await tracker.preflightConfiguredMonitoringScope(requested,()=>true);
        assert.equal(preflight.status,'ready',JSON.stringify(preflight));
        tracker.effectiveMonitoringScope=requested;
        await tracker.refreshIgnoreMatchers();
        assert.equal(tracker.isPathIgnored(Uri.file(path.join(dir,'ignored.txt'))),false,
            'ordinary .gitignore policy must not define Whole Workspace membership');
        assert.equal(tracker.isPathIgnored(Uri.file(path.join(dir,'.gitignore'))),true,
            'the explicit metadata-file exclusion itself remains effective');
    }));

    test('PR12 AUDIT Whole Workspace never reads Git exclude policy metadata',()=>fixture(async({tracker,dir})=>{
        const gitInfo=path.join(dir,'.git','info');fs.mkdirSync(gitInfo,{recursive:true});
        const exclude=path.join(gitInfo,'exclude');fs.writeFileSync(exclude,'ignored-by-git.txt\n');
        const target=path.join(dir,'ignored-by-git.txt');fs.writeFileSync(target,'whole workspace baseline');
        const requested=scopeFor(tracker,'wholeWorkspace',[]);
        const originalOpen=fs.promises.open;let attempts=0;
        fs.promises.open=async(targetPath,...args)=>{
            if(path.resolve(String(targetPath))===path.resolve(exclude)){
                attempts++;
                throw new Error('Whole Workspace must not read .git/info/exclude');
            }
            return originalOpen(targetPath,...args);
        };
        try {
            const preflight=await tracker.preflightConfiguredMonitoringScope(requested,()=>true);
            assert.equal(preflight.status,'ready',JSON.stringify(preflight));
            tracker.effectiveMonitoringScope=requested;
            await tracker.refreshIgnoreMatchers();
            assert.equal(attempts,0);
            assert.equal(tracker.isPathIgnored(Uri.file(target)),false,
                'Git exclude policy must not define Whole Workspace membership');
        } finally {fs.promises.open=originalOpen;}
    }));

    test('PR12 AUDIT Rules mode fails closed when Git exclude metadata cannot be inspected',()=>fixture(async({tracker,dir})=>{
        const gitInfo=path.join(dir,'.git','info');fs.mkdirSync(gitInfo,{recursive:true});
        const exclude=path.join(gitInfo,'exclude');fs.writeFileSync(exclude,'private.txt\n');
        const requested=scopeFor(tracker,'rules',[]);
        const originalLstat=fs.lstatSync;let attempts=0;
        fs.lstatSync=function(target,...args){
            if(path.resolve(String(target))===path.resolve(exclude)){
                attempts++;
                throw Object.assign(new Error('access denied'),{code:'EACCES'});
            }
            return originalLstat(target,...args);
        };
        try {
            const preflight=await tracker.preflightConfiguredMonitoringScope(requested,()=>true);
            assert.equal(preflight.status,'failed',JSON.stringify(preflight));
            assert.match(preflight.reason??'',/access denied|EACCES|ignore policy/i);
            assert.ok(attempts>0,'Rules mode must inspect repository exclude metadata rather than silently omitting it');
            tracker.effectiveMonitoringScope=requested;
            await assert.rejects(()=>tracker.refreshIgnoreMatchers(),/access denied|EACCES|ignore policy/i);
        } finally {fs.lstatSync=originalLstat;}
    },'rules'));

    test('PR12 AUDIT imported-tree watcher installation is streaming and bounded before candidate scan',()=>fixture(async({tracker,dir})=>{
        const imported=path.join(dir,'imported-watch-budget');fs.mkdirSync(imported);
        for(let i=0;i<4;i++) fs.mkdirSync(path.join(imported,`child-${i}`));
        tracker.maxScopePreflightEntries=2;
        const oldReaddir=fs.promises.readdir;let materialized=0;
        fs.promises.readdir=async(...args)=>{materialized++;return oldReaddir(...args);};
        try {
            await assert.rejects(
                ()=>tracker.watchImportedTree(imported,tracker.sessionEpoch,false,{remainingEntries:tracker.maxScopePreflightEntries}),
                /preparation work budget|inspected directory entries/i
            );
            assert.equal(materialized,0,'imported watch discovery must not allocate readdir result arrays');
            assert.equal([...tracker.importedDirectoryWatchers.keys()].some(candidate=>tracker.pathBelongsToRoot(candidate,imported)),false,
                'bounded watch failure must roll back partial imported-tree watcher installation');
        } finally {fs.promises.readdir=oldReaddir;}
    }));

    test('PR12 CASE watcher glob uses child-directory case semantics under a sensitive root',()=>fixture(async({tracker,dir})=>{
        const child=path.join(dir,'child-case-insensitive');
        const actual=path.join(child,'Foo.txt');
        fs.mkdirSync(child);fs.writeFileSync(actual,'tracked');
        const lower=path.join(child,'foo.txt'),upper=path.join(child,'FOO.txt');
        const originalDetect=tracker.detectWorkspaceRootCaseSensitivity.bind(tracker);
        tracker.detectWorkspaceRootCaseSensitivity=()=>true;
        tracker.workspaceRootCaseSensitivityCache.clear();
        setVsCodeExcludes({'files.watcherExclude':{'child-case-insensitive/FOO.txt':true}});
        try {
            await withLookups([[lower,actual],[upper,actual]],[],async()=>{
                const requested=includeScope(tracker,'rules',['child-case-insensitive/foo.txt']);
                const issue=tracker.configuredScopeNeedsSupplementalCoverage(requested);
                assert.match(issue??'',/child-case-insensitive\/foo\.txt/i,
                    'a case-insensitive child must make the watcher exclusion intersect the explicit file include even when the workspace root is case-sensitive');
            });
        } finally {
            tracker.detectWorkspaceRootCaseSensitivity=originalDetect;
            tracker.workspaceRootCaseSensitivityCache.clear();
        }
    },'rules'));

    test('PR12 CASE watcher glob does not inherit insensitive root semantics into a sensitive child',()=>fixture(async({tracker,dir})=>{
        const child=path.join(dir,'child-case-sensitive');
        fs.mkdirSync(child);
        const lower=path.join(child,'foo.txt'),upper=path.join(child,'FOO.txt');
        fs.writeFileSync(lower,'lower');fs.writeFileSync(upper,'upper');
        const actualChildSensitivity=detectLocalPathCaseSensitivity(child);
        if(actualChildSensitivity!==true){
            console.log('SKIP PR12 sensitive-child watcher case fixture requires a case-sensitive child directory');
            return;
        }
        const originalDetect=tracker.detectWorkspaceRootCaseSensitivity.bind(tracker);
        tracker.detectWorkspaceRootCaseSensitivity=()=>false;
        tracker.workspaceRootCaseSensitivityCache.clear();
        setVsCodeExcludes({'files.watcherExclude':{'child-case-sensitive/FOO.txt':true}});
        try {
            const requested=includeScope(tracker,'rules',['child-case-sensitive/foo.txt']);
            const issue=tracker.configuredScopeNeedsSupplementalCoverage(requested);
            assert.equal(issue,undefined,
                'a sensitive child keeps case-distinct watcher and include file names disjoint even when the root is insensitive');
        } finally {
            tracker.detectWorkspaceRootCaseSensitivity=originalDetect;
            tracker.workspaceRootCaseSensitivityCache.clear();
        }
    },'rules'));

    test('PR12 AUDIT watcher brace expansion is capped before Cartesian explosion',()=>fixture(async({tracker,scope})=>{
        const original=tracker.getVsCodeWatcherExcludePatterns.bind(tracker);
        try {
            const explosive=Array.from({length:25},()=>'{a,b}').join('/');
            tracker.getVsCodeWatcherExcludePatterns=()=>[explosive];
            const issue=tracker.configuredScopeNeedsSupplementalCoverage(scope);
            assert.match(issue??'',/watcherExclude expansion exceeds safe bound/i,
                'brace explosion must conservatively require supplemental coverage');
            assert.equal(tracker.expandSimpleBraceGlob(explosive),undefined,
                'brace expansion must stop before materializing the full Cartesian product');
        } finally {
            tracker.getVsCodeWatcherExcludePatterns=original;
        }
    }));

    test('PR12 AUDIT restore-directory descendant watcher exclusions need no supplemental coverage',()=>fixture(async({tracker,scope})=>{
        const original=tracker.getVsCodeWatcherExcludePatterns.bind(tracker);
        try {
            tracker.getVsCodeWatcherExcludePatterns=()=>['**/.difftracker-restore-*/**'];
            assert.equal(tracker.configuredScopeNeedsSupplementalCoverage(scope),undefined,
                'descendant-only restore-directory watcher exclusions are already covered by the hard boundary');
            tracker.getVsCodeWatcherExcludePatterns=()=>['**/.difftracker-restore-*'];
            assert.match(tracker.configuredScopeNeedsSupplementalCoverage(scope)??'',/watcherExclude/,
                'a watcher pattern that can match an ordinary restore-prefixed file must still require supplemental coverage');
        } finally {
            tracker.getVsCodeWatcherExcludePatterns=original;
        }
    }));

    // These regressions model filesystem lookup only; production scope and
    // coverage classifiers remain the authorities under test on every platform.
    function caseIdentity(tracker, sensitive) {
        const original = tracker.workspaceRootIdentityForFolder.bind(tracker);
        tracker.workspaceRootIdentityForFolder = folder => ({ ...original(folder), caseSensitive: sensitive });
        return { ...tracker.currentWorkspaceRootIdentities()[0], caseSensitive: sensitive };
    }

    test('PR12 CASE Unicode lowercasing is not watcher exclusion coverage proof',()=>fixture(async({tracker,dir})=>{
        const identity=caseIdentity(tracker,false);
        const upper='\u0130',lower='i\u0307';
        fs.mkdirSync(path.join(dir,upper));fs.mkdirSync(path.join(dir,lower));
        fs.writeFileSync(path.join(dir,upper,'live.txt'),'must remain observed');
        const requested=scopeFor(tracker,'wholeWorkspace',[{scope:'all',pattern:`**/${lower}/**`}]);
        assert.equal(upper.toLowerCase(),lower,'fixture demonstrates the unsafe JavaScript equivalence');
        assert.equal(evaluateConfiguredScope(requested,identity,`${upper}/live.txt`,false).monitored,true);
        assert.equal(tracker.watcherPatternCoveredByExplicitScopeExclusion(requested,identity,`**/${upper}/**`),false);
        tracker.getVsCodeWatcherExcludePatterns=()=>[`**/${upper}/**`];
        assert.match(tracker.configuredScopeNeedsSupplementalCoverage(requested)??'',/watcherExclude/);
        const result=await tracker.applyConfiguredMonitoringScope(requested);
        assert.equal(result.status,'requiresS4','public Apply must reject the uncovered Unicode watcher blind spot');
    }));

    test('PR12 CASE wildcard ASCII aliases cannot inherit root case semantics',()=>fixture(async({tracker,dir})=>{
        const identity=caseIdentity(tracker,false);
        const actual=path.join(dir,'mixed','PRIVATE'),missing=path.join(dir,'mixed','private');
        fs.mkdirSync(actual,{recursive:true});fs.writeFileSync(path.join(actual,'live.txt'),'live');
        const requested=scopeFor(tracker,'wholeWorkspace',[{scope:'all',pattern:'**/private/**'}]);
        await withLookups([], [missing], async()=>{
            assert.equal(evaluateConfiguredScope(requested,identity,'mixed/PRIVATE/live.txt',false).monitored,true);
            assert.equal(tracker.watcherPatternCoveredByExplicitScopeExclusion(requested,identity,'**/PRIVATE/**'),false,
                'a wildcard has no unique physical parent at which to prove a case alias');
        });
    }));

    test('PR12 CASE literal exclusion coverage retains filesystem alias proof',()=>fixture(async({tracker,dir})=>{
        const identity=caseIdentity(tracker,false);
        const actual=path.join(dir,'private'),alias=path.join(dir,'PRIVATE');
        fs.mkdirSync(actual);fs.writeFileSync(path.join(actual,'live.txt'),'excluded');
        const requested=scopeFor(tracker,'wholeWorkspace',[{scope:'all',pattern:'private/**'}]);
        await withLookups([[alias,actual]],[],async()=>{
            assert.equal(evaluateConfiguredScope(requested,identity,'PRIVATE/live.txt',false).source,'explicitExclude');
            assert.equal(tracker.watcherPatternCoveredByExplicitScopeExclusion(requested,identity,'PRIVATE/**'),true);
        });
    }));

    test('PR12 CASE exact Unicode patterns and exclusion precedence remain valid',()=>fixture(async({tracker,dir})=>{
        const identity=caseIdentity(tracker,false);
        const same='**/\u0130/**';
        let requested=scopeFor(tracker,'wholeWorkspace',[{scope:'all',pattern:same}]);
        assert.equal(tracker.watcherPatternCoveredByExplicitScopeExclusion(requested,identity,same),true);
        requested=scopeFor(tracker,'wholeWorkspace',[{scope:'folder',folder:'another-root',pattern:same}]);
        assert.equal(tracker.watcherPatternCoveredByExplicitScopeExclusion(requested,identity,same),false);
        requested=scopeFor(tracker,'wholeWorkspace',[{scope:'all',pattern:'**/ordinary/'}]);
        assert.equal(tracker.watcherPatternCoveredByExplicitScopeExclusion(requested,identity,'**/ordinary'),false,
            'directory-only rules cannot cover a same-named ordinary file');
        requested=scopeFor(tracker,'wholeWorkspace',[{scope:'all',pattern:'**'}]);
        assert.equal(tracker.watcherPatternCoveredByExplicitScopeExclusion(requested,identity,same),true);
    }));

    for(const sensitive of [true,false]) {
        test(`PR12 CASE reserved watcher pattern case semantics (sensitive=${sensitive})`,()=>fixture(async({tracker,dir})=>{
            const identity=caseIdentity(tracker,sensitive);
            const git=path.join(dir,sensitive?'.GIT':'.git');fs.mkdirSync(git);
            const probe=path.join(dir,'ProbeName'),probeAlias=path.join(dir,'probeName');
            const aliases=sensitive?[]:[
                [probeAlias,probe],[path.join(dir,'.GIT'),git],[path.join(dir,'.Git'),git],
                [path.join(dir,'.gIT'),git]
            ];
            // toggleAsciiCase('.GIT') probes '.gIT', not '.git'. Model that
            // spelling too: the native Windows lookup must not leak into this
            // simulated sensitive directory merely because opendir lists Git first.
            const denied=sensitive?[probeAlias,path.join(dir,'.git'),path.join(dir,'.Git'),path.join(dir,'.gIT')]:[];
            await withLookups(aliases,denied,async()=>{
                assert.equal(detectLocalPathCaseSensitivity(dir),sensitive,
                    'fixture must establish the requested case semantics before coverage assertions');
                for(const pattern of ['**/.git/**','**/.difftracker-restore-*/**']) {
                    assert.equal(tracker.watcherPatternOnlyTargetsHardBoundary(pattern,identity),true);
                }
                for(const pattern of ['.GIT/**','.Git','.DIFFTRACKER-RESTORE-*/**']) {
                    assert.equal(tracker.watcherPatternOnlyTargetsHardBoundary(pattern,identity),!sensitive,pattern);
                }
                for(const pattern of ['**/.GIT/**','**/.DIFFTRACKER-RESTORE-*/**',
                    '**/.difftracker-restore-*','**/.DIFFTRACKER-RESTORE-*','**/.G\u0130T/**','**/.git*/**','**/.G?T/**']) {
                    assert.equal(tracker.watcherPatternOnlyTargetsHardBoundary(pattern,identity),false,pattern);
                }
                const originalOpen=fs.opendirSync;
                let probeOpens=0;
                fs.opendirSync=(target,...args)=>{
                    if(path.resolve(String(target))===path.resolve(dir))probeOpens++;
                    return originalOpen(target,...args);
                };
                try {
                    for(let i=0;i<32;i++) {
                        assert.equal(tracker.watcherPatternOnlyTargetsHardBoundary(
                            '.DIFFTRACKER-RESTORE-*/**',identity),!sensitive);
                    }
                    assert.ok(probeOpens<=1,
                        `same-parent proof must reuse a bounded metadata-validated case probe (opens=${probeOpens})`);
                } finally {fs.opendirSync=originalOpen;}
                const requested=scopeFor(tracker);
                tracker.getVsCodeWatcherExcludePatterns=()=>['{.GIT,.DIFFTRACKER-RESTORE-*}/**'];
                const issue=tracker.configuredScopeNeedsSupplementalCoverage(requested);
                if(sensitive)assert.match(issue??'',/watcherExclude/);else assert.equal(issue,undefined);
            });
        }));
    }

    for(const gitFirst of [true,false]) {
        test(`PR12 CASE sensitive lookup fixture is independent of directory order (gitFirst=${gitFirst})`,()=>fixture(async({tracker,dir})=>{
            const identity=caseIdentity(tracker,true);
            const git=path.join(dir,'.GIT'),probe=path.join(dir,'ProbeName');fs.mkdirSync(git);
            // Simulate an insensitive backing lookup even on Linux, then overlay
            // a sensitive directory. This reproduces the Windows fixture leak
            // independently of the runner's real filesystem and entry order.
            await withLookups([[path.join(dir,'.gIT'),git],[path.join(dir,'probeName'),probe]],[],async()=>{
                const originalOpen=fs.opendirSync;
                fs.opendirSync=(target,...args)=>{
                    if(path.resolve(String(target))!==path.resolve(dir))return originalOpen(target,...args);
                    let index=0;
                    const names=gitFirst?['.GIT','ProbeName']:['ProbeName','.GIT'];
                    return {readSync(){return index<names.length?{name:names[index++],isSymbolicLink:()=>false}:null;},closeSync(){}};
                };
                try {
                    await withLookups([],['.git','.Git','.gIT','probeName'].map(name=>path.join(dir,name)),async()=>{
                        assert.equal(detectLocalPathCaseSensitivity(dir),true);
                        assert.equal(tracker.watcherPatternOnlyTargetsHardBoundary('.Git',identity),false);
                        assert.equal(tracker.watcherPatternOnlyTargetsHardBoundary('.DIFFTRACKER-RESTORE-*/**',identity),false);
                    });
                } finally {fs.opendirSync=originalOpen;}
            });
        }));
    }

    test('PR12 AUDIT traversal-proven physical identity is not charged twice',()=>fixture(async({dir})=>{
        const nested=path.join(dir,'physical-parent');
        fs.mkdirSync(nested);
        const target=path.join(nested,'PhysicalTarget');
        fs.writeFileSync(target,'target');
        const budget={
            remainingEntries:1,
            physicalPaths:new Set([path.resolve(nested),path.resolve(target)])
        };
        const originalOpen=fs.opendirSync;
        let opens=0;
        fs.opendirSync=(value,...args)=>{
            if(path.resolve(String(value))===path.resolve(dir) ||
                path.resolve(String(value))===path.resolve(nested)) {
                opens++;
                throw new Error('physical provenance must avoid a second directory scan');
            }
            return originalOpen(value,...args);
        };
        try {
            const relative=path.relative(dir,target).split(path.sep).join('/');
            const resolved=resolveRelativePathIdentity(dir,relative,false,budget);
            assert.equal(resolved.unavailable,false);
            assert.equal(resolved.resolvedRelativePath,relative);
            assert.equal(resolved.verifiedPrefixLength,2);
            assert.equal(budget.remainingEntries,1);
            assert.equal(opens,0);
        } finally {fs.opendirSync=originalOpen;}
    }));

    test('PR12 AUDIT preparation identity lookup stops at an early exact witness',()=>fixture(async({dir})=>{
        const target=path.join(dir,'EarlyTarget');
        fs.writeFileSync(target,'target');
        const originalOpen=fs.opendirSync;
        let reads=0;
        fs.opendirSync=(value,...args)=>{
            if(path.resolve(String(value))!==path.resolve(dir))return originalOpen(value,...args);
            let index=0;
            return {
                readSync(){
                    reads++;
                    if(index++===0)return {name:'EarlyTarget',isSymbolicLink:()=>false};
                    return {name:`later-${index}`,isSymbolicLink:()=>false};
                },
                closeSync(){}
            };
        };
        try {
            const budget={remainingEntries:5};
            const resolved=resolveRelativePathIdentity(dir,'EarlyTarget',true,budget);
            assert.equal(resolved.unavailable,false);
            assert.equal(resolved.resolvedRelativePath,'EarlyTarget');
            assert.equal(reads,0,
                'a proven case-sensitive root must not be enumerated to confirm an exact first component');
            assert.equal(budget.remainingEntries,5,
                'identity proof must preserve the full preparation allowance when no scan is needed');
            assert.equal(budget.exhausted,undefined);
        } finally {fs.opendirSync=originalOpen;}
    }));

    test('PR12 AUDIT preparation directory evidence is reused across different literals',()=>fixture(async({dir})=>{
        const first=path.join(dir,'AlphaTarget'),second=path.join(dir,'BetaTarget');
        fs.writeFileSync(first,'a');fs.writeFileSync(second,'b');
        const firstAlias=path.join(dir,'alphatarget'),secondAlias=path.join(dir,'betatarget');
        const originalOpen=fs.opendirSync;
        let opens=0;
        fs.opendirSync=(value,...args)=>{
            if(path.resolve(String(value))===path.resolve(dir))opens++;
            return originalOpen(value,...args);
        };
        try {
            await withLookups([[firstAlias,first],[secondAlias,second]],[],async()=>{
                const budget={remainingEntries:64};
                assert.equal(resolveRelativePathIdentity(dir,'alphatarget',false,budget).resolvedRelativePath,'AlphaTarget');
                const afterFirst=budget.remainingEntries;
                const opensAfterFirst=opens;
                assert.equal(resolveRelativePathIdentity(dir,'betatarget',false,budget).resolvedRelativePath,'BetaTarget');
                assert.equal(opens,opensAfterFirst,
                    'different literals in the same parent must reuse one bounded directory enumeration');
                assert.equal(budget.remainingEntries,afterFirst,
                    'reusing parent directory evidence must not consume additional entry work');
            });
        } finally {fs.opendirSync=originalOpen;}
    }));

    test('PR12 AUDIT alias identity proof enumerates a parent only once',()=>fixture(async({dir})=>{
        const actual=path.join(dir,'LatePhysicalTarget');
        const alias=path.join(dir,'latephysicaltarget');
        fs.writeFileSync(actual,'target');
        const originalOpen=fs.opendirSync;
        let opens=0,reads=0;
        fs.opendirSync=(value,...args)=>{
            if(path.resolve(String(value))!==path.resolve(dir))return originalOpen(value,...args);
            opens++;
            const real=originalOpen(value,...args);
            const originalRead=real.readSync.bind(real);
            real.readSync=()=>{reads++;return originalRead();};
            return real;
        };
        try {
            await withLookups([[alias,actual]],[],async()=>{
                const budget={remainingEntries:64};
                const resolved=resolveRelativePathIdentity(dir,'latephysicaltarget',false,budget);
                assert.equal(resolved.unavailable,false);
                assert.equal(resolved.resolvedRelativePath,'LatePhysicalTarget');
                assert.equal(opens,1,
                    'alias proof must reuse the exact-scan evidence instead of reopening the parent');
                assert.ok(reads<=64,
                    'one alias proof must remain inside the single shared directory-entry allowance');
            });
        } finally {fs.opendirSync=originalOpen;}
    }));

    test('PR12 AUDIT preparation reuses unique filesystem alias identity proof',()=>fixture(async({dir})=>{
        const actual=path.join(dir,'PhysicalTarget');
        const alias=path.join(dir,'physicaltarget');
        fs.writeFileSync(actual,'target');
        const originalOpen=fs.opendirSync;
        let opens=0;
        fs.opendirSync=(value,...args)=>{
            if(path.resolve(String(value))===path.resolve(dir))opens++;
            return originalOpen(value,...args);
        };
        try {
            await withLookups([[alias,actual]],[],async()=>{
                const budget={remainingEntries:64};
                const first=resolveRelativePathIdentity(dir,'physicaltarget',false,budget);
                assert.equal(first.unavailable,false);
                assert.equal(first.resolvedRelativePath,'PhysicalTarget');
                const afterFirst=budget.remainingEntries;
                const opensAfterFirst=opens;
                const second=resolveRelativePathIdentity(dir,'physicaltarget',false,budget);
                assert.equal(second.unavailable,false);
                assert.equal(second.resolvedRelativePath,'PhysicalTarget');
                assert.equal(budget.remainingEntries,afterFirst,
                    'repeated alias resolution must reuse operation-local identity evidence');
                assert.equal(opens,opensAfterFirst,
                    'repeated alias resolution must not reopen and rescan the parent directory');
            });
        } finally {fs.opendirSync=originalOpen;}
    }));

    test('PR12 AUDIT runtime scan cap preserves a proven case-insensitive explicit include',()=>fixture(async({tracker,dir})=>{
        const actual=path.join(dir,'MixedIncluded');
        const alias=path.join(dir,'mixedincluded');
        fs.writeFileSync(actual,'tracked');
        const originalOpen=fs.opendirSync;
        try {
            await withLookups([[alias,actual]],[],async()=>{
                const wrappedOpen=fs.opendirSync;
                fs.opendirSync=(value,...args)=>{
                    if(path.resolve(String(value))!==path.resolve(dir))return wrappedOpen(value,...args);
                    let index=0;
                    return {
                        readSync(){
                            index++;
                            if(index<=25000)return {
                                name:`synthetic-${String(index).padStart(5,'0')}.txt`,
                                isSymbolicLink:()=>false
                            };
                            return null;
                        },
                        closeSync(){}
                    };
                };
                try {
                    const identity={...tracker.currentWorkspaceRootIdentities()[0],caseSensitive:false};
                    const requested=includeScope(tracker,'rules',['mixedincluded']);
                    requested.roots=[identity];
                    const decision=evaluateConfiguredScope(
                        requested,identity,'MixedIncluded',true,false
                    );
                    assert.equal(decision.source,'explicitInclude',
                        'a previously valid ASCII-case alias must remain included when runtime spelling recovery hits its bounded cap');
                    assert.equal(decision.monitored,true);
                } finally {
                    fs.opendirSync=wrappedOpen;
                }
            });
        } finally {
            fs.opendirSync=originalOpen;
        }
    },'rules'));

    test('PR12 AUDIT runtime scan cap does not drop an existing Whole Workspace path',()=>fixture(async({tracker,dir})=>{
        const target=path.join(dir,'runtime-late-entry.txt');
        fs.writeFileSync(target,'tracked');
        const originalOpen=fs.opendirSync;
        const readsPerOpen=[];
        fs.opendirSync=(value,...args)=>{
            if(path.resolve(String(value))!==path.resolve(dir))return originalOpen(value,...args);
            let index=0,reads=0;
            readsPerOpen.push(()=>reads);
            return {
                readSync(){
                    reads++;
                    index++;
                    if(index<=25000)return {
                        name:`synthetic-${String(index).padStart(5,'0')}.txt`,
                        isSymbolicLink:()=>false
                    };
                    if(index===25001)return {name:'runtime-late-entry.txt',isSymbolicLink:()=>false};
                    return null;
                },
                closeSync(){}
            };
        };
        try {
            const resolved=resolveRelativePathIdentity(dir,'runtime-late-entry.txt',false);
            assert.equal(resolved.unavailable,true,
                'runtime cap must not pretend physical spelling was established');
            assert.equal(resolved.runtimeFallbackExhausted,true);
            assert.equal(resolved.lookupVerifiedPrefixLength,1,
                'successful lstat must survive bounded spelling-scan exhaustion');

            const identity={...tracker.currentWorkspaceRootIdentities()[0],caseSensitive:false};
            const requested={...scopeFor(tracker,'wholeWorkspace'),roots:[identity]};
            const decision=evaluateConfiguredScope(
                requested,identity,'runtime-late-entry.txt',false,false
            );
            assert.equal(decision.monitored,true,
                'an existing ordinary path must not be silently dropped as identityUnknown solely because the runtime scan cap was reached');
            assert.equal(decision.source,'wholeWorkspace');
            assert.ok(readsPerOpen.length>0);
            assert.ok(Math.max(...readsPerOpen.map(reads=>reads()))<=20001,
                'every runtime directory enumeration remains individually bounded even when the physical entry is beyond the scan cap');
        } finally {fs.opendirSync=originalOpen;}
    }));

    test('PR12 AUDIT runtime identity cap reuses an established canonical key for a filesystem alias',()=>fixture(async({tracker,dir})=>{
        caseIdentity(tracker,false);
        const actual=path.join(dir,'EstablishedKey.txt');
        const alias=path.join(dir,'establishedkey.txt');
        fs.writeFileSync(actual,'tracked');
        tracker.fileSnapshots.set(actual,'baseline');
        tracker.baselineExistingFiles.add(actual);
        assert.equal(tracker.canonicalTrackingPath(actual,true),actual);
        const initialKeys=tracker.canonicalTrackingPaths.size;

        const originalOpen=fs.opendirSync;
        await withLookups([[alias,actual]],[],async()=>{
            const wrapped=fs.opendirSync;
            fs.opendirSync=(value,...args)=>{
                if(path.resolve(String(value))!==path.resolve(dir))return wrapped(value,...args);
                let index=0;
                return {
                    readSync(){
                        index++;
                        if(index<=25000)return {
                            name:`synthetic-${String(index).padStart(5,'0')}.txt`,
                            isSymbolicLink:()=>false
                        };
                        return null;
                    },
                    closeSync(){}
                };
            };
            try {
                const canonical=tracker.canonicalTrackingPath(alias);
                assert.equal(path.resolve(canonical),path.resolve(actual),
                    'bounded spelling recovery must reuse the already-established physical-file key');
                assert.equal(tracker.canonicalTrackingPaths.size,initialKeys,
                    'the alternate-case URI must not create a second canonical identity');
            } finally {
                fs.opendirSync=wrapped;
            }
        });
        fs.opendirSync=originalOpen;
    }));

    test('PR12 AUDIT runtime canonical alias recovery never merges distinct case-sensitive files',()=>fixture(async({tracker,dir})=>{
        if(detectLocalPathCaseSensitivity(dir)!==true){
            console.log('SKIP PR12 distinct-case canonical-key fixture requires a case-sensitive directory');
            return;
        }
        caseIdentity(tracker,false);
        const upper=path.join(dir,'Distinct.txt');
        const lower=path.join(dir,'distinct.txt');
        fs.writeFileSync(upper,'upper');
        fs.writeFileSync(lower,'lower');
        tracker.fileSnapshots.set(upper,'upper baseline');
        tracker.baselineExistingFiles.add(upper);
        assert.equal(tracker.canonicalTrackingPath(upper,true),upper);

        const originalOpen=fs.opendirSync;
        fs.opendirSync=(value,...args)=>{
            if(path.resolve(String(value))!==path.resolve(dir))return originalOpen(value,...args);
            let index=0;
            return {
                readSync(){
                    index++;
                    if(index<=25000)return {
                        name:`synthetic-${String(index).padStart(5,'0')}.txt`,
                        isSymbolicLink:()=>false
                    };
                    return null;
                },
                closeSync(){}
            };
        };
        try {
            const canonical=tracker.canonicalTrackingPath(lower);
            assert.equal(path.resolve(canonical),path.resolve(lower),
                'ASCII-case prefilter alone must never merge two distinct filesystem entries');
        } finally {
            fs.opendirSync=originalOpen;
        }
    }));

    test('PR12 AUDIT path identity fallback consumes the caller work budget',()=>fixture(async({dir})=>{
        const target=path.join(dir,'TargetName');
        fs.writeFileSync(target,'target');
        const originalOpen=fs.opendirSync;
        let opens=0,reads=0;
        fs.opendirSync=(value,...args)=>{
            if(path.resolve(String(value))!==path.resolve(dir))return originalOpen(value,...args);
            opens++;
            let index=0;
            return {
                readSync(){
                    reads++;
                    if(index<20){
                        index++;
                        return {name:`f-${String(index).padStart(3,'0')}`,isSymbolicLink:()=>false};
                    }
                    if(index++===20)return {name:'TargetName',isSymbolicLink:()=>false};
                    return null;
                },
                closeSync(){}
            };
        };
        try {
            const budget={remainingEntries:5};
            const resolved=resolveRelativePathIdentity(dir,'TargetName',false,budget);
            assert.equal(budget.remainingEntries,0);
            assert.equal(budget.exhausted,true,
                'identity lookup must expose shared-budget exhaustion instead of scanning past it');
            assert.equal(resolved.unavailable,true);
            assert.ok(reads<=6,
                'shared identity lookup may read one uncharged lookahead to distinguish EOF from an entry beyond the caller allowance');
            assert.equal(opens,1,
                'budget exhaustion must stop before an additional fallback scan');
        } finally {fs.opendirSync=originalOpen;}
    }));

    test('PR12 AUDIT Apply does not repeat supplemental identity qualification at every transaction barrier',()=>fixture(async({tracker,scope})=>{
        const requested=JSON.parse(JSON.stringify(scope));
        const original=tracker.configuredScopeNeedsSupplementalCoverage.bind(tracker);
        let calls=0;
        tracker.configuredScopeNeedsSupplementalCoverage=(...args)=>{
            calls++;
            return original(...args);
        };
        try {
            const result=await tracker.applyConfiguredMonitoringScope(requested);
            assert.equal(result.status,'applied',JSON.stringify(result));
            assert.equal(calls,1,
                'filesystem-aware supplemental qualification must run once; later barriers use the watcher coverage revision');
        } finally {
            tracker.configuredScopeNeedsSupplementalCoverage=original;
        }
    }));

    test('PR12 AUDIT preflight reports identity-budget exhaustion as truncated',()=>fixture(async({tracker,dir})=>{
        const originalDetect=tracker.detectWorkspaceRootCaseSensitivity.bind(tracker);
        tracker.detectWorkspaceRootCaseSensitivity=()=>false;
        tracker.workspaceRootCaseSensitivityCache.clear();
        for(let i=0;i<8;i++)fs.writeFileSync(path.join(dir,`identity-${i}.txt`),'x');
        const requested=scopeFor(tracker,'wholeWorkspace',[{scope:'all',pattern:'missing-alias/**'}]);
        tracker.maxScopePreflightEntries=2;
        try {
            const result=await tracker.preflightConfiguredMonitoringScope(requested,()=>true);
            assert.equal(result.status,'ready',JSON.stringify(result));
            assert.equal(result.truncated,true,JSON.stringify(result));
            assert.equal(result.unreadableDirectoryCount,0,
                'identity work exhaustion is a bounded-preparation condition, not a filesystem read failure');
            assert.match(result.reason??'',/identity|preparation|budget|entries/i);
        } finally {
            tracker.detectWorkspaceRootCaseSensitivity=originalDetect;
            tracker.workspaceRootCaseSensitivityCache.clear();
        }
    }));

    test('PR12 AUDIT Rules include identity work shares the traversal preparation budget',()=>fixture(async({tracker,dir})=>{
        const target=path.join(dir,'TargetName');
        const originalDetect=tracker.detectWorkspaceRootCaseSensitivity.bind(tracker);
        tracker.detectWorkspaceRootCaseSensitivity=()=>false;
        tracker.workspaceRootCaseSensitivityCache.clear();
        const requested=includeScope(tracker,'rules',['TargetName']);
        await sourceScope(tracker,scopeFor(tracker,'rules'),false);
        fs.writeFileSync(target,'target');

        const originalOpen=fs.opendirSync;
        const originalAsyncOpen=fs.promises.opendir;
        let syncReads=0,asyncReads=0,asyncSawTarget=false;
        const entries=()=>Array.from({length:20},(_,entryIndex)=>({
            name:`f-${String(entryIndex+1).padStart(3,'0')}`,
            isFile:()=>true,isDirectory:()=>false,isSymbolicLink:()=>false
        })).concat([{
            name:'TargetName',isFile:()=>true,isDirectory:()=>false,isSymbolicLink:()=>false
        }]);
        const syncHandle=()=>{
            const pending=entries();
            return {
                readSync(){
                    syncReads++;
                    return pending.shift()??null;
                },
                closeSync(){}
            };
        };
        fs.opendirSync=(value,...args)=>
            path.resolve(String(value))===path.resolve(dir)?syncHandle():originalOpen(value,...args);
        fs.promises.opendir=async(value,...args)=>{
            if(path.resolve(String(value))!==path.resolve(dir))return originalAsyncOpen(value,...args);
            const pending=entries();
            return {
                readSync(){
                    asyncReads++;
                    return pending.shift()??null;
                },
                closeSync(){},
                async *[Symbol.asyncIterator](){
                    while(pending.length>0){
                        asyncReads++;
                        const entry=pending.shift();
                        if(entry?.name==='TargetName')asyncSawTarget=true;
                        yield entry;
                    }
                }
            };
        };
        tracker.maxScopePreflightEntries=5;
        try {
            const outcome=await tracker.applyConfiguredMonitoringScope(requested);
            assert.notEqual(outcome.status,'applied');
            assert.match(outcome.reason??'',/path-identity|preparation|budget|entries/i);
            assert.ok(asyncReads<=6,
                'async iteration may fetch one lookahead entry before the loop body observes the exhausted budget');
            assert.equal(asyncSawTarget,false,
                'bounded preflight must not discover the late real target outside its entry allowance');
            assert.ok(syncReads<=6,
                'Rules Apply may read one uncharged lookahead to distinguish EOF from an entry beyond the shared preparation allowance');
            assert.equal(tracker.fileSnapshots.has(target),false);
        } finally {
            fs.opendirSync=originalOpen;
            fs.promises.opendir=originalAsyncOpen;
            tracker.detectWorkspaceRootCaseSensitivity=originalDetect;
            tracker.workspaceRootCaseSensitivityCache.clear();
        }
    },'rules'));

    test('PR12 AUDIT identity alias scan distinguishes N-1 N and N+1 at EOF',()=>fixture(async({dir})=>{
        const resolveAtBound=async(entryCount,budgetCount)=>{
            const parent=path.join(dir,`identity-eof-${entryCount}-${budgetCount}`);
            fs.mkdirSync(parent,{recursive:true});
            const actual=path.join(parent,'TargetName');
            fs.writeFileSync(actual,'target');
            for(let i=1;i<entryCount;i++)fs.writeFileSync(path.join(parent,`f-${String(i).padStart(3,'0')}`),'x');
            const alias=path.join(parent,'targetname');
            const budget={remainingEntries:budgetCount};
            let result;
            await withLookups([[alias,actual]],[],async()=>{
                result=resolveRelativePathIdentity(parent,'targetname',false,budget);
            });
            return {result,budget};
        };

        const below=await resolveAtBound(4,5);
        assert.equal(below.result.unavailable,false,'N-1 entries must leave complete alias evidence');
        assert.equal(below.result.resolvedRelativePath,'TargetName');
        assert.equal(below.budget.remainingEntries,1);
        assert.notEqual(below.budget.exhausted,true);

        const exact=await resolveAtBound(5,5);
        assert.equal(exact.result.unavailable,false,'exactly N entries must probe EOF and remain complete');
        assert.equal(exact.result.resolvedRelativePath,'TargetName');
        assert.equal(exact.budget.remainingEntries,0);
        assert.notEqual(exact.budget.exhausted,true,
            'reaching EOF exactly at the allowance is completion, not exhaustion');

        const above=await resolveAtBound(6,5);
        assert.equal(above.result.unavailable,true,'N+1 entries must remain fail-closed');
        assert.equal(above.budget.remainingEntries,0);
        assert.equal(above.budget.exhausted,true,
            'a non-null lookahead after N charged entries must mark the preparation budget exhausted');
    }));

    test('PR12 CASE root case probe searches past non-probeable raw entries',()=>fixture(async({dir})=>{
        const originalOpen=fs.opendirSync;
        let index=0,reads=0,closed=false;
        fs.opendirSync=(target,...args)=>{
            if(path.resolve(String(target))!==path.resolve(dir))return originalOpen(target,...args);
            return {
                readSync(){
                    reads++;
                    if(index<128){
                        index++;
                        return {name:String(index).padStart(4,'0'),isSymbolicLink:()=>false};
                    }
                    if(index===128){
                        index++;
                        return {name:'ProbeName',isSymbolicLink:()=>false};
                    }
                    return null;
                },
                closeSync(){closed=true;}
            };
        };
        try {
            const detected=detectLocalPathCaseSensitivity(dir);
            assert.equal(typeof detected,'boolean');
            assert.equal(reads,129);
            assert.equal(closed,true);
        } finally {fs.opendirSync=originalOpen;}
    }));

    test('PR12 CASE literal hard-boundary proof respects child filesystem semantics',()=>fixture(async({tracker,dir})=>{
        let identity=caseIdentity(tracker,true);
        const git=path.join(dir,'insensitive','.git'),alias=path.join(dir,'insensitive','.GIT');
        fs.mkdirSync(git,{recursive:true});
        await withLookups([[alias,git]],[],async()=>{
            assert.equal(tracker.watcherPatternOnlyTargetsHardBoundary('insensitive/.GIT/**',identity),true,
                'verified child alias must work even under a sensitive root');
        });
        identity={...identity,caseSensitive:false};
        const distinct=path.join(dir,'sensitive','.GIT'),missing=path.join(dir,'sensitive','.git');
        fs.mkdirSync(distinct,{recursive:true});fs.writeFileSync(path.join(distinct,'live.txt'),'live');
        await withLookups([], [missing], async()=>{
            assert.equal(evaluateConfiguredScope(scopeFor(tracker),identity,'sensitive/.GIT/live.txt',false).monitored,true);
            assert.equal(tracker.watcherPatternOnlyTargetsHardBoundary('sensitive/.GIT/**',identity),false,
                'root case mode must not override a proven distinct literal child');
        });
    }));

    test('PR12 CASE wildcard hard-boundary aliases cannot trust only the root flag',()=>fixture(async({tracker,dir})=>{
        const identity=caseIdentity(tracker,false);
        const actual=path.join(dir,'sensitive','.GIT'),missing=path.join(dir,'sensitive','.git');
        fs.mkdirSync(actual,{recursive:true});fs.writeFileSync(path.join(actual,'live.txt'),'live');
        const requested=scopeFor(tracker);
        await withLookups([], [missing], async()=>{
            assert.equal(evaluateConfiguredScope(requested,identity,'sensitive/.GIT/live.txt',false).monitored,true);
            assert.equal(tracker.watcherPatternOnlyTargetsHardBoundary('**/.GIT/**',identity),false,
                'one insensitive root is not proof about every wildcard-selected descendant parent');
        });
    }));

    test('PR12 CASE Rules include and Whole Workspace share reserved watcher classification',()=>fixture(async({tracker,dir})=>{
        caseIdentity(tracker,false);
        const visible=path.join(dir,'visible'),git=path.join(visible,'.git');
        fs.mkdirSync(git,{recursive:true});fs.writeFileSync(path.join(visible,'ProbeName'),'visible');
        const aliases=[[path.join(visible,'.GIT'),git],[path.join(visible,'.Git'),git],[path.join(visible,'probeName'),path.join(visible,'ProbeName')]];
        await withLookups(aliases,[],async()=>{
            tracker.getVsCodeWatcherExcludePatterns=()=>['visible/.GIT/**','visible/.DIFFTRACKER-RESTORE-*/**'];
            const requested=scopeFor(tracker,'rules');
            requested.includes=[{scope:'all',path:'visible'}];
            assert.equal(tracker.configuredScopeNeedsSupplementalCoverage(requested),undefined,
                'explicit-include intersection checks must consume the same hard-boundary-filtered patterns');
            tracker.getVsCodeWatcherExcludePatterns=()=>['visible/.DIFFTRACKER-RESTORE-*'];
            assert.ok(tracker.configuredScopeNeedsSupplementalCoverage(requested),
                'ordinary restore-prefixed files remain a coverage obligation in Rules mode');
        });
    },'rules'));

    test('PR12 CASE unknown identity and excessive brace variants remain fail closed',()=>fixture(async({tracker})=>{
        const identity=caseIdentity(tracker,false);
        assert.equal(tracker.watcherPatternOnlyTargetsHardBoundary('**/.GIT/**',{...identity,caseSensitive:undefined}),false);
        tracker.getVsCodeWatcherExcludePatterns=()=>[Array.from({length:25},()=>'{.GIT,.DIFFTRACKER-RESTORE-x}').join('/')];
        assert.match(tracker.configuredScopeNeedsSupplementalCoverage(scopeFor(tracker))??'',/expansion exceeds safe bound/);
    }));

    test('PR12 AUDIT watcher-failure gap participates in the same populated-directory projection',()=>fixture(async({tracker,dir})=>{
        const imported=path.join(dir,'populated-watch-failure-projection');
        fs.mkdirSync(imported);
        fs.writeFileSync(path.join(imported,'child.txt'),'current');

        const originalWatch=tracker.watchImportedTree.bind(tracker);
        const originalValidate=tracker.validateCandidatePersistenceProjection.bind(tracker);
        const originalFlush=tracker.flushPendingPersistence.bind(tracker);
        let projected=false;
        let flushed=false;
        tracker.watchImportedTree=async()=>{throw new Error('forced watcher installation failure');};
        tracker.validateCandidatePersistenceProjection=budget=>{
            const gap=tracker.coverageGaps.get(path.resolve(imported))?.subtree;
            assert.equal(gap?.reasonCode,'directory-runtime-coverage-gap',
                'watcher-failure gap must exist before the final persistence projection');
            projected=true;
            return originalValidate(budget);
        };
        tracker.flushPendingPersistence=async(...args)=>{
            if(projected){
                const gap=tracker.coverageGaps.get(path.resolve(imported))?.subtree;
                assert.equal(gap?.reasonCode,'directory-runtime-coverage-gap',
                    'watcher-failure gap must share the child-baseline durable flush');
                flushed=true;
            }
            return originalFlush(...args);
        };
        try {
            await tracker.onExternalFileCreated(Uri.file(imported));
            assert.equal(projected,true,'runtime populated-directory import must validate a final projection');
            assert.equal(flushed,true,'runtime populated-directory import must flush the combined projection');
            assert.equal(
                tracker.coverageGaps.get(path.resolve(imported))?.subtree?.reasonCode,
                'directory-runtime-coverage-gap'
            );
        } finally {
            tracker.watchImportedTree=originalWatch;
            tracker.validateCandidatePersistenceProjection=originalValidate;
            tracker.flushPendingPersistence=originalFlush;
        }
    }));

    test('PR12 AUDIT populated-directory failure gap is reserved before child baseline bytes',()=>fixture(async({tracker,dir})=>{
        const imported=path.join(dir,'populated-gap-reservation');fs.mkdirSync(imported);
        const child=path.join(imported,'child.txt');fs.writeFileSync(child,'current');
        const watcherFailureReason=
            'Imported directory watch coverage is incomplete; current files were scanned, but rebuild the baseline after reducing watched directories or resolving the system watcher limit';

        tracker.maxPersistedBytes=serialized(tracker)+100000;
        const probe=tracker.createCandidatePersistenceBudget();
        const beforeGap=probe.remainingBytes;
        tracker.reserveCandidateCoverageGap(imported,{
            targetKind:'subtree',
            reasonCode:'directory-runtime-coverage-gap',
            reason:watcherFailureReason
        },probe);
        const gapBytes=beforeGap-probe.remainingBytes;
        const beforeChild=probe.remainingBytes;
        tracker.consumeCandidatePersistenceBudget(
            child,
            {kind:'text',content:'',baselineExists:false},
            probe
        );
        const childBytes=beforeChild-probe.remainingBytes;
        assert.ok(gapBytes>0&&childBytes>0);

        tracker.maxPersistedBytes=serialized(tracker)+gapBytes+childBytes-1;
        const originalWatch=tracker.watchImportedTree.bind(tracker);
        tracker.watchImportedTree=async()=>{};
        try {
            await tracker.onExternalFileCreated(Uri.file(imported));
            assert.equal(tracker.fileSnapshots.has(child),false,
                'child baseline must not consume bytes reserved for mandatory failure evidence');
            assert.equal(
                tracker.coverageGaps.get(path.resolve(imported))?.subtree?.reasonCode,
                'directory-runtime-coverage-gap'
            );
            assert.equal(await tracker.flushPendingPersistence(),true,
                'the reserved failure gap must remain durably persistable after child-budget rejection');
        } finally {
            tracker.watchImportedTree=originalWatch;
        }
    }));

    test('PR12 AUDIT full coverage-gap ledger rejects populated imports before child mutation',()=>fixture(async({tracker,dir})=>{
        const existing=path.join(dir,'existing-gap');
        tracker.maxPersistedSnapshots=1;
        tracker.setSubtreeCoverageGap(existing,'existing-gap','existing durable gap',false);
        assert.equal(await tracker.flushPendingPersistence(),true);

        const imported=path.join(dir,'gap-count-full');fs.mkdirSync(imported);
        const child=path.join(imported,'child.txt');fs.writeFileSync(child,'current');
        const originalWatch=tracker.watchImportedTree.bind(tracker);
        let watchAttempted=false;
        const beforePauseEpoch=tracker.sessionEpoch;
        tracker.watchImportedTree=async()=>{watchAttempted=true;};
        try {
            await tracker.onExternalFileCreated(Uri.file(imported));
            assert.equal(watchAttempted,false,
                'mandatory gap capacity must be checked before watcher traversal or child capture');
            assert.equal(tracker.fileSnapshots.has(child),false);
            assert.equal(tracker.coverageGaps.has(path.resolve(imported)),false,
                'a rejected reservation must not create an over-limit non-durable gap');
            assert.equal(tracker.coverageGaps.size,1);
            assert.equal(tracker.isRecording,false,
                'recording must pause when mandatory coverage evidence cannot be reserved');
            assert.equal(tracker.baselineBuilding,true);
            assert.equal(tracker.snapshotInitialized,false);
            assert.equal(tracker.externalWatcherEnabled,false);
            assert.ok(tracker.sessionEpoch>beforePauseEpoch,
                'fail-closed pause must invalidate operations from the old coverage epoch');
            assert.equal(fs.existsSync(path.join(tracker.storageUri.fsPath,'session-state.unsaved')),true,
                'fail-closed pause must retain a durable unsaved marker');
        } finally {
            tracker.watchImportedTree=originalWatch;
        }
    }));

    test('PR12 AUDIT populated-directory creation stops child baseline publication at the byte budget',()=>fixture(async({tracker,dir})=>{
        const imported=path.join(dir,'populated-byte-budget');fs.mkdirSync(imported);
        const children=[];
        for(let i=0;i<20;i++){
            const child=path.join(imported,`child-${String(i).padStart(2,'0')}.txt`);
            fs.writeFileSync(child,'current');children.push(child);
        }
        tracker.maxPersistedBytes=serialized(tracker)+1500;
        await tracker.onExternalFileCreated(Uri.file(imported));
        const captured=children.filter(child=>tracker.fileSnapshots.has(child));
        assert.equal(captured.length,0,
            'capacity failure must roll back every child baseline from this populated-directory import');
        const importedIdentity=tracker.canonicalTrackingPath(imported);
        assert.ok(tracker.getSubtreeCoverageGaps().some(gap=>
            tracker.canonicalTrackingPath(gap.targetPath)===importedIdentity),
            'aborted populated-directory capture must preserve an explicit subtree reconciliation obligation');
    }));

    test('PR12 AUDIT restore additions validate late coverage evidence before publication',()=>fixture(async({tracker,dir})=>{
        const candidate=path.join(dir,'restore-projection-candidate.txt');
        fs.writeFileSync(candidate,'current');
        tracker.scanCoverage=tracker.ignoreFingerprint;
        const originalFind=tracker.findScopeFilesUnderDirectory.bind(tracker);
        const originalValidate=tracker.validateRestoreAdditionsProjection.bind(tracker);
        let injected=false,validated=false;
        tracker.findScopeFilesUnderDirectory=async()=>[Uri.file(candidate)];
        tracker.validateRestoreAdditionsProjection=additions=>{
            if(!injected){
                injected=true;
                tracker.setSubtreeCoverageGap(
                    path.join(dir,'late-restore-gap'),
                    'late-restore-gap',
                    'late restore evidence '.repeat(80),
                    false
                );
                tracker.maxPersistedBytes=serialized(tracker)+64;
            }
            validated=true;
            return originalValidate(additions);
        };
        try {
            await assert.rejects(
                ()=>tracker.discoverRestoredFiles(tracker.sessionEpoch),
                /Restored additions would exceed persisted byte capacity|schema\/count limits/i
            );
            assert.equal(validated,true);
            assert.equal(tracker.fileSnapshots.has(candidate),false);
            assert.equal(tracker.unresolvedBaselineFiles.has(candidate),false);
        } finally {
            tracker.findScopeFilesUnderDirectory=originalFind;
            tracker.validateRestoreAdditionsProjection=originalValidate;
        }
    }));

    test('PR12 AUDIT populated-directory durable flush failure rolls back children and persists the gap',()=>fixture(async({tracker,dir})=>{
        const imported=path.join(dir,'populated-durable-rollback');fs.mkdirSync(imported);
        const child=path.join(imported,'child.txt');fs.writeFileSync(child,'current');
        assert.equal(await tracker.flushPendingPersistence(),true);

        const originalWatch=tracker.watchImportedTree.bind(tracker);
        const originalFlush=tracker.flushPendingPersistence.bind(tracker);
        let flushes=0,forcedFailure=false;
        tracker.watchImportedTree=async()=>{};
        tracker.flushPendingPersistence=async(...args)=>{
            flushes++;
            if(!forcedFailure&&tracker.fileSnapshots.has(child)){
                forcedFailure=true;
                return false;
            }
            return originalFlush(...args);
        };
        try {
            await tracker.onExternalFileCreated(Uri.file(imported));
            assert.equal(forcedFailure,true,'test must reject the durable child publication');
            assert.ok(flushes>=2,
                'failed child publication must be followed by an immediate rollback persistence attempt');
            assert.equal(tracker.fileSnapshots.has(child),false,
                'failed durable publication must not retain the child absence baseline in memory');
            assert.equal(tracker.trackedChanges.has(child),false,
                'failed durable publication must not retain child review state');
            assert.equal(
                tracker.coverageGaps.get(path.resolve(imported))?.subtree?.reasonCode,
                'directory-runtime-coverage-gap'
            );
            const saved=JSON.parse(fs.readFileSync(path.join(tracker.storageUri.fsPath,'session-state.json'),'utf8'));
            assert.equal(saved.fileSnapshots.some(([target])=>path.resolve(target)===path.resolve(child)),false,
                'rolled-back child must not survive in the durable session');
            const savedGap=saved.coverageGaps.find(([target])=>path.resolve(target)===path.resolve(imported));
            assert.equal(savedGap?.[1]?.subtree?.reasonCode,'directory-runtime-coverage-gap',
                'durable rollback must retain the subtree reconciliation obligation');
        } finally {
            tracker.watchImportedTree=originalWatch;
            tracker.flushPendingPersistence=originalFlush;
        }
    }));

    test('PR12 AUDIT rollback preserves revisioned unresolved accounting maps',()=>fixture(async({tracker,dir})=>{
        const unresolved=path.join(dir,'rollback-unresolved.txt');
        tracker.unresolvedBaselineFiles.set(unresolved,'prior unknown evidence');
        const base={repoRoot:dir,kind:'repository',headName:'main',headCommit:'aaa',detached:false,inProgress:false};
        const current={...base,headName:'feature',headCommit:'bbb'};
        tracker.setBaselineGitContexts([base]);tracker.observeGitContext(current);
        assert.equal(await tracker.flushPendingPersistence(),true);
        const originalFind=tracker.findScopeFilesUnderDirectory.bind(tracker);
        tracker.findScopeFilesUnderDirectory=async()=>{throw new Error('forced rollback');};
        try {
            assert.equal(await tracker.rebuildRepositoryBaseline(dir,current),false);
            assert.equal(typeof tracker.unresolvedBaselineFiles.revision,'number',
                'repository rollback must restore UnresolvedBaselineMap rather than a plain Map');
            const before=tracker.unresolvedBaselineFiles.revision;
            tracker.unresolvedBaselineFiles.set(path.join(dir,'after.txt'),'after rollback');
            assert.ok(tracker.unresolvedBaselineFiles.revision>before);
        } finally {tracker.findScopeFilesUnderDirectory=originalFind;}
    }));


    test('PR12 AUDIT imported-tree watcher descends through unknown Dirent types',()=>fixture(async({tracker,dir})=>{
        const imported=path.join(dir,'unknown-dirent-watch');
        const nested=path.join(imported,'nested');
        fs.mkdirSync(nested,{recursive:true});
        const originalOpen=fs.promises.opendir;
        fs.promises.opendir=async(target,...args)=>{
            const handle=await originalOpen(target,...args);
            if(path.resolve(String(target))!==path.resolve(imported)) return handle;
            const originalRead=handle.readSync.bind(handle);
            handle.readSync=()=>{
                const entry=originalRead();
                if(!entry||entry.name!=='nested') return entry;
                return {
                    name:entry.name,
                    isDirectory:()=>false,
                    isFile:()=>false,
                    isSymbolicLink:()=>false
                };
            };
            return handle;
        };
        try {
            await tracker.watchImportedTree(imported,tracker.sessionEpoch);
            assert.ok(tracker.importedDirectoryWatchers.has(imported));
            assert.ok(tracker.importedDirectoryWatchers.has(nested),
                'unknown directory entries must use lstat fallback and receive direct imported-tree watchers');
        } finally {fs.promises.opendir=originalOpen;}
    }));

}
