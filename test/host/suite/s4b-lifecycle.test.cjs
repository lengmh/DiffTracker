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

module.exports = async function s4bLifecycleHost(workspace) {
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
