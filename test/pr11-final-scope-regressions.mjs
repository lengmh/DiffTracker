import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { evaluateConfiguredScope, validateAndCanonicalizeScope, detectScopeExpansion } from '../out/monitoringScope.js';

// Model only filesystem lookup, not the production scope/matching algorithm.
// Exact directory entries remain real, including on Windows runners.
export async function withLookups(aliases, denied, run) {
    const originals = {};
    const within = (value, prefix) => value === prefix || value.startsWith(prefix + path.sep);
    const translate = value => {
        if (typeof value !== 'string') return value;
        const normalized = path.resolve(value);
        if (denied.some(prefix => within(normalized, prefix))) {
            throw Object.assign(new Error('Simulated case-sensitive missing entry'), { code: 'ENOENT' });
        }
        for (const [alias, actual] of aliases) {
            if (within(normalized, alias)) return actual + normalized.slice(alias.length);
        }
        return value;
    };
    const native = fs.realpathSync.native;
    for (const name of ['existsSync', 'statSync', 'lstatSync', 'readdirSync', 'opendirSync', 'realpathSync']) {
        originals[name] = fs[name];
        fs[name] = (value, ...args) => {
            try { return originals[name](translate(value), ...args); }
            catch (error) { if (name === 'existsSync' && error.code === 'ENOENT') return false; throw error; }
        };
    }
    fs.realpathSync.native = (value, ...args) => native(translate(value), ...args);
    try { return await run(); }
    finally { for (const [name, original] of Object.entries(originals)) fs[name] = original; }
}

