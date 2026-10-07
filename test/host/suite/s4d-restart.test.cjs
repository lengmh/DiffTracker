// A real process boundary is owned by test/host/run.mjs: prepare exits one
// Extension Host, the launcher edits disk, and restore runs in a second Host.
// This is not a workbench.action.reloadWindow command/UI acceptance test.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { DiffTracker } = require('../../../out/diffTracker.js');
const { validateAndCanonicalizeScope } = require('../../../out/monitoringScope.js');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(description, predicate) {
    const deadline = Date.now() + 15000;
    while (!predicate()) {
        if (Date.now() > deadline) { throw new Error(`Timed out waiting for ${description}`); }
        await delay(50);
    }
}

function fixture() {
    const workspace = process.env.DIFF_TRACKER_HOST_WORKSPACE;
    const storage = process.env.DIFF_TRACKER_HOST_RESTART_STORAGE;
    assert.ok(workspace && storage, 'the launcher must supply stable restart workspace and storage paths');
    const root = vscode.Uri.file(path.join(workspace, 's4d-restart-owner')).fsPath;
    const nested = path.join(root, 'deep');
    return {
        workspace, storage, root, directories: [root, nested],
        offlineFile: path.join(root, 'readme.txt'),
        pendingFile: path.join(nested, 'tracked.txt'),
        baseline: ['accepted root text\n', 'accepted nested text\n'],
        pendingContent: 'native pending edit before Host exit\n',
        offlineContent: 'offline edit between Extension Host processes\n',
        manifestPath: path.join(storage, 'restart-fixture.json'),
        statePath: path.join(storage, 'session-state.json')
    };
}

function stateDigest(statePath) {
    return createHash('sha256').update(fs.readFileSync(statePath)).digest('hex');
}

function snapshotTree(root) {
    const entries = [];
    const visit = directory => {
        for (const name of fs.readdirSync(directory).sort()) {
            const target = path.join(directory, name);
            const stat = fs.lstatSync(target);
            assert.ok(stat.isDirectory() || stat.isFile(), 'restart fixture contains only direct directories and files');
            entries.push({
                relative: path.relative(root, target), directory: stat.isDirectory(),
                mode: stat.mode, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
                bytes: stat.isFile() ? fs.readFileSync(target).toString('base64') : undefined
            });
            if (stat.isDirectory()) { visit(target); }
        }
    };
    visit(root);
    return entries;
}

async function observeNativeHandles(directories, scenario) {
    const nativeWatch = fs.watch;
    const handles = [];
    // Observe acquisition and close only. Forward callbacks unchanged to actual
    // fs.watch; never inject events or replace the production watcher with a fake.
    fs.watch = function (directory, ...args) {
        const watcher = nativeWatch.call(this, directory, ...args);
        if (directories.includes(String(directory))) {
            const handle = { directory: String(directory), watcher, closed: false };
            handles.push(handle);
            watcher.once('close', () => { handle.closed = true; });
        }
        return watcher;
    };
    try { return await scenario(handles); }
    finally { fs.watch = nativeWatch; }
}

function assertActiveOwners(tracker, directories, root, handles) {
    assert.equal(tracker.importedDirectoryWatchers.size, 0);
    assert.deepEqual([...tracker.supplementalDirectoryWatchers.keys()].sort(), [...directories].sort());
    for (const directory of directories) {
        const owner = tracker.supplementalDirectoryWatchers.get(directory);
        assert.equal(owner.epoch, tracker.sessionEpoch);
        assert.equal(owner.coverageRoot, root);
        assert.equal(handles.filter(handle => handle.directory === directory && !handle.closed).length, 1,
            'each directory must own one real native handle acquired in this Host process');
    }
    assert.equal(tracker.activeDirectDirectoryWatcherCount(tracker.sessionEpoch), directories.length);
}

function assertReview(tracker, filePath, baseline, current) {
    assert.equal(tracker.getOriginalContent(filePath), baseline, 'restart must not silently accept a pending or offline edit');
    const change = tracker.getTrackedChanges().find(item => item.filePath === filePath);
    assert.ok(change, `expected pending review for ${filePath}`);
    assert.equal(change.baselineExists, true);
    assert.equal(change.currentContent, current);
    assert.equal(change.unavailableReason, undefined);
    assert.ok(tracker.getReviewToken(filePath), 'restored text must expose a current review token');
}

