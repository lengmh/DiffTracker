/** Count rendering uses one ephemeral Git snapshot; actions retain fresh verification. */
import assert from 'node:assert/strict';
import fs from 'node:fs';

export function registerKeepCountSnapshot(h) {
    const { test, root, file, seed, scan, getTracker } = h;
    async function fixture(run) {
        const tracker = getTracker();
        const a = { repoRoot: root, kind: 'repository', headName: 'count-a',
            headCommit: 'a'.repeat(40), detached: false, inProgress: false };
        const b = { ...a, headName: 'count-b' };
        tracker.setBaselineGitContexts([a]);
        const paths = [file('count-first.txt'), file('count-second.txt'), file('count-third.txt')];
        for (const target of paths) { seed(target, 'before\n', 'reviewed current\n'); await scan(target); }
        tracker.observeGitContext(b);
        let live = [b];
        let calls = 0;
        tracker.setGitContextProvider(() => { calls++; return live; });
        const tokens = tracker.getReviewTokens();
        assert.equal(tokens.length, paths.length);
        calls = 0;
        await run({ tracker, paths, tokens, a, b,
            calls: () => calls, resetCalls: () => { calls = 0; }, setLive: value => { live = value; } });
    }

    test('KEEP-COUNT-SNAPSHOT multiple and duplicate tokens use exactly one live snapshot', () => fixture(async ctx => {
        assert.equal(ctx.tracker.getCrossBranchKeepCount([...ctx.tokens, ctx.tokens[0]]), 3);
        assert.equal(ctx.calls(), 1, 'one synchronous count must not rescan repositories for every token');
    }));

    test('KEEP-COUNT-SNAPSHOT next count obtains fresh unavailable and restored context', () => fixture(async ctx => {
        assert.equal(ctx.tracker.getCrossBranchKeepCount(ctx.tokens), 3);
        assert.equal(ctx.calls(), 1);
        ctx.setLive(undefined);
        ctx.resetCalls();
        assert.equal(ctx.tracker.getCrossBranchKeepCount(ctx.tokens), 0);
        assert.equal(ctx.calls(), 1, 'unavailable context must not reuse an earlier count snapshot');
        ctx.setLive([ctx.b]);
        ctx.resetCalls();
        assert.equal(ctx.tracker.getCrossBranchKeepCount(ctx.tokens), 3);
        assert.equal(ctx.calls(), 1);
    }));

    test('KEEP-COUNT-SNAPSHOT next count respects branch change and newly reviewed tokens', () => fixture(async ctx => {
        assert.equal(ctx.tracker.getCrossBranchKeepCount(ctx.tokens), 3);
        const c = { ...ctx.b, headName: 'count-c' };
        ctx.setLive([c]);
        ctx.tracker.observeGitContext(c);
        ctx.resetCalls();
        assert.equal(ctx.tracker.getCrossBranchKeepCount(ctx.tokens), 0, 'branch B tokens are stale on branch C');
        assert.equal(ctx.calls(), 1);
        const reviewedOnC = ctx.tracker.getReviewTokens();
        ctx.resetCalls();
        assert.equal(ctx.tracker.getCrossBranchKeepCount(reviewedOnC), 3);
        assert.equal(ctx.calls(), 1);
    }));

    for (const action of ['file', 'block', 'batch']) {
        test(`KEEP-COUNT-SNAPSHOT ${action} action verifies fresh Git state after a successful count`, () => fixture(async ctx => {
            const target = ctx.paths[0];
            const block = ctx.tracker.getChangeBlocks(target)[0];
            assert.equal(ctx.tracker.getCrossBranchKeepCount(ctx.tokens), 3);
            ctx.setLive([{ ...ctx.b, headName: 'count-c' }]);
            ctx.resetCalls();
            const result = action === 'file' ? await ctx.tracker.keepAllChangesInFile(target, ctx.tokens[0])
                : action === 'block' ? await ctx.tracker.keepBlock(target, block.blockId, ctx.tokens[0])
                : await ctx.tracker.keepAllChanges(ctx.tokens);
            if (action === 'batch') { assert.equal(result.succeeded, 0); assert.equal(result.failed, 3); }
            else assert.notEqual(result.status, 'success');
            assert.ok(ctx.calls() > 0, 'an action must call the live provider rather than reuse count-time context');
            for (const p of ctx.paths) {
                assert.equal(ctx.tracker.getOriginalContent(p), 'before\n');
                assert.equal(fs.readFileSync(p, 'utf8'), 'reviewed current\n');
            }
        }));
    }
}
