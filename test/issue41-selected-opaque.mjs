import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export function registerIssue41SelectedOpaque(h) {
    const { test, file, Uri, DiffTracker, pause, getTracker, setTracker, setListedFiles } = h;
    async function fixture(run) {
        let tracker = getTracker();
        const repo = file('selected-opaque-repo'), storage = file('selected-opaque-storage');
        fs.mkdirSync(repo);
        const target = path.join(repo, 'target.png'), sibling = path.join(repo, 'sibling.png'), text = path.join(repo, 'review.txt');
        const before = Buffer.from([0, 1, 2]), after = Buffer.from([0, 3, 4]);
        fs.writeFileSync(target, before); fs.writeFileSync(sibling, before); fs.writeFileSync(text, 'old text');
        setListedFiles([target, sibling, text].map(Uri.file));
        tracker.storageUri = Uri.file(storage);
        assert.equal(await tracker.resetBaselineToCurrentState(), true);
        const a = { repoRoot: repo, kind: 'repository', headName: 'a', headCommit: 'a'.repeat(40), detached: false, inProgress: false };
        const b = { ...a, headName: 'b', headCommit: 'b'.repeat(40) };
        let live = [a]; tracker.setGitContextProvider(() => live); tracker.setBaselineGitContexts([a]);
        for (const p of [target, sibling]) { fs.writeFileSync(p, after); await tracker.readFileAndUpdate(p, Uri.file(p)); }
        fs.writeFileSync(text, 'pending text'); await tracker.readFileAndUpdate(text, Uri.file(text));
        live = [b]; tracker.observeGitContext(b);
        assert.equal(await tracker.flushPendingPersistence(), true);
        const ctx = { tracker, repo, storage, target, sibling, text, a, b, before, after,
            select: token => tracker.acknowledgeOpaqueChange(target, token ?? tracker.getOpaqueReviewToken(target), { allowCrossBranch: true }),
            setLive: value => { live = value; },
            restart: async () => {
                await tracker.dispose(); tracker = new DiffTracker(Uri.file(storage)); setTracker(tracker);
                tracker.setGitContextProvider(() => live);
                assert.ok(['restored', 'recovered'].includes(await tracker.restorePersistedState()));
                tracker.reconcileRestoredGitContexts(live ?? []);
                return tracker;
            }
        };
        await run(ctx);
    }
    test('ISSUE41-PNG selected acknowledgement preserves siblings, Git pause and original provenance across reload', () => fixture(async ctx => {
        const { tracker, target, sibling, text, a } = ctx;
        const baseline = JSON.stringify([...tracker.baselineGitContexts]);
        tracker.revertHistory = [{ id: 'siblings', createdAt: new Date().toISOString(), items: [tracker.createFileRevertItem(text)] }];
        const history = JSON.stringify(tracker.revertHistory);
        const accepted = await ctx.select();
        assert.equal(accepted.status, 'success', JSON.stringify({accepted, issue: tracker.getPersistenceIssue()}));
        assert.equal(tracker.getTrackedChange(target), undefined);
        assert.equal(tracker.getTrackedChange(sibling).reviewKind, 'opaque');
        assert.equal(tracker.getTrackedChange(text).currentContent, 'pending text');
        assert.equal(JSON.stringify(tracker.revertHistory), history);
        assert.equal(JSON.stringify([...tracker.baselineGitContexts]), baseline);
        assert.ok(tracker.getGitPauseReason(target));
        assert.notEqual((await tracker.revertFile(text)).status, 'success');
        assert.deepEqual(fs.readFileSync(target), ctx.after);
        const restarted = await ctx.restart();
        assert.equal(restarted.getTrackedChange(target), undefined);
        assert.ok(restarted.getGitPauseReason(target));
        assert.ok(restarted.getTrackedChange(sibling));
        ctx.setLive([a]); restarted.observeGitContext(a);
        fs.writeFileSync(target, ctx.before); await restarted.readFileAndUpdate(target, Uri.file(target));
        assert.equal(restarted.getTrackedChange(target).reviewKind, 'opaque', 'returning to different bytes must be pending again');
    }));
    test('ISSUE41-PNG default and mixed-batch acknowledgement remain paused', () => fixture(async ctx => {
        const { tracker, target } = ctx;
        assert.notEqual((await tracker.acknowledgeOpaqueChange(target)).status, 'success');
        const result = await tracker.acceptAllPendingChanges([], tracker.getOpaqueReviewTokens(), []);
        assert.equal(result.succeeded, 0);
        assert.ok(tracker.getTrackedChange(target));
    }));
    for (const persist of [true, false]) test(`ISSUE41-PNG Git change during final hash rejects the candidate (storage=${persist})`, () => fixture(async ctx => {
        if (!persist) ctx.tracker.storageUri = undefined;
        const original = ctx.tracker.acknowledgedIdentityStillCurrent.bind(ctx.tracker);
        let injected = false;
        ctx.tracker.acknowledgedIdentityStillCurrent = (...args) => {
            const valid = original(...args);
            assert.equal(args[0], ctx.target);
            injected = true;
            ctx.setLive([{ ...ctx.b, headName: 'c' }]);
            return valid;
        };
        const result = await ctx.select();
        assert.ok(injected);
        assert.notEqual(result.status, 'success');
        assert.ok(ctx.tracker.getTrackedChange(ctx.target));
        assert.deepEqual(fs.readFileSync(ctx.target), ctx.after);
    }));
    for (const mode of ['touch-once', 'touch-always', 'changed-bytes']) {
        test(`ISSUE41-PNG bounded metadata retry ${mode}`, () => fixture(async ctx => {
            const originalCheck = ctx.tracker.acknowledgedIdentityStillCurrent.bind(ctx.tracker);
            const originalRead = fs.readSync;
            let checking = false, reads = 0;
            let time = fs.statSync(ctx.target).mtimeMs + 1000;
            ctx.tracker.acknowledgedIdentityStillCurrent = (...args) => {
                checking = true;
                try { return originalCheck(...args); } finally { checking = false; }
            };
            fs.readSync = (...args) => {
                const result = originalRead(...args);
                if (checking) {
                    reads++;
                    if (mode === 'touch-always' || reads === 1) {
                        if (mode === 'changed-bytes') fs.writeFileSync(ctx.target, Buffer.from([0, 8, 9]));
                        fs.utimesSync(ctx.target, new Date(time), new Date(time));
                        time += 1000;
                    }
                }
                return result;
            };
            let result;
            try { result = await ctx.select(); } finally { fs.readSync = originalRead; }
            assert.equal(reads, 2, 'one initial identity read and at most one retry');
            assert.equal(result.status === 'success', mode === 'touch-once');
            if (mode === 'touch-once') assert.equal(ctx.tracker.getTrackedChange(ctx.target), undefined);
            else assert.ok(ctx.tracker.getTrackedChange(ctx.target));
        }));
    }
    for (const transition of ['before-action', 'during-persist', 'unavailable', 'operation']) {
        test(`ISSUE41-PNG rejects Git drift ${transition}`, () => fixture(async ctx => {
            const { tracker, target, b } = ctx;
            const token = tracker.getOpaqueReviewToken(target);
            const original = { ...tracker.opaqueBaselineFiles.get(target) };
            if (transition === 'during-persist') {
                const gate = pause(path.join(ctx.storage, 'session-state.tmp.json'), 'write');
                const action = ctx.select(token);
                try {
                    await Promise.race([gate.entered, action.then(r => { throw new Error(`No persistence barrier: ${JSON.stringify(r)}`); })]);
                    ctx.setLive([{ ...b, headName: 'c' }]);
                } finally { gate.release(); }
                assert.notEqual((await action).status, 'success');
            } else {
                const next = transition === 'unavailable' ? undefined : [{ ...b,
                    ...(transition === 'operation' ? { inProgress: true } : { headName: 'c' }) }];
                ctx.setLive(next);
                if (transition === 'before-action') tracker.observeGitContext(next[0]);
                assert.notEqual((await ctx.select(token)).status, 'success');
            }
            assert.deepEqual(tracker.opaqueBaselineFiles.get(target), original);
            assert.ok(tracker.getTrackedChange(target));
            assert.deepEqual(fs.readFileSync(target), ctx.after);
        }));
    }
}