async function removeFixture(f) {
    await fs.promises.rm(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await fs.promises.rm(f.storage, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

exports.prepare = async () => {
    const f = fixture();
    assert.equal(fs.existsSync(f.root), false, 'restart target must begin absent');
    assert.equal(fs.existsSync(f.storage), false, 'restart storage must be fresh');
    fs.mkdirSync(f.storage, { recursive: true });
    const source = fs.mkdtempSync(path.join(f.workspace, 's4d-restart-source-'));
    let prepared = false;
    await observeNativeHandles(f.directories, async handles => {
        const tracker = new DiffTracker(vscode.Uri.file(f.storage));
        let disposed = false;
        try {
            const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(f.workspace));
            assert.ok(folder, 'restart fixture must have an actual primary workspace owner');
            // A folder-scoped include avoids imposing coverage for an absent
            // target on the suite's independently excluded second workspace root.
            const requested = validateAndCanonicalizeScope({
                mode: 'rules',
                includes: [{ scope: 'folder', folder: folder.name, path: 's4d-restart-owner' }],
                excludes: []
            }, tracker.currentWorkspaceRootIdentities());
            assert.equal(requested.ok, true);
            tracker.effectiveMonitoringScope = { kind: 'configured', ...requested.scope };
            tracker.sessionWorkspaceRoots = tracker.getWorkspaceRoots();
            tracker.isRecording = true;
            tracker.externalWatcherEnabled = true;
            tracker.snapshotInitialized = true;
            assert.equal(tracker.getBaselineState(), 'ready');
            assert.equal(tracker.fileWatchers.length, 0);

            fs.mkdirSync(path.join(source, 'deep'));
            fs.writeFileSync(path.join(source, 'readme.txt'), f.baseline[0]);
            fs.writeFileSync(path.join(source, 'deep', 'tracked.txt'), f.baseline[1]);
            fs.renameSync(source, f.root);
            // Only the directory-discovery boundary is explicit. Handoff uses
            // actual bridge/replacement fs.watch handles, and all later edits
            // must reach the tracker exclusively through real native callbacks.
            await tracker.onExternalFileCreated(vscode.Uri.file(f.root));
            await until('pre-restart bridge handles to close', () =>
                handles.filter(handle => handle.closed).length === f.directories.length);
            assertActiveOwners(tracker, f.directories, f.root, handles);
            for (const directory of f.directories) {
                const acquired = handles.filter(handle => handle.directory === directory);
                assert.equal(acquired.length, 2, 'bridge and replacement must acquire independent native handles');
                assert.notEqual(acquired[0].watcher, acquired[1].watcher);
            }
            for (const [index, filePath] of [f.offlineFile, f.pendingFile].entries()) {
                assert.equal(tracker.getTrackedChanges().find(change => change.filePath === filePath)?.baselineExists, false);
                const token = tracker.getReviewToken(filePath);
                assert.ok(token);
                const kept = await tracker.keepAllChangesInFile(filePath, token);
                assert.equal(kept.status, 'success', JSON.stringify(kept));
                assert.equal(tracker.getOriginalContent(filePath), f.baseline[index]);
            }
            await delay(250);
            fs.writeFileSync(f.pendingFile, f.pendingContent);
            await until('pre-restart native pending edit', () => tracker.getTrackedChanges().some(change =>
                change.filePath === f.pendingFile && change.currentContent === f.pendingContent));
            assertReview(tracker, f.pendingFile, f.baseline[1], f.pendingContent);
            assert.equal(tracker.getTrackedChanges().some(change => change.filePath === f.offlineFile), false);
            assert.equal(tracker.fileWatchers.length, 0);
            assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
            assert.equal(await tracker.flushPendingPersistence(), true);
            // Dispose preserves the recording session in storage while releasing
            // all runtime owners. Stop would intentionally save a stopped session.
            await tracker.dispose();
            disposed = true;
            await until('first Host disposal to release native owners', () => handles.every(handle => handle.closed));
            const saved = JSON.parse(fs.readFileSync(f.statePath, 'utf8'));
            assert.equal(saved.version, 4);
            assert.equal(saved.isRecording, true);
            assert.equal(new Map(saved.coverageGaps).get(f.root)?.importedCoverageRequired, true);
            assert.equal(new Map(saved.coverageGaps).get(f.root)?.subtree?.reasonCode, 'imported-coverage-restart-required');
            assert.equal(new Map(saved.fileSnapshots).get(f.offlineFile), f.baseline[0]);
            assert.equal(new Map(saved.fileSnapshots).get(f.pendingFile), f.baseline[1]);
            fs.writeFileSync(f.manifestPath, JSON.stringify({
                phase: 'prepared', hostPid: process.pid, workspace: f.workspace,
                offlineFile: f.offlineFile, offlineContent: f.offlineContent,
                stateDigest: stateDigest(f.statePath), baseline: f.baseline
            }));
            prepared = true;
            console.log('PASS HOST-S4-D restart prepare: imported handoff, Keep, pending native edit, durable obligation and closed handles');
        } finally {
            try {
                if (!disposed) { await tracker.dispose(); }
                await until('prepare cleanup to release native owners', () => handles.every(handle => handle.closed));
            } finally {
                await fs.promises.rm(source, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
                if (!prepared) { await removeFixture(f); }
            }
        }
    });
};

exports.restore = async () => {
    const f = fixture();
    const manifest = JSON.parse(fs.readFileSync(f.manifestPath, 'utf8'));
    assert.equal(manifest.phase, 'offline-edited', 'the launcher must edit disk after the first Host has exited');
    assert.notEqual(manifest.hostPid, process.pid, 'restore must execute in a different Extension Host process');
    assert.equal(manifest.workspace, f.workspace);
    assert.deepEqual(manifest.baseline, f.baseline);
    assert.equal(stateDigest(f.statePath), manifest.stateDigest, 'restart must use the exact first Host persisted session');
    assert.equal(fs.readFileSync(f.offlineFile, 'utf8'), f.offlineContent);
    assert.equal(fs.readFileSync(f.pendingFile, 'utf8'), f.pendingContent);
    const diskBeforeRestore = snapshotTree(f.root);
    await observeNativeHandles(f.directories, async handles => {
        const tracker = new DiffTracker(vscode.Uri.file(f.storage));
        try {
            assert.equal(await tracker.restorePersistedState(), 'restored', tracker.getPersistenceIssue());
            assert.equal(tracker.isRecording, true);
            assert.equal(tracker.getBaselineState(), 'ready');
            assertActiveOwners(tracker, f.directories, f.root, handles);
            assert.ok(handles.length >= f.directories.length,
                'saved coverage metadata is not evidence until this process acquires new native handles');
            assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
            assertReview(tracker, f.offlineFile, f.baseline[0], f.offlineContent);
            assertReview(tracker, f.pendingFile, f.baseline[1], f.pendingContent);
            assert.deepEqual(snapshotTree(f.root), diskBeforeRestore,
                'restore must preserve every fixture entry, file byte and modification metadata');

            // Restore follows the normal production Host-watch setup. Close the
            // generic watchers before the proof edits so independent direct
            // owners alone must observe both the root and nested directory.
            tracker.fileWatchers.forEach(watcher => watcher.dispose());
            tracker.fileWatchers = [];
            await delay(250);
            const liveContent = 'native edit after real Host process restart\n';
            for (const filePath of [f.offlineFile, f.pendingFile]) { fs.writeFileSync(filePath, liveContent); }
            await until('second Host direct owners to observe later native-only edits', () =>
                [f.offlineFile, f.pendingFile].every(filePath => tracker.getTrackedChanges().some(change =>
                    change.filePath === filePath && change.currentContent === liveContent)));
            for (const [index, filePath] of [f.offlineFile, f.pendingFile].entries()) {
                assertReview(tracker, filePath, f.baseline[index], liveContent);
            }
            assert.equal(tracker.fileWatchers.length, 0);
            assertActiveOwners(tracker, f.directories, f.root, handles);
            assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
            tracker.stopRecording();
            await until('second Host Stop to release native owners', () => handles.every(handle => handle.closed));
            assert.equal(tracker.activeDirectDirectoryWatcherCount(tracker.sessionEpoch), 0);
            assert.equal(tracker.supplementalIdentityTimer, undefined);
            assert.equal(await tracker.flushPendingPersistence(), true);
            const saved = JSON.parse(fs.readFileSync(f.statePath, 'utf8'));
            assert.equal(saved.isRecording, false);
            assert.equal(new Map(saved.fileSnapshots).get(f.offlineFile), f.baseline[0]);
            assert.equal(new Map(saved.fileSnapshots).get(f.pendingFile), f.baseline[1]);
            console.log('PASS HOST-S4-D process restart: same persisted review, offline reconciliation, fresh native owners, native-only later edits and Stop');
        } finally {
            try {
                await tracker.dispose();
                await until('restore disposal to release native owners', () => handles.every(handle => handle.closed));
            } finally { await removeFixture(f); }
        }
    });
};
