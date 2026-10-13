import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateAndCanonicalizeScope } from '../out/monitoringScope.js';

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
    for (const available of [true, false]) {
        test(`ISSUE41-GIT initialization release revalidates an observed pause (verified=${available})`, () => fixture(async ctx => {
            const { tracker, target, a, b, observe } = ctx;
            const before = tracker.getOriginalContent(target);
            tracker.revertHistory = [{ id: 'initialization-history', createdAt: new Date().toISOString(), items: [tracker.createFileRevertItem(target)] }];
            const history = JSON.stringify(tracker.revertHistory);
            tracker.setGitContextPending(true);
            observe(b);
            ctx.setLive(available ? [a] : undefined);
            // Both production ready paths reconcile before releasing the gate.
            tracker.reconcileRestoredGitContexts([a]);
            assert.match(tracker.getGitPauseReason(target), /initialization/);
            assert.notEqual((await tracker.revertFile(target)).status, 'success');
            tracker.setGitContextPending(false);
            assert.equal(!!tracker.getGitPauseReason(target), !available);
            assert.equal(tracker.getOriginalContent(target), before);
            assert.equal(tracker.getTrackedChange(target).currentContent, 'pending\n');
            assert.equal(JSON.stringify(tracker.revertHistory), history);
            assert.equal(fs.readFileSync(target, 'utf8'), 'pending\n');
        }));
    }
    for (const gateKind of ['archive restore', 'configured scope']) {
        for (const available of [true, false]) {
            test(`ISSUE41-GIT outer gate release ${gateKind} revalidates an observed pause (verified=${available})`, () => fixture(async ctx => {
                const { tracker, target, a, b, observe } = ctx;
                tracker.revertHistory = [{ id: 'outer-gate-history', createdAt: new Date().toISOString(), items: [tracker.createFileRevertItem(target)] }];
                const before = {
                    baseline: tracker.getOriginalContent(target),
                    pending: JSON.stringify(tracker.getTrackedChange(target)),
                    history: JSON.stringify(tracker.revertHistory),
                    bytes: fs.readFileSync(target)
                };
                let entered, release, transactionEnded, finish;
                const transactionEndedPromise = new Promise(resolve => { transactionEnded = resolve; });
                const finishPromise = new Promise(resolve => { finish = resolve; });
                const enteredPromise = new Promise(resolve => { entered = resolve; });
                const releasePromise = new Promise(resolve => { release = resolve; });
                const method = gateKind === 'archive restore'
                    ? 'performArchivedGitReviewRestore' : 'performConfiguredMonitoringScopeApply';
                const original = tracker[method];
                let rollbacks = 0;
                tracker[method] = async () => {
                    // Exercise the real public wrapper and transaction gates;
                    // only the inner operation is held and conservatively refused.
                    const transaction = gateKind === 'configured scope'
                        ? tracker.beginBaselineTransaction(() => { rollbacks++; }) : undefined;
                    try {
                        entered();
                        await releasePromise;
                        return gateKind === 'archive restore'
                            ? { status: 'refused', reason: 'Controlled restore refusal' }
                            : { status: 'conflict', reason: 'Controlled scope refusal', retainedReviews: 0,
                                discardedReviews: 0, releasedBaselines: 0, capturedBaselines: 0 };
                    } finally {
                        if (transaction) {
                            tracker.endBaselineTransaction(transaction, false);
                            transactionEnded();
                            await finishPromise;
                        }
                    }
                };
                const scope = validateAndCanonicalizeScope({ mode: 'wholeWorkspace', includes: [], excludes: [] },
                    tracker.currentWorkspaceRootIdentities());
                assert.equal(scope.ok, true);
                const action = gateKind === 'archive restore'
                    ? tracker.restoreArchivedGitReview('controlled-restore-token')
                    : tracker.applyConfiguredMonitoringScope(scope.scope);
                try {
                    await Promise.race([enteredPromise, action.then(() => { throw new Error('Operation ended before the outer-gate barrier'); })]);
                    if (gateKind === 'archive restore') {
                        assert.ok(tracker.archiveRestoreTask);
                        assert.equal(tracker.recoveryActionRunning, true);
                    } else {
                        assert.ok(tracker.baselineTransaction);
                        assert.equal(tracker.activeScopeApplications, 1);
                    }
                    observe(b); observe(a);
                    assert.ok(tracker.getGitPauseReason(target), 'compatible return must remain paused while the outer operation is active');
                    if (!available) ctx.setLive(undefined);
                    release();
                    if (gateKind === 'configured scope') {
                        await transactionEndedPromise;
                        assert.equal(tracker.baselineTransaction, undefined);
                        assert.equal(tracker.activeScopeApplications, 1);
                        observe(a);
                        assert.ok(tracker.getGitPauseReason(target),
                            'ending the transaction alone cannot resume while the scope wrapper still owns cleanup');
                        if (!available) ctx.setLive(undefined);
                        finish();
                    }
                    assert.equal((await action).status, gateKind === 'archive restore' ? 'refused' : 'conflict');
                    assert.equal(tracker.archiveRestoreTask, undefined);
                    assert.equal(tracker.recoveryActionRunning, false);
                    assert.equal(tracker.baselineTransaction, undefined);
                    assert.equal(tracker.activeScopeApplications, 0);
                    assert.equal(!!tracker.getGitPauseReason(target), !available,
                        'releasing the last gate revalidates the live provider without needing another Git event');
                    assert.equal(rollbacks, gateKind === 'configured scope' ? 1 : 0);
                    assert.equal(tracker.getOriginalContent(target), before.baseline);
                    assert.equal(JSON.stringify(tracker.getTrackedChange(target)), before.pending);
                    assert.equal(JSON.stringify(tracker.revertHistory), before.history);
                    assert.deepEqual(fs.readFileSync(target), before.bytes);
                } finally {
                    release(); finish();
                    await action;
                    tracker[method] = original;
                }
            }));
        }
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
