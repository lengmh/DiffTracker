from pathlib import Path
import subprocess

source = Path('src/diffTracker.ts')
assert subprocess.check_output(['git', 'hash-object', str(source)], text=True).strip() == '66770164b00ea39c0a31ca33c90f8f05a391571e'
s = source.read_text(encoding='utf-8')
old = "typeof value.mtime !== 'number' || !Number.isFinite(value.mtime) || value.mtime < 0 ||"
new = "typeof value.mtime !== 'number' || !Number.isFinite(value.mtime) ||"
assert s.count(old) == 1
source.write_text(s.replace(old, new, 1), encoding='utf-8')

test = Path('test/state-schema-compatibility.mjs')
t = test.read_text(encoding='utf-8')
anchor = "    for (const failAt of ['write', 'rename', 'copy']) {"
assert t.count(anchor) == 1
regressions = r'''    for (const version of [2, 3]) {
        test(`SCHEMA-MTIME V${version} accepts finite pre-epoch timestamps`, async () => {
            const { state } = fixture(version);
            state.opaqueBaselineFiles[0][1].mtime = -315619200000;
            const parsed = getTracker().parsePersistedState(state);
            assert.ok(parsed, 'finite negative mtimes must not invalidate opaque identity');
            assert.equal(parsed.opaqueBaselineFiles[0][1].mtime, -315619200000);
        });
    }
    for (const value of [NaN, Infinity, -Infinity, '1960-01-01', null]) {
        test(`SCHEMA-MTIME rejects invalid timestamp ${String(value)}`, async () => {
            const { state } = fixture();
            state.opaqueBaselineFiles[0][1].mtime = value;
            assert.equal(getTracker().parsePersistedState(state), undefined);
        });
    }
    for (const scope of ['workspace', 'repository']) {
        test(`SCHEMA-MTIME ${scope} scan persists and restores pre-epoch file`, async () => {
            let tracker = getTracker();
            const { target } = fixture();
            const stamp = new Date('1960-01-01T00:00:00Z');
            fs.utimesSync(target, stamp, stamp);
            assert.ok(fs.statSync(target).mtimeMs < 0);
            const storage = Uri.file(file('pre-epoch-storage'));
            tracker.storageUri = storage;
            setListedFiles([Uri.file(target)]);
            if (scope === 'workspace') {
                assert.equal(await tracker.resetBaselineToCurrentState(), true);
            } else {
                const base = { repoRoot: root, kind: 'repository', headName: 'main',
                    headCommit: 'aaa', detached: false, inProgress: false };
                const current = { ...base, headName: 'next', headCommit: 'bbb' };
                tracker.setBaselineGitContexts([base]);
                tracker.observeGitContext(current);
                assert.equal(await tracker.rebuildRepositoryBaseline(root, current), true);
            }
            assert.equal(pending(target), undefined);
            assert.ok(tracker.opaqueBaselineFiles.get(target)?.mtime < 0);
            assert.equal(await tracker.flushPendingPersistence(), true);
            await tracker.dispose();
            tracker = new DiffTracker(storage);
            setTracker(tracker);
            assert.equal(await tracker.restorePersistedState(), 'restored');
            assert.ok(tracker.opaqueBaselineFiles.get(target)?.mtime < 0);
            assert.equal(pending(target), undefined);
        });
    }

'''
test.write_text(t.replace(anchor, regressions + anchor, 1), encoding='utf-8')
