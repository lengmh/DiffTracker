import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveRelativePathIdentity, detectLocalPathCaseSensitivity } from '../out/utils/pathIdentity.js';
import { evaluateConfiguredScope } from '../out/monitoringScope.js';
import { withLookups } from './pr11-final-scope-regressions.mjs';

// Model directory enumeration only. Every requested target and witness is real.
// The target is entry 15,001 in each of three consecutive parent directories.
function deepTree(dir) {
    const root = path.join(dir, 'runtime-budget');
    const middle = path.join(root, 'Alpha');
    const parent = path.join(middle, 'Beta');
    fs.mkdirSync(parent, { recursive: true });
    const target = path.join(parent, 'Leaf.txt');
    fs.writeFileSync(target, 'after');
    const levels = new Map([[root, 'Alpha'], [middle, 'Beta'], [parent, 'Leaf.txt']]);
    for (const directory of levels.keys()) fs.writeFileSync(path.join(directory, 'WarmProbe'), 'witness');
    return { root, parent, target, levels, relative: 'Alpha/Beta/Leaf.txt' };
}

async function lateEnumeration(tree, run) {
    const original = fs.opendirSync;
    const counts = { reads: 0, opens: 0, closes: 0, perParent: new Map() };
    const reset = () => { counts.reads = counts.opens = counts.closes = 0; counts.perParent.clear(); };
    fs.opendirSync = (value, ...args) => {
        const directory = path.resolve(String(value));
        const target = tree.levels.get(directory);
        if (!target) return original(value, ...args);
        counts.opens++;
        let index = 0;
        return {
            readSync() {
                counts.reads++;
                counts.perParent.set(directory, (counts.perParent.get(directory) ?? 0) + 1);
                index++;
                if (index > 25000) return null;
                const name = index === 1 ? 'WarmProbe' : index === 15001 ? target : `filler-${index}`;
                return { name, isSymbolicLink: () => false,
                    isDirectory: () => name === target && target !== 'Leaf.txt',
                    isFile: () => name !== target || target === 'Leaf.txt' };
            },
            closeSync() { counts.closes++; }
        };
    };
    try { return await run(counts, reset); }
    finally {
        fs.opendirSync = original;
        assert.equal(counts.closes, counts.opens, 'every opened enumeration handle must close');
    }
}

function invalidate(tree) {
    // Change actual metadata so no test can pass via an earlier cached spelling.
    for (const directory of tree.levels.keys()) fs.utimesSync(directory, new Date(1000), new Date(1000));
}

