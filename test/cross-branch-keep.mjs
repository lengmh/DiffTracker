/** Issue 35: cross-branch Keep exercises production tracker transactions in a real Git repo. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateAndCanonicalizeScope } from '../out/monitoringScope.js';

export function registerCrossBranchKeep(h) {
    const { test, Uri, DiffTracker, vscode, file, document, pause, getTracker, setTracker, setListedFiles } = h;
    const before = 'old first\nanchor 1\nanchor 2\nanchor 3\nold last\n';
    const after = 'new first\nanchor 1\nanchor 2\nanchor 3\nnew last\n';
    const pending = (t, p) => t.getTrackedChanges().find(c => c.filePath === p);
    const saved = storage => JSON.parse(fs.readFileSync(path.join(storage, 'session-state.json'), 'utf8'));
    function git(workspace, ...args) {
        const result = spawnSync('git', ['-C', workspace, ...args], {
            encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
        });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
    }
    function snapshot(ctx) {
        return {
            files: ctx.targets.map(p => [fs.readFileSync(p).toString('base64'), fs.statSync(p).mode]),
            head: fs.readFileSync(path.join(ctx.workspace, '.git', 'HEAD')).toString('base64'),
            index: fs.readFileSync(path.join(ctx.workspace, '.git', 'index')).toString('base64'),
            status: git(ctx.workspace, 'status', '--porcelain=v1'),
            commit: git(ctx.workspace, 'rev-parse', 'HEAD')
        };
    }
    async function fixture(run, { crossBranch = true, mixed = false } = {}) {
        await getTracker().dispose();
        const oldFolders = vscode.workspace.workspaceFolders;
        const oldGetFolder = vscode.workspace.getWorkspaceFolder;
        const workspace = file('keep-git-workspace');
        const storage = file('keep-storage');
        fs.mkdirSync(workspace);
        git(workspace, 'init', '-b', 'branch-a');
        const targets = ['first.txt', 'second.txt'].map(name => path.join(workspace, name));
        for (const target of targets) fs.writeFileSync(target, before);
        fs.chmodSync(targets[0], 0o755);
        git(workspace, 'add', '.');
        git(workspace, '-c', 'user.name=Regression', '-c', 'user.email=regression@example.invalid', 'commit', '-m', 'baseline');
        git(workspace, 'branch', 'branch-b');
        git(workspace, 'branch', 'branch-c');
        const folder = { uri: Uri.file(workspace), name: 'cross-branch-keep' };
        vscode.workspace.workspaceFolders = [folder];
        vscode.workspace.getWorkspaceFolder = uri => {
            const relative = path.relative(workspace, uri.fsPath);
            return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ? folder : undefined;
        };
        const opaque = path.join(workspace, 'opaque.bin');
        const unknown = path.join(workspace, 'unknown.txt');
        if (mixed) fs.writeFileSync(opaque, Buffer.from([0, 1, 2]));
        setListedFiles([...targets, ...(mixed ? [opaque] : [])].map(p => Uri.file(p)));
        let tracker = new DiffTracker(Uri.file(storage));
        setTracker(tracker);
        tracker.isRecording = true;
        const a = { repoRoot: workspace, kind: 'repository', headName: 'branch-a',
            headCommit: git(workspace, 'rev-parse', 'HEAD'), detached: false, inProgress: false };
        const b = { ...a, headName: 'branch-b' };
        let live = [a];
        tracker.setGitContextProvider(() => live);
        try {
            assert.equal(await tracker.resetBaselineToCurrentState(), true);
            tracker.setBaselineGitContexts([a]);
            for (const target of targets) {
                fs.writeFileSync(target, after);
                await tracker.readFileAndUpdate(target, Uri.file(target));
            }
            if (mixed) {
                fs.writeFileSync(opaque, Buffer.from([0, 2, 3, 4]));
                await tracker.readFileAndUpdate(opaque, Uri.file(opaque));
                fs.writeFileSync(unknown, 'unverified before-image\n');
                tracker.unresolvedBaselineFiles.set(unknown, 'Before-image could not be verified');
                tracker.markFileUnavailable(unknown, 'Before-image could not be verified');
            }
            if (crossBranch) {
                git(workspace, 'checkout', 'branch-b');
                live = [b];
                tracker.observeGitContext(b);
                assert.ok(tracker.getGitPauseReason(targets[0]));
            }
            assert.equal(await tracker.flushPendingPersistence(), true);
            const ctx = { tracker, workspace, storage, targets, target: targets[0], opaque, unknown, a, b,
                setLive: value => { live = value; },
                restart: async () => {
                    await tracker.dispose();
                    tracker = new DiffTracker(Uri.file(storage));
                    setTracker(tracker);
                    tracker.setGitContextProvider(() => live);
                    assert.ok(['restored', 'recovered'].includes(await tracker.restorePersistedState()));
                    tracker.reconcileRestoredGitContexts(live ?? []);
                    return tracker;
                }
            };
            await run(ctx);
        } finally {
            await tracker.dispose();
            vscode.workspace.workspaceFolders = oldFolders;
            vscode.workspace.getWorkspaceFolder = oldGetFolder;
        }
    }
    for (const phase of ['temporary write', 'primary publication']) {
        for (const action of ['file', 'block', 'batch']) {
            test(`CROSS-BRANCH-KEEP LIFECYCLE stopped ${action} during ${phase} blocks Start until recovery`, () => fixture(async ctx => {
                const { tracker, target } = ctx;
                const gate = phase === 'temporary write'
                    ? pause(path.join(ctx.storage, 'session-state.tmp.json'), 'write')
                    : pause(path.join(ctx.storage, 'session-state.json'), 'copy');
                const operation = action === 'file' ? tracker.keepAllChangesInFile(target, tracker.getReviewToken(target))
                    : action === 'block' ? tracker.keepBlock(target, tracker.getChangeBlocks(target)[0].blockId, tracker.getReviewToken(target))
                    : tracker.keepAllChanges(tracker.getReviewTokens());
                const disk = snapshot(ctx);
                try {
                    await Promise.race([gate.entered, operation.then(result => { throw new Error(`Keep ended before Stop barrier: ${JSON.stringify(result)}`); })]);
                    assert.equal(fs.existsSync(path.join(ctx.storage, 'session-state.keep-in-progress.json')), true);
                    tracker.stopRecording();
                    assert.equal(tracker.isRecoveryBlocked(), true);
                    assert.equal(tracker.startRecording(), false, 'Start must not overwrite the pre-Keep recovery source');
                } finally { gate.release(); }
                const result = await operation;
                if (action === 'batch') { assert.equal(result.succeeded, 0); assert.equal(result.failed, 2); }
                else assert.notEqual(result.status, 'success');
                assert.equal(tracker.isRecoveryBlocked(), true);
                assert.equal(tracker.startRecording(), false);
                assert.equal(tracker.getOriginalContent(target), before);
                assert.deepEqual(snapshot(ctx), disk);
                const reloaded = await ctx.restart();
                assert.equal(reloaded.getOriginalContent(target), before);
                assert.ok(pending(reloaded, target));
                assert.equal(reloaded.isRecoveryBlocked(), false);
                assert.equal(fs.existsSync(path.join(ctx.storage, 'session-state.keep-in-progress.json')), false);
                assert.equal(reloaded.startRecording(), true);
                const deadline = Date.now() + 2000;
                while (reloaded.baselineBuilding && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
                assert.equal(reloaded.baselineBuilding, false, 'fresh recording must finish after recovery');
                assert.equal(await reloaded.flushPendingPersistence(), true);
                assert.equal((await ctx.restart()).getOriginalContent(target), after,
                    'a later explicit fresh baseline must not be reverted by a stale Keep intent');
            }));
        }
    }
    for (const action of ['file', 'block', 'batch']) {
        test(`CROSS-BRANCH-KEEP LIFECYCLE discard waits for stopped ${action} intent write and cannot resurrect review`, () => fixture(async ctx => {
            const { tracker, target } = ctx;
            const intent = path.join(ctx.storage, 'session-state.keep-in-progress.json');
            const gate = pause(intent, 'write');
            const operation = action === 'file' ? tracker.keepAllChangesInFile(target, tracker.getReviewToken(target))
                : action === 'block' ? tracker.keepBlock(target, tracker.getChangeBlocks(target)[0].blockId, tracker.getReviewToken(target))
                : tracker.keepAllChanges(tracker.getReviewTokens());
            let discard, settled = false;
            const disk = snapshot(ctx);
            try {
                await Promise.race([gate.entered, operation.then(result => { throw new Error(`Keep ended before intent-write Stop barrier: ${JSON.stringify(result)}`); })]);
                tracker.stopRecording();
                assert.equal(tracker.isRecoveryBlocked(), true);
                discard = tracker.discardRecoveryState().then(result => { settled = true; return result; });
                await new Promise(resolve => setImmediate(resolve));
                assert.equal(settled, false, 'discard must wait until the previously queued intent write settles');
                assert.equal(tracker.startRecording(), false);
            } finally { gate.release(); }
            const result = await operation;
            if (action === 'batch') assert.equal(result.succeeded, 0);
            else assert.notEqual(result.status, 'success');
            assert.equal(await discard, true);
            for (const name of ['session-state.json', 'session-state.last-good.json', 'session-state.unsaved', 'session-state.keep-in-progress.json', 'session-state.pre-keep.json']) {
                assert.equal(fs.existsSync(path.join(ctx.storage, name)), false, `${name} must stay discarded after late writes settle`);
            }
            const image = crashImage(ctx);
            const restarted = new DiffTracker(Uri.file(image));
            try {
                assert.equal(await restarted.restorePersistedState(), 'absent');
                assert.equal(restarted.getOriginalContent(target), undefined);
                assert.equal(restarted.isRecoveryBlocked(), false);
            } finally { await restarted.dispose(); }
            assert.deepEqual(snapshot(ctx), disk);
        }));
    }
    for (const action of ['file', 'block', 'batch']) {
        test(`CROSS-BRANCH-KEEP LIFECYCLE synchronous Stop after ${action} durable commit cannot roll it back`, () => fixture(async ctx => {
            const { tracker, target } = ctx;
            let stopped = false;
            const listener = tracker.onDidChangeBaselineState(state => {
                if (state !== 'ready' || stopped) return;
                assert.equal(tracker.baselineTransaction?.durablyCommitted, true);
                assert.equal(fs.existsSync(path.join(ctx.storage, 'session-state.keep-in-progress.json')), false);
                stopped = true;
                tracker.stopRecording();
            });
            const disk = snapshot(ctx);
            let result;
            try {
                result = action === 'file' ? await tracker.keepAllChangesInFile(target, tracker.getReviewToken(target))
                    : action === 'block' ? await tracker.keepBlock(target, tracker.getChangeBlocks(target)[0].blockId, tracker.getReviewToken(target))
                    : await tracker.keepAllChanges(tracker.getReviewTokens());
            } finally { listener.dispose(); }
            assert.equal(stopped, true);
            if (action === 'batch') { assert.equal(result.succeeded, 1); assert.equal(result.failed, 1); }
            else assert.equal(result.status, 'success');
            const accepted = action === 'block' ? before.replace('old first', 'new first') : after;
            assert.equal(tracker.getOriginalContent(target), accepted);
            assert.equal(tracker.isRecoveryBlocked(), false);
            const reloaded = await ctx.restart();
            assert.equal(reloaded.getOriginalContent(target), accepted);
            assert.equal(reloaded.isRecoveryBlocked(), false);
            assert.deepEqual(snapshot(ctx), disk);
        }));
    }
    // Freeze only the durable storage image. Never dispose/flush the live tracker
    // before the copy: doing so would repair the interrupted publication and hide it.
    function crashImage(ctx) {
        const storage = file('keep-crash-storage');
        fs.cpSync(ctx.storage, storage, { recursive: true });
        return storage;
    }
    async function readCrashImage(ctx, storage, check) {
        const recovered = new DiffTracker(Uri.file(storage));
        const live = [{ ...ctx.b, headName: git(ctx.workspace, 'symbolic-ref', '--short', 'HEAD') }];
        recovered.setGitContextProvider(() => live);
        try {
            const result = await recovered.restorePersistedState();
            assert.ok(['restored', 'recovered'].includes(result), `crash recovery must restore an actionable session, got ${result}`);
            assert.equal(fs.existsSync(path.join(storage, 'session-state.pre-keep.json')), false,
                'successful recovery must remove its obsolete pre-Keep backup');
            recovered.reconcileRestoredGitContexts(live);
            await check(recovered);
        } finally { await recovered.dispose(); }
    }
    for (const action of ['file', 'block', 'batch']) {
        test(`CROSS-BRANCH-KEEP CRASH ${action} after unsaved deletion restores the pre-Keep session`, () => fixture(async ctx => {
            const { tracker, target } = ctx;
            const unsaved = path.join(ctx.storage, 'session-state.unsaved');
            const originalDelete = vscode.workspace.fs.delete;
            const originalUnlink = fs.unlinkSync;
            let image;
            const interrupt = () => {
                if (image) return;
                assert.notEqual(saved(ctx.storage).fileSnapshots.find(([p]) => p === target)?.[1], before);
                assert.equal(fs.existsSync(unsaved), false);
                image = crashImage(ctx);
                throw new Error('simulated crash after removing unsaved, before durable Keep commit');
            };
            // The old implementation yields through VS Code delete; the fixed
            // implementation must keep the final guard/deletions synchronous.
            vscode.workspace.fs.delete = async (uri, ...args) => {
                const result = await originalDelete(uri, ...args);
                if (uri.fsPath === unsaved) interrupt();
                return result;
            };
            fs.unlinkSync = (targetPath, ...args) => {
                const result = originalUnlink(targetPath, ...args);
                if (String(targetPath) === unsaved) interrupt();
                return result;
            };
            try {
                if (action === 'file') await tracker.keepAllChangesInFile(target, tracker.getReviewToken(target));
                else if (action === 'block') await tracker.keepBlock(target, tracker.getChangeBlocks(target)[0].blockId, tracker.getReviewToken(target));
                else await tracker.keepAllChanges(tracker.getReviewTokens());
            } finally {
                vscode.workspace.fs.delete = originalDelete;
                fs.unlinkSync = originalUnlink;
            }
            assert.ok(image, 'the interrupted candidate must have reached durable marker deletion');
            git(ctx.workspace, 'checkout', 'branch-c');
            ctx.setLive([{ ...ctx.b, headName: 'branch-c' }]);
            await readCrashImage(ctx, image, async recovered => {
                for (const p of ctx.targets) {
                    assert.equal(recovered.getOriginalContent(p), before, 'an uncommitted Keep must never be accepted on restart');
                    assert.ok(pending(recovered, p));
                }
                assert.ok(recovered.getGitPauseReason(target));
                assert.deepEqual(saved(image).gitContexts, [ctx.a]);
            });
        }));
    }
    for (const phase of ['before candidate', 'after candidate']) {
        for (const action of ['file', 'block', 'batch']) {
            test(`CROSS-BRANCH-KEEP CRASH ${action} ${phase} restores all prior evidence`, () => fixture(async ctx => {
                const { tracker, target } = ctx;
                const gate = phase === 'before candidate'
                    ? pause(path.join(ctx.storage, 'session-state.tmp.json'), 'write')
                    : pause(path.join(ctx.storage, 'session-state.json'), 'copy');
                const operation = action === 'file' ? tracker.keepAllChangesInFile(target, tracker.getReviewToken(target))
                    : action === 'block' ? tracker.keepBlock(target, tracker.getChangeBlocks(target)[0].blockId, tracker.getReviewToken(target))
                    : tracker.keepAllChanges(tracker.getReviewTokens());
                let image;
                try {
                    await Promise.race([gate.entered, operation.then(result => { throw new Error(`Keep ended before crash barrier: ${JSON.stringify(result)}`); })]);
                    const candidate = saved(ctx.storage).fileSnapshots.find(([p]) => p === target)?.[1];
                    if (phase === 'before candidate') assert.equal(candidate, before);
                    else assert.notEqual(candidate, before);
                    assert.equal(fs.existsSync(path.join(ctx.storage, 'session-state.pre-keep.json')), true,
                        'an uncommitted intent must retain its recovery backup');
                    image = crashImage(ctx);
                    git(ctx.workspace, 'checkout', 'branch-c');
                    ctx.setLive([{ ...ctx.b, headName: 'branch-c' }]);
                } finally { gate.release(); }
                await operation;
                await readCrashImage(ctx, image, async recovered => {
                    for (const p of ctx.targets) {
                        assert.equal(recovered.getOriginalContent(p), before);
                        assert.ok(pending(recovered, p));
                    }
                    assert.equal(pending(recovered, ctx.unknown)?.reviewKind, 'unknown');
                    assert.ok(pending(recovered, ctx.unknown)?.unavailableReason);
                    assert.equal(pending(recovered, ctx.opaque)?.reviewKind, 'opaque');
                    assert.deepEqual(saved(image).gitContexts, [ctx.a]);
                    assert.ok(recovered.getGitPauseReason(target));
                    assert.equal(recovered.isRecoveryBlocked(), false);
                });
            }, { mixed: true }));
        }
    }
    for (const action of ['file', 'block', 'batch']) {
        test(`CROSS-BRANCH-KEEP CRASH committed ${action} restart keeps accepted baseline and permits later Keep`, () => fixture(async ctx => {
            const { tracker, target } = ctx;
            const result = action === 'file' ? await tracker.keepAllChangesInFile(target, tracker.getReviewToken(target))
                : action === 'block' ? await tracker.keepBlock(target, tracker.getChangeBlocks(target)[0].blockId, tracker.getReviewToken(target))
                : await tracker.keepAllChanges(tracker.getReviewTokens());
            if (action === 'batch') assert.equal(result.succeeded, 2);
            else assert.equal(result.status, 'success');
            assert.equal(fs.existsSync(path.join(ctx.storage, 'session-state.keep-in-progress.json')), false);
            assert.equal(fs.existsSync(path.join(ctx.storage, 'session-state.unsaved')), false);
            assert.equal(fs.existsSync(path.join(ctx.storage, 'session-state.pre-keep.json')), false,
                'committed Keep must remove the no-longer-needed before-image backup');
            const image = crashImage(ctx);
            git(ctx.workspace, 'checkout', 'branch-c');
            ctx.setLive([{ ...ctx.b, headName: 'branch-c' }]);
            const disk = snapshot(ctx);
            await readCrashImage(ctx, image, async recovered => {
                assert.equal(recovered.getOriginalContent(target), action === 'block' ? before.replace('old first', 'new first') : after);
                assert.equal(recovered.isRecoveryBlocked(), false);
                const p = ctx.targets[1];
                fs.writeFileSync(p, `${after}later reviewed work\n`);
                await recovered.readFileAndUpdate(p, Uri.file(p));
                assert.equal((await recovered.keepAllChangesInFile(p, recovered.getReviewToken(p))).status, 'success',
                    'a completed commit must not leave an inert recovery intent blocking later Keep');
            });
            fs.writeFileSync(ctx.targets[1], after);
            assert.deepEqual(snapshot(ctx), disk);
        }));
    }
    for (const fault of ['pre-Keep backup write', 'intent write', 'unsaved delete', 'intent delete']) {
        for (const action of ['file', 'block', 'batch']) {
            test(`CROSS-BRANCH-KEEP DURABILITY ${action} ${fault} failure cannot accept the candidate`, () => fixture(async ctx => {
                const { tracker, target } = ctx;
                const fileName = fault === 'pre-Keep backup write' ? 'session-state.pre-keep.json'
                    : fault === 'unsaved delete' ? 'session-state.unsaved' : 'session-state.keep-in-progress.json';
                const faultPath = path.join(ctx.storage, fileName);
                const originalWrite = vscode.workspace.fs.writeFile;
                const originalDelete = vscode.workspace.fs.delete;
                const originalUnlink = fs.unlinkSync;
                let injected = 0;
                const fail = () => { injected++; throw Object.assign(new Error(`injected ${fault} failure`), { code: 'EACCES' }); };
                vscode.workspace.fs.writeFile = async (uri, ...args) => {
                    if (fault.endsWith('write') && uri.fsPath === faultPath) fail();
                    return originalWrite(uri, ...args);
                };
                vscode.workspace.fs.delete = async (uri, ...args) => {
                    if (fault.endsWith('delete') && uri.fsPath === faultPath) fail();
                    return originalDelete(uri, ...args);
                };
                fs.unlinkSync = (targetPath, ...args) => {
                    if (fault.endsWith('delete') && String(targetPath) === faultPath) fail();
                    return originalUnlink(targetPath, ...args);
                };
                const disk = snapshot(ctx);
                let result, image;
                try {
                    result = action === 'file' ? await tracker.keepAllChangesInFile(target, tracker.getReviewToken(target))
                        : action === 'block' ? await tracker.keepBlock(target, tracker.getChangeBlocks(target)[0].blockId, tracker.getReviewToken(target))
                        : await tracker.keepAllChanges(tracker.getReviewTokens());
                    image = crashImage(ctx);
                } finally {
                    vscode.workspace.fs.writeFile = originalWrite;
                    vscode.workspace.fs.delete = originalDelete;
                    fs.unlinkSync = originalUnlink;
                }
                assert.ok(injected, 'the production durability boundary must actually be exercised');
                if (action === 'batch') { assert.equal(result.succeeded, 0); assert.equal(result.failed, 2); }
                else assert.notEqual(result.status, 'success');
                for (const p of ctx.targets) {
                    assert.equal(tracker.getOriginalContent(p), before);
                    assert.ok(pending(tracker, p));
                }
                assert.deepEqual(snapshot(ctx), disk);
                await readCrashImage(ctx, image, async recovered => {
                    for (const p of ctx.targets) {
                        assert.equal(recovered.getOriginalContent(p), before);
                        assert.ok(pending(recovered, p));
                    }
                    assert.equal(recovered.isRecoveryBlocked(), false);
                    assert.deepEqual(saved(image).gitContexts, [ctx.a]);
                });
            }));
        }
    }
    test('CROSS-BRANCH-KEEP CRASH restores preexisting pending-scope Unknown evidence', () => fixture(async ctx => {
        const { tracker, target } = ctx;
        const excluded = ctx.targets[1];
        const requested = validateAndCanonicalizeScope({ mode: 'rules', includes: [],
            excludes: [{ scope: 'all', pattern: path.basename(excluded) }] }, tracker.currentWorkspaceRootIdentities());
        assert.equal(requested.ok, true);
        tracker.setPendingMonitoringScope(requested.scope);
        assert.equal(pending(tracker, excluded)?.reviewKind, 'unknown');
        assert.equal(await tracker.flushPendingPersistence(), true);
        const gate = pause(path.join(ctx.storage, 'session-state.json'), 'copy');
        const operation = tracker.keepAllChangesInFile(target, tracker.getReviewToken(target));
        let image;
        try {
            await Promise.race([gate.entered, operation.then(result => { throw new Error(`Keep ended before pending-scope crash: ${JSON.stringify(result)}`); })]);
            image = crashImage(ctx);
            git(ctx.workspace, 'checkout', 'branch-c');
            ctx.setLive([{ ...ctx.b, headName: 'branch-c' }]);
        } finally { gate.release(); }
        await operation;
        await readCrashImage(ctx, image, async recovered => {
            assert.equal(recovered.getOriginalContent(target), before);
            assert.equal(recovered.getOriginalContent(excluded), before);
            assert.equal(pending(recovered, excluded)?.reviewKind, 'unknown');
            assert.ok(pending(recovered, excluded)?.unavailableReason);
            // Pending settings are not reapplied on startup. Recovery retains
            // their uncertainty as a durable gap requiring explicit review.
            assert.equal(recovered.coverageGaps.get(excluded)?.file?.reasonCode, 'pending-scope-gap');
            assert.equal(recovered.getReviewToken(excluded), undefined);
        });
    }));
    for (const action of ['file', 'block', 'batch']) {
        test(`CROSS-BRANCH-KEEP BACKUP ${action} cleanup failure cannot undo durable success`, () => fixture(async ctx => {
            const { tracker, target } = ctx;
            const backup = path.join(ctx.storage, 'session-state.pre-keep.json');
            const originalDelete = vscode.workspace.fs.delete;
            const originalUnlink = fs.unlinkSync;
            let injected = 0;
            const fail = () => { injected++; throw Object.assign(new Error('injected obsolete backup cleanup failure'), { code: 'EACCES' }); };
            vscode.workspace.fs.delete = async (uri, ...args) => {
                if (uri.fsPath === backup) fail();
                return originalDelete(uri, ...args);
            };
            fs.unlinkSync = (targetPath, ...args) => {
                if (String(targetPath) === backup) fail();
                return originalUnlink(targetPath, ...args);
            };
            let result, image;
            const disk = snapshot(ctx);
            try {
                result = action === 'file' ? await tracker.keepAllChangesInFile(target, tracker.getReviewToken(target))
                    : action === 'block' ? await tracker.keepBlock(target, tracker.getChangeBlocks(target)[0].blockId, tracker.getReviewToken(target))
                    : await tracker.keepAllChanges(tracker.getReviewTokens());
                image = crashImage(ctx);
            } finally {
                vscode.workspace.fs.delete = originalDelete;
                fs.unlinkSync = originalUnlink;
            }
            assert.ok(injected, 'successful Keep must attempt to remove the obsolete backup');
            if (action === 'batch') { assert.equal(result.succeeded, 2); assert.equal(result.failed, 0); }
            else assert.equal(result.status, 'success', result.reason);
            assert.equal(tracker.isRecoveryBlocked(), false);
            const accepted = action === 'block' ? before.replace('old first', 'new first') : after;
            assert.equal(tracker.getOriginalContent(target), accepted);
            assert.equal(saved(ctx.storage).fileSnapshots.find(([p]) => p === target)?.[1], accepted);
            assert.equal(fs.existsSync(path.join(ctx.storage, 'session-state.keep-in-progress.json')), false);
            assert.equal(fs.existsSync(backup), true, 'cleanup failure may leave only an inert backup');
            const recovered = new DiffTracker(Uri.file(image));
            recovered.setGitContextProvider(() => [ctx.b]);
            try {
                assert.equal(await recovered.restorePersistedState(), 'restored');
                assert.equal(recovered.getOriginalContent(target), accepted, 'inert leftover backup must never revert a committed baseline');
                assert.equal(recovered.isRecoveryBlocked(), false);
                assert.equal(fs.existsSync(path.join(image, 'session-state.pre-keep.json')), false,
                    'startup must retry cleanup after a transient obsolete-backup deletion failure');
            } finally { await recovered.dispose(); }
            assert.deepEqual(snapshot(ctx), disk);
        }));
    }
    test('CROSS-BRANCH-KEEP BACKUP failed recovery retains complete before-images until a successful retry', () => fixture(async ctx => {
        const { tracker, target } = ctx;
        const gate = pause(path.join(ctx.storage, 'session-state.json'), 'copy');
        const operation = tracker.keepAllChangesInFile(target, tracker.getReviewToken(target));
        let image;
        try {
            await Promise.race([gate.entered, operation.then(result => { throw new Error(`Keep ended before recovery-failure setup: ${JSON.stringify(result)}`); })]);
            image = crashImage(ctx);
            git(ctx.workspace, 'checkout', 'branch-c');
            ctx.setLive([{ ...ctx.b, headName: 'branch-c' }]);
        } finally { gate.release(); }
        await operation;
        const backup = path.join(image, 'session-state.pre-keep.json');
        const intent = path.join(image, 'session-state.keep-in-progress.json');
        const beforeBackup = fs.readFileSync(backup);
        const beforeIntent = fs.readFileSync(intent);
        const originalWrite = vscode.workspace.fs.writeFile;
        vscode.workspace.fs.writeFile = async (uri, ...args) => {
            if (uri.fsPath === path.join(image, 'session-state.tmp.json')) throw new Error('injected recovery persistence failure');
            return originalWrite(uri, ...args);
        };
        const recovered = new DiffTracker(Uri.file(image));
        recovered.setGitContextProvider(() => [{ ...ctx.b, headName: 'branch-c' }]);
        try {
            assert.equal(await recovered.restorePersistedState(), 'blocked');
            assert.equal(recovered.isRecoveryBlocked(), true);
            assert.deepEqual(fs.readFileSync(backup), beforeBackup);
            assert.deepEqual(fs.readFileSync(intent), beforeIntent);
        } finally {
            vscode.workspace.fs.writeFile = originalWrite;
            await recovered.dispose();
        }
        assert.deepEqual(fs.readFileSync(backup), beforeBackup, 'blocked shutdown must preserve the recovery backup');
        await readCrashImage(ctx, image, async retried => {
            assert.equal(retried.getOriginalContent(target), before);
            assert.ok(pending(retried, target));
        });
    }));
    for (const action of ['file', 'block', 'batch']) {
        test(`CROSS-BRANCH-KEEP ${action} only changes the reviewed baseline and preserves pause through reload`, () => fixture(async ctx => {
            const { tracker, target } = ctx;
            const disk = snapshot(ctx);
            const contexts = saved(ctx.storage).gitContexts;
            const tokens = tracker.getReviewTokens();
            const blocks = tracker.getChangeBlocks(target);
            assert.ok(blocks.length >= 2);
            const result = action === 'file' ? await tracker.keepAllChangesInFile(target, tracker.getReviewToken(target))
                : action === 'block' ? await tracker.keepBlock(target, blocks[0].blockId, tracker.getReviewToken(target))
                : await tracker.keepAllChanges(tokens);
            if (action === 'batch') assert.equal(result.succeeded, 2, JSON.stringify(result));
            else assert.equal(result.status, 'success', result.reason);
            assert.deepEqual(snapshot(ctx), disk, 'Keep must not edit bytes, executable modes, HEAD, index or status');
            assert.ok(tracker.getGitPauseReason(target), 'Keep must not resume branch-paused recording');
            assert.deepEqual(saved(ctx.storage).gitContexts, contexts, 'Keep must not rebase the session Git identity');
            if (action === 'block') {
                assert.match(tracker.getOriginalContent(target), /^new first/);
                assert.match(tracker.getOriginalContent(target), /old last/);
                assert.ok(pending(tracker, target));
            } else assert.equal(tracker.getOriginalContent(target), after);
            const reloaded = await ctx.restart();
            assert.ok(reloaded.getGitPauseReason(target));
            assert.deepEqual(saved(ctx.storage).gitContexts, contexts);
            assert.equal(reloaded.getOriginalContent(target), action === 'block' ? before.replace('old first', 'new first') : after);
        }));
    }
    test('CROSS-BRANCH-KEEP same-branch normal Keep remains available', () => fixture(async ctx => {
        assert.equal((await ctx.tracker.keepAllChangesInFile(ctx.target)).status, 'success');
        assert.equal(ctx.tracker.getGitPauseReason(ctx.target), undefined);
    }, { crossBranch: false }));
    for (const action of ['file', 'block', 'batch']) {
        test(`CROSS-BRANCH-KEEP stale ${action} token retains review with accurate batch partial counts`, () => fixture(async ctx => {
            const { tracker, target } = ctx;
            const tokens = tracker.getReviewTokens();
            const token = tracker.getReviewToken(target);
            const block = tracker.getChangeBlocks(target)[0];
            fs.writeFileSync(target, `${after}newer unreviewed change\n`);
            const result = action === 'batch' ? await tracker.keepAllChanges(tokens)
                : action === 'file' ? await tracker.keepAllChangesInFile(target, token)
                : await tracker.keepBlock(target, block.blockId, token);
            if (action === 'batch') { assert.equal(result.succeeded, 1); assert.equal(result.failed, 1); }
            else assert.notEqual(result.status, 'success');
            assert.equal(tracker.getOriginalContent(target), before);
            assert.ok(pending(tracker, target));
        }));
    }
    for (const mutation of ['branch-c', 'merge', 'identity', 'unavailable', 'dirty', 'disk']) {
        for (const action of ['file', 'block']) {
            test(`CROSS-BRANCH-KEEP ${action} rolls back when ${mutation} changes during persistence`, () => fixture(async ctx => {
                const { tracker, target } = ctx;
                const token = tracker.getReviewToken(target);
                const block = tracker.getChangeBlocks(target)[0];
                const gate = pause(path.join(ctx.storage, 'session-state.tmp.json'), 'write');
                const operation = action === 'file' ? tracker.keepAllChangesInFile(target, token)
                    : tracker.keepBlock(target, block.blockId, token);
                try {
                    await Promise.race([gate.entered, operation.then(result => { throw new Error(`Keep ended before write barrier: ${JSON.stringify(result)}`); })]);
                    if (mutation === 'branch-c') { git(ctx.workspace, 'checkout', 'branch-c'); ctx.setLive([{ ...ctx.b, headName: 'branch-c' }]); }
                    if (mutation === 'merge') ctx.setLive([{ ...ctx.b, inProgress: true }]);
                    if (mutation === 'identity') ctx.setLive([{ ...ctx.b, kind: 'worktree' }]);
                    if (mutation === 'unavailable') ctx.setLive(undefined);
                    if (mutation === 'dirty') { const doc = document(target); doc.text = 'unsaved new work\n'; doc.isDirty = true; doc.version++; }
                    if (mutation === 'disk') fs.writeFileSync(target, 'new disk work during Keep\n');
                } finally { gate.release(); }
                const disk = snapshot(ctx);
                const result = await operation;
                assert.notEqual(result.status, 'success', JSON.stringify(result));
                assert.equal(tracker.getOriginalContent(target), before);
                assert.ok(pending(tracker, target));
                assert.equal(saved(ctx.storage).fileSnapshots.find(([p]) => p === target)?.[1], before, 'rollback must reach durable state');
                assert.deepEqual(saved(ctx.storage).gitContexts, [ctx.a]);
                assert.deepEqual(snapshot(ctx), disk, 'failure must not overwrite concurrent workspace work');
            }));
        }
    }
    for (const mutation of ['branch-c', 'disk']) {
        for (const action of ['file', 'block', 'batch']) {
            test(`CROSS-BRANCH-KEEP ${action} restores durable baseline after primary publication and ${mutation} race`, () => fixture(async ctx => {
                const { tracker, target } = ctx;
                const token = tracker.getReviewToken(target);
                const block = tracker.getChangeBlocks(target)[0];
                const gate = pause(path.join(ctx.storage, 'session-state.json'), 'copy');
                const operation = action === 'file' ? tracker.keepAllChangesInFile(target, token)
                    : action === 'block' ? tracker.keepBlock(target, block.blockId, token)
                    : tracker.keepAllChanges(tracker.getReviewTokens());
                try {
                    await Promise.race([gate.entered, operation.then(result => { throw new Error(`Keep ended before primary-copy barrier: ${JSON.stringify(result)}`); })]);
                    assert.notEqual(saved(ctx.storage).fileSnapshots.find(([p]) => p === target)?.[1], before,
                        'candidate baseline must have reached primary for this regression');
                    if (mutation === 'branch-c') { git(ctx.workspace, 'checkout', 'branch-c'); ctx.setLive([{ ...ctx.b, headName: 'branch-c' }]); }
                    else fs.writeFileSync(target, 'new disk work after primary publication\n');
                } finally { gate.release(); }
                const disk = snapshot(ctx);
                const result = await operation;
                if (action === 'batch') {
                    assert.equal(result.failed, mutation === 'branch-c' ? 2 : 1);
                    assert.equal(result.succeeded, mutation === 'branch-c' ? 0 : 1);
                } else assert.notEqual(result.status, 'success');
                assert.equal(tracker.getOriginalContent(target), before);
                assert.equal(saved(ctx.storage).fileSnapshots.find(([p]) => p === target)?.[1], before);
                assert.deepEqual(snapshot(ctx), disk);
            }));
        }
    }
    test('CROSS-BRANCH-KEEP reviewed branch token rejects a switch before clicking Keep', () => fixture(async ctx => {
        const token = ctx.tracker.getReviewToken(ctx.target);
        git(ctx.workspace, 'checkout', 'branch-c');
        ctx.setLive([{ ...ctx.b, headName: 'branch-c' }]);
        assert.notEqual((await ctx.tracker.keepAllChangesInFile(ctx.target, token)).status, 'success');
        assert.equal(ctx.tracker.getOriginalContent(ctx.target), before);
        assert.ok(pending(ctx.tracker, ctx.target));
    }));
    for (const phase of ['temporary write', 'primary publication']) {
        for (const action of ['file', 'block', 'batch']) {
            test(`CROSS-BRANCH-KEEP ${action} retains Unknown coverage when scope changes during ${phase}`, () => fixture(async ctx => {
                const { tracker, target } = ctx;
                const token = tracker.getReviewToken(target);
                const block = tracker.getChangeBlocks(target)[0];
                const requested = validateAndCanonicalizeScope({ mode: 'rules', includes: [],
                    excludes: [{ scope: 'all', pattern: path.basename(target) }] }, tracker.currentWorkspaceRootIdentities());
                assert.equal(requested.ok, true, JSON.stringify(requested.errors));
                const gate = phase === 'temporary write'
                    ? pause(path.join(ctx.storage, 'session-state.tmp.json'), 'write')
                    : pause(path.join(ctx.storage, 'session-state.json'), 'copy');
                const operation = action === 'file' ? tracker.keepAllChangesInFile(target, token)
                    : action === 'block' ? tracker.keepBlock(target, block.blockId, token)
                    : tracker.keepAllChanges(tracker.getReviewTokens());
                try {
                    await Promise.race([gate.entered, operation.then(result => { throw new Error(`Keep ended before scope-change barrier: ${JSON.stringify(result)}`); })]);
                    if (phase === 'primary publication') assert.notEqual(saved(ctx.storage).fileSnapshots.find(([p]) => p === target)?.[1], before);
                    tracker.setPendingMonitoringScope(requested.scope);
                    assert.equal(tracker.getReviewToken(target), undefined);
                    assert.equal(pending(tracker, target)?.reviewKind, 'unknown');
                    assert.equal(tracker.coverageGaps.get(target)?.file?.reasonCode, 'pending-explicit-exclusion');
                } finally { gate.release(); }
                const disk = snapshot(ctx);
                const result = await operation;
                if (action === 'batch') {
                    assert.equal(result.failed, 1, JSON.stringify(result));
                    assert.equal(result.succeeded, 1, JSON.stringify(result));
                } else assert.notEqual(result.status, 'success');
                assert.equal(tracker.getOriginalContent(target), before);
                assert.equal(saved(ctx.storage).fileSnapshots.find(([p]) => p === target)?.[1], before);
                assert.equal(pending(tracker, target)?.reviewKind, 'unknown');
                assert.ok(pending(tracker, target)?.unavailableReason);
                assert.equal(tracker.coverageGaps.get(target)?.file?.reasonCode, 'pending-explicit-exclusion');
                assert.equal(saved(ctx.storage).coverageGaps.find(([p]) => p === target)?.[1]?.file?.reasonCode, 'pending-explicit-exclusion');
                assert.equal(tracker.getReviewToken(target), undefined);
                assert.deepEqual(snapshot(ctx), disk);
            }));
        }
    }
    for (const phase of ['temporary write', 'primary publication']) {
        for (const action of ['file', 'block']) {
            test(`CROSS-BRANCH-KEEP ${action} retains newly unavailable review without a coverage gap during ${phase}`, () => fixture(async ctx => {
                const { tracker, target } = ctx;
                const token = tracker.getReviewToken(target);
                const block = tracker.getChangeBlocks(target)[0];
                const reason = 'Concurrent observation failure while accepting the reviewed baseline';
                const gate = phase === 'temporary write'
                    ? pause(path.join(ctx.storage, 'session-state.tmp.json'), 'write')
                    : pause(path.join(ctx.storage, 'session-state.json'), 'copy');
                const operation = action === 'file' ? tracker.keepAllChangesInFile(target, token)
                    : tracker.keepBlock(target, block.blockId, token);
                try {
                    await Promise.race([gate.entered, operation.then(result => { throw new Error(`Keep ended before unavailable-review barrier: ${JSON.stringify(result)}`); })]);
                    if (phase === 'primary publication') assert.notEqual(saved(ctx.storage).fileSnapshots.find(([p]) => p === target)?.[1], before);
                    tracker.markFileUnavailable(target, reason);
                    assert.equal(tracker.coverageGaps.get(target)?.file, undefined,
                        'classification guard must work independently of coverage evidence');
                    assert.equal(tracker.getReviewToken(target), undefined);
                    assert.equal(pending(tracker, target)?.reviewKind, 'unknown');
                } finally { gate.release(); }
                const disk = snapshot(ctx);
                const result = await operation;
                assert.notEqual(result.status, 'success');
                assert.equal(tracker.getOriginalContent(target), before);
                assert.equal(saved(ctx.storage).fileSnapshots.find(([p]) => p === target)?.[1], before);
                assert.equal(pending(tracker, target)?.reviewKind, 'unknown');
                assert.equal(pending(tracker, target)?.unavailableReason, reason);
                assert.equal(tracker.coverageGaps.get(target)?.file, undefined);
                assert.equal(tracker.getReviewToken(target), undefined);
                assert.deepEqual(snapshot(ctx), disk);
            }));
        }
    }
    for (const mutation of ['pending exclusion', 'unavailable review']) {
        for (const action of ['file', 'block']) {
            test(`CROSS-BRANCH-KEEP committed ${action} preserves ${mutation} arriving during final refresh`, () => fixture(async ctx => {
                const { tracker, target } = ctx;
                const token = tracker.getReviewToken(target);
                const block = tracker.getChangeBlocks(target)[0];
                const accepted = action === 'file' ? after : before.replace('old first', 'new first');
                const publication = pause(path.join(ctx.storage, 'session-state.json'), 'copy');
                const operation = action === 'file' ? tracker.keepAllChangesInFile(target, token)
                    : tracker.keepBlock(target, block.blockId, token);
                let refresh;
                try {
                    await Promise.race([publication.entered, operation.then(result => { throw new Error(`Keep ended before final-refresh setup: ${JSON.stringify(result)}`); })]);
                    // Install only after publication starts: earlier validation reads must not consume this gate.
                    refresh = pause(target, 'read');
                } finally { publication.release(); }
                try {
                    await Promise.race([refresh.entered, operation.then(result => { throw new Error(`Keep ended before final-refresh read: ${JSON.stringify(result)}`); })]);
                    assert.equal(tracker.baselineTransaction, undefined, 'the acceptance transaction must already be committed');
                    assert.equal(tracker.getOriginalContent(target), accepted);
                    assert.equal(saved(ctx.storage).fileSnapshots.find(([p]) => p === target)?.[1], accepted);
                    if (mutation === 'pending exclusion') {
                        const requested = validateAndCanonicalizeScope({ mode: 'rules', includes: [],
                            excludes: [{ scope: 'all', pattern: path.basename(target) }] }, tracker.currentWorkspaceRootIdentities());
                        assert.equal(requested.ok, true);
                        tracker.setPendingMonitoringScope(requested.scope);
                    } else tracker.markFileUnavailable(target, 'New uncertainty after committed Keep');
                    assert.equal(pending(tracker, target)?.reviewKind, 'unknown');
                    assert.equal(tracker.getReviewToken(target), undefined);
                } finally { refresh?.release(); }
                const disk = snapshot(ctx);
                const result = await operation;
                assert.equal(result.status, 'success', result.reason);
                assert.equal(tracker.getOriginalContent(target), accepted, 'new evidence cannot roll back an already committed Keep');
                assert.equal(saved(ctx.storage).fileSnapshots.find(([p]) => p === target)?.[1], accepted);
                assert.equal(pending(tracker, target)?.reviewKind, 'unknown');
                assert.ok(pending(tracker, target)?.unavailableReason);
                assert.equal(tracker.getReviewToken(target), undefined);
                if (mutation === 'pending exclusion') assert.equal(tracker.coverageGaps.get(target)?.file?.reasonCode, 'pending-explicit-exclusion');
                else assert.equal(tracker.coverageGaps.get(target)?.file, undefined);
                assert.deepEqual(snapshot(ctx), disk);
            }));
        }
    }
    for (const state of ['unavailable', 'merge', 'identity', 'detached']) {
        test(`CROSS-BRANCH-KEEP authoritative ${state} provider blocks stale cached safe context`, () => fixture(async ctx => {
            ctx.setLive(state === 'unavailable' ? undefined : [{ ...ctx.b,
                ...(state === 'merge' ? { inProgress: true } : state === 'identity' ? { kind: 'worktree' } : { detached: true, headName: undefined }) }]);
            const disk = snapshot(ctx);
            assert.notEqual((await ctx.tracker.keepAllChangesInFile(ctx.target)).status, 'success');
            assert.equal(ctx.tracker.getOriginalContent(ctx.target), before);
            assert.deepEqual(snapshot(ctx), disk);
        }));
    }
    test('CROSS-BRANCH-KEEP live branch B without the corresponding tracker observation is rejected', () => fixture(async ctx => {
        const { tracker, target } = ctx;
        git(ctx.workspace, 'checkout', 'branch-b');
        ctx.setLive([ctx.b]);
        assert.equal(tracker.getGitPauseReason(target), undefined);
        const disk = snapshot(ctx);
        assert.notEqual((await tracker.keepAllChangesInFile(target)).status, 'success');
        assert.equal(tracker.getOriginalContent(target), before);
        assert.deepEqual(saved(ctx.storage).gitContexts, [ctx.a]);
        assert.deepEqual(snapshot(ctx), disk);
    }, { crossBranch: false }));
    test('CROSS-BRANCH-KEEP observed repository removal overrides a stale live branch B snapshot', () => fixture(async ctx => {
        const { tracker, target } = ctx;
        tracker.observeGitRepositoryRemoved(ctx.workspace);
        const disk = snapshot(ctx);
        assert.notEqual((await tracker.keepAllChangesInFile(target)).status, 'success');
        assert.equal(tracker.getOriginalContent(target), before);
        assert.ok(tracker.getGitPauseReason(target));
        assert.deepEqual(saved(ctx.storage).gitContexts, [ctx.a]);
        assert.deepEqual(snapshot(ctx), disk);
    }));
    test('CROSS-BRANCH-KEEP returning to branch A revalidates pause and preserves Keep baselines', () => fixture(async ctx => {
        const { tracker, target } = ctx;
        git(ctx.workspace, 'checkout', 'branch-a');
        ctx.setLive([ctx.a]);
        tracker.observeGitContext(ctx.a);
        assert.equal(tracker.getGitPauseReason(target), undefined);
        const disk = snapshot(ctx);
        assert.equal((await tracker.keepAllChangesInFile(target)).status, 'success');
        assert.equal(tracker.getOriginalContent(target), after);
        assert.equal(tracker.getGitPauseReason(target), undefined);
        assert.deepEqual(saved(ctx.storage).gitContexts, [ctx.a]);
        assert.deepEqual(snapshot(ctx), disk);
        assert.equal((await tracker.revertFile(ctx.targets[1])).status, 'success');
        const reloaded = await ctx.restart();
        assert.equal(reloaded.getOriginalContent(target), after);
        assert.deepEqual(saved(ctx.storage).gitContexts, [ctx.a]);
    }));
    test('CROSS-BRANCH-KEEP mixed Accept keeps text while opaque and Unknown remain strict', () => fixture(async ctx => {
        const { tracker } = ctx;
        assert.equal(pending(tracker, ctx.opaque)?.reviewKind, 'opaque');
        assert.equal(pending(tracker, ctx.unknown)?.reviewKind, 'unknown');
        const result = await tracker.acceptAllPendingChanges();
        assert.equal(result.accepted, 2, JSON.stringify(result));
        assert.equal(result.acknowledged, 0);
        assert.equal(result.failed, 2);
        assert.equal(pending(tracker, ctx.opaque)?.reviewKind, 'opaque');
        assert.equal(pending(tracker, ctx.unknown)?.reviewKind, 'unknown');
        assert.ok(tracker.getGitPauseReason(ctx.target));
    }, { mixed: true }));
    test('CROSS-BRANCH-KEEP Revert retains strict Git pause', () => fixture(async ctx => {
        const disk = snapshot(ctx);
        assert.notEqual((await ctx.tracker.revertFile(ctx.target)).status, 'success');
        assert.equal((await ctx.tracker.revertAllChanges()).succeeded, 0);
        assert.deepEqual(snapshot(ctx), disk);
    }));
    test('CROSS-BRANCH-KEEP Undo remains strict after switching branches', () => fixture(async ctx => {
        const { tracker } = ctx;
        assert.equal((await tracker.revertFile(ctx.target)).status, 'success');
        git(ctx.workspace, 'checkout', 'branch-b');
        ctx.setLive([ctx.b]);
        tracker.observeGitContext(ctx.b);
        const disk = snapshot(ctx);
        assert.equal((await tracker.undoLastRevert()).succeeded, 0);
        assert.deepEqual(snapshot(ctx), disk);
    }, { crossBranch: false }));
    test('CROSS-BRANCH-KEEP persistence failure rolls back baseline and preserves review', () => fixture(async ctx => {
        const original = vscode.workspace.fs.writeFile;
        vscode.workspace.fs.writeFile = async (uri, ...args) => {
            if (uri.fsPath === path.join(ctx.storage, 'session-state.tmp.json')) throw new Error('injected storage failure');
            return original(uri, ...args);
        };
        const disk = snapshot(ctx);
        let result;
        try { result = await ctx.tracker.keepAllChangesInFile(ctx.target); }
        finally { vscode.workspace.fs.writeFile = original; }
        assert.notEqual(result.status, 'success');
        assert.equal(ctx.tracker.getOriginalContent(ctx.target), before);
        assert.ok(pending(ctx.tracker, ctx.target));
        assert.equal(saved(ctx.storage).fileSnapshots.find(([p]) => p === ctx.target)?.[1], before);
        assert.deepEqual(snapshot(ctx), disk);
    }));
}
