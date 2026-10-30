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

    test('Issue #39 deleted supplemental target retires only after committed exclusion and keeps review evidence', () => fixture(async ({tracker,dir,scope}) => {
        const blind = path.join(dir, '.aws');
        const pending = path.join(dir, 'pending.txt');
        const gitHead = path.join(dir, '.git', 'HEAD');
        fs.mkdirSync(blind);
        fs.mkdirSync(path.dirname(gitHead));
        fs.writeFileSync(gitHead, 'ref: refs/heads/main\n');
        fs.writeFileSync(pending, 'before');
        setVsCodeExcludes({'files.watcherExclude': {'.aws/**': true}});
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status, 'applied');
        const oldOwner = activeNativeWatcher(nativeDirectoryWatchers, blind);
        assert.ok(oldOwner);
        fs.writeFileSync(pending, 'pending');
        await tracker.onExternalFileChanged(Uri.file(pending));
        await h.waitUntil(() => tracker.getReviewToken(pending));
        fs.rmdirSync(blind);
        await tracker.onExternalFileDeleted(Uri.file(blind));
        assert.equal(oldOwner.active, false, 'confirmed deletion closes the dead native owner');
        assert.equal(tracker.getSubtreeCoverageGaps().find(gap => gap.targetPath === blind)?.reasonCode,
            'supplemental-watcher-target-missing-gap');
        const before = {
            snapshots: [...tracker.fileSnapshots], reviews: structuredClone(tracker.getTrackedChanges()),
            token: tracker.getReviewToken(pending), head: fs.readFileSync(gitHead, 'utf8')
        };
        const requested = configuredScope(tracker, 'wholeWorkspace', [], [{scope:'all', pattern:'/.aws/'}]);
        tracker.setPendingMonitoringScope(requested);
        assert.equal(tracker.getSubtreeCoverageGaps().length, 1, 'saved request alone is not effective exclusion');
        const commit = tracker.commitPreparedScopePersistence.bind(tracker);
        let preparing = 0;
        tracker.commitPreparedScopePersistence = async (...args) => {
            preparing++;
            assert.equal(tracker.getSubtreeCoverageGaps().length, 1, 'in-flight Apply still exposes committed coverage');
            assert.deepEqual(tracker.getEffectiveMonitoringScope().excludes, []);
            return commit(...args);
        };
        try {
            const result = await tracker.applyConfiguredMonitoringScope(requested);
            assert.equal(result.status, 'applied', JSON.stringify(result));
        } finally { tracker.commitPreparedScopePersistence = commit; }
        assert.equal(preparing, 1);
        assert.equal(tracker.isPathIgnored(Uri.file(blind), true), true, 'effective directory probe proves explicit exclusion');
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
        assert.deepEqual(tracker.getCoverageGaps(), []);
        assert.equal(tracker.supplementalCoverageRoots.has(blind), false);
        assert.deepEqual([...tracker.fileSnapshots], before.snapshots);
        assert.deepEqual(tracker.getTrackedChanges(), before.reviews);
        assert.deepEqual(tracker.getReviewToken(pending), before.token);
        assert.equal(fs.readFileSync(pending, 'utf8'), 'pending');
        assert.equal(fs.readFileSync(gitHead, 'utf8'), before.head);
        assert.ok(tracker.coverageGaps.get(blind)?.subtree, 'retirement preserves durable uncertainty');
        // Recreated path has a different inode. Apply may reinstall coverage,
        // but cannot certify the earlier unobserved interval.
        fs.mkdirSync(blind);
        fs.writeFileSync(path.join(blind, 'new.txt'), 'new incarnation');
        tracker.setPendingMonitoringScope(scope);
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status, 'applied');
        tracker.setPendingMonitoringScope(undefined);
        const freshOwner = activeNativeWatcher(nativeDirectoryWatchers, blind);
        assert.ok(freshOwner);
        assert.notEqual(freshOwner, oldOwner);
        assert.ok(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === blind));
        assert.equal((await tracker.recheckObservationCoverage()).status, 'rechecked');
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), [], 'only successful live reconciliation certifies the subtree');
        assert.equal(tracker.getOriginalContent(pending), 'before');
        assert.deepEqual(tracker.getReviewToken(pending), before.token);
    }));

    for (const outcome of ['failed', 'cancelled']) test(`Issue #39 ${outcome} Apply keeps supplemental diagnostics and owner`, () => fixture(async ({tracker,dir,scope}) => {
        const blind = path.join(dir, '.aws');
        fs.mkdirSync(blind);
        setVsCodeExcludes({'files.watcherExclude': {'.aws/**': true}});
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status, 'applied');
        const owner = activeNativeWatcher(nativeDirectoryWatchers, blind);
        // A recreated target can have live future observation and an unresolved
        // earlier deletion interval simultaneously.
        tracker.setSubtreeCoverageGap(blind, 'supplemental-watcher-target-missing-gap', 'Unreconciled deletion');
        const requested = configuredScope(tracker, 'wholeWorkspace', [], [{scope:'all', pattern:'/.aws/'}]);
        const commit = tracker.commitPreparedScopePersistence.bind(tracker);
        const capture = tracker.captureConfiguredExpansionBaselines.bind(tracker);
        let current = true;
        tracker.commitPreparedScopePersistence = async () => {
            assert.equal(tracker.getSubtreeCoverageGaps().length, 1);
            assert.equal(owner.active, true, 'committed owner survives candidate preparation');
            return false;
        };
        if (outcome === 'cancelled') {
            tracker.commitPreparedScopePersistence = commit;
            tracker.captureConfiguredExpansionBaselines = async (...args) => {
                const result = await capture(...args);
                current = false;
                return result;
            };
        }
        try {
            const result = await tracker.applyConfiguredMonitoringScope(requested, false, () => current);
            assert.equal(result.status, 'failed', JSON.stringify(result));
            assert.equal(tracker.getSubtreeCoverageGaps().length, 1);
            assert.deepEqual(tracker.getEffectiveMonitoringScope(), scope);
            assert.equal(owner.active, true);
            assert.equal(tracker.supplementalCoverageRoots.has(blind), true);
        } finally {
            tracker.commitPreparedScopePersistence = commit;
            tracker.captureConfiguredExpansionBaselines = capture;
        }
        assert.equal((await tracker.applyConfiguredMonitoringScope(requested)).status, 'applied');
        assert.equal(owner.active, false, 'successful scope retirement releases the live owner');
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
    }));

    test('Issue #39 root-specific exclusion releases only its own overlapping coverage owner', () => fixture(async ({tracker,dir,folder}) => {
        const outer = path.join(dir, '.aws');
        const nestedRoot = path.join(outer, 'workspace');
        const inner = path.join(nestedRoot, '.aws');
        fs.mkdirSync(inner, {recursive:true});
        const nested = {uri:Uri.file(nestedRoot), name:'nested'};
        const {vscode} = h;
        const previousGet = vscode.workspace.getWorkspaceFolder;
        const previousConfig = vscode.workspace.getConfiguration;
        vscode.workspace.workspaceFolders = [folder, nested];
        vscode.workspace.getWorkspaceFolder = uri =>
            tracker.pathBelongsToRoot(uri.fsPath, nestedRoot) ? nested : previousGet(uri);
        vscode.workspace.getConfiguration = (section, resource) => {
            const config = previousConfig(section, resource);
            return {...config, get:(key, fallback) => key === 'files.watcherExclude'
                ? {'.aws/**':true} : config.get(key, fallback)};
        };
        try {
            tracker.sessionWorkspaceRoots = tracker.getWorkspaceRoots();
            tracker.effectiveMonitoringScope = configuredScope(tracker, 'rules');
            const included = configuredScope(tracker, 'wholeWorkspace');
            assert.equal((await tracker.applyConfiguredMonitoringScope(included)).status, 'applied');
            const outerOwner = activeNativeWatcher(nativeDirectoryWatchers, outer);
            const innerOwner = activeNativeWatcher(nativeDirectoryWatchers, inner);
            assert.ok(outerOwner);
            assert.ok(innerOwner);
            // The same relative missing-root uncertainty belongs to two distinct
            // workspace identities, despite their physical containment.
            for (const target of [outer, inner]) {
                tracker.setSubtreeCoverageGap(target, 'supplemental-watcher-target-missing-gap', 'Earlier deletion interval');
            }
            const excluded = configuredScope(tracker, 'wholeWorkspace', [], [
                {scope:'folder', folder:folder.name, pattern:'/.aws/'}
            ]);
            assert.equal((await tracker.applyConfiguredMonitoringScope(excluded)).status, 'applied');
            assert.deepEqual(tracker.getSubtreeCoverageGaps().map(gap => gap.targetPath), [inner]);
            assert.deepEqual(tracker.getCoverageGaps().map(([target]) => target), [inner]);
            assert.equal(outerOwner.active, false);
            assert.equal(innerOwner.active, true, 'nested root keeps its legitimate direct watcher');
            assert.deepEqual([...tracker.supplementalCoverageRoots], [inner]);
            assert.ok(tracker.coverageGaps.has(outer));
        } finally {
            vscode.workspace.getWorkspaceFolder = previousGet;
            vscode.workspace.getConfiguration = previousConfig;
        }
    }));

    for (const mode of ['rules', 'wholeWorkspace']) test(`S4-B nested workspace ${mode} retains independent observation and review baselines`, () => fixture(async ({tracker,dir,folder}) => {
        const outer = path.join(dir, 'vendor');
        const nestedRoot = path.join(outer, 'pkg');
        const inner = path.join(nestedRoot, 'src');
        fs.mkdirSync(inner, {recursive:true});
        const outerFile = path.join(outer, 'outer.txt');
        const innerFile = path.join(inner, 'inner.txt');
        fs.writeFileSync(outerFile, 'outer before');
        fs.writeFileSync(innerFile, 'inner before');
        const nested = {uri:Uri.file(nestedRoot), name:'nested'};
        const {vscode} = h;
        const previousGet = vscode.workspace.getWorkspaceFolder;
        const previousConfig = vscode.workspace.getConfiguration;
        let innerExcludes = {'src/**':true};
        vscode.workspace.workspaceFolders = [folder, nested];
        vscode.workspace.getWorkspaceFolder = uri =>
            tracker.pathBelongsToRoot(uri.fsPath, nestedRoot) ? nested : previousGet(uri);
        vscode.workspace.getConfiguration = (section, resource) => {
            const config = previousConfig(section, resource);
            return {...config, get:(key, fallback) => key === 'files.watcherExclude'
                ? resource && tracker.pathBelongsToRoot(resource.fsPath, nestedRoot)
                    ? innerExcludes : {'vendor/**':true}
                : config.get(key, fallback)};
        };
        try {
            tracker.sessionWorkspaceRoots = tracker.getWorkspaceRoots();
            tracker.effectiveMonitoringScope = configuredScope(tracker, 'rules');
            tracker.maxImportedDirectoryWatchers = 2;
            const requested = configuredScope(tracker, mode, [
                {scope:'folder', folder:nested.name, path:'src'},
                {scope:'folder', folder:folder.name, path:'vendor'}
            ]);
            const result = await tracker.applyConfiguredMonitoringScope(requested, false, () => true);
            assert.equal(result.status, 'applied', JSON.stringify(result));
            assert.equal(tracker.getOriginalContent(innerFile), 'inner before');
            assert.equal(tracker.getSubtreeCoverageGaps().length, 0);
            fs.writeFileSync(outerFile, 'outer after');
            fs.writeFileSync(innerFile, 'inner after');
            // No host event is supplied: each non-recursive native owner can
            // report only its direct child, never an inner workspace descendant.
            activeNativeWatcher(nativeDirectoryWatchers, outer)?.listener('change', 'outer.txt');
            activeNativeWatcher(nativeDirectoryWatchers, inner)?.listener('change', 'inner.txt');
            await settle(tracker);
            const changes = new Map(tracker.getTrackedChanges().map(change => [change.filePath, change]));
            assert.equal(changes.get(innerFile)?.currentContent, 'inner after',
                'a ready baseline must not silently miss the nested host-excluded edit');
            assert.equal(changes.get(outerFile)?.currentContent, 'outer after');
            assert.equal(tracker.getOriginalContent(innerFile), 'inner before');
            assert.equal(tracker.getOriginalContent(outerFile), 'outer before');
            assert.deepEqual([...tracker.supplementalCoverageRoots], [outer, inner]);
            assert.equal(tracker.supplementalDirectoryWatchers.has(nestedRoot), false,
                'outer traversal still stops at the nested workspace root');

            innerExcludes = {};
            fireConfigurationChanged('files.watcherExclude');
            assert.deepEqual([...tracker.supplementalCoverageRoots], [outer]);
            assert.equal(activeNativeWatcher(nativeDirectoryWatchers, inner), undefined,
                'removing inner coverage must release its owner even while the outer target remains');
            assert.equal(tracker.supplementalDirectoryWatchers.has(inner), false);
            assert.ok(activeNativeWatcher(nativeDirectoryWatchers, outer));
            assert.equal(tracker.getOriginalContent(innerFile), 'inner before');
            assert.equal(tracker.getSubtreeCoverageGaps().length, 0);
        } finally {
            vscode.workspace.getConfiguration = previousConfig;
            vscode.workspace.getWorkspaceFolder = previousGet;
        }
    }, 'rules'));

    test('S4-B P2 concrete excluded parent keeps a narrow directory include within its own budget', () => fixture(async ({tracker,dir}) => {
        const excluded = path.join(dir, 'node_modules');
        const included = path.join(excluded, 'included-package');
        fs.mkdirSync(included, {recursive:true});
        const target = path.join(included, 'tracked.txt');
        fs.writeFileSync(target, 'before');
        for (let index = 0; index < 4; index++) {
            fs.mkdirSync(path.join(excluded, `sibling-${index}`));
        }
        tracker.maxImportedDirectoryWatchers = 1;
        setVsCodeExcludes({'files.watcherExclude': {'node_modules/**':true}});
        tracker.effectiveMonitoringScope = configuredScope(tracker, 'rules');
        const requested = configuredScope(tracker, 'rules', [{scope:'all',path:'node_modules/included-package'}]);
        assert.equal((await tracker.applyConfiguredMonitoringScope(requested, false, () => true)).status, 'applied');
        assert.deepEqual([...tracker.supplementalCoverageRoots], [included]);
        assert.deepEqual([...tracker.supplementalDirectoryWatchers.keys()], [included]);
        assert.equal(nativeDirectoryWatchers.some(owner => path.resolve(String(owner.directory)) === excluded), false);
        assert.equal(tracker.getSubtreeCoverageGaps().length, 0);
        const owner = activeNativeWatcher(nativeDirectoryWatchers, included);
        assert.ok(owner);
        fs.writeFileSync(target, 'after');
        owner.listener('change', 'tracked.txt');
        await settle(tracker);
        assert.equal(tracker.getTrackedChanges().find(change => change.filePath === target)?.currentContent, 'after');
    }, 'rules'));

    for (const include of ['node_modules/pkg/file.js', 'node_modules/missing']) {
        test(`S4-B P2 concrete exclusion cannot promote unsupported include ${include}`, () => fixture(async ({tracker,dir}) => {
            fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), {recursive:true});
            fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'file.js'), 'before');
            setVsCodeExcludes({'files.watcherExclude': {'node_modules/**':true}});
            const before = configuredScope(tracker, 'rules');
            tracker.effectiveMonitoringScope = before;
            const requested = configuredScope(tracker, 'rules', [{scope:'all',path:include}]);
            assert.equal((await tracker.applyConfiguredMonitoringScope(requested, false, () => true)).status, 'requiresS4');
            assert.equal(tracker.getEffectiveMonitoringScope().scopeRevision, before.scopeRevision);
            assert.equal(nativeDirectoryWatchers.length, 0, 'an excluded parent is not an include directory witness');
        }, 'rules'));
    }

    test('S4-B P2 broad directory include retains the narrower concrete excluded subtree', () => fixture(async ({tracker,dir}) => {
        const included = path.join(dir, 'included');
        const excluded = path.join(included, 'blind');
        fs.mkdirSync(excluded, {recursive:true});
        fs.mkdirSync(path.join(included, 'visible-sibling'));
        fs.writeFileSync(path.join(excluded, 'tracked.txt'), 'before');
        tracker.maxImportedDirectoryWatchers = 1;
        setVsCodeExcludes({'files.watcherExclude': {'included/blind/**':true}});
        tracker.effectiveMonitoringScope = configuredScope(tracker, 'rules');
        const requested = configuredScope(tracker, 'rules', [{scope:'all',path:'included'}]);
        assert.equal((await tracker.applyConfiguredMonitoringScope(requested, false, () => true)).status, 'applied');
        assert.deepEqual([...tracker.supplementalCoverageRoots], [excluded]);
        assert.deepEqual([...tracker.supplementalDirectoryWatchers.keys()], [excluded]);
        assert.equal(tracker.getSubtreeCoverageGaps().length, 0);
    }, 'rules'));

    for (const [oldRoot, newRoot] of [['old', 'next'], ['old', 'old/child'], ['old/child', 'old']]) {
        test(`S4-B P2 stopped watcher policy ${oldRoot} to ${newRoot} releases obsolete owners before Start`, () => fixture(async ({tracker,dir}) => {
            for (const name of ['old/child', 'next/child']) {
                fs.mkdirSync(path.join(dir, name), {recursive:true});
            }
            const next = path.join(dir, newRoot);
            const changed = path.join(next, 'changed.txt');
            const deleted = path.join(next, 'deleted.txt');
            fs.writeFileSync(changed, 'before');
            fs.writeFileSync(deleted, 'before-delete');
            tracker.maxImportedDirectoryWatchers = 2;
            setVsCodeExcludes({'files.watcherExclude': {[`${oldRoot}/**`]:true}});
            tracker.effectiveMonitoringScope = configuredScope(tracker, 'rules');
            const requested = configuredScope(tracker, 'rules', [{scope:'all',path:'next'}, {scope:'all',path:'old'}]);
            const applied = await tracker.applyConfiguredMonitoringScope(requested, false, () => true);
            assert.equal(applied.status, 'applied', JSON.stringify(applied));
            const oldOwners = [...nativeDirectoryWatchers];
            tracker.stopRecording();
            setVsCodeExcludes({'files.watcherExclude': {[`${newRoot}/**`]:true}});
            fireConfigurationChanged('files.watcherExclude');
            const beforeStart = nativeDirectoryWatchers.length;
            h.setListedFiles([Uri.file(changed), Uri.file(deleted)]);
            tracker.startRecording();
            await h.waitUntil(() => tracker.getBaselineState() === 'ready');
            assert.deepEqual(tracker.getSubtreeCoverageGaps(), [],
                'the final target fits the shared budget: ' + JSON.stringify(tracker.getSubtreeCoverageGaps()));
            assert.equal(nativeDirectoryWatchers.slice(beforeStart).some(owner =>
                !tracker.pathBelongsToRoot(path.resolve(String(owner.directory)), next)), false,
            'obsolete directories must never be rebound during Start');
            assert.deepEqual([...tracker.supplementalCoverageRoots], [next]);
            assert.ok([...tracker.supplementalDirectoryWatchers.values()].every(entry => entry.coverageRoot === next));
            assert.equal(tracker.getSubtreeCoverageGaps().length, 0,
                'the final target fits the shared budget and must not retain an artificial capacity or ownership gap');
            const owner = activeNativeWatcher(nativeDirectoryWatchers, next);
            assert.ok(owner, 'current target must be watched after Start');
            assert.ok(oldOwners.every(entry => !entry.active));
            for (const old of oldOwners) { old.listener('change', undefined); }
            assert.equal(tracker.getSubtreeCoverageGaps().length, 0, 'stale callbacks cannot damage current coverage');
            fs.writeFileSync(changed, 'after');
            owner.listener('change', 'changed.txt');
            const created = path.join(next, 'created.txt');
            fs.writeFileSync(created, 'created');
            owner.listener('rename', 'created.txt');
            fs.unlinkSync(deleted);
            owner.listener('rename', 'deleted.txt');
            await settle(tracker);
            const changes = new Map(tracker.getTrackedChanges().map(change => [change.filePath, change]));
            assert.equal(changes.get(changed)?.currentContent, 'after');
            assert.equal(changes.get(created)?.baselineExists, false);
            assert.equal(changes.get(deleted)?.isDeleted, true);
            assert.equal(await tracker.flushPendingPersistence(), true);
        }, 'rules'));
    }

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
                    assert.ok(tracker.getSubtreeCoverageGaps().some(gap=>gap.targetPath===path.resolve(child)),
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

    test('Issue #55 native directory rename is an observation without child creation provenance', () => fixture(async ({tracker,dir}) => {
        const {blind, child, target} = await lifecycleFixture(tracker, dir);
        const unseen = path.join(child, 'unproven.txt');
        fs.writeFileSync(unseen, 'no child creation event');
        const parent = activeNativeWatcher(nativeDirectoryWatchers, blind);
        parent.listener('rename', 'child');
        await settle(tracker);
        await h.waitUntil(() => tracker.directoryObservations.size === 0);
        assert.equal(tracker.getTrackedChange(unseen)?.reviewKind, 'unknown');
        assert.equal(tracker.getOriginalContent(unseen), undefined);
        assert.equal(tracker.getOriginalContent(target), 'before');
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
        for (let i = 0; i < 20; i++) { parent.listener(i % 2 ? 'change' : 'rename', 'child'); }
        await settle(tracker);
        assert.equal(tracker.getOriginalContent(unseen), undefined);
        fs.writeFileSync(target, 'observed after native burst');
        activeNativeWatcher(nativeDirectoryWatchers, child).listener('change', 'tracked.txt');
        await settle(tracker);
        assert.equal(tracker.getTrackedChange(target)?.currentContent, 'observed after native burst');
    }, 'rules'));

    test('Issue #55 runtime create and native notifications share bounded work without losing exact creation provenance', () => fixture(async ({tracker,dir}) => {
        const {blind, child, target} = await lifecycleFixture(tracker, dir);
        const first = path.join(blind, 'first');
        const second = path.join(blind, 'second');
        fs.mkdirSync(first); fs.mkdirSync(second);
        const a = path.join(first, 'a.txt'), b = path.join(second, 'b.txt');
        const unknown = path.join(child, 'unknown.txt');
        fs.writeFileSync(a, 'created a'); fs.writeFileSync(b, 'created b'); fs.writeFileSync(unknown, 'unproven');
        const gate = h.pause(a, 'read');
        tracker.dispatchExternalEvent(Uri.file(first), 'create', tracker.sessionEpoch);
        try {
            await gate.entered;
            for (let i = 0; i < 20; i++) {
                tracker.dispatchExternalEvent(Uri.file(second), 'create', tracker.sessionEpoch);
                activeNativeWatcher(nativeDirectoryWatchers, blind).listener('rename', 'child');
            }
        } finally { gate.release(); }
        await settle(tracker);
        await h.waitUntil(() => tracker.directoryObservations.size === 0);
        assert.equal(tracker.getOriginalContent(a), '');
        assert.equal(tracker.getOriginalContent(b), '');
        assert.equal(tracker.getTrackedChange(unknown)?.reviewKind, 'unknown');
        assert.equal(tracker.getOriginalContent(target), 'before');
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
        fs.writeFileSync(b, 'later b');
        activeNativeWatcher(nativeDirectoryWatchers, second).listener('change', 'b.txt');
        await settle(tracker);
        assert.equal(tracker.getTrackedChange(b)?.currentContent, 'later b');
    }, 'rules'));

    test('Issue #55 reverse-ordered parent and child create events coalesce before independent owner installation', () => fixture(async ({tracker,dir}) => {
        const parent = path.join(dir, 'created-parent'), child = path.join(parent, 'deep');
        fs.mkdirSync(child, {recursive:true});
        const target = path.join(child, 'created.txt'); fs.writeFileSync(target, 'new child');
        tracker.dispatchExternalEvent(Uri.file(child), 'create', tracker.sessionEpoch);
        tracker.dispatchExternalEvent(Uri.file(parent), 'create', tracker.sessionEpoch);
        await settle(tracker);
        await h.waitUntil(() => tracker.directoryObservations.size === 0);
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
        assert.equal(tracker.getOriginalContent(target), '');
        assert.equal(tracker.importedDirectoryWatchers.size, 0);
        assert.ok(nativeDirectoryWatchers.filter(owner => owner.active).length <= 2);
        fs.writeFileSync(target, 'later child');
        activeNativeWatcher(nativeDirectoryWatchers, child).listener('change', 'created.txt'); await settle(tracker);
        assert.equal(tracker.getTrackedChange(target)?.currentContent, 'later child');
    }));

    test('Issue #55 a file event during directory verification gets a bounded follow-up with the original baseline', () => fixture(async ({tracker,dir}) => {
        const {blind, child, target} = await lifecycleFixture(tracker, dir);
        const owner = activeNativeWatcher(nativeDirectoryWatchers, child);
        const gate = h.pause(target, 'read');
        activeNativeWatcher(nativeDirectoryWatchers, blind).listener('change', 'child');
        try {
            await gate.entered;
            fs.writeFileSync(target, 'written during verification');
            owner.listener('change', 'tracked.txt');
        } finally { gate.release(); }
        await settle(tracker);
        await h.waitUntil(() => tracker.directoryObservations.size === 0);
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
        assert.equal(tracker.getOriginalContent(target), 'before');
        assert.equal(tracker.getTrackedChange(target)?.currentContent, 'written during verification');
        fs.writeFileSync(target, 'later event');
        activeNativeWatcher(nativeDirectoryWatchers, child).listener('change', 'tracked.txt'); await settle(tracker);
        assert.equal(tracker.getTrackedChange(target)?.currentContent, 'later event');
    }, 'rules'));

    test('Issue #55 continuous native activity leaves a bounded gap and can recover on the next settled notification', () => fixture(async ({tracker,dir}) => {
        const {blind, child, target} = await lifecycleFixture(tracker, dir);
        const opendir = fs.promises.opendir;
        let inspections = 0;
        fs.promises.opendir = async (directory, ...args) => {
            const result = await opendir(directory, ...args);
            if (String(directory) === child) {
                inspections++;
                fs.writeFileSync(target, `busy write ${inspections}`);
                activeNativeWatcher(nativeDirectoryWatchers, child).listener('change', 'tracked.txt');
            }
            return result;
        };
        try { await tracker.onExternalFileChanged(Uri.file(child)); }
        finally { fs.promises.opendir = opendir; }
        assert.ok(inspections > 0 && inspections < 24, 'continuous activity cannot produce unlimited scans');
        assert.equal(tracker.directoryObservations.size, 0);
        assert.ok(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === child));
        assert.equal(tracker.getOriginalContent(target), 'before');
        activeNativeWatcher(nativeDirectoryWatchers, blind).listener('change', 'child'); await settle(tracker);
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
        fs.writeFileSync(target, 'stable later edit');
        activeNativeWatcher(nativeDirectoryWatchers, child).listener('change', 'tracked.txt'); await settle(tracker);
        assert.equal(tracker.getTrackedChange(target)?.currentContent, 'stable later edit');
    }, 'rules'));

    test('Issue #55 identity replacement during verification remains unverified until a fresh owned handoff', () => fixture(async ({tracker,dir}) => {
        const {blind, child, target} = await lifecycleFixture(tracker, dir);
        const gate = h.pause(target, 'read');
        activeNativeWatcher(nativeDirectoryWatchers, blind).listener('change', 'child');
        try {
            await gate.entered;
            fs.renameSync(child, path.join(dir, 'previous-incarnation'));
            fs.mkdirSync(child); fs.writeFileSync(target, 'new incarnation');
        } finally { gate.release(); }
        await settle(tracker);
        assert.ok(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === child));
        assert.equal(tracker.getOriginalContent(target), 'before');
        activeNativeWatcher(nativeDirectoryWatchers, blind).listener('rename', 'child'); await settle(tracker);
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
        assert.equal(tracker.getTrackedChange(target)?.currentContent, 'new incarnation');
        fs.writeFileSync(target, 'next incarnation edit');
        activeNativeWatcher(nativeDirectoryWatchers, child).listener('change', 'tracked.txt'); await settle(tracker);
        assert.equal(tracker.getTrackedChange(target)?.currentContent, 'next incarnation edit');
    }, 'rules'));

    for (const kind of ['change', 'rename']) test(`Issue #55 parent-only ${kind} rebinds a replaced directory without accepting its files`, () => fixture(async ({tracker,dir}) => {
        const {blind, child, target} = await lifecycleFixture(tracker, dir);
        const oldOwner = activeNativeWatcher(nativeDirectoryWatchers, child);
        fs.renameSync(child, path.join(dir, 'old-incarnation'));
        fs.mkdirSync(child);
        fs.writeFileSync(target, 'replacement bytes');
        const unknown = path.join(child, 'unknown.txt');
        fs.writeFileSync(unknown, 'replacement without creation provenance');
        activeNativeWatcher(nativeDirectoryWatchers, blind).listener(kind, 'child');
        await settle(tracker);
        await h.waitUntil(() => tracker.directoryObservations.size === 0);
        const owner = activeNativeWatcher(nativeDirectoryWatchers, child);
        assert.ok(owner && owner !== oldOwner);
        assert.equal(oldOwner.active, false);
        assert.equal(tracker.getOriginalContent(target), 'before');
        assert.equal(tracker.getTrackedChange(target)?.currentContent, 'replacement bytes');
        assert.equal(tracker.getTrackedChange(unknown)?.reviewKind, 'unknown');
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
        oldOwner.listener('change', undefined);
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), [], 'stale native callbacks cannot invalidate the new owner');
        fs.writeFileSync(target, 'observed replacement edit');
        owner.listener('change', 'tracked.txt');
        await settle(tracker);
        assert.equal(tracker.getTrackedChange(target)?.currentContent, 'observed replacement edit');
    }, 'rules'));

    test('Issue #55 exclusion completes the gap Apply Recheck chain while retaining independent evidence', () => fixture(async ({tracker,dir}) => {
        const {blind, child, target, scope} = await lifecycleFixture(tracker, dir);
        const broken = path.join(dir, 'other-blind'); fs.mkdirSync(broken);
        setVsCodeExcludes({'files.watcherExclude': {'lifecycle-blind/**':true,'other-blind/**':true}});
        const included = configuredScope(tracker, scope.mode, [...scope.includes, {scope:'all',path:'other-blind'}]);
        assert.equal((await tracker.applyConfiguredMonitoringScope(included)).status, 'applied');
        const pending = path.join(blind, 'pending.txt'); fs.writeFileSync(pending, 'original');
        await tracker.onExternalFileCreated(Uri.file(pending));
        assert.equal((await tracker.keepAllChangesInFile(pending)).status, 'success');
        fs.writeFileSync(pending, 'pending review');
        await tracker.onExternalFileChanged(Uri.file(pending)); await settle(tracker);
        const token = tracker.getReviewToken(pending);
        const unknown = path.join(blind, 'unknown.txt'); fs.writeFileSync(unknown, 'unknown original');
        tracker.recordUnresolvedBaseline(unknown, 'Original before-image is unknown');
        const history = structuredClone(tracker.revertHistory);
        h.vscode.workspace.textDocuments.push({uri:Uri.file(target),isDirty:true});
        try {
            activeNativeWatcher(nativeDirectoryWatchers, blind).listener('change', 'child');
            await settle(tracker);
        } finally { h.vscode.workspace.textDocuments.pop(); }
        assert.equal(tracker.getSubtreeCoverageGaps().find(gap => gap.targetPath === child)?.reasonCode,
            'supplemental-watcher-directory-change-gap');
        activeNativeWatcher(nativeDirectoryWatchers, broken).error(Object.assign(new Error('Independent native failure'), {code:'EIO'}));
        const excluded = configuredScope(tracker, scope.mode, included.includes,
            [{scope:'all',pattern:'/lifecycle-blind/child/'}]);
        tracker.setPendingMonitoringScope(excluded);
        assert.equal((await tracker.applyConfiguredMonitoringScope(excluded, true)).status, 'applied');
        tracker.setPendingMonitoringScope(undefined);
        const afterApply = tracker.getSubtreeCoverageGaps().map(gap => path.relative(dir, gap.targetPath));
        const childOwnerAfterApply = activeNativeWatcher(nativeDirectoryWatchers, child);
        const evidence = tracker.coverageGaps.get(child)?.subtree;
        // Recheck must not hide the independent real failure or claim to have
        // scanned the excluded subtree. Capture the complete chain before its
        // assertion so a baseline failure distinguishes Apply from Recheck.
        activeNativeWatcher(nativeDirectoryWatchers, broken).error(Object.assign(new Error('Independent native failure'), {code:'EIO'}));
        const watch = fs.watch;
        fs.watch = (directory, ...args) => {
            if (path.resolve(String(directory)) === broken) { throw Object.assign(new Error('Independent native failure'), {code:'EIO'}); }
            return watch(directory, ...args);
        };
        try { assert.equal((await tracker.recheckObservationCoverage()).status, 'limited'); }
        finally { fs.watch = watch; }
        const afterRecheck = tracker.getSubtreeCoverageGaps().map(gap => path.relative(dir, gap.targetPath));
        assert.deepEqual({afterApply, afterRecheck}, {afterApply:['other-blind'], afterRecheck:['other-blind']});
        assert.equal(childOwnerAfterApply, undefined, 'a retained parent root cannot retain an excluded child owner');
        assert.ok(evidence);
        assert.equal(tracker.coverageGaps.get(child)?.subtree, evidence, 'unscanned excluded evidence stays durable');
        assert.deepEqual(tracker.getReviewToken(pending), token);
        assert.equal(tracker.getOriginalContent(pending), 'original');
        assert.equal(tracker.getOriginalContent(unknown), undefined);
        assert.equal(tracker.getTrackedChange(unknown)?.reviewKind, 'unknown');
        assert.deepEqual(tracker.revertHistory, history);
        assert.equal(fs.readFileSync(pending, 'utf8'), 'pending review');
        assert.equal(await tracker.flushPendingPersistence(), true);
        const saved = JSON.parse(fs.readFileSync(path.join(tracker.storageUri.fsPath, 'session-state.json'), 'utf8'));
        assert.ok(saved.coverageGaps.some(([directory, record]) => directory === child && record.subtree));
        fs.writeFileSync(pending, 'continued sibling edit');
        activeNativeWatcher(nativeDirectoryWatchers, blind).listener('change', 'pending.txt');
        await settle(tracker);
        assert.equal(tracker.getTrackedChange(pending)?.currentContent, 'continued sibling edit');
    }, 'rules'));

    test('Issue #55 excluded diagnostics use subtree ownership without blanket family retirement', () => fixture(async ({tracker,dir}) => {
        const {blind, child, scope} = await lifecycleFixture(tracker, dir);
        const codes = ['supplemental-watcher-directory-change-gap', 'supplemental-watcher-target-missing-gap',
            'supplemental-watcher-identity-gap', 'supplemental-watcher-runtime-gap',
            'supplemental-watcher-installation-gap', 'supplemental-watcher-capacity-gap',
            'supplemental-watcher-system-limit-gap', 'supplemental-watcher-preparation-gap',
            'supplemental-watcher-policy-change-gap', 'directory-runtime-coverage-gap',
            'directory-scan-coverage-gap', 'scope-preparation-event', 'legacy-directory-sentinel'];
        const evidence = new Map();
        for (const [index, code] of codes.entries()) {
            const directory = path.join(child, `nested-${index}`);
            fs.mkdirSync(directory);
            tracker.setSubtreeCoverageGap(directory, code, 'Unverified interval');
            evidence.set(directory, tracker.coverageGaps.get(directory).subtree);
        }
        tracker.setSubtreeCoverageGap(blind, 'supplemental-watcher-runtime-gap', 'Ancestor still protects monitored siblings');
        const future = path.join(child, 'future');
        tracker.setSubtreeCoverageGap(future, 'supplemental-watcher-future-control', 'Unclassified semantics must remain visible');
        const requested = configuredScope(tracker, scope.mode, scope.includes,
            [{scope:'all',pattern:'/lifecycle-blind/child/'}]);
        assert.equal((await tracker.applyConfiguredMonitoringScope(requested)).status, 'applied');
        const readDir = fs.readdirSync;
        let excludedEnumerations = 0;
        fs.readdirSync = (directory, ...args) => {
            if (tracker.pathBelongsToRoot(String(directory), child)) { excludedEnumerations++; }
            return readDir(directory, ...args);
        };
        try {
            assert.deepEqual(tracker.getSubtreeCoverageGaps().map(gap => gap.targetPath), [blind, future]);
            assert.deepEqual(tracker.getCoverageGaps().map(([directory]) => directory), [blind, future]);
            assert.equal(excludedEnumerations, 0, 'diagnostic projection must stop at the excluded ancestor');
        } finally { fs.readdirSync = readDir; }
        for (const [directory, record] of evidence) { assert.equal(tracker.coverageGaps.get(directory)?.subtree, record); }
        assert.equal(activeNativeWatcher(nativeDirectoryWatchers, child), undefined);
        assert.ok(activeNativeWatcher(nativeDirectoryWatchers, blind));
    }, 'rules'));

    test('Issue #55 excluded child notifications neither allocate owners nor replace dormant evidence', () => fixture(async ({tracker,dir}) => {
        const {blind, child, target, scope} = await lifecycleFixture(tracker, dir);
        const stale = activeNativeWatcher(nativeDirectoryWatchers, child);
        const sibling = path.join(blind, 'sibling.txt');
        fs.writeFileSync(sibling, 'original'); await tracker.onExternalFileCreated(Uri.file(sibling));
        assert.equal((await tracker.keepAllChangesInFile(sibling)).status, 'success');
        tracker.setSubtreeCoverageGap(child, 'supplemental-watcher-directory-change-gap', 'Prior excluded interval');
        const requested = configuredScope(tracker, scope.mode, scope.includes,
            [{scope:'all',pattern:'/lifecycle-blind/child/'}]);
        assert.equal((await tracker.applyConfiguredMonitoringScope(requested)).status, 'applied');
        const evidence = tracker.coverageGaps.get(child).subtree;
        const owners = nativeDirectoryWatchers.filter(owner => owner.active).length;
        fs.mkdirSync(path.join(child, 'new-directory'));
        const parent = activeNativeWatcher(nativeDirectoryWatchers, blind);
        for (const internal of ['.git', '.difftracker-restore-temporary']) {
            fs.mkdirSync(path.join(blind, internal));
            parent.listener('rename', internal);
        }
        for (let i = 0; i < 20; i++) {
            parent.listener(i % 2 ? 'change' : 'rename', 'child');
            stale.listener('rename', 'new-directory');
        }
        await settle(tracker);
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
        assert.equal(tracker.coverageGaps.get(child)?.subtree, evidence);
        assert.equal(nativeDirectoryWatchers.filter(owner => owner.active).length, owners);
        assert.equal(tracker.getOriginalContent(target), undefined);
        fs.writeFileSync(sibling, 'still observed'); parent.listener('change', 'sibling.txt');
        await settle(tracker);
        assert.equal(tracker.getTrackedChange(sibling)?.currentContent, 'still observed');
        parent.listener('rename', undefined);
        assert.equal(tracker.getSubtreeCoverageGaps().find(gap => gap.targetPath === blind)?.reasonCode,
            'supplemental-watcher-runtime-gap', 'excluded noise must not suppress an unnamed owner event');
    }, 'rules'));

    test('Issue #55 excluded file activity cannot invalidate its parent directory verification', () => fixture(async ({tracker,dir}) => {
        const {blind, child, target, scope} = await lifecycleFixture(tracker, dir);
        const excludedFile = path.join(blind, 'excluded.txt'); fs.writeFileSync(excludedFile, 'excluded');
        const requested = configuredScope(tracker, scope.mode, scope.includes,
            [{scope:'all',pattern:'/lifecycle-blind/excluded.txt'}]);
        assert.equal((await tracker.applyConfiguredMonitoringScope(requested)).status, 'applied');
        const open = fs.promises.opendir;
        fs.promises.opendir = async (directory, ...args) => {
            const result = await open(directory, ...args);
            if (String(directory) === blind) {
                fs.writeFileSync(excludedFile, 'excluded activity during every scan');
                activeNativeWatcher(nativeDirectoryWatchers, blind).listener('change', 'excluded.txt');
            }
            return result;
        };
        try { await tracker.onExternalFileChanged(Uri.file(blind)); }
        finally { fs.promises.opendir = open; }
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
        assert.equal(tracker.getOriginalContent(excludedFile), undefined);
        fs.writeFileSync(target, 'still observed');
        activeNativeWatcher(nativeDirectoryWatchers, child).listener('change', 'tracked.txt'); await settle(tracker);
        assert.equal(tracker.getTrackedChange(target)?.currentContent, 'still observed');
    }, 'rules'));

    test('Issue #55 excluded directory delete and recreate cannot dirty its parent verification', () => fixture(async ({tracker,dir}) => {
        const {blind,child,scope}=await lifecycleFixture(tracker,dir);
        const sibling=path.join(blind,'sibling.txt');fs.writeFileSync(sibling,'before');
        const excluded=configuredScope(tracker,scope.mode,scope.includes,[{scope:'all',pattern:'/lifecycle-blind/child/'}]);
        assert.equal((await tracker.applyConfiguredMonitoringScope(excluded,true)).status,'applied');
        const parent=activeNativeWatcher(nativeDirectoryWatchers,blind);
        const revision=tracker.supplementalDirectoryWatchers.get(blind).eventRevision??0;
        const prepare=tracker.prepareImportedCoverageHandoff;
        let excludedDeletes=0;
        tracker.prepareImportedCoverageHandoff=async function(...args){
            const result=await prepare.apply(this,args);
            if(excludedDeletes<2){
                excludedDeletes++;fs.rmSync(child,{recursive:true});parent.listener('rename','child');fs.mkdirSync(child);
            }
            return result;
        };
        try{
            await tracker.onExternalFileChanged(Uri.file(blind));
            assert.deepEqual(tracker.getSubtreeCoverageGaps(),[],'excluded churn must not consume both verification passes');
            await tracker.onExternalFileChanged(Uri.file(blind));
        }finally{tracker.prepareImportedCoverageHandoff=prepare;}
        assert.equal(excludedDeletes,2);
        assert.equal(tracker.directoryObservations.size,0);
        assert.deepEqual(tracker.getSubtreeCoverageGaps(),[]);
        assert.equal(tracker.supplementalDirectoryWatchers.get(blind).eventRevision??0,revision);
        assert.equal(tracker.getOriginalContent(sibling),'before');
        fs.writeFileSync(sibling,'after excluded churn');parent.listener('change','sibling.txt');await settle(tracker);
        assert.equal(tracker.getTrackedChange(sibling)?.currentContent,'after excluded churn');
        assert.equal(tracker.getOriginalContent(sibling),'before');
    },'rules'));

    test('Issue #55 a formerly excluded directory becoming a regular file remains observable', () => fixture(async ({tracker,dir}) => {
        const {blind,child,scope}=await lifecycleFixture(tracker,dir);
        const excluded=configuredScope(tracker,scope.mode,scope.includes,[{scope:'all',pattern:'/lifecycle-blind/child/'}]);
        assert.equal((await tracker.applyConfiguredMonitoringScope(excluded,true)).status,'applied');
        const parent=activeNativeWatcher(nativeDirectoryWatchers,blind);
        fs.rmSync(child,{recursive:true});parent.listener('rename','child');
        fs.writeFileSync(child,'replacement regular file');parent.listener('rename','child');await settle(tracker);
        assert.equal(tracker.getTrackedChange(child)?.currentContent,'replacement regular file');
        // This explicit test-user approval establishes the file before-image;
        // directory exclusion itself must never accept the replacement file.
        if(tracker.getTrackedChange(child)?.reviewKind==='unknown'){
            assert.equal((await tracker.resetUnknownBaseline(child)).status,'success');
        }else{assert.equal((await tracker.keepAllChangesInFile(child)).status,'success');}
        assert.equal(tracker.getOriginalContent(child),'replacement regular file');
        const revision=tracker.supplementalDirectoryWatchers.get(blind).eventRevision??0;
        fs.unlinkSync(child);parent.listener('rename','child');await settle(tracker);
        assert.ok((tracker.supplementalDirectoryWatchers.get(blind).eventRevision??0)>revision,'a known file deletion must be registered');
        assert.equal(tracker.getTrackedChange(child)?.isDeleted,true);
        assert.equal(tracker.getOriginalContent(child),'replacement regular file');
    },'rules'));

    test('Issue #55 excluded evidence stays dormant after Reload and reinclude gets a fresh baseline and live observation', () => fixture(async ({tracker,dir}) => {
        const {blind, child, target, scope} = await lifecycleFixture(tracker, dir);
        fs.writeFileSync(target, 'pending before exclusion');
        activeNativeWatcher(nativeDirectoryWatchers, child).listener('change', 'tracked.txt'); await settle(tracker);
        tracker.setSubtreeCoverageGap(child, 'supplemental-watcher-directory-change-gap', 'Earlier unverified interval');
        const excluded = configuredScope(tracker, scope.mode, scope.includes,
            [{scope:'all',pattern:'/lifecycle-blind/child/'}]);
        assert.equal((await tracker.applyConfiguredMonitoringScope(excluded, true)).status, 'applied');
        const storage = tracker.storageUri; await tracker.dispose();
        tracker = new DiffTracker(storage); setTracker(tracker);
        assert.equal(await tracker.restorePersistedState(), 'restored');
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
        assert.ok(tracker.coverageGaps.get(child)?.subtree);
        assert.equal(activeNativeWatcher(nativeDirectoryWatchers, child), undefined);
        fs.writeFileSync(target, 'changed while excluded');
        assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status, 'applied');
        assert.equal(tracker.getOriginalContent(target), 'changed while excluded');
        assert.equal(tracker.getTrackedChange(target), undefined, 'released review must not be resurrected');
        assert.equal((await tracker.recheckObservationCoverage()).status, 'rechecked');
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
        const owner = activeNativeWatcher(nativeDirectoryWatchers, child);
        assert.ok(owner);
        fs.writeFileSync(target, 'live edit after reinclude'); owner.listener('change', 'tracked.txt');
        await settle(tracker);
        assert.equal(tracker.getTrackedChange(target)?.currentContent, 'live edit after reinclude');
        assert.equal(tracker.getOriginalContent(target), 'changed while excluded');
        assert.ok(activeNativeWatcher(nativeDirectoryWatchers, blind));
    }, 'rules'));

    for (const relative of ['ignored', 'parent/ignored']) for (const stopped of [false, true])
    test(`Issue #55 Rules directory ignore skips ${relative} change before observation (stopped=${stopped})`, () => fixture(async ({tracker,dir}) => {
        const ignored = path.join(dir, relative);
        fs.mkdirSync(ignored, {recursive:true});
        const target = path.join(ignored, 'unobserved.txt');
        fs.writeFileSync(target, 'ignored current bytes');
        fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored/\n');
        await tracker.refreshIgnoreMatchers();
        assert.equal(tracker.isPathIgnored(Uri.file(ignored)), false, 'directory-only policy differs from a file probe');
        assert.equal(tracker.isPathIgnored(Uri.file(ignored), true), true);
        if (stopped) { tracker.stopRecording(); }
        const opendir = fs.promises.opendir;
        let ignoredEnumerations = 0;
        fs.promises.opendir = async (directory, ...args) => {
            if (tracker.pathBelongsToRoot(String(directory), ignored)) { ignoredEnumerations++; }
            return opendir(directory, ...args);
        };
        try {
            await tracker.onExternalFileChanged(Uri.file(ignored));
            assert.equal(ignoredEnumerations, 0, 'ignored subtrees must not be enumerated to verify an event');
            assert.equal(tracker.directoryObservations.size, 0);
            assert.equal(tracker.coverageGaps.has(ignored), false, 'ignored directory notifications create no observation obligation');
            assert.equal(activeNativeWatcher(nativeDirectoryWatchers, ignored), undefined);
            assert.equal(tracker.getTrackedChange(target), undefined);
            assert.equal(tracker.getOriginalContent(target), undefined);
            assert.equal(fs.readFileSync(target, 'utf8'), 'ignored current bytes');
            assert.equal(tracker.isRecording, !stopped);
        } finally { fs.promises.opendir = opendir; }
    }, 'rules'));

    test('Issue #55 Rules directory ignore preserves included parent and child observation', () => fixture(async ({tracker,dir}) => {
        const ignored = path.join(dir, 'ignored'), child = path.join(ignored, 'included');
        const excluded = path.join(ignored, 'other');
        fs.mkdirSync(child, {recursive:true}); fs.mkdirSync(excluded);
        const target = path.join(child, 'tracked.txt'); fs.writeFileSync(target, 'before');
        fs.writeFileSync(path.join(excluded, 'unobserved.txt'), 'ordinary ignored bytes');
        fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored/\n');
        const included = configuredScope(tracker, 'rules', [{scope:'all',path:'ignored/included'}],
            [{scope:'all',pattern:'/ignored/other/'}]);
        assert.equal((await tracker.applyConfiguredMonitoringScope(included)).status, 'applied');
        assert.equal(tracker.isPathIgnored(Uri.file(ignored), true), false, 'a traversable ancestor of an explicit include remains monitored');
        assert.equal(tracker.isPathIgnored(Uri.file(child), true), false, 'explicit include overrides ordinary directory ignore');
        const unseen = path.join(child, 'unseen.txt'); fs.writeFileSync(unseen, 'unknown history');
        const opendir = fs.promises.opendir;
        let excludedEnumerations = 0;
        fs.promises.opendir = async (directory, ...args) => {
            if (tracker.pathBelongsToRoot(String(directory), excluded)) { excludedEnumerations++; }
            return opendir(directory, ...args);
        };
        try {
            await tracker.onExternalFileChanged(Uri.file(ignored));
            await tracker.onExternalFileChanged(Uri.file(child));
            assert.equal(excludedEnumerations, 0);
            assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
            assert.equal(tracker.getTrackedChange(unseen)?.reviewKind, 'unknown');
            assert.equal(tracker.getOriginalContent(unseen), undefined);
            assert.equal(tracker.getOriginalContent(target), 'before');
            const owner = activeNativeWatcher(nativeDirectoryWatchers, child); assert.ok(owner);
            fs.writeFileSync(target, 'later observed edit'); owner.listener('change', 'tracked.txt');
            await settle(tracker);
            assert.equal(tracker.getTrackedChange(target)?.currentContent, 'later observed edit');
            assert.equal(tracker.getOriginalContent(target), 'before');
        } finally { fs.promises.opendir = opendir; }
    }, 'rules'));

    test('Issue #55 Rules directory ignore does not suppress a same-name ordinary file replacement', () => fixture(async ({tracker,dir}) => {
        const target = path.join(dir, 'ignored'); fs.mkdirSync(target);
        fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored/\n'); await tracker.refreshIgnoreMatchers();
        await tracker.onExternalFileChanged(Uri.file(target));
        fs.rmdirSync(target); fs.writeFileSync(target, 'replacement before');
        assert.equal(tracker.isPathIgnored(Uri.file(target)), false);
        assert.equal(tracker.recordScannedBaseline(target, await tracker.readFileSnapshot(Uri.file(target)), 'workspace'), true);
        fs.writeFileSync(target, 'replacement after'); await tracker.onExternalFileChanged(Uri.file(target));
        await settle(tracker);
        assert.equal(tracker.getOriginalContent(target), 'replacement before');
        assert.equal(tracker.getTrackedChange(target)?.currentContent, 'replacement after');
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
    }, 'rules'));

    test('Issue #55 directory change automatically reconciles without accepting unknown history', () => fixture(async ({tracker,dir}) => {
        const {blind, child, target} = await lifecycleFixture(tracker, dir);
        fs.writeFileSync(target, 'pending review');
        activeNativeWatcher(nativeDirectoryWatchers, child).listener('change', 'tracked.txt');
        await settle(tracker);
        const token = tracker.getReviewToken(target);
        assert.ok(token);
        const unseen = path.join(child, 'unseen.txt');
        fs.writeFileSync(unseen, 'no proven creation event');
        activeNativeWatcher(nativeDirectoryWatchers, blind).listener('change', 'child');
        await settle(tracker);
        assert.equal(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === child), false,
            'a directory change must finish its own observation reconciliation');
        assert.equal(tracker.getOriginalContent(target), 'before');
        assert.deepEqual(tracker.getReviewToken(target), token);
        assert.equal(tracker.getTrackedChange(unseen)?.reviewKind, 'unknown');
        assert.equal(tracker.getOriginalContent(unseen), undefined,
            'a directory notification is not evidence that all children were absent');
        const owner = activeNativeWatcher(nativeDirectoryWatchers, child);
        fs.writeFileSync(target, 'later observed edit');
        owner.listener('change', 'tracked.txt');
        await settle(tracker);
        assert.equal(tracker.getTrackedChange(target)?.currentContent, 'later observed edit');
        assert.equal(fs.readFileSync(unseen, 'utf8'), 'no proven creation event');
    }, 'rules'));

    test('Issue #55 repeated sibling directory changes share bounded reconciliation and retain real failures', () => fixture(async ({tracker,dir}) => {
        const {blind, child, target} = await lifecycleFixture(tracker, dir);
        const other = path.join(dir, 'other.txt');
        fs.writeFileSync(other, 'other original');
        await tracker.onExternalFileCreated(Uri.file(other));
        fs.writeFileSync(other, 'unrelated pending');
        await tracker.onExternalFileChanged(Uri.file(other));
        await settle(tracker);
        const token = tracker.getReviewToken(other);
        const gate = h.pause(target, 'read');
        const parent = activeNativeWatcher(nativeDirectoryWatchers, blind);
        parent.listener('change', 'child');
        try {
            await gate.entered;
            for (let i = 0; i < 40; i++) { parent.listener('change', 'child'); }
            const sibling = path.join(blind, 'sibling');
            fs.mkdirSync(sibling);
            fs.writeFileSync(path.join(sibling, 'unseen.txt'), 'unknown history');
            parent.listener('change', 'sibling');
        } finally { gate.release(); }
        await settle(tracker);
        await h.waitUntil(() => tracker.directoryObservations.size === 0);
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
        assert.equal(tracker.getOriginalContent(target), 'before');
        assert.deepEqual(tracker.getReviewToken(other), token);
        assert.equal(tracker.getTrackedChange(path.join(blind, 'sibling', 'unseen.txt'))?.reviewKind, 'unknown');
        assert.ok(nativeDirectoryWatchers.filter(owner => owner.active).length <= 3,
            'duplicate notifications must not leak temporary bridge owners');
        // A later runtime fault belongs to the ancestor, outside a child's
        // successful proof. Reconciliation must leave it visible and durable.
        activeNativeWatcher(nativeDirectoryWatchers, child).error(Object.assign(new Error('real native failure'), {code:'EIO'}));
        parent.listener('change', 'sibling');
        await settle(tracker);
        assert.ok(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === blind));
        assert.equal(await tracker.flushPendingPersistence(), true);
        const saved = JSON.parse(fs.readFileSync(path.join(tracker.storageUri.fsPath, 'session-state.json'), 'utf8'));
        assert.ok(saved.coverageGaps.some(([root, record]) => root === blind && record.subtree));
    }, 'rules'));

    for (const interruption of ['stop', 'pending', 'dirty']) test(`Issue #55 directory change respects ${interruption} during reconciliation`, () => fixture(async ({tracker,dir,scope}) => {
        const {blind, child, target} = await lifecycleFixture(tracker, dir);
        const parent = activeNativeWatcher(nativeDirectoryWatchers, blind);
        const gate = h.pause(target, 'read');
        parent.listener('change', 'child');
        try {
            await gate.entered;
            if (interruption === 'stop') { tracker.stopRecording(); }
            if (interruption === 'pending') {
                tracker.setPendingMonitoringScope(configuredScope(tracker, scope.mode, [], [{scope:'all',pattern:'/lifecycle-blind/'}]));
            }
            if (interruption === 'dirty') { h.vscode.workspace.textDocuments.push({uri:Uri.file(target),isDirty:true}); }
        } finally { gate.release(); }
        try {
            await settle(tracker);
            assert.ok(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === child));
            assert.equal(tracker.getOriginalContent(target), 'before');
            assert.equal(fs.readFileSync(target, 'utf8'), 'before');
            if (interruption === 'stop') { assert.equal(nativeDirectoryWatchers.some(owner => owner.active), false); }
        } finally { if (interruption === 'dirty') { h.vscode.workspace.textDocuments.pop(); } }
    }, 'rules'));

    test('Issue #55 directory observation budget exhaustion retains uncertainty and stops work', () => fixture(async ({tracker,dir}) => {
        const {blind, child, target} = await lifecycleFixture(tracker, dir);
        tracker.maxScopePreflightEntries = 1;
        activeNativeWatcher(nativeDirectoryWatchers, blind).listener('change', 'child');
        await settle(tracker);
        assert.equal(tracker.directoryObservations.size, 0);
        assert.ok(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === child));
        assert.equal(tracker.getOriginalContent(target), 'before');
        assert.equal(fs.readFileSync(target, 'utf8'), 'before');
    }, 'rules'));

    test('Issue #55 directory observation preserves pending control evidence', () => fixture(async ({tracker,dir}) => {
        const {child, target} = await lifecycleFixture(tracker, dir);
        tracker.setSubtreeCoverageGap(child, 'pending-scope-gap', 'Earlier scope pause requires control recovery');
        await tracker.onExternalFileChanged(Uri.file(child));
        assert.equal(tracker.getSubtreeCoverageGaps().find(gap => gap.targetPath === child)?.reasonCode, 'pending-scope-gap');
        assert.equal(tracker.getOriginalContent(target), 'before');
        assert.equal(fs.readFileSync(target, 'utf8'), 'before');
    }, 'rules'));

    test('Issue #55 failed observation persistence rolls back tentative discovery and keeps a gap', () => fixture(async ({tracker,dir}) => {
        const {child, target} = await lifecycleFixture(tracker, dir);
        const unseen = path.join(child, 'unseen.txt');
        fs.writeFileSync(unseen, 'unproven history');
        const write = h.vscode.workspace.fs.writeFile;
        h.vscode.workspace.fs.writeFile = async (uri, ...args) => {
            if (uri.fsPath === path.join(tracker.storageUri.fsPath, 'session-state.tmp.json')) {
                throw new Error('Injected observation persistence failure');
            }
            return write(uri, ...args);
        };
        try {
            await tracker.onExternalFileChanged(Uri.file(child));
            assert.equal(tracker.persistenceFailed, true);
            assert.equal(tracker.unresolvedBaselineFiles.has(unseen), false,
                'a failed durable publication must not leave tentative discovery in memory');
            assert.ok(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === child));
            assert.equal(tracker.getOriginalContent(target), 'before');
            assert.equal(fs.readFileSync(unseen, 'utf8'), 'unproven history');
        } finally { h.vscode.workspace.fs.writeFile = write; }
    }, 'rules'));

    test('Issue #55 automatic directory verification never enumerates an explicitly excluded child', () => fixture(async ({tracker,dir}) => {
        const {blind, child, target, scope} = await lifecycleFixture(tracker, dir);
        const excluded = path.join(child, 'private');
        fs.mkdirSync(excluded);
        fs.writeFileSync(path.join(excluded, 'secret.txt'), 'excluded content');
        const requested = configuredScope(tracker, scope.mode, scope.includes,
            [{scope:'all',pattern:'/lifecycle-blind/child/private/'}]);
        assert.equal((await tracker.applyConfiguredMonitoringScope(requested)).status, 'applied');
        tracker.setSubtreeCoverageGap(excluded, 'supplemental-watcher-directory-change-gap', 'Earlier excluded interval');
        const evidence = tracker.coverageGaps.get(excluded).subtree;
        const opendir = fs.promises.opendir;
        let excludedReads = 0;
        fs.promises.opendir = async (directory, ...args) => {
            if (tracker.pathBelongsToRoot(String(directory), excluded)) { excludedReads++; }
            return opendir(directory, ...args);
        };
        try {
            activeNativeWatcher(nativeDirectoryWatchers, blind).listener('change', 'child');
            await settle(tracker);
            await h.waitUntil(() => tracker.directoryObservations.size === 0);
            assert.equal(excludedReads, 0);
            assert.equal(tracker.coverageGaps.get(excluded)?.subtree, evidence,
                'unscanned excluded history must remain durable for a future re-include');
            assert.equal(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === child), false);
            fs.writeFileSync(target, 'still observed');
            activeNativeWatcher(nativeDirectoryWatchers, child).listener('change', 'tracked.txt');
            await settle(tracker);
            assert.equal(tracker.getTrackedChange(target)?.currentContent, 'still observed');
        } finally { fs.promises.opendir = opendir; }
    }, 'rules'));

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

    for (const failure of ['error', 'unnamed', 'directory']) {
        test(`S4-B lifecycle failed Apply retains committed ${failure} coverage evidence`, () => fixture(async ({tracker,dir}) => {
            const {blind, child, target, scope} = await lifecycleFixture(tracker, dir);
            fs.writeFileSync(target, 'pending before Apply');
            activeNativeWatcher(nativeDirectoryWatchers, child).listener('change', 'tracked.txt');
            await settle(tracker);
            const added = path.join(dir, 'added');
            fs.mkdirSync(added);
            fs.writeFileSync(path.join(added, 'new.txt'), 'new');
            const requested = configuredScope(tracker, 'rules', [...scope.includes, {scope:'all',path:'added'}]);
            const gapTarget = failure === 'directory' ? path.join(child, 'arrived') : blind;
            tracker.captureConfiguredExpansionBaselines = async () => {
                const committed = activeNativeWatcher(nativeDirectoryWatchers, child);
                if (failure === 'error') { committed.error(Object.assign(new Error('live committed owner failed'), {code:'EIO'})); }
                else if (failure === 'directory') {
                    fs.mkdirSync(gapTarget);
                    fs.writeFileSync(path.join(gapTarget, 'unobserved.txt'), 'imported during rejected Apply');
                    committed.listener('change', 'arrived');
                }
                else { committed.listener('change', undefined); }
                throw new Error('force candidate rollback');
            };
            const result = await tracker.applyConfiguredMonitoringScope(requested, false, () => true);
            assert.equal(result.status, 'failed');
            assert.equal(tracker.getEffectiveMonitoringScope().scopeRevision, scope.scopeRevision);
            assert.equal(tracker.getOriginalContent(target), 'before');
            assert.ok(tracker.getTrackedChanges().some(change => change.filePath === target));
            assert.ok(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === gapTarget),
                'rollback must not erase a live committed coverage failure');
            const saved = JSON.parse(fs.readFileSync(path.join(tracker.storageUri.fsPath, 'session-state.json'), 'utf8'));
            assert.ok(saved.coverageGaps.some(([root, value]) => root === gapTarget && value.subtree));
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
        const dispatch = tracker.dispatchExternalEvent;
        tracker.dispatchExternalEvent = () => {};
        activeNativeWatcher(nativeDirectoryWatchers, blind).listener('rename', 'added');
        tracker.dispatchExternalEvent = dispatch;
        await settle(tracker);
        assert.ok(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === added));
        assert.equal(await tracker.resetBaselineToCurrentState(), true);
        assert.equal(tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === added), false);
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