export function registerPR12RuntimeBudgetRegressions(h, fixture, scopeFor) {
    const { test, Uri } = h;
    for (const cache of ['cold', 'warm-prefix', 'repeated-lookup', 'invalidated']) {
        test(`PR12 BUDGET total scans are bounded across three 15001-entry components (${cache})`, () => fixture(async ({dir}) => {
            const tree = deepTree(dir);
            await lateEnumeration(tree, async (counts, reset) => {
                if (cache === 'repeated-lookup') {
                    resolveRelativePathIdentity(tree.root, tree.relative, false);
                } else if (cache !== 'cold') {
                    resolveRelativePathIdentity(tree.root, 'WarmProbe', false);
                }
                if (cache === 'invalidated') invalidate(tree);
                reset();
                const identity = resolveRelativePathIdentity(tree.root, tree.relative, false);
                console.log(`BUDGET ${cache}: ${counts.reads} reads; ${counts.opens} opens; lookup=${identity.lookupVerifiedPrefixLength}`);
                // Existing limits, shared across the WHOLE lookup: 10k cache
                // construction + 20k spelling recovery, not that sum per parent.
                // Each phase can inspect one EOF/overflow lookahead per component.
                assert.ok(counts.reads <= 30000 + 2 * 3, `whole-path reads=${counts.reads}, limit=30006`);
                assert.ok(counts.reads > 20000, 'fixture must exercise multiple large-directory phases');
                assert.equal(identity.lookupVerifiedPrefixLength, 3, 'existence survives spelling exhaustion');
                assert.equal(identity.runtimeFallbackExhausted, true);
                assert.equal(identity.unavailable, true, 'do not claim fully recovered physical spelling');
            });
        }));
    }

    test('PR12 BUDGET one scope decision shares runtime identity work across exclusions', () => fixture(async ({tracker, dir}) => {
        const tree = deepTree(dir);
        invalidate(tree);
        await lateEnumeration(tree, async counts => {
            const identity = {name: 'deep', uri: pathToFileURL(tree.root).toString(), caseSensitive: false};
            const excludes = Array.from({length: 20}, (_, index) => ({scope: 'all', pattern: `/Different${index}/**`}));
            const scoped = {...scopeFor(tracker, 'rules'), roots: [identity], excludes};
            const decision = evaluateConfiguredScope(scoped, identity, tree.relative, false);
            console.log(`BUDGET scope-rules: ${counts.reads} reads; ${counts.opens} opens`);
            assert.equal(decision.monitored, true);
            assert.equal(decision.source, 'ordinaryPolicy');
            assert.ok(counts.reads <= 30000 + 2 * 3,
                `one scope decision must share runtime identity allowances; reads=${counts.reads}`);
        });
    }));

    test('PR12 BUDGET exhausted decision context still honors a proven alias exclusion', () => fixture(async ({tracker, dir}) => {
        const tree = deepTree(dir);
        invalidate(tree);
        const alpha = path.join(tree.root, 'alpha');
        const beta = path.join(alpha, 'beta');
        const leaf = path.join(beta, 'leaf.txt');
        const aliases = [[leaf, tree.target], [beta, tree.parent], [alpha, path.join(tree.root, 'Alpha')]];
        await withLookups(aliases, [], async () => lateEnumeration(tree, async counts => {
            const identity = {name: 'deep', uri: pathToFileURL(tree.root).toString(), caseSensitive: false};
            const unrelated = Array.from({length: 20}, (_, index) => ({scope: 'all', pattern: `/Different${index}/**`}));
            const scoped = {...scopeFor(tracker, 'rules'), roots: [identity],
                excludes: [...unrelated, {scope: 'all', pattern: '/alpha/beta/leaf.txt'}]};
            const decision = evaluateConfiguredScope(scoped, identity, tree.relative, false);
            assert.equal(decision.monitored, false,
                'budget exhaustion must not turn a proven existing alias exclusion into permission');
            assert.equal(decision.source, 'explicitExclude');
            assert.ok(counts.reads <= 30000 + 2 * 3,
                `alias proof must not reopen a fresh runtime scan per rule; reads=${counts.reads}`);
        }));
    }));

    test('PR12 BUDGET exhausted decision context still honors a proven alias include', () => fixture(async ({tracker, dir}) => {
        const tree = deepTree(dir);
        invalidate(tree);
        const alpha = path.join(tree.root, 'alpha');
        const aliases = [[alpha, path.join(tree.root, 'Alpha')]];
        await withLookups(aliases, [], async () => lateEnumeration(tree, async counts => {
            const identity = {name: 'deep', uri: pathToFileURL(tree.root).toString(), caseSensitive: false};
            const unrelated = Array.from({length: 20}, (_, index) => ({scope: 'all', pattern: `/Different${index}/**`}));
            const scoped = {...scopeFor(tracker, 'rules'), roots: [identity], excludes: unrelated,
                includes: [{scope: 'all', path: 'alpha/Beta/Leaf.txt'}]};
            const decision = evaluateConfiguredScope(scoped, identity, tree.relative, true);
            assert.equal(decision.monitored, true,
                'budget exhaustion must not drop a proven existing alias include');
            assert.equal(decision.source, 'explicitInclude');
            assert.ok(counts.reads <= 30000 + 2 * 3,
                `alias include must not reopen a fresh runtime scan per rule; reads=${counts.reads}`);
        }));
    }));

    test('PR12 BUDGET exhausted runtime still records a changed deep existing file', () => fixture(async ({tracker, dir}) => {
        const tree = deepTree(dir);
        await tracker.refreshIgnoreMatchers();
        tracker.fileSnapshots.set(tree.target, 'before');
        tracker.baselineExistingFiles.add(tree.target);
        tracker.canonicalTrackingPath(tree.target, true);
        invalidate(tree);
        await lateEnumeration(tree, async () => {
            await tracker.onExternalFileChanged(Uri.file(tree.target));
            // Drain the real debounce queue; do not assert before its read runs.
            assert.equal(await tracker.drainDeferredScopeApplyEvents(tracker.sessionEpoch), true);
            const change = tracker.getTrackedChanges().find(item => item.filePath === tree.target);
            assert.ok(change, 'a verified existing file must not disappear from recording at the cap');
            assert.equal(change.originalContent, 'before');
            assert.equal(change.currentContent, 'after');
        });
    }));

    test('PR12 BUDGET deep runtime aliases reuse existing keys and preserve literal policy', () => fixture(async ({tracker, dir}) => {
        const tree = deepTree(dir);
        const alias = path.join(tree.parent, 'leaf.txt');
        tracker.fileSnapshots.set(tree.target, 'before');
        tracker.baselineExistingFiles.add(tree.target);
        tracker.canonicalTrackingPath(tree.target, true);
        const initialCount = tracker.canonicalTrackingPaths.size;
        invalidate(tree);
        const aliases = [[alias, tree.target], ...[...tree.levels.keys()].map(parent =>
            [path.join(parent, 'warmProbe'), path.join(parent, 'WarmProbe')])];
        await withLookups(aliases, [], async () => lateEnumeration(tree, async () => {
            assert.equal(tracker.canonicalTrackingPath(alias), tree.target);
            assert.equal(tracker.canonicalTrackingPaths.size, initialCount);
            const identity = {name: 'deep', uri: pathToFileURL(tree.root).toString(), caseSensitive: false};
            const base = {...scopeFor(tracker, 'rules'), roots: [identity]};
            const unrelated = {...base, excludes: [{scope: 'all', pattern: '/Different/**'}]};
            assert.equal(evaluateConfiguredScope(unrelated, identity, tree.relative, false).monitored, true);
            const excluded = {...base, excludes: [{scope: 'all', pattern: '/Alpha/Beta/leaf.txt'}]};
            assert.equal(evaluateConfiguredScope(excluded, identity, tree.relative, false).source, 'explicitExclude');
            const included = {...base, includes: [{scope: 'all', path: 'Alpha/Beta/leaf.txt'}]};
            assert.equal(evaluateConfiguredScope(included, identity, tree.relative, true).source, 'explicitInclude');
        }));
    }));

    test('PR12 BUDGET deep runtime hard-link entries keep independent keys', () => fixture(async ({tracker, dir}) => {
        const tree = deepTree(dir);
        if (detectLocalPathCaseSensitivity(tree.parent) !== true) {
            console.log('SKIP case-variant hard links need a case-sensitive directory; distinct-name links have cross-platform coverage');
            return;
        }
        tracker.fileSnapshots.set(tree.target, 'before');
        tracker.baselineExistingFiles.add(tree.target);
        tracker.canonicalTrackingPath(tree.target, true);
        const initialCount = tracker.canonicalTrackingPaths.size;
        const link = path.join(tree.parent, 'leaf.txt');
        fs.linkSync(tree.target, link);
        invalidate(tree);
        await lateEnumeration(tree, async () => {
            assert.equal(tracker.canonicalTrackingPath(link), link);
            assert.equal(tracker.canonicalTrackingPaths.size, initialCount + 1);
            const identity = {name: 'deep', uri: pathToFileURL(tree.root).toString(), caseSensitive: true};
            const scoped = {...scopeFor(tracker, 'rules'), roots: [identity],
                excludes: [{scope: 'all', pattern: '/Alpha/Beta/leaf.txt'}]};
            assert.equal(evaluateConfiguredScope(scoped, identity, tree.relative, false).monitored, true,
                'an independently named hard link must not exclude the other entry');
        });
    }));

    for (const failure of ['missing', 'denied', 'symlink']) {
        test(`PR12 BUDGET runtime exhaustion cannot excuse ${failure} identity`, () => fixture(async ({dir}) => {
            const tree = deepTree(dir);
            const original = fs.lstatSync;
            fs.lstatSync = (value, ...args) => {
                if (path.resolve(String(value)) !== tree.target) return original(value, ...args);
                if (failure !== 'symlink') throw Object.assign(new Error(failure), {code: failure === 'missing' ? 'ENOENT' : 'EACCES'});
                const stat = original(value, ...args);
                return new Proxy(stat, {get(target, key) { return key === 'isSymbolicLink' ? () => true : Reflect.get(target, key); }});
            };
            try {
                await lateEnumeration(tree, async () => {
                    const identity = resolveRelativePathIdentity(tree.root, tree.relative, false);
                    assert.notEqual(identity.runtimeFallbackExhausted, true,
                        'runtime escape hatch requires every component to be an accessible non-symlink lookup');
                    if (failure === 'missing') {
                        assert.ok(identity.lookupVerifiedPrefixLength < 3, 'missing leaf is not a verified existing path');
                    } else {
                        assert.equal(identity.unavailable, true);
                    }
                });
            } finally { fs.lstatSync = original; }
        }));
    }

    test('PR12 BUDGET preparation remains caller-owned and fails closed', () => fixture(async ({dir}) => {
        const tree = deepTree(dir);
        await lateEnumeration(tree, async counts => {
            const budget = {remainingEntries: 7};
            const identity = resolveRelativePathIdentity(tree.root, tree.relative, false, budget);
            assert.equal(budget.remainingEntries, 0);
            assert.equal(budget.exhausted, true);
            assert.equal(identity.unavailable, true);
            assert.notEqual(identity.runtimeFallbackExhausted, true);
            assert.ok(counts.reads <= 8, 'runtime allowances must not be granted to preparation');
        });
    }));
}
