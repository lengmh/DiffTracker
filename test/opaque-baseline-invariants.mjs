/** Cross-product regressions for opaque baseline publication and reconciliation.
 * Runs in tracker-safety.mjs against the production class and its VS Code boundary.
 * Barriers deliberately interleave real disk I/O with editor/watcher notifications.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const formats = ['bom', 'binary', 'invalid-utf8', 'oversized'];
function bytes(format, changed = false) {
    const value = changed ? 0x62 : 0x61;
    switch (format) {
        case 'bom': return Buffer.from([0xef, 0xbb, 0xbf, value]);
        case 'binary': return Buffer.from([0x00, value, 0x01]);
        case 'invalid-utf8': return Buffer.from([0xc3, 0x28, value]);
        case 'oversized': return Buffer.alloc(5 * 1024 * 1024 + 1, value);
        default: throw new Error(`Unknown fixture format: ${format}`);
    }
}

export function registerOpaqueBaselineInvariants(harness) {
    const { test, Uri, DiffTracker, docs, counters, faults, document, file, pending,
        pause, waitUntil, getTracker, setTracker, setListedFiles } = harness;

    async function setup(format) {
        const repo = file(`opaque-${format}`);
        fs.mkdirSync(repo);
        const target = path.join(repo, 'opaque.dat');
        fs.writeFileSync(target, bytes(format));
        setListedFiles([Uri.file(target)]);
        const tracker = getTracker();
        const storage = Uri.file(file('opaque-storage'));
        tracker.storageUri = storage;
        assert.equal(await tracker.resetBaselineToCurrentState(), true);
        assert.ok(tracker.opaqueBaselineFiles.has(target));
        assert.equal(pending(target), undefined);
        return { tracker, repo, target, storage };
    }

    function beginScan(scope, tracker, repo) {
        if (scope === 'workspace') { return tracker.resetBaselineToCurrentState(); }
        const base = { repoRoot: repo, kind: 'repository', headName: 'main',
            headCommit: 'aaa', detached: false, inProgress: false };
        const current = { ...base, headName: 'feature', headCommit: 'bbb' };
        tracker.setBaselineGitContexts([base]);
        tracker.observeGitContext(current);
        return tracker.rebuildRepositoryBaseline(repo, current);
    }

    function edit(tracker, doc) {
        doc.text = 'unsaved editor mutation';
        doc.isDirty = true;
        doc.version++;
        tracker.onDocumentChanged({ document: doc, contentChanges: [{ text: doc.text }] });
    }

    // P1 and its save/close variants: isDirty at scan start/end alone is not a
    // history of what happened while the scan was awaiting a read.
    for (const scope of ['workspace', 'repository']) {
        for (const format of formats) {
            for (const completion of ['dirty', 'saved', 'closed']) {
                test(`OPAQUE-INVARIANT scan ${scope}/${format}/${completion} retains editor evidence`, async () => {
                    let { tracker, repo, target, storage } = await setup(format);
                    const doc = document(target);
                    const gate = pause(target, 'stat');
                    const operation = beginScan(scope, tracker, repo);
                    try {
                        await gate.entered;
                        edit(tracker, doc);
                        if (completion === 'saved') {
                            // Simulate a save preserving the original file encoding.
                            fs.writeFileSync(target, bytes(format, true));
                            doc.isDirty = false;
                            tracker.onDidSaveDocument(doc);
                        } else if (completion === 'closed') {
                            docs.splice(docs.indexOf(doc), 1);
                        }
                    } finally { gate.release(); }
                    assert.equal(await operation, true);
                    assert.equal(tracker.opaqueBaselineFiles.has(target), false,
                        'a concurrent edit must not be accepted as a quiet opaque baseline');
                    assert.equal(tracker.fileSnapshots.has(target), false);
                    assert.match(pending(target)?.unavailableReason ?? '', /scan|unknown|unsaved/i);
                    assert.ok(tracker.unresolvedBaselineFiles.has(target));
                    assert.equal(await tracker.flushPendingPersistence(), true);
                    await tracker.dispose();
                    tracker = new DiffTracker(storage);
                    setTracker(tracker);
                    assert.equal(await tracker.restorePersistedState(), 'restored');
                    assert.ok(pending(target)?.unavailableReason, 'uncertainty must survive restart');
                    assert.equal(tracker.getReviewToken(target), undefined);
                    const before = { ...counters };
                    assert.notEqual((await tracker.revertFile(target)).status, 'success');
                    assert.deepEqual(counters, before, 'unavailable review cannot write the resource');
                    tracker.stopRecording();
                    assert.equal(await tracker.resetBaselineToCurrentState(), true);
                    assert.equal(pending(target), undefined);
                    assert.equal(tracker.isRecording, false);
                    const saved = JSON.parse(fs.readFileSync(path.join(storage.fsPath, 'session-state.json'), 'utf8'));
                    assert.equal(saved.opaqueBaselineFiles.length, 0);
                    assert.equal(saved.unresolvedBaselineFiles.length, 0);
                });
            }
        }
    }

    // Having no text snapshot is not the same as having no captured before-image.
    // This also covers a parent notification followed by opening a captured file.
    for (const scope of ['workspace', 'repository']) {
        for (const format of formats) {
            for (const notification of ['change', 'create', 'document', 'open-after-parent']) {
                test(`OPAQUE-INVARIANT captured ${scope}/${format}/${notification} retains identity`, async () => {
                    const { tracker, repo, target } = await setup(format);
                    const blocked = path.join(repo, 'blocked.txt');
                    fs.writeFileSync(blocked, 'stable text');
                    setListedFiles([Uri.file(target), Uri.file(blocked)]);
                    const gate = pause(blocked, 'read');
                    const operation = beginScan(scope, tracker, repo);
                    let baseline;
                    try {
                        await gate.entered;
                        await waitUntil(() => tracker.opaqueBaselineFiles.has(target), 5000);
                        baseline = { ...tracker.opaqueBaselineFiles.get(target) };
                        if (notification === 'document') {
                            edit(tracker, document(target));
                        } else if (notification === 'open-after-parent') {
                            await tracker.onExternalFileChanged(Uri.file(repo));
                            tracker.onDocumentOpened(document(target));
                        } else {
                            fs.writeFileSync(target, bytes(format, true));
                            if (notification === 'change') {
                                await tracker.onExternalFileChanged(Uri.file(target));
                            } else {
                                await tracker.onExternalFileCreated(Uri.file(target), true);
                            }
                        }
                    } finally { gate.release(); }
                    assert.equal(await operation, true);
                    if (notification !== 'open-after-parent') {
                        await waitUntil(() => notification === 'document'
                            ? pending(target)?.reviewKind === 'unknown'
                            : pending(target)?.reviewKind === 'opaque', 5000);
                    } else {
                        assert.equal(pending(target), undefined, 'opening known unchanged bytes is quiet');
                    }
                    assert.deepEqual(tracker.opaqueBaselineFiles.get(target), baseline,
                        'later events must not discard or replace the captured before-image');
                    assert.equal(tracker.unresolvedBaselineFiles.has(target), false);
                    assert.equal(await tracker.flushPendingPersistence(), true);
                });
            }
        }
    }

    // Check each live notification entry point with an already dirty editor.
    for (const format of formats) {
        for (const event of ['Changed', 'Created', 'Deleted']) {
            test(`OPAQUE-INVARIANT dirty ${format}/${event} cannot be cleared by identical disk bytes`, async () => {
                const { tracker, target } = await setup(format);
                const before = { ...tracker.opaqueBaselineFiles.get(target) };
                const doc = document(target);
                edit(tracker, doc);
                fs.unlinkSync(target);
                fs.writeFileSync(target, bytes(format));
                await tracker[`onExternalFile${event}`](Uri.file(target));
                // Changed is debounced; wait through the read before asserting.
                if (event === 'Changed') { await new Promise(resolve => setTimeout(resolve, 180)); }
                assert.ok(pending(target)?.unavailableReason);
                assert.equal(doc.isDirty, true);
                assert.equal(doc.getText(), 'unsaved editor mutation');
                assert.deepEqual(tracker.opaqueBaselineFiles.get(target), before);
            });
        }
    }

    // The shared reconciliation boundary must be safe independently of its caller.
    for (const format of formats) {
        test(`OPAQUE-INVARIANT reconcile ${format} rechecks dirty editor after the read`, async () => {
            const { tracker, target } = await setup(format);
            const state = await tracker.readFileSnapshot(Uri.file(target));
            edit(tracker, document(target));
            assert.equal(tracker.reconcileOpaqueBaseline(target, state), true);
            assert.ok(pending(target)?.unavailableReason);
            assert.ok(tracker.opaqueBaselineFiles.has(target));
        });
        test(`OPAQUE-INVARIANT accept ${format} rejects dirty editor without a notification`, async () => {
            const { tracker, target } = await setup(format);
            const state = await tracker.readFileSnapshot(Uri.file(target));
            tracker.opaqueBaselineFiles.delete(target);
            document(target).isDirty = true;
            tracker.recordOpaqueBaseline(target, state);
            assert.equal(tracker.opaqueBaselineFiles.has(target), false);
            assert.ok(tracker.unresolvedBaselineFiles.has(target));
            assert.match(pending(target)?.unavailableReason ?? '', /unsaved/i);
        });
    }

    // Clean save/reload is not proof of a modification, nor permission to lose
    // an opaque identity by pushing undecodable bytes through the text-diff path.
    for (const format of formats) {
        for (const notification of ['save-identical', 'reload-identical', 'save-changed']) {
            test(`OPAQUE-INVARIANT clean ${format}/${notification} reconciles actual bytes`, async () => {
                const { tracker, target } = await setup(format);
                const before = { ...tracker.opaqueBaselineFiles.get(target) };
                const doc = document(target);
                edit(tracker, doc);
                const changed = notification === 'save-changed';
                fs.writeFileSync(target, bytes(format, changed));
                doc.text = fs.readFileSync(target, 'utf8');
                doc.isDirty = false;
                doc.version++;
                if (notification.startsWith('save')) { tracker.onDidSaveDocument(doc); }
                else { tracker.onDocumentChanged({ document: doc, contentChanges: [] }); }
                if (changed) {
                    await waitUntil(() => pending(target)?.reviewKind === 'opaque', 5000);
                } else {
                    await waitUntil(() => pending(target) === undefined, 5000);
                }
                assert.deepEqual(tracker.opaqueBaselineFiles.get(target), before);
                assert.equal(tracker.unresolvedBaselineFiles.has(target), false);
            });
        }
    }

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
                                    await waitUntil(() => pending(target)?.reviewKind === 'opaque', 5000);
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
}
