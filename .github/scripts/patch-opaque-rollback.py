from pathlib import Path
import subprocess

source = Path('src/diffTracker.ts')
assert subprocess.check_output(['git', 'hash-object', str(source)], text=True).strip() == 'aaf233fe7246ac18f61c8d7ff9b9f44c611e74fe'
s = source.read_text(encoding='utf-8')
start = s.index('    private async performRepositoryRebuild(')
prefix, body = s[:start], s[start:]
old = '''        const restoreMemory = (): void => {
            this.fileSnapshots = previous.fileSnapshots;'''
new = '''        const restoreMemory = (): void => {
            // Roll back the baseline candidate, not observations made while it
            // was being built. Editor-only changes need not emit a watcher event.
            const observedReviewPaths = [...this.trackedChanges.keys()].filter(ownsPath);
            this.fileSnapshots = previous.fileSnapshots;'''
assert body.count(old) == 1
body = body.replace(old, new, 1)
old = '''            this.baselineBuilding = previous.baselineBuilding;
            this.resetChangeBlocksCaches();'''
new = '''            this.baselineBuilding = previous.baselineBuilding;
            for (const filePath of observedReviewPaths) {
                if (this.isPathIgnored(vscode.Uri.file(filePath))) { continue; }
                // Preserve a visible conflict synchronously even when Stop or
                // disposal cancels the remaining async reconciliation. When the
                // session stays active, reread against the restored before-image.
                this.markFileUnavailable(filePath, 'Baseline rebuild was interrupted; reconcile current file and editor changes before review');
                this.pendingExternalChanges.add(filePath);
            }
            this.resetChangeBlocksCaches();'''
assert body.count(old) == 1
body = body.replace(old, new, 1)
source.write_text(prefix + body, encoding='utf-8')

harness = Path('test/tracker-safety.mjs')
h = harness.read_text(encoding='utf-8')
old = '    test, root, Uri, DiffTracker, docs, counters, document, file, pending, pause, waitUntil,'
assert h.count(old) == 1
h = h.replace(old, '    test, root, Uri, DiffTracker, docs, counters, faults, document, file, pending, pause, waitUntil,', 1)
harness.write_text(h, encoding='utf-8')

matrix = Path('test/opaque-baseline-invariants.mjs')
t = matrix.read_text(encoding='utf-8')
t = t.replace('const { test, Uri, DiffTracker, docs, counters, document, file, pending,', 'const { test, Uri, DiffTracker, docs, counters, faults, document, file, pending,', 1)
regressions = r'''
    // A failed rebuild must restore its old before-image without rolling back
    // live editor observations. Exercise both pre-capture and captured states.
    for (const format of formats) {
        for (const captured of [false, true]) {
            for (const saved of [false, true]) {
                for (const abort of ['git', 'stop', 'persistence']) {
                    test(`OPAQUE-ROLLBACK ${format}/captured=${captured}/saved=${saved}/${abort} retains current edits`, async () => {
                        let { tracker, repo, target, storage } = await setup(format);
                        const original = { ...tracker.opaqueBaselineFiles.get(target) };
                        const doc = document(target);
                        const blocked = path.join(repo, 'blocked.txt');
                        fs.writeFileSync(blocked, 'stable');
                        setListedFiles([Uri.file(target), Uri.file(blocked)]);
                        const gate = pause(captured ? blocked : target, captured ? 'read' : 'stat');
                        const operation = beginScan('repository', tracker, repo);
                        const tempState = path.join(storage.fsPath, 'session-state.tmp.json');
                        try {
                            await gate.entered;
                            if (captured) { await waitUntil(() => tracker.opaqueBaselineFiles.has(target), 5000); }
                            edit(tracker, doc);
                            if (saved) {
                                fs.writeFileSync(target, bytes(format, true));
                                doc.isDirty = false;
                                tracker.onDidSaveDocument(doc);
                                if (captured) {
                                    await waitUntil(() => /changed since the baseline/i.test(pending(target)?.unavailableReason ?? ''), 5000);
                                }
                            }
                            assert.ok(pending(target)?.unavailableReason);
                            if (abort === 'git') {
                                tracker.observeGitContext({ repoRoot: repo, kind: 'repository', headName: 'third',
                                    headCommit: 'ccc', detached: false, inProgress: false });
                            } else if (abort === 'stop') {
                                tracker.stopRecording();
                            } else {
                                faults.set(tempState, { write: Object.assign(new Error('NoPermissions'), { code: 'NoPermissions' }) });
                            }
                        } finally { gate.release(); }
                        try {
                            assert.equal(await operation, false);
                            assert.deepEqual(tracker.opaqueBaselineFiles.get(target), original, 'rollback restores the old before-image');
                            assert.ok(pending(target)?.unavailableReason, 'rollback must not erase an edit observed during the rebuild');
                            assert.deepEqual(fs.readFileSync(target), bytes(format, saved));
                            assert.equal(doc.isDirty, !saved);
                        } finally { faults.delete(tempState); }
                        assert.equal(await tracker.flushPendingPersistence(), true);
                        await tracker.dispose();
                        tracker = new DiffTracker(storage);
                        setTracker(tracker);
                        assert.equal(await tracker.restorePersistedState(), 'restored');
                        assert.ok(pending(target)?.unavailableReason);
                        assert.deepEqual(tracker.opaqueBaselineFiles.get(target), original);
                    });
                }
            }
        }
    }
'''
assert t.endswith('}\n')
t = t[:-2] + regressions + '}\n'
matrix.write_text(t, encoding='utf-8')
