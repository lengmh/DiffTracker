// Real workspace ownership and native watchers; no synthetic event delivery.
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

async function afterEvent(description, event, matches, update) {
    let delivered = false;
    const subscription = event(value => { if (matches(value)) { delivered = true; } });
    try {
        await update();
        await until(description, () => delivered);
    } finally {
        subscription.dispose();
    }
}

module.exports = async function nestedWorkspaceCoverageHost(outerPath) {
    const outer = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(outerPath));
    assert.ok(outer, 'outer workspace folder must be registered');
    const vendor = vscode.Uri.file(path.join(outerPath, 'vendor')).fsPath;
    const nested = path.join(vendor, 'pkg');
    const src = path.join(nested, 'src');
    const outerFile = path.join(vendor, 'outer.txt');
    const nestedFile = path.join(src, 'nested.txt');
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'difftracker-nested-host-'));
    const filesConfig = vscode.workspace.getConfiguration('files', outer.uri);
    const previousExcludes = filesConfig.inspect('watcherExclude')?.workspaceFolderValue;
    let tracker;
    const hostWatchers = [];
    const hostEvents = [];
    try {
        fs.mkdirSync(src, { recursive: true });
        fs.mkdirSync(path.join(nested, '.vscode'));
        fs.writeFileSync(outerFile, 'outer baseline\n');
        fs.writeFileSync(nestedFile, 'nested baseline\n');
        // Wait for notification delivery, not only updated folder lookup: a
        // later event would stop a new tracker and invalidate its install epoch.
        await afterEvent('nested workspace registration event', vscode.workspace.onDidChangeWorkspaceFolders,
            event => event.added.some(folder => folder.uri.fsPath === nested), () => {
                assert.equal(vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders.length, 0, {
                    uri: vscode.Uri.file(nested), name: 'nested-supplemental-package'
                }), true);
            });
        const nestedFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(src));
        assert.equal(nestedFolder?.uri.fsPath, nested);
        // Apply each folder policy only after registration, and wait for the
        // actual configuration notification before constructing the tracker.
        for (const [folder, pattern] of [[outer, 'vendor/**'], [nestedFolder, 'src/**']]) {
            const config = vscode.workspace.getConfiguration('files', folder.uri);
            const previous = config.inspect('watcherExclude')?.workspaceFolderValue;
            await afterEvent(`${folder.name} watcher exclusion event`, vscode.workspace.onDidChangeConfiguration,
                event => event.affectsConfiguration('files.watcherExclude', folder.uri), () =>
                    config.update('watcherExclude', { ...previous, [pattern]: true },
                        vscode.ConfigurationTarget.WorkspaceFolder));
            assert.equal(vscode.workspace.getConfiguration('files', folder.uri).get('watcherExclude', {})[pattern], true);
        }

        // Keep independent host watchers as a negative control. The production
        // tracker below owns only native direct watchers, so these cannot mask
        // a missing nested owner by dispatching an event into the tracker.
        for (const folder of [outer, nestedFolder]) {
            const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'));
            watcher.onDidChange(event => hostEvents.push(event.fsPath));
            hostWatchers.push(watcher);
        }
        tracker = new DiffTracker(vscode.Uri.file(storage));
        const requested = validateAndCanonicalizeScope({
            mode: 'rules', includes: [
                { scope: 'folder', folder: outer.name, path: 'vendor' },
                { scope: 'folder', folder: nestedFolder.name, path: 'src' }
            ], excludes: []
        }, tracker.currentWorkspaceRootIdentities());
        assert.equal(requested.ok, true);
        tracker.effectiveMonitoringScope = { kind: 'configured', ...requested.scope };
        tracker.isRecording = true;
        tracker.externalWatcherEnabled = true;
        tracker.snapshotInitialized = true;
        for (const [filePath, content] of [[outerFile, 'outer baseline\n'], [nestedFile, 'nested baseline\n']]) {
            tracker.fileSnapshots.set(filePath, content);
            tracker.baselineExistingFiles.add(filePath);
        }

        const plan = tracker.configuredSupplementalCoveragePlan(requested.scope);
        assert.equal(plan.issue, undefined);
        assert.deepEqual(plan.targets, [vendor, src],
            'outer containment must not remove a target owned by the nested workspace');
        const installEpoch = tracker.sessionEpoch;
        const install = await tracker.installSupplementalCoverageTargets(plan.targets, installEpoch, true);
        assert.equal(tracker.sessionEpoch, installEpoch, 'fixture events must settle before watcher installation');
        assert.equal(tracker.isRecording, true, 'fixture setup must not pause the new tracker');
        tracker.commitSupplementalCoverageTargets(plan.targets);
        assert.deepEqual(install.successfulRoots, [vendor, src], JSON.stringify(tracker.getSubtreeCoverageGaps()));
        assert.deepEqual([...tracker.supplementalCoverageRoots], [vendor, src]);
        assert.deepEqual([...tracker.supplementalDirectoryWatchers.keys()], [vendor, src],
            'outer traversal stops at the nested workspace root and cannot watch its src directory');
        assert.equal(tracker.supplementalDirectoryWatchers.get(vendor).coverageRoot, vendor);
        assert.equal(tracker.supplementalDirectoryWatchers.get(src).coverageRoot, src);
        assert.equal(tracker.fileWatchers.length, 0);
        assert.equal(tracker.importedDirectoryWatchers.size, 0);

        await delay(750);
        fs.writeFileSync(outerFile, 'outer external edit\n');
        fs.writeFileSync(nestedFile, 'nested external edit\n');
        await until('independently owned outer and nested direct events', () =>
            [outerFile, nestedFile].every(filePath => tracker.getTrackedChanges().some(change =>
                change.filePath === filePath && change.currentContent ===
                    (filePath === outerFile ? 'outer external edit\n' : 'nested external edit\n'))));
        await delay(1000);
        assert.equal(hostEvents.includes(outerFile), false, 'outer edit is excluded from host observation');
        assert.equal(hostEvents.includes(nestedFile), false, 'nested edit is excluded from host observation');
        assert.equal(tracker.getOriginalContent(outerFile), 'outer baseline\n');
        assert.equal(tracker.getOriginalContent(nestedFile), 'nested baseline\n');
        assert.equal(tracker.getSubtreeCoverageGaps().length, 0);
        assert.equal(await tracker.flushPendingPersistence(), true);
        const saved = JSON.parse(fs.readFileSync(path.join(storage, 'session-state.json'), 'utf8'));
        assert.equal(new Map(saved.fileSnapshots).get(nestedFile), 'nested baseline\n');
        console.log('PASS HOST-NESTED independent direct owners observe excluded edits and preserve baselines');
    } finally {
        for (const watcher of hostWatchers) { watcher.dispose(); }
        if (tracker) { await tracker.dispose(); }
        const folder = vscode.workspace.workspaceFolders.find(item => item.uri.fsPath === nested);
        if (folder) {
            await afterEvent('nested workspace removal event', vscode.workspace.onDidChangeWorkspaceFolders,
                event => event.removed.some(item => item.uri.fsPath === nested), () => {
                    assert.equal(vscode.workspace.updateWorkspaceFolders(folder.index, 1), true);
                });
        }
        await filesConfig.update('watcherExclude', previousExcludes, vscode.ConfigurationTarget.WorkspaceFolder);
        await fs.promises.rm(vendor, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        await fs.promises.rm(storage, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
};
