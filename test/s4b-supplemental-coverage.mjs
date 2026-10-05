import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function configuredScope(tracker, mode, includes = [], excludes = []) {
    const roots = tracker.currentWorkspaceRootIdentities().map(root => ({...root}));
    const scope = {kind:'configured', mode, roots, includes, excludes, scopeRevision:''};
    scope.scopeRevision = createHash('sha256').update(JSON.stringify({
        model:1, mode, roots, includes, excludes
    })).digest('hex');
    return scope;
}

function activeNativeWatcher(nativeDirectoryWatchers, directory) {
    const resolved = path.resolve(directory);
    return [...nativeDirectoryWatchers].reverse().find(watcher =>
        watcher.active && path.resolve(String(watcher.directory)) === resolved
    );
}

async function settle(tracker) {
    await delay(220);
    if (typeof tracker.drainDeferredScopeApplyEvents === 'function') {
        await tracker.drainDeferredScopeApplyEvents(tracker.sessionEpoch);
    }
    await delay(20);
}

export function registerS4BSupplementalCoverage(h, fixture) {
    const {test, Uri, DiffTracker, file, getTracker, setTracker, setVsCodeExcludes, nativeDirectoryWatchers,
        fireConfigurationChanged} = h;

    test('S4-B literal watcher blind subtree installs persistent direct coverage and observes C/M/D', () => fixture(async ({tracker,dir}) => {
        const blind = path.join(dir,'blind');
        fs.mkdirSync(blind,{recursive:true});
        const changed = path.join(blind,'changed.txt');
        const deleted = path.join(blind,'deleted.txt');
        fs.writeFileSync(changed,'before');
        fs.writeFileSync(deleted,'before-delete');
        setVsCodeExcludes({'files.watcherExclude': {'blind/**': true}});
        tracker.effectiveMonitoringScope = configuredScope(tracker,'rules');
        const requested = configuredScope(tracker,'rules',[{scope:'all',path:'blind'}]);

        const result = await tracker.applyConfiguredMonitoringScope(requested,false,()=>true);
        assert.equal(result.status,'applied',JSON.stringify(result));
        assert.equal(tracker.getOriginalContent(changed),'before');
        assert.equal(tracker.getOriginalContent(deleted),'before-delete');
        assert.ok(tracker.supplementalCoverageRoots.has(path.resolve(blind)));
        const watcher = activeNativeWatcher(nativeDirectoryWatchers,blind);
        assert.ok(watcher,'literal watcher blind subtree must have an owned direct watcher');
        assert.equal(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath===path.resolve(blind)),false);

        fs.writeFileSync(changed,'after');
        watcher.listener('change','changed.txt');
        const created = path.join(blind,'created.txt');
        fs.writeFileSync(created,'created');
        watcher.listener('rename','created.txt');
        fs.unlinkSync(deleted);
        watcher.listener('rename','deleted.txt');
        await settle(tracker);

        const changes = new Map(tracker.getTrackedChanges().map(item=>[path.resolve(item.filePath),item]));
        assert.equal(changes.get(path.resolve(changed))?.currentContent,'after');
        assert.equal(changes.get(path.resolve(created))?.baselineExists,false);
        assert.equal(changes.get(path.resolve(created))?.currentExists,true);
        assert.equal(changes.get(path.resolve(deleted))?.isDeleted,true);
    },'rules'));

    test('S4-B supplemental watcher capacity failure commits a durable visible gap instead of pretending coverage', () => fixture(async ({tracker,dir}) => {
        const blind = path.join(dir,'capacity-blind');
        fs.mkdirSync(blind,{recursive:true});
        fs.writeFileSync(path.join(blind,'existing.txt'),'baseline');
        setVsCodeExcludes({'files.watcherExclude': {'capacity-blind/**': true}});
        tracker.effectiveMonitoringScope = configuredScope(tracker,'rules');
        tracker.maxImportedDirectoryWatchers = 0;
        const requested = configuredScope(tracker,'rules',[{scope:'all',path:'capacity-blind'}]);

        const result = await tracker.applyConfiguredMonitoringScope(requested,false,()=>true);
        assert.equal(result.status,'applied',JSON.stringify(result));
        const gap = tracker.getSubtreeCoverageGaps().find(item => item.targetPath===path.resolve(blind));
        assert.ok(gap,'failed direct coverage must be visible as a durable subtree gap');
        assert.equal(gap.reasonCode,'supplemental-watcher-capacity-gap');
        assert.match(gap.reason,/capacity/i);
        assert.equal(activeNativeWatcher(nativeDirectoryWatchers,blind),undefined);
        assert.equal(tracker.getEffectiveMonitoringScope().scopeRevision,requested.scopeRevision);
    },'rules'));

    test('S4-B imported bridge and supplemental coverage share one direct-watcher capacity budget', () => fixture(async ({tracker,dir}) => {
        const blind = path.join(dir,'shared-budget-blind');
        const imported = path.join(blind,'imported-child');
        fs.mkdirSync(blind,{recursive:true});
        fs.writeFileSync(path.join(blind,'baseline.txt'),'baseline');
        setVsCodeExcludes({'files.watcherExclude': {'shared-budget-blind/**': true}});
        tracker.effectiveMonitoringScope = configuredScope(tracker,'rules');
        tracker.maxImportedDirectoryWatchers = 1;
        const requested = configuredScope(tracker,'rules',[{scope:'all',path:'shared-budget-blind'}]);

        const result = await tracker.applyConfiguredMonitoringScope(requested,false,()=>true);
        assert.equal(result.status,'applied',JSON.stringify(result));
        assert.ok(activeNativeWatcher(nativeDirectoryWatchers,blind),
            'the single shared direct-watcher slot is consumed by supplemental coverage');
        fs.mkdirSync(imported,{recursive:true});
        assert.equal(tracker.activeDirectDirectoryWatcherCount(tracker.sessionEpoch),1);
        assert.throws(
            () => tracker.watchImportedDirectory(imported,tracker.sessionEpoch),
            /watcher (?:capacity|limit)|capacity|limit/i,
            'temporary imported bridge must not receive a second independent 256-slot budget'
        );
        assert.equal(activeNativeWatcher(nativeDirectoryWatchers,imported),undefined);
    },'rules'));

    test('S4-B failed scope Apply rolls back newly installed supplemental watchers', () => fixture(async ({tracker,dir}) => {
        const blind = path.join(dir,'rollback-blind');
        fs.mkdirSync(blind,{recursive:true});
        fs.writeFileSync(path.join(blind,'baseline.txt'),'baseline');
        setVsCodeExcludes({'files.watcherExclude': {'rollback-blind/**': true}});
        const before = configuredScope(tracker,'rules');
        tracker.effectiveMonitoringScope = before;
        const requested = configuredScope(tracker,'rules',[{scope:'all',path:'rollback-blind'}]);
        const originalCapture = tracker.captureConfiguredExpansionBaselines.bind(tracker);
        tracker.captureConfiguredExpansionBaselines = async () => {
            throw new Error('forced S4-B candidate capture failure');
        };
        try {
            const result = await tracker.applyConfiguredMonitoringScope(requested,false,()=>true);
            assert.equal(result.status,'failed',JSON.stringify(result));
            assert.match(result.reason??'',/forced S4-B candidate capture failure/);
            assert.equal(tracker.getEffectiveMonitoringScope().scopeRevision,before.scopeRevision,
                'failed Apply must restore the previously committed scope');
            assert.equal(activeNativeWatcher(nativeDirectoryWatchers,blind),undefined,
                'candidate-only supplemental watcher must be removed on rollback');
            assert.equal(tracker.supplementalCoverageRoots.has(path.resolve(blind)),false);
        } finally {
            tracker.captureConfiguredExpansionBaselines = originalCapture;
        }
    },'rules'));

    test('S4-B persisted configured scope rebuilds supplemental coverage on restart before normal recording resumes', () => fixture(async ({tracker,dir,folder}) => {
        const storage = file('s4b-restart-storage');
        tracker.storageUri = Uri.file(storage);
        const blind = path.join(dir,'restart-blind');
        fs.mkdirSync(blind,{recursive:true});
        const target = path.join(blind,'tracked.txt');
        fs.writeFileSync(target,'before');
        setVsCodeExcludes({'files.watcherExclude': {'restart-blind/**': true}});
        tracker.effectiveMonitoringScope = configuredScope(tracker,'rules');
        const requested = configuredScope(tracker,'rules',[{scope:'all',path:'restart-blind'}]);
        assert.equal((await tracker.applyConfiguredMonitoringScope(requested,false,()=>true)).status,'applied');
        assert.equal(await tracker.flushPendingPersistence(),true);
        await tracker.dispose();

        const restarted = new DiffTracker(Uri.file(storage));
        setTracker(restarted);
        const outcome = await restarted.restorePersistedState();
        assert.equal(outcome,'restored');
        assert.equal(restarted.getIsRecording(),true);
        assert.equal(restarted.getBaselineState(),'ready');
        assert.ok(restarted.supplementalCoverageRoots.has(path.resolve(blind)));
        const watcher = activeNativeWatcher(nativeDirectoryWatchers,blind);
        assert.ok(watcher,'restart must rebuild owned supplemental coverage from effective scope + watcher policy');
        assert.equal(restarted.getSubtreeCoverageGaps().some(gap => gap.targetPath===path.resolve(blind)),false);

        fs.writeFileSync(target,'after-restart');
        watcher.listener('change','tracked.txt');
        await settle(restarted);
        const change = restarted.getTrackedChanges().find(item=>path.resolve(item.filePath)===path.resolve(target));
        assert.equal(change?.currentContent,'after-restart');
    },'rules'));

    test('S4-B child watcher failure during candidate capture remains a visible gap', () => fixture(async ({tracker,dir}) => {
        const blind = path.join(dir,'child-error-blind');
        const child = path.join(blind,'child');
        fs.mkdirSync(child,{recursive:true});
        fs.writeFileSync(path.join(child,'tracked.txt'),'before');
        setVsCodeExcludes({'files.watcherExclude': {'child-error-blind/**': true}});
        tracker.effectiveMonitoringScope = configuredScope(tracker,'rules');
        const requested = configuredScope(tracker,'rules',[{scope:'all',path:'child-error-blind'}]);
        const originalCapture = tracker.captureConfiguredExpansionBaselines.bind(tracker);
        let failedChild;
        tracker.captureConfiguredExpansionBaselines = async (...args) => {
            failedChild = activeNativeWatcher(nativeDirectoryWatchers,child);
            assert.ok(failedChild);
            failedChild.error(Object.assign(new Error('child watcher failed during capture'),{code:'EIO'}));
            return originalCapture(...args);
        };
        try {
            const result = await tracker.applyConfiguredMonitoringScope(requested,false,()=>true);
            assert.equal(result.status,'applied',JSON.stringify(result));
            assert.equal(failedChild.active,false);
            assert.ok(activeNativeWatcher(nativeDirectoryWatchers,blind));
            assert.ok(tracker.getSubtreeCoverageGaps().some(gap=>gap.targetPath===path.resolve(blind)),
                'a healthy root handle and completed capture cannot erase its failed child coverage');
        } finally {
            tracker.captureConfiguredExpansionBaselines = originalCapture;
        }
    },'rules'));

    test('S4-B full-scan reconciliation preserves a child failure newer than watch installation', () => fixture(async ({tracker,dir}) => {
        const blind = path.join(dir,'reconcile-child-error-blind');
        const child = path.join(blind,'child');
        fs.mkdirSync(child,{recursive:true});
        const epoch = tracker.sessionEpoch;
        tracker.setSubtreeCoverageGap(blind,'supplemental-watcher-installation-gap','Earlier coverage obligation',false);
        const healthyInstall = await tracker.installSupplementalCoverageTargets([blind],epoch,true);
        tracker.reconcileSupplementalCoverageAfterSuccessfulScan(healthyInstall);
        assert.equal(tracker.getSubtreeCoverageGaps().some(gap=>gap.targetPath===path.resolve(blind)),false,
            'a completed full scan with unchanged healthy ownership may retire its older obligation');

        tracker.setSubtreeCoverageGap(blind,'supplemental-watcher-installation-gap','Second earlier obligation',false);
        const install = await tracker.installSupplementalCoverageTargets([blind],epoch,true);
        const childWatcher = activeNativeWatcher(nativeDirectoryWatchers,child);
        childWatcher.error(Object.assign(new Error('new failure during full scan'),{code:'EIO'}));
        const newGap = tracker.getSubtreeCoverageGaps().find(gap=>gap.targetPath===path.resolve(blind));
        assert.ok(newGap);
        assert.ok(activeNativeWatcher(nativeDirectoryWatchers,blind));

        tracker.reconcileSupplementalCoverageAfterSuccessfulScan(install);
        assert.deepEqual(tracker.getSubtreeCoverageGaps().find(gap=>gap.targetPath===path.resolve(blind)),newGap,
            'full-scan completion cannot clear a new child failure merely because its root handle is healthy');
    },'rules'));

    test('S4-B repeated Apply preserves an older gap after watcher recovery without reconciliation', () => fixture(async ({tracker,dir}) => {
        const blind = path.join(dir,'unreconciled-blind');
        fs.mkdirSync(blind,{recursive:true});
        const target = path.join(blind,'tracked.txt');
        fs.writeFileSync(target,'before');
        setVsCodeExcludes({'files.watcherExclude': {'unreconciled-blind/**': true}});
        tracker.effectiveMonitoringScope = configuredScope(tracker,'rules');
        const requested = configuredScope(tracker,'rules',[{scope:'all',path:'unreconciled-blind'}]);
        assert.equal((await tracker.applyConfiguredMonitoringScope(requested,false,()=>true)).status,'applied');
        activeNativeWatcher(nativeDirectoryWatchers,blind).error(
            Object.assign(new Error('watcher unavailable'),{code:'EIO'})
        );
        fs.writeFileSync(target,'changed while unobserved');
        assert.ok(tracker.getSubtreeCoverageGaps().some(gap=>gap.targetPath===path.resolve(blind)));

        const result = await tracker.applyConfiguredMonitoringScope(requested,false,()=>true);
        assert.equal(result.status,'applied',JSON.stringify(result));
        assert.ok(activeNativeWatcher(nativeDirectoryWatchers,blind));
        assert.equal(tracker.getOriginalContent(target),'before');
        assert.ok(tracker.getSubtreeCoverageGaps().some(gap=>gap.targetPath===path.resolve(blind)),
            'scope candidate capture skips existing baselines, so it cannot retire an older observation gap');
    },'rules'));

    test('S4-B removing watcher exclusion retains the known gap until state is reconciled', () => fixture(async ({tracker,dir}) => {
        const blind = path.join(dir,'policy-removal-blind');
        fs.mkdirSync(blind,{recursive:true});
        const target = path.join(blind,'tracked.txt');
        fs.writeFileSync(target,'before');
        setVsCodeExcludes({'files.watcherExclude': {'policy-removal-blind/**': true}});
        const requested = configuredScope(tracker,'wholeWorkspace');
        assert.equal((await tracker.applyConfiguredMonitoringScope(requested,false,()=>true)).status,'applied');
        activeNativeWatcher(nativeDirectoryWatchers,blind).error(
            Object.assign(new Error('missed observation before policy removal'),{code:'EIO'})
        );
        fs.writeFileSync(target,'changed during gap');
        const before = tracker.getSubtreeCoverageGaps().find(gap=>gap.targetPath===path.resolve(blind));
        assert.ok(before);

        setVsCodeExcludes({});
        fireConfigurationChanged('files.watcherExclude');
        await settle(tracker);
        assert.equal(activeNativeWatcher(nativeDirectoryWatchers,blind),undefined);
        assert.deepEqual(tracker.getSubtreeCoverageGaps().find(gap=>gap.targetPath===path.resolve(blind)),before,
            'restored host coverage only covers future events, not changes missed during the existing gap');
    }));

    test('S4-B queued callback from a closed replaced watcher cannot mutate live coverage', () => fixture(async ({tracker,dir}) => {
        const blind = path.join(dir,'replaced-watch-blind');
        fs.mkdirSync(blind,{recursive:true});
        const epoch = tracker.sessionEpoch;
        tracker.watchSupplementalDirectory(blind,blind,epoch);
        const old = activeNativeWatcher(nativeDirectoryWatchers,blind);
        old.error(Object.assign(new Error('old watcher failed'),{code:'EIO'}));
        tracker.watchSupplementalDirectory(blind,blind,epoch);
        assert.equal(old.active,false);
        assert.ok(activeNativeWatcher(nativeDirectoryWatchers,blind));
        const before = tracker.getSubtreeCoverageGaps();

        old.listener('change',undefined);
        assert.deepEqual(tracker.getSubtreeCoverageGaps(),before,
            'matching path, epoch and coverage root do not make an old native handle the current owner');
    },'rules'));

    for (const interruption of ['stop','scope release']) {
        test(`S4-B async directory installation interrupted by ${interruption} cannot publish stale work`, () => fixture(async ({tracker,dir}) => {
            const blind = path.join(dir,'interrupted-watch-blind');
            const child = path.join(blind,'child');
            const grandchild = path.join(child,'grandchild');
            fs.mkdirSync(blind,{recursive:true});
            const epoch = tracker.sessionEpoch;
            await tracker.installSupplementalCoverageTargets([blind],epoch,true);
            tracker.commitSupplementalCoverageTargets([blind]);
            const watcher = activeNativeWatcher(nativeDirectoryWatchers,blind);
            fs.mkdirSync(grandchild,{recursive:true});

            let enter;
            const entered = new Promise(resolve=>{enter=resolve;});
            let release;
            const released = new Promise(resolve=>{release=resolve;});
            const originalOpen = fs.promises.opendir;
            const originalTree = tracker.watchSupplementalTree.bind(tracker);
            const originalDispatch = tracker.dispatchExternalEvent;
            let work;
            fs.promises.opendir = async (directory,...args) => {
                if (path.resolve(String(directory))===path.resolve(child)) {
                    enter();
                    await released;
                    if (interruption==='stop') {
                        throw Object.assign(new Error('late directory failure after Stop'),{code:'EIO'});
                    }
                }
                return originalOpen(directory,...args);
            };
            tracker.watchSupplementalTree = (...args) => {
                const promise = originalTree(...args);
                if (path.resolve(args[0])===path.resolve(child)) { work=promise; }
                return promise;
            };
            // Isolate direct-watch ownership from the independent imported-directory
            // bridge, whose event dispatch and reconciliation have separate tests.
            tracker.dispatchExternalEvent = ()=>{};
            try {
                watcher.listener('rename','child');
                if (work) {
                    await entered;
                } else {
                    assert.ok(tracker.getSubtreeCoverageGaps().some(gap=>gap.targetPath===path.resolve(blind)),
                        'deferring runtime installation must leave explicit persistent-coverage uncertainty');
                }
                if (interruption==='stop') { tracker.stopRecording(); }
                else { tracker.commitSupplementalCoverageTargets([]); }
                const gapsBefore = tracker.getSubtreeCoverageGaps();
                release();
                await work?.catch(()=>{});
                await Promise.resolve();
                assert.equal(nativeDirectoryWatchers.some(entry=>entry.active &&
                    path.relative(blind,String(entry.directory)).split(path.sep)[0]!=='..'),false,
                    'work started by a released owner must not install descendant handles afterward');
                assert.deepEqual(tracker.getSubtreeCoverageGaps(),gapsBefore,
                    'late failures from obsolete coverage work must not modify the current ledger');
            } finally {
                release();
                fs.promises.opendir = originalOpen;
                tracker.watchSupplementalTree = originalTree;
                tracker.dispatchExternalEvent = originalDispatch;
            }
        },'rules'));
    }

    test('S4-B failed overlapping target preparation preserves the previous live watch owner', () => fixture(async ({tracker,dir}) => {
        const blind = path.join(dir,'overlap-blind');
        const child = path.join(blind,'child');
        fs.mkdirSync(child,{recursive:true});
        const epoch = tracker.sessionEpoch;
        await tracker.installSupplementalCoverageTargets([child],epoch,true);
        tracker.commitSupplementalCoverageTargets([child]);
        const old = activeNativeWatcher(nativeDirectoryWatchers,child);
        const previousEntry = tracker.supplementalDirectoryWatchers.get(child);
        const originalOpen = fs.promises.opendir;
        fs.promises.opendir = async (directory,...args) => {
            if (path.resolve(String(directory))===path.resolve(child)) {
                throw Object.assign(new Error('forced failure after overlapping watch acquisition'),{code:'EIO'});
            }
            return originalOpen(directory,...args);
        };
        try {
            const install = await tracker.installSupplementalCoverageTargets([blind],epoch,true);
            tracker.rollbackSupplementalCoverageInstall(install,epoch);
            assert.equal(old.active,true,
                'failed candidate preparation cannot restore an old entry whose native watcher was already closed');
            assert.equal(tracker.supplementalDirectoryWatchers.get(child),previousEntry);
            assert.ok(tracker.getSubtreeCoverageGaps().some(gap=>gap.targetPath===path.resolve(blind)));
        } finally {
            fs.promises.opendir = originalOpen;
        }
    },'rules'));
}
