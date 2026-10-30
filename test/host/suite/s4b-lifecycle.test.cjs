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

async function until(description, predicate, diagnostics) {
    const deadline = Date.now() + 15000;
    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for ${description}${diagnostics ? `: ${JSON.stringify(diagnostics())}` : ''}`);
        }
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
    const nativeLstat = fs.lstatSync;
    let observedNotifications = 0;
    const notifications = [];
    const providerFallbacks = [];
    fs.lstatSync = function(target, ...args) {
        const result = nativeLstat.call(this, target, ...args);
        if (String(target).startsWith(`${root}${path.sep}`) && providerFallbacks.length < 32 &&
            new Error().stack.includes('isUntrackedDirectory')) {
            providerFallbacks.push({path:path.relative(root,String(target)),directory:result.isDirectory()});
        }
        return result;
    };
    fs.watch = function(directory, ...args) {
        const listener = args[args.length - 1];
        if (String(directory) === root && typeof listener === 'function') {
            args[args.length - 1] = (kind, filename) => {
                if (notifications.length < 128) { notifications.push({kind,filename:String(filename)}); }
                if (String(filename) === 'existing') { observedNotifications++; }
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
        await until('a real native directory notification', () => observedNotifications > 0);
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
        const excludedEvidence = tracker.coverageGaps.get(child)?.subtree;
        assert.ok(excludedEvidence);
        assert.equal((await tracker.recheckObservationCoverage()).status, 'rechecked');
        assert.equal(tracker.coverageGaps.get(child)?.subtree, excludedEvidence);
        const originalEvidence = {...excludedEvidence}, reactivated = [];
        const diagnostics = tracker.onDidTrackChanges(() => {
            reactivated.push(...tracker.getSubtreeCoverageGaps().filter(gap => gap.targetPath === child));
        });
        const opendir = fs.promises.opendir; let excludedEnumerations = 0;
        fs.promises.opendir = async (directory, ...args) => {
            if (String(directory) === child || String(directory).startsWith(`${child}${path.sep}`)) { excludedEnumerations++; }
            return opendir(directory, ...args);
        };
        try {
            for (let round = 0; round < 3; round++) {
                const before = observedNotifications;
                const inner = path.join(child, `created-${round}`); fs.mkdirSync(inner);
                fs.writeFileSync(path.join(inner, 'ignored.txt'), `excluded modification ${round}\n`);
                fs.renameSync(inner, path.join(child, `renamed-${round}`));
                fs.rmSync(child, {recursive:true}); fs.mkdirSync(child);
                await until(`real excluded-directory delete/recreate notification ${round}`, () => observedNotifications > before);
                const incoming = `${root}-incoming-${round}`, live = path.join(root, `live-${round}`);
                fs.mkdirSync(incoming); fs.writeFileSync(path.join(incoming, 'tracked.txt'), `imported ${round}\n`);
                fs.renameSync(incoming, live);
                const current = path.join(live, 'tracked.txt');
                await until(`automatic observation of moved directory ${round}`, () =>
                    tracker.supplementalDirectoryWatchers.get(live)?.epoch === tracker.sessionEpoch &&
                    tracker.directoryObservations.size === 0 &&
                    tracker.getTrackedChange(current)?.reviewKind === 'unknown', () => ({
                        notifications,providerFallbacks,epoch:tracker.sessionEpoch,recording:tracker.getIsRecording(),
                        externalWatcherEnabled:tracker.externalWatcherEnabled,snapshotInitialized:tracker.snapshotInitialized,
                        baselineBuilding:tracker.baselineBuilding,baselineTransaction:!!tracker.baselineTransaction,
                        restoringEpoch:tracker.restoringEpoch,coverageRecheckEpoch:tracker.coverageRecheckEpoch,
                        scopeApplyPreflight:tracker.scopeApplyPreflight,activeScopeApplications:tracker.activeScopeApplications,
                        pendingScope:tracker.pendingMonitoringScope?.scopeRevision,scopeKind:tracker.effectiveMonitoringScope.kind,
                        recoveryBlocked:tracker.recoveryBlocked,persistenceFailed:tracker.persistenceFailed,persistenceIssue:tracker.persistenceIssue,
                        workspaceChanged:tracker.workspaceContextChanged,gitPending:tracker.gitContextPending,
                        ignoredDirectory:tracker.isPathIgnored(vscode.Uri.file(live),true),
                        ignoredFile:tracker.testIgnorePath(live),workspaceOwner:tracker.owningWorkspaceFolderForTraversal(live)?.name,
                        canonicalPath:path.relative(root,tracker.canonicalTrackingPath(live)),
                        owners:[...tracker.supplementalDirectoryWatchers].map(([directory,owner])=>
                            ({path:path.relative(root,directory),epoch:owner.epoch,coverageRoot:path.relative(root,owner.coverageRoot)})),
                        jobs:[...tracker.directoryObservations].map(([directory,job])=>({path:path.relative(root,directory),dirty:job.dirty})),
                        gaps:tracker.getSubtreeCoverageGaps().map(gap=>({path:path.relative(root,gap.targetPath),reasonCode:gap.reasonCode})),
                        reviewKind:tracker.getTrackedChange(current)?.reviewKind,
                        currentContent:tracker.getTrackedChange(current)?.currentContent,
                        originalKnown:tracker.getOriginalContent(current)!==undefined
                    }));
                const unknown = tracker.getUnknownReviewToken(current); assert.ok(unknown);
                fs.writeFileSync(current, `later native child edit ${round}\n`);
                await until(`continued moved-directory native observation ${round}`, () =>
                    tracker.getUnknownReviewToken(current)?.reviewRevision !== unknown.reviewRevision);
                assert.equal(tracker.getTrackedChange(current)?.reviewKind, 'unknown');
                assert.equal(tracker.getOriginalContent(current), undefined);
                fs.writeFileSync(sibling, `later native sibling edit ${round}\n`);
                await until(`continued retained-parent native observation ${round}`, () =>
                    tracker.getTrackedChange(sibling)?.currentContent === `later native sibling edit ${round}\n`);
                await until(`bounded directory work after round ${round}`, () => tracker.directoryObservations.size === 0);
                assert.deepEqual(tracker.getSubtreeCoverageGaps(), [], `Limited must not recur after round ${round}`);
                assert.equal(tracker.coverageGaps.get(child)?.subtree, excludedEvidence);
                assert.deepEqual(excludedEvidence, originalEvidence);
                assert.deepEqual(reactivated, [], 'the same old excluded gap must stay inactive throughout native callbacks');
                assert.equal(tracker.supplementalDirectoryWatchers.has(child), false);
                assert.equal(tracker.getOriginalContent(sibling), 'sibling before\n');
            }
            assert.equal(excludedEnumerations, 0);
        } finally { fs.promises.opendir = opendir; diagnostics.dispose(); }
        console.log(`HOST-ISSUE-55 provider fallback metadata: ${JSON.stringify(providerFallbacks)}`);
        console.log('PASS HOST-ISSUE-55 cleared Limited stays clear through three excluded create/modify/rename/delete-recreate and included move/native-edit rounds');
    } finally {
        fs.watch = nativeWatch;
        fs.lstatSync = nativeLstat;
        await tracker.dispose();
        fs.rmSync(root, {recursive:true,force:true});
        for (let round = 0; round < 3; round++) { fs.rmSync(`${root}-incoming-${round}`, {recursive:true,force:true}); }
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
