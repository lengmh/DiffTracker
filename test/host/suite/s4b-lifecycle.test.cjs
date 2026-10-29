// Real native watcher identity coverage, deliberately without a host workspace
// watcher that could mask a dead direct owner by reporting the parent rename.
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

async function directoryChangeHost(workspace) {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'difftracker-directory-change-host-'));
    const root = vscode.Uri.file(path.join(workspace, 's4b-change-owner')).fsPath;
    const child = path.join(root, 'existing');
    const target = path.join(child, 'tracked.txt');
    const sibling = path.join(root, 'sibling.txt');
    const tracker = new DiffTracker(vscode.Uri.file(storage));
    const nativeWatch = fs.watch;
    let observedNotification = false;
    fs.watch = function(directory, ...args) {
        const listener = args[args.length - 1];
        if (String(directory) === root && typeof listener === 'function') {
            args[args.length - 1] = (kind, filename) => {
                if (String(filename) === 'existing') { observedNotification = true; }
                listener(kind, filename);
            };
        }
        return nativeWatch.call(this, directory, ...args);
    };
    try {
        fs.mkdirSync(child, {recursive:true});
        fs.writeFileSync(target, 'known before\n');
        fs.writeFileSync(sibling, 'sibling before\n');
        const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));
        const requested = validateAndCanonicalizeScope({mode:'rules',
            includes:[{scope:'folder',folder:folder.name,path:'s4b-change-owner'}], excludes:[]
        }, tracker.currentWorkspaceRootIdentities());
        assert.equal(requested.ok, true);
        tracker.effectiveMonitoringScope = {kind:'configured', ...requested.scope};
        tracker.sessionWorkspaceRoots = tracker.getWorkspaceRoots();
        tracker.isRecording = true;
        tracker.externalWatcherEnabled = true;
        tracker.snapshotInitialized = true;
        tracker.fileSnapshots.set(target, 'known before\n');
        tracker.baselineExistingFiles.add(target);
        tracker.fileSnapshots.set(sibling, 'sibling before\n');
        tracker.baselineExistingFiles.add(sibling);
        await tracker.installSupplementalCoverageTargets([root], tracker.sessionEpoch, true);
        tracker.commitSupplementalCoverageTargets([root]);
        assert.equal(tracker.fileWatchers.length, 0, 'only native observation may deliver this scenario');
        fs.utimesSync(child, new Date(), new Date(Date.now() + 2000));
        // libuv may classify directory metadata as rename (Linux) or change.
        // Deterministic tests exercise both callback branches separately; this
        // scenario must use the platform's real callback without rewriting it.
        await until('a real native directory notification', () => observedNotification);
        await until('directory verification to finish automatically', () =>
            tracker.directoryObservations.size === 0 && tracker.getSubtreeCoverageGaps().length === 0);
        assert.equal(tracker.getOriginalContent(target), 'known before\n');
        fs.writeFileSync(target, 'later observed edit\n');
        await until('continued native child observation after directory verification', () =>
            tracker.getTrackedChange(target)?.currentContent === 'later observed edit\n');
        assert.equal(tracker.getOriginalContent(target), 'known before\n');
        console.log('PASS HOST-ISSUE-55 real directory notification reconciles automatically and keeps observing child edits');
        const excluded = validateAndCanonicalizeScope({mode:'rules', includes:requested.scope.includes,
            excludes:[{scope:'folder',folder:folder.name,pattern:'/s4b-change-owner/existing/'}]
        }, tracker.currentWorkspaceRootIdentities());
        assert.equal(excluded.ok, true);
        tracker.setSubtreeCoverageGap(child, 'supplemental-watcher-directory-change-gap', 'Earlier directory uncertainty');
        const result = await tracker.applyConfiguredMonitoringScope(excluded.scope, true);
        assert.equal(result.status, 'applied', JSON.stringify(result));
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), [], 'Apply completes excluded diagnostics without Recheck');
        assert.equal(tracker.supplementalDirectoryWatchers.has(child), false);
        assert.ok(tracker.coverageGaps.get(child)?.subtree, 'unscanned excluded evidence remains durable');
        fs.mkdirSync(path.join(child, 'excluded-new-directory'));
        fs.writeFileSync(path.join(child, 'excluded-new-directory', 'ignored.txt'), 'excluded contents\n');
        await delay(300);
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
        fs.writeFileSync(sibling, 'sibling observed after exclusion\n');
        await until('continued sibling observation after child exclusion', () =>
            tracker.getTrackedChange(sibling)?.currentContent === 'sibling observed after exclusion\n');
        assert.equal(tracker.getOriginalContent(sibling), 'sibling before\n');
        console.log('PASS HOST-ISSUE-55 Apply retires excluded diagnostics and owners while native sibling observation continues');
    } finally {
        fs.watch = nativeWatch;
        await tracker.dispose();
        fs.rmSync(root, {recursive:true,force:true});
        fs.rmSync(storage, {recursive:true,force:true});
    }
}

module.exports = async function s4bLifecycleHost(workspace) {
    await directoryChangeHost(workspace);
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'difftracker-s4b-host-'));
    const root = vscode.Uri.file(path.join(workspace, 's4b-identity-owner')).fsPath;
    const moved = `${root}-moved`;
    const target = path.join(root, 'tracked.txt');
    const tracker = new DiffTracker(vscode.Uri.file(storage));
    try {
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(target, 'known before\n');
        const requested = validateAndCanonicalizeScope({
            mode: 'rules', includes: [{scope:'all', path:'s4b-identity-owner'}], excludes: []
        }, tracker.currentWorkspaceRootIdentities());
        assert.equal(requested.ok, true);
        tracker.effectiveMonitoringScope = {kind:'configured', ...requested.scope};
        tracker.sessionWorkspaceRoots = tracker.getWorkspaceRoots();
        tracker.isRecording = true;
        tracker.snapshotInitialized = true;
        tracker.fileSnapshots.set(target, 'known before\n');
        tracker.baselineExistingFiles.add(target);
        await tracker.installSupplementalCoverageTargets([root], tracker.sessionEpoch, true);
        tracker.commitSupplementalCoverageTargets([root]);
        assert.equal(tracker.fileWatchers.length, 0);
        assert.equal(tracker.getSubtreeCoverageGaps().length, 0);
        await delay(250);
        fs.renameSync(root, moved);
        // Recreate the path before queued callbacks run. Existence alone cannot
        // prove that the old native handle follows this replacement directory.
        fs.mkdirSync(root);
        fs.writeFileSync(target, 'replacement contents\n');
        const deadline = Date.now() + 15000;
        while (!tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === root)) {
            if (Date.now() > deadline) { throw new Error('Replaced native owner produced no visible coverage gap'); }
            await delay(50);
        }
        assert.equal(tracker.supplementalDirectoryWatchers.get(root)?.epoch, -1);
        assert.equal(tracker.getOriginalContent(target), 'known before\n');
        assert.equal(fs.readFileSync(target, 'utf8'), 'replacement contents\n');
        assert.equal(await tracker.flushPendingPersistence(), true);
        const saved = JSON.parse(fs.readFileSync(path.join(storage, 'session-state.json'), 'utf8'));
        assert.ok(saved.coverageGaps.some(([directory, record]) => directory === root && record.subtree));
        console.log('PASS HOST-S4-B replaced direct directory identity retains baseline and durable gap without parent watcher');
    } finally {
        await tracker.dispose();
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(moved, { recursive: true, force: true });
        fs.rmSync(storage, { recursive: true, force: true });
    }
};
