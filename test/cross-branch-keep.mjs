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
    test('CROSS-BRANCH-KEEP returning to branch A permits Keep but preserves sticky pause and strict Revert', () => fixture(async ctx => {
        const { tracker, target } = ctx;
        const reason = tracker.getGitPauseReason(target);
        git(ctx.workspace, 'checkout', 'branch-a');
        ctx.setLive([ctx.a]);
        tracker.observeGitContext(ctx.a);
        assert.equal(tracker.getGitPauseReason(target), reason);
        const disk = snapshot(ctx);
        assert.notEqual((await tracker.revertFile(target)).status, 'success');
        assert.equal((await tracker.keepAllChangesInFile(target)).status, 'success');
        assert.equal(tracker.getOriginalContent(target), after);
        assert.equal(tracker.getGitPauseReason(target), reason);
        assert.deepEqual(saved(ctx.storage).gitContexts, [ctx.a]);
        assert.notEqual((await tracker.revertFile(ctx.targets[1])).status, 'success');
        assert.deepEqual(snapshot(ctx), disk);
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
