import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export function registerS4CStaleHandoff(h, fixture) {
    const {test, Uri, nativeDirectoryWatchers, waitUntil, fireConfigurationChanged} = h;
    test('S4-C stale handoff releases only uncommitted candidates after settings refresh', () => fixture(async ({tracker,dir}) => {
        const imported = path.join(dir, 'stale-import');
        const target = path.join(imported, 'new.txt');
        fs.mkdirSync(imported); fs.writeFileSync(target, 'pending import');
        const open = fs.promises.opendir;
        let entered, release, opens = 0;
        const waiting = new Promise(resolve => { entered = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        fs.promises.opendir = async (directory, ...args) => {
            if (directory === imported && ++opens === 2) { entered(); await gate; }
            return open(directory, ...args);
        };
        const importing = tracker.onExternalFileCreated(Uri.file(imported));
        try {
            await waiting;
            const [bridge, candidate] = nativeDirectoryWatchers.filter(owner => owner.directory === imported);
            assert.ok(bridge?.active && candidate?.active, 'replacement overlaps the useful bridge');
            fireConfigurationChanged('search.exclude');
            await tracker.ignoreRefreshPromise;
            release(); await importing;
            assert.equal(candidate.active, false, 'superseded preparation releases its uncommitted native owner');
            assert.equal(bridge.active, true, 'the bridge remains responsible for observation');
            assert.equal(tracker.getOriginalContent(target), '');
            assert.equal(tracker.getTrackedChanges().find(change => change.filePath === target)?.currentContent, 'pending import');
            assert.ok(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === imported));
            fs.writeFileSync(target, 'bridge captures later edit');
            bridge.listener('change', 'new.txt');
            await waitUntil(() => tracker.getTrackedChanges().some(change => change.currentContent === 'bridge captures later edit'));
            assert.equal(await tracker.flushPendingPersistence(), true);
            const saved = JSON.parse(fs.readFileSync(path.join(tracker.storageUri.fsPath, 'session-state.json'), 'utf8'));
            assert.equal(new Map(saved.coverageGaps).get(imported).importedCoverageRequired, true);
            tracker.stopRecording();
            assert.equal(nativeDirectoryWatchers.some(owner => owner.active), false);
        } finally { release(); await importing; fs.promises.opendir = open; }
    }));

    test('S4-C stale handoff preserves a newer in-flight reuse and its native-only edits', () => fixture(async ({tracker,dir}) => {
        const imported = path.join(dir, 'in-flight-import');
        const target = path.join(imported, 'new.txt');
        fs.mkdirSync(imported); fs.writeFileSync(target, 'pending import');
        const open = fs.promises.opendir;
        let enteredOlder, releaseOlder, enteredNewer, releaseNewer, opens = 0;
        const olderWaiting = new Promise(resolve => { enteredOlder = resolve; });
        const olderGate = new Promise(resolve => { releaseOlder = resolve; });
        const newerWaiting = new Promise(resolve => { enteredNewer = resolve; });
        const newerGate = new Promise(resolve => { releaseNewer = resolve; });
        fs.promises.opendir = async (directory, ...args) => {
            if (directory === imported) {
                opens++;
                if (opens === 2) { enteredOlder(); await olderGate; }
                else if (opens === 4) { enteredNewer(); await newerGate; }
            }
            return open(directory, ...args);
        };
        const older = tracker.onExternalFileCreated(Uri.file(imported));
        let newer;
        try {
            await olderWaiting;
            const [bridge, candidate] = nativeDirectoryWatchers.filter(owner => owner.directory === imported);
            newer = tracker.onExternalFileCreated(Uri.file(imported));
            await newerWaiting;
            assert.equal(nativeDirectoryWatchers.filter(owner => owner.directory === imported).length, 2,
                'the newer attempt reuses the same native owner rather than opening another handle');
            releaseOlder(); await older;
            assert.equal(candidate.active, true, 'older cleanup cannot revoke a newer in-flight claim');
            assert.equal(bridge.active, true, 'the newer handoff has not completed reconciliation');
            releaseNewer(); await newer;
            assert.equal(candidate.active, true);
            assert.equal(bridge.active, false, 'the newer handoff can finish after the older attempt exits');
            assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
            fs.writeFileSync(target, 'newer owner captures edit');
            candidate.listener('change', 'new.txt');
            await waitUntil(() => tracker.getTrackedChanges().some(change => change.currentContent === 'newer owner captures edit'));
        } finally {
            releaseOlder(); releaseNewer();
            await Promise.all([older, newer]); fs.promises.opendir = open;
        }
    }));
    test('S4-C stale handoff latest reuse releases its candidate if that attempt is also superseded', () => fixture(async ({tracker,dir}) => {
        const imported = path.join(dir, 'in-flight-import');
        const target = path.join(imported, 'new.txt');
        fs.mkdirSync(imported); fs.writeFileSync(target, 'pending import');
        const open = fs.promises.opendir;
        let enteredOlder, releaseOlder, enteredNewer, releaseNewer, opens = 0;
        const olderWaiting = new Promise(resolve => { enteredOlder = resolve; });
        const olderGate = new Promise(resolve => { releaseOlder = resolve; });
        const newerWaiting = new Promise(resolve => { enteredNewer = resolve; });
        const newerGate = new Promise(resolve => { releaseNewer = resolve; });
        fs.promises.opendir = async (directory, ...args) => {
            if (directory === imported) {
                opens++;
                if (opens === 2) { enteredOlder(); await olderGate; }
                else if (opens === 4) { enteredNewer(); await newerGate; }
            }
            return open(directory, ...args);
        };
        const older = tracker.onExternalFileCreated(Uri.file(imported));
        let newer;
        try {
            await olderWaiting;
            const [bridge, candidate] = nativeDirectoryWatchers.filter(owner => owner.directory === imported);
            newer = tracker.onExternalFileCreated(Uri.file(imported));
            await newerWaiting;
            assert.equal(nativeDirectoryWatchers.filter(owner => owner.directory === imported).length, 2,
                'the newer attempt reuses the same native owner rather than opening another handle');
            releaseOlder(); await older;
            assert.equal(candidate.active, true, 'older cleanup cannot revoke a newer in-flight claim');
            assert.equal(bridge.active, true, 'the newer handoff has not completed reconciliation');
            fireConfigurationChanged('search.exclude');
            await tracker.ignoreRefreshPromise;
            releaseNewer(); await newer;
            assert.equal(candidate.active, false, 'the latest claim must release an uncommitted reused owner');
            assert.equal(bridge.active, true);
            assert.ok(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === imported));
            fs.writeFileSync(target, 'bridge captures superseded edit');
            bridge.listener('change', 'new.txt');
            await waitUntil(() => tracker.getTrackedChanges().some(change => change.currentContent === 'bridge captures superseded edit'));
        } finally {
            releaseOlder(); releaseNewer();
            await Promise.all([older, newer]); fs.promises.opendir = open;
        }
    }));

    test('S4-C stale handoff preserves a newer committed reuse and its native-only edits', () => fixture(async ({tracker,dir}) => {
        const imported = path.join(dir, 'committed-import');
        const target = path.join(imported, 'new.txt');
        fs.mkdirSync(imported); fs.writeFileSync(target, 'pending import');
        const open = fs.promises.opendir;
        let entered, release, opens = 0;
        const waiting = new Promise(resolve => { entered = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        fs.promises.opendir = async (directory, ...args) => {
            if (directory === imported && ++opens === 2) { entered(); await gate; }
            return open(directory, ...args);
        };
        const older = tracker.onExternalFileCreated(Uri.file(imported));
        try {
            await waiting;
            const [bridge, candidate] = nativeDirectoryWatchers.filter(owner => owner.directory === imported);
            await tracker.onExternalFileCreated(Uri.file(imported));
            assert.equal(nativeDirectoryWatchers.filter(owner => owner.directory === imported).length, 2);
            assert.equal(candidate.active, true);
            assert.equal(bridge.active, false);
            release(); await older;
            assert.equal(candidate.active, true, 'stale cleanup must preserve the committed reused owner');
            assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
            fs.writeFileSync(target, 'committed owner captures edit');
            candidate.listener('change', 'new.txt');
            await waitUntil(() => tracker.getTrackedChanges().some(change => change.currentContent === 'committed owner captures edit'));
        } finally { release(); await older; fs.promises.opendir = open; }
    }));

    test('S4-C stale handoff preserves committed ancestor coverage and its new descendant owner', () => fixture(async ({tracker,dir}) => {
        const ancestor = path.join(dir, 'ancestor-import');
        const existing = path.join(ancestor, 'existing.txt');
        fs.mkdirSync(ancestor); fs.writeFileSync(existing, 'ancestor review');
        await tracker.onExternalFileCreated(Uri.file(ancestor));
        const ancestorOwner = nativeDirectoryWatchers.find(owner => owner.active && owner.directory === ancestor);
        const imported = path.join(ancestor, 'nested-import');
        const target = path.join(imported, 'new.txt');
        fs.mkdirSync(imported); fs.writeFileSync(target, 'nested review');
        const open = fs.promises.opendir;
        let entered, release, opens = 0;
        const waiting = new Promise(resolve => { entered = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        fs.promises.opendir = async (directory, ...args) => {
            if (directory === imported && ++opens === 2) { entered(); await gate; }
            return open(directory, ...args);
        };
        const importing = tracker.onExternalFileCreated(Uri.file(imported));
        try {
            await waiting;
            const [bridge, descendantOwner] = nativeDirectoryWatchers.filter(owner => owner.directory === imported);
            fireConfigurationChanged('search.exclude');
            await tracker.ignoreRefreshPromise;
            release(); await importing;
            assert.ok(ancestorOwner.active && descendantOwner.active && bridge.active,
                'committed ancestor coverage remains responsible for its newly discovered descendants');
            assert.ok(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === imported));
            fs.writeFileSync(existing, 'ancestor native edit'); ancestorOwner.listener('change', 'existing.txt');
            fs.writeFileSync(target, 'descendant native edit'); descendantOwner.listener('change', 'new.txt');
            await waitUntil(() => tracker.getTrackedChanges().some(change => change.currentContent === 'ancestor native edit') &&
                tracker.getTrackedChanges().some(change => change.currentContent === 'descendant native edit'));
            tracker.stopRecording();
            assert.equal(nativeDirectoryWatchers.some(owner => owner.active), false);
        } finally { release(); await importing; fs.promises.opendir = open; }
    }));

    test('S4-C stale handoff candidates do not consume the shared direct watcher budget', () => fixture(async ({tracker,dir}) => {
        assert.equal(tracker.maxImportedDirectoryWatchers, 256);
        const open = fs.promises.opendir;
        let imported, opens = 0;
        fs.promises.opendir = async (directory, ...args) => {
            if (directory === imported && ++opens === 2) {
                fireConfigurationChanged('search.exclude');
                await tracker.ignoreRefreshPromise;
            }
            return open(directory, ...args);
        };
        try {
            for (let index = 0; index < 129; index++) {
                imported = path.join(dir, `budget-import-${index}`); opens = 0;
                fs.mkdirSync(imported);
                await tracker.onExternalFileCreated(Uri.file(imported));
                assert.equal(nativeDirectoryWatchers.filter(owner => owner.active).length, index + 1,
                    'each failed handoff retains only its bridge, without exhausting the shared quota early');
            }
            assert.ok(nativeDirectoryWatchers.some(owner => owner.active && owner.directory === imported));
            assert.ok(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === imported));
            tracker.stopRecording();
            assert.equal(nativeDirectoryWatchers.some(owner => owner.active), false);
        } finally { fs.promises.opendir = open; }
    }));

    test('S4-C stale handoff cannot reinstall owners after Stop during preparation', () => fixture(async ({tracker,dir}) => {
        const imported = path.join(dir, 'stop-import'); fs.mkdirSync(imported);
        const open = fs.promises.opendir;
        let entered, release, opens = 0;
        const waiting = new Promise(resolve => { entered = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        fs.promises.opendir = async (directory, ...args) => {
            if (directory === imported && ++opens === 2) { entered(); await gate; }
            return open(directory, ...args);
        };
        const importing = tracker.onExternalFileCreated(Uri.file(imported));
        try {
            await waiting;
            tracker.stopRecording();
            release(); await importing;
            assert.equal(tracker.getIsRecording(), false);
            assert.equal(nativeDirectoryWatchers.some(owner => owner.active), false);
        } finally { release(); await importing; fs.promises.opendir = open; }
    }));

    test('S4-C stale handoff cannot reclaim a descendant from newer in-flight preparation', () => fixture(async ({tracker,dir}) => {
        const imported = path.join(dir, 'nested-in-flight');
        const nested = path.join(imported, 'child');
        const target = path.join(nested, 'new.txt');
        fs.mkdirSync(nested, {recursive:true}); fs.writeFileSync(target, 'pending import');
        const open = fs.promises.opendir;
        let enteredOlder, releaseOlder, enteredNewer, releaseNewer, rootOpens = 0, childOpens = 0;
        const olderWaiting = new Promise(resolve => { enteredOlder = resolve; });
        const olderGate = new Promise(resolve => { releaseOlder = resolve; });
        const newerWaiting = new Promise(resolve => { enteredNewer = resolve; });
        const newerGate = new Promise(resolve => { releaseNewer = resolve; });
        fs.promises.opendir = async (directory, ...args) => {
            if (directory === imported && ++rootOpens === 2) { enteredOlder(); await olderGate; }
            if (directory === nested && ++childOpens === 3) { enteredNewer(); await newerGate; }
            return open(directory, ...args);
        };
        const older = tracker.onExternalFileCreated(Uri.file(imported));
        let newer;
        try {
            await olderWaiting;
            newer = tracker.onExternalFileCreated(Uri.file(imported));
            await newerWaiting;
            const [bridge, candidate] = nativeDirectoryWatchers.filter(owner => owner.directory === nested);
            assert.ok(candidate.active && bridge.active);
            releaseOlder(); await older;
            assert.equal(candidate.active, true, 'stale ancestor traversal cannot steal and revoke the newer descendant claim');
            releaseNewer(); await newer;
            assert.equal(candidate.active, true);
            assert.equal(bridge.active, false);
            assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
            fs.writeFileSync(target, 'nested owner captures edit'); candidate.listener('change', 'new.txt');
            await waitUntil(() => tracker.getTrackedChanges().some(change => change.currentContent === 'nested owner captures edit'));
        } finally {
            releaseOlder(); releaseNewer();
            await Promise.all([older, newer]); fs.promises.opendir = open;
        }
    }));
}
