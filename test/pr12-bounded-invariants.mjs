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
        assert.ok(captured.length<children.length,
            'the parent scan must abort instead of retaining every child after durable byte capacity is exhausted');
        assert.ok(tracker.getSubtreeCoverageGaps().some(gap=>gap.targetPath===imported),
            'aborted populated-directory capture must preserve an explicit subtree reconciliation obligation');
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
