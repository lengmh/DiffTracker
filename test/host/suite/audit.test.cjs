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
module.exports = async function auditHost(workspace) {
    const p = path.join(workspace, 'audit-source.txt');
    const q = path.join(workspace, 'audit-target.txt');
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'difftracker-audit-host-'));
    let tracker;
    let participant;
    let releaseRead;
    try {
        fs.writeFileSync(p, 'base\n'); fs.writeFileSync(q, 'edit\n');
        tracker = new DiffTracker(vscode.Uri.file(storage));
        tracker.startRecording(); await until(() => tracker.getBaselineState() === 'ready');
        fs.writeFileSync(p, 'edit\n');
        await until(() => tracker.getReviewToken(p));
        const token = tracker.getReviewToken(p);
        fs.unlinkSync(p); fs.symlinkSync(q, p);
        assert.notEqual((await tracker.revertFile(p, token)).status, 'success');
        assert.equal(fs.readFileSync(q, 'utf8'), 'edit\n');
        console.log('PASS HOST-AUDIT internal symlink preserves unrelated target');
        fs.unlinkSync(p); fs.writeFileSync(p, 'edit\n');
        await until(() => tracker.getReviewToken(p));
        assert.equal((await tracker.revertFile(p)).status, 'success');
        participant = vscode.workspace.onWillSaveTextDocument(event => {
            if (event.document.uri.fsPath !== p) return;
            const document = event.document;
            const range = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
            event.waitUntil(Promise.resolve([vscode.TextEdit.replace(range, 'save participant output\n')]));
        });
        const undo = await tracker.undoLastRevert();
        assert.equal(undo.succeeded, 0);
        assert.equal(fs.readFileSync(p, 'utf8'), 'save participant output\n');
        assert.equal(tracker.revertHistory.length, 1);
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
    } finally {
        releaseRead?.(); participant?.dispose(); await tracker?.dispose();
        fs.rmSync(storage, { recursive: true, force: true });
    }
};
