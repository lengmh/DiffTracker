import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { registerScopeSingleActionCrashes } from './scope-single-action-crash.mjs';
import { registerScopeSingleActionAcceptance } from './scope-single-action-acceptance.mjs';
const require = createRequire(import.meta.url);

// Exercise the production tracker through the normal pause/withdraw/recheck
// paths. The shared fixture mocks VS Code, not scope or review algorithms.
export function registerScopeExclusionRecovery(h, fixture, scopeFor) {
    const { test, Uri, DiffTracker, setTracker, vscode } = h;
    async function paused(context) {
        const { tracker, dir, scope } = context;
        const subtree = path.join(dir, 'work-turns');
        fs.mkdirSync(subtree);
        const changed = path.join(subtree, 'changed.txt');
        const clean = path.join(subtree, 'clean.txt');
        const deleted = path.join(subtree, 'deleted.txt');
        const other = path.join(dir, 'other.txt');
        for (const file of [changed, clean, deleted, other]) { fs.writeFileSync(file, 'original'); }
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status, 'applied');
        for (const file of [changed, other]) {
            fs.writeFileSync(file, 'pending');
            await tracker.readFileAndUpdate(file, Uri.file(file));
        }
        const originalOther = tracker.getReviewToken(other);
        tracker.setPendingMonitoringScope(scopeFor(tracker, 'wholeWorkspace', [{ scope: 'all', pattern: '/work-turns/' }]));
        fs.writeFileSync(changed, 'changed during pause');
        fs.unlinkSync(deleted);
        tracker.setPendingMonitoringScope(undefined);
        assert.equal(tracker.getTrackedChange(changed)?.reviewKind, 'unknown');
        assert.equal((await tracker.resetUnknownBaseline(changed)).status, 'conflict');
        return { subtree, changed, clean, deleted, other, originalOther };
    }

    for (const reload of [false, true]) test(`SCOPE-RECOVERY withdrawn exclusion reconciles original baselines (reload=${reload})`, () => fixture(async context => {
        const files = await paused(context);
        let tracker = context.tracker;
        if (reload) {
            const storage = tracker.storageUri;
            assert.equal(await tracker.flushPendingPersistence(), true);
            await tracker.dispose();
            tracker = new DiffTracker(storage); setTracker(tracker);
            assert.equal(await tracker.restorePersistedState(), 'restored');
        }
        const otherToken = tracker.getReviewToken(files.other);
        const result = await tracker.recheckObservationCoverage();
        assert.equal(result.status, 'rechecked', JSON.stringify(result));
        assert.equal(tracker.getOriginalContent(files.changed), 'original');
        assert.equal(tracker.getTrackedChange(files.changed)?.reviewKind, 'text');
        assert.equal(tracker.getTrackedChange(files.changed)?.currentContent, 'changed during pause');
        assert.equal(tracker.getTrackedChange(files.clean), undefined, 'clean baselines must not remain phantom reviews');
        assert.equal(tracker.getTrackedChange(files.deleted)?.isDeleted, true);
        assert.deepEqual(tracker.getReviewToken(files.other), otherToken);
        assert.equal(tracker.getOriginalContent(files.other), 'original');
        assert.equal(fs.readFileSync(files.changed, 'utf8'), 'changed during pause');
        assert.equal(fs.existsSync(files.deleted), false);
        assert.deepEqual(tracker.getCoverageGaps(), []);
        assert.equal(await tracker.flushPendingPersistence(), true);
        const saved = JSON.parse(fs.readFileSync(path.join(tracker.storageUri.fsPath, 'session-state.json'), 'utf8'));
        assert.equal(new Map(saved.fileSnapshots).get(files.changed), 'original');
        assert.deepEqual(saved.coverageGaps, []);
    }));

    test('SCOPE-RECOVERY unknown before-image stays unknown after observation repair and requires explicit Reset', () => fixture(async context => {
        const { tracker, dir, scope } = context;
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status, 'applied');
        tracker.setPendingMonitoringScope(scopeFor(tracker, 'wholeWorkspace', [{ scope: 'all', pattern: '/unseen.txt' }]));
        const target = path.join(dir, 'unseen.txt');
        fs.writeFileSync(target, 'unobserved content');
        await tracker.onExternalFileCreated(Uri.file(target));
        tracker.setPendingMonitoringScope(undefined);
        assert.equal(tracker.getOriginalContent(target), undefined);
        assert.equal((await tracker.recheckObservationCoverage()).status, 'rechecked');
        assert.equal(tracker.getTrackedChange(target)?.reviewKind, 'unknown');
        assert.equal(tracker.getOriginalContent(target), undefined, 'Recheck is not Accept or Reset');
        assert.equal((await tracker.resetUnknownBaseline(target)).status, 'success');
        assert.equal(tracker.getOriginalContent(target), 'unobserved content');
    }));

    test('SCOPE-RECOVERY real file gaps are not blanket-cleared with withdrawn exclusion markers', () => fixture(async context => {
        const files = await paused(context);
        const { tracker } = context;
        tracker.setFileCoverageGap(files.other, 'file-read-failed', 'Independent unverified read');
        tracker.markFileUnavailable(files.other, 'Independent unverified read');
        assert.equal((await tracker.recheckObservationCoverage()).status, 'limited');
        assert.equal(tracker.coverageGaps.get(files.other)?.file?.reasonCode, 'file-read-failed');
        assert.equal(tracker.getTrackedChange(files.changed)?.reviewKind, 'text');
        assert.equal(tracker.getTrackedChange(files.other)?.reviewKind, 'unknown');
        assert.equal((await tracker.resetUnknownBaseline(files.other)).status, 'conflict');
    }));

    for (const blocked of ['stopped', 'dirty', 'pending']) test(`SCOPE-RECOVERY refuses ${blocked} without consuming legacy evidence`, () => fixture(async context => {
        const files = await paused(context);
        const { tracker } = context;
        if (blocked === 'stopped') { tracker.stopRecording(); }
        if (blocked === 'pending') { tracker.setPendingMonitoringScope(scopeFor(tracker, 'wholeWorkspace', [{ scope: 'all', pattern: '/work-turns/' }])); }
        if (blocked === 'dirty') { vscode.workspace.textDocuments.push({ uri: Uri.file(files.changed), isDirty: true }); }
        const gaps = JSON.stringify(tracker.getCoverageGaps());
        const review = JSON.stringify(tracker.getTrackedChanges());
        try {
            assert.equal((await tracker.recheckObservationCoverage()).status, 'conflict');
            assert.equal(JSON.stringify(tracker.getCoverageGaps()), gaps);
            assert.equal(JSON.stringify(tracker.getTrackedChanges()), review);
            assert.equal(tracker.getOriginalContent(files.changed), 'original');
        } finally { if (blocked === 'dirty') { vscode.workspace.textDocuments.pop(); } }
    }));
    async function withController(tracker, scope, run, options = {}) {
        const oldConfig = vscode.workspace.getConfiguration;
        const oldEvent = vscode.workspace.onDidChangeConfiguration;
        const handlers = [];
        const config = { monitoringScope: scope.mode, watchInclude: scope.includes, watchExclude: scope.excludes };
        const writes = [];
        const hooks = {};
        const settings = new Map();
        const configurationPublications = [];
        const notifyConfiguration = key => {
            h.fireConfigurationChanged(`diffTracker.${key}`);
            for (const handler of [...handlers]) { handler({ affectsConfiguration: name => name === `diffTracker.${key}` }); }
        };
        vscode.workspace.onDidChangeConfiguration = handler => { handlers.push(handler); return { dispose() {} }; };
        vscode.workspace.getConfiguration = (...args) => ({
            ...oldConfig(...args),
            get: (key, fallback) => Object.hasOwn(config, key) ? config[key] : oldConfig(...args).get(key, fallback),
            inspect: key => ({ workspaceValue: config[key],
                workspaceFolderValue:options.singleFolderAlias && args[1]
                    ? hooks.folderValue ? hooks.folderValue(key) : config[key] : undefined }),
            update: async (key, value) => {
                writes.push([key, value]);
                const publish = async () => {
                    config[key] = structuredClone(value);
                    await hooks.afterWrite?.(key, value);
                    notifyConfiguration(key);
                };
                if(hooks.update){return hooks.update(key,value,publish);}
                await hooks.beforeWrite?.(key, value);
                await new Promise(resolve => setImmediate(resolve));
                if (options.deferConfigurationReadback?.(key)) {
                    configurationPublications.push(new Promise((resolve, reject) => {
                        setImmediate(() => { void publish().then(resolve, reject); });
                    }));
                } else { await publish(); }
            }
        });
        const oldLoad = Module._load;
        let Controller;
        try {
            Module._load = function(id, ...args) { return id === 'vscode' ? vscode : oldLoad.call(this, id, ...args); };
            Controller = require('../out/monitoringScopeController.js').MonitoringScopeController;
        } finally { Module._load = oldLoad; }
        const controller = new Controller({ workspaceState: {
            get: key => settings.get(key), update: async (key, value) => {
                await hooks.beforeStateUpdate?.(key, value);
                settings.set(key, value);
                await hooks.afterStateUpdate?.(key, value);
            }
        } }, tracker);
        try { await run({ controller, config, writes, hooks, notifyConfiguration }); }
        finally {
            await Promise.all(configurationPublications);
            controller.dispose();
            try { await tracker.ignoreRefreshPromise; }
            catch (error) {
                if (!options.expectBlockedPolicy || !tracker.recoveryBlocked) { throw error; }
                assert.match(error.message, /Committed resource-scoped legacy watchExclude policy is unavailable/);
            }
            vscode.workspace.getConfiguration = oldConfig;
            vscode.workspace.onDidChangeConfiguration = oldEvent;
        }
    }

    test('EXCLUDES owned configuration publication completes Save and Apply without another user action', () => fixture(async ({tracker,scope,dir}) => {
        fs.mkdirSync(path.join(dir,'generated-cache'));
        await withController(tracker,scope,async ({controller}) => {
            const outcome = await controller.saveAndApplyScope({mode:'wholeWorkspace',includes:[],excludes:[
                {scope:'all',pattern:'/prior-cache/'},
                {scope:'all',pattern:'/generated-cache/'}
            ]},async()=>true);
            assert.equal(outcome.status,'applied',JSON.stringify(outcome));
            const status = controller.getStatus();
            assert.equal(status.requested.scope.scopeRevision,status.effective.scopeRevision);
            assert.deepEqual(status.effective.excludes,[
                {scope:'all',pattern:'/generated-cache/'},
                {scope:'all',pattern:'/prior-cache/'}
            ]);
        },{deferConfigurationReadback:key=>key==='watchExclude'});
    },'wholeWorkspace',[{scope:'all',pattern:'/prior-cache/'}]));

    for(const kind of ['save','shortcut']) for(const boundary of ['acknowledgement','publication','rejection'])
    test(`EXCLUDES uncertain ${kind} ${boundary} preserves settings and fences late writes without applying`,()=>fixture(async({tracker,scope,dir})=>{
        const selected=path.join(dir,'generated-cache');fs.mkdirSync(selected);
        tracker.setSubtreeCoverageGap(selected,'supplemental-watcher-runtime-gap','Prior interval');
        await withController(tracker,scope,async({controller,config,writes,hooks})=>{
            const timer=globalThis.setTimeout;let deadline,release,publishLate,action;
            const response=new Promise(resolve=>{release=resolve;});
            globalThis.setTimeout=(callback,ms,...args)=>{
                if(ms===2000){deadline=()=>callback(...args);return timer(()=>{},60000);}
                return timer(callback,ms,...args);
            };
            try{
                hooks.update=async(key,value,publish)=>{
                    if(key!=='watchExclude'){await publish();return;}
                    publishLate=publish;
                    if(boundary==='acknowledgement'){await response;await publish();}
                    if(boundary==='rejection'){throw new Error('Rejected after an unverified write');}
                };
                const proposal={mode:'wholeWorkspace',includes:[],excludes:[{scope:'all',pattern:'/generated-cache/'}]};
                action=kind==='save' ? controller.saveAndApplyScope(proposal,async()=>true)
                    : controller.excludeCoverageSubtree(selected,async()=>true);
                for(let sample=0;sample<10&&!publishLate;sample++){await new Promise(resolve=>setImmediate(resolve));}
                assert.equal(typeof publishLate,'function');
                if(boundary!=='rejection'){
                    assert.equal(typeof deadline,'function','the API response and publication share a bounded deadline');
                    deadline();
                }
                const outcome=await action;
                assert.equal(outcome.status,'partial',JSON.stringify(outcome));
                assert.equal(outcome.scopeCommitted,false);
                assert.equal(controller.getStatus().effective.scopeRevision,scope.scopeRevision);
                assert.equal(controller.hasPendingScopeSettingsWrites(),true,'an unverified late write must retain its fence');
                const count=writes.length;
                assert.equal((await controller.saveAndApplyScope(proposal,async()=>true)).status,'conflict');
                assert.equal((await controller.applyPendingScope()).status,'conflict');
                assert.equal((await controller.restoreEffectiveScopeConfiguration()).status,'conflict');
                assert.equal((await controller.recheckObservationCoverage()).status,'conflict');
                assert.equal(writes.length,count,'neither compensation nor reentry may write across uncertainty');
                assert.ok(tracker.getSubtreeCoverageGaps().some(gap=>gap.targetPath===selected));
                release();await response;
                if(boundary!=='acknowledgement'){await publishLate();}
                for(let sample=0;sample<10&&controller.hasPendingScopeSettingsWrites();sample++){await new Promise(resolve=>setImmediate(resolve));}
                assert.equal(controller.hasPendingScopeSettingsWrites(),false);
                assert.deepEqual(config.watchExclude,proposal.excludes);
                assert.equal(controller.getStatus().effective.scopeRevision,scope.scopeRevision,'late settlement cannot auto-apply');
                const applied=await controller.applyPendingScope();
                assert.equal(applied.status,'applied',JSON.stringify(applied));
                assert.equal(writes.length,count,'Apply Saved Request consumes the settled request without rewriting it');
                assert.equal(controller.getStatus().requested.scope.scopeRevision,controller.getStatus().effective.scopeRevision);
                assert.equal(tracker.getSubtreeCoverageGaps().some(gap=>gap.targetPath===selected),false);
            }finally{
                release();globalThis.setTimeout=timer;await action?.catch(()=>{});
            }
        });
    }));

    test('EXCLUDES a rejected response with proved publication permits exact compensation',()=>fixture(async({tracker,scope})=>{
        await withController(tracker,scope,async({controller,config,hooks})=>{
            const before=structuredClone(config);let rejected=false;
            hooks.update=async(key,value,publish)=>{
                await publish();
                if(key==='watchExclude'&&!rejected){rejected=true;throw new Error('Rejected after observable publication');}
            };
            const result=await controller.saveAndApplyScope({mode:'wholeWorkspace',includes:[],
                excludes:[{scope:'all',pattern:'/generated-cache/'}]},async()=>true);
            assert.equal(result.status,'failed',JSON.stringify(result));assert.equal(result.settingsStatus,'restored');
            assert.deepEqual(config,before);assert.equal(controller.hasPendingScopeSettingsWrites(),false);
        });
    }));

    for(const kind of ['save-only','restore']) for(const stopped of [false,true])
    test(`EXCLUDES ${kind} settles its three owned keys and preserves review (stopped=${stopped})`,()=>fixture(async({tracker,scope,dir})=>{
        const target=path.join(dir,'pending.txt');fs.writeFileSync(target,'baseline');
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status,'applied');
        fs.writeFileSync(target,'pending');await tracker.readFileAndUpdate(target,Uri.file(target));
        if(stopped){tracker.stopRecording();}const token=tracker.getReviewToken(target);
        await withController(tracker,scope,async({controller,config,notifyConfiguration,writes})=>{
            const proposal={mode:'wholeWorkspace',includes:[],excludes:[{scope:'all',pattern:'/generated-cache/'}]};
            if(kind==='restore'){
                config.watchExclude=proposal.excludes;notifyConfiguration('watchExclude');
                const result=await controller.restoreEffectiveScopeConfiguration();
                assert.equal(result.status,'restored',JSON.stringify(result));assert.deepEqual(config.watchExclude,[]);
            }else{
                const saved=await controller.saveRequestedScope(proposal,{expectedRequestVersion:controller.getRequestVersion()});
                assert.equal(saved.ok,true,JSON.stringify(saved));
                assert.equal(controller.getStatus().effective.scopeRevision,scope.scopeRevision,'Save Request Only must not apply');
                const applied=await controller.applyPendingScope();assert.equal(applied.status,'applied',JSON.stringify(applied));
            }
            assert.equal(writes.length,3);assert.deepEqual(tracker.getReviewToken(target),token);
            assert.equal(tracker.getOriginalContent(target),'baseline');assert.equal(tracker.getIsRecording(),!stopped);
            assert.equal(controller.getStatus().requested.scope.scopeRevision,controller.getStatus().effective.scopeRevision);
        },{deferConfigurationReadback:()=>true});
    }));

    test('EXCLUDES shortcut compensation has a bounded response and preserves its unresolved fence',()=>fixture(async({tracker,scope,dir})=>{
        const selected=path.join(dir,'generated-cache');fs.mkdirSync(selected);
        tracker.setSubtreeCoverageGap(selected,'supplemental-watcher-runtime-gap','Prior interval');
        await withController(tracker,scope,async({controller,config,writes,hooks})=>{
            const timer=globalThis.setTimeout;let deadline,release,compensation=false,current=true,action;
            const response=new Promise(resolve=>{release=resolve;});
            globalThis.setTimeout=(callback,ms,...args)=>{
                if(ms===2000){deadline=()=>callback(...args);return timer(()=>{},60000);}
                return timer(callback,ms,...args);
            };
            hooks.update=async(_key,_value,publish)=>{
                if(writes.length===1){await publish();current=false;}
                else{compensation=true;await response;await publish();}
            };
            try{
                action=controller.excludeCoverageSubtree(selected,async()=>true,()=>current);
                for(let sample=0;sample<30&&!compensation;sample++){await new Promise(resolve=>setImmediate(resolve));}
                assert.equal(compensation,true);deadline();
                const result=await action;
                assert.equal(result.status,'partial',JSON.stringify(result));assert.equal(result.scopeCommitted,false);
                assert.equal(controller.hasPendingScopeSettingsWrites(),true);assert.equal(writes.length,2);
                assert.deepEqual(config.watchExclude,[{scope:'all',pattern:'/generated-cache/'}]);
                release();for(let sample=0;sample<10&&controller.hasPendingScopeSettingsWrites();sample++){await new Promise(resolve=>setImmediate(resolve));}
                assert.equal(controller.hasPendingScopeSettingsWrites(),false);assert.deepEqual(config.watchExclude,[]);
                assert.equal(controller.getStatus().effective.scopeRevision,scope.scopeRevision);
                assert.ok(tracker.getSubtreeCoverageGaps().some(gap=>gap.targetPath===selected));
            }finally{release();globalThis.setTimeout=timer;await action?.catch(()=>{});}
        });
    }));

    test('EXCLUDES disposal releases an unresponsive action without applying its late saved request',()=>fixture(async({tracker,scope})=>{
        await withController(tracker,scope,async({controller,config,writes,hooks})=>{
            let release,entered=false,completed=false;
            const response=new Promise(resolve=>{release=resolve;});
            hooks.update=async(key,_value,publish)=>{
                if(key==='watchExclude'){entered=true;await response;}
                await publish();
            };
            const proposal={mode:'wholeWorkspace',includes:[],excludes:[{scope:'all',pattern:'/generated-cache/'}]};
            const action=controller.saveAndApplyScope(proposal,async()=>true).then(result=>{completed=true;return result;});
            try{
                for(let sample=0;sample<10&&!entered;sample++){await new Promise(resolve=>setImmediate(resolve));}
                assert.equal(entered,true);controller.dispose();
                for(let sample=0;sample<10&&!completed;sample++){await new Promise(resolve=>setImmediate(resolve));}
                assert.equal(completed,true,'disposing cannot wait indefinitely for the settings service');
                assert.equal((await action).status,'partial');assert.equal(controller.hasPendingScopeSettingsWrites(),false);
                const count=writes.length;release();
                for(let sample=0;sample<10&&config.watchExclude.length===0;sample++){await new Promise(resolve=>setImmediate(resolve));}
                assert.deepEqual(config.watchExclude,proposal.excludes);assert.equal(writes.length,count);
                assert.equal(tracker.getEffectiveMonitoringScope().scopeRevision,scope.scopeRevision);
                const settings=new Map(),reloaded=new controller.constructor({workspaceState:{
                    get:key=>settings.get(key),update:async(key,value)=>settings.set(key,value)
                }},tracker);
                try{
                    assert.notEqual(reloaded.getStatus().requested.scope.scopeRevision,reloaded.getStatus().effective.scopeRevision);
                    assert.equal((await reloaded.applyPendingScope()).status,'applied');
                    assert.equal(reloaded.getStatus().requested.scope.scopeRevision,reloaded.getStatus().effective.scopeRevision);
                }finally{reloaded.dispose();}
            }finally{release();await action;}
        });
    }));

    for(const action of ['shortcut','save']) for(const phase of ['ignore','persist'])
    test(`EXCLUDES settled settings-file notification completes one ${action} action (${phase})`, () => fixture(async ({tracker,scope,dir}) => {
        const selected=path.join(dir,'generated-cache');fs.mkdirSync(selected);
        const settingsFile=path.join(dir,'.vscode','settings.json');fs.mkdirSync(path.dirname(settingsFile));
        fs.writeFileSync(settingsFile,'{}');
        const unrelated=path.join(dir,'unrelated.txt');fs.writeFileSync(unrelated,'before');
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status,'applied');
        h.setListedFiles([Uri.file(settingsFile),Uri.file(unrelated)]);
        tracker.startRecording();await h.waitUntil(()=>tracker.getBaselineState()==='ready');
        assert.equal(tracker.getOriginalContent(settingsFile),'{}');
        fs.writeFileSync(unrelated,'pending');await tracker.readFileAndUpdate(unrelated,Uri.file(unrelated));
        const token=tracker.getReviewToken(unrelated);
        tracker.setSubtreeCoverageGap(selected,'supplemental-watcher-runtime-gap','Prior interval');
        await withController(tracker,scope,async({controller,hooks,config,writes})=>{
            let wrote=false,injected=false;
            hooks.afterWrite=()=>{fs.writeFileSync(settingsFile,JSON.stringify(config));wrote=true;};
            const notify=()=>{
                if(wrote&&!injected&&tracker.baselineTransaction){
                    injected=true;tracker.dispatchExternalEvent(Uri.file(settingsFile),'change',tracker.sessionEpoch);
                }
            };
            const opendir=fs.promises.opendir,write=vscode.workspace.fs.writeFile;
            fs.promises.opendir=async(directory,...args)=>{const result=await opendir(directory,...args);if(phase==='ignore'){notify();}return result;};
            vscode.workspace.fs.writeFile=async(...args)=>{await write(...args);if(phase==='persist'){notify();}};
            try{
                const outcome=action==='shortcut'?await controller.excludeCoverageSubtree(selected,async()=>true):
                    await controller.saveAndApplyScope({mode:'rules',includes:[],excludes:[{scope:'all',pattern:'/generated-cache/'}]},async()=>true);
                assert.equal(injected,true);
                assert.equal(outcome.status,'applied',JSON.stringify(outcome));
                assert.equal(outcome.scopeCommitted,true);
                assert.equal(writes.length,action==='shortcut'?1:3,'no repeated configuration writes');
                assert.equal(tracker.getOriginalContent(settingsFile),'{}');
                assert.equal(tracker.getTrackedChange(settingsFile)?.currentContent,JSON.stringify(config));
                assert.deepEqual(tracker.getReviewToken(unrelated),token);
                assert.equal(tracker.getSubtreeCoverageGaps().some(gap=>gap.targetPath===selected),false);
            }finally{fs.promises.opendir=opendir;vscode.workspace.fs.writeFile=write;}
        });
    },'rules'));

    for(const change of ['other-file','settings-bytes','settings-identity','commit-bytes','commit-identity','dirty','stop','budget'])
    test(`EXCLUDES settings proof retains transaction and compensation protection (${change})`, () => fixture(async ({tracker,scope,dir}) => {
        const selected=path.join(dir,'generated-cache');fs.mkdirSync(selected);
        const settingsFile=path.join(dir,'.vscode','settings.json');fs.mkdirSync(path.dirname(settingsFile));
        fs.writeFileSync(settingsFile,'{}');
        const other=path.join(dir,'other.txt');fs.writeFileSync(other,'original');
        h.setListedFiles([Uri.file(settingsFile),Uri.file(other)]);
        tracker.startRecording();await h.waitUntil(()=>tracker.getBaselineState()==='ready');
        const original=tracker.getOriginalContent(settingsFile);
        await withController(tracker,scope,async({controller,hooks,config,writes})=>{
            let wrote=false,injected=false,external,commitChanged=false;
            hooks.afterWrite=()=>{fs.writeFileSync(settingsFile,JSON.stringify(config));wrote=true;};
            const opendir=fs.promises.opendir,write=vscode.workspace.fs.writeFile;
            vscode.workspace.fs.writeFile=async(...args)=>{
                await write(...args);
                if(change.startsWith('commit-')&&injected&&!commitChanged&&tracker.baselineTransaction){
                    commitChanged=true;
                    external=JSON.stringify({...config,independentAtCommit:true});
                    if(change==='commit-identity'){fs.renameSync(settingsFile,`${settingsFile}.previous`);}
                    // No subsequent event: the durable barrier must check the
                    // actual file instead of trusting the earlier notification.
                    fs.writeFileSync(settingsFile,external);
                }
            };
            fs.promises.opendir=async(directory,...args)=>{
                const result=await opendir(directory,...args);
                if(wrote&&!injected&&tracker.baselineTransaction){
                    injected=true;
                    if(change==='other-file'){
                        fs.writeFileSync(other,'independent edit');tracker.dispatchExternalEvent(Uri.file(other),'change',tracker.sessionEpoch);
                    }else{
                        if(change==='settings-bytes'){external=JSON.stringify({...config,independent:true});fs.writeFileSync(settingsFile,external);}
                        if(change==='settings-identity'){external=fs.readFileSync(settingsFile,'utf8');fs.renameSync(settingsFile,`${settingsFile}.previous`);fs.writeFileSync(settingsFile,external);}
                        if(change==='dirty'){vscode.workspace.textDocuments.push({uri:Uri.file(settingsFile),isDirty:true});}
                        if(change==='stop'){tracker.stopRecording();}
                        for(let i=0;i<(change==='budget'?20:1);i++){
                            tracker.dispatchExternalEvent(Uri.file(settingsFile),'change',tracker.sessionEpoch);
                        }
                    }
                }
                return result;
            };
            try{
                const outcome=await controller.saveAndApplyScope({mode:'rules',includes:[],excludes:[{scope:'all',pattern:'/generated-cache/'}]},async()=>true);
                assert.equal(injected,true);
                assert.notEqual(outcome.status,'applied',JSON.stringify(outcome));
                assert.equal(outcome.scopeCommitted,false);
                assert.equal(controller.getStatus().effective.scopeRevision,scope.scopeRevision);
                assert.equal(tracker.getOriginalContent(settingsFile),original);
                if(change==='settings-bytes'||change==='settings-identity'||change.startsWith('commit-')){
                    if(change.startsWith('commit-')){assert.equal(commitChanged,true);}
                    assert.equal(outcome.status,'partial');
                    assert.equal(writes.length,3,'do not compensate over an unowned physical settings revision');
                    assert.equal(fs.readFileSync(settingsFile,'utf8'),external);
                }
                if(change==='other-file'){
                    assert.equal(fs.readFileSync(other,'utf8'),'independent edit');
                    assert.equal(outcome.settingsStatus,'restored','an unrelated event does not forfeit physical settings ownership');
                }
                if(change==='stop'){assert.equal(tracker.getIsRecording(),false);}
            }finally{fs.promises.opendir=opendir;vscode.workspace.fs.writeFile=write;if(change==='dirty'){vscode.workspace.textDocuments.pop();}}
        });
    },'rules'));

    for(const independent of ['workspace-file','different-folder-value'])
    test(`EXCLUDES owned save retains independent Folder guard (${independent})`, () => fixture(async ({tracker,scope}) => {
        const workspaceFile=vscode.workspace.workspaceFile;
        try{
            if(independent==='workspace-file'){vscode.workspace.workspaceFile=Uri.file('scope-test.code-workspace');}
            await withController(tracker,scope,async({controller,hooks,config})=>{
                if(independent==='different-folder-value'){
                    let changed=false;
                    hooks.afterWrite=key=>{if(key==='watchExclude'){changed=true;}};
                    hooks.folderValue=key=>key==='watchExclude'&&changed
                        ? [{scope:'all',pattern:'/independent-folder/'}] : config[key];
                }
                const outcome=await controller.saveAndApplyScope({mode:'wholeWorkspace',includes:[],
                    excludes:[{scope:'all',pattern:'/generated-cache/'}]},async()=>true);
                assert.equal(outcome.status,'partial',JSON.stringify(outcome));
                assert.equal(outcome.scopeCommitted,false);
                assert.equal(controller.getStatus().effective.scopeRevision,scope.scopeRevision);
                assert.deepEqual(config.watchExclude,[{scope:'all',pattern:'/generated-cache/'}]);
            },{singleFolderAlias:true});
        }finally{vscode.workspace.workspaceFile=workspaceFile;}
    },'wholeWorkspace',[{scope:'all',pattern:'/prior-cache/'}]));

    test('EXCLUDES coverage shortcut settles its saved exclusion and retires only its target gap', () => fixture(async ({tracker,scope,dir}) => {
        const selected = path.join(dir,'generated-cache');
        fs.mkdirSync(selected);
        tracker.setSubtreeCoverageGap(selected,'supplemental-watcher-runtime-gap','Prior observation interval is unverified');
        await withController(tracker,scope,async ({controller}) => {
            const outcome = await controller.excludeCoverageSubtree(selected,async()=>true);
            assert.equal(outcome.status,'applied',JSON.stringify(outcome));
            assert.equal(controller.getStatus().requested.scope.scopeRevision,controller.getStatus().effective.scopeRevision);
            assert.equal(tracker.getSubtreeCoverageGaps().some(gap=>gap.targetPath===selected),false);
        },{deferConfigurationReadback:key=>key==='watchExclude'});
    },'wholeWorkspace',[{scope:'all',pattern:'/prior-cache/'}]));

    test('EXCLUDES single-folder Workspace and Folder aliases retain owned Save and Apply authority', () => fixture(async ({tracker,scope}) => {
        await withController(tracker,scope,async({controller})=>{
            const outcome=await controller.saveAndApplyScope({mode:'wholeWorkspace',includes:[],
                excludes:[{scope:'all',pattern:'/generated-cache/'}]},async()=>true);
            assert.equal(outcome.status,'applied',JSON.stringify(outcome));
            assert.equal(controller.getStatus().requested.scope.scopeRevision,controller.getStatus().effective.scopeRevision);
        },{singleFolderAlias:true});
    },'wholeWorkspace',[{scope:'all',pattern:'/prior-cache/'}]));

    test('EXCLUDES changing workspace layout cannot turn an independent source into an owned alias', () => fixture(async ({tracker,scope}) => {
        const workspaceFile=vscode.workspace.workspaceFile;
        vscode.workspace.workspaceFile=Uri.file('independent.code-workspace');
        try{
            await withController(tracker,scope,async({controller,hooks,config})=>{
                hooks.afterWrite=key=>{if(key==='watchExclude'){vscode.workspace.workspaceFile=undefined;}};
                const outcome=await controller.saveAndApplyScope({mode:'wholeWorkspace',includes:[],
                    excludes:[{scope:'all',pattern:'/generated-cache/'}]},async()=>true);
                assert.equal(outcome.status,'partial',JSON.stringify(outcome));
                assert.equal(outcome.scopeCommitted,false);
                assert.deepEqual(config.watchExclude,[{scope:'all',pattern:'/generated-cache/'}]);
                assert.equal(controller.getStatus().effective.scopeRevision,scope.scopeRevision);
            },{singleFolderAlias:true});
        }finally{vscode.workspace.workspaceFile=workspaceFile;}
    },'wholeWorkspace',[{scope:'all',pattern:'/prior-cache/'}]));

    test('EXCLUDES an observed competing edit cannot be compensated away when its final value matches the proposal', () => fixture(async ({tracker,scope}) => {
        const proposal = {mode:'wholeWorkspace',includes:[],excludes:[{scope:'all',pattern:'/generated-cache/'}]};
        await withController(tracker,scope,async ({controller,config,hooks,notifyConfiguration}) => {
            let injected = false;
            hooks.afterWrite = (key,value) => {
                if (key !== 'watchExclude' || injected) { return; }
                injected = true;
                config.watchExclude = [{scope:'all',pattern:'/independent-choice/'}];
                notifyConfiguration('watchExclude');
                // A second external edit chooses the same value as the pending
                // operation. It does not renew that operation's write ownership.
                config.watchExclude = structuredClone(value);
            };
            const outcome = await controller.saveAndApplyScope(proposal,async()=>true);
            assert.equal(outcome.status,'partial',JSON.stringify(outcome));
            assert.equal(outcome.scopeCommitted,false);
            assert.deepEqual(config.watchExclude,proposal.excludes,'the last external choice must survive compensation');
            assert.equal(controller.getStatus().effective.scopeRevision,scope.scopeRevision);
        });
    }));

    test('EXCLUDES shortcut preserves an observed external choice even when it matches the exclusion it proposed', () => fixture(async ({tracker,scope,dir}) => {
        const selected = path.join(dir,'generated-cache');
        fs.mkdirSync(selected);
        tracker.setSubtreeCoverageGap(selected,'supplemental-watcher-runtime-gap','Prior observation interval is unverified');
        await withController(tracker,scope,async ({controller,config,hooks,notifyConfiguration}) => {
            let injected = false;
            let externalChoice;
            hooks.afterWrite = (key,value) => {
                if (key !== 'watchExclude' || injected) { return; }
                injected = true;
                config.watchExclude = [{scope:'all',pattern:'/independent-choice/'}];
                notifyConfiguration('watchExclude');
                externalChoice = structuredClone(value);
                config.watchExclude = externalChoice;
            };
            const outcome = await controller.excludeCoverageSubtree(selected,async()=>true);
            assert.equal(outcome.status,'partial',JSON.stringify(outcome));
            assert.equal(outcome.scopeCommitted,false);
            assert.deepEqual(config.watchExclude,externalChoice,'the shortcut must not restore over observed external intent');
            assert.equal(controller.getStatus().effective.scopeRevision,scope.scopeRevision);
        });
    }));

    test('EXCLUDES compensation settles its owned configuration publication before reporting restored settings', () => fixture(async ({tracker,scope}) => {
        await withController(tracker,scope,async ({controller,config,hooks}) => {
            const before=structuredClone(config);
            let failed=false;
            hooks.beforeWrite=key=>{
                if(key==='watchInclude'&&!failed){failed=true;throw new Error('Controlled write rejection');}
            };
            const outcome=await controller.saveAndApplyScope({mode:'rules',includes:[],
                excludes:[{scope:'all',pattern:'/generated-cache/'}]},async()=>true);
            assert.equal(outcome.status,'failed',JSON.stringify(outcome));
            assert.equal(outcome.settingsStatus,'restored',JSON.stringify(outcome));
            assert.deepEqual(config,before);
            assert.equal(controller.getStatus().effective.scopeRevision,scope.scopeRevision);
        },{deferConfigurationReadback:key=>key==='monitoringScope'});
    }));

    test('EXCLUDES an external withdrawal after owned publication cannot renew save authority', () => fixture(async ({tracker,scope}) => {
        await withController(tracker,scope,async ({controller,config,hooks,notifyConfiguration}) => {
            hooks.afterWrite=(key,value)=>{
                if(key!=='watchExclude'){return;}
                notifyConfiguration(key);
                config.watchExclude=scope.excludes;
                notifyConfiguration(key);
                config.watchExclude=structuredClone(value);
            };
            const proposal={mode:'wholeWorkspace',includes:[],excludes:[{scope:'all',pattern:'/generated-cache/'}]};
            const outcome=await controller.saveAndApplyScope(proposal,async()=>true);
            assert.equal(outcome.status,'partial',JSON.stringify(outcome));
            assert.equal(outcome.scopeCommitted,false);
            assert.deepEqual(config.watchExclude,proposal.excludes);
            assert.equal(controller.getStatus().effective.scopeRevision,scope.scopeRevision);
        });
    }));

    test('EXCLUDES legacy unnamed diagnostic stops prescribing a rebuild without changing saved evidence', () => fixture(async ({tracker,dir}) => {
        const selected = path.join(dir,'generated-cache');
        fs.mkdirSync(selected);
        const oldReason = 'Supplemental watcher returned an unnamed event; current subtree state requires a baseline rebuild.';
        tracker.setSubtreeCoverageGap(selected,'supplemental-watcher-runtime-gap',oldReason);
        assert.equal(await tracker.flushPendingPersistence(),true);
        const persistedReason = () => new Map(JSON.parse(fs.readFileSync(
            path.join(tracker.storageUri.fsPath,'session-state.json'),'utf8')).coverageGaps).get(selected).subtree.reason;
        assert.equal(persistedReason(),oldReason);
        const diagnostic = tracker.getSubtreeCoverageGaps().find(gap=>gap.targetPath===selected);
        assert.equal(diagnostic.reasonCode,'supplemental-watcher-runtime-gap');
        assert.match(diagnostic.reason,/unnamed event/);
        assert.doesNotMatch(diagnostic.reason,/baseline rebuild/);
        assert.doesNotMatch(tracker.getCoverageGaps().find(([target])=>target===selected)[1],/baseline rebuild/);
        assert.equal(await tracker.flushPendingPersistence(),true);
        assert.equal(persistedReason(),oldReason,'presentation must not rewrite or retire historical evidence');
    }));

    test('SCOPE-RECOVERY Restore completes withdrawn-exclusion observation in one action', () => fixture(async context => {
        const files = await paused(context);
        const { tracker, scope } = context;
        await withController(tracker, scope, async ({controller,config}) => {
            config.watchExclude = [{scope:'all',pattern:'/work-turns/'}];
            controller.reconcileRequestedScope();
            const outcome = await controller.restoreEffectiveScopeConfiguration();
            assert.equal(outcome?.status,'restored',JSON.stringify(outcome));
            assert.equal(outcome.coverageStatus,'verified');
            assert.deepEqual(config.watchExclude,[]);
            assert.equal(tracker.getOriginalContent(files.changed),'original');
            assert.equal(tracker.getTrackedChange(files.changed)?.currentContent,'changed during pause');
            assert.equal(tracker.getTrackedChange(files.changed)?.reviewKind,'text');
            assert.deepEqual(tracker.getCoverageGaps(),[]);
            fs.writeFileSync(files.changed,'edit after Restore');
            await tracker.onExternalFileChanged(Uri.file(files.changed));
            await h.waitUntil(()=>tracker.getTrackedChange(files.changed)?.currentContent==='edit after Restore');
            assert.equal(tracker.getOriginalContent(files.changed),'original');
        });
    }));

    for (const situation of ['stopped','real-failure','external-settings'])
    test(`SCOPE-RECOVERY Restore ${situation} preserves scope and reports its actual completion`, () => fixture(async context => {
        const files = await paused(context);
        const {tracker,scope} = context;
        if (situation === 'stopped') { tracker.stopRecording(); }
        if (situation === 'real-failure') {
            tracker.setFileCoverageGap(files.other,'file-read-failed','Independent read failure');
            tracker.markFileUnavailable(files.other,'Independent read failure');
        }
        await withController(tracker,scope,async ({controller,config,hooks,writes}) => {
            config.watchExclude=[{scope:'all',pattern:'/work-turns/'}];
            controller.reconcileRequestedScope();
            if (situation === 'external-settings') {
                hooks.afterWrite = key => {
                    if (key === 'monitoringScope') { config.watchExclude=[{scope:'all',pattern:'/external/'}]; }
                };
            }
            const outcome=await controller.restoreEffectiveScopeConfiguration();
            assert.equal(outcome.status,situation==='external-settings'?'partial':'restored',JSON.stringify(outcome));
            assert.equal(tracker.getEffectiveMonitoringScope().scopeRevision,scope.scopeRevision);
            assert.equal(tracker.getIsRecording(),situation!=='stopped');
            assert.equal(tracker.getOriginalContent(files.changed),'original');
            if (situation === 'stopped') {
                assert.equal(outcome.coverageStatus,'deferred');
                assert.equal(tracker.getTrackedChange(files.changed)?.reviewKind,'unknown');
            } else if (situation === 'real-failure') {
                assert.equal(outcome.coverageStatus,'verified');
                assert.ok(outcome.unrelatedCoverageGaps.some(([file])=>file===files.other));
                assert.deepEqual(config.watchExclude,[]);
                assert.equal(tracker.coverageGaps.get(files.other)?.file?.reasonCode,'file-read-failed');
            } else {
                assert.deepEqual(config.watchExclude,[{scope:'all',pattern:'/external/'}]);
                assert.equal(writes.length,1,'Restore stops before overwriting the newer exclusion');
            }
            assert.equal(fs.readFileSync(files.changed,'utf8'),'changed during pause');
        });
    }));

    test('SCOPE-RECOVERY Save and Apply combines expansion and discard before any settings write', () => fixture(async ({tracker,dir,scope}) => {
        const removed = path.join(dir,'remove'); fs.mkdirSync(removed);
        const target = path.join(removed,'pending.txt'); fs.writeFileSync(target,'original');
        const added = path.join(dir,'added.txt'); fs.writeFileSync(added,'new baseline');
        assert.equal((await tracker.applyConfiguredMonitoringScope(scopeFor(tracker))).status,'applied');
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status,'applied');
        fs.writeFileSync(target,'pending'); await tracker.readFileAndUpdate(target,Uri.file(target));
        await withController(tracker,scope,async ({controller,writes,config}) => {
            let confirmations=0;
            const outcome=await controller.saveAndApplyScope({mode:'wholeWorkspace',includes:[],
                excludes:[{scope:'all',pattern:'/remove/'}]},async proposal => {
                confirmations++;
                assert.ok(proposal.expansionReasons.length>0);
                assert.deepEqual(proposal.affectedReviewPaths,[target]);
                assert.equal(writes.length,0);
                assert.equal(tracker.getTrackedChange(target)?.reviewKind,'text');
                return true;
            });
            assert.equal(outcome.status,'applied',JSON.stringify(outcome));
            assert.equal(outcome.coverageStatus,'verified');
            assert.equal(confirmations,1);
            assert.deepEqual(writes.map(([key])=>key),['monitoringScope','watchInclude','watchExclude']);
            assert.equal(config.monitoringScope,'wholeWorkspace');
            assert.equal(tracker.getTrackedChange(target),undefined);
            assert.equal(tracker.getOriginalContent(added),'new baseline');
            fs.writeFileSync(added,'observed after Save and Apply');
            await tracker.onExternalFileChanged(Uri.file(added));
            await h.waitUntil(()=>tracker.getTrackedChange(added)?.currentContent==='observed after Save and Apply');
            assert.equal(tracker.getOriginalContent(added),'new baseline');
            assert.equal(fs.readFileSync(target,'utf8'),'pending');
        });
    },'rules'));

    for (const situation of ['cancel','settings-failure','external-settings','unrelated-failure'])
    test(`SCOPE-RECOVERY Save and Apply ${situation} reports only durable, owned results`, () => fixture(async ({tracker,dir,scope}) => {
        const removed=path.join(dir,'remove'); fs.mkdirSync(removed);
        const target=path.join(removed,'pending.txt'), other=path.join(dir,'other.txt');
        fs.writeFileSync(target,'original'); fs.writeFileSync(other,'other original');
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status,'applied');
        fs.writeFileSync(target,'pending'); await tracker.readFileAndUpdate(target,Uri.file(target));
        const token=tracker.getReviewToken(target);
        if (situation === 'unrelated-failure') {
            tracker.setFileCoverageGap(other,'file-read-failed','Independent read failure');
            tracker.markFileUnavailable(other,'Independent read failure');
        }
        await withController(tracker,scope,async ({controller,config,hooks,writes}) => {
            const before=structuredClone(config);
            if (situation === 'settings-failure') {
                hooks.beforeWrite=key=>{if(key==='watchInclude')throw new Error('Controlled settings write failure');};
            }
            if (situation === 'external-settings') {
                hooks.afterWrite=key=>{if(key==='monitoringScope')config.watchExclude=[{scope:'all',pattern:'/external/'}];};
            }
            const proposal={mode:'wholeWorkspace',includes:[{scope:'all',path:'new-inc'}],excludes:[{scope:'all',pattern:'/remove/'}]};
            let confirmations=0;
            const outcome=await controller.saveAndApplyScope(proposal,async()=>{confirmations++;return situation!=='cancel';});
            const committed=situation==='unrelated-failure';
            assert.equal(outcome.status,situation==='cancel'?'cancelled':situation==='unrelated-failure'?'applied':'partial',JSON.stringify(outcome));
            assert.equal(outcome.scopeCommitted,committed);
            assert.equal(confirmations,1);
            if (situation==='cancel' || situation==='settings-failure') {
                assert.deepEqual(config,before);
                assert.deepEqual(tracker.getReviewToken(target),token);
                assert.equal(outcome.settingsStatus,situation==='cancel'?'unchanged':'partial');
                if(situation==='cancel')assert.equal(writes.length,0);
                else{assert.equal(controller.hasPendingScopeSettingsWrites(),true);assert.equal(writes.length,2);}
            } else if (situation==='external-settings') {
                assert.deepEqual(config.watchExclude,[{scope:'all',pattern:'/external/'}]);
                assert.equal(writes.length,1);
            } else {
                assert.ok(config.watchExclude.some(rule=>rule.pattern==='/remove/'));
                assert.equal(outcome.coverageStatus,'verified');
                assert.ok(outcome.unrelatedCoverageGaps.some(([file])=>file===other));
                assert.equal(tracker.getTrackedChange(target),undefined);
                assert.equal(tracker.coverageGaps.get(other)?.file?.reasonCode,'file-read-failed');
                const retried=await controller.saveAndApplyScope(proposal,async()=>{throw new Error('Retry must not discard the same review again');});
                assert.equal(retried.status,'applied');
                assert.ok(config.watchExclude.some(rule=>rule.pattern==='/remove/'));
            }
            assert.equal(fs.readFileSync(target,'utf8'),'pending');
        });
    }));

    for (const situation of ['invalid','stale-draft','new-review','stop-during-confirmation','disposed','durability-failure','stopped'])
    test(`SCOPE-RECOVERY Save and Apply ${situation} keeps confirmation bound to its proposal`, () => fixture(async ({tracker,dir,scope}) => {
        const removed=path.join(dir,'remove'); fs.mkdirSync(removed);
        const target=path.join(removed,'pending.txt'); fs.writeFileSync(target,'original');
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status,'applied');
        fs.writeFileSync(target,'pending'); await tracker.readFileAndUpdate(target,Uri.file(target));
        if(situation==='stopped')tracker.stopRecording();
        const token=tracker.getReviewToken(target);
        const commit=tracker.commitPreparedScopePersistence;
        if(situation==='durability-failure')tracker.commitPreparedScopePersistence=async()=>false;
        try { await withController(tracker,scope,async ({controller,config,writes}) => {
            const version=controller.getRequestVersion();
            if(situation==='stale-draft'){
                config.watchExclude=[{scope:'all',pattern:'/external/'}];controller.reconcileRequestedScope();
            }
            const before=structuredClone(config);
            const proposal={mode:'wholeWorkspace',includes:situation==='invalid'?[{scope:'all',path:'../outside'}]:[],
                excludes:[{scope:'all',pattern:'/remove/'}]};
            const outcome=await controller.saveAndApplyScope(proposal,async()=>{
                if(situation==='new-review'){
                    fs.writeFileSync(target,'newer pending');await tracker.readFileAndUpdate(target,Uri.file(target));
                }
                if(situation==='stop-during-confirmation')tracker.stopRecording();
                if(situation==='disposed')controller.dispose();
                return true;
            },version);
            const expected=situation==='invalid'?'invalid':situation==='durability-failure'?'failed':situation==='stopped'?'applied':'conflict';
            assert.equal(outcome.status,expected,JSON.stringify(outcome));
            if(situation==='stopped'){
                assert.equal(outcome.coverageStatus,'deferred');
                assert.equal(tracker.getIsRecording(),false);
                assert.equal(tracker.getTrackedChange(target),undefined);
            }else{
                assert.deepEqual(config,before);
                assert.equal(tracker.getEffectiveMonitoringScope().scopeRevision,scope.scopeRevision);
                if(situation!=='durability-failure')assert.equal(writes.length,0);
                if(situation!=='new-review'&&situation!=='stop-during-confirmation')assert.deepEqual(tracker.getReviewToken(target),token);
            }
            assert.equal(fs.readFileSync(target,'utf8'),situation==='new-review'?'newer pending':'pending');
        }); }finally{tracker.commitPreparedScopePersistence=commit;}
    }));

    test('SCOPE-RECOVERY Save Request Only stops before overwriting an external edit between settings writes', () => fixture(async ({tracker,scope}) => {
        await withController(tracker,scope,async ({controller,config,hooks,writes}) => {
            const version=controller.getRequestVersion();
            hooks.afterWrite=key=>{if(key==='monitoringScope')config.watchExclude=[{scope:'all',pattern:'/external/'}];};
            const result=await controller.saveRequestedScope({mode:'wholeWorkspace',includes:[],
                excludes:[{scope:'all',pattern:'/my-draft/'}]},{expectedRequestVersion:version});
            assert.equal(result.ok,false);
            assert.equal(writes.length,1);
            assert.deepEqual(config.watchExclude,[{scope:'all',pattern:'/external/'}]);
            assert.equal(tracker.getEffectiveMonitoringScope().scopeRevision,scope.scopeRevision);
        });
    }));

    test('SCOPE-RECOVERY Save and Apply reinclude finalizes dormant evidence and observes later native edits', () => fixture(async ({tracker,dir,scope}) => {
        const blind=path.join(dir,'reinclude');fs.mkdirSync(blind);
        const target=path.join(blind,'tracked.txt');fs.writeFileSync(target,'old baseline');
        const other=path.join(dir,'other.txt');fs.writeFileSync(other,'other baseline');
        h.setVsCodeExcludes({'files.watcherExclude':{'reinclude/**':true}});
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status,'applied');
        fs.writeFileSync(target,'old pending');await tracker.readFileAndUpdate(target,Uri.file(target));
        fs.writeFileSync(other,'other pending');await tracker.readFileAndUpdate(other,Uri.file(other));
        const otherToken=tracker.getReviewToken(other);
        tracker.setSubtreeCoverageGap(blind,'supplemental-watcher-directory-change-gap','Earlier interval');
        const unknown=path.join(dir,'unseen.txt');fs.writeFileSync(unknown,'unknown before-image');
        await tracker.readFileAndUpdate(unknown,Uri.file(unknown));
        await withController(tracker,scope,async ({controller}) => {
            assert.equal((await controller.excludeCoverageSubtree(blind,async()=>true)).status,'applied');
            assert.ok(tracker.coverageGaps.get(blind)?.subtree,'excluded evidence is retained without scanning');
            fs.writeFileSync(target,'fresh authorized baseline');
            const result=await controller.saveAndApplyScope({mode:'wholeWorkspace',includes:[],excludes:[]},async()=>true);
            assert.equal(result.status,'applied',JSON.stringify(result));assert.equal(result.coverageStatus,'verified');
            assert.equal(tracker.getOriginalContent(target),'fresh authorized baseline');
            assert.equal(tracker.getTrackedChange(target),undefined);
            assert.deepEqual(tracker.getSubtreeCoverageGaps(),[]);
            assert.deepEqual(tracker.getReviewToken(other),otherToken);
            // Recheck creates a fresh Unknown observation generation. It must
            // preserve uncertainty rather than invent an original before-image.
            assert.equal(tracker.getTrackedChange(unknown)?.reviewKind,'unknown');
            const owner=[...h.nativeDirectoryWatchers].reverse().find(item=>item.active&&path.resolve(String(item.directory))===blind);
            assert.ok(owner);
            fs.writeFileSync(target,'native edit after reinclude');owner.listener('change','tracked.txt');
            await h.waitUntil(()=>tracker.getTrackedChange(target)?.currentContent==='native edit after reinclude');
            assert.equal(tracker.getOriginalContent(target),'fresh authorized baseline');
            assert.equal(tracker.getOriginalContent(unknown),undefined);
        });
    }));

    for (const stopped of [false, true]) test(`SCOPE-RECOVERY real controller quick Cancel preserves clean baselines and actual review (stopped=${stopped})`, () => fixture(async context => {
        const { tracker, dir, scope } = context;
        const subtree = path.join(dir, 'work-turns'); fs.mkdirSync(subtree);
        const changed = path.join(subtree, 'changed.txt'), clean = path.join(subtree, 'clean.txt');
        fs.writeFileSync(changed, 'original'); fs.writeFileSync(clean, 'clean');
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status, 'applied');
        fs.writeFileSync(changed, 'pending'); await tracker.readFileAndUpdate(changed, Uri.file(changed));
        if (stopped) { tracker.stopRecording(); }
        const token = tracker.getReviewToken(changed);
        await withController(tracker, scope, async ({ controller, writes }) => {
            const result = await controller.excludeResource(subtree, true, async paths => {
                assert.deepEqual(paths, [changed], 'unchanged files are not pending review');
                assert.equal(writes.length, 0);
                assert.equal(tracker.getTrackedChange(changed)?.reviewKind, 'text');
                return false;
            });
            assert.equal(result.status, 'cancelled');
            assert.equal(writes.length, 0);
            assert.deepEqual(tracker.getReviewToken(changed), token);
            assert.equal(tracker.getTrackedChange(clean), undefined);
            assert.deepEqual(tracker.getCoverageGaps(), []);
        });
    }));

    for (const scenario of ['pending', 'clean', 'legacy-gap', 'save-failure']) test(`SCOPE-RECOVERY real controller quick exclusion ${scenario} is scoped and rollback-safe`, () => fixture(async context => {
        const { tracker, dir, scope } = context;
        const subtree = path.join(dir, 'work-turns'); fs.mkdirSync(subtree);
        const target = path.join(subtree, 'selected.txt'), other = path.join(dir, 'other.txt');
        fs.writeFileSync(target, 'original'); fs.writeFileSync(other, 'outside');
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status, 'applied');
        fs.writeFileSync(other, 'outside edit'); await tracker.readFileAndUpdate(other, Uri.file(other));
        if (scenario !== 'clean') { fs.writeFileSync(target, 'selected edit'); await tracker.readFileAndUpdate(target, Uri.file(target)); }
        if (scenario === 'legacy-gap') {
            tracker.setPendingMonitoringScope(scopeFor(tracker, 'wholeWorkspace', [{ scope: 'all', pattern: '/work-turns/' }]));
            tracker.setPendingMonitoringScope(undefined);
        }
        const otherToken = tracker.getReviewToken(other);
        const before = structuredClone(tracker.getTrackedChanges());
        const commit = tracker.commitPreparedScopePersistence;
        if (scenario === 'save-failure') { tracker.commitPreparedScopePersistence = async () => false; }
        try {
            await withController(tracker, scope, async ({ controller, config }) => {
                let prompts = 0;
                const result = await controller.excludeResource(subtree, true, async paths => {
                    prompts++; assert.deepEqual(paths, [target]); return true;
                });
                assert.equal(result.status, scenario === 'save-failure' ? 'failed' : 'applied', JSON.stringify(result));
                assert.equal(prompts, scenario === 'clean' ? 0 : 1);
                assert.deepEqual(tracker.getReviewToken(other), otherToken);
                assert.equal(tracker.getOriginalContent(other), 'outside');
                if (scenario === 'save-failure') {
                    assert.deepEqual(config.watchExclude, scope.excludes);
                    assert.deepEqual(tracker.getTrackedChanges(), before);
                    assert.equal(tracker.getOriginalContent(target), 'original');
                } else {
                    assert.equal(tracker.getTrackedChange(target), undefined);
                    assert.equal(tracker.getOriginalContent(target), undefined);
                    assert.equal(config.watchExclude.some(rule => rule.pattern === '/work-turns/'), true);
                    assert.equal((await controller.excludeResource(subtree, true, async () => { throw new Error('unexpected second prompt'); })).status, 'alreadyExcluded');
                }
                assert.deepEqual(tracker.getCoverageGaps(), []);
                assert.equal(fs.readFileSync(other, 'utf8'), 'outside edit');
            });
        } finally { tracker.commitPreparedScopePersistence = commit; }
    }));

    test('SCOPE-RECOVERY manual pending settings must not manufacture Unknown in a stopped frozen review', () => fixture(async context => {
        const { tracker, dir, scope } = context;
        const target = path.join(dir, 'frozen.txt'); fs.writeFileSync(target, 'original');
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status, 'applied');
        fs.writeFileSync(target, 'pending'); await tracker.readFileAndUpdate(target, Uri.file(target));
        tracker.stopRecording();
        const frozen = structuredClone(tracker.getTrackedChanges());
        tracker.setPendingMonitoringScope(scopeFor(tracker, 'wholeWorkspace', [{ scope: 'all', pattern: '/frozen.txt' }]));
        assert.deepEqual(tracker.getTrackedChanges(), frozen);
        tracker.setPendingMonitoringScope(undefined);
        assert.deepEqual(tracker.getTrackedChanges(), frozen);
        assert.deepEqual(tracker.getCoverageGaps(), []);
    }));

    for (const disturbance of ['dirty-editor', 'event', 'document-event', 'delete-event', 'unreadable', 'retirement-save'])
    test(`SCOPE-RECOVERY ${disturbance} during recovery cannot certify stale evidence`, () => fixture(async context => {
        const files = await paused(context);
        const { tracker } = context;
        const read = tracker.readCurrentFileState;
        const write = vscode.workspace.fs.writeFile;
        let injected = false;
        tracker.readCurrentFileState = async function(target, ...args) {
            const result = await read.call(this, target, ...args);
            if (target === files.changed && !injected && disturbance !== 'retirement-save') {
                injected = true;
                if (disturbance === 'dirty-editor') {
                    vscode.workspace.textDocuments.push({ uri: Uri.file(target), isDirty: true });
                } else if (['event', 'document-event', 'delete-event'].includes(disturbance)) {
                    fs.writeFileSync(target, 'changed during certification');
                    if (disturbance === 'document-event') {
                        tracker.onDocumentChanged({ document: { uri: Uri.file(target), isDirty: false } });
                    } else if (disturbance === 'delete-event') {
                        fs.unlinkSync(target); await tracker.onExternalFileDeleted(Uri.file(target));
                    } else { await tracker.onExternalFileChanged(Uri.file(target)); }
                } else { return { kind: 'unavailable', reason: 'injected unreadable resource' }; }
            }
            return result;
        };
        if (disturbance === 'retirement-save') {
            vscode.workspace.fs.writeFile = async (uri, bytes) => {
                if (!injected && path.basename(uri.fsPath) === 'session-state.tmp.json') {
                    const candidate = JSON.parse(Buffer.from(bytes).toString());
                    if (!candidate.coverageGaps.some(([target, record]) => target === files.changed && record.file)) {
                        injected = true;
                        throw new Error('injected control-gap retirement failure');
                    }
                }
                return write(uri, bytes);
            };
        }
        try {
            const result = await tracker.recheckObservationCoverage();
            assert.notEqual(result.status, 'rechecked', JSON.stringify(result));
            assert.equal(injected, true);
            assert.ok(tracker.coverageGaps.get(files.changed)?.file, 'unproven control gap stays recoverable');
            assert.equal(tracker.getTrackedChange(files.changed)?.reviewKind, 'unknown');
            assert.equal(tracker.getOriginalContent(files.changed), 'original');
            assert.equal((await tracker.resetUnknownBaseline(files.changed)).status, 'conflict');
        } finally {
            tracker.readCurrentFileState = read;
            vscode.workspace.fs.writeFile = write;
            if (disturbance === 'dirty-editor') { vscode.workspace.textDocuments.pop(); }
        }
        if (disturbance !== 'retirement-save') {
            assert.equal((await tracker.recheckObservationCoverage()).status, 'rechecked');
            assert.equal(tracker.getOriginalContent(files.changed), 'original');
            if (disturbance === 'delete-event') { assert.equal(tracker.getTrackedChange(files.changed)?.isDeleted, true); }
            else { assert.equal(tracker.getTrackedChange(files.changed)?.currentContent,
                ['event', 'document-event'].includes(disturbance) ? 'changed during certification' : 'changed during pause'); }
        }
    }));

    for (const failed of [false, true])
    test(`SCOPE-RECOVERY control subtree requires working direct observation (failure=${failed})`, () => fixture(async context => {
        const files = await paused(context);
        const { tracker } = context;
        h.setVsCodeExcludes({ 'files.watcherExclude': { 'work-turns/**': true } });
        tracker.setSubtreeCoverageGap(files.subtree, 'pending-scope-gap', 'Pending scope reconciliation remains required');
        // Real production installer and scan; only the native watch factory is
        // fault-injected. A wrapped pending code cannot hide ENOSPC.
        const watch = fs.watch;
        if (failed) {
            fs.watch = (target, ...args) => {
                if (path.resolve(String(target)) === files.subtree) {
                    throw Object.assign(new Error('injected native watcher limit'), { code: 'ENOSPC' });
                }
                return watch(target, ...args);
            };
        }
        try {
            const result = await tracker.recheckObservationCoverage();
            assert.equal(result.status, failed ? 'limited' : 'rechecked', JSON.stringify(result));
            assert.equal(tracker.getOriginalContent(files.changed), 'original');
            if (failed) {
                assert.ok(tracker.coverageGaps.get(files.changed)?.file);
                assert.ok(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === files.subtree));
                assert.equal((await tracker.resetUnknownBaseline(files.changed)).status, 'conflict');
            } else {
                assert.equal(tracker.getTrackedChange(files.changed)?.reviewKind, 'text');
                assert.deepEqual(tracker.getCoverageGaps(), []);
                const owner = [...h.nativeDirectoryWatchers].reverse().find(item => item.active && item.directory === files.subtree);
                assert.ok(owner);
                fs.writeFileSync(files.changed, 'native follow-up');
                owner.listener('change', 'changed.txt');
                await h.waitUntil(() => tracker.getTrackedChange(files.changed)?.currentContent === 'native follow-up');
                assert.equal(tracker.getOriginalContent(files.changed), 'original');
            }
        } finally { fs.watch = watch; }
    }));

    for (const situation of ['duplicate', 'kind-change', 'new-review', 'postcommit-preference'])
    test(`SCOPE-RECOVERY quick exclusion ${situation} keeps consent bound to the actual operation`, () => fixture(async context => {
        const { tracker, dir, scope } = context;
        const target = path.join(dir, 'chosen.txt'); fs.writeFileSync(target, 'original');
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status, 'applied');
        fs.writeFileSync(target, 'pending'); await tracker.readFileAndUpdate(target, Uri.file(target));
        await withController(tracker, scope, async ({ controller, config, writes }) => {
            if (situation === 'postcommit-preference') {
                controller.clearDismissedConsent = async () => { throw new Error('injected preference failure'); };
            }
            const result = await controller.excludeResource(target, false, async paths => {
                assert.deepEqual(paths, [target]);
                assert.equal(writes.length, 0);
                if (situation === 'duplicate') {
                    assert.equal((await controller.excludeResource(target, false, async () => true)).status, 'conflict');
                    assert.equal((await controller.applyPendingScope()).status, 'conflict');
                } else if (situation === 'kind-change') {
                    fs.unlinkSync(target); fs.mkdirSync(target);
                } else if (situation === 'new-review') {
                    fs.writeFileSync(target, 'newer pending'); await tracker.readFileAndUpdate(target, Uri.file(target));
                }
                return true;
            });
            const applied = situation === 'duplicate' || situation === 'postcommit-preference';
            assert.equal(result.status, applied ? 'applied' : 'conflict', JSON.stringify(result));
            assert.equal(writes.length, applied ? 1 : 0);
            assert.equal(config.watchExclude.some(rule => rule.pattern === '/chosen.txt'), applied);
            assert.equal(tracker.getOriginalContent(target), applied ? undefined : 'original');
            if (situation === 'postcommit-preference') { assert.match(result.reason, /preference/); }
        });
    }));

    for (const situation of ['existing', 'missing', 'cancel', 'new-review'])
    test(`SCOPE-RECOVERY coverage-row single action ${situation} shares the confirmed scope transaction`, () => fixture(async ({tracker,dir,scope}) => {
        const chosen = path.join(dir, 'warned'); fs.mkdirSync(chosen);
        const target = path.join(chosen, 'review.txt'); fs.writeFileSync(target, 'original');
        h.setVsCodeExcludes({'files.watcherExclude': {'warned/**':true}});
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status, 'applied');
        fs.writeFileSync(target, 'pending'); await tracker.readFileAndUpdate(target, Uri.file(target));
        if (situation === 'missing') {
            fs.rmSync(chosen, {recursive:true}); await tracker.onExternalFileDeleted(Uri.file(chosen));
        } else { tracker.setSubtreeCoverageGap(chosen, 'supplemental-watcher-directory-change-gap', 'Prior interval'); }
        const token = tracker.getReviewToken(target);
        await withController(tracker, scope, async ({controller, writes, config}) => {
            let confirmations = 0;
            const outcome = await controller.excludeCoverageSubtree(chosen, async paths => {
                confirmations++;
                assert.deepEqual(paths, [target]);
                assert.equal(writes.length, 0, 'coverage-row confirmation must precede settings writes');
                if (situation === 'new-review') {
                    fs.writeFileSync(target, 'newer pending'); await tracker.readFileAndUpdate(target, Uri.file(target));
                }
                return situation !== 'cancel';
            });
            assert.equal(confirmations, 1);
            const applied = situation === 'existing' || situation === 'missing';
            assert.equal(outcome.status, applied ? 'applied' : situation === 'cancel' ? 'cancelled' : 'conflict', JSON.stringify(outcome));
            assert.equal(writes.length, applied ? 1 : 0);
            assert.equal(config.watchExclude.some(rule => rule.pattern === '/warned/'), applied);
            if (applied) {
                assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
                assert.equal(tracker.getOriginalContent(target), undefined);
                assert.equal(tracker.supplementalDirectoryWatchers.has(chosen), false);
            } else if (situation === 'cancel') { assert.deepEqual(tracker.getReviewToken(target), token); }
            assert.equal(fs.existsSync(target), situation !== 'missing');
        });
    }));

    registerScopeSingleActionAcceptance(h,fixture,scopeFor,withController);
    registerScopeSingleActionCrashes(h,fixture,scopeFor,withController);
}
