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

    test('S4-B Rules fallback for default wildcard exclusions watches only its concrete include and observes C/M/D', () => fixture(async ({tracker,dir}) => {
        const included = path.join(dir,'concrete-include');
        const nested = path.join(included,'node_modules','fixture-package','lib');
        const unrelated = path.join(dir,'unrelated');
        fs.mkdirSync(nested,{recursive:true});
        fs.mkdirSync(unrelated,{recursive:true});
        const changed = path.join(nested,'changed.txt');
        const deleted = path.join(nested,'deleted.txt');
        fs.writeFileSync(changed,'before');
        fs.writeFileSync(deleted,'before-delete');
        setVsCodeExcludes({'files.watcherExclude': {
            '**/node_modules/*/**': true,
            '**/.hg/store/**': true
        }});
        tracker.effectiveMonitoringScope = configuredScope(tracker,'rules');
        const requested = configuredScope(tracker,'rules',[{scope:'all',path:'concrete-include'}]);

        const result = await tracker.applyConfiguredMonitoringScope(requested,false,()=>true);
        assert.equal(result.status,'applied',JSON.stringify(result));
        assert.deepEqual([...tracker.supplementalCoverageRoots],[path.resolve(included)],
            'default wildcard exclusions must be covered from the explicit include, not the workspace root');
        assert.ok(activeNativeWatcher(nativeDirectoryWatchers,included));
        assert.equal(activeNativeWatcher(nativeDirectoryWatchers,dir),undefined);
        assert.equal(activeNativeWatcher(nativeDirectoryWatchers,unrelated),undefined);
        assert.equal(tracker.getOriginalContent(changed),'before');
        assert.equal(tracker.getOriginalContent(deleted),'before-delete');
        const watcher = activeNativeWatcher(nativeDirectoryWatchers,nested);
        assert.ok(watcher);

        fs.writeFileSync(changed,'after');
        watcher.listener('change','changed.txt');
        const created = path.join(nested,'created.txt');
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

    test('S4-B Rules fallback rejects absent includes and file-parent promotion', () => fixture(async ({tracker,dir}) => {
        const before = configuredScope(tracker,'rules');
        tracker.effectiveMonitoringScope = before;
        fs.writeFileSync(path.join(dir,'root.txt'),'root file');
        fs.mkdirSync(path.join(dir,'nested'),{recursive:true});
        fs.writeFileSync(path.join(dir,'nested','file.txt'),'nested file');
        for (const [include,pattern] of [
            ['missing','**/missing/**'], ['root.txt','**/*.txt'], ['nested/file.txt','**/*.txt']
        ]) {
            setVsCodeExcludes({'files.watcherExclude': {[pattern]:true}});
            const requested = configuredScope(tracker,'rules',[{scope:'all',path:include}]);
            const result = await tracker.applyConfiguredMonitoringScope(requested,false,()=>true);
            assert.equal(result.status,'requiresS4',`${include}: ${JSON.stringify(result)}`);
            assert.equal(tracker.getEffectiveMonitoringScope().scopeRevision,before.scopeRevision);
            assert.equal(nativeDirectoryWatchers.some(watcher=>watcher.active),false,
                'unsupported include fallback cannot broaden watching to a parent directory or workspace root');
        }
    },'rules'));

    test('S4-B Rules fallback leaves Whole Workspace wildcard-root exclusions unsupported', () => fixture(async ({tracker,dir}) => {
        fs.mkdirSync(path.join(dir,'existing-directory'),{recursive:true});
        setVsCodeExcludes({'files.watcherExclude': {'**/node_modules/*/**':true}});
        const before = configuredScope(tracker,'rules');
        tracker.effectiveMonitoringScope = before;
        const requested = configuredScope(tracker,'wholeWorkspace');
        const result = await tracker.applyConfiguredMonitoringScope(requested,false,()=>true);
        assert.equal(result.status,'requiresS4',JSON.stringify(result));
        assert.equal(tracker.getEffectiveMonitoringScope().scopeRevision,before.scopeRevision);
        assert.equal(nativeDirectoryWatchers.some(watcher=>watcher.active),false);
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

    async function lifecycleFixture(tracker, dir) {
        const blind = path.join(dir, 'lifecycle-blind');
        const child = path.join(blind, 'child');
        fs.mkdirSync(child, { recursive: true });
        const target = path.join(child, 'tracked.txt');
        fs.writeFileSync(target, 'before');
        setVsCodeExcludes({'files.watcherExclude': {'lifecycle-blind/**': true}});
        tracker.effectiveMonitoringScope = configuredScope(tracker, 'rules');
        const scope = configuredScope(tracker, 'rules', [{scope:'all', path:'lifecycle-blind'}]);
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope, false, () => true)).status, 'applied');
        h.setListedFiles([Uri.file(target)]);
        return {blind, child, target, scope};
    }

    for (const operation of ['reset', 'repository rebuild']) {
        test(`S4-B lifecycle ${operation} renews direct owners and preserves safe review`, () => fixture(async ({tracker,dir}) => {
            const {blind, child, target} = await lifecycleFixture(tracker, dir);
            const old = activeNativeWatcher(nativeDirectoryWatchers, child);
            let result;
            if (operation === 'reset') {
                result = await tracker.resetBaselineToCurrentState();
            } else {
                const context = {repoRoot:dir,kind:'repository',headName:'main',headCommit:'aaa',detached:false,inProgress:false};
                tracker.setBaselineGitContexts([context]);
                tracker.observeGitContext(context);
                result = await tracker.rebuildRepositoryBaseline(dir, context);
            }
            assert.equal(result, true);
            const fresh = activeNativeWatcher(nativeDirectoryWatchers, child);
            assert.ok(fresh && fresh !== old, 'the current epoch needs a newly bound native owner');
            assert.equal(old.active, false);
            const gaps = tracker.getSubtreeCoverageGaps();
            old.listener('change', undefined);
            assert.deepEqual(tracker.getSubtreeCoverageGaps(), gaps, 'late old callbacks remain rejected');
            assert.equal(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === blind), false);
            fs.writeFileSync(target, 'after lifecycle');
            fresh.listener('change', 'tracked.txt');
            await settle(tracker);
            assert.equal(tracker.getTrackedChanges().find(change => change.filePath === target)?.currentContent, 'after lifecycle', JSON.stringify(tracker.getTrackedChanges()));
            assert.equal((await tracker.keepAllChangesInFile(target)).status, 'success');
            fs.writeFileSync(target, 'later edit');
            fresh.listener('change', 'tracked.txt');
            await settle(tracker);
            assert.equal((await tracker.revertFile(target)).status, 'success');
            assert.equal(fs.readFileSync(target, 'utf8'), 'after lifecycle');
        }, 'rules'));
    }

    for (const failure of ['error', 'unnamed']) {
        test(`S4-B lifecycle failed Apply retains committed ${failure} coverage evidence`, () => fixture(async ({tracker,dir}) => {
            const {blind, child, target, scope} = await lifecycleFixture(tracker, dir);
            fs.writeFileSync(target, 'pending before Apply');
            activeNativeWatcher(nativeDirectoryWatchers, child).listener('change', 'tracked.txt');
            await settle(tracker);
            const added = path.join(dir, 'added');
            fs.mkdirSync(added);
            fs.writeFileSync(path.join(added, 'new.txt'), 'new');
            const requested = configuredScope(tracker, 'rules', [...scope.includes, {scope:'all',path:'added'}]);
            tracker.captureConfiguredExpansionBaselines = async () => {
                const committed = activeNativeWatcher(nativeDirectoryWatchers, child);
                if (failure === 'error') { committed.error(Object.assign(new Error('live committed owner failed'), {code:'EIO'})); }
                else { committed.listener('change', undefined); }
                throw new Error('force candidate rollback');
            };
            const result = await tracker.applyConfiguredMonitoringScope(requested, false, () => true);
            assert.equal(result.status, 'failed');
            assert.equal(tracker.getEffectiveMonitoringScope().scopeRevision, scope.scopeRevision);
            assert.equal(tracker.getOriginalContent(target), 'before');
            assert.ok(tracker.getTrackedChanges().some(change => change.filePath === target));
            assert.ok(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === blind),
                'rollback must not erase a live committed coverage failure');
            const saved = JSON.parse(fs.readFileSync(path.join(tracker.storageUri.fsPath, 'session-state.json'), 'utf8'));
            assert.ok(saved.coverageGaps.some(([root, value]) => root === blind && value.subtree));
            const reviewed = tracker.getReviewToken(target);
            assert.ok(reviewed);
            fs.writeFileSync(target, 'unobserved later content');
            assert.equal((await tracker.keepAllChangesInFile(target, reviewed)).status, 'conflict');
            assert.equal((await tracker.revertFile(target, reviewed)).status, 'conflict');
            assert.equal(fs.readFileSync(target, 'utf8'), 'unobserved later content');
            assert.equal(tracker.getOriginalContent(target), 'before');
        }, 'rules'));
    }

    test('S4-B lifecycle failed Apply removes failed candidate owners too', () => fixture(async ({tracker,dir}) => {
        const {blind, scope} = await lifecycleFixture(tracker, dir);
        const candidate = path.join(dir, 'candidate-blind');
        fs.mkdirSync(candidate);
        fs.writeFileSync(path.join(candidate, 'new.txt'), 'new');
        // Keep the committed watcher requirement unchanged while preparing another target.
        setVsCodeExcludes({'files.watcherExclude': {'lifecycle-blind/**':true,'candidate-blind/**':true}});
        const requested = configuredScope(tracker, 'rules', [...scope.includes, {scope:'all',path:'candidate-blind'}]);
        tracker.captureConfiguredExpansionBaselines = async () => {
            activeNativeWatcher(nativeDirectoryWatchers, candidate).error(Object.assign(new Error('candidate failed'), {code:'EIO'}));
            throw new Error('force candidate rollback');
        };
        assert.equal((await tracker.applyConfiguredMonitoringScope(requested, false, () => true)).status, 'failed');
        assert.equal(tracker.supplementalDirectoryWatchers.has(candidate), false,
            'failed candidate entries cannot survive rollback as future restart obligations');
        assert.ok(activeNativeWatcher(nativeDirectoryWatchers, blind));
        assert.equal(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === candidate), false);
    }, 'rules'));


    for (const replacement of ['missing', 'same-path replacement']) {
        test(`S4-B lifecycle ${replacement} invalidates the old directory inode`, () => fixture(async ({tracker,dir}) => {
            const {blind, child, target} = await lifecycleFixture(tracker, dir);
            const owner = activeNativeWatcher(nativeDirectoryWatchers, child);
            fs.renameSync(child, path.join(blind, 'moved-child'));
            if (replacement === 'same-path replacement') {
                fs.mkdirSync(child);
                fs.writeFileSync(target, 'replacement contents');
            }
            owner.listener('rename', 'child');
            await settle(tracker);
            assert.ok(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === blind),
                'a named directory self-event cannot certify a handle bound to the old inode');
            assert.equal(owner.active, false);
            assert.equal(tracker.getOriginalContent(target), 'before');
            const before = tracker.getSubtreeCoverageGaps();
            owner.listener('change', undefined);
            assert.deepEqual(tracker.getSubtreeCoverageGaps(), before);
        }, 'rules'));
    }

    test('S4-B lifecycle reset repairs directory-change coverage through a bounded full scan', () => fixture(async ({tracker,dir}) => {
        const {blind} = await lifecycleFixture(tracker, dir);
        const added = path.join(blind, 'added');
        fs.mkdirSync(added);
        const target = path.join(added, 'new.txt');
        fs.writeFileSync(target, 'new baseline');
        h.setListedFiles([Uri.file(path.join(blind, 'child', 'tracked.txt')), Uri.file(target)]);
        activeNativeWatcher(nativeDirectoryWatchers, blind).listener('rename', 'added');
        await settle(tracker);
        assert.ok(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === blind));
        assert.equal(await tracker.resetBaselineToCurrentState(), true);
        assert.equal(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === blind), false);
        assert.equal(tracker.getOriginalContent(target), 'new baseline');
        assert.equal(tracker.supplementalDirectoryWatchers.get(added)?.epoch, tracker.sessionEpoch);
        const fresh = activeNativeWatcher(nativeDirectoryWatchers, added);
        assert.ok(fresh);
        fs.writeFileSync(target, 'new pending');
        fresh.listener('change', 'new.txt');
        await settle(tracker);
        assert.equal(tracker.getTrackedChanges().find(change => change.filePath === target)?.currentContent, 'new pending');
    }, 'rules'));

    for (const rollback of [false, true]) {
        test(`S4-B lifecycle reset retains failed handoff coverage (rollback=${rollback})`, () => fixture(async ({tracker,dir}) => {
            const {blind, child, target} = await lifecycleFixture(tracker, dir);
            fs.writeFileSync(target, 'pending before reset');
            activeNativeWatcher(nativeDirectoryWatchers, child).listener('change', 'tracked.txt');
            await settle(tracker);
            const originalWatch = fs.watch;
            const originalInitialize = tracker.initializeWorkspaceSnapshots;
            fs.watch = (directory, ...args) => {
                if (path.resolve(String(directory)) === child) { throw Object.assign(new Error('handoff capacity failure'), {code:'ENOSPC'}); }
                return originalWatch(directory, ...args);
            };
            if (rollback) { tracker.initializeWorkspaceSnapshots = async () => { throw new Error('forced reset rollback'); }; }
            try {
                assert.equal(await tracker.resetBaselineToCurrentState(), !rollback);
                assert.ok(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === blind));
                assert.equal(activeNativeWatcher(nativeDirectoryWatchers, child), undefined);
                if (rollback) {
                    assert.equal(tracker.getOriginalContent(target), 'before');
                    assert.ok(tracker.getTrackedChanges().some(change => change.filePath === target));
                }
                const saved = JSON.parse(fs.readFileSync(path.join(tracker.storageUri.fsPath, 'session-state.json'), 'utf8'));
                assert.ok(saved.coverageGaps.some(([root, value]) => root === blind && value.subtree));
            } finally {
                fs.watch = originalWatch;
                tracker.initializeWorkspaceSnapshots = originalInitialize;
            }
        }, 'rules'));
    }


    test('S4-B lifecycle stopped scope Apply installs no watchers until Start', () => fixture(async ({tracker,dir}) => {
        const {blind, child, target, scope} = await lifecycleFixture(tracker, dir);
        const old = activeNativeWatcher(nativeDirectoryWatchers, child);
        tracker.stopRecording();
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope, false, () => true)).status, 'applied');
        assert.equal(nativeDirectoryWatchers.some(owner => owner.active), false);
        const gaps = tracker.getSubtreeCoverageGaps();
        old.listener('change', undefined);
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), gaps);
        tracker.startRecording();
        await h.waitUntil(() => tracker.getBaselineState() === 'ready');
        const fresh = activeNativeWatcher(nativeDirectoryWatchers, child);
        assert.ok(fresh && fresh !== old);
        fs.writeFileSync(target, 'after Start');
        fresh.listener('change', 'tracked.txt');
        await settle(tracker);
        assert.equal(tracker.getTrackedChanges().find(change => change.filePath === target)?.currentContent, 'after Start');
        assert.ok(tracker.supplementalCoverageRoots.has(blind));
    }, 'rules'));

    test('S4-B lifecycle restart installation failure preserves pending review and a durable gap', () => fixture(async ({tracker,dir}) => {
        const {blind, child, target} = await lifecycleFixture(tracker, dir);
        fs.writeFileSync(target, 'pending across restart');
        activeNativeWatcher(nativeDirectoryWatchers, child).listener('change', 'tracked.txt');
        await settle(tracker);
        assert.equal(await tracker.flushPendingPersistence(), true);
        const storage = tracker.storageUri;
        await tracker.dispose();
        const originalWatch = fs.watch;
        fs.watch = (directory, ...args) => {
            if (path.resolve(String(directory)) === child) { throw Object.assign(new Error('restart watcher capacity failure'), {code:'ENOSPC'}); }
            return originalWatch(directory, ...args);
        };
        try {
            const restarted = new DiffTracker(storage);
            setTracker(restarted);
            assert.equal(await restarted.restorePersistedState(), 'restored');
            assert.equal(restarted.getOriginalContent(target), 'before');
            assert.ok(restarted.getTrackedChanges().some(change => change.filePath === target));
            assert.ok(restarted.getSubtreeCoverageGaps().some(gap => gap.targetPath === blind));
            assert.equal(await restarted.flushPendingPersistence(), true);
            const saved = JSON.parse(fs.readFileSync(path.join(storage.fsPath, 'session-state.json'), 'utf8'));
            assert.ok(saved.coverageGaps.some(([root, value]) => root === blind && value.subtree));
        } finally { fs.watch = originalWatch; }
    }, 'rules'));


    test('S4-B lifecycle silent directory replacement becomes a durable identity gap', () => fixture(async ({tracker,dir}) => {
        const {blind, child, target} = await lifecycleFixture(tracker, dir);
        const owner = activeNativeWatcher(nativeDirectoryWatchers, child);
        fs.renameSync(child, path.join(blind, 'silent-moved-child'));
        fs.mkdirSync(child);
        fs.writeFileSync(target, 'silent replacement');
        // Windows can omit native self-rename notifications entirely. Do not
        // inject a callback or rely on an ancestor watcher in this regression.
        await h.waitUntil(() => tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === blind), 2500);
        assert.equal(owner.active, false);
        assert.equal(tracker.getOriginalContent(target), 'before');
        assert.equal(await tracker.flushPendingPersistence(), true);
        const saved = JSON.parse(fs.readFileSync(path.join(tracker.storageUri.fsPath, 'session-state.json'), 'utf8'));
        assert.ok(saved.coverageGaps.some(([root, value]) => root === blind && value.subtree?.reasonCode === 'supplemental-watcher-identity-gap'));
    }, 'rules'));

    for (const release of ['Stop', 'scope release']) {
        test(`S4-B lifecycle identity probes stop after ${release} without stale ledger writes`, () => fixture(async ({tracker,dir}) => {
            const {blind, child} = await lifecycleFixture(tracker, dir);
            if (release === 'Stop') { tracker.stopRecording(); }
            else { tracker.commitSupplementalCoverageTargets([]); }
            const before = tracker.getSubtreeCoverageGaps();
            fs.renameSync(child, path.join(blind, 'released-child'));
            const originalStat = fs.promises.lstat;
            let identityProbes = 0;
            fs.promises.lstat = (target, options, ...args) => {
                if (options?.bigint && (path.resolve(String(target)) === child || path.resolve(String(target)) === blind)) {
                    identityProbes++;
                }
                return originalStat(target, options, ...args);
            };
            try {
                await delay(1150);
                assert.equal(identityProbes, 0, 'released owners must not retain background identity work');
                assert.deepEqual(tracker.getSubtreeCoverageGaps(), before);
            } finally { fs.promises.lstat = originalStat; }
        }, 'rules'));
    }


    test('S4-B lifecycle identity sweep bounds concurrency and rejects late results after Stop', () => fixture(async ({tracker,dir}) => {
        const {blind} = await lifecycleFixture(tracker, dir);
        for (let index = 0; index < 12; index++) {
            const directory = path.join(blind, `probe-${index}`);
            fs.mkdirSync(directory);
            tracker.watchSupplementalDirectory(directory, blind, tracker.sessionEpoch);
        }
        const originalStat = fs.promises.lstat;
        let release;
        const held = new Promise(resolve => { release = resolve; });
        let probes = 0;
        fs.promises.lstat = async (target, options, ...args) => {
            if (options?.bigint && String(target).startsWith(blind)) {
                probes++;
                await held;
                throw Object.assign(new Error('late unavailable identity'), {code:'ENOENT'});
            }
            return originalStat(target, options, ...args);
        };
        try {
            await h.waitUntil(() => probes === 8, 2500);
            await delay(1100);
            assert.equal(probes, 8, 'a slow sweep must neither exceed eight in-flight reads nor overlap the next tick');
            tracker.stopRecording();
            const before = tracker.getSubtreeCoverageGaps();
            release();
            await h.waitUntil(() => !tracker.supplementalIdentitySweepRunning, 2500);
            assert.equal(probes, 8, 'cancelled queued owners must not begin more metadata I/O');
            assert.deepEqual(tracker.getSubtreeCoverageGaps(), before, 'awaited failures from an old epoch cannot publish');
            assert.equal(tracker.supplementalIdentityTimer, undefined);
        } finally {
            release();
            fs.promises.lstat = originalStat;
        }
    }, 'rules'));

}
