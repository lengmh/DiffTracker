import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export function registerRecheckObservationCoverage(h, fixture) {
    const { test, setVsCodeExcludes, nativeDirectoryWatchers, waitUntil, Uri, vscode, fireConfigurationChanged } = h;
    const ownerFor = directory => [...nativeDirectoryWatchers].reverse().find(owner =>
        owner.active && path.resolve(String(owner.directory)) === directory);
    const savedState = tracker => JSON.parse(fs.readFileSync(path.join(tracker.storageUri.fsPath, 'session-state.json'), 'utf8'));
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
