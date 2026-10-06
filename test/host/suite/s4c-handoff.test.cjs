// One configured-scope import in the real Extension Host. The parent-create
// boundary is delivered once; every edit after Keep must arrive via fs.watch.
// No workspace FileSystemWatcher can mask a missing persistent direct owner.
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
        await delay(50);
    }
}

module.exports = async function s4cHandoffHost(workspace) {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'difftracker-s4c-host-'));
    // Keep source and destination on the same filesystem for a genuine move of
    // an already-populated directory, including on Windows hosted runners.
    const source = fs.mkdtempSync(path.join(workspace, 's4c-import-source-'));
    const root = vscode.Uri.file(path.join(workspace, 's4c-import-owner')).fsPath;
    const nested = path.join(root, 'deep');
    const directories = [root, nested];
    const files = [path.join(root, 'readme.txt'), path.join(nested, 'tracked.txt')];
    const tracker = new DiffTracker(vscode.Uri.file(storage));
    const nativeWatch = fs.watch;
    const handles = [];
    // Observe only resource lifetimes. Forward the production callback unchanged
    // to the real native watcher; never synthesize or invoke a watcher event.
    fs.watch = function (directory, ...args) {
        const watcher = nativeWatch.call(this, directory, ...args);
        if (directories.includes(String(directory))) {
            const handle = { directory: String(directory), watcher, closed: false };
            handles.push(handle);
            watcher.once('close', () => { handle.closed = true; });
        }
        return watcher;
    };
    try {
        const requested = validateAndCanonicalizeScope({
            mode: 'rules', includes: [{ scope: 'all', path: 's4c-import-owner' }], excludes: []
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
        fs.writeFileSync(path.join(source, 'readme.txt'), 'imported root text\n');
        fs.writeFileSync(path.join(source, 'deep', 'tracked.txt'), 'imported nested text\n');
        fs.renameSync(source, root);
        await tracker.onExternalFileCreated(vscode.Uri.file(root));

        assert.equal(tracker.importedDirectoryWatchers.size, 0,
            'successful configured import must release its temporary bridge owners');
        assert.deepEqual([...tracker.supplementalDirectoryWatchers.keys()].sort(), [...directories].sort(),
            'each imported directory must have an independently established persistent owner');
        for (const directory of directories) {
            const owner = tracker.supplementalDirectoryWatchers.get(directory);
            assert.equal(owner.epoch, tracker.sessionEpoch);
            assert.equal(owner.coverageRoot, root);
            const acquired = handles.filter(handle => handle.directory === directory);
            assert.equal(acquired.length, 2, 'bridge and replacement must acquire separate native handles');
            assert.notEqual(acquired[0].watcher, acquired[1].watcher);
        }
        await until('temporary imported bridge handles to close', () =>
            handles.filter(handle => handle.closed).length === directories.length);
        assert.equal(handles.filter(handle => !handle.closed).length, directories.length);
        assert.equal(tracker.fileWatchers.length, 0);
        assert.equal(tracker.getSubtreeCoverageGaps().length, 0);

        for (const [index, filePath] of files.entries()) {
            const content = index === 0 ? 'imported root text\n' : 'imported nested text\n';
            const change = tracker.getTrackedChanges().find(item => item.filePath === filePath);
            assert.equal(change?.baselineExists, false, 'imported text must enter review with an absent baseline');
            assert.equal(change.currentContent, content);
            assert.equal(change.unavailableReason, undefined);
            const token = tracker.getReviewToken(filePath);
            assert.ok(token, 'the imported text must expose a real review token');
            const kept = await tracker.keepAllChangesInFile(filePath, token);
            assert.equal(kept.status, 'success', JSON.stringify(kept));
            assert.equal(tracker.getOriginalContent(filePath), content);
            assert.equal(tracker.getTrackedChanges().some(item => item.filePath === filePath), false);
        }

        // These writes are the only source of subsequent change notifications.
        // In particular, do not call dispatchExternalEvent or a native listener.
        await delay(250);
        for (const filePath of files) { fs.writeFileSync(filePath, 'native edit after Keep\n'); }
        await until('persistent direct owners to observe native edits after Keep', () =>
            files.every(filePath => tracker.getTrackedChanges().some(change =>
                change.filePath === filePath && change.currentContent === 'native edit after Keep\n')));
        for (const [index, filePath] of files.entries()) {
            const change = tracker.getTrackedChanges().find(item => item.filePath === filePath);
            assert.equal(change.baselineExists, true);
            assert.equal(change.unavailableReason, undefined);
            assert.equal(tracker.getOriginalContent(filePath),
                index === 0 ? 'imported root text\n' : 'imported nested text\n');
        }
        assert.equal(tracker.importedDirectoryWatchers.size, 0);
        assert.equal(tracker.fileWatchers.length, 0);
        assert.equal(tracker.getSubtreeCoverageGaps().length, 0,
            'restart uncertainty must not be presented as a current runtime coverage gap');
        assert.equal(await tracker.flushPendingPersistence(), true);
        const saved = JSON.parse(fs.readFileSync(path.join(storage, 'session-state.json'), 'utf8'));
        assert.equal(saved.version, 4);
        assert.equal(new Map(saved.coverageGaps).get(root)?.subtree?.reasonCode,
            'imported-coverage-restart-required', 'saved review must not claim that an OS handle survives restart');

        tracker.stopRecording();
        await until('Stop to release every imported native handle', () => handles.every(handle => handle.closed));
        assert.equal(tracker.activeDirectDirectoryWatcherCount(tracker.sessionEpoch), 0);
        assert.equal(tracker.supplementalIdentityTimer, undefined);
        assert.equal(tracker.fileWatchers.length, 0);
        assert.equal(await tracker.flushPendingPersistence(), true);
        const stopped = JSON.parse(fs.readFileSync(path.join(storage, 'session-state.json'), 'utf8'));
        assert.equal(stopped.isRecording, false);
        assert.equal(new Map(stopped.coverageGaps).get(root)?.subtree?.reasonCode,
            'imported-coverage-restart-required');
        console.log('PASS HOST-S4-C populated import hands off to independent native owners; Keep, later edits, restart evidence and Stop remain safe');
    } finally {
        fs.watch = nativeWatch;
        await tracker.dispose();
        await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        await fs.promises.rm(source, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        await fs.promises.rm(storage, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
};
