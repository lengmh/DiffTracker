/** Issue 41: shared Acknowledge / explicit Unknown Reset transaction boundaries.
 * Production tracker, mocked VS Code API, real temporary filesystem. No host/physical-crash claim.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export function registerIssue41AckRecovery(h) {
    const { test, Uri, DiffTracker, vscode, file, document, pause, getTracker, setTracker, setListedFiles } = h;
    const pending = (tracker, target) => tracker.getTrackedChanges().find(change => change.filePath === target);
    const saved = storage => JSON.parse(fs.readFileSync(path.join(storage, 'session-state.json'), 'utf8'));
    const oldBytes = Buffer.from([0, 1, 2, 3]);
    const approvedBytes = Buffer.from([0, 4, 5, 6]);
    const laterBytes = Buffer.from([0, 7, 8, 9]);

    async function fixture(kind, run) {
        await getTracker().dispose();
        const workspace = file('ack-workspace');
        const storage = file('ack-storage');
        fs.mkdirSync(workspace);
        const target = path.join(workspace, 'target.bin');
        const sibling = path.join(workspace, 'sibling.txt');
        const undo = path.join(workspace, 'undo.txt');
        fs.writeFileSync(target, oldBytes);
        fs.writeFileSync(sibling, 'old sibling');
        fs.writeFileSync(undo, 'old undo');
        setListedFiles([target, sibling, undo].map(Uri.file));
        let tracker = new DiffTracker(Uri.file(storage));
        setTracker(tracker);
        tracker.isRecording = true;
        tracker.externalWatcherEnabled = true;
        assert.equal(await tracker.resetBaselineToCurrentState(), true);
        fs.writeFileSync(undo, 'undo evidence');
        await tracker.readFileAndUpdate(undo, Uri.file(undo));
        assert.equal((await tracker.revertFile(undo)).status, 'success');
        fs.writeFileSync(sibling, 'pending sibling');
        await tracker.readFileAndUpdate(sibling, Uri.file(sibling));
        fs.writeFileSync(target, approvedBytes);
        if (kind === 'unknown') tracker.recordUnresolvedBaseline(target, 'Original unknown before-image');
        else await tracker.readFileAndUpdate(target, Uri.file(target));
        assert.equal(pending(tracker, target)?.reviewKind, kind === 'unknown' ? 'unknown' : 'opaque');
        assert.equal(await tracker.flushPendingPersistence(), true);
        const before = saved(storage);
        const ctx = { tracker, target, sibling, undo, storage, before,
            act: () => kind === 'unknown'
                ? tracker.resetUnknownBaseline(target, tracker.getUnknownReviewToken(target))
                : tracker.acknowledgeOpaqueChange(target, tracker.getOpaqueReviewToken(target)),
            assertPrevious: recovered => {
                if (kind === 'unknown') assert.equal(recovered.unresolvedBaselineFiles.get(target), 'Original unknown before-image');
                else assert.deepEqual(recovered.opaqueBaselineFiles.get(target), new Map(before.opaqueBaselineFiles).get(target));
                assert.equal(pending(recovered, target)?.reviewKind, kind === 'unknown' ? 'unknown' : 'opaque');
                assert.equal(recovered.fileSnapshots.get(sibling), 'old sibling');
                assert.equal(pending(recovered, sibling)?.currentContent, 'pending sibling');
                assert.deepEqual(recovered.revertHistory, before.revertHistory);
            },
            crashImage: () => {
                const image = file('ack-crash-image');
                fs.cpSync(storage, image, { recursive: true });
                return image;
            },
            recover: async image => {
                await tracker.dispose();
                tracker = new DiffTracker(Uri.file(image));
                setTracker(tracker);
                const outcome = await tracker.restorePersistedState();
                assert.ok(['restored', 'recovered'].includes(outcome), `saved before-images must recover, got ${outcome}`);
                return tracker;
            }
        };
        try { await run(ctx); }
        finally { await tracker.dispose(); }
    }

    for (const kind of ['acknowledge', 'unknown']) {
        for (const point of ['unsaved delete', 'intent delete']) {
            test(`ISSUE-41 ACK durability ${kind} ${point} retains complete recoverable before-images`, () => fixture(kind, async ctx => {
                const { tracker, target, storage } = ctx;
                const faultPath = path.join(storage, point === 'unsaved delete' ? 'session-state.unsaved' : 'session-state.keep-in-progress.json');
                const originalDelete = vscode.workspace.fs.delete;
                const originalUnlink = fs.unlinkSync;
                let injected = 0, image;
                const fail = () => {
                    if (!injected) {
                        const candidate = saved(storage);
                        if (kind === 'unknown') assert.equal(new Map(candidate.unresolvedBaselineFiles).has(target), false);
                        else assert.notEqual(new Map(candidate.opaqueBaselineFiles).get(target)?.fingerprint,
                            new Map(ctx.before.opaqueBaselineFiles).get(target)?.fingerprint);
                        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(storage, 'session-state.last-good.json'), 'utf8')), candidate,
                            'both ordinary copies must already contain the candidate at this late failure');
                    }
                    injected++;
                    // Capture the actual failed-commit state before in-process rollback.
                    image ??= ctx.crashImage();
                    throw Object.assign(new Error(`injected ${point}`), { code: 'EACCES' });
                };
                vscode.workspace.fs.delete = async (uri, ...args) => {
                    if (uri.fsPath === faultPath) fail();
                    return originalDelete(uri, ...args);
                };
                fs.unlinkSync = (p, ...args) => {
                    if (String(p) === faultPath) fail();
                    return originalUnlink(p, ...args);
                };
                let result;
                try { result = await ctx.act(); }
                finally { vscode.workspace.fs.delete = originalDelete; fs.unlinkSync = originalUnlink; }
                assert.ok(injected, 'the actual durability boundary must be exercised');
                assert.notEqual(result.status, 'success');
                ctx.assertPrevious(tracker);
                assert.deepEqual(fs.readFileSync(target), approvedBytes, 'no workspace write');
                assert.deepEqual(JSON.parse(fs.readFileSync(path.join(image, 'session-state.pre-keep.json'), 'utf8')), ctx.before,
                    'the failed commit retains the entire pre-operation session, not just the target');
                ctx.assertPrevious(await ctx.recover(image));
            }));
        }

        test(`ISSUE-41 ACK duplicate ${kind} unchanged notification during candidate write succeeds`, () => fixture(kind, async ctx => {
            const gate = pause(path.join(ctx.storage, 'session-state.tmp.json'), 'write');
            const operation = ctx.act();
            try {
                await Promise.race([gate.entered, operation.then(result => { throw new Error(`ended before barrier: ${JSON.stringify(result)}`); })]);
                await ctx.tracker.onExternalFileChanged(Uri.file(ctx.target));
                await new Promise(resolve => setTimeout(resolve, 180));
                assert.equal(pending(ctx.tracker, ctx.target), undefined, 'duplicate event removes only the candidate projection');
            } finally { gate.release(); }
            assert.equal((await operation).status, 'success', 'approved identity must not depend on a transient pending projection');
            assert.equal(pending(ctx.tracker, ctx.target), undefined);
            assert.equal(ctx.tracker.fileSnapshots.get(ctx.sibling), 'old sibling');
            assert.deepEqual(ctx.tracker.revertHistory, ctx.before.revertHistory);
            const reloaded = await ctx.recover(ctx.crashImage());
            assert.equal(pending(reloaded, ctx.target), undefined);
            fs.writeFileSync(ctx.target, oldBytes);
            await reloaded.readFileAndUpdate(ctx.target, Uri.file(ctx.target));
            assert.equal(pending(reloaded, ctx.target)?.reviewKind, 'opaque', 'a later return to old bytes is a new review');
        }));

        for (const representation of ['text', 'missing', 'oversized']) {
            test(`ISSUE-41 ACK identity ${kind} ${representation} approval survives a same-content projection refresh`, () => fixture(kind, async ctx => {
                const content = representation === 'text' ? Buffer.from('approved UTF-8 text')
                    : representation === 'oversized' ? Buffer.alloc(5 * 1024 * 1024 + 1, 1) : undefined;
                if (content) fs.writeFileSync(ctx.target, content);
                else fs.unlinkSync(ctx.target);
                if (kind !== 'unknown') await ctx.tracker.readFileAndUpdate(ctx.target, Uri.file(ctx.target));
                const gate = pause(path.join(ctx.storage, 'session-state.tmp.json'), 'write');
                const operation = ctx.act();
                let finalReadBytes = 0, largestRead = 0;
                const originalRead = fs.readSync;
                try {
                    await gate.entered;
                    await ctx.tracker.readFileAndUpdate(ctx.target, Uri.file(ctx.target));
                    assert.equal(pending(ctx.tracker, ctx.target), undefined);
                    if (representation === 'oversized') {
                        fs.readSync = (fd, buffer, offset, length, ...args) => {
                            const read = originalRead(fd, buffer, offset, length, ...args);
                            finalReadBytes += read;
                            largestRead = Math.max(largestRead, length);
                            return read;
                        };
                    }
                    gate.release();
                    assert.equal((await operation).status, 'success');
                } finally { gate.release(); fs.readSync = originalRead; }
                if (representation === 'oversized') {
                    assert.equal(finalReadBytes, content.length, 'exactly one bounded final identity pass');
                    assert.ok(largestRead <= 64 * 1024, 'oversized resources never require a full-buffer synchronous allocation');
                }
                assert.equal(pending(ctx.tracker, ctx.target), undefined);
                if (content) assert.deepEqual(fs.readFileSync(ctx.target), content);
                else assert.equal(fs.existsSync(ctx.target), false);
                assert.deepEqual(ctx.tracker.revertHistory, ctx.before.revertHistory);
                const reloaded = await ctx.recover(ctx.crashImage());
                assert.equal(pending(reloaded, ctx.target), undefined);
            }));
        }

        test(`ISSUE-41 ACK isolation ${kind} removes only obsolete target Undo items`, () => fixture(kind, async ctx => {
            const record = ctx.tracker.revertHistory[0];
            const siblingItem = record.items[0];
            ctx.tracker.opaqueBaselineFiles.delete(ctx.target);
            ctx.tracker.fileSnapshots.set(ctx.target, siblingItem.after.content);
            ctx.tracker.baselineExistingFiles.add(ctx.target);
            if (kind === 'unknown') {
                ctx.tracker.unresolvedBaselineFiles.delete(ctx.target);
                ctx.tracker.markFileUnavailable(ctx.target, 'Current resource identity requires explicit reset');
            } else await ctx.tracker.readFileAndUpdate(ctx.target, Uri.file(ctx.target));
            // An older text Undo may predate this now-opaque/unknown review.
            ctx.tracker.revertHistory = [{ ...record, items: [
                { ...siblingItem, filePath: ctx.target }, ...record.items
            ] }];
            assert.equal(await ctx.tracker.flushPendingPersistence(), true);
            assert.equal((await ctx.act()).status, 'success');
            assert.deepEqual(ctx.tracker.revertHistory, ctx.before.revertHistory,
                'only the accepted target becomes obsolete; its batch siblings retain Undo');
            assert.equal(ctx.tracker.fileSnapshots.get(ctx.sibling), 'old sibling');
            assert.equal(pending(ctx.tracker, ctx.sibling)?.currentContent, 'pending sibling');
        }));

        for (const stage of ['backup', 'intent']) {
            test(`ISSUE-41 ACK preparation ${kind} ${stage} write failure never publishes a candidate`, () => fixture(kind, async ctx => {
                const faultPath = path.join(ctx.storage, stage === 'backup' ? 'session-state.pre-keep.json' : 'session-state.keep-in-progress.json');
                const originalWrite = vscode.workspace.fs.writeFile;
                let injected = 0;
                vscode.workspace.fs.writeFile = async (uri, ...args) => {
                    if (uri.fsPath === faultPath) {
                        injected++;
                        throw Object.assign(new Error(`injected ${stage} write`), { code: 'EACCES' });
                    }
                    return originalWrite(uri, ...args);
                };
                let result;
                try { result = await ctx.act(); }
                finally { vscode.workspace.fs.writeFile = originalWrite; }
                assert.ok(injected);
                assert.notEqual(result.status, 'success');
                ctx.assertPrevious(ctx.tracker);
                assert.deepEqual(saved(ctx.storage), ctx.before);
                ctx.assertPrevious(await ctx.recover(ctx.crashImage()));
            }));
        }

        for (const phase of ['intent write', 'candidate write']) {
            test(`ISSUE-41 ACK lifecycle ${kind} Stop during ${phase} retains recovery and blocks a new baseline`, () => fixture(kind, async ctx => {
                const gate = pause(path.join(ctx.storage, phase === 'intent write' ? 'session-state.keep-in-progress.json' : 'session-state.tmp.json'), 'write');
                const operation = ctx.act();
                try {
                    await gate.entered;
                    ctx.tracker.stopRecording();
                    assert.equal(ctx.tracker.isRecoveryBlocked(), true);
                    assert.equal(ctx.tracker.startRecording(), false);
                } finally { gate.release(); }
                assert.notEqual((await operation).status, 'success');
                ctx.assertPrevious(ctx.tracker);
                ctx.assertPrevious(await ctx.recover(ctx.crashImage()));
            }));
        }

        test(`ISSUE-41 ACK identity ${kind} silent edit after unsaved deletion is rejected at final commit`, () => fixture(kind, async ctx => {
            const originalUnlink = fs.unlinkSync;
            let injected = 0, image;
            fs.unlinkSync = (target, ...args) => {
                const result = originalUnlink(target, ...args);
                if (String(target) === path.join(ctx.storage, 'session-state.unsaved') && !injected++) {
                    fs.writeFileSync(ctx.target, laterBytes);
                    image = ctx.crashImage();
                }
                return result;
            };
            let result;
            try { result = await ctx.act(); }
            finally { fs.unlinkSync = originalUnlink; }
            assert.ok(injected);
            assert.notEqual(result.status, 'success');
            ctx.assertPrevious(ctx.tracker);
            assert.deepEqual(fs.readFileSync(ctx.target), laterBytes);
            ctx.assertPrevious(await ctx.recover(image));
        }));

        test(`ISSUE-41 ACK lifecycle ${kind} Stop after durable commit preserves acceptance`, () => fixture(kind, async ctx => {
            const subscription = ctx.tracker.onDidChangeBaselineState(state => {
                if (state === 'ready') ctx.tracker.stopRecording();
            });
            try { assert.equal((await ctx.act()).status, 'success'); }
            finally { subscription.dispose(); }
            const reloaded = await ctx.recover(ctx.crashImage());
            assert.equal(pending(reloaded, ctx.target), undefined);
            assert.equal(reloaded.unresolvedBaselineFiles.has(ctx.target), false);
            assert.deepEqual(reloaded.revertHistory, ctx.before.revertHistory);
        }));

        for (const event of ['notified', 'silent']) {
            test(`ISSUE-41 ACK identity ${kind} ${event} actual edit during candidate write is rejected`, () => fixture(kind, async ctx => {
                const gate = pause(path.join(ctx.storage, 'session-state.tmp.json'), 'write');
                const operation = ctx.act();
                try {
                    await gate.entered;
                    fs.writeFileSync(ctx.target, laterBytes);
                    if (event === 'notified') await ctx.tracker.readFileAndUpdate(ctx.target, Uri.file(ctx.target));
                } finally { gate.release(); }
                assert.notEqual((await operation).status, 'success', 'new bytes were never approved');
                ctx.assertPrevious(ctx.tracker);
                assert.deepEqual(fs.readFileSync(ctx.target), laterBytes);
                ctx.assertPrevious(await ctx.recover(ctx.crashImage()));
            }));
        }

        test(`ISSUE-41 ACK identity ${kind} dirty editor during candidate write is rejected`, () => fixture(kind, async ctx => {
            const gate = pause(path.join(ctx.storage, 'session-state.tmp.json'), 'write');
            const operation = ctx.act();
            try {
                await gate.entered;
                const doc = document(ctx.target);
                doc.isDirty = true;
                doc.text = 'unsaved unapproved editor text';
                doc.version++;
                ctx.tracker.onDocumentChanged({ document: doc });
            } finally { gate.release(); }
            assert.notEqual((await operation).status, 'success');
            if (kind === 'unknown') assert.equal(ctx.tracker.unresolvedBaselineFiles.get(ctx.target), 'Original unknown before-image');
            else assert.deepEqual(ctx.tracker.opaqueBaselineFiles.get(ctx.target), new Map(ctx.before.opaqueBaselineFiles).get(ctx.target));
            assert.equal(document(ctx.target).getText(), 'unsaved unapproved editor text');
            assert.deepEqual(fs.readFileSync(ctx.target), approvedBytes);
        }));
    }
}
