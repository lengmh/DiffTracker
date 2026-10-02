import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { detectLocalPathCaseSensitivity, sameExistingDirectoryEntry } from '../out/utils/pathIdentity.js';
import { validateAndCanonicalizeScope } from '../out/monitoringScope.js';
import { withLookups } from './pr11-final-scope-regressions.mjs';

export function registerPR12LiteralEntryRegressions(h, fixture, scopeFor) {
    const {test, setVsCodeExcludes} = h;
    const withLateEntries = async (directory, run) => {
        const original = fs.opendirSync;
        let reads = 0;
        fs.opendirSync = (value, ...args) => {
            if (path.resolve(String(value)) !== path.resolve(directory)) { return original(value, ...args); }
            let index = 0;
            return {
                readSync() {
                    reads++;
                    return ++index <= 25000
                        ? {name: `synthetic-${index}.txt`, isSymbolicLink: () => false}
                        : null;
                },
                closeSync() {}
            };
        };
        try { await run(() => reads); }
        finally { fs.opendirSync = original; }
    };

    test('PR12 CLOSURE brace alternatives preserve literal whitespace and empty branches', () => fixture(async ({tracker}) => {
        for (const [pattern, expected] of [
            ['**/{ .git, .difftracker-restore-x}/**', ['**/ .git/**', '**/ .difftracker-restore-x/**']],
            ['**/{.git ,\t.git}/**', ['**/.git /**', '**/\t.git/**']],
            ['**/{,.git}/**', ['**//**', '**/.git/**']],
            ['**/{ ,\u00a0.git}/**', ['**/ /**', '**/\u00a0.git/**']],
            ['{a,{ b,c }}', ['a', ' b', 'c ']]
        ]) {
            assert.deepEqual(tracker.expandSimpleBraceGlob(pattern)?.sort(), expected.sort(), pattern);
        }
    }));

    test('PR12 CLOSURE brace expansion keeps the exact cap including empty alternatives', () => fixture(async ({tracker}) => {
        assert.equal(tracker.expandSimpleBraceGlob('{a,b}'.repeat(8))?.length, 256);
        assert.equal(tracker.expandSimpleBraceGlob('{a,b}'.repeat(9)), undefined);
        assert.equal(tracker.expandSimpleBraceGlob('{,a}'.repeat(8))?.length, 256);
        assert.equal(tracker.expandSimpleBraceGlob('{,a}'.repeat(9)), undefined);
    }));

    for (const mode of ['wholeWorkspace', 'rules']) {
        test(`PR12 CLOSURE ${mode} Apply rejects leading-space watcher blind spots`, () => fixture(async ({tracker, dir}) => {
            const parent = path.join(dir, 'visible');
            const hidden = path.join(parent, ' .git');
            fs.mkdirSync(hidden, {recursive: true});
            fs.writeFileSync(path.join(hidden, 'live.txt'), 'not Git metadata');
            const checked = validateAndCanonicalizeScope({mode,
                includes: mode === 'rules' ? [{scope: 'all', path: 'visible'}] : [], excludes: []
            }, tracker.currentWorkspaceRootIdentities());
            assert.equal(checked.ok, true);
            const before = tracker.getEffectiveMonitoringScope();
            setVsCodeExcludes({'files.watcherExclude': {'visible/{ .git, .difftracker-restore-x}/**': true}});
            const result = await tracker.applyConfiguredMonitoringScope(checked.scope);
            assert.equal(result.status, 'requiresS4', JSON.stringify(result));
            assert.deepEqual(tracker.getEffectiveMonitoringScope(), before);
            assert.equal(tracker.fileSnapshots.has(path.join(hidden, 'live.txt')), false);
        }, mode));
    }

    test('PR12 CLOSURE only actual hard-boundary brace alternatives are exempt', () => fixture(async ({tracker}) => {
        const scope = scopeFor(tracker);
        setVsCodeExcludes({'files.watcherExclude': {'**/{.git,.difftracker-restore-x}/**': true}});
        assert.equal(tracker.configuredScopeNeedsSupplementalCoverage(scope), undefined);
        setVsCodeExcludes({'files.watcherExclude': {'**/{,.git}/**': true}});
        assert.ok(tracker.configuredScopeNeedsSupplementalCoverage(scope));
    }));

    test('PR12 CLOSURE same inode does not prove the same directory entry', () => fixture(async ({tracker, dir}) => {
        const original = path.join(dir, 'First');
        const link = path.join(dir, 'Second');
        fs.writeFileSync(original, 'shared');
        fs.linkSync(original, link);
        assert.equal(fs.lstatSync(original).ino, fs.lstatSync(link).ino);
        assert.notEqual(fs.realpathSync.native(original), fs.realpathSync.native(link));
        assert.equal(tracker.sameExistingFilesystemEntry(original, link), false);
        assert.equal(sameExistingDirectoryEntry(original, original), true);
        assert.equal(sameExistingDirectoryEntry(original, path.join(dir, 'Missing')), false);
        const lstat = fs.lstatSync;
        fs.lstatSync = (value, ...args) => {
            const result = lstat(value, ...args);
            return new Proxy(result, {get(target, name) {return name === 'ino' ? 0 : Reflect.get(target, name);}});
        };
        try { assert.equal(sameExistingDirectoryEntry(original, link), false); }
        finally { fs.lstatSync = lstat; }
    }));

    test('PR12 CLOSURE runtime cap keeps case-variant hard-link canonical keys separate', () => fixture(async ({tracker, dir}) => {
        const parent = path.join(dir, 'large-hardlinks');
        fs.mkdirSync(parent);
        const original = path.join(parent, 'Foo');
        const link = path.join(parent, 'foo');
        fs.writeFileSync(original, 'shared');
        if (detectLocalPathCaseSensitivity(parent) !== true) {
            console.log('SKIP case-variant hard links require a case-sensitive directory; distinct-name hard links are tested on every OS');
            return;
        }
        fs.linkSync(original, link);
        tracker.fileSnapshots.set(original, 'baseline');
        tracker.baselineExistingFiles.add(original);
        assert.equal(tracker.canonicalTrackingPath(original, true), original);
        const count = tracker.canonicalTrackingPaths.size;
        await withLateEntries(parent, async reads => {
            assert.equal(tracker.canonicalTrackingPath(link), link);
            assert.equal(tracker.canonicalTrackingPaths.size, count + 1);
            assert.ok(reads() > 20000, 'must exercise runtime spelling exhaustion rather than a cached shortcut');
        });
    }));

    test('PR12 CLOSURE runtime cap still reuses a proven filesystem alias', () => fixture(async ({tracker, dir}) => {
        const parent = path.join(dir, 'large-alias');
        fs.mkdirSync(parent);
        const original = path.join(parent, 'Foo');
        const alias = path.join(parent, 'foo');
        fs.writeFileSync(original, 'shared');
        tracker.fileSnapshots.set(original, 'baseline');
        tracker.baselineExistingFiles.add(original);
        assert.equal(tracker.canonicalTrackingPath(original, true), original);
        const count = tracker.canonicalTrackingPaths.size;
        await withLookups([[alias, original]], [], async () => {
            await withLateEntries(parent, async reads => {
                assert.equal(tracker.canonicalTrackingPath(alias), original);
                assert.equal(tracker.canonicalTrackingPaths.size, count);
                assert.ok(reads() > 20000, 'positive alias case must also reach the runtime cap');
            });
        });
    }));
}
