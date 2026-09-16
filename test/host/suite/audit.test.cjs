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
        for (const name of ['scope-files.txt', 'scope-watcher.txt', 'scope-search.txt']) {
            const included = vscode.Uri.file(path.join(workspace, name)).fsPath;
            const excluded = vscode.Uri.file(path.join(process.env.DIFF_TRACKER_HOST_SECOND_ROOT, name)).fsPath;
            assert.equal(tracker.getOriginalContent(included), 'scope baseline\n');
            assert.equal(tracker.getOriginalContent(excluded), undefined);
            assert.equal(tracker.testIgnorePath(excluded).ignored, true);
        }
        console.log('PASS HOST-SCOPE folder exclusions stay within their workspace root');

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
        const offline = vscode.Uri.file(path.join(workspace, 'audit-offline.txt')).fsPath;
        const offlineEmpty = vscode.Uri.file(path.join(workspace, 'audit-offline-empty.txt')).fsPath;
        fs.writeFileSync(offline, 'created while tracker was disposed\n');
        fs.writeFileSync(offlineEmpty, '');
        tracker = new DiffTracker(vscode.Uri.file(storage));
        tracker.setGitContextPending(true);
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
        for (const filePath of [offline, offlineEmpty]) {
            assert.ok(tracker.getTrackedChanges().some(change => change.filePath === filePath));
            assert.equal(tracker.getOriginalContent(filePath), '');
            assert.equal(tracker.baselineExistingFiles.has(filePath), false);
        }
        console.log('PASS HOST-RESTORE offline text and empty additions retain absent baselines');

        await stableReview(tracker, q);
        const preservedBaseline = tracker.getOriginalContent(q);
        assert.equal((await tracker.keepAllChangesInFile(q)).status, 'conflict');
        assert.equal((await tracker.revertFile(q)).status, 'conflict');
        assert.equal(tracker.getOriginalContent(q), preservedBaseline);
        assert.equal(fs.readFileSync(q, 'utf8'), 'external during restore\n');
        tracker.reconcileRestoredGitContexts([]);
        tracker.setGitContextPending(false);
        assert.equal((await tracker.keepAllChangesInFile(q)).status, 'success');
        console.log('PASS HOST-GIT-INIT restored Keep/Revert pause until reconciliation completes');

        const ignoreDir = path.join(workspace, 'audit-ignore');
        const ignoredFile = vscode.Uri.file(path.join(ignoreDir, 'existing.txt')).fsPath;
        const ignoreFile = path.join(ignoreDir, '.gitignore');
        fs.mkdirSync(ignoreDir, { recursive: true });
        fs.writeFileSync(ignoreFile, 'existing.txt\n');
        fs.writeFileSync(ignoredFile, 'existed before the baseline\n');
        await until(() => tracker.isPathIgnored(vscode.Uri.file(ignoredFile)));
        await delay(750);
        assert.equal(await tracker.resetBaselineToCurrentState(), true);
        assert.equal(tracker.getOriginalContent(ignoredFile), undefined);
        const covered = JSON.parse(fs.readFileSync(path.join(storage, 'session-state.json'), 'utf8'));
        assert.match(covered.scanCoverage, /^[a-f0-9]{64}$/);
        await tracker.dispose();
        fs.writeFileSync(ignoreFile, '');
        tracker = new DiffTracker(vscode.Uri.file(storage));
        assert.equal(await tracker.restorePersistedState(), 'restored');
        assert.equal(tracker.getOriginalContent(ignoredFile), undefined);
        assert.ok(tracker.getTrackedChanges().find(change => change.filePath === ignoredFile)?.unavailableReason);
        assert.equal((await tracker.revertFile(ignoredFile)).status, 'conflict');
        assert.equal(fs.readFileSync(ignoredFile, 'utf8'), 'existed before the baseline\n');
        console.log('PASS HOST-IGNORE offline rule removal retains unknown before-image');

        // Import complete trees from outside the watched workspace. Linux may
        // deliver only a directory create; Windows may deliver child events too.
        for (const withRules of [false, true]) {
            const source = path.join(storage, withRules ? 'import-rules' : 'import-plain');
            const target = vscode.Uri.file(path.join(workspace, withRules ? 'audit-import-rules' : 'audit-import-plain')).fsPath;
            fs.mkdirSync(path.join(source, 'deep'), { recursive: true });
            for (let i = 0; i < 12; i++) { fs.writeFileSync(path.join(source, 'deep', `file-${i}.txt`), `import ${i}\n`); }
            fs.writeFileSync(path.join(source, 'empty.txt'), '');
            if (withRules) {
                fs.writeFileSync(path.join(source, '.gitignore'), '*.log\n!keep.log\n');
                fs.writeFileSync(path.join(source, 'deep', 'skip.log'), 'ignored\n');
                fs.writeFileSync(path.join(source, 'deep', 'keep.log'), 'included\n');
            }
            const expected = [...Array.from({length:12}, (_, i) => path.join(target, 'deep', `file-${i}.txt`)), path.join(target, 'empty.txt')];
            if (withRules) { expected.push(path.join(target, 'deep', 'keep.log')); }
            const editors = vscode.window.visibleTextEditors.length;
            fs.renameSync(source, target);
            await until(() => expected.every(p => tracker.getTrackedChanges().some(c => c.filePath === p && !c.unavailableReason)));
            await stableReview(tracker, expected[0]);
            assert.equal(vscode.window.visibleTextEditors.length, editors);
            for (const p of expected) { assert.equal(tracker.getOriginalContent(p), ''); }
            if (withRules) { assert.equal(tracker.getTrackedChanges().some(c => c.filePath === path.join(target, 'deep', 'skip.log')), false); }
            const tokens = expected.map(p => tracker.getReviewToken(p));
            const accepted = await tracker.keepAllChanges(tokens);
            assert.equal(accepted.failed, 0, JSON.stringify(accepted));
            assert.equal(accepted.succeeded, expected.length);
            fs.writeFileSync(expected[0], 'external follow-up\n');
            await stableReview(tracker, expected[0]);
            const reverted = await tracker.revertFile(expected[0]);
            assert.equal(reverted.status, 'success', JSON.stringify(reverted));
            assert.equal(fs.readFileSync(expected[0], 'utf8'), 'import 0\n');
            console.log(`PASS HOST-DIRECTORY imported tree review/Keep/Revert (rules=${withRules})`);
        }




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
