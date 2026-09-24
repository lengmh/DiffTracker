import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function registerPR12BoundedInvariants(h) {
    const { test, vscode, Uri, DiffTracker, file, document, getTracker, setTracker } = h;
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
    }));

    test('PR12 AUDIT policy content has a cumulative byte bound before matcher publication',()=>fixture(async({tracker,scope,dir})=>{
        const target=path.join(dir,'.gitignore');fs.writeFileSync(target,'x'.repeat(512));
        h.setListedIgnores([Uri.file(target)]);tracker.maxPersistedBytes=128;
        const before=tracker.ignoreMatchers;
        try {
            const result=await tracker.preflightConfiguredMonitoringScope(scope,()=>true);
            assert.equal(result.status,'failed',JSON.stringify(result));assert.match(result.reason??'',/byte/i);
            assert.equal(tracker.ignoreMatchers,before);
        } finally {h.setListedIgnores([]);}
    }));

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

    test('PR12 AUDIT path identity discovery never materializes an unbounded root listing',async()=>{
        const {detectLocalPathCaseSensitivity}=await import('../out/utils/pathIdentity.js');
        const dir=file('identity-bounded');fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'ProbeName'),'probe');
        const oldOpen=fs.opendirSync,oldRead=fs.readdirSync;
        let reads=0,listings=0,closed=false;
        fs.opendirSync=(target,...args)=>path.resolve(String(target))===dir?{
            readSync(){reads++;return reads<=10001?{name:`entry-${reads}`,isSymbolicLink:()=>false}:null;},
            closeSync(){closed=true;}
        }:oldOpen(target,...args);
        fs.readdirSync=(target,...args)=>{if(path.resolve(String(target))===dir)listings++;return oldRead(target,...args);};
        try {
            assert.equal(detectLocalPathCaseSensitivity(dir),undefined,'an incomplete directory identity proof must remain unverified');
            assert.equal(listings,0);assert.ok(reads<=10001);assert.equal(closed,true);
        } finally {fs.opendirSync=oldOpen;fs.readdirSync=oldRead;}
    });

}
