// Production tracker in the real Extension Host. Only the restore read is
// paused to make watcher ordering deterministic; filesystem/events/save are real.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');
const { DiffTracker } = require('../../../out/diffTracker.js');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
    const deadline = Date.now() + 30000;
    while (!await predicate()) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for real host audit condition');
        await delay(50);
    }
}
async function stableReview(tracker, filePath) {
    let previous;
    let since = Date.now();
    try {
        await until(() => {
            const token = tracker.getReviewToken(filePath);
            const key = token && JSON.stringify(token);
            if (!key || key !== previous) { previous = key; since = Date.now(); }
            return key && Date.now() - since >= 750 && tracker.getBaselineState() === 'ready';
        });
    } catch (error) {
        console.error('HOST-AUDIT diagnostics', JSON.stringify({filePath,
            baselineState:tracker.getBaselineState(),recording:tracker.getIsRecording(),watching:tracker.externalWatcherEnabled,
            roots:tracker.sessionWorkspaceRoots,ignored:tracker.isPathIgnored(vscode.Uri.file(filePath)),
            snapshots:[...tracker.fileSnapshots].filter(([p])=>p.includes('audit-')),
            changes:tracker.getTrackedChanges().filter(c=>c.filePath.includes('audit-')),
            disk:await tracker.readFileSnapshot(vscode.Uri.file(filePath))}));
        throw error;
    }
}
module.exports = async function auditHost(workspace) {
    const p = vscode.Uri.file(path.join(workspace, 'audit-source.txt')).fsPath;
    const q = vscode.Uri.file(path.join(workspace, 'audit-target.txt')).fsPath;
    const recoveryPath = vscode.Uri.file(path.join(workspace, 'audit-recovery.txt')).fsPath;
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'difftracker-audit-host-'));
    let tracker;
    let participant;
    let releaseRead;
    try {
        // Fixtures predate host startup. Creating them here queues native Windows
        // create events into the scan, correctly producing unknown baselines.
        assert.equal(fs.readFileSync(p, 'utf8'), 'base\n');
        if (process.platform === 'win32') {
            assert.ok(vscode.workspace.getWorkspaceFolder(vscode.Uri.file(p.toUpperCase())), 'Windows workspace membership must ignore path casing');
            console.log('PASS HOST-AUDIT Windows workspace lookup accepts equivalent path casing');
        }
        assert.equal(fs.readFileSync(recoveryPath, 'utf8'), 'base\n');
        const ignoredPaths = ['node_modules', 'out'].map(dir => vscode.Uri.file(path.join(workspace, dir, 'audit-ignored.txt')).fsPath);
        for (const ignored of ignoredPaths) { await vscode.workspace.openTextDocument(vscode.Uri.file(ignored)); }
        tracker = new DiffTracker(vscode.Uri.file(storage));
        tracker.startRecording(); await until(() => tracker.getBaselineState() === 'ready');
        const initialState = JSON.parse(fs.readFileSync(path.join(storage, 'session-state.json'), 'utf8'));
        for (const ignored of ignoredPaths) {
            assert.equal(tracker.getOriginalContent(ignored), undefined);
            assert.equal(initialState.fileSnapshots.some(([filePath]) => filePath === ignored), false);
            assert.equal(initialState.unresolvedBaselineFiles.some(([filePath]) => filePath === ignored), false);
        }
        console.log('PASS HOST-AUDIT ignored open documents never enter persisted baseline');
        await delay(500); // Allow the native watcher backend to register.
        for (const batch of [false, true]) {
            const parent = vscode.Uri.file(path.join(workspace, batch ? 'audit-parent-batch' : 'audit-parent-file')).fsPath;
            const child = path.join(parent, 'nested', 'child.txt');
            assert.equal(tracker.getOriginalContent(child), 'parent baseline\n', 'Parent recovery fixture must have a known baseline');
            fs.rmSync(parent, { recursive: true });
            try {
                await until(() => tracker.getTrackedChanges().some(change => change.filePath === child && change.isDeleted));
            } catch (error) {
                console.error('HOST-PARENT deletion diagnostics', JSON.stringify({batch,child,exists:fs.existsSync(child),
                    baseline:tracker.getOriginalContent(child),changes:tracker.getTrackedChanges().filter(change=>change.filePath.startsWith(parent))}));
                throw error;
            }
            await stableReview(tracker, child);
            const result = batch ? await tracker.revertAllChanges([tracker.getReviewToken(child)]) : await tracker.revertFile(child);
            assert.equal(batch ? result.succeeded === 1 : result.status === 'success', true, JSON.stringify(result));
            assert.equal(fs.readFileSync(child, 'utf8'), 'parent baseline\n');
            if (process.platform !== 'win32') {
                assert.equal(fs.statSync(parent).mode & 0o777, 0o700);
                assert.equal(fs.statSync(path.dirname(child)).mode & 0o777, 0o700);
                console.log('PASS HOST-PARENT restored parents have private POSIX permissions');
            }
            console.log(`PASS HOST-PARENT ${batch ? 'batch' : 'file'} recovery`);
        }
        console.log('PASS HOST-AUDIT file and batch recovery recreate deleted parent hierarchy');
        fs.writeFileSync(p, 'edit\n');
        await stableReview(tracker, p);
        const token = tracker.getReviewToken(p);
        fs.unlinkSync(p); fs.symlinkSync(q, p);
        assert.notEqual((await tracker.revertFile(p, token)).status, 'success');
        assert.equal(fs.readFileSync(q, 'utf8'), 'edit\n');
        console.log('PASS HOST-AUDIT internal symlink preserves unrelated target');
        fs.writeFileSync(recoveryPath, 'edit\n');
        await stableReview(tracker, recoveryPath);
        const reverted = await tracker.revertFile(recoveryPath);
        assert.equal(reverted.status, 'success', JSON.stringify(reverted));
        participant = vscode.workspace.onWillSaveTextDocument(event => {
            if (event.document.uri.fsPath !== recoveryPath) return;
            const document = event.document;
            const range = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
            event.waitUntil(Promise.resolve([vscode.TextEdit.replace(range, 'save participant output\n')]));
        });
        const historyBeforeUndo = JSON.stringify(tracker.revertHistory);
        const undo = await tracker.undoLastRevert();
        assert.equal(undo.succeeded, 0);
        assert.equal(fs.readFileSync(recoveryPath, 'utf8'), 'save participant output\n');
        assert.equal(JSON.stringify(tracker.revertHistory), historyBeforeUndo, 'Conflicting Undo must retain all recovery records');
        console.log('PASS HOST-AUDIT real save participant retains conflicting Undo recovery');
        participant.dispose(); participant = undefined;
        await tracker.flushPendingPersistence(); await tracker.dispose();
        tracker = new DiffTracker(vscode.Uri.file(storage));
        const read = tracker.readCurrentFileState.bind(tracker);
        const gate = new Promise(resolve => { releaseRead = resolve; });
        let entered = false;
        tracker.readCurrentFileState = async filePath => {
            const result = await read(filePath);
            if (filePath === q) { entered = true; await gate; }
            return result;
        };
        const restoring = tracker.restorePersistedState();
        try {
            await until(() => entered);
            // Native watcher registration is asynchronous inside the host.
            await delay(500);
            fs.writeFileSync(q, 'external during restore\n');
            await until(() => tracker.restoreEvents.has(q));
        } finally { releaseRead(); }
        assert.equal(await restoring, 'restored');
        await until(() => tracker.getTrackedChanges().some(change => change.filePath === q && change.currentContent === 'external during restore\n'));
        console.log('PASS HOST-AUDIT real watcher replays write over stale restore read');
        tracker.stopRecording();
        assert.equal(await tracker.resetBaselineToCurrentState(), true);
        await tracker.dispose();
        tracker = new DiffTracker(vscode.Uri.file(storage));
        assert.equal(await tracker.restorePersistedState(), 'restored');
        assert.equal(tracker.getIsRecording(), false);
        assert.equal(tracker.getTrackedChanges().length, 0);
        assert.equal(tracker.getOriginalContent(q), undefined);
        assert.equal(tracker.revertHistory.length, 0);
        assert.equal(fs.readFileSync(q, 'utf8'), 'external during restore\n');
        console.log('PASS HOST-AUDIT stopped clear survives tracker disposal and restore');
    } finally {
        releaseRead?.(); participant?.dispose(); await tracker?.dispose();
        fs.rmSync(storage, { recursive: true, force: true });
    }
};
