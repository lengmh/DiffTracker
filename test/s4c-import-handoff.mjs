import { registerS4CStaleHandoff } from './s4c-stale-handoff.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateAndCanonicalizeScope } from '../out/monitoringScope.js';

export function registerS4CImportHandoff(h, fixture) {
    registerS4CStaleHandoff(h, fixture);
    const {test, Uri, DiffTracker, nativeDirectoryWatchers, waitUntil, setTracker} = h;
    function assertCurrentCoverageOrGap(tracker, directory) {
        const direct = tracker.supplementalDirectoryWatchers.get(directory) ??
            tracker.importedDirectoryWatchers.get(directory);
        const currentOwner = direct?.epoch === tracker.sessionEpoch &&
            nativeDirectoryWatchers.some(owner => owner.active && owner.directory === directory);
        const explicitGap = tracker.getSubtreeCoverageGaps().some(gap =>
            directory === gap.targetPath || directory.startsWith(`${gap.targetPath}${path.sep}`));
        assert.ok(currentOwner || explicitGap,
            `retained obligation at ${directory} requires a current owner or an explicit covering gap`);
    }
    test('S4-C imported directory releases the bridge only after persistent coverage and captures post-Keep edits', () => fixture(async ({tracker,dir}) => {
        const imported = path.join(dir, 'imported');
        const nested = path.join(imported, 'nested');
        fs.mkdirSync(nested, {recursive:true});
        const target = path.join(nested, 'new.txt');
        fs.writeFileSync(target, 'imported content');
        await tracker.onExternalFileCreated(Uri.file(imported));
        assert.equal(tracker.getTrackedChanges().find(change => change.filePath === target)?.currentContent, 'imported content');
        assert.equal(tracker.getOriginalContent(target), '');
        assert.equal(tracker.getSubtreeCoverageGaps().length, 0);
        const owners = nativeDirectoryWatchers.filter(owner => path.resolve(String(owner.directory)) === nested);
        assert.equal(owners.length, 2, 'a separately installed direct owner must overlap the temporary bridge');
        assert.equal(owners[0].active, false, 'the temporary bridge is reclaimed');
        assert.equal(owners[1].active, true, 'replacement coverage remains active');
        assert.equal((await tracker.keepAllChanges()).succeeded, 1);
        fs.writeFileSync(target, 'edited after Keep');
        owners[1].listener('change', 'new.txt');
        await waitUntil(() => tracker.getTrackedChanges().some(change => change.currentContent === 'edited after Keep'));
        assert.equal(tracker.getOriginalContent(target), 'imported content');
        tracker.stopRecording();
        assert.equal(nativeDirectoryWatchers.some(owner => owner.active), false);
    }));

    test('S4-C repeated save and reload reconstructs persistent import ownership without accepting offline edits', () => fixture(async ({tracker,dir}) => {
        const imported = path.join(dir, 'reload-import');
        fs.mkdirSync(imported);
        const target = path.join(imported, 'review.txt');
        fs.writeFileSync(target, 'accepted import');
        await tracker.onExternalFileCreated(Uri.file(imported));
        assert.equal((await tracker.keepAllChangesInFile(target)).status, 'success');
        const storage = tracker.storageUri;
        for (let iteration = 0; iteration < 2; iteration++) {
            assert.equal(await tracker.flushPendingPersistence(), true);
            const saved = JSON.parse(fs.readFileSync(path.join(storage.fsPath, 'session-state.json'), 'utf8'));
            assert.equal(saved.version, 5);
            assert.equal(saved.coverageGaps.find(([root]) => root === imported)?.[1].subtree.reasonCode,
                'imported-coverage-restart-required');
            assert.equal(saved.coverageGaps.find(([root]) => root === imported)?.[1].importedCoverageRequired, true);
            await tracker.dispose();
            fs.writeFileSync(target, `offline ${iteration}`);
            tracker = new DiffTracker(storage); setTracker(tracker);
            assert.equal(await tracker.restorePersistedState(), 'restored');
            assert.equal(tracker.getOriginalContent(target), 'accepted import');
            assert.equal(tracker.getTrackedChanges().find(change => change.filePath === target)?.currentContent, `offline ${iteration}`);
            assert.equal(tracker.getSubtreeCoverageGaps().length, 0);
            const owner = [...nativeDirectoryWatchers].reverse().find(item => item.active && item.directory === imported);
            assert.ok(owner, 'reload must independently reestablish direct coverage');
            fs.writeFileSync(target, `live ${iteration}`);
            owner.listener('change', 'review.txt');
            await waitUntil(() => tracker.getTrackedChanges().some(change => change.currentContent === `live ${iteration}`));
        }
    }));

    for (const failure of ['capacity', 'system-limit']) test(`S4-C ${failure} during overlap preserves bridge, reviews and durable uncertainty`, () => fixture(async ({tracker,dir}) => {
        const imported = path.join(dir, 'limited-import');
        fs.mkdirSync(imported);
        const target = path.join(imported, 'new.txt');
        fs.writeFileSync(target, 'pending import');
        const watch = fs.watch;
        let attempts = 0;
        if (failure === 'capacity') { tracker.maxImportedDirectoryWatchers = 1; }
        else fs.watch = (directory, ...args) => {
            if (directory === imported && ++attempts === 2) {
                throw Object.assign(new Error('watch quota'), {code:'ENOSPC'});
            }
            return watch(directory, ...args);
        };
        try { await tracker.onExternalFileCreated(Uri.file(imported)); }
        finally { fs.watch = watch; }
        assert.equal(tracker.getOriginalContent(target), '');
        assert.equal(tracker.getTrackedChanges().find(change => change.filePath === target)?.currentContent, 'pending import');
        assert.ok(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === imported));
        const live = nativeDirectoryWatchers.filter(owner => owner.active);
        assert.equal(live.length, 1, 'useful bridge survives failed replacement without leaking partial owners');
        fs.writeFileSync(target, 'bridge still sees edits');
        live[0].listener('change', 'new.txt');
        await waitUntil(() => tracker.getTrackedChanges().some(change => change.currentContent === 'bridge still sees edits'));
        assert.equal(await tracker.flushPendingPersistence(), true);
        const saved = JSON.parse(fs.readFileSync(path.join(tracker.storageUri.fsPath, 'session-state.json'), 'utf8'));
        assert.equal(saved.coverageGaps.find(([root]) => root === imported)?.[1].subtree.reasonCode,
            'imported-coverage-restart-required');
    }));

    test('S4-C nested imports restore unchanged descendant obligations under their persistent ancestor', () => fixture(async ({tracker,dir}) => {
        const outer = path.join(dir, 'outer-import');
        fs.mkdirSync(outer);
        await tracker.onExternalFileCreated(Uri.file(outer));
        const inner = path.join(outer, 'inner-import');
        fs.mkdirSync(inner);
        const target = path.join(inner, 'new.txt');
        fs.writeFileSync(target, 'nested import');
        await tracker.onExternalFileCreated(Uri.file(inner));
        assert.equal(tracker.getSubtreeCoverageGaps().length, 0);
        assert.equal((await tracker.keepAllChangesInFile(target)).status, 'success');
        const storage = tracker.storageUri;
        await tracker.dispose();
        tracker = new DiffTracker(storage); setTracker(tracker);
        assert.equal(await tracker.restorePersistedState(), 'restored');
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
        const owner = [...nativeDirectoryWatchers].reverse().find(item => item.active && item.directory === inner);
        assert.ok(owner);
        fs.writeFileSync(target, 'nested edit after reload');
        owner.listener('change', 'new.txt');
        await waitUntil(() => tracker.getTrackedChanges().some(change => change.currentContent === 'nested edit after reload'));
        assert.equal(tracker.getOriginalContent(target), 'nested import');
    }));

    test('S4-C Rules import captures opaque edits after acknowledgement and preserves coverage across Stop and Start', () => fixture(async ({tracker,dir}) => {
        const imported = path.join(dir, 'rules-import');
        fs.mkdirSync(imported);
        const target = path.join(imported, 'image.bin');
        fs.writeFileSync(target, Buffer.from([0,1,2,3]));
        await tracker.onExternalFileCreated(Uri.file(imported));
        assert.equal(tracker.getTrackedChanges().find(change => change.filePath === target)?.reviewKind, 'opaque');
        assert.equal((await tracker.acknowledgeOpaqueChange(target)).status, 'success');
        let owner = [...nativeDirectoryWatchers].reverse().find(item => item.active && item.directory === imported);
        assert.ok(owner);
        fs.writeFileSync(target, Buffer.from([0,4,5,6]));
        owner.listener('change', 'image.bin');
        await waitUntil(() => tracker.getTrackedChanges().some(change => change.filePath === target));
        assert.equal(tracker.getTrackedChanges().find(change => change.filePath === target)?.reviewKind, 'opaque');
        h.setListedFiles([Uri.file(target)]);
        tracker.stopRecording();
        assert.equal(nativeDirectoryWatchers.some(item => item.active), false);
        tracker.startRecording();
        await waitUntil(() => tracker.getBaselineState() === 'ready');
        owner = [...nativeDirectoryWatchers].reverse().find(item => item.active && item.directory === imported);
        assert.ok(owner);
        assert.equal(tracker.getSubtreeCoverageGaps().length, 0);
        fs.writeFileSync(target, Buffer.from([0,7,8,9]));
        owner.listener('change', 'image.bin');
        await waitUntil(() => tracker.getTrackedChanges().some(change => change.filePath === target));
        assert.equal(tracker.getTrackedChanges().find(change => change.filePath === target)?.reviewKind, 'opaque');
    }, 'rules'));

    test('S4-C a failed persistent owner retains its restart obligation through failure and reload', () => fixture(async ({tracker,dir}) => {
        const imported = path.join(dir, 'failed-owner');
        fs.mkdirSync(imported);
        const target = path.join(imported, 'new.txt');
        fs.writeFileSync(target, 'preserved baseline');
        await tracker.onExternalFileCreated(Uri.file(imported));
        await tracker.keepAllChangesInFile(target);
        const owner = [...nativeDirectoryWatchers].reverse().find(item => item.active && item.directory === imported);
        owner.error(Object.assign(new Error('native failure'), {code:'EIO'}));
        assert.ok(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === imported));
        assert.equal(await tracker.flushPendingPersistence(), true);
        const storage = tracker.storageUri;
        const saved = JSON.parse(fs.readFileSync(path.join(storage.fsPath, 'session-state.json'), 'utf8'));
        const evidence = saved.coverageGaps.find(([root]) => root === imported)?.[1].subtree;
        assert.equal(evidence.reasonCode, 'imported-coverage-restart-required');
        assert.match(evidence.reason, /native failure/);
        await tracker.dispose();
        fs.writeFileSync(target, 'changed while owner failed');
        tracker = new DiffTracker(storage); setTracker(tracker);
        assert.equal(await tracker.restorePersistedState(), 'restored');
        assert.equal(tracker.getOriginalContent(target), 'preserved baseline');
        assert.equal(tracker.getTrackedChanges().find(change => change.filePath === target)?.currentContent, 'changed while owner failed');
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
    }));

    test('S4-C pending exclusion control evidence survives imported-root persistence and withdrawal after reload', () => fixture(async ({tracker,dir}) => {
        const imported = path.join(dir, 'pending-root');
        fs.mkdirSync(imported);
        fs.writeFileSync(path.join(imported, 'new.txt'), 'pending review');
        await tracker.onExternalFileCreated(Uri.file(imported));
        const requested = validateAndCanonicalizeScope({mode:'wholeWorkspace', includes:[],
            excludes:[{scope:'all',pattern:'pending-root'}]}, tracker.currentWorkspaceRootIdentities());
        assert.equal(requested.ok, true);
        tracker.setPendingMonitoringScope(requested.scope);
        await tracker.onExternalFileCreated(Uri.file(imported));
        assert.equal(await tracker.flushPendingPersistence(), true);
        const storage = tracker.storageUri;
        const saved = JSON.parse(fs.readFileSync(path.join(storage.fsPath, 'session-state.json'), 'utf8'));
        assert.equal(saved.coverageGaps.find(([root]) => root === imported)?.[1].subtree.reasonCode,
            'pending-scope-deferred-event');
        assert.equal(saved.coverageGaps.find(([root]) => root === imported)?.[1].importedCoverageRequired, true);
        await tracker.dispose();
        tracker = new DiffTracker(storage); setTracker(tracker);
        assert.equal(await tracker.restorePersistedState(), 'restored');
        tracker.setPendingMonitoringScope(undefined);
        assert.ok(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === imported &&
            gap.reasonCode === 'pending-scope-gap'), 'withdrawal must not manufacture healthy coverage');
        assert.ok(nativeDirectoryWatchers.some(owner => owner.active && owner.directory === imported),
            'pending control evidence must not hide the independent restart ownership obligation');
        assert.equal(await tracker.resetBaselineToCurrentState(), true);
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
        const owner = [...nativeDirectoryWatchers].reverse().find(item => item.active && item.directory === imported);
        assert.ok(owner, 'Reset may clear the gap only with persistent observation restored');
        const target = path.join(imported, 'new.txt');
        fs.writeFileSync(target, 'edit after pending recovery');
        owner.listener('change', 'new.txt');
        await waitUntil(() => tracker.getTrackedChanges().some(change =>
            change.filePath === target && change.currentContent === 'edit after pending recovery'));
    }));

    test('S4-C pending root control survives native failure and reload without hiding unseen children', () => fixture(async ({tracker,dir}) => {
        const imported = path.join(dir, 'empty-pending');
        fs.mkdirSync(imported);
        await tracker.onExternalFileCreated(Uri.file(imported));
        const requested = validateAndCanonicalizeScope({mode:'wholeWorkspace', includes:[],
            excludes:[{scope:'all',pattern:'empty-pending'}]}, tracker.currentWorkspaceRootIdentities());
        tracker.setPendingMonitoringScope(requested.scope);
        const target = path.join(imported, 'unseen.txt');
        fs.writeFileSync(target, 'unseen pending addition');
        await tracker.onExternalFileCreated(Uri.file(imported));
        const owner = nativeDirectoryWatchers.find(item => item.active && item.directory === imported);
        owner.listener('rename', undefined);
        owner.error(Object.assign(new Error('latest native failure while pending '.repeat(100)), {code:'EIO'}));
        const failedGap = tracker.getSubtreeCoverageGaps().find(gap => gap.targetPath === imported);
        assert.equal(failedGap.reasonCode, 'pending-scope-deferred-event');
        assert.ok(failedGap.reason.length <= 1000);
        assert.match(failedGap.reason, /latest native failure/);
        assert.doesNotMatch(failedGap.reason, /unnamed event/, 'health detail is replaced, not repeatedly appended');
        const storage = tracker.storageUri;
        await tracker.dispose();
        tracker = new DiffTracker(storage); setTracker(tracker);
        // Production installs the requested-scope gate before restoring a session.
        tracker.setPendingMonitoringScope(requested.scope);
        assert.equal(await tracker.restorePersistedState(), 'restored');
        tracker.setPendingMonitoringScope(undefined);
        assert.ok(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === imported &&
            gap.reasonCode === 'pending-scope-gap'),
        'a skipped pending subtree must retain its control evidence after owner reinstallation');
        assert.equal(tracker.getTrackedChanges().some(change => change.filePath === imported), false,
            'a directory control gap must not become a phantom file review');
        assert.equal(await tracker.resetBaselineToCurrentState(), true);
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
        const restoredOwner = nativeDirectoryWatchers.find(item => item.active && item.directory === imported);
        assert.ok(restoredOwner);
        fs.writeFileSync(target, 'edit after empty-root recovery');
        restoredOwner.listener('change', 'unseen.txt');
        await waitUntil(() => tracker.getTrackedChanges().some(change =>
            change.filePath === target && change.currentContent === 'edit after empty-root recovery'));
    }));

    for (const transition of ['Reset', 'Stop-Start', 'Stop-Clear-reload-Start']) {
        test(`S4-C withdrawal before save retains ownership through ${transition}`, () => fixture(async ({tracker,dir}) => {
            const imported = path.join(dir, 'withdrawn-root');
            fs.mkdirSync(imported);
            const target = path.join(imported, 'new.txt');
            fs.writeFileSync(target, 'before withdrawal');
            await tracker.onExternalFileCreated(Uri.file(imported));
            const requested = validateAndCanonicalizeScope({mode:'wholeWorkspace', includes:[],
                excludes:[{scope:'all',pattern:'withdrawn-root'}]}, tracker.currentWorkspaceRootIdentities());
            tracker.setPendingMonitoringScope(requested.scope);
            await tracker.onExternalFileCreated(Uri.file(imported));
            tracker.setPendingMonitoringScope(undefined);
            const storage = tracker.storageUri;
            await tracker.dispose();
            tracker = new DiffTracker(storage); setTracker(tracker);
            assert.equal(await tracker.restorePersistedState(), 'restored');
            assert.ok(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === imported));
            if (transition === 'Reset') { assert.equal(await tracker.resetBaselineToCurrentState(), true); }
            else {
                tracker.stopRecording();
                if (transition === 'Stop-Clear-reload-Start') {
                    assert.equal(await tracker.resetBaselineToCurrentState(), true);
                    await tracker.dispose();
                    tracker = new DiffTracker(storage); setTracker(tracker);
                    assert.equal(await tracker.restorePersistedState(), 'restored');
                    assert.equal(tracker.getIsRecording(), false);
                    assert.equal(nativeDirectoryWatchers.some(owner => owner.active), false);
                }
                tracker.startRecording();
                await waitUntil(() => tracker.getBaselineState() === 'ready');
            }
            assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
            const owner = nativeDirectoryWatchers.find(item => item.active && item.directory === imported);
            assert.ok(owner);
            fs.writeFileSync(target, 'edit after recovered lifecycle');
            owner.listener('change', 'new.txt');
            await waitUntil(() => tracker.getTrackedChanges().some(change =>
                change.filePath === target && change.currentContent === 'edit after recovered lifecycle'));
        }));
    }

    test('S4-C pending directory deletion stays subtree-typed through reconstruction owner restore', () => fixture(async ({tracker,dir}) => {
        const imported = path.join(dir, 'deleted-pending');
        fs.mkdirSync(imported);
        const target = path.join(imported, 'new.txt');
        fs.writeFileSync(target, 'before deferred deletion');
        await tracker.onExternalFileCreated(Uri.file(imported));
        const requested = validateAndCanonicalizeScope({mode:'wholeWorkspace', includes:[],
            excludes:[{scope:'all',pattern:'deleted-pending'}]}, tracker.currentWorkspaceRootIdentities());
        tracker.setPendingMonitoringScope(requested.scope);
        fs.rmSync(imported, {recursive:true});
        await tracker.onExternalFileDeleted(Uri.file(imported));
        const storage = tracker.storageUri;
        await tracker.dispose();
        tracker = new DiffTracker(storage); setTracker(tracker);
        tracker.setPendingMonitoringScope(requested.scope);
        assert.equal(await tracker.restorePersistedState(), 'restored');
        const gap = tracker.getSubtreeCoverageGaps().find(item => item.targetPath === imported);
        assert.equal(gap?.reasonCode, 'pending-scope-deferred-delete');
        assert.match(gap.reason, /explicit exclusion awaited confirmation/);
        assert.equal(nativeDirectoryWatchers.some(owner => owner.active && owner.directory === imported), false);
        assert.equal(tracker.supplementalDirectoryWatchers.get(imported)?.observationDirectory,dir,
            'a reconstruction owner does not certify the independent pending-scope control evidence');
        assert.equal(await tracker.flushPendingPersistence(), true);
        const saved = JSON.parse(fs.readFileSync(path.join(storage.fsPath, 'session-state.json'), 'utf8'));
        const record = new Map(saved.coverageGaps).get(imported);
        assert.equal(record.importedCoverageRequired, true);
        assert.equal(record.subtree.reasonCode, 'pending-scope-deferred-delete');
        tracker.setPendingMonitoringScope(undefined);
        assert.ok(tracker.getSubtreeCoverageGaps().some(item => item.targetPath === imported &&
            item.reasonCode === 'pending-scope-gap'));
        assert.equal(tracker.getTrackedChanges().some(change => change.filePath === imported), false);
        fs.mkdirSync(imported);
        fs.writeFileSync(target, 'recreated before reset');
        assert.equal(await tracker.resetBaselineToCurrentState(), true);
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
        const owner = nativeDirectoryWatchers.find(item => item.active && item.directory === imported);
        assert.ok(owner);
        fs.writeFileSync(target, 'edit after deleted-root recovery');
        owner.listener('change', 'new.txt');
        await waitUntil(() => tracker.getTrackedChanges().some(change =>
            change.filePath === target && change.currentContent === 'edit after deleted-root recovery'));
    }));

    test('S4-C child-first overlapping ownership stays visible and Stop then Start rebuilds persistent coverage', () => fixture(async ({tracker,dir}) => {
        const outer = path.join(dir, 'child-first');
        const inner = path.join(outer, 'nested');
        fs.mkdirSync(inner, {recursive:true});
        const target = path.join(inner, 'new.txt');
        fs.writeFileSync(target, 'child first');
        await tracker.onExternalFileCreated(Uri.file(inner));
        await tracker.onExternalFileCreated(Uri.file(outer));
        const gap = tracker.getSubtreeCoverageGaps().find(item => item.targetPath === outer);
        assert.ok(gap);
        assert.match(gap.reason, /Stop.*Start/i, 'tell the user the recovery that actually changes ownership');
        tracker.stopRecording();
        tracker.startRecording();
        await waitUntil(() => tracker.getBaselineState() === 'ready');
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
        const owner = [...nativeDirectoryWatchers].reverse().find(item => item.active && item.directory === inner);
        assert.ok(owner);
        fs.writeFileSync(target, 'edited after recovery');
        owner.listener('change', 'new.txt');
        await waitUntil(() => tracker.getTrackedChanges().some(change => change.currentContent === 'edited after recovery'));
        assert.equal(tracker.getOriginalContent(target), 'child first');
    }));

    test('S4-C scan-time bridge discovery cannot clear an unverified persistent-coverage obligation', () => fixture(async ({tracker,dir}) => {
        const parent = path.join(dir, 'scan-parent');
        fs.mkdirSync(parent);
        await tracker.installSupplementalCoverageTargets([parent], tracker.sessionEpoch, true);
        tracker.commitSupplementalCoverageTargets([parent]);
        const child = path.join(parent, 'scan-child');
        fs.mkdirSync(child);
        fs.writeFileSync(path.join(child, 'new.txt'), 'unknown scan provenance');
        const dispatch = tracker.dispatchExternalEvent;
        tracker.dispatchExternalEvent = () => {};
        nativeDirectoryWatchers.find(owner => owner.active && owner.directory === parent).listener('rename', 'scan-child');
        tracker.dispatchExternalEvent = dispatch;
        await tracker.onExternalFileCreated(Uri.file(child), true);
        assert.ok(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === child),
            'a temporary bridge plus scan is not persistent handoff proof');
        assert.ok(tracker.importedDirectoryWatchers.has(child));
    }));

    test('S4-C healthy restart descriptors count toward the existing gap budget before another import', () => fixture(async ({tracker,dir}) => {
        const first = path.join(dir, 'budget-owner');
        fs.mkdirSync(first);
        await tracker.onExternalFileCreated(Uri.file(first));
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
        tracker.maxPersistedSnapshots = 1;
        const second = path.join(dir, 'budget-rejected');
        fs.mkdirSync(second);
        const target = path.join(second, 'new.txt');
        fs.writeFileSync(target, 'must not be accepted');
        await tracker.onExternalFileCreated(Uri.file(second));
        assert.equal(tracker.getIsRecording(), false, 'unpersistable coverage must pause before child capture');
        assert.equal(tracker.getOriginalContent(target), undefined);
        assert.equal(nativeDirectoryWatchers.some(owner => owner.active), false);
        const saved = JSON.parse(fs.readFileSync(path.join(tracker.storageUri.fsPath, 'session-state.json'), 'utf8'));
        assert.equal(saved.coverageGaps.length, 1);
        assert.equal(saved.coverageGaps[0][0], first);
    }));

    test('S4-C import reserves independent ownership bytes before acquiring watchers or capturing children', () => fixture(async ({tracker,dir}) => {
        const imported = path.join(dir, 'byte-limited-import');
        fs.mkdirSync(imported);
        const target = path.join(imported, 'new.txt');
        fs.writeFileSync(target, 'must remain uncaptured');
        assert.equal(await tracker.flushPendingPersistence(), true);
        const prior = JSON.parse(fs.readFileSync(path.join(tracker.storageUri.fsPath, 'session-state.json'), 'utf8'));
        // The old gap-only representation fits exactly. It cannot authorize an
        // import whose independent ownership descriptor needs additional bytes.
        const gapOnly = structuredClone(prior);
        gapOnly.coverageGaps.push([imported, {subtree:{targetKind:'subtree',
            reasonCode:'directory-runtime-coverage-gap',
            reason:'Imported directory watch coverage is incomplete; current files were scanned, but rebuild the baseline after reducing watched directories or resolving the system watcher limit'}}]);
        tracker.maxPersistedBytes = Buffer.byteLength(JSON.stringify(gapOnly), 'utf8');
        await tracker.onExternalFileCreated(Uri.file(imported));
        assert.equal(tracker.getIsRecording(), false);
        assert.equal(tracker.getOriginalContent(target), undefined);
        assert.equal(nativeDirectoryWatchers.length, 0, 'reject the unreserved descriptor before native acquisition');
        const saved = JSON.parse(fs.readFileSync(path.join(tracker.storageUri.fsPath, 'session-state.json'), 'utf8'));
        assert.deepEqual(saved.fileSnapshots, prior.fileSnapshots);
        assert.deepEqual(saved.coverageGaps, prior.coverageGaps);
    }));

    test('S4-C saving an established obligation does not reclassify a temporarily missing filesystem spelling', () => fixture(async ({tracker,dir}) => {
        if (process.platform === 'win32' || process.platform === 'darwin') { return; }
        const imported = path.join(dir, '.GIT');
        fs.mkdirSync(imported);
        fs.writeFileSync(path.join(imported, 'review.txt'), 'ordinary Linux directory');
        await tracker.onExternalFileCreated(Uri.file(imported));
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
        assert.equal(tracker.importedDirectoryWatchers.size, 0);
        fs.renameSync(imported, `${imported}-moved`);
        assert.equal(await tracker.flushPendingPersistence(), true);
        const saved = JSON.parse(fs.readFileSync(path.join(tracker.storageUri.fsPath, 'session-state.json'), 'utf8'));
        assert.ok(saved.coverageGaps.some(([root, record]) => root === imported &&
            record.subtree?.reasonCode === 'imported-coverage-restart-required'),
        'serialization must preserve durable identity obligations without consulting current directory entries');
    }));

    for (const lifecycle of ['live', 'reload']) test(`S4-C explicit exclusion without discard preserves imported review and ownership ${lifecycle}`, () => fixture(async ({tracker,dir}) => {
        const imported = path.join(dir, 'unapproved-exclusion');
        fs.mkdirSync(imported);
        const target = path.join(imported, 'pending.txt');
        fs.writeFileSync(target, 'pending import');
        await tracker.onExternalFileCreated(Uri.file(imported));
        const previous = tracker.getEffectiveMonitoringScope();
        const owner = nativeDirectoryWatchers.find(item => item.active && item.directory === imported);
        assert.ok(owner);
        const requested = validateAndCanonicalizeScope({mode:'wholeWorkspace', includes:[],
            excludes:[{scope:'all',pattern:'unapproved-exclusion'}]}, tracker.currentWorkspaceRootIdentities());
        assert.equal(requested.ok, true);
        const result = await tracker.applyConfiguredMonitoringScope(requested.scope, false, () => true);
        assert.equal(result.status, 'conflict', JSON.stringify(result));
        assert.match(result.reason, /discard.*confirm|confirm.*discard/i);
        assert.deepEqual(tracker.getEffectiveMonitoringScope(), previous);
        assert.equal(owner.active, true, 'refusal must preserve the exact committed owner');
        assert.equal(tracker.getOriginalContent(target), '');
        assert.equal(tracker.getTrackedChanges().find(change => change.filePath === target)?.currentContent, 'pending import');
        assert.equal(fs.readFileSync(target, 'utf8'), 'pending import');
        assert.equal(await tracker.flushPendingPersistence(), true);
        const storage = tracker.storageUri;
        const saved = JSON.parse(fs.readFileSync(path.join(storage.fsPath, 'session-state.json'), 'utf8'));
        assert.equal(saved.coverageGaps.find(([root]) => root === imported)?.[1].importedCoverageRequired, true);
        if (lifecycle === 'reload') {
            await tracker.dispose();
            tracker = new DiffTracker(storage); setTracker(tracker);
            assert.equal(await tracker.restorePersistedState(), 'restored');
            assert.deepEqual(tracker.getEffectiveMonitoringScope(), previous);
        }
        const activeOwner = [...nativeDirectoryWatchers].reverse().find(item => item.active && item.directory === imported);
        assert.ok(activeOwner);
        fs.writeFileSync(target, 'edit after refused exclusion');
        if (!process.env.DT_REAL_DIRECTORY_WATCH) activeOwner.listener('change', 'pending.txt');
        await waitUntil(() => tracker.getTrackedChanges().some(change =>
            change.filePath === target && change.currentContent === 'edit after refused exclusion'));
        assert.equal(tracker.getOriginalContent(target), '');
    }));

    test('S4-C a committed explicit scope exclusion retires the imported obligation durably', () => fixture(async ({tracker,dir}) => {
        const imported = path.join(dir, 'retired-import');
        fs.mkdirSync(imported);
        const target = path.join(imported, 'new.txt');
        fs.writeFileSync(target, 'accepted before contraction');
        await tracker.onExternalFileCreated(Uri.file(imported));
        await tracker.keepAllChangesInFile(target);
        const requested = validateAndCanonicalizeScope({mode:'wholeWorkspace', includes:[],
            excludes:[{scope:'all',pattern:'retired-import'}]}, tracker.currentWorkspaceRootIdentities());
        assert.equal(requested.ok, true);
        assert.equal((await tracker.applyConfiguredMonitoringScope(requested.scope, false, () => true)).status, 'applied');
        const saved = JSON.parse(fs.readFileSync(path.join(tracker.storageUri.fsPath, 'session-state.json'), 'utf8'));
        assert.equal(saved.coverageGaps.some(([root]) => root === imported), false);
        assert.equal(nativeDirectoryWatchers.some(owner => owner.active && owner.directory === imported), false);
    }));

    test('S4-C revision-bound discard retires imported review and ownership durably', () => fixture(async ({tracker,dir}) => {
        const imported = path.join(dir, 'approved-discard');
        fs.mkdirSync(imported);
        const target = path.join(imported, 'pending.txt');
        fs.writeFileSync(target, 'discarded review stays on disk');
        await tracker.onExternalFileCreated(Uri.file(imported));
        const owner = nativeDirectoryWatchers.find(item => item.active && item.directory === imported);
        const requested = validateAndCanonicalizeScope({mode:'wholeWorkspace', includes:[],
            excludes:[{scope:'all',pattern:'approved-discard'}]}, tracker.currentWorkspaceRootIdentities());
        const revision = tracker.getExplicitlyExcludedReviewRevision(requested.scope);
        const result = await tracker.applyConfiguredMonitoringScope(requested.scope, true, () => true, revision);
        assert.equal(result.status, 'applied', JSON.stringify(result));
        assert.equal(result.discardedReviews, 1);
        assert.equal(result.retainedReviews, 0);
        assert.equal(owner.active, false);
        assert.equal(tracker.getOriginalContent(target), undefined);
        assert.equal(tracker.getTrackedChanges().some(change => change.filePath === target), false);
        assert.equal(fs.readFileSync(target, 'utf8'), 'discarded review stays on disk');
        const storage = tracker.storageUri;
        const saved = JSON.parse(fs.readFileSync(path.join(storage.fsPath, 'session-state.json'), 'utf8'));
        assert.equal(saved.coverageGaps.some(([root]) => root === imported), false);
        await tracker.dispose();
        tracker = new DiffTracker(storage); setTracker(tracker);
        assert.equal(await tracker.restorePersistedState(), 'restored');
        assert.equal(tracker.getEffectiveMonitoringScope().scopeRevision, requested.scope.scopeRevision);
        assert.equal(tracker.getTrackedChanges().some(change => change.filePath === target), false);
        assert.equal(nativeDirectoryWatchers.some(item => item.active && item.directory === imported), false);
    }));

    for (const barrier of ['preparation', 'durable-copy']) test(`S4-C excluded review arriving during ${barrier} refuses publication and preserves exact imported owner`, () => fixture(async ({tracker,dir}) => {
        const imported = path.join(dir, 'late-exclusion-event');
        fs.mkdirSync(imported);
        const target = path.join(imported, 'accepted.txt');
        fs.writeFileSync(target, 'accepted before Apply');
        await tracker.onExternalFileCreated(Uri.file(imported));
        assert.equal((await tracker.keepAllChangesInFile(target)).status, 'success');
        assert.equal(await tracker.flushPendingPersistence(), true);
        const previous = tracker.getEffectiveMonitoringScope();
        const owner = nativeDirectoryWatchers.find(item => item.active && item.directory === imported);
        const requested = validateAndCanonicalizeScope({mode:'wholeWorkspace', includes:[],
            excludes:[{scope:'all',pattern:'late-exclusion-event'}]}, tracker.currentWorkspaceRootIdentities());
        const gate = h.pause(path.join(tracker.storageUri.fsPath,
            barrier === 'preparation' ? 'session-state.tmp.json' : 'session-state.json'),
        barrier === 'preparation' ? 'write' : 'copy');
        const applying = tracker.applyConfiguredMonitoringScope(requested.scope, false, () => true);
        try {
            const reached = await Promise.race([gate.entered.then(() => 'barrier'), applying.then(result => result)]);
            assert.equal(reached, 'barrier', JSON.stringify(reached));
            fs.writeFileSync(target, 'change observed during Apply');
            await tracker.onExternalFileChanged(Uri.file(target));
        } finally { gate.release(); }
        const result = await applying;
        assert.notEqual(result.status, 'applied', JSON.stringify(result));
        assert.deepEqual(tracker.getEffectiveMonitoringScope(), previous);
        assert.equal(owner.active, true, 'rollback preserves the same committed owner');
        assert.equal(tracker.getOriginalContent(target), 'accepted before Apply');
        assert.equal(tracker.getTrackedChanges().find(change => change.filePath === target)?.currentContent,
            'change observed during Apply');
        const saved = JSON.parse(fs.readFileSync(path.join(tracker.storageUri.fsPath, 'session-state.json'), 'utf8'));
        assert.equal(saved.effectiveMonitoringScope.scopeRevision, previous.scopeRevision);
        assert.equal(saved.coverageGaps.find(([root]) => root === imported)?.[1].importedCoverageRequired, true);
        fs.writeFileSync(target, 'later native-only edit');
        if (!process.env.DT_REAL_DIRECTORY_WATCH) owner.listener('change', 'accepted.txt');
        await waitUntil(() => tracker.getTrackedChanges().some(change =>
            change.filePath === target && change.currentContent === 'later native-only edit'));
    }));

    test('S4-C stopped restore and explicit contraction cannot resurrect a retired restart obligation', () => fixture(async ({tracker,dir}) => {
        const imported = path.join(dir, 'retired-stopped-import');
        fs.mkdirSync(imported);
        await tracker.onExternalFileCreated(Uri.file(imported));
        tracker.stopRecording();
        const storage = tracker.storageUri;
        await tracker.dispose();
        tracker = new DiffTracker(storage); setTracker(tracker);
        assert.equal(await tracker.restorePersistedState(), 'restored');
        assert.equal(tracker.getIsRecording(), false);
        assert.equal(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === imported), false,
            'empty stopped review presents the retained import obligation as dormant, not a live warning');
        assert.equal(tracker.importedCoverageObligations.has(imported), true,
            'the dormant obligation must remain durable until explicit exclusion retires it');
        const requested = validateAndCanonicalizeScope({mode:'wholeWorkspace', includes:[],
            excludes:[{scope:'all',pattern:'retired-stopped-import'}]}, tracker.currentWorkspaceRootIdentities());
        assert.equal((await tracker.applyConfiguredMonitoringScope(requested.scope, false, () => true)).status, 'applied');
        assert.equal(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === imported), false);
        await tracker.dispose();
        tracker = new DiffTracker(storage); setTracker(tracker);
        assert.equal(await tracker.restorePersistedState(), 'restored');
        assert.equal(await tracker.flushPendingPersistence(), true);
        const saved = JSON.parse(fs.readFileSync(path.join(storage.fsPath, 'session-state.json'), 'utf8'));
        assert.equal(saved.coverageGaps.some(([root]) => root === imported), false,
            'a retired restart reason must not regenerate an ownership marker on reload');
        tracker.startRecording();
        await waitUntil(() => tracker.getBaselineState() === 'ready');
        assert.equal(nativeDirectoryWatchers.some(owner => owner.active && owner.directory === imported), false);
    }));

    test('S4-C rejected scope persistence restores the imported obligation and its live owner', () => fixture(async ({tracker,dir}) => {
        const imported = path.join(dir, 'rollback-import');
        fs.mkdirSync(imported);
        const target = path.join(imported, 'new.txt');
        fs.writeFileSync(target, 'accepted before rejected contraction');
        await tracker.onExternalFileCreated(Uri.file(imported));
        await tracker.keepAllChangesInFile(target);
        const previous = tracker.getEffectiveMonitoringScope();
        const requested = validateAndCanonicalizeScope({mode:'wholeWorkspace', includes:[],
            excludes:[{scope:'all',pattern:'rollback-import'}]}, tracker.currentWorkspaceRootIdentities());
        const flush = tracker.flushPersistState.bind(tracker);
        let rejected = false;
        tracker.flushPersistState = async (...args) => {
            if (!rejected && tracker.effectiveMonitoringScope.scopeRevision === requested.scope.scopeRevision) {
                rejected = true; return false;
            }
            return flush(...args);
        };
        try {
            assert.equal((await tracker.applyConfiguredMonitoringScope(requested.scope, false, () => true)).status, 'failed');
        } finally { tracker.flushPersistState = flush; }
        assert.equal(rejected, true);
        assert.equal(tracker.getEffectiveMonitoringScope().scopeRevision, previous.scopeRevision);
        const saved = JSON.parse(fs.readFileSync(path.join(tracker.storageUri.fsPath, 'session-state.json'), 'utf8'));
        assert.ok(saved.coverageGaps.some(([root, record]) => root === imported &&
            record.subtree?.reasonCode === 'imported-coverage-restart-required'));
        const owner = [...nativeDirectoryWatchers].reverse().find(item => item.active && item.directory === imported);
        assert.ok(owner);
        fs.writeFileSync(target, 'edit after rejected contraction');
        owner.listener('change', 'new.txt');
        await waitUntil(() => tracker.getTrackedChanges().some(change => change.currentContent === 'edit after rejected contraction'));
        assert.equal(tracker.getOriginalContent(target), 'accepted before rejected contraction');
    }));

    test('S4-C scope rollback retains pending control and a newer native failure independently of ownership', () => fixture(async ({tracker,dir}) => {
        const imported = path.join(dir, 'pending-rollback');
        fs.mkdirSync(imported);
        const target = path.join(imported, 'new.txt');
        fs.writeFileSync(target, 'before failed apply');
        await tracker.onExternalFileCreated(Uri.file(imported));
        const pending = validateAndCanonicalizeScope({mode:'wholeWorkspace', includes:[],
            excludes:[{scope:'all',pattern:'pending-rollback'}]}, tracker.currentWorkspaceRootIdentities());
        tracker.setPendingMonitoringScope(pending.scope);
        await tracker.onExternalFileCreated(Uri.file(imported));
        const requested = validateAndCanonicalizeScope({mode:'wholeWorkspace', includes:[],
            excludes:[{scope:'all',pattern:'unrelated'}]}, tracker.currentWorkspaceRootIdentities());
        const flush = tracker.flushPersistState.bind(tracker);
        let rejected = false;
        tracker.flushPersistState = async (...args) => {
            if (!rejected && tracker.effectiveMonitoringScope.scopeRevision === requested.scope.scopeRevision) {
                rejected = true;
                const owner = nativeDirectoryWatchers.find(item => item.active && item.directory === imported);
                owner.error(Object.assign(new Error('failure during rollback'), {code:'ENOSPC'}));
                return false;
            }
            return flush(...args);
        };
        try { assert.equal((await tracker.applyConfiguredMonitoringScope(requested.scope, false, () => true)).status, 'failed'); }
        finally { tracker.flushPersistState = flush; }
        assert.equal(rejected, true);
        const gap = tracker.getSubtreeCoverageGaps().find(item => item.targetPath === imported);
        assert.equal(gap.reasonCode, 'pending-scope-deferred-event');
        assert.match(gap.reason, /ENOSPC/);
        const saved = JSON.parse(fs.readFileSync(path.join(tracker.storageUri.fsPath, 'session-state.json'), 'utf8'));
        const record = new Map(saved.coverageGaps).get(imported);
        assert.equal(record.importedCoverageRequired, true);
        assert.equal(record.subtree.reasonCode, 'pending-scope-deferred-event');
        assert.match(record.subtree.reason, /ENOSPC/);
        tracker.setPendingMonitoringScope(undefined);
        assert.equal(tracker.getTrackedChanges().some(change => change.filePath === imported), false);
        assert.equal(await tracker.resetBaselineToCurrentState(), true);
        const owner = nativeDirectoryWatchers.find(item => item.active && item.directory === imported);
        assert.ok(owner);
        fs.writeFileSync(target, 'after failed scope transaction');
        owner.listener('change', 'new.txt');
        await waitUntil(() => tracker.getTrackedChanges().some(change =>
            change.filePath === target && change.currentContent === 'after failed scope transaction'));
    }));

    for (const transition of ['Apply', 'Reset']) test(`S4-C ${transition} refuses an obsolete plan after another import completes`, () => fixture(async ({tracker,dir,scope}) => {
        const imported = path.join(dir, 'late-import');
        const target = path.join(imported, 'new.txt');
        const method = transition === 'Apply' ? 'drainDeferredScopeApplyEvents' : 'refreshIgnoreMatchers';
        const original = tracker[method].bind(tracker);
        let inserted = false;
        tracker[method] = async (...args) => {
            const result = await original(...args);
            if (!inserted) {
                inserted = true;
                fs.mkdirSync(imported);
                fs.writeFileSync(target, 'arrived during transition');
                await tracker.onExternalFileCreated(Uri.file(imported));
            }
            return result;
        };
        try {
            if (transition === 'Apply') {
                assert.equal((await tracker.applyConfiguredMonitoringScope(scope, false, () => true)).status, 'conflict');
            } else { assert.equal(await tracker.resetBaselineToCurrentState(), false); }
        } finally { tracker[method] = original; }
        assert.equal(inserted, true);
        assert.equal(tracker.getOriginalContent(target), '');
        assert.equal(await tracker.flushPendingPersistence(), true);
        const saved = JSON.parse(fs.readFileSync(path.join(tracker.storageUri.fsPath, 'session-state.json'), 'utf8'));
        assert.ok(saved.coverageGaps.some(([root, record]) => root === imported &&
            record.subtree?.reasonCode === 'imported-coverage-restart-required'));
        assert.ok(nativeDirectoryWatchers.some(owner => owner.active && owner.directory === imported));
    }));

    test('S4-C Clear while stopped retains the imported observation obligation for the next Start', () => fixture(async ({tracker,dir}) => {
        const imported = path.join(dir, 'clear-stopped');
        fs.mkdirSync(imported);
        const target = path.join(imported, 'new.txt');
        fs.writeFileSync(target, 'before Clear');
        await tracker.onExternalFileCreated(Uri.file(imported));
        assert.equal(fs.existsSync(path.join(dir, '.git')), false, 'a Git repository is not required');
        tracker.stopRecording();
        assert.equal(await tracker.resetBaselineToCurrentState(), true);
        assert.equal(tracker.getTrackedChanges().length, 0);
        assert.equal(nativeDirectoryWatchers.some(owner => owner.active), false);
        assert.equal(await tracker.flushPendingPersistence(), true);
        const saved = JSON.parse(fs.readFileSync(path.join(tracker.storageUri.fsPath, 'session-state.json'), 'utf8'));
        assert.equal(saved.coverageGaps.find(([root]) => root === imported)?.[1].subtree.reasonCode,
            'imported-coverage-restart-required');
        const storage = tracker.storageUri;
        await tracker.dispose();
        tracker = new DiffTracker(storage); setTracker(tracker);
        assert.equal(await tracker.restorePersistedState(), 'restored');
        assert.equal(tracker.getIsRecording(), false);
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), [],
            'Stop → Clear → Reload must not promote a dormant import restart obligation into an active warning');
        assert.deepEqual(tracker.getCoverageGaps(), [], 'scope diagnostics must agree with the Changes Tree');
        assert.equal(nativeDirectoryWatchers.some(owner => owner.active), false);
        assert.equal(await tracker.flushPendingPersistence(), true);
        const reloaded = JSON.parse(fs.readFileSync(path.join(storage.fsPath, 'session-state.json'), 'utf8'));
        assert.equal(reloaded.coverageGaps.find(([root]) => root === imported)?.[1].importedCoverageRequired, true,
            'keeping the future direct-watcher restoration plan must not imply a current runtime failure');
        await tracker.dispose();
        tracker = new DiffTracker(storage); setTracker(tracker);
        assert.equal(await tracker.restorePersistedState(), 'restored');
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), [],
            'a second stopped reload must not resurrect the dormant diagnostic');
        assert.equal(tracker.importedCoverageObligations.has(imported), true);
        tracker.startRecording();
        await waitUntil(() => tracker.getBaselineState() === 'ready');
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
        const owner = [...nativeDirectoryWatchers].reverse().find(item => item.active && item.directory === imported);
        assert.ok(owner);
        fs.writeFileSync(target, 'after Clear and Start');
        owner.listener('change', 'new.txt');
        await waitUntil(() => tracker.getTrackedChanges().some(change => change.currentContent === 'after Clear and Start'));
    }));

    test('Issue #45 retained stopped review keeps genuine restart uncertainty across reload', () => fixture(async ({tracker,dir}) => {
        const imported = path.join(dir, 'retained-stopped');
        fs.mkdirSync(imported);
        const target = path.join(imported, 'review.txt');
        fs.writeFileSync(target, 'saved review baseline');
        await tracker.onExternalFileCreated(Uri.file(imported));
        assert.equal((await tracker.keepAllChangesInFile(target)).status, 'success');
        tracker.stopRecording();
        const storage = tracker.storageUri;
        assert.equal(await tracker.flushPendingPersistence(), true);
        await tracker.dispose();
        tracker = new DiffTracker(storage); setTracker(tracker);
        assert.equal(await tracker.restorePersistedState(), 'restored');
        assert.equal(tracker.getIsRecording(), false);
        assert.equal(tracker.getOriginalContent(target), 'saved review baseline');
        assert.ok(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === imported),
            'Stop without Clear must not suppress recovery evidence while an old review baseline remains');
    }));

    test('Issue #45 missing import after stopped Clear is not a false gap in a fresh recording', () => fixture(async ({tracker,dir}) => {
        const imported = path.join(dir, 'removed-stopped');
        fs.mkdirSync(imported);
        fs.writeFileSync(path.join(imported, 'old.txt'), 'old content');
        await tracker.onExternalFileCreated(Uri.file(imported));
        tracker.stopRecording();
        assert.equal(await tracker.resetBaselineToCurrentState(), true);
        fs.rmSync(imported, { recursive: true, force: true });
        const storage = tracker.storageUri;
        await tracker.dispose();
        tracker = new DiffTracker(storage); setTracker(tracker);
        assert.equal(await tracker.restorePersistedState(), 'restored');
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
        assert.equal(tracker.startRecording(), true);
        await waitUntil(() => tracker.getBaselineState() === 'ready');
        assert.equal(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === imported), false,
            'absent historic import path is not a live watcher failure after a new baseline');
        assert.equal(tracker.importedCoverageObligations.has(imported), false);
        fs.mkdirSync(imported);
        const recreated = path.join(imported, 'new.txt');
        fs.writeFileSync(recreated, 'new creation');
        await tracker.onExternalFileCreated(Uri.file(imported));
        assert.equal(tracker.getTrackedChanges().find(change => change.filePath === recreated)?.currentContent,
            'new creation', 'later recreation is handled as a new directory import');
    }));

    for (const scenario of ['ENOENT', 'ENOTDIR', 'file', 'directory', 'EACCES']) {
        test(`Issue #45 retirement target probe classifies ${scenario} conservatively`, () => fixture(async ({tracker,dir}) => {
            const parent = path.join(dir, 'probe-parent');
            const imported = path.join(parent, 'imported');
            fs.mkdirSync(parent);
            if (scenario === 'ENOTDIR') {
                fs.rmdirSync(parent);
                fs.writeFileSync(parent, 'parent is now a file');
            } else if (scenario === 'file') { fs.writeFileSync(imported, 'replacement file'); }
            else if (scenario === 'directory') { fs.mkdirSync(imported); }
            const lstat = fs.lstatSync;
            if (scenario === 'EACCES') fs.lstatSync = (target, ...args) => {
                if (target === imported) { throw Object.assign(new Error('denied'), {code:'EACCES'}); }
                return lstat(target, ...args);
            };
            try {
                assert.equal(tracker.importedCoverageTargetExistsForNewBaseline(imported),
                    scenario === 'directory' || scenario === 'EACCES',
                    'only proven absence or a non-directory retires an imported directory obligation');
            } finally { fs.lstatSync = lstat; }
        }));
    }

    test('Issue #45 Reset revalidates an absent import recreated during ignore refresh without an event', () => fixture(async ({tracker,dir}) => {
        const imported = path.join(dir, 'reset-recreated');
        const target = path.join(imported, 'review.txt');
        fs.mkdirSync(imported);
        fs.writeFileSync(target, 'accepted baseline');
        await tracker.onExternalFileCreated(Uri.file(imported));
        assert.equal((await tracker.keepAllChangesInFile(target)).status, 'success');
        fs.rmSync(imported, {recursive:true});
        const refresh = tracker.refreshIgnoreMatchers.bind(tracker);
        let recreated = false;
        tracker.refreshIgnoreMatchers = async (...args) => {
            const result = await refresh(...args);
            if (!recreated) {
                recreated = true;
                fs.mkdirSync(imported);
                fs.writeFileSync(target, 'replacement current bytes');
                // No synthetic create event: the filesystem changed while Reset awaited.
            }
            return result;
        };
        let reset;
        try { reset = await tracker.resetBaselineToCurrentState(); }
        finally { tracker.refreshIgnoreMatchers = refresh; }
        assert.equal(recreated, true);
        assert.equal(tracker.importedCoverageObligations.has(imported), true,
            'a stale absence plan must never silently retire a recreated imported path');
        if (!reset) {
            assert.equal(tracker.getOriginalContent(target), 'accepted baseline',
                'refused Reset must preserve the previously accepted baseline');
        } else {
            assert.ok(nativeDirectoryWatchers.some(owner => owner.active && owner.directory === imported),
                'successful Reset must independently cover the recreated import');
        }
        assert.equal(await tracker.flushPendingPersistence(), true);
        const saved = JSON.parse(fs.readFileSync(path.join(tracker.storageUri.fsPath, 'session-state.json'), 'utf8'));
        assert.equal(saved.coverageGaps.find(([root]) => root === imported)?.[1].importedCoverageRequired, true);
    }));

    for (const barrier of ['install', 'scan']) test(`Issue #45 Start revalidates an absent import recreated during ${barrier} without an event`, () => fixture(async ({tracker,dir}) => {
        const imported = path.join(dir, `start-recreated-${barrier}`);
        fs.mkdirSync(imported);
        fs.writeFileSync(path.join(imported, 'old.txt'), 'previous import');
        await tracker.onExternalFileCreated(Uri.file(imported));
        tracker.stopRecording();
        assert.equal(await tracker.resetBaselineToCurrentState(), true);
        fs.rmSync(imported, {recursive:true});
        const method = barrier === 'install' ? 'installSupplementalCoverageTargets' : 'initializeWorkspaceSnapshots';
        const original = tracker[method].bind(tracker);
        let recreated = false;
        let finished;
        const completed = new Promise(resolve => { finished = resolve; });
        tracker[method] = async (...args) => {
            try {
                const result = await original(...args);
                if (!recreated) {
                    recreated = true;
                    fs.mkdirSync(imported);
                    fs.writeFileSync(path.join(imported, 'new.txt'), 'recreated during Start');
                }
                return result;
            } finally { finished(); }
        };
        try {
            assert.equal(tracker.startRecording(), true);
            await completed;
            // Let the caller resume after the intercepted asynchronous boundary.
            await new Promise(resolve => setImmediate(resolve));
            await waitUntil(() => tracker.getBaselineState() !== 'building' ||
                tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === imported));
            assert.equal(recreated, true);
            assert.equal(tracker.importedCoverageObligations.has(imported), true,
                'Start must retain the obligation when its absence proof becomes stale');
            const owner = nativeDirectoryWatchers.some(item => item.active && item.directory === imported);
            const gap = tracker.getSubtreeCoverageGaps().some(item => item.targetPath === imported);
            assert.ok(owner || gap || !tracker.getIsRecording(),
                'recreated imports require direct observation or a visible failed/limited Start');
        } finally { tracker[method] = original; }
    }));

    test('Issue #45 Reset retires absent imported owners without a phantom gap', () => fixture(async ({tracker,dir}) => {
        const imported = path.join(dir, 'reset-retired');
        fs.mkdirSync(imported);
        fs.writeFileSync(path.join(imported, 'old.txt'), 'old import');
        await tracker.onExternalFileCreated(Uri.file(imported));
        const oldOwner = nativeDirectoryWatchers.find(owner => owner.active && owner.directory === imported);
        assert.ok(oldOwner);
        fs.rmSync(imported, {recursive:true});
        assert.equal(await tracker.resetBaselineToCurrentState(), true);
        assert.equal(tracker.importedCoverageObligations.has(imported), false);
        assert.equal(oldOwner.active, false);
        assert.equal(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === imported), false,
            'a retired stale native owner must not regenerate uncertainty after a successful Reset');
        assert.equal(await tracker.flushPendingPersistence(), true);
        const saved = JSON.parse(fs.readFileSync(path.join(tracker.storageUri.fsPath, 'session-state.json'), 'utf8'));
        assert.equal(saved.coverageGaps.some(([root]) => root === imported), false);
    }));

    for (const barrier of ['install', 'scan', 'persist-write', 'persist-copy']) {
        test(`Issue #45 Reset refuses retired import recreation after ${barrier}`, () => fixture(async ({tracker,dir}) => {
            const imported = path.join(dir, `reset-late-${barrier}`);
            const target = path.join(imported, 'review.txt');
            fs.mkdirSync(imported);
            fs.writeFileSync(target, 'accepted original');
            await tracker.onExternalFileCreated(Uri.file(imported));
            assert.equal((await tracker.keepAllChangesInFile(target)).status, 'success');
            fs.writeFileSync(target, 'pending before Reset');
            await tracker.onExternalFileChanged(Uri.file(target));
            await waitUntil(() => tracker.getTrackedChanges().some(change => change.filePath === target));
            assert.equal(await tracker.flushPendingPersistence(), true);
            fs.rmSync(imported, {recursive:true});
            const recreate = () => {
                fs.mkdirSync(imported);
                fs.writeFileSync(target, 'replacement during Reset');
            };
            let reset;
            if (barrier.startsWith('persist-')) {
                const copying = barrier === 'persist-copy';
                const gate = h.pause(path.join(tracker.storageUri.fsPath,
                    copying ? 'session-state.json' : 'session-state.tmp.json'), copying ? 'copy' : 'write');
                const resetting = tracker.resetBaselineToCurrentState();
                try {
                    assert.equal(await Promise.race([gate.entered.then(() => 'entered'), resetting]), 'entered');
                    recreate();
                } finally { gate.release(); }
                reset = await resetting;
            } else {
                const method = barrier === 'install' ? 'installSupplementalCoverageTargets' : 'initializeWorkspaceSnapshots';
                const original = tracker[method].bind(tracker);
                let inserted = false;
                tracker[method] = async (...args) => {
                    const result = await original(...args);
                    if (!inserted) { inserted = true; recreate(); }
                    return result;
                };
                try { reset = await tracker.resetBaselineToCurrentState(); }
                finally { tracker[method] = original; }
                assert.equal(inserted, true);
            }
            assert.equal(reset, false, 'Reset must reject stale absence evidence through durable publication');
            assert.equal(tracker.getOriginalContent(target), 'accepted original');
            assert.ok(tracker.getTrackedChanges().some(change => change.filePath === target),
                'the failed Reset must retain review rather than accept replacement bytes');
            assert.equal(tracker.importedCoverageObligations.has(imported), true);
            assertCurrentCoverageOrGap(tracker, imported);
            assert.equal(await tracker.flushPendingPersistence(), true);
            const saved = JSON.parse(fs.readFileSync(path.join(tracker.storageUri.fsPath, 'session-state.json'), 'utf8'));
            assert.equal(saved.coverageGaps.find(([root]) => root === imported)?.[1].importedCoverageRequired, true);
        }));
    }

    for (const replaced of ['root', 'nested']) for (const barrier of ['scan', 'persist-copy']) {
        test(`Issue #45 Reset rejects silent ${replaced} owner replacement during ${barrier}`, () => fixture(async ({tracker,dir}) => {
            const imported = path.join(dir, `owner-replaced-${replaced}-${barrier}`);
            const nested = path.join(imported, 'nested');
            const target = path.join(nested, 'review.txt');
            fs.mkdirSync(nested, {recursive:true});
            fs.writeFileSync(target, 'accepted owned content');
            await tracker.onExternalFileCreated(Uri.file(imported));
            assert.equal((await tracker.keepAllChangesInFile(target)).status, 'success');
            fs.writeFileSync(target, 'pending owned review');
            await tracker.onExternalFileChanged(Uri.file(target));
            await waitUntil(() => tracker.getTrackedChanges().some(change => change.filePath === target));
            assert.equal(await tracker.flushPendingPersistence(), true);
            const replace = () => {
                const directory = replaced === 'root' ? imported : nested;
                // Renaming keeps the old inode alive and guarantees a distinct
                // replacement inode even on filesystems that reuse deleted inodes.
                fs.renameSync(directory, `${directory}-old-inode`);
                fs.mkdirSync(nested, {recursive:true});
                fs.writeFileSync(target, 'silent replacement bytes');
            };
            let reset;
            if (barrier === 'persist-copy') {
                const gate = h.pause(path.join(tracker.storageUri.fsPath, 'session-state.json'), 'copy');
                const resetting = tracker.resetBaselineToCurrentState();
                try {
                    assert.equal(await Promise.race([gate.entered.then(() => 'entered'), resetting]), 'entered');
                    replace();
                } finally { gate.release(); }
                reset = await resetting;
            } else {
                const initialize = tracker.initializeWorkspaceSnapshots.bind(tracker);
                let replacedOnce = false;
                tracker.initializeWorkspaceSnapshots = async (...args) => {
                    const result = await initialize(...args);
                    if (!replacedOnce) { replacedOnce = true; replace(); }
                    return result;
                };
                try { reset = await tracker.resetBaselineToCurrentState(); }
                finally { tracker.initializeWorkspaceSnapshots = initialize; }
                assert.equal(replacedOnce, true);
            }
            assert.equal(reset, false, 'path spelling does not certify the native owner still observes its inode');
            assert.equal(tracker.getOriginalContent(target), 'accepted owned content');
            assert.ok(tracker.getTrackedChanges().some(change => change.filePath === target));
            assert.equal(tracker.importedCoverageObligations.has(imported), true);
            assertCurrentCoverageOrGap(tracker, replaced === 'root' ? imported : nested);
        }));
    }

    for (const transition of ['Start', 'Reset']) test(`Issue #45 ${transition} superseding Start restores tentative retirement before planning`, () => fixture(async ({tracker,dir}) => {
        const imported = path.join(dir, 'repeated-start-import');
        const target = path.join(imported, 'review.txt');
        fs.mkdirSync(imported);
        fs.writeFileSync(target, 'old import');
        await tracker.onExternalFileCreated(Uri.file(imported));
        tracker.stopRecording();
        assert.equal(await tracker.resetBaselineToCurrentState(), true);
        fs.rmSync(imported, {recursive:true});
        const refresh = tracker.refreshIgnoreMatchers.bind(tracker);
        let entered, release, calls = 0;
        const waiting = new Promise(resolve => { entered = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        tracker.refreshIgnoreMatchers = async (...args) => {
            if (++calls === 1) { entered(); await gate; }
            return refresh(...args);
        };
        try {
            assert.equal(tracker.startRecording(), true);
            await waiting;
            assert.equal(tracker.importedCoverageObligations.has(imported), false,
                'the older candidate must reach its tentative absent-root retirement');
            fs.mkdirSync(imported);
            fs.writeFileSync(target, `recreated before newer ${transition}`);
            if (transition === 'Start') { assert.equal(tracker.startRecording(), true); }
            else { await tracker.resetBaselineToCurrentState(); }
            await waitUntil(() => tracker.getBaselineState() === 'ready' ||
                tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === imported));
            assert.equal(tracker.importedCoverageObligations.has(imported), true,
                `the newer ${transition} must plan from restored committed obligations`);
            assertCurrentCoverageOrGap(tracker, imported);
            const newerEpoch = tracker.sessionEpoch;
            release();
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(tracker.sessionEpoch, newerEpoch);
            assert.equal(tracker.importedCoverageObligations.has(imported), true,
                'the old continuation must not erase the newer obligation');
            assertCurrentCoverageOrGap(tracker, imported);
            assert.equal(await tracker.flushPendingPersistence(), true);
            const saved = JSON.parse(fs.readFileSync(path.join(tracker.storageUri.fsPath, 'session-state.json'), 'utf8'));
            assert.equal(saved.coverageGaps.find(([root]) => root === imported)?.[1].importedCoverageRequired, true);
        } finally { release(); tracker.refreshIgnoreMatchers = refresh; }
    }));

    for (const transition of ['Start', 'Reset']) {
        test(`Issue #45 failed ${transition} preflight cannot strand superseded Start in building`, () => fixture(async ({tracker,dir}) => {
            const imported = path.join(dir, `failed-takeover-${transition}`);
            fs.mkdirSync(imported);
            fs.writeFileSync(path.join(imported, 'review.txt'), 'known import');
            await tracker.onExternalFileCreated(Uri.file(imported));
            tracker.stopRecording();
            const refresh = tracker.refreshIgnoreMatchers.bind(tracker);
            const initialize = tracker.initializeWorkspaceSnapshots.bind(tracker);
            let entered, release, settled, calls = 0;
            const waiting = new Promise(resolve => { entered = resolve; });
            const gate = new Promise(resolve => { release = resolve; });
            const finished = new Promise(resolve => { settled = resolve; });
            tracker.refreshIgnoreMatchers = async (...args) => {
                if (++calls === 1) { entered(); await gate; }
                return refresh(...args);
            };
            tracker.initializeWorkspaceSnapshots = async (...args) => {
                try { return await initialize(...args); }
                finally { settled(); }
            };
            try {
                assert.equal(tracker.startRecording(), true);
                await waiting;
                // This real unsupported watcher policy makes candidate planning
                // fail before a replacement scan can take ownership.
                h.setVsCodeExcludes({'files.watcherExclude': {'**/node_modules/*/**':true}});
                const accepted = transition === 'Start' ? tracker.startRecording()
                    : await tracker.resetBaselineToCurrentState();
                assert.equal(accepted, false, 'the replacement preflight must actually refuse');
                h.setVsCodeExcludes({});
                release();
                await finished;
                await new Promise(resolve => setImmediate(resolve));
                assert.notEqual(tracker.getBaselineState(), 'building',
                    'a rejected takeover must resume the earlier scan or explicitly pause, never leave a dead Starting state');
                assert.equal(tracker.importedCoverageObligations.has(imported), true);
                if (tracker.getIsRecording()) {
                    assert.equal(tracker.getBaselineState(), 'ready');
                    assertCurrentCoverageOrGap(tracker, imported);
                } else {
                    assert.equal(nativeDirectoryWatchers.some(owner => owner.active), false,
                        'an explicitly paused failed takeover must not retain live native observers');
                }
            } finally {
                release(); h.setVsCodeExcludes({});
                tracker.refreshIgnoreMatchers = refresh;
                tracker.initializeWorkspaceSnapshots = initialize;
            }
        }));
    }

    for (const failure of ['refresh-throw', 'retired-recreated', 'planning-throw']) {
        test(`Issue #45 takeover ${failure} explicitly pauses an abandoned Start`, () => fixture(async ({tracker,dir}) => {
            const imported = path.join(dir, `takeover-failure-${failure}`);
            fs.mkdirSync(imported);
            fs.writeFileSync(path.join(imported, 'old.txt'), 'old imported bytes');
            await tracker.onExternalFileCreated(Uri.file(imported));
            tracker.stopRecording();
            if (failure === 'retired-recreated') { fs.rmSync(imported, {recursive:true}); }
            const refresh = tracker.refreshIgnoreMatchers.bind(tracker);
            const plan = tracker.configuredSupplementalCoveragePlan.bind(tracker);
            let entered, release, calls = 0;
            const waiting = new Promise(resolve => { entered = resolve; });
            const gate = new Promise(resolve => { release = resolve; });
            tracker.refreshIgnoreMatchers = async (...args) => {
                const call = ++calls;
                if (call === 1) { entered(); await gate; }
                if (call === 2 && failure === 'refresh-throw') { throw new Error('injected refresh failure'); }
                const result = await refresh(...args);
                if (call === 2 && failure === 'retired-recreated') { fs.mkdirSync(imported); }
                return result;
            };
            try {
                assert.equal(tracker.startRecording(), true);
                await waiting;
                if (failure === 'planning-throw') {
                    tracker.configuredSupplementalCoveragePlan = () => { throw new Error('injected planning failure'); };
                    assert.throws(() => tracker.startRecording(), /injected planning failure/);
                } else { assert.equal(await tracker.resetBaselineToCurrentState(), false); }
                assert.equal(tracker.getIsRecording(), false);
                assert.equal(tracker.getBaselineState(), 'idle');
                assert.equal(tracker.snapshotInitialized, false);
                assert.equal(tracker.importedCoverageObligations.has(imported), true);
                assert.equal(nativeDirectoryWatchers.some(owner => owner.active), false);
                release();
                await new Promise(resolve => setImmediate(resolve));
                assert.equal(await tracker.flushPendingPersistence(), true);
                const saved = JSON.parse(fs.readFileSync(path.join(tracker.storageUri.fsPath, 'session-state.json'), 'utf8'));
                assert.equal(saved.isRecording, false);
                assert.equal(saved.baselineState, 'building', 'abandoned partial capture must not persist Ready');
                assert.equal(saved.coverageGaps.find(([root]) => root === imported)?.[1].importedCoverageRequired, true);
            } finally {
                release(); tracker.refreshIgnoreMatchers = refresh;
                tracker.configuredSupplementalCoveragePlan = plan;
            }
        }));
    }

    for (const newer of ['Start', 'Stop']) {
        test(`Issue #45 old Reset refresh failure cannot pause newer ${newer} epoch`, () => fixture(async ({tracker,dir}) => {
            const imported = path.join(dir, `takeover-newer-${newer}`);
            fs.mkdirSync(imported);
            fs.writeFileSync(path.join(imported, 'review.txt'), 'known imported baseline');
            await tracker.onExternalFileCreated(Uri.file(imported));
            tracker.stopRecording();
            const refresh = tracker.refreshIgnoreMatchers.bind(tracker);
            let enterStart, releaseStart, enterReset, releaseReset, calls = 0;
            const startWaiting = new Promise(resolve => { enterStart = resolve; });
            const startGate = new Promise(resolve => { releaseStart = resolve; });
            const resetWaiting = new Promise(resolve => { enterReset = resolve; });
            const resetGate = new Promise(resolve => { releaseReset = resolve; });
            tracker.refreshIgnoreMatchers = async (...args) => {
                const call = ++calls;
                if (call === 1) { enterStart(); await startGate; }
                if (call === 2) { enterReset(); await resetGate; throw new Error('late old Reset failure'); }
                return refresh(...args);
            };
            try {
                assert.equal(tracker.startRecording(), true);
                await startWaiting;
                const resetting = tracker.resetBaselineToCurrentState();
                await resetWaiting;
                if (newer === 'Start') {
                    assert.equal(tracker.startRecording(), true);
                    await waitUntil(() => tracker.getBaselineState() === 'ready');
                } else { tracker.stopRecording(); }
                const epoch = tracker.sessionEpoch;
                const initialized = tracker.snapshotInitialized;
                releaseReset();
                assert.equal(await resetting, false);
                releaseStart();
                await new Promise(resolve => setImmediate(resolve));
                assert.equal(tracker.sessionEpoch, epoch, 'old failure must not call Stop on the newer epoch');
                assert.equal(tracker.getIsRecording(), newer === 'Start');
                assert.equal(tracker.getBaselineState(), newer === 'Start' ? 'ready' : 'idle');
                assert.equal(tracker.snapshotInitialized, initialized);
                assert.equal(tracker.importedCoverageObligations.has(imported), true);
                if (newer === 'Start') { assertCurrentCoverageOrGap(tracker, imported); }
                else { assert.equal(nativeDirectoryWatchers.some(owner => owner.active), false); }
            } finally { releaseReset(); releaseStart(); tracker.refreshIgnoreMatchers = refresh; }
        }));
    }

    for (const transition of ['Start', 'Reset']) {
        test(`Issue #45 ${transition} Ready publishes only after transaction release and permits immediate scope Apply`, () => fixture(async ({tracker,dir,scope}) => {
            const imported = path.join(dir, `ready-barrier-${transition}`);
            fs.mkdirSync(imported);
            fs.writeFileSync(path.join(imported, 'review.txt'), 'baseline at Ready');
            await tracker.onExternalFileCreated(Uri.file(imported));
            if (transition === 'Start') { tracker.stopRecording(); }
            let observed = false, transactionAtReady, applying;
            let notifyReady;
            const ready = new Promise(resolve => { notifyReady = resolve; });
            const subscription = tracker.onDidChangeBaselineState(state => {
                if (state !== 'ready' || observed) { return; }
                observed = true;
                // These observations happen synchronously in the Ready listener,
                // without yielding or waiting for persistence to catch up.
                transactionAtReady = tracker.baselineTransaction;
                applying = tracker.applyConfiguredMonitoringScope(scope, false, () => true);
                notifyReady();
            });
            try {
                if (transition === 'Start') { assert.equal(tracker.startRecording(), true); }
                else { assert.equal(await tracker.resetBaselineToCurrentState(), true); }
                await ready;
                const result = await applying;
                // Allow the earlier operation to settle before fixture disposal;
                // this cannot change the values captured by the Ready listener.
                await waitUntil(() => tracker.baselineTransaction === undefined);
                assert.deepEqual({transactionReleased: transactionAtReady === undefined, applyStatus: result.status},
                    {transactionReleased:true, applyStatus:'applied'},
                    `Ready must be an actionable completion boundary: ${JSON.stringify(result)}`);
            } finally { subscription.dispose(); }
        }));
    }

    test('Issue #45 unchanged imported owners complete Start and observe later edits', () => fixture(async ({tracker,dir}) => {
        const imported = path.join(dir, 'start-stable-owner');
        const nested = path.join(imported, 'nested');
        const target = path.join(nested, 'review.txt');
        fs.mkdirSync(nested, {recursive:true});
        fs.writeFileSync(target, 'fresh Start baseline');
        await tracker.onExternalFileCreated(Uri.file(imported));
        tracker.stopRecording();
        assert.equal(tracker.startRecording(), true);
        await waitUntil(() => tracker.getBaselineState() === 'ready');
        assert.equal(await tracker.flushPendingPersistence(), true);
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
        assert.equal(tracker.importedCoverageObligations.has(imported), true);
        assert.equal(tracker.getOriginalContent(target), 'fresh Start baseline');
        const owner = nativeDirectoryWatchers.find(item => item.active && item.directory === nested);
        assert.ok(owner);
        fs.writeFileSync(target, 'observed after stable Start');
        owner.listener('change', 'review.txt');
        await waitUntil(() => tracker.getTrackedChanges().some(change =>
            change.filePath === target && change.currentContent === 'observed after stable Start'));
        assert.equal(tracker.getOriginalContent(target), 'fresh Start baseline');
    }));

    test('Issue #45 failed stopped Clear rolls back legacy effective scope with the old review', () => fixture(async ({tracker,dir}) => {
        const baselinePath = path.join(dir, 'legacy-review.txt');
        tracker.fileSnapshots.set(baselinePath, 'before Clear');
        tracker.baselineExistingFiles.add(baselinePath);
        const previousScope = tracker.createLegacyEffectiveScopeForRoots([dir]);
        tracker.effectiveMonitoringScope = previousScope;
        tracker.stopRecording();
        tracker.getLegacyGlobalWatchExcludePatterns = () => ['late-legacy-policy'];
        const originalFlush = tracker.flushPersistState.bind(tracker);
        tracker.flushPersistState = async (completed, transaction, ...rest) =>
            transaction ? false : originalFlush(completed, transaction, ...rest);
        try {
            assert.equal(await tracker.resetBaselineToCurrentState(), false);
            assert.deepEqual(tracker.getEffectiveMonitoringScope(), previousScope,
                'failed Clear must not publish an uncommitted compatibility scope');
            assert.equal(tracker.fileSnapshots.get(baselinePath), 'before Clear');
            assert.equal(tracker.baselineExistingFiles.has(baselinePath), true);
        } finally {
            tracker.flushPersistState = originalFlush;
        }
    }));

    for (const interruption of ['edit', 'stop']) test(`S4-C ${interruption} during reconciliation cannot release stale bridges or declare coverage`, () => fixture(async ({tracker,dir}) => {
        const imported = path.join(dir, 'racing-import');
        fs.mkdirSync(imported);
        const target = path.join(imported, 'new.txt');
        fs.writeFileSync(target, 'before scan');
        const open = fs.promises.opendir;
        let entered, release, opens = 0;
        const waiting = new Promise(resolve => { entered = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        fs.promises.opendir = async (directory, ...args) => {
            if (directory === imported && ++opens === 3) { entered(); await gate; }
            return open(directory, ...args);
        };
        const importing = tracker.onExternalFileCreated(Uri.file(imported));
        try {
            await waiting;
            const bridge = nativeDirectoryWatchers.find(owner => owner.directory === imported);
            assert.ok(bridge?.active);
            if (interruption === 'stop') { tracker.stopRecording(); }
            else {
                fs.writeFileSync(target, 'changed during reconciliation');
                bridge.listener('change', 'new.txt');
            }
            release();
            await importing;
            if (interruption === 'stop') {
                assert.equal(tracker.getIsRecording(), false);
                assert.equal(nativeDirectoryWatchers.some(owner => owner.active), false);
                assert.equal(tracker.getOriginalContent(target), undefined);
            } else {
                assert.equal(bridge.active, true, 'a raced scan cannot certify replacement coverage');
                assert.ok(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === imported));
                assert.equal(tracker.getOriginalContent(target), '');
                assert.equal(tracker.getTrackedChanges().find(change => change.filePath === target)?.currentContent,
                    'changed during reconciliation');
            }
        } finally { release(); await importing; fs.promises.opendir = open; }
    }));
}
