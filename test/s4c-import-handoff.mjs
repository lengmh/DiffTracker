import { registerS4CStaleHandoff } from './s4c-stale-handoff.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateAndCanonicalizeScope } from '../out/monitoringScope.js';

export function registerS4CImportHandoff(h, fixture) {
    registerS4CStaleHandoff(h, fixture);
    const {test, Uri, DiffTracker, nativeDirectoryWatchers, waitUntil, setTracker} = h;
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
            assert.equal(saved.version, 4);
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

    test('S4-C pending directory deletion stays subtree-typed through restore installation failure', () => fixture(async ({tracker,dir}) => {
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
        assert.match(gap.reason, /Pending scope reconciliation remains required/);
        assert.equal(nativeDirectoryWatchers.some(owner => owner.active && owner.directory === imported), false);
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
        assert.ok(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === imported));
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
        tracker.stopRecording();
        assert.equal(await tracker.resetBaselineToCurrentState(), true);
        assert.equal(tracker.getTrackedChanges().length, 0);
        assert.equal(nativeDirectoryWatchers.some(owner => owner.active), false);
        assert.equal(await tracker.flushPendingPersistence(), true);
        const saved = JSON.parse(fs.readFileSync(path.join(tracker.storageUri.fsPath, 'session-state.json'), 'utf8'));
        assert.equal(saved.coverageGaps.find(([root]) => root === imported)?.[1].subtree.reasonCode,
            'imported-coverage-restart-required');
        tracker.startRecording();
        await waitUntil(() => tracker.getBaselineState() === 'ready');
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
        const owner = [...nativeDirectoryWatchers].reverse().find(item => item.active && item.directory === imported);
        assert.ok(owner);
        fs.writeFileSync(target, 'after Clear and Start');
        owner.listener('change', 'new.txt');
        await waitUntil(() => tracker.getTrackedChanges().some(change => change.currentContent === 'after Clear and Start'));
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
