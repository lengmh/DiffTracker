// Real registered workspace watchers and filesystem events; no injected callbacks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');
const { DiffTracker } = require('../../../out/diffTracker.js');
const { validateAndCanonicalizeScope } = require('../../../out/monitoringScope.js');
const inside = (file, root) => {
    const relative = path.relative(root, file);
    return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
async function until(description, predicate, diagnostics = () => ({})) {
    const deadline = Date.now() + 15000;
    while (!predicate()) {
        if (Date.now() > deadline) { throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(diagnostics())}`); }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
}
async function changeFolders(matches, change) {
    let delivered = false;
    const listener = vscode.workspace.onDidChangeWorkspaceFolders(event => { if (matches(event)) { delivered = true; } });
    try { assert.equal(change(), true); await until('nested workspace registration notification', () => delivered); }
    finally { listener.dispose(); }
}

module.exports = async function nestedRecheckDeletionHost(workspacePath) {
    const outer = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(workspacePath));
    assert.ok(outer, 'outer workspace must be registered');
    // Use VS Code's fsPath spelling (including Windows drive normalization)
    // for all later comparisons with workspace and watcher notification paths.
    const outerPath = outer.uri.fsPath;
    const ancestor = path.join(outerPath, 'excluded-recheck', 'container');
    const inner = path.join(ancestor, 'nested');
    const files = ['one.txt', 'two.txt'].map(name => path.join(inner, 'selected', name));
    const outside = path.join(outerPath, 'recheck-independent.txt');
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'difftracker-recheck-nested-'));
    const open = fs.promises.open;
    let tracker, release, action;
    const events = [];
    const diagnostics = () => ({ recording: tracker?.isRecording, enabled: tracker?.externalWatcherEnabled,
        epoch: tracker?.sessionEpoch, watchers: tracker?.fileWatchers.length,
        independentBaseline: tracker?.fileSnapshots.has(outside), independentUnknown: tracker?.unresolvedBaselineFiles.get(outside),
        independentReview: tracker?.getTrackedChange(outside)?.reviewKind, events });
    try {
        // run.mjs creates these before-images before launching VS Code.
        await changeFolders(event => event.added.some(folder => folder.uri.fsPath === inner), () =>
            vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders.length, 0,
                { uri: vscode.Uri.file(inner), name: 'nested-recheck' }));
        const nested = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(files[0]));
        assert.equal(nested.uri.fsPath, inner);
        tracker = new DiffTracker(vscode.Uri.file(storage));
        const dispatch = tracker.dispatchExternalEvent;
        tracker.dispatchExternalEvent = function(event, kind, epoch) {
            if (events.length < 32 && (inside(event.fsPath, ancestor) || inside(files[0], event.fsPath) || event.fsPath === outside)) {
                events.push({ path: path.relative(outerPath, event.fsPath), kind, epoch, restoring: this.restoringEpoch });
            }
            return dispatch.call(this, event, kind, epoch);
        };
        const checked = validateAndCanonicalizeScope({ mode: 'rules', includes: [{ scope: 'folder', folder: nested.name, path: 'selected' }],
            excludes: [{ scope: 'folder', folder: outer.name, pattern: '/excluded-recheck/' }] },
        tracker.currentWorkspaceRootIdentities());
        assert.equal(checked.ok, true);
        const scope = checked.scope;
        const applied = await tracker.applyConfiguredMonitoringScope(scope);
        assert.equal(applied.status, 'applied', JSON.stringify(applied));
        assert.equal(tracker.startRecording(), true);
        await until('nested Recheck baseline', () => tracker.getBaselineState() === 'ready');
        assert.equal(tracker.getOriginalContent(outside), 'independent baseline', JSON.stringify(diagnostics()));
        const pendingReads = new Set();
        const reader = tracker.readFileAndUpdate;
        tracker.readFileAndUpdate = async function(file, ...args) {
            const result = await reader.call(this, file, ...args);
            const index = files.indexOf(file);
            if (index >= 0 && this.getTrackedChange(file)?.currentContent === `pending ${index}`) { pendingReads.add(file); }
            return result;
        };
        for (const [index, file] of files.entries()) {
            assert.equal(tracker.getOriginalContent(file), `baseline ${index}`);
            fs.writeFileSync(file, `pending ${index}`);
        }
        await until('real pending reads and directory preparation complete', () =>
            files.every(file => pendingReads.has(file) && !tracker.externalChangeTimers.has(file)) &&
            tracker.pendingSnapshotReads.size === 0 && tracker.activeCreations.size === 0 &&
            tracker.directoryObservations.size === 0, diagnostics);
        tracker.readFileAndUpdate = reader;
        for (const [index, file] of files.entries()) {
            const review = tracker.getTrackedChange(file);
            assert.equal(review?.currentContent, `pending ${index}`);
            assert.equal(review?.reviewKind, 'text');
            assert.equal(review?.unavailableReason, undefined);
        }
        for (const file of files) {
            tracker.setFileCoverageGap(file, 'pending-scope-gap', 'Synthetic earlier interval');
            tracker.markFileUnavailable(file, 'Synthetic earlier interval');
        }
        const targets = files.map(file => ({ path: file, kind: 'file', workspaceRoot: nested.uri.toString() }));
        assert.equal(await tracker.retainScopeOperationRecovery(targets, scope.scopeRevision), true);
        const gate = new Promise(resolve => { release = resolve; });
        let entered = false, settled = false;
        fs.promises.open = async (file, ...args) => {
            // The post-certification read is pending before a handle is opened.
            // Holding our own Windows file handle would obstruct the deletion.
            if (!entered && String(file) === files[1] && !tracker.baselineTransaction &&
                !tracker.coverageGaps.get(files[1])?.file && tracker.restoringEpoch === tracker.sessionEpoch) {
                entered = true;
                await gate;
            }
            return open(file, ...args);
        };
        action = tracker.recheckScopeOperationCoverage(targets, scope.scopeRevision);
        action.finally(() => { settled = true; });
        await until('post-certification nested reread gate', () => entered || settled, diagnostics);
        assert.equal(entered, true, JSON.stringify(await Promise.race([action, Promise.resolve('pending')])));
        assert.equal(tracker.getTrackedChange(files[0])?.currentContent, 'pending 0');
        fs.rmSync(ancestor, { recursive: true });
        await until('real deletion buffered during Recheck', () => [...tracker.restoreEvents.values()].some(event =>
            event.kind === 'delete' && inside(files[0], event.uri.fsPath)) || tracker.coverageRecheckSelectedOverflow, diagnostics);
        release();
        const result = await action;
        fs.promises.open = open;
        assert.ok(['rechecked', 'limited'].includes(result.status), JSON.stringify(result));
        const review = tracker.getTrackedChange(files[0]);
        assert.ok(review?.isDeleted === true || !!review?.unavailableReason,
            'deletion after the first reread cannot leave its old pending text trusted');
        const related = tracker.getScopeOperationCoverageGaps(targets).related;
        if (related.length) { assert.equal(result.status, 'limited'); }
        for (const [index, file] of files.entries()) { assert.equal(tracker.getOriginalContent(file), `baseline ${index}`); }
        assert.equal(await tracker.flushPendingPersistence(), true);
        // The nested root is still absent. Independent live resources must
        // continue to be observed without accepting the lost root's contents.
        fs.writeFileSync(outside, 'independent later edit');
        await until('real observation after nested ancestor deletion', () =>
            tracker.getTrackedChange(outside)?.currentContent === 'independent later edit', diagnostics);
        assert.equal(tracker.getOriginalContent(outside), 'independent baseline');
        console.log('PASS HOST-NESTED-RECHECK excluded ancestor deletion preserves nested review and independent observation');
    } finally {
        release?.();
        if (action) { await action; }
        fs.promises.open = open;
        if (tracker) { await tracker.dispose(); }
        const folder = vscode.workspace.workspaceFolders.find(item => item.uri.fsPath === inner);
        if (folder) {
            await changeFolders(event => event.removed.some(item => item.uri.fsPath === inner), () =>
                vscode.workspace.updateWorkspaceFolders(folder.index, 1));
        }
        await fs.promises.rm(path.join(outerPath, 'excluded-recheck'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        await fs.promises.rm(outside, { force: true });
        await fs.promises.rm(storage, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
};
