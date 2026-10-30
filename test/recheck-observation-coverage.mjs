import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateAndCanonicalizeScope } from '../out/monitoringScope.js';

export function registerRecheckObservationCoverage(h, fixture) {
    const { test, setVsCodeExcludes, nativeDirectoryWatchers, waitUntil, Uri, vscode, fireConfigurationChanged } = h;
    const ownerFor = directory => [...nativeDirectoryWatchers].reverse().find(owner =>
        owner.active && path.resolve(String(owner.directory)) === directory);
    const savedState = tracker => JSON.parse(fs.readFileSync(path.join(tracker.storageUri.fsPath, 'session-state.json'), 'utf8'));
    test('RECHECK upgrades a 0.8.10 tracker unnamed runtime record without replacing baselines or Undo', () => fixture(async context => {
        let {tracker}=context;
        const {dir}=context,storage=tracker.storageUri;
        const fixtureState=JSON.parse(fs.readFileSync(new URL('./fixtures/unnamed-runtime-0.8.10.json',import.meta.url),'utf8'));
        assert.equal(fixtureState.sourceVersion,'0.8.10');
        assert.equal(fixtureState.sourceCommit,'ddc2190cc0dba35944fc80dfba8ba963a2d850ca');
        const bind=value=>{
            if(Array.isArray(value)){return value.map(bind);}
            if(value&&typeof value==='object'){return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,bind(item)]));}
            if(typeof value!=='string'){return value;}
            const uriPrefix='file://FIXTURE_WORKSPACE';
            if(value.startsWith(uriPrefix)){return Uri.file(path.join(dir,...value.slice(uriPrefix.length).split('/').filter(Boolean))).toString();}
            if(value.startsWith('FIXTURE_WORKSPACE')){return path.join(dir,...value.slice('FIXTURE_WORKSPACE'.length).split('/').filter(Boolean));}
            return value;
        };
        const state=bind(fixtureState.state);
        // Rebind only fixture location/root identity; retain old diagnostics,
        // snapshots, unknown before-image and the actual persisted Undo record.
        const checked=validateAndCanonicalizeScope(state.effectiveMonitoringScope,tracker.currentWorkspaceRootIdentities());
        assert.equal(checked.ok,true,JSON.stringify(checked.errors));
        state.effectiveMonitoringScope={kind:'configured',...checked.scope};
        const blind=path.join(dir,'native-owner'),target=path.join(blind,'tracked.txt'),undo=path.join(dir,'undo.txt');
        fs.mkdirSync(blind);fs.writeFileSync(target,'pending');fs.writeFileSync(undo,'undo baseline');
        fs.writeFileSync(path.join(blind,'unknown.txt'),'unknown before');
        setVsCodeExcludes({'files.watcherExclude':{'native-owner/**':true}});
        await tracker.dispose();
        fs.mkdirSync(storage.fsPath,{recursive:true});
        fs.writeFileSync(path.join(storage.fsPath,'session-state.json'),JSON.stringify(state));
        tracker=new h.DiffTracker(storage);h.setTracker(tracker);
        assert.equal(await tracker.restorePersistedState(),'restored');
        assert.equal(tracker.getOriginalContent(target),'original');
        assert.equal(tracker.getOriginalContent(path.join(blind,'unknown.txt')),undefined);
        assert.equal((await tracker.recheckObservationCoverage()).status,'rechecked');
        assert.deepEqual(tracker.getSubtreeCoverageGaps(),[]);
        assert.equal(tracker.getTrackedChange(target)?.currentContent,'pending');
        assert.equal(tracker.getTrackedChange(path.join(blind,'unknown.txt'))?.reviewKind,'unknown');
        assert.deepEqual(tracker.revertHistory,state.revertHistory);
        fs.writeFileSync(target,'observed after upgrade');ownerFor(blind).listener('change','tracked.txt');
        await waitUntil(()=>tracker.getTrackedChange(target)?.currentContent==='observed after upgrade');
        assert.equal((await tracker.undoLastRevert()).succeeded,1);
        assert.equal(fs.readFileSync(undo,'utf8'),'undo pending');
    }));
    for (const scenario of ['success','dirty','native-failure'])
    test(`RECHECK unnamed callback preserves review and Undo (${scenario})`, () => fixture(async ({tracker,scope,dir}) => {
        const blind=path.join(dir,'native-owner');fs.mkdirSync(blind);
        const target=path.join(blind,'tracked.txt'),undo=path.join(dir,'undo.txt');
        fs.writeFileSync(target,'original');fs.writeFileSync(undo,'undo baseline');
        setVsCodeExcludes({'files.watcherExclude':{'native-owner/**':true}});
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status,'applied');
        fs.writeFileSync(target,'pending');await tracker.readFileAndUpdate(target,Uri.file(target));
        fs.writeFileSync(undo,'undo pending');await tracker.readFileAndUpdate(undo,Uri.file(undo));
        assert.equal((await tracker.revertFile(undo)).status,'success');
        const history=structuredClone(tracker.revertHistory),token=tracker.getReviewToken(target);
        const unknown=path.join(blind,'unknown.txt');fs.writeFileSync(unknown,'unknown before');
        tracker.recordUnresolvedBaseline(unknown,'Unverified before-image');
        await tracker.readFileAndUpdate(unknown,Uri.file(unknown));
        ownerFor(blind).listener('change',undefined);
        assert.equal(tracker.getSubtreeCoverageGaps().find(gap=>gap.targetPath===blind)?.reasonCode,
            'supplemental-watcher-runtime-gap');
        const watch=fs.watch;
        if(scenario==='native-failure'){
            const failure=Object.assign(new Error('Synthetic native owner unavailable'),{code:'ENOSPC'});
            ownerFor(blind).error(failure);
            fs.watch=(directory,...args)=>{if(String(directory)===blind){throw failure;}return watch(directory,...args);};
        }
        if(scenario==='dirty'){vscode.workspace.textDocuments.push({uri:Uri.file(target),isDirty:true});}
        try{
            const result=await tracker.recheckObservationCoverage();
            assert.equal(result.status,scenario==='success'?'rechecked':scenario==='dirty'?'conflict':'limited',
                JSON.stringify({result,gaps:tracker.getSubtreeCoverageGaps()}));
            assert.equal(tracker.getOriginalContent(target),'original');
            assert.deepEqual(tracker.getReviewToken(target),token);
            assert.equal(tracker.getOriginalContent(unknown),undefined);
            assert.equal(tracker.getTrackedChange(unknown).reviewKind,'unknown');
            assert.deepEqual(tracker.revertHistory,history);
            if(scenario==='success'){
                fs.writeFileSync(target,'later native edit');ownerFor(blind).listener('change','tracked.txt');
                await waitUntil(()=>tracker.getTrackedChange(target)?.currentContent==='later native edit');
                assert.equal((await tracker.undoLastRevert()).succeeded,1);
                assert.equal(fs.readFileSync(undo,'utf8'),'undo pending');
            }else{assert.ok(tracker.getSubtreeCoverageGaps().some(gap=>gap.targetPath===blind));}
        }finally{fs.watch=watch;if(scenario==='dirty'){vscode.workspace.textDocuments.pop();}}
    }));
    async function seed({ tracker, scope, dir }) {
        const target = path.join(dir, 'baseline.txt');
        fs.writeFileSync(target, 'baseline');
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status, 'applied');
        if (scope.mode === 'rules') {
            h.setListedFiles([Uri.file(target)]);
            tracker.startRecording();
            await waitUntil(() => tracker.getBaselineState() === 'ready');
        }
        fs.writeFileSync(target, 'pending');
        await tracker.onExternalFileChanged(Uri.file(target));
        await waitUntil(() => tracker.getTrackedChanges().some(change => change.filePath === target && change.currentContent === 'pending'));
        return target;
    }
    async function atEnumeration(dir, run) {
        const original = fs.promises.opendir;
        let enter, release, used = false;
        const entered = new Promise(resolve => { enter = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        fs.promises.opendir = async (directory, ...args) => {
            if (path.resolve(String(directory)) === dir && !used) { used = true; enter(); await gate; }
            return original(directory, ...args);
        };
        try { await run(entered, release); }
        finally { release(); fs.promises.opendir = original; }
    }

    test('RECHECK one quiet public recheck retires an exact busy-directory gap without accepting review', () => fixture(async context => {
        const {tracker, dir, scope} = context;
        const unrelated = await seed(context);
        const blind = path.join(dir, 'busy-blind'), child = path.join(blind, 'child');
        fs.mkdirSync(child, {recursive:true});
        const target = path.join(child, 'tracked.txt'); fs.writeFileSync(target, 'original');
        setVsCodeExcludes({'files.watcherExclude': {'busy-blind/**':true}});
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status, 'applied');
        const unknown = path.join(child, 'unknown.txt'); fs.writeFileSync(unknown, 'unknown original');
        tracker.recordUnresolvedBaseline(unknown, 'Original before-image is unknown');
        const token = tracker.getReviewToken(unrelated);
        const opendir = fs.promises.opendir;
        let activity = 0;
        fs.promises.opendir = async (directory, ...args) => {
            const result = await opendir(directory, ...args);
            if (String(directory) === child) {
                fs.writeFileSync(target, `busy ${++activity}`);
                ownerFor(child).listener('change', 'tracked.txt');
            }
            return result;
        };
        try { await tracker.onExternalFileChanged(Uri.file(child)); }
        finally { fs.promises.opendir = opendir; }
        assert.ok(activity > 0 && activity < 24);
        assert.equal(tracker.directoryObservations.size, 0);
        assert.equal(tracker.getSubtreeCoverageGaps().find(gap => gap.targetPath === child)?.reasonCode,
            'directory-runtime-coverage-gap');
        const disk = fs.readFileSync(target, 'utf8');
        const result = await tracker.recheckObservationCoverage();
        assert.equal(result.status, 'rechecked', JSON.stringify({result,gaps:tracker.getSubtreeCoverageGaps()}));
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
        assert.equal(tracker.getOriginalContent(target), 'original');
        assert.equal(tracker.getTrackedChange(target)?.currentContent, disk);
        assert.equal(tracker.getOriginalContent(unknown), undefined);
        assert.equal(tracker.getTrackedChange(unknown)?.reviewKind, 'unknown');
        assert.deepEqual(tracker.getReviewToken(unrelated), token);
        assert.equal(fs.readFileSync(target, 'utf8'), disk);
        assert.equal(await tracker.flushPendingPersistence(), true);
        const saved = savedState(tracker);
        assert.equal(new Map(saved.fileSnapshots).get(target), 'original');
        assert.notEqual(saved.coverageGaps.find(([directory]) => directory === child)?.[1].subtree?.reasonCode,
            'directory-runtime-coverage-gap');
        fs.writeFileSync(target, 'native edit after public recheck');
        ownerFor(child).listener('change', 'tracked.txt');
        await waitUntil(() => tracker.getTrackedChange(target)?.currentContent === 'native edit after public recheck');
        assert.equal(tracker.getOriginalContent(target), 'original');
    }));

    async function seedDirectoryGap(context, code = 'directory-runtime-coverage-gap') {
        const {tracker, dir, scope} = context;
        const unrelated = await seed(context);
        const blind = path.join(dir, 'import-gap'), child = path.join(blind, 'child');
        fs.mkdirSync(child, {recursive:true});
        const target = path.join(child, 'tracked.txt'); fs.writeFileSync(target, 'original');
        setVsCodeExcludes({'files.watcherExclude': {'import-gap/**':true}});
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status, 'applied');
        const unknown = path.join(child, 'unknown.txt'); fs.writeFileSync(unknown, 'unknown original');
        tracker.recordUnresolvedBaseline(unknown, 'Original before-image is unknown');
        tracker.setSubtreeCoverageGap(child, code, 'Old directory observation interval');
        return {unrelated, child, target, unknown, evidence:tracker.coverageGaps.get(child).subtree,
            token:tracker.getReviewToken(unrelated)};
    }

    test('RECHECK exact scan-gap repair retains unknown before-images and future native observation', () => fixture(async context => {
        const {tracker} = context;
        const files = await seedDirectoryGap(context, 'directory-scan-coverage-gap');
        assert.equal((await tracker.recheckObservationCoverage()).status, 'rechecked');
        assert.equal(tracker.getOriginalContent(files.target), 'original');
        assert.equal(tracker.getOriginalContent(files.unknown), undefined);
        assert.equal(tracker.getTrackedChange(files.unknown)?.reviewKind, 'unknown');
        assert.deepEqual(tracker.getReviewToken(files.unrelated), files.token);
        fs.writeFileSync(files.target, 'after scan-gap repair');
        ownerFor(files.child).listener('change', 'tracked.txt');
        await waitUntil(() => tracker.getTrackedChange(files.target)?.currentContent === 'after scan-gap repair');
    }));

    for (const barrier of ['new-evidence', 'identity', 'durable-copy', 'new-evidence-at-copy']) test(`RECHECK exact import-gap retirement refuses ${barrier}`, () => fixture(async context => {
        const {tracker, dir} = context;
        const files = await seedDirectoryGap(context);
        let result, replacement;
        if (barrier === 'durable-copy' || barrier === 'new-evidence-at-copy') {
            const copy = vscode.workspace.fs.copy;
            let injected = false;
            vscode.workspace.fs.copy = async (...args) => {
                if (tracker.baselineTransaction && !injected) {
                    injected = true;
                    if (barrier === 'durable-copy') { throw new Error('Injected certification copy failure'); }
                    tracker.setSubtreeCoverageGap(files.child, 'directory-runtime-coverage-gap', 'New uncertainty at durable copy');
                    replacement = tracker.coverageGaps.get(files.child).subtree;
                }
                return copy(...args);
            };
            try { result = await tracker.recheckObservationCoverage(); }
            finally { vscode.workspace.fs.copy = copy; }
            assert.equal(injected, true);
            assert.equal(result.status, barrier === 'durable-copy' ? 'failed' : 'limited');
        } else {
            await atEnumeration(barrier === 'identity' ? dir : files.child, async (entered, release) => {
                const recheck = tracker.recheckObservationCoverage();
                try {
                    await entered;
                    if (barrier === 'identity') {
                        fs.renameSync(files.child, path.join(dir, 'old-owner'));
                        fs.mkdirSync(files.child); fs.writeFileSync(files.target, 'replacement');
                    } else {
                        tracker.setSubtreeCoverageGap(files.child, 'directory-runtime-coverage-gap', 'New uncertainty during Recheck');
                        replacement = tracker.coverageGaps.get(files.child).subtree;
                    }
                } finally { release(); }
                result = await recheck;
            });
            assert.equal(result.status, 'limited');
        }
        assert.equal(tracker.coverageGaps.get(files.child)?.subtree, replacement ?? files.evidence);
        assert.equal(tracker.getOriginalContent(files.target), 'original');
        assert.equal(tracker.getOriginalContent(files.unknown), undefined);
        assert.equal(tracker.getTrackedChange(files.unknown)?.reviewKind, 'unknown');
        assert.deepEqual(tracker.getReviewToken(files.unrelated), files.token);
        if (barrier === 'new-evidence-at-copy') {
            assert.equal(await tracker.flushPendingPersistence(), true);
            assert.equal(savedState(tracker).coverageGaps.find(([directory]) => directory === files.child)?.[1].subtree?.reason,
                'New uncertainty at durable copy');
        }
        if (barrier === 'durable-copy') {
            assert.equal(await tracker.flushPendingPersistence(), true);
            assert.equal(savedState(tracker).coverageGaps.find(([directory]) => directory === files.child)?.[1].subtree?.reasonCode,
                'directory-runtime-coverage-gap');
            assert.equal((await tracker.recheckObservationCoverage()).status, 'rechecked', 'a quiet retry is idempotent');
        }
    }));

    test('RECHECK reinstalls failed coverage without accepting pending text or opaque changes', () => fixture(async ({ tracker, scope, dir }) => {
        const blind = path.join(dir, 'blind');
        fs.mkdirSync(blind);
        const text = path.join(blind, 'pending.txt');
        const opaque = path.join(blind, 'pending.bin');
        fs.writeFileSync(text, 'original baseline');
        fs.writeFileSync(opaque, Buffer.from([0, 1, 2]));
        setVsCodeExcludes({ 'files.watcherExclude': { 'blind/**': true } });
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status, 'applied');
        const originalOpaque = structuredClone(tracker.opaqueBaselineFiles.get(opaque));
        let owner = ownerFor(blind);
        assert.ok(owner);
        fs.writeFileSync(text, 'pending before failure');
        fs.writeFileSync(opaque, Buffer.from([0, 3, 4]));
        owner.listener('change', 'pending.txt');
        owner.listener('change', 'pending.bin');
        await waitUntil(() => tracker.getTrackedChanges().length >= 2);
        owner.error(Object.assign(new Error('watch limit'), { code: 'ENOSPC' }));
        fs.writeFileSync(text, 'missed while watcher failed');
        const result = await tracker.recheckObservationCoverage();
        assert.equal(result.status, 'rechecked', JSON.stringify(result));
        assert.equal(tracker.getIsRecording(), true);
        assert.equal(tracker.getOriginalContent(text), 'original baseline');
        assert.deepEqual(tracker.opaqueBaselineFiles.get(opaque), originalOpaque);
        assert.equal(tracker.getTrackedChanges().find(change => change.filePath === text)?.currentContent, 'missed while watcher failed');
        assert.equal(tracker.getTrackedChanges().find(change => change.filePath === opaque)?.reviewKind, 'opaque');
        assert.ok(tracker.getReviewToken(text));
        assert.ok(tracker.getOpaqueReviewToken(opaque));
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
        owner = ownerFor(blind);
        assert.ok(owner);
        fs.writeFileSync(text, 'later native edit');
        owner.listener('change', 'pending.txt');
        await waitUntil(() => tracker.getTrackedChanges().some(change => change.currentContent === 'later native edit'));
        assert.equal(tracker.getOriginalContent(text), 'original baseline');
        assert.equal(await tracker.flushPendingPersistence(), true);
        const saved = JSON.parse(fs.readFileSync(path.join(tracker.storageUri.fsPath, 'session-state.json'), 'utf8'));
        assert.equal(new Map(saved.fileSnapshots).get(text), 'original baseline');
        assert.deepEqual(saved.coverageGaps, []);
    }));

    for (const mode of ['rules', 'wholeWorkspace']) test(`RECHECK ${mode} preserves token and unknown before-images without unbounded host search`, () => fixture(async context => {
        const { tracker, dir } = context;
        const target = await seed(context);
        const token = tracker.getReviewToken(target);
        const fingerprint = tracker.scanCoverage;
        tracker.scanCoverage = undefined;
        const unknown = path.join(dir, 'unseen.txt');
        fs.writeFileSync(unknown, 'not an accepted baseline');
        const find = vscode.workspace.findFiles;
        vscode.workspace.findFiles = async () => { throw new Error('unbounded host search'); };
        try {
            const result = await tracker.recheckObservationCoverage();
            assert.equal(result.status, 'rechecked', JSON.stringify(result));
            assert.deepEqual(tracker.getReviewToken(target), token);
            assert.equal(tracker.getOriginalContent(target), 'baseline');
            assert.equal(tracker.getOriginalContent(unknown), undefined);
            assert.equal(tracker.getTrackedChanges().find(change => change.filePath === unknown)?.reviewKind, 'unknown');
            assert.equal(tracker.scanCoverage, undefined, 'current discovery must not become original-baseline absence proof');
            assert.ok(fingerprint);
        } finally { vscode.workspace.findFiles = find; }
    }, mode));

    for (const state of ['stopped', 'pending', 'dirty', 'building']) test(`RECHECK refuses ${state} without altering review or recording intent`, () => fixture(async context => {
        const { tracker, scope } = context;
        const target = await seed(context);
        if (state === 'stopped') { tracker.stopRecording(); }
        if (state === 'pending') { tracker.setPendingMonitoringScope({ ...scope, scopeRevision: 'pending' }); }
        if (state === 'building') { tracker.baselineBuilding = true; }
        const docs = vscode.workspace.textDocuments;
        if (state === 'dirty') { docs.push({ uri: Uri.file(target), isDirty: true }); }
        const before = JSON.stringify(tracker.getTrackedChanges());
        const recording = tracker.getIsRecording();
        try {
            assert.equal((await tracker.recheckObservationCoverage()).status, 'conflict');
            assert.equal(tracker.getIsRecording(), recording);
            assert.equal(tracker.getOriginalContent(target), 'baseline');
            assert.equal(JSON.stringify(tracker.getTrackedChanges()), before);
        } finally { if (state === 'dirty') { docs.pop(); } }
    }));

    test('RECHECK concurrent command and Apply cannot replace the original scope or baselines', () => fixture(async context => {
        const { tracker, scope, dir } = context;
        const target = await seed(context);
        await atEnumeration(dir, async (entered, release) => {
            const recheck = tracker.recheckObservationCoverage();
            await entered;
            assert.equal((await tracker.recheckObservationCoverage()).status, 'conflict');
            assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status, 'conflict');
            release();
            assert.equal((await recheck).status, 'rechecked');
        });
        assert.equal(tracker.getOriginalContent(target), 'baseline');
    }));

    test('RECHECK Stop and newer Start invalidate old scan without changing new owner state', () => fixture(async context => {
        const { tracker, dir } = context;
        const target = await seed(context);
        await atEnumeration(dir, async (entered, release) => {
            const recheck = tracker.recheckObservationCoverage();
            await entered;
            tracker.stopRecording();
            assert.equal(tracker.getOriginalContent(target), 'baseline');
            tracker.startRecording();
            await waitUntil(() => tracker.getBaselineState() === 'ready');
            const generation = tracker.getCoverageGeneration();
            release();
            assert.equal((await recheck).status, 'conflict');
            assert.equal(tracker.getCoverageGeneration(), generation);
            assert.equal(tracker.getIsRecording(), true);
            assert.equal(tracker.getOriginalContent(target), 'pending', 'only the explicit Start adopts a new baseline');
        });
    }));

    test('RECHECK settings change during enumeration retains durable uncertainty and original review', () => fixture(async context => {
        const { tracker, dir } = context;
        const target = await seed(context);
        await atEnumeration(dir, async (entered, release) => {
            const recheck = tracker.recheckObservationCoverage();
            await entered;
            fireConfigurationChanged('files.watcherExclude');
            release();
            assert.notEqual((await recheck).status, 'rechecked');
        });
        assert.equal(tracker.getOriginalContent(target), 'baseline');
        assert.ok(tracker.getSubtreeCoverageGaps().some(gap => gap.reasonCode === 'coverage-recheck-incomplete'));
        assert.ok(savedState(tracker).coverageGaps.some(([, gap]) => gap.subtree?.reasonCode === 'coverage-recheck-incomplete'));
        await tracker.ignoreRefreshPromise;
        assert.equal((await tracker.recheckObservationCoverage()).status, 'rechecked', 'a later quiet retry retires the previous marker');
    }));

    test('RECHECK direct create and save events invalidate certification and replay without adopting current bytes', () => fixture(async context => {
        const { tracker, dir } = context;
        const target = await seed(context);
        const created = path.join(dir, 'during-recheck.txt');
        await atEnumeration(dir, async (entered, release) => {
            const recheck = tracker.recheckObservationCoverage();
            await entered;
            fs.writeFileSync(created, 'new contents');
            await tracker.onExternalFileCreated(Uri.file(created));
            fs.writeFileSync(target, 'saved during recheck');
            tracker.onDidSaveDocument({ uri: Uri.file(target), isDirty: false });
            release();
            assert.equal((await recheck).status, 'limited');
        });
        await waitUntil(() => tracker.getTrackedChanges().some(change => change.currentContent === 'saved during recheck'));
        assert.equal(tracker.getOriginalContent(target), 'baseline');
        assert.equal(tracker.getOriginalContent(created), '');
        assert.equal(tracker.getTrackedChanges().find(change => change.filePath === created)?.baselineExists, false);
        assert.ok(tracker.getSubtreeCoverageGaps().length > 0);
    }));

    test('RECHECK event overflow remains visibly unverified after bounded replay', () => fixture(async context => {
        const { tracker, dir } = context;
        await seed(context);
        tracker.maxScopePreflightEntries = 3;
        await atEnumeration(dir, async (entered, release) => {
            const recheck = tracker.recheckObservationCoverage();
            await entered;
            for (let index = 0; index < 4; index++) {
                await tracker.onExternalFileCreated(Uri.file(path.join(dir, `event-${index}`)));
            }
            assert.equal(tracker.restoreEvents.size, 3);
            release();
            assert.notEqual((await recheck).status, 'rechecked');
        });
        assert.ok(savedState(tracker).coverageGaps.some(([, gap]) => gap.subtree?.reasonCode === 'coverage-recheck-incomplete'));
    }));

    test('RECHECK bounded enumeration failure preserves baseline and persists a retryable gap', () => fixture(async context => {
        const { tracker, dir } = context;
        const target = await seed(context);
        for (let index = 0; index < 5; index++) { fs.writeFileSync(path.join(dir, `extra-${index}`), 'unseen'); }
        tracker.maxScopePreflightEntries = 2;
        assert.equal((await tracker.recheckObservationCoverage()).status, 'failed');
        assert.equal(tracker.getOriginalContent(target), 'baseline');
        assert.equal(tracker.getIsRecording(), true);
        assert.ok(savedState(tracker).coverageGaps.some(([, gap]) => gap.subtree?.reasonCode === 'coverage-recheck-incomplete'));
    }));

    test('RECHECK an in-flight Apply preflight excludes Recheck before its first scan', () => fixture(async context => {
        const { tracker, dir, scope } = context;
        await seed(context);
        await atEnumeration(dir, async (entered, release) => {
            const apply = tracker.applyConfiguredMonitoringScope(scope);
            await entered;
            assert.equal((await tracker.recheckObservationCoverage()).status, 'conflict');
            release();
            assert.equal((await apply).status, 'applied');
        });
    }));

    for (const failure of ['write', 'settings']) test(`RECHECK ${failure} at gap retirement retains durable unverified state`, () => fixture(async context => {
        const { tracker } = context;
        const target = await seed(context);
        const write = vscode.workspace.fs.writeFile;
        let injected = false;
        vscode.workspace.fs.writeFile = async (uri, bytes) => {
            if (!injected && path.basename(uri.fsPath) === 'session-state.tmp.json') {
                const candidate = JSON.parse(Buffer.from(bytes).toString());
                if (!candidate.coverageGaps.some(([, gap]) => gap.subtree?.reasonCode === 'coverage-recheck-incomplete')) {
                    injected = true;
                    if (failure === 'write') { throw new Error('injected retirement persistence failure'); }
                    fireConfigurationChanged('files.watcherExclude');
                }
            }
            return write(uri, bytes);
        };
        try {
            assert.equal((await tracker.recheckObservationCoverage()).status, 'failed');
            assert.equal(injected, true);
            assert.equal(tracker.getOriginalContent(target), 'baseline');
            assert.equal(tracker.getTrackedChanges().find(change => change.filePath === target)?.currentContent, 'pending');
            assert.ok(tracker.getSubtreeCoverageGaps().some(gap => gap.reasonCode === 'coverage-recheck-incomplete'));
            assert.ok(savedState(tracker).coverageGaps.some(([, gap]) => gap.subtree?.reasonCode === 'coverage-recheck-incomplete'));
        } finally { vscode.workspace.fs.writeFile = write; }
    }));

    test('RECHECK repeated storage failure pauses rather than claiming healthy recording', () => fixture(async context => {
        const { tracker } = context;
        const target = await seed(context);
        const write = vscode.workspace.fs.writeFile;
        vscode.workspace.fs.writeFile = async (uri, bytes) => {
            if (path.basename(uri.fsPath) === 'session-state.tmp.json') { throw new Error('storage unavailable'); }
            return write(uri, bytes);
        };
        try {
            assert.equal((await tracker.recheckObservationCoverage()).status, 'failed');
            assert.equal(tracker.getIsRecording(), false);
            assert.equal(tracker.getOriginalContent(target), 'baseline');
            assert.equal(tracker.getTrackedChanges().find(change => change.filePath === target)?.currentContent, 'pending');
            assert.ok(fs.existsSync(path.join(tracker.storageUri.fsPath, 'session-state.unsaved')));
        } finally { vscode.workspace.fs.writeFile = write; }
    }));

    test('RECHECK native owner identity replacement cannot retire uncertainty', () => fixture(async context => {
        const { tracker, scope, dir } = context;
        const blind = path.join(dir, 'blind');
        fs.mkdirSync(blind); fs.writeFileSync(path.join(blind, 'original.txt'), 'baseline');
        setVsCodeExcludes({ 'files.watcherExclude': { 'blind/**': true } });
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status, 'applied');
        await atEnumeration(dir, async (entered, release) => {
            const recheck = tracker.recheckObservationCoverage();
            await entered;
            fs.renameSync(blind, path.join(dir, 'previous-directory'));
            fs.mkdirSync(blind); fs.writeFileSync(path.join(blind, 'original.txt'), 'replaced');
            release();
            assert.notEqual((await recheck).status, 'rechecked');
        });
        assert.equal(tracker.getOriginalContent(path.join(blind, 'original.txt')), 'baseline');
        assert.ok(tracker.getSubtreeCoverageGaps().length > 0);
    }));

    test('RECHECK root marker survives reload and only the exact safe shape is accepted', () => fixture(async context => {
        let { tracker } = context;
        const { dir } = context;
        const target = await seed(context);
        tracker.maxScopePreflightEntries = 1;
        assert.equal((await tracker.recheckObservationCoverage()).status, 'failed');
        const state = savedState(tracker);
        assert.ok(tracker.parsePersistedState(state));
        const rootEntry = state.coverageGaps.find(([target]) => target === dir);
        assert.ok(rootEntry);
        for (const mutate of [
            entry => { entry[1].file = entry[1].subtree; },
            entry => { entry[1].subtree.reasonCode = 'unrelated-gap'; },
            entry => { entry[1].importedCoverageRequired = true; },
            entry => { entry[0] = path.dirname(dir); },
            entry => { entry[1].subtree.targetKind = 'file'; }
        ]) {
            const invalid = structuredClone(state);
            mutate(invalid.coverageGaps.find(([target]) => target === dir));
            assert.equal(tracker.parsePersistedState(invalid), undefined);
        }
        const storage = tracker.storageUri;
        await tracker.dispose();
        tracker = new h.DiffTracker(storage); h.setTracker(tracker);
        assert.equal(await tracker.restorePersistedState(), 'restored');
        assert.equal(tracker.getOriginalContent(target), 'baseline');
        assert.ok(tracker.getSubtreeCoverageGaps().some(gap => gap.reasonCode === 'coverage-recheck-incomplete'));
        assert.equal((await tracker.recheckObservationCoverage()).status, 'rechecked');
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
        assert.equal(tracker.getOriginalContent(target), 'baseline');
    }));

    test('RECHECK stale initial save cannot pause a newer Stop then Start session', () => fixture(async context => {
        const { tracker } = context;
        const target = await seed(context);
        const write = vscode.workspace.fs.writeFile;
        let enter, release, held = false;
        const entered = new Promise(resolve => { enter = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        vscode.workspace.fs.writeFile = async (uri, bytes) => {
            if (!held && path.basename(uri.fsPath) === 'session-state.tmp.json') {
                held = true; enter(); await gate;
            }
            return write(uri, bytes);
        };
        const recheck = tracker.recheckObservationCoverage();
        try {
            await entered;
            tracker.stopRecording();
            tracker.startRecording();
            release();
            assert.equal((await recheck).status, 'conflict');
            await waitUntil(() => tracker.getBaselineState() === 'ready');
            assert.equal(tracker.getIsRecording(), true);
            assert.equal(tracker.getOriginalContent(target), 'pending');
            assert.equal(await tracker.flushPendingPersistence(), true);
            assert.equal(fs.existsSync(path.join(tracker.storageUri.fsPath, 'session-state.unsaved')), false);
        } finally { release(); await recheck; vscode.workspace.fs.writeFile = write; }
    }));

    for (const bound of ['entries', 'bytes']) test(`RECHECK ${bound} marker capacity refuses without evicting prior evidence`, () => fixture(async context => {
        const { tracker, dir } = context;
        const target = await seed(context);
        tracker.setSubtreeCoverageGap(path.join(dir, 'prior-a'), 'prior-gap', 'Prior uncertainty');
        tracker.setSubtreeCoverageGap(path.join(dir, 'prior-b'), 'prior-gap', 'Prior uncertainty');
        assert.equal(await tracker.flushPendingPersistence(), true);
        const before = JSON.stringify(savedState(tracker));
        const gaps = tracker.getSubtreeCoverageGaps();
        if (bound === 'entries') { tracker.maxPersistedSnapshots = 2; }
        else { tracker.maxPersistedBytes = Buffer.byteLength(JSON.stringify(tracker.buildPersistedState())); }
        assert.equal((await tracker.recheckObservationCoverage()).status, 'failed');
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), gaps);
        assert.equal(JSON.stringify(savedState(tracker)), before);
        assert.equal(tracker.getOriginalContent(target), 'baseline');
        assert.equal(tracker.getIsRecording(), true);
    }));

    test('RECHECK final cleanup save failure reports failure after its safe pause', () => fixture(async context => {
        const { tracker } = context;
        const target = await seed(context);
        const write = vscode.workspace.fs.writeFile;
        let writes = 0;
        vscode.workspace.fs.writeFile = async (uri, bytes) => {
            if (path.basename(uri.fsPath) === 'session-state.tmp.json' && ++writes === 3) {
                throw new Error('final cleanup save failure');
            }
            return write(uri, bytes);
        };
        try {
            const result = await tracker.recheckObservationCoverage();
            assert.equal(result.status, 'failed', JSON.stringify(result));
            assert.equal(tracker.getIsRecording(), false);
            assert.equal(tracker.getOriginalContent(target), 'baseline');
            assert.equal(tracker.getTrackedChanges().find(change => change.filePath === target)?.currentContent, 'pending');
            assert.ok(fs.existsSync(path.join(tracker.storageUri.fsPath, 'session-state.unsaved')));
        } finally { vscode.workspace.fs.writeFile = write; }
    }));
}
