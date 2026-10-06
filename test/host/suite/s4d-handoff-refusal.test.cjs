// Host acceptance of failed/raced handoffs. Faults and the import boundary are
// explicit; every proof edit is delivered by the real, unchanged fs.watch callback.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');
const { DiffTracker } = require('../../../out/diffTracker.js');
const { validateAndCanonicalizeScope } = require('../../../out/monitoringScope.js');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(description, predicate) {
    const deadline = Date.now() + 15000;
    while (!predicate()) {
        if (Date.now() > deadline) { throw new Error(`Timed out waiting for ${description}`); }
        await delay(25);
    }
}

async function scenario(workspace, kind) {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'difftracker-s4d-refusal-'));
    const name = `s4d-${kind}-owner`;
    const root = vscode.Uri.file(path.join(workspace, name)).fsPath;
    const target = path.join(root, 'pending.txt');
    let tracker = new DiffTracker(vscode.Uri.file(storage));
    const nativeWatch = fs.watch;
    const nativeOpendir = fs.promises.opendir;
    const handles = [];
    let attempts = 0;
    let gateEntered = false;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let importing;
    // Scope both interception and accounting to the exact fixture owner. Other
    // extension/Host watchers are untouched, and no production event is injected.
    fs.watch = function (directory, ...args) {
        if (String(directory) === root && ++attempts === 2 && kind === 'install-refusal') {
            throw Object.assign(new Error('S4-D injected replacement watch limit'), { code: 'ENOSPC' });
        }
        const watcher = nativeWatch.call(this, directory, ...args);
        if (String(directory) === root) {
            const handle = { watcher, closed: false, events: 0 };
            handles.push(handle);
            watcher.once('close', () => { handle.closed = true; });
            watcher.on('change', () => { handle.events++; });
        }
        return watcher;
    };
    try {
        const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));
        assert.ok(folder);
        const include = { scope: 'folder', folder: folder.name, path: name };
        const requested = validateAndCanonicalizeScope({
            mode: 'rules', includes: [include], excludes: []
        }, tracker.currentWorkspaceRootIdentities());
        assert.equal(requested.ok, true, JSON.stringify(requested));
        tracker.effectiveMonitoringScope = { kind: 'configured', ...requested.scope };
        tracker.sessionWorkspaceRoots = tracker.getWorkspaceRoots();
        tracker.isRecording = true;
        tracker.externalWatcherEnabled = true;
        tracker.snapshotInitialized = true;
        assert.equal(tracker.getBaselineState(), 'ready');
        assert.equal(tracker.fileWatchers.length, 0);
        fs.mkdirSync(root);
        fs.writeFileSync(target, 'pending imported text\n');

        if (kind === 'reconciliation-event') {
            // Hold the first subtree read after replacement ownership has been
            // recorded. Counting opendir calls would couple this gate to unrelated
            // policy discovery and could pause before the handoff event snapshot.
            fs.promises.opendir = async (directory, ...args) => {
                if (String(directory) === root && !gateEntered &&
                    tracker.supplementalCoverageRoots.has(root)) {
                    gateEntered = true;
                    await gate;
                }
                return nativeOpendir(directory, ...args);
            };
        }
        importing = tracker.onExternalFileCreated(vscode.Uri.file(root));
        if (kind === 'reconciliation-event') {
            await until('reconciliation gate', () => gateEntered);
            assert.equal(handles.length, 2, 'independent replacement must overlap the live bridge');
            const bridge = tracker.importedDirectoryWatchers.get(root);
            const owner = tracker.supplementalDirectoryWatchers.get(root);
            assert.ok(bridge && owner);
            fs.writeFileSync(target, 'native edit during reconciliation\n');
            await until('both native handles to receive the interrupted reconciliation edit', () =>
                handles.every(handle => handle.events > 0) &&
                bridge.eventRevision > 0 && owner.eventRevision > 0);
            release();
        }
        await importing;
        fs.promises.opendir = nativeOpendir;
        assert.ok(tracker.importedDirectoryWatchers.get(root)?.epoch === tracker.sessionEpoch,
            'failed or raced replacement cannot release the useful bridge');
        assert.equal(handles[0].closed, false);
        assert.ok(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === root),
            'failed or raced handoff must remain visibly unverified');
        const expected = kind === 'reconciliation-event'
            ? 'native edit during reconciliation\n' : 'pending imported text\n';
        await until('import review after failed handoff', () =>
            tracker.getTrackedChanges().some(change => change.filePath === target && change.currentContent === expected));
        assert.equal(tracker.getOriginalContent(target), '');
        assert.equal(tracker.getTrackedChanges().find(change => change.filePath === target).baselineExists, false);
        assert.equal(fs.readFileSync(target, 'utf8'), expected);

        fs.writeFileSync(target, 'native edit while handoff remains unverified\n');
        await until('retained coverage to capture a later native edit', () =>
            tracker.getTrackedChanges().some(change => change.filePath === target &&
                change.currentContent === 'native edit while handoff remains unverified\n'));
        assert.equal(tracker.fileWatchers.length, 0);
        assert.ok(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === root));
        assert.equal(await tracker.flushPendingPersistence(), true);
        const saved = JSON.parse(fs.readFileSync(path.join(storage, 'session-state.json'), 'utf8'));
        const evidence = new Map(saved.coverageGaps).get(root);
        assert.equal(evidence?.importedCoverageRequired, true);
        assert.ok(evidence.subtree, 'uncertainty and restart obligation must be durable together');

        // A fresh tracker must install coverage and reconcile with the old review
        // baseline. This is in-process recovery; another test restarts the Host.
        await tracker.dispose();
        await until('failed handoff session handles to close', () => handles.every(handle => handle.closed));
        tracker = new DiffTracker(vscode.Uri.file(storage));
        assert.equal(await tracker.restorePersistedState(), 'restored', tracker.getPersistenceIssue());
        assert.equal(tracker.getOriginalContent(target), '');
        assert.equal(tracker.getTrackedChanges().find(change => change.filePath === target)?.currentContent,
            'native edit while handoff remains unverified\n');
        assert.equal(fs.readFileSync(target, 'utf8'), 'native edit while handoff remains unverified\n');
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
        tracker.fileWatchers.forEach(watcher => watcher.dispose());
        tracker.fileWatchers = [];
        const owner = tracker.supplementalDirectoryWatchers.get(root);
        assert.ok(owner?.epoch === tracker.sessionEpoch);
        await delay(250);
        fs.writeFileSync(target, 'native edit after failed handoff recovery\n');
        await until('fresh direct owner after failure recovery', () =>
            tracker.getTrackedChanges().some(change => change.filePath === target &&
                change.currentContent === 'native edit after failed handoff recovery\n'));

        const previousScope = tracker.getEffectiveMonitoringScope();
        const excluded = validateAndCanonicalizeScope({
            mode: 'rules', includes: [include],
            excludes: [{ scope: 'folder', folder: folder.name, pattern: name }]
        }, tracker.currentWorkspaceRootIdentities());
        assert.equal(excluded.ok, true, JSON.stringify(excluded));
        const refused = await tracker.applyConfiguredMonitoringScope(excluded.scope, false, () => true);
        assert.equal(refused.status, 'conflict', JSON.stringify(refused));
        assert.match(refused.reason, /discard.*confirm|confirm.*discard/i);
        assert.deepEqual(tracker.getEffectiveMonitoringScope(), previousScope);
        assert.equal(tracker.supplementalDirectoryWatchers.get(root), owner,
            'unapproved review discard cannot retire the committed direct owner');
        fs.writeFileSync(target, 'native edit after refused exclusion\n');
        await until('continued native capture after refused exclusion', () =>
            tracker.getTrackedChanges().some(change => change.filePath === target &&
                change.currentContent === 'native edit after refused exclusion\n'));
        assert.equal(tracker.getOriginalContent(target), '');
        assert.equal(tracker.fileWatchers.length, 0);
        tracker.stopRecording();
        await until('Stop to close all refusal-scenario native handles', () => handles.every(handle => handle.closed));
        assert.equal(tracker.activeDirectDirectoryWatcherCount(tracker.sessionEpoch), 0);
        console.log(`PASS HOST-S4-D ${kind}: durable gap, retained native edits, recovery, refused exclusion and later native edit`);
    } finally {
        release();
        if (importing) { await importing; }
        fs.promises.opendir = nativeOpendir;
        fs.watch = nativeWatch;
        await tracker.dispose();
        await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        await fs.promises.rm(storage, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
}

module.exports = async workspace => {
    await scenario(workspace, 'install-refusal');
    await scenario(workspace, 'reconciliation-event');
};