export function registerFinalScopeRegressions(h) {
    const { test, root, file, Uri, DiffTracker, vscode } = h;
    const rel = p => path.relative(root, p).split(path.sep).join('/');
    const scope = (t, includes = [], excludes = []) => {
        const result = validateAndCanonicalizeScope({ mode: 'rules', includes, excludes }, t.currentWorkspaceRootIdentities());
        assert.equal(result.ok, true, JSON.stringify(result.errors));
        return result.scope;
    };
    const overrideRoot = (t, sensitive) => {
        const original = t.workspaceRootIdentityForFolder.bind(t);
        t.workspaceRootIdentityForFolder = folder => ({ ...original(folder), caseSensitive: sensitive });
        return { ...t.currentWorkspaceRootIdentities()[0], caseSensitive: sensitive };
    };

    test('PR11 FINAL P1 child lookup enforces hard boundaries despite sensitive root', async () => {
        const t = h.getTracker(), dir = file('final-mixed-hard'), git = path.join(dir, '.git');
        fs.mkdirSync(git, { recursive: true }); fs.writeFileSync(path.join(git, 'HEAD'), 'metadata');
        const alias = path.join(dir, '.GIT'), identity = overrideRoot(t, true);
        await withLookups([[alias, git]], [], async () => {
            const request = { mode: 'rules', includes: [{ scope: 'all', path: rel(path.join(alias, 'HEAD')) }], excludes: [] };
            assert.equal(validateAndCanonicalizeScope(request, [identity]).ok, false,
                'root sensitivity must not authorize a case-equivalent nested .git alias');
            assert.equal(evaluateConfiguredScope({ ...request, roots: [identity] }, identity,
                rel(path.join(alias, 'HEAD')), false).source, 'hardBoundary');
            assert.match(t.validateResourceTarget(path.join(alias, 'HEAD')) ?? '', /hard.*(?:boundary|excluded)/i);
        });
    });

    test('PR11 FINAL P1 insensitive root cannot authorize missing variant in sensitive child', async () => {
        const t = h.getTracker(), dir = file('final-sensitive-child');
        const actual = path.join(dir, 'Secrets'), missing = path.join(dir, 'secrets');
        fs.mkdirSync(actual, { recursive: true }); fs.writeFileSync(path.join(actual, 'key.txt'), 'private');
        const identity = overrideRoot(t, false);
        await withLookups([], [missing], async () => {
            const request = { mode: 'rules', roots: [identity], includes: [{ scope: 'all', path: rel(missing) }], excludes: [] };
            assert.equal(evaluateConfiguredScope(request, identity, rel(path.join(actual, 'key.txt')), true).monitored, false,
                'a matching ASCII spelling without successful lookup is not filesystem identity proof');
            assert.notEqual(t.canonicalTrackingPath(path.join(missing, 'key.txt')), path.join(actual, 'key.txt'),
                'tracking keys must not merge case-distinct descendant paths');
        });
    });

    test('PR11 FINAL P1 exclusion containment cannot inherit insensitive root semantics', async () => {
        const t = h.getTracker(), dir = file('final-containment-child');
        const actual = path.join(dir, 'Secrets'), missing = path.join(dir, 'secrets');
        fs.mkdirSync(actual, { recursive: true }); fs.writeFileSync(path.join(actual, 'key.txt'), 'private');
        const identity = overrideRoot(t, false);
        await withLookups([], [missing], async () => {
            const make = pattern => validateAndCanonicalizeScope({ mode: 'rules', includes: [], excludes: [{ scope: 'all', pattern }] }, [identity]).scope;
            assert.equal(detectScopeExpansion(make('/' + rel(actual)), make('/' + rel(missing))).expands, true,
                'changing an exclusion to a missing case variant exposes the old directory');
        });
    });

    test('PR11 FINAL P1 ordinary child aliases resolve even beneath sensitive root', async () => {
        const t = h.getTracker(), dir = file('final-normal-alias'), actual = path.join(dir, 'private');
        fs.mkdirSync(actual, { recursive: true }); fs.writeFileSync(path.join(actual, 'key.txt'), 'data');
        const alias = path.join(dir, 'PRIVATE'), identity = overrideRoot(t, true);
        await withLookups([[alias, actual]], [], async () => {
            const request = { mode: 'rules', roots: [identity], includes: [{ scope: 'all', path: rel(alias) }], excludes: [] };
            assert.equal(evaluateConfiguredScope(request, identity, rel(path.join(actual, 'key.txt')), true).source, 'explicitInclude');
            assert.equal(t.canonicalTrackingPath(path.join(alias, 'key.txt')), path.join(actual, 'key.txt'));
        });
    });

    for (const sensitive of [true, false]) for (const kind of ['anchored', 'slashless', 'glob-parent', 'glob-tail']) {
        test(`PR11 FINAL P1 normalization exclusion ${kind} root-sensitive=${sensitive}`, async () => {
            const t = h.getTracker(), dir = file(`final-normalization-${kind}-${sensitive}`);
            const actual = path.join(dir, 'caf\u00e9'), alias = path.join(dir, 'cafe\u0301');
            fs.mkdirSync(actual, { recursive: true }); fs.writeFileSync(path.join(actual, 'key.txt'), 'private');
            const identity = overrideRoot(t, sensitive);
            const pattern = kind === 'anchored' ? '/' + rel(alias) + '/' : kind === 'slashless' ? 'cafe\u0301/' :
                kind === 'glob-parent' ? '*/cafe\u0301/' : rel(alias) + '/**';
            await withLookups([[alias, actual]], [], async () => {
                const request = { mode: 'rules', roots: [identity], includes: [], excludes: [{ scope: 'all', pattern }] };
                assert.equal(evaluateConfiguredScope(request, identity, rel(path.join(actual, 'key.txt')), false).source, 'explicitExclude',
                    'literal components must match actual filesystem lookup, not only the ignore regex');
                if (kind !== 'glob-tail') assert.equal(evaluateConfiguredScope(request, identity, rel(actual), false, true).source, 'explicitExclude');
            });
        });
    }

    for (const mode of ['isolated-empty', 'isolated-strings', 'explicit-mode', 'explicit-includes', 'structured']) {
        test(`PR11 FINAL P2 controller classifies ${mode} workspace exclusion`, async () => {
            const t = h.getTracker(), original = vscode.workspace.getConfiguration;
            const values = { watchExclude: mode === 'structured' ? [{ scope: 'all', pattern: 'private/' }] :
                mode === 'isolated-strings' ? ['private/'] : [] };
            if (mode === 'explicit-mode') values.monitoringScope = 'rules';
            if (mode === 'explicit-includes') values.watchInclude = [];
            vscode.workspace.getConfiguration = (section, resource) => {
                const base = original(section, resource);
                if (section !== 'diffTracker') return base;
                return { ...base, inspect: key => ({ workspaceValue: values[key] }), get: (key, fallback) => values[key] ?? base.get(key, fallback) };
            };
            const state = new Map();
            const controller = h.createScopeController({ workspaceState: { get: key => state.get(key), update: async (key, value) => state.set(key, value) } });
            try {
                const expected = !mode.startsWith('isolated');
                assert.equal(controller.getStatus().workspaceRequestPresent, expected,
                    'empty legacy arrays cannot manufacture a pending structured request that blocks Start');
                assert.equal(t.hasStructuredWorkspaceScopeRequest(), expected);
            } finally { controller.dispose(); vscode.workspace.getConfiguration = original; }
        });
    }

    test('PR11 FINAL P2 effective exclusion deactivates subtree gaps across restart without losing uncertainty', async () => {
        let t = h.getTracker();
        const storage = file('final-gap-storage'), dir = file('final-deferred-gap');
        t.storageUri = Uri.file(storage);
        const requested = scope(t, [], [{ scope: 'all', pattern: rel(dir) + '/' }]);
        t.setPendingMonitoringScope(requested); fs.mkdirSync(dir);
        await t.onExternalFileCreated(Uri.file(dir));
        assert.ok(t.getSubtreeCoverageGaps().some(gap => gap.targetPath === dir), 'a pending-only exclusion has not retired active coverage yet');
        assert.equal((await t.applyConfiguredMonitoringScope(requested)).status, 'applied');
        t.setPendingMonitoringScope(undefined);
        assert.equal(t.getSubtreeCoverageGaps().some(gap => gap.targetPath === dir), false,
            'intentionally excluded subtree must not keep the active Coverage Limited warning');
        assert.equal(t.getCoverageGaps().some(([target]) => target === dir), false);
        assert.ok(t.coverageGaps.get(dir)?.subtree, 'uncertainty remains durable for future re-inclusion');
        assert.equal(await t.flushPendingPersistence(), true);
        await t.dispose(); t = new DiffTracker(Uri.file(storage)); h.setTracker(t);
        assert.equal(await t.restorePersistedState(), 'restored');
        assert.equal(t.getSubtreeCoverageGaps().some(gap => gap.targetPath === dir), false, 'restart must not resurrect retired warnings');
        // Simulate a future prepared scope; S4 preparation itself remains out of S3.
        t.effectiveMonitoringScope = { kind: 'configured', ...scope(t) };
        t.setPendingMonitoringScope(undefined);
        assert.ok(t.getSubtreeCoverageGaps().some(gap => gap.targetPath === dir), 're-inclusion must reactivate preserved uncertainty');
    });

    test('PR11 FINAL P2 uncommitted exclusion cannot hide active subtree gaps', async () => {
        const t = h.getTracker(), dir = file('final-gap-candidate'); fs.mkdirSync(dir);
        t.setSubtreeCoverageGap(dir, 'pending-scope-deferred-event', 'unverified');
        const old = t.getEffectiveMonitoringScope();
        t.committedScopeDuringApply = old;
        t.effectiveMonitoringScope = { kind: 'configured', ...scope(t, [], [{ scope: 'all', pattern: rel(dir) + '/' }]) };
        try { assert.ok(t.getSubtreeCoverageGaps().some(gap => gap.targetPath === dir), 'candidate exclusions are not committed scope'); }
        finally { t.effectiveMonitoringScope = old; t.committedScopeDuringApply = undefined; }
    });
}
