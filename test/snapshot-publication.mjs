import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createLegacyEffectiveScope } from '../out/monitoringScope.js';

export function registerSnapshotPublication(h, fixture) {
    const { test, vscode, Uri, DiffTracker, document, setTracker, waitUntil } = h;
    const baseline = 'original\n', earlier = 'earlier pending\n', latest = 'latest saved contents\n';
    async function within(promise) {
        let timer;
        try { return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Snapshot publication boundary was not reached')), 5000);
        })]); } finally { clearTimeout(timer); }
    }
    async function seed(tracker, dir, configured) {
        if (!configured) { tracker.effectiveMonitoringScope = createLegacyEffectiveScope(tracker.currentWorkspaceRootIdentities(), []); }
        const target = path.join(dir, 'known.txt');
        fs.writeFileSync(target, earlier); tracker.fileSnapshots.set(target, baseline); tracker.baselineExistingFiles.add(target);
        await tracker.readFileAndUpdate(target, Uri.file(target));
        tracker.activateExternalWatchers(tracker.createExternalWatchers(tracker.sessionEpoch));
        const watcher = tracker.fileWatchers.find(value => (typeof value.pattern === 'string' ? value.pattern : value.pattern?.pattern) === '**/*');
        assert.ok(watcher);
        return { target, notify: () => watcher.emit('change', Uri.file(target)) };
    }
    function capturedRead(target) {
        let enter, release, stats = 0;
        const entered = new Promise(resolve => { enter = resolve; }), released = new Promise(resolve => { release = resolve; });
        const stat = vscode.workspace.fs.stat;
        vscode.workspace.fs.stat = async function(uri) {
            const result = await stat.call(this, uri);
            // Hold the final real provider result after sampling, without
            // replacing its identity, metadata or bytes.
            if (uri.fsPath === target && ++stats === 2) { enter(); await released; }
            return result;
        };
        return { entered, release, restore: () => { vscode.workspace.fs.stat = stat; } };
    }
    async function saveNewDocument(tracker, target, text = latest) {
        const doc = document(target), edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, new vscode.Range(0, 0, 1, 0), text);
        assert.equal(await vscode.workspace.applyEdit(edit), true);
        tracker.onDocumentChanged({ document: doc, contentChanges: [{ range: new vscode.Range(0, 0, 1, 0), text }] });
        assert.equal(await doc.save(), true); tracker.onDidSaveDocument(doc);
        return doc;
    }
    const idle = tracker => waitUntil(() => tracker.pendingSnapshotReads.size === 0 &&
        tracker.activeExternalOperations.size === 0 && tracker.externalChangeTimers.size === 0, 5000);
    const perform = (tracker, target, action) => {
        const token = tracker.getReviewToken(target); assert.ok(token);
        return action === 'keep-file' ? tracker.keepAllChangesInFile(target, token)
            : action === 'keep-block' ? tracker.keepBlock(target, 0, token)
            : action === 'revert-file' ? tracker.revertFile(target, token) : tracker.revertBlock(target, 0, token);
    };
    async function assertStopped(tracker, target, expected) {
        const storage = tracker.storageUri;
        tracker.stopRecording(); assert.equal(await tracker.flushPendingPersistence(), true);
        for (const name of ['session-state.json', 'session-state.last-good.json']) {
            const saved = JSON.parse(fs.readFileSync(path.join(storage.fsPath, name), 'utf8'));
            assert.equal(new Map(saved.fileSnapshots).get(target), expected);
            assert.equal(saved.stoppedReviews?.some(review => review.filePath === target), false);
        }
        await tracker.dispose(); const reader = new DiffTracker(storage); setTracker(reader);
        assert.equal(await reader.restorePersistedState(), 'restored');
        assert.equal(reader.getTrackedChange(target), undefined); assert.equal(reader.getReviewToken(target), undefined);
    }

    for (const configured of [false, true]) {
        for (const action of ['keep-file', 'keep-block', 'revert-file', 'revert-block']) for (const fresh of [false, true]) {
            test(`SNAPSHOT-PUBLICATION saved action configured=${configured} action=${action} fresh=${fresh}`, () => fixture(async ({ tracker, dir }) => {
                const { target, notify } = await seed(tracker, dir, configured), gate = capturedRead(target);
                notify();
                try {
                    await within(gate.entered);
                    const doc = await saveNewDocument(tracker, target);
                    assert.equal(tracker.getTrackedChange(target)?.currentContent, latest);
                    if (fresh) {
                        notify();
                        await within(waitUntil(() => !tracker.pendingSnapshotReads.has(target) && tracker.externalChangeTimers.size === 0, 5000));
                    }
                    assert.equal((await perform(tracker, target, action)).status, 'success');
                    if (doc.isDirty) { assert.equal(await doc.save(), true); tracker.onDidSaveDocument(doc); }
                    gate.release(); await within(idle(tracker));
                    assert.equal(tracker.getTrackedChange(target), undefined, 'late bytes cannot republish the old review');
                    assert.equal(tracker.getReviewToken(target), undefined);
                    const expected = action.startsWith('keep') ? latest : baseline;
                    assert.equal(fs.readFileSync(target, 'utf8'), expected); assert.equal(doc.getText(), expected);
                    await assertStopped(tracker, target, expected);
                } finally { gate.release(); await within(idle(tracker)); gate.restore(); }
            }));
        }

        for (const action of ['revert-file', 'revert-block']) {
            test(`SNAPSHOT-PUBLICATION during action configured=${configured} action=${action}`, () => fixture(async ({ tracker, dir }) => {
                const { target, notify } = await seed(tracker, dir, configured);
                const edit = h.pause(target, 'apply'), actionTask = perform(tracker, target, action);
                let read;
                try {
                    await within(edit.entered); read = capturedRead(target); notify(); await within(read.entered);
                    edit.release(); assert.equal((await actionTask).status, 'success');
                    const doc = document(target); assert.equal(await doc.save(), true);
                    // Save's callback may arrive later than the physical save.
                    // Isolate action publication from notification revocation.
                    read.release(); await within(idle(tracker));
                    assert.equal(tracker.getTrackedChange(target), undefined);
                    assert.equal(tracker.getReviewToken(target), undefined);
                    assert.equal(fs.readFileSync(target, 'utf8'), baseline); assert.equal(doc.getText(), baseline);
                    tracker.onDidSaveDocument(doc);
                } finally { edit.release(); read?.release(); await actionTask; await within(idle(tracker)); read?.restore(); }
            }));
        }

        test(`SNAPSHOT-PUBLICATION saved observation configured=${configured}`, () => fixture(async ({ tracker, dir }) => {
            const { target, notify } = await seed(tracker, dir, configured), gate = capturedRead(target);
            notify();
            try {
                await within(gate.entered); await saveNewDocument(tracker, target);
                gate.release(); await within(idle(tracker));
                assert.equal(tracker.getTrackedChange(target)?.currentContent, latest);
                assert.ok(tracker.getReviewToken(target));
                fs.writeFileSync(target, 'later external edit\n'); notify();
                await within(idle(tracker));
                assert.equal(tracker.getTrackedChange(target)?.currentContent, 'later external edit\n');
            } finally { gate.release(); await within(idle(tracker)); gate.restore(); }
        }));

        for (const observation of ['same-view', 'sibling', 'new-epoch']) {
            test(`SNAPSHOT-PUBLICATION positive configured=${configured} observation=${observation}`, () => fixture(async ({ tracker, dir }) => {
                const { target, notify } = await seed(tracker, dir, configured);
                const doc = document(target); tracker.processDocumentChange(doc);
                fs.writeFileSync(target, latest);
                const gate = capturedRead(target); notify();
                try {
                    await within(gate.entered);
                    if (observation === 'same-view') {
                        tracker.processDocumentChange(doc); tracker.ensureInlineView(target);
                    } else if (observation === 'sibling') {
                        const sibling = path.join(dir, 'sibling.txt'); fs.writeFileSync(sibling, earlier);
                        tracker.fileSnapshots.set(sibling, baseline); tracker.baselineExistingFiles.add(sibling);
                        await saveNewDocument(tracker, sibling);
                    } else {
                        tracker.advanceEpoch(); fs.writeFileSync(target, 'new epoch content\n');
                        await tracker.readFileAndUpdate(target, Uri.file(target));
                    }
                    gate.release(); await within(idle(tracker));
                    assert.equal(tracker.getTrackedChange(target)?.currentContent, observation === 'new-epoch' ? 'new epoch content\n' : latest);
                    assert.equal(tracker.getOriginalContent(target), baseline); assert.ok(tracker.getReviewToken(target));
                } finally { gate.release(); await within(idle(tracker)); gate.restore(); }
            }));
        }
    }
}
