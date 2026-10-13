import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/** Production tracker with a controlled authoritative Git boundary; no copied policy. */
export function registerIssue41GitResume(h) {
    const { test, file, seed, scan, Uri, pause, getTracker } = h;
    async function fixture(run) {
        const tracker = getTracker();
        const repo = file('issue41-repo'); fs.mkdirSync(repo);
        const target = path.join(repo, 'review.txt');
        seed(target, 'before\n', 'pending\n'); await scan(target);
        const a = { repoRoot: repo, kind: 'repository', headName: 'a', headCommit: 'a'.repeat(40), detached: false, inProgress: false };
        const b = { ...a, headName: 'b', headCommit: 'b'.repeat(40) };
        let live = [a];
        tracker.setGitContextProvider(() => live);
        tracker.setBaselineGitContexts([a]);
        const observe = context => { live = [context]; return tracker.observeGitContext(context); };
        await run({ tracker, target, a, b, observe, setLive: value => { live = value; } });
    }
    for (const transition of ['branch', 'operation', 'removed']) {
        test(`ISSUE41-GIT resume ${transition} preserves baseline, pending and Undo`, () => fixture(async ctx => {
            const { tracker, target, a, b, observe } = ctx;
            const before = tracker.getOriginalContent(target);
            tracker.revertHistory = [{ id: 'preserved', createdAt: new Date().toISOString(), items: [tracker.createFileRevertItem(target)] }];
            const history = JSON.stringify(tracker.revertHistory);
            if (transition === 'removed') { ctx.setLive([]); tracker.observeGitRepositoryRemoved(a.repoRoot); }
            else observe(transition === 'branch' ? b : { ...a, inProgress: true });
            assert.ok(tracker.getGitPauseReason(target));
            assert.notEqual((await tracker.revertFile(target)).status, 'success');
            observe(a);
            assert.equal(tracker.getGitPauseReason(target), undefined);
            assert.equal(tracker.getOriginalContent(target), before);
            assert.equal(tracker.getTrackedChange(target).currentContent, 'pending\n');
            assert.equal(JSON.stringify(tracker.revertHistory), history);
            assert.equal(fs.readFileSync(target, 'utf8'), 'pending\n');
        }));
    }
    test('ISSUE41-GIT return with new commit preserves same-branch compatibility', () => fixture(async ctx => {
        ctx.observe(ctx.b); ctx.observe({ ...ctx.a, headCommit: 'c'.repeat(40) });
        assert.equal(ctx.tracker.getGitPauseReason(ctx.target), undefined);
        assert.equal(ctx.tracker.getOriginalContent(ctx.target), 'before\n');
        assert.equal((await ctx.tracker.revertFile(ctx.target)).status, 'success');
    }));
    for (const invalid of ['unavailable', 'unobserved', 'operation', 'kind', 'detached']) {
        test(`ISSUE41-GIT refuses return with ${invalid} authoritative context`, () => fixture(async ctx => {
            ctx.observe(ctx.b);
            ctx.setLive(invalid === 'unavailable' ? undefined : [{ ...ctx.a,
                ...(invalid === 'unobserved' ? { headCommit: 'c'.repeat(40) } : {}),
                ...(invalid === 'operation' ? { inProgress: true } : {}),
                ...(invalid === 'kind' ? { kind: 'worktree' } : {}),
                ...(invalid === 'detached' ? { headName: undefined, detached: true } : {}) }]);
            ctx.tracker.observeGitContext(ctx.a);
            assert.ok(ctx.tracker.getGitPauseReason(ctx.target));
            assert.equal(ctx.tracker.getOriginalContent(ctx.target), 'before\n');
            assert.equal(fs.readFileSync(ctx.target, 'utf8'), 'pending\n');
        }));
    }
    test('ISSUE41-GIT return during Revert cannot revive the in-flight write', () => fixture(async ctx => {
        const { tracker, target, a, b, observe } = ctx;
        const gate = pause(target, 'read');
        const action = tracker.revertFile(target);
        await gate.entered;
        observe(b); observe(a);
        assert.ok(tracker.getGitPauseReason(target), 'keep pause until in-flight recovery action has settled');
        gate.release();
        assert.notEqual((await action).status, 'success');
        assert.equal(fs.readFileSync(target, 'utf8'), 'pending\n');
        assert.equal(tracker.getGitPauseReason(target), undefined, 'settling the old action revalidates the compatible return');
    }));
}
