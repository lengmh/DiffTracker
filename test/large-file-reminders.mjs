/** Metadata-only oversized reminders: production tracker, real sparse disk files. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function registerLargeFileReminders(h) {
    const { test, Uri, DiffTracker, vscode, file, document, pause, getTracker, setTracker, setListedFiles } = h;
    const limit = 64 * 1024 * 1024;
    const pending = (t, p) => t.getTrackedChanges().find(c => c.filePath === p);
    async function fixture(run, initialLarge = false) {
        await getTracker().dispose();
        const dir = file('large-reminders'), storage = file('large-reminder-storage');
        fs.mkdirSync(dir);
        const target = path.join(dir, 'large.dat'), sibling = path.join(dir, 'sibling.txt');
        fs.writeFileSync(target, 'old text'); fs.writeFileSync(sibling, 'old sibling');
        if (initialLarge === 'open') { const doc = document(target); doc.getText = () => { throw new Error('Initial huge document text read'); }; }
        if (initialLarge) fs.truncateSync(target, limit + 1);
        setListedFiles([target, sibling].map(Uri.file));
        let tracker = new DiffTracker(Uri.file(storage)); setTracker(tracker);
        tracker.isRecording = true; tracker.externalWatcherEnabled = true;
        const originalRead = vscode.workspace.fs.readFile;
        let fullReads = 0, hashes = 0;
        vscode.workspace.fs.readFile = async (uri, ...args) => {
            if (uri.fsPath === target && fs.existsSync(target) && fs.statSync(target).size > limit) {
                fullReads++; throw new Error('Oversized workspace content read');
            }
            return originalRead(uri, ...args);
        };
        const protect = value => {
            const fingerprint = value.fingerprintLocalFile;
            value.fingerprintLocalFile = async (p, ...args) => {
                if (p === target && fs.existsSync(target) && fs.statSync(target).size > limit) {
                    hashes++; throw new Error('Oversized workspace fingerprint');
                }
                return fingerprint.call(value, p, ...args);
            };
        };
        protect(tracker);
        try {
            assert.equal(await tracker.resetBaselineToCurrentState(), true);
            fs.writeFileSync(sibling, 'sibling pending');
            await tracker.readFileAndUpdate(sibling, Uri.file(sibling));
            tracker.revertHistory = [{ id: 'sibling-history', createdAt: new Date().toISOString(),
                items: [tracker.createFileRevertItem(sibling)] }];
            const history = JSON.stringify(tracker.revertHistory);
            const ctx = { target, sibling, storage, dir,
                get tracker() { return tracker; },
                change: async size => { fs.truncateSync(target, size); await tracker.readFileAndUpdate(target, Uri.file(target)); },
                acknowledge: () => tracker.acknowledgeLargeFileReminder(target, tracker.getLargeFileReminderToken(target)),
                assertProtected: () => {
                    assert.equal(fullReads, 0); assert.equal(hashes, 0);
                    assert.equal(JSON.stringify(tracker.revertHistory), history);
                    assert.equal(tracker.getOriginalContent(sibling), 'old sibling');
                    assert.equal(pending(tracker, sibling)?.currentContent, 'sibling pending');
                },
                restart: async () => {
                    assert.equal(await tracker.flushPendingPersistence(), true);
                    await tracker.dispose(); tracker = new DiffTracker(Uri.file(storage)); setTracker(tracker); protect(tracker);
                    assert.ok(['restored', 'recovered'].includes(await tracker.restorePersistedState()));
                    return tracker;
                }
            };
            await run(ctx);
            ctx.assertProtected();
        } finally { vscode.workspace.fs.readFile = originalRead; await tracker.dispose(); }
    }

    test('LARGE-REMINDER initial oversized files are quiet metadata observations without content baselines', () => fixture(async ctx => {
        assert.equal(pending(ctx.tracker, ctx.target), undefined);
        assert.equal(ctx.tracker.getOriginalContent(ctx.target), undefined);
        assert.equal(ctx.tracker.opaqueBaselineFiles.has(ctx.target), false);
        assert.equal(ctx.tracker.unresolvedBaselineFiles.has(ctx.target), false);
        assert.ok(ctx.tracker.largeFileReminders.has(ctx.target));
        await ctx.restart();
        assert.equal(pending(ctx.tracker, ctx.target), undefined);
    }, true));
    test('LARGE-REMINDER size changes and deletion are dismiss-only, same-size and mtime events stay quiet', () => fixture(async ctx => {
        await ctx.change(limit + 2);
        assert.equal(pending(ctx.tracker, ctx.target)?.largeFileReminder?.pending, true);
        assert.equal((await ctx.acknowledge()).status, 'success');
        assert.equal(pending(ctx.tracker, ctx.target), undefined);
        const stat = fs.statSync(ctx.target);
        fs.utimesSync(ctx.target, new Date(), new Date(stat.mtimeMs + 1000));
        await ctx.tracker.readFileAndUpdate(ctx.target, Uri.file(ctx.target));
        assert.equal(pending(ctx.tracker, ctx.target), undefined);
        await ctx.restart();
        assert.equal(pending(ctx.tracker, ctx.target), undefined);
        await ctx.change(limit + 3);
        assert.equal(pending(ctx.tracker, ctx.target)?.largeFileReminder?.pending, true);
        fs.unlinkSync(ctx.target);
        await ctx.tracker.onExternalFileDeleted(Uri.file(ctx.target));
        assert.equal(pending(ctx.tracker, ctx.target)?.largeFileReminder?.currentExists, false);
        assert.equal((await ctx.acknowledge()).status, 'success');
        assert.equal(pending(ctx.tracker, ctx.target), undefined);
    }, true));
    test('LARGE-REMINDER preserves old pending text and Undo after dismissing a large transition', () => fixture(async ctx => {
        fs.writeFileSync(ctx.target, 'pending text'); await ctx.tracker.readFileAndUpdate(ctx.target, Uri.file(ctx.target));
        const targetHistory = ctx.tracker.createFileRevertItem(ctx.target);
        ctx.tracker.revertHistory[0].items.push(targetHistory);
        const history = JSON.stringify(ctx.tracker.revertHistory);
        await ctx.change(limit + 1);
        assert.equal(ctx.tracker.getOriginalContent(ctx.target), 'old text');
        assert.equal((await ctx.acknowledge()).status, 'success');
        assert.deepEqual(pending(ctx.tracker, ctx.target)?.largeFileReminder, {
            pending: false, retainedReview: true, currentExists: true, currentSize: limit + 1
        });
        assert.equal(ctx.tracker.getReviewToken(ctx.target), undefined);
        assert.equal(ctx.tracker.getOpaqueReviewToken(ctx.target), undefined);
        assert.equal(ctx.tracker.getUnknownReviewToken(ctx.target), undefined);
        assert.equal(ctx.tracker.getLargeFileReminderToken(ctx.target), undefined);
        assert.deepEqual(ctx.tracker.getChangeBlocks(ctx.target), []);
        assert.equal(JSON.stringify(ctx.tracker.revertHistory), history);
        ctx.tracker.revertHistory[0].items.pop();
        fs.writeFileSync(ctx.target, 'later small text'); await ctx.tracker.readFileAndUpdate(ctx.target, Uri.file(ctx.target));
        assert.equal(pending(ctx.tracker, ctx.target)?.largeFileReminder, undefined);
        assert.equal(pending(ctx.tracker, ctx.target)?.originalContent, 'old text');
        assert.equal(pending(ctx.tracker, ctx.target)?.currentContent, 'later small text');
    }));
    test('LARGE-REMINDER Unknown can dismiss a reminder without resetting its unknown baseline', () => fixture(async ctx => {
        ctx.tracker.fileSnapshots.delete(ctx.target); ctx.tracker.baselineExistingFiles.delete(ctx.target);
        ctx.tracker.recordUnresolvedBaseline(ctx.target, 'Original uncertainty');
        await ctx.change(limit + 1);
        assert.equal(pending(ctx.tracker, ctx.target)?.reviewKind, 'unknown');
        assert.equal((await ctx.acknowledge()).status, 'success');
        assert.equal(ctx.tracker.unresolvedBaselineFiles.get(ctx.target), 'Original uncertainty');
        assert.equal(pending(ctx.tracker, ctx.target)?.largeFileReminder?.pending, false);
        assert.equal(pending(ctx.tracker, ctx.target)?.largeFileReminder?.retainedReview, true);
    }));
    test('LARGE-REMINDER initial large to small remains Unknown without fabricated creation history', () => fixture(async ctx => {
        fs.writeFileSync(ctx.target, 'now small'); await ctx.tracker.readFileAndUpdate(ctx.target, Uri.file(ctx.target));
        assert.equal(pending(ctx.tracker, ctx.target)?.reviewKind, 'unknown');
        assert.equal(ctx.tracker.getOriginalContent(ctx.target), undefined);
        assert.equal(ctx.tracker.getReviewToken(ctx.target), undefined);
    }, true));
    test('LARGE-REMINDER directory delete observes ledger-only descendants', () => fixture(async ctx => {
        fs.unlinkSync(ctx.target);
        await ctx.tracker.onExternalFileDeleted(Uri.file(ctx.dir));
        assert.equal(pending(ctx.tracker, ctx.target)?.largeFileReminder?.currentExists, false);
        assert.equal(pending(ctx.tracker, ctx.target)?.largeFileReminder?.pending, true);
    }, true));
    test('LARGE-REMINDER dirty oversized document events never read the complete document text', () => fixture(async ctx => {
        const doc = document(ctx.target);
        await ctx.change(limit + 1);
        doc.isDirty = true; doc.version++;
        doc.getText = () => { throw new Error('Oversized document getText must not run'); };
        ctx.tracker.onDocumentChanged({ document: doc, contentChanges: [] });
        ctx.tracker.processDocumentChange(doc);
        assert.equal((await ctx.acknowledge()).status, 'conflict');
        assert.equal(ctx.tracker.getOriginalContent(ctx.target), 'old text');
    }));
    test('LARGE-REMINDER preserved Undo cannot read an oversized dirty editor', () => fixture(async ctx => {
        const doc = document(ctx.target);
        fs.writeFileSync(ctx.target, 'pending before Undo');
        await ctx.tracker.readFileAndUpdate(ctx.target, Uri.file(ctx.target));
        const item = ctx.tracker.createFileRevertItem(ctx.target);
        assert.ok(item);
        await ctx.change(limit + 1);
        doc.isDirty = true;
        doc.getText = () => { throw new Error('Undo must not read oversized document text'); };
        assert.equal((await ctx.tracker.readUndoCurrentState(item)).kind, 'unavailable');
    }));
    test('LARGE-REMINDER optional V4 ledger validates shape, bounds, and coexists with content history', () => fixture(async ctx => {
        await ctx.change(limit + 1);
        const state = ctx.tracker.buildPersistedState();
        assert.ok(ctx.tracker.parsePersistedState(state));
        const old = { ...state }; delete old.largeFileReminders;
        assert.deepEqual(ctx.tracker.parsePersistedState(old).largeFileReminders, []);
        for (const bad of [null, {}, [[ctx.target, {}]], [state.largeFileReminders[0], state.largeFileReminders[0]],
            [[ctx.target, { ...state.largeFileReminders[0][1], observed: { exists: true, size: -1 } }]],
            [[ctx.target, { ...state.largeFileReminders[0][1], observed: { exists: false, size: 1 } }]]]) {
            assert.equal(ctx.tracker.parsePersistedState({ ...state, largeFileReminders: bad }), undefined);
        }
        ctx.tracker.maxPersistedSnapshots = 1;
        assert.equal(ctx.tracker.parsePersistedState({ ...state, largeFileReminders: [state.largeFileReminders[0],
            [ctx.sibling, state.largeFileReminders[0][1]]] }), undefined);
        ctx.tracker.maxPersistedSnapshots = 10000;
        await ctx.restart();
        assert.equal(pending(ctx.tracker, ctx.target)?.largeFileReminder?.pending, true);
        assert.equal((await ctx.acknowledge()).status, 'success');
        await ctx.restart();
        assert.equal(pending(ctx.tracker, ctx.target)?.largeFileReminder?.pending, false);
        assert.equal(pending(ctx.tracker, ctx.target)?.largeFileReminder?.retainedReview, true);
        assert.equal(ctx.tracker.getOriginalContent(ctx.target), 'old text');
    }));
    for (const point of ['unsaved', 'intent']) {
        test(`LARGE-REMINDER durable ${point} failure preserves previous receipt and content history on restart`, () => fixture(async ctx => {
            await ctx.change(limit + 2);
            assert.equal(await ctx.tracker.flushPendingPersistence(), true);
            const before = JSON.parse(fs.readFileSync(path.join(ctx.storage, 'session-state.json'), 'utf8'));
            const faultPath = path.join(ctx.storage, point === 'unsaved' ? 'session-state.unsaved' : 'session-state.keep-in-progress.json');
            const originalDelete = vscode.workspace.fs.delete, originalUnlink = fs.unlinkSync;
            let image;
            const fail = () => {
                if (!image) { image = file('large-crash'); fs.cpSync(ctx.storage, image, { recursive: true }); }
                throw Object.assign(new Error('Injected late metadata receipt failure'), { code: 'EACCES' });
            };
            vscode.workspace.fs.delete = async (uri, ...args) => { if (uri.fsPath === faultPath) fail(); return originalDelete(uri, ...args); };
            fs.unlinkSync = (p, ...args) => { if (String(p) === faultPath) fail(); return originalUnlink(p, ...args); };
            let result;
            try { result = await ctx.acknowledge(); }
            finally { vscode.workspace.fs.delete = originalDelete; fs.unlinkSync = originalUnlink; }
            assert.ok(image); assert.equal(result.status, 'failed');
            assert.equal(pending(ctx.tracker, ctx.target)?.largeFileReminder?.pending, true);
            assert.deepEqual(JSON.parse(fs.readFileSync(path.join(image, 'session-state.pre-keep.json'), 'utf8')), before);
            const recovered = new DiffTracker(Uri.file(image));
            try {
                assert.ok(['restored', 'recovered'].includes(await recovered.restorePersistedState()));
                assert.equal(pending(recovered, ctx.target)?.largeFileReminder?.pending, true);
                assert.equal(recovered.getOriginalContent(ctx.target), 'old text');
                assert.deepEqual(recovered.revertHistory, before.revertHistory);
            } finally { await recovered.dispose(); }
        }));
    }
    test('LARGE-REMINDER size change during receipt save preserves the newer reminder and rejects stale approval', () => fixture(async ctx => {
        await ctx.change(limit + 1);
        const token = ctx.tracker.getLargeFileReminderToken(ctx.target);
        const gate = pause(path.join(ctx.storage, 'session-state.tmp.json'), 'write');
        const operation = ctx.tracker.acknowledgeLargeFileReminder(ctx.target, token);
        try { await gate.entered; await ctx.change(limit + 2); }
        finally { gate.release(); }
        assert.equal((await operation).status, 'failed');
        assert.equal(pending(ctx.tracker, ctx.target)?.largeFileReminder?.pending, true);
        assert.equal(pending(ctx.tracker, ctx.target)?.largeFileReminder?.currentSize, limit + 2);
        assert.equal((await ctx.tracker.acknowledgeLargeFileReminder(ctx.target, token)).status, 'conflict');
    }));

    test('LARGE-REMINDER create and rename produce independent metadata reminders', () => fixture(async ctx => {
        const created = path.join(ctx.dir, 'created.dat'), renamed = path.join(ctx.dir, 'renamed.dat');
        fs.writeFileSync(created, ''); fs.truncateSync(created, limit + 1);
        await ctx.tracker.onExternalFileCreated(Uri.file(created));
        assert.equal(pending(ctx.tracker, created)?.largeFileReminder?.pending, true);
        assert.equal((await ctx.tracker.acknowledgeLargeFileReminder(created)).status, 'success');
        fs.renameSync(created, renamed);
        await ctx.tracker.onExternalFileDeleted(Uri.file(created));
        await ctx.tracker.onExternalFileCreated(Uri.file(renamed));
        assert.equal(pending(ctx.tracker, created)?.largeFileReminder?.currentExists, false);
        assert.equal(pending(ctx.tracker, renamed)?.largeFileReminder?.pending, true);
        assert.equal(ctx.tracker.getReviewToken(renamed), undefined);
    }));
    test('LARGE-REMINDER same-size content events retain the reviewed metadata token', () => fixture(async ctx => {
        await ctx.change(limit + 2);
        const token = ctx.tracker.getLargeFileReminderToken(ctx.target);
        const fd = fs.openSync(ctx.target, 'r+');
        try { fs.writeSync(fd, Buffer.from('different bytes'), 0, 15, 0); } finally { fs.closeSync(fd); }
        await ctx.tracker.readFileAndUpdate(ctx.target, Uri.file(ctx.target));
        assert.deepEqual(ctx.tracker.getLargeFileReminderToken(ctx.target), token);
        assert.equal((await ctx.tracker.acknowledgeLargeFileReminder(ctx.target, token)).status, 'success');
    }, true));

    test('LARGE-REMINDER initial open oversized document is quiet without reading editor text', () => fixture(async ctx => {
        assert.equal(pending(ctx.tracker, ctx.target), undefined);
        assert.equal(ctx.tracker.unresolvedBaselineFiles.has(ctx.target), false);
    }, 'open'));
    test('LARGE-REMINDER directory rollback restores receipts alongside before-images', () => fixture(async ctx => {
        await ctx.change(limit + 1);
        const prior = ctx.tracker.captureImportedDirectoryRollbackState(ctx.dir);
        const ledger = JSON.stringify([...ctx.tracker.largeFileReminders]);
        ctx.tracker.largeFileReminders.delete(ctx.target);
        ctx.tracker.restoreImportedDirectoryRollbackState(ctx.dir, prior);
        assert.equal(JSON.stringify([...ctx.tracker.largeFileReminders]), ledger);
        assert.equal(ctx.tracker.getOriginalContent(ctx.target), 'old text');
        assert.equal(pending(ctx.tracker, ctx.target)?.largeFileReminder?.pending, true);
    }));
    test('LARGE-REMINDER uncertainty retains the metadata-only action projection', () => fixture(async ctx => {
        await ctx.change(limit + 1);
        ctx.tracker.markFileUnavailable(ctx.target, 'Coverage became uncertain');
        assert.equal(pending(ctx.tracker, ctx.target)?.largeFileReminder?.pending, true);
        assert.equal(ctx.tracker.getUnknownReviewToken(ctx.target), undefined);
        assert.deepEqual(ctx.tracker.getChangeBlocks(ctx.target), []);
    }));

    test('LARGE-REMINDER exact 64 MiB remains fingerprinted opaque review', () => fixture(async ctx => {
        await ctx.change(limit);
        assert.equal(ctx.tracker.largeFileReminders.has(ctx.target), false);
        assert.equal(pending(ctx.tracker, ctx.target)?.reviewKind, 'opaque');
        assert.match(pending(ctx.tracker, ctx.target)?.currentFingerprint ?? '', /^[a-f0-9]{64}$/);
        assert.ok(ctx.tracker.getOpaqueReviewToken(ctx.target));
    }));
    test('LARGE-REMINDER growth during streaming is bounded and switches to metadata-only', () => fixture(async ctx => {
        fs.truncateSync(ctx.target, 5 * 1024 * 1024 + 1);
        const originalStream = fs.createReadStream;
        let streamed = 0, window;
        fs.createReadStream = (p, options) => {
            if (String(p) === ctx.target) {
                window = options.end;
                fs.truncateSync(ctx.target, limit + 1000);
                const stream = originalStream(p, options);
                stream.on('data', data => { streamed += data.length; });
                return stream;
            }
            return originalStream(p, options);
        };
        try { await ctx.tracker.readFileAndUpdate(ctx.target, Uri.file(ctx.target)); }
        finally { fs.createReadStream = originalStream; }
        assert.equal(window, limit - 1);
        assert.ok(streamed <= limit);
        assert.equal(pending(ctx.tracker, ctx.target)?.largeFileReminder?.pending, true);
        assert.equal(pending(ctx.tracker, ctx.target)?.currentFingerprint, undefined);
    }));

    test('LARGE-REMINDER archive preflight rejects a ledger-only path replaced by a symlink', () => fixture(async ctx => {
        const repoRoot = ctx.tracker.getWorkspaceRoots()[0];
        ctx.tracker.setBaselineGitContexts([{ repoRoot, kind: 'repository', headName: 'main',
            headCommit: 'a'.repeat(40), detached: false, inProgress: false }]);
        const state = ctx.tracker.buildPersistedState();
        assert.equal(ctx.tracker.archivedReviewConflict(state), undefined);
        fs.unlinkSync(ctx.target); fs.symlinkSync(ctx.sibling, ctx.target);
        assert.match(ctx.tracker.archivedReviewConflict(state) ?? '', /symbolic link/i);
    }, true));
    test('LARGE-REMINDER failed Keep refresh cannot read a newly oversized dirty document', () => fixture(async ctx => {
        const a = { repoRoot: ctx.dir, kind: 'repository', headName: 'a', headCommit: 'a'.repeat(40), detached: false, inProgress: false };
        const b = { ...a, headName: 'b', headCommit: 'b'.repeat(40) };
        ctx.tracker.setBaselineGitContexts([a]); ctx.tracker.setGitContextProvider(() => [b]); ctx.tracker.observeGitContext(b);
        fs.writeFileSync(ctx.target, 'pending before Keep');
        await ctx.tracker.readFileAndUpdate(ctx.target, Uri.file(ctx.target));
        const doc = document(ctx.target);
        const gate = pause(path.join(ctx.storage, 'session-state.tmp.json'), 'write');
        const operation = ctx.tracker.keepAllChangesInFile(ctx.target);
        try {
            await Promise.race([gate.entered, operation.then(result => { throw new Error(`Keep ended before barrier: ${JSON.stringify(result)}`); })]);
            fs.truncateSync(ctx.target, limit + 1);
            doc.isDirty = true;
            doc.getText = () => { throw new Error('Failed Keep must not read newly oversized editor text'); };
        } finally { gate.release(); }
        assert.notEqual((await operation).status, 'success');
        assert.equal(pending(ctx.tracker, ctx.target)?.largeFileReminder?.pending, true);
        assert.equal(ctx.tracker.getOriginalContent(ctx.target), 'old text');
    }));

    for (const read of ['first', 'second']) {
        test(`LARGE-REMINDER Unknown Reset discovering a large file on ${read} read offers reminder without resetting history`, () => fixture(async ctx => {
            ctx.tracker.fileSnapshots.delete(ctx.target); ctx.tracker.baselineExistingFiles.delete(ctx.target);
            ctx.tracker.recordUnresolvedBaseline(ctx.target, 'Earlier content is unknown');
            const token = ctx.tracker.getUnknownReviewToken(ctx.target);
            assert.ok(token);
            const originalRead = ctx.tracker.readCurrentFileState.bind(ctx.tracker);
            if (read === 'first') fs.truncateSync(ctx.target, limit + 1);
            else {
                let reads = 0;
                ctx.tracker.readCurrentFileState = async p => {
                    const state = await originalRead(p);
                    if (p === ctx.target && ++reads === 1) fs.truncateSync(ctx.target, limit + 1);
                    return state;
                };
            }
            assert.notEqual((await ctx.tracker.resetUnknownBaseline(ctx.target, token)).status, 'success');
            assert.equal(pending(ctx.tracker, ctx.target)?.largeFileReminder?.pending, true);
            assert.ok(ctx.tracker.getLargeFileReminderToken(ctx.target));
            assert.equal(ctx.tracker.unresolvedBaselineFiles.get(ctx.target), 'Earlier content is unknown');
        }));
    }

    test('LARGE-REMINDER same-context Keep rejects oversized growth before committing the small baseline', () => fixture(async ctx => {
        fs.writeFileSync(ctx.target, 'pending small text');
        await ctx.tracker.readFileAndUpdate(ctx.target, Uri.file(ctx.target));
        const gate = pause(path.join(ctx.storage, 'session-state.tmp.json'), 'write');
        const operation = ctx.tracker.keepAllChangesInFile(ctx.target);
        try {
            await Promise.race([gate.entered, operation.then(result => { throw new Error(`Keep ended before barrier: ${JSON.stringify(result)}`); })]);
            fs.truncateSync(ctx.target, limit + 1);
        } finally { gate.release(); }
        assert.notEqual((await operation).status, 'success');
        assert.equal(ctx.tracker.getOriginalContent(ctx.target), 'old text');
        assert.equal(pending(ctx.tracker, ctx.target)?.largeFileReminder?.pending, true);
    }));
    test('LARGE-REMINDER post-commit Keep observation publishes a newer size reminder', () => fixture(async ctx => {
        fs.writeFileSync(ctx.target, 'approved small text');
        await ctx.tracker.readFileAndUpdate(ctx.target, Uri.file(ctx.target));
        const read = ctx.tracker.readCurrentFileState.bind(ctx.tracker);
        ctx.tracker.readCurrentFileState = async p => {
            if (p === ctx.target && ctx.tracker.fileSnapshots.get(p) === 'approved small text' && !ctx.tracker.baselineTransaction) {
                fs.truncateSync(p, limit + 1);
            }
            return read(p);
        };
        assert.equal((await ctx.tracker.keepAllChangesInFile(ctx.target)).status, 'success');
        assert.equal(ctx.tracker.getOriginalContent(ctx.target), 'approved small text');
        assert.equal(pending(ctx.tracker, ctx.target)?.largeFileReminder?.pending, true);
    }));

    for (const growthBoundary of ['path stat', 'descriptor stat']) {
        test(`LARGE-REMINDER sparse growth after ${growthBoundary} cannot trigger an unbounded small-file read`, async () => {
            const tracker = getTracker(), target = file('bounded-growth.dat');
            fs.writeFileSync(target, 'small');
            const stat = vscode.workspace.fs.stat, readFile = vscode.workspace.fs.readFile, open = fs.promises.open;
            let grew = false, unboundedReads = 0, bytesRead = 0;
            const grow = () => { grew = true; fs.truncateSync(target, 1024 * 1024 * 1024); };
            vscode.workspace.fs.stat = async uri => {
                const result = await stat(uri);
                if (uri.fsPath === target && growthBoundary === 'path stat' && !grew) grow();
                return result;
            };
            vscode.workspace.fs.readFile = async uri => {
                if (uri.fsPath === target) { unboundedReads++; throw new Error('Unbounded workspace read is forbidden'); }
                return readFile(uri);
            };
            fs.promises.open = async (...args) => {
                const fd = await open(...args);
                if (String(args[0]) === target) {
                    const descriptorStat = fd.stat.bind(fd), read = fd.read.bind(fd);
                    fd.stat = async (...statArgs) => {
                        const result = await descriptorStat(...statArgs);
                        if (growthBoundary === 'descriptor stat' && !grew) grow();
                        return result;
                    };
                    fd.read = async (...readArgs) => { const result = await read(...readArgs); bytesRead += result.bytesRead; return result; };
                }
                return fd;
            };
            try {
                const state = await tracker.readFileSnapshot(Uri.file(target));
                assert.equal(unboundedReads, 0);
                assert.equal(state.reasonCode, 'large-file-reminder-only');
                assert.equal(state.size, 1024 * 1024 * 1024);
                assert.ok(bytesRead <= 6, `read at most original size plus one byte, got ${bytesRead}`);
            } finally { vscode.workspace.fs.stat = stat; vscode.workspace.fs.readFile = readFile; fs.promises.open = open; }
        });
    }

    for (const mutation of ['size', 'mtime', 'deleted', 'small', 'directory']) {
        test(`LARGE-REMINDER initial oversized metadata rechecks ${mutation} before establishing a quiet observation`, async () => {
            const tracker = getTracker(), target = file('initial-large-race.dat');
            fs.writeFileSync(target, ''); fs.truncateSync(target, limit + 1);
            tracker.snapshotInitialized = false;
            const stat = vscode.workspace.fs.stat;
            let mutated = false, contentReads = 0;
            tracker.readLocalFileBytesBounded = async () => { contentReads++; throw new Error('No content reads for oversized metadata'); };
            tracker.fingerprintLocalFile = async () => { contentReads++; throw new Error('No fingerprints for oversized metadata'); };
            vscode.workspace.fs.stat = async uri => {
                const result = await stat(uri);
                if (uri.fsPath === target && !mutated) {
                    mutated = true;
                    if (mutation === 'size') fs.truncateSync(target, limit + 2);
                    if (mutation === 'mtime') fs.utimesSync(target, new Date(), new Date(result.mtime + 1000));
                    if (mutation === 'deleted') fs.unlinkSync(target);
                    if (mutation === 'small') fs.truncateSync(target, 4);
                    if (mutation === 'directory') { fs.unlinkSync(target); fs.mkdirSync(target); }
                }
                return result;
            };
            try {
                const state = await tracker.readFileSnapshot(Uri.file(target));
                tracker.recordScannedBaseline(target, state, 'workspace');
                if (mutation === 'mtime') {
                    assert.equal(pending(tracker, target), undefined, 'mtime alone is intentionally ignored');
                    assert.equal(tracker.largeFileReminders.get(target)?.observed.size, limit + 1);
                } else {
                    assert.ok(pending(tracker, target), 'a raced initial observation must not silently establish a quiet stale baseline');
                    assert.equal(tracker.largeFileReminders.has(target), false);
                    assert.equal(pending(tracker, target)?.reviewKind, 'unknown');
                }
                assert.equal(contentReads, 0);
                assert.equal(tracker.fileSnapshots.has(target), false);
                assert.equal(tracker.opaqueBaselineFiles.has(target), false);
            } finally { vscode.workspace.fs.stat = stat; }
        });
    }
    test('LARGE-REMINDER descriptor close cannot publish a stale oversized metadata observation', async () => {
        const tracker = getTracker(), target = file('descriptor-large-race.dat');
        fs.writeFileSync(target, 'small'); tracker.snapshotInitialized = false;
        const stat = vscode.workspace.fs.stat, open = fs.promises.open;
        let grew = false, reads = 0;
        vscode.workspace.fs.stat = async uri => {
            const result = await stat(uri);
            if (uri.fsPath === target && !grew) { grew = true; fs.truncateSync(target, limit + 1); }
            return result;
        };
        fs.promises.open = async (...args) => {
            const descriptor = await open(...args);
            if (String(args[0]) === target) {
                const close = descriptor.close.bind(descriptor), read = descriptor.read.bind(descriptor);
                descriptor.read = async (...args) => { reads++; return read(...args); };
                descriptor.close = async () => { await close(); fs.truncateSync(target, limit + 2); };
            }
            return descriptor;
        };
        try {
            const state = await tracker.readFileSnapshot(Uri.file(target));
            tracker.recordScannedBaseline(target, state, 'workspace');
            assert.match(state.reason ?? '', /changed while being observed/);
            assert.equal(tracker.largeFileReminders.has(target), false);
            assert.equal(pending(tracker, target)?.reviewKind, 'unknown');
            assert.equal(reads, 0);
        } finally { vscode.workspace.fs.stat = stat; fs.promises.open = open; }
    });

    for (const entry of ['initial-open', 'document-change']) {
        for (const linkKind of ['file', 'parent']) {
            test(`LARGE-REMINDER ${entry} rejects an external ${linkKind} symlink before observing metadata`, async () => {
                const tracker = getTracker(), parent = file('document-parent');
                fs.mkdirSync(parent);
                const target = path.join(parent, 'document.dat');
                fs.writeFileSync(target, 'before');
                const doc = document(target);
                const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'difftracker-large-external-'));
                const externalTarget = path.join(outside, 'document.dat');
                fs.writeFileSync(externalTarget, ''); fs.truncateSync(externalTarget, limit + 1);
                if (entry === 'document-change') {
                    tracker.fileSnapshots.set(target, 'before'); tracker.baselineExistingFiles.add(target);
                    tracker.updateTrackedDiff(target, 'pending text');
                } else tracker.snapshotInitialized = false;
                fs.unlinkSync(target);
                if (linkKind === 'file') fs.symlinkSync(externalTarget, target, 'file');
                else { fs.rmdirSync(parent); fs.symlinkSync(outside, parent, 'dir'); }
                let textReads = 0, contentReads = 0, followingStats = 0;
                const stat = fs.statSync;
                fs.statSync = (p, ...args) => {
                    if (String(p) === target) followingStats++;
                    return stat(p, ...args);
                };
                doc.getText = () => { textReads++; throw new Error('Rejected symlink document must not be read'); };
                tracker.readLocalFileBytesBounded = async () => { contentReads++; throw new Error('Rejected symlink content must not be read'); };
                tracker.fingerprintLocalFile = async () => { contentReads++; throw new Error('Rejected symlink content must not be hashed'); };
                try {
                    if (entry === 'initial-open') tracker.ensureSnapshotForDocument(doc, true);
                    else tracker.processDocumentChange(doc);
                    assert.equal(tracker.largeFileReminders.has(target), false, 'external metadata must not become a reminder');
                    assert.equal(tracker.opaqueBaselineFiles.has(target), false);
                    assert.equal(tracker.getLargeFileReminderToken(target), undefined);
                    assert.equal(pending(tracker, target)?.currentSize, undefined);
                    assert.equal(pending(tracker, target)?.largeFileReminder, undefined);
                    assert.equal(tracker.fileSnapshots.get(target), entry === 'document-change' ? 'before' : undefined);
                    assert.equal(textReads, 0); assert.equal(contentReads, 0); assert.equal(followingStats, 0);
                    assert.match(pending(tracker, target)?.unavailableReason ?? '', /symbolic link/i);
                    assert.deepEqual(tracker.buildPersistedState()?.largeFileReminders ?? [], []);
                } finally {
                    fs.statSync = stat;
                    fs.unlinkSync(linkKind === 'file' ? target : parent);
                    fs.rmSync(outside, { recursive: true, force: true });
                }
            });
        }
    }

}
