/** Archived Git review regressions against the production DiffTracker.
 * The shared harness fakes only VS Code boundaries; session parsing, persistence,
 * Git compatibility and filesystem reconciliation are production code.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { validateAndCanonicalizeScope } from '../out/monitoringScope.js';

const ARCHIVE = 'session-state.archive.json';
const BACKUP = 'session-state.pre-restore.json';
const INTENT = 'session-state.restore-in-progress.json';
const PRIMARY = 'session-state.json';

export function registerArchivedGitReview(h) {
    const { test, Uri, DiffTracker, vscode, file, document, faults, counters,
        pause, emitWatcher, waitUntil, watcherInstances, getTracker, setTracker, setListedFiles } = h;

    async function fixture(run, { compatible = true, unknown = false, configured = false } = {}) {
        await getTracker().dispose();
        const previousFolders = vscode.workspace.workspaceFolders;
        const previousGetFolder = vscode.workspace.getWorkspaceFolder;
        const workspace = file('archive-workspace');
        const storage = file('extension-host-storage');
        fs.mkdirSync(workspace);
        fs.mkdirSync(path.join(workspace, '.git'));
        fs.writeFileSync(path.join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n');
        const folder = { uri: Uri.file(workspace), name: 'archive-fixture' };
        vscode.workspace.workspaceFolders = [folder];
        vscode.workspace.getWorkspaceFolder = uri => {
            const relative = path.relative(workspace, uri.fsPath);
            return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
                ? folder : undefined;
        };
        const target = path.join(workspace, 'review.txt');
        const opaque = path.join(workspace, 'image.bin');
        const uncertain = path.join(workspace, 'unknown.txt');
        fs.writeFileSync(target, 'main before-image\n');
        fs.writeFileSync(opaque, Buffer.from([0, 1, 2]));
        setListedFiles([Uri.file(target), Uri.file(opaque)]);
        let tracker = new DiffTracker(Uri.file(storage));
        setTracker(tracker);
        tracker.isRecording = true;
        const main = { repoRoot: workspace, kind: 'repository', headName: 'main',
            headCommit: 'a'.repeat(40), detached: false, inProgress: false };
        const feature = { ...main, headName: 'feature', headCommit: 'b'.repeat(40) };
        const currentTracker = () => tracker;
        try {
            assert.equal(await tracker.resetBaselineToCurrentState(), true, tracker.getPersistenceIssue());
            if (configured) {
                const requested = validateAndCanonicalizeScope({ mode: 'rules', includes: [], excludes: [] }, tracker.effectiveMonitoringScope.roots);
                assert.equal(requested.ok, true);
                const applied = await tracker.applyConfiguredMonitoringScope(requested.scope, false, () => true);
                assert.equal(applied.status, 'applied', applied.reason);
            }
            tracker.setBaselineGitContexts([main]);
            fs.writeFileSync(target, 'main pending review\n');
            await tracker.readFileAndUpdate(target, Uri.file(target));
            if (unknown) {
                fs.writeFileSync(uncertain, 'unknown current content\n');
                tracker.unresolvedBaselineFiles.set(uncertain, 'Before-image could not be verified');
                tracker.markFileUnavailable(uncertain, 'Before-image could not be verified');
            }
            tracker.observeGitContext(feature);
            assert.equal(await tracker.rebuildRepositoryBaseline(workspace, feature), true,
                tracker.getPersistenceIssue());
            assert.equal(tracker.getOriginalContent(target), 'main pending review\n');
            fs.writeFileSync(target, 'newer current review\n');
            await tracker.readFileAndUpdate(target, Uri.file(target));
            if (compatible) { tracker.observeGitContext(main); }
            assert.equal(await tracker.flushPendingPersistence(), true);
            const archive = fs.readFileSync(path.join(storage, ARCHIVE));
            const restart = async (beforeLoad) => {
                await tracker.dispose();
                await beforeLoad?.();
                tracker = new DiffTracker(Uri.file(storage));
                setTracker(tracker);
                const outcome = await tracker.restorePersistedState();
                tracker.reconcileRestoredGitContexts([compatible ? main : feature]);
                return outcome;
            };
            await run({ tracker, currentTracker, workspace, storage, target, opaque, uncertain,
                main, feature, archive, restart });
        } finally {
            faults.clear();
            await tracker.dispose();
            vscode.workspace.workspaceFolders = previousFolders;
            vscode.workspace.getWorkspaceFolder = previousGetFolder;
        }
    }

    const readState = (storage, name = PRIMARY) => JSON.parse(fs.readFileSync(path.join(storage, name), 'utf8'));
    const changeFor = (tracker, target) => tracker.getTrackedChanges().find(change => change.filePath === target);
    async function ready(tracker) {
        const preview = await tracker.previewArchivedGitReview();
        assert.equal(preview.status, 'ready', preview.reason);
        assert.equal(typeof preview.token, 'string');
        assert.ok(preview.token.length > 0);
        return preview;
    }
    function tree(root) {
        return fs.readdirSync(root).sort().flatMap(name => {
            const target = path.join(root, name);
            const stat = fs.lstatSync(target);
            return stat.isDirectory()
                ? [[name, 'directory', stat.mode], ...tree(target).map(([child, ...rest]) => [`${name}/${child}`, ...rest])]
                : [[name, stat.mode, stat.mtimeMs, fs.readFileSync(target).toString('base64')]];
        });
    }
    function storageSnapshot(storage) {
        return fs.readdirSync(storage).sort().map(name => [name, fs.readFileSync(path.join(storage, name)).toString('base64')]);
    }
    async function rejectWithoutMutation(ctx, expectedStatus) {
        const before = storageSnapshot(ctx.storage);
        const baseline = ctx.tracker.getOriginalContent(ctx.target);
        const disk = tree(ctx.workspace);
        const result = await ctx.tracker.previewArchivedGitReview();
        assert.equal(result.status, expectedStatus, result.reason);
        assert.ok(result.reason);
        assert.deepEqual(storageSnapshot(ctx.storage), before, 'preview must not alter durable sessions');
        assert.equal(ctx.tracker.getOriginalContent(ctx.target), baseline);
        assert.deepEqual(tree(ctx.workspace), disk);
    }
    async function failStorageDestination(predicate, run) {
        const originals = Object.fromEntries(['writeFile', 'copy', 'rename'].map(name => [name, vscode.workspace.fs[name]]));
        for (const name of Object.keys(originals)) {
            vscode.workspace.fs[name] = async (...args) => {
                const destination = name === 'writeFile' ? args[0] : args[1];
                if (predicate(destination.fsPath)) { throw Object.assign(new Error('injected storage failure'), { code: 'EACCES' }); }
                return originals[name](...args);
            };
        }
        try { await run(); } finally { Object.assign(vscode.workspace.fs, originals); }
    }

    test('ARCHIVE-RESTORE refuses feature context without touching either session', () => fixture(async ctx => {
        await rejectWithoutMutation(ctx, 'refused');
    }, { compatible: false }));

    test('ARCHIVE-RESTORE preview describes the whole latest archive and is read-only', () => fixture(async ctx => {
        const before = storageSnapshot(ctx.storage);
        const disk = tree(ctx.workspace);
        const preview = await ready(ctx.tracker);
        assert.deepEqual(preview.archive.workspaceRoots, [ctx.workspace]);
        assert.deepEqual(preview.archive.gitContext, ctx.main);
        assert.equal(preview.archive.textBaselines, 1);
        assert.equal(preview.archive.opaqueBaselines, 1);
        assert.equal(preview.archive.unknownBaselines, 1);
        assert.equal(preview.archive.recoveryRecords, 0);
        assert.equal(preview.archive.isRecording, true);
        assert.deepEqual(storageSnapshot(ctx.storage), before);
        assert.deepEqual(tree(ctx.workspace), disk);
    }, { unknown: true }));

    test('ARCHIVE-RESTORE restores returned-main review with full distinct backup and no workspace writes', () => fixture(async ctx => {
        const { tracker, storage, target, workspace } = ctx;
        assert.ok(tracker.getPausedGitRepositories().length, 'returning to main leaves the old sticky Git pause');
        tracker.revertHistory = [{ id: 'current-session-recovery', createdAt: new Date().toISOString(),
            items: [tracker.createFileRevertItem(target)] }];
        tracker.retainedReviewPaths.add(target);
        assert.equal(await tracker.flushPendingPersistence(), true);
        const before = readState(storage);
        assert.equal(before.revertHistory.length, 1);
        const disk = tree(workspace);
        const beforeActions = { apply: counters.apply, save: counters.save };
        const preview = await ready(tracker);
        const result = await tracker.restoreArchivedGitReview(preview.token);
        assert.equal(result.status, 'restored', result.reason);
        assert.equal(tracker.getOriginalContent(target), 'main before-image\n');
        assert.equal(changeFor(tracker, target)?.currentContent, 'newer current review\n');
        assert.deepEqual(tracker.getPausedGitRepositories(), []);
        assert.deepEqual(readState(storage, BACKUP), before, 'backup preserves the entire prior serialized session');
        assert.deepEqual(fs.readFileSync(path.join(storage, ARCHIVE)), ctx.archive, 'restoring cannot overwrite the source archive');
        assert.equal(fs.existsSync(path.join(storage, INTENT)), false);
        assert.deepEqual(tree(workspace), disk, 'restoring must preserve files, identities and Git metadata');
        assert.deepEqual({ apply: counters.apply, save: counters.save }, beforeActions);
        assert.equal(readState(storage).fileSnapshots.find(([p]) => p === target)?.[1], 'main before-image\n');
        fs.writeFileSync(target, 'edit after archive restore\n');
        emitWatcher('change', Uri.file(target));
        await waitUntil(() => changeFor(tracker, target)?.currentContent === 'edit after archive restore\n');
        assert.equal(tracker.getOriginalContent(target), 'main before-image\n');
        assert.equal(await ctx.restart(), 'restored');
        assert.equal(ctx.currentTracker().getOriginalContent(target), 'main before-image\n');
        assert.equal(changeFor(ctx.currentTracker(), target)?.currentContent, 'edit after archive restore\n');
    }));

    test('ARCHIVE-RESTORE keeps unknown before-images unknown after reconciliation and restart', () => fixture(async ctx => {
        const result = await ctx.tracker.restoreArchivedGitReview((await ready(ctx.tracker)).token);
        assert.equal(result.status, 'restored', result.reason);
        assert.equal(ctx.tracker.getOriginalContent(ctx.uncertain), undefined);
        assert.ok(changeFor(ctx.tracker, ctx.uncertain)?.unavailableReason);
        assert.equal(ctx.tracker.getReviewToken(ctx.uncertain), undefined);
        assert.equal(await ctx.restart(), 'restored');
        assert.equal(ctx.currentTracker().getOriginalContent(ctx.uncertain), undefined);
        assert.ok(changeFor(ctx.currentTracker(), ctx.uncertain)?.unavailableReason);
    }, { unknown: true }));

    for (const [name, mutate, status] of [
        ['missing archive', ctx => fs.unlinkSync(path.join(ctx.storage, ARCHIVE)), 'missing'],
        ['corrupt archive', ctx => fs.writeFileSync(path.join(ctx.storage, ARCHIVE), '{broken'), 'invalid'],
        ['future schema', ctx => {
            const state = readState(ctx.storage, ARCHIVE); state.version = 999;
            fs.writeFileSync(path.join(ctx.storage, ARCHIVE), JSON.stringify(state));
        }, 'invalid'],
        ['internally inconsistent archive workspace roots', ctx => {
            const state = readState(ctx.storage, ARCHIVE); state.workspaceRoots = [path.join(ctx.workspace, 'other-root')];
            fs.writeFileSync(path.join(ctx.storage, ARCHIVE), JSON.stringify(state));
        }, 'invalid'],
        ['different current workspace root', ctx => {
            const other = path.join(ctx.workspace, 'different-root'); fs.mkdirSync(other);
            vscode.workspace.workspaceFolders = [{ uri: Uri.file(other), name: 'archive-fixture' }];
        }, 'refused'],
        ['changed workspace root identity', () => { vscode.workspace.workspaceFolders[0].name = 'renamed-root'; }, 'refused'],
        ['multiple workspace roots', ctx => {
            const other = path.join(ctx.workspace, 'other-root'); fs.mkdirSync(other);
            vscode.workspace.workspaceFolders.push({ uri: Uri.file(other), name: 'other' });
        }, 'refused'],
        ['incompatible effective monitoring scope', ctx => {
            const scope = validateAndCanonicalizeScope({ mode: 'rules', includes: [], excludes: [] }, ctx.tracker.effectiveMonitoringScope.roots);
            assert.equal(scope.ok, true); ctx.tracker.effectiveMonitoringScope = { kind: 'configured', ...scope.scope };
        }, 'refused'],
        ['multiple archived Git repositories', ctx => {
            const state = readState(ctx.storage, ARCHIVE);
            state.gitContexts.push({ ...ctx.main, repoRoot: path.join(ctx.workspace, 'nested') });
            fs.writeFileSync(path.join(ctx.storage, ARCHIVE), JSON.stringify(state));
        }, 'refused'],
        ['multiple Git repositories', ctx => ctx.tracker.observeGitContext({ ...ctx.main, repoRoot: path.join(ctx.workspace, 'nested') }), 'refused'],
        ['missing original repository', ctx => ctx.tracker.observeGitRepositoryRemoved(ctx.workspace), 'refused'],
        ['Git initialization', ctx => ctx.tracker.setGitContextPending(true), 'refused'],
        ['Git operation in progress', ctx => ctx.tracker.observeGitContext({ ...ctx.main, inProgress: true }), 'refused'],
        ['worktree identity mismatch', ctx => ctx.tracker.observeGitContext({ ...ctx.main, kind: 'worktree' }), 'refused'],
        ['dirty editor', ctx => { const doc = document(ctx.target); doc.text = 'unsaved'; doc.isDirty = true; doc.version++; }, 'refused'],
        ['current observation coverage gap', ctx => {
            ctx.tracker.setFileCoverageGap(ctx.target, 'pending-scope-gap', 'Pending coverage requires reconciliation');
        }, 'refused'],
        ['archived observation coverage gap', ctx => {
            const state = readState(ctx.storage, ARCHIVE);
            state.coverageGaps = [[ctx.target, { file: { targetKind: 'file', reasonCode: 'pending-scope-gap',
                reason: 'Pending coverage requires reconciliation' } }]];
            fs.writeFileSync(path.join(ctx.storage, ARCHIVE), JSON.stringify(state));
        }, 'refused'],
        ['pending monitoring scope', ctx => {
            const scope = validateAndCanonicalizeScope({ mode: 'rules', includes: [], excludes: [] }, ctx.tracker.effectiveMonitoringScope.roots);
            assert.equal(scope.ok, true); ctx.tracker.setPendingMonitoringScope(scope.scope);
        }, 'refused'],
        ['blocked recovery', ctx => { ctx.tracker.recoveryBlocked = true; }, 'refused'],
        ['incomplete baseline', ctx => { ctx.tracker.snapshotInitialized = false; }, 'refused']
    ]) {
        test(`ARCHIVE-RESTORE ${name} is non-destructive`, () => fixture(async ctx => {
            mutate(ctx);
            await rejectWithoutMutation(ctx, status);
        }));
    }

    for (const [name, mutate] of [
        ['archive overwritten by a newer review', ctx => {
            const state = readState(ctx.storage, ARCHIVE); state.fileSnapshots[0][1] = 'different archive before-image';
            fs.writeFileSync(path.join(ctx.storage, ARCHIVE), JSON.stringify(state));
        }],
        ['new live review', async ctx => {
            fs.writeFileSync(ctx.target, 'new pending work after preview');
            await ctx.tracker.readFileAndUpdate(ctx.target, Uri.file(ctx.target));
        }],
        ['Git changed after preview', ctx => ctx.tracker.observeGitContext(ctx.feature)],
        ['editor became dirty after preview', ctx => { document(ctx.target).isDirty = true; }],
        ['epoch changed after preview', ctx => ctx.tracker.stopRecording()]
    ]) {
        test(`ARCHIVE-RESTORE stale token rejects ${name}`, () => fixture(async ctx => {
            const preview = await ready(ctx.tracker);
            await mutate(ctx);
            const baseline = ctx.tracker.getOriginalContent(ctx.target);
            const archive = fs.readFileSync(path.join(ctx.storage, ARCHIVE));
            const disk = tree(ctx.workspace);
            const result = await ctx.tracker.restoreArchivedGitReview(preview.token);
            assert.equal(result.status, 'refused', result.reason);
            assert.ok(result.reason);
            assert.equal(ctx.tracker.getOriginalContent(ctx.target), baseline);
            assert.deepEqual(fs.readFileSync(path.join(ctx.storage, ARCHIVE)), archive);
            assert.deepEqual(tree(ctx.workspace), disk);
            assert.equal(fs.existsSync(path.join(ctx.storage, BACKUP)), false,
                'a stale preview must not replace the pre-restore safety backup');
        }));
    }

    test('ARCHIVE-RESTORE discovers only extension-host workspace storage, not project JSON', () => fixture(async ctx => {
        fs.writeFileSync(path.join(ctx.workspace, ARCHIVE), ctx.archive);
        fs.unlinkSync(path.join(ctx.storage, ARCHIVE));
        await rejectWithoutMutation(ctx, 'missing');
        fs.writeFileSync(path.join(ctx.storage, ARCHIVE), ctx.archive);
        const preview = await ready(ctx.tracker);
        assert.deepEqual(preview.archive.workspaceRoots, [ctx.workspace]);
    }));

    test('ARCHIVE-RESTORE refuses an invented confirmation token', () => fixture(async ctx => {
        const result = await ctx.tracker.restoreArchivedGitReview('not-a-preview-token');
        assert.equal(result.status, 'refused');
        assert.equal(ctx.tracker.getOriginalContent(ctx.target), 'main pending review\n');
        assert.equal(fs.existsSync(path.join(ctx.storage, BACKUP)), false);
    }));

    test('ARCHIVE-RESTORE safety backup failure preserves the current session and original archive', () => fixture(async ctx => {
        const preview = await ready(ctx.tracker);
        const before = readState(ctx.storage);
        const disk = tree(ctx.workspace);
        await failStorageDestination(target => path.basename(target).startsWith('session-state.pre-restore'), async () => {
            const result = await ctx.tracker.restoreArchivedGitReview(preview.token);
            assert.notEqual(result.status, 'restored');
            assert.ok(result.reason);
        });
        assert.equal(ctx.tracker.getOriginalContent(ctx.target), 'main pending review\n');
        assert.deepEqual(readState(ctx.storage), before);
        assert.deepEqual(fs.readFileSync(path.join(ctx.storage, ARCHIVE)), ctx.archive);
        assert.deepEqual(tree(ctx.workspace), disk);
    }));

    test('ARCHIVE-RESTORE failure after primary publication rolls back the whole session', () => fixture(async ctx => {
        const preview = await ready(ctx.tracker);
        const before = readState(ctx.storage);
        const disk = tree(ctx.workspace);
        const originalCopy = vscode.workspace.fs.copy;
        let failed = false;
        vscode.workspace.fs.copy = async (source, destination, options) => {
            if (!failed && path.basename(source.fsPath) === PRIMARY &&
                path.basename(destination.fsPath) === 'session-state.last-good.json' &&
                readState(ctx.storage).fileSnapshots.some(([p, text]) => p === ctx.target && text === 'main before-image\n')) {
                failed = true;
                throw Object.assign(new Error('injected failure after primary publication'), { code: 'EACCES' });
            }
            return originalCopy(source, destination, options);
        };
        let result;
        try { result = await ctx.tracker.restoreArchivedGitReview(preview.token); }
        finally { vscode.workspace.fs.copy = originalCopy; }
        assert.equal(failed, true, 'failure must occur after the archived candidate reached primary');
        assert.equal(result.status, 'rolled-back', result.reason);
        assert.equal(ctx.tracker.getOriginalContent(ctx.target), 'main pending review\n');
        assert.deepEqual(readState(ctx.storage), before);
        assert.deepEqual(readState(ctx.storage, BACKUP), before);
        assert.deepEqual(fs.readFileSync(path.join(ctx.storage, ARCHIVE)), ctx.archive);
        assert.deepEqual(tree(ctx.workspace), disk);
        assert.equal(fs.existsSync(path.join(ctx.storage, INTENT)), false);
        assert.equal(await ctx.restart(), 'restored');
        assert.equal(ctx.currentTracker().getOriginalContent(ctx.target), 'main pending review\n');
    }));

    for (const phase of ['before candidate publication', 'after primary publication', 'after last-good publication']) {
        test(`ARCHIVE-RESTORE restart recovers complete safety backup ${phase}`, () => fixture(async ctx => {
            const before = readState(ctx.storage);
            const backup = Buffer.from(JSON.stringify(before));
            const disk = tree(ctx.workspace);
            const result = await ctx.restart(() => {
                fs.writeFileSync(path.join(ctx.storage, BACKUP), backup);
                fs.writeFileSync(path.join(ctx.storage, INTENT), JSON.stringify({ version: 1,
                    backupSha256: createHash('sha256').update(backup).digest('hex') }));
                if (phase !== 'before candidate publication') {
                    fs.writeFileSync(path.join(ctx.storage, PRIMARY), ctx.archive);
                    fs.writeFileSync(path.join(ctx.storage, 'session-state.unsaved'), 'Session write incomplete');
                }
                if (phase === 'after last-good publication') {
                    fs.writeFileSync(path.join(ctx.storage, 'session-state.last-good.json'), ctx.archive);
                }
            });
            assert.equal(result, 'recovered', ctx.currentTracker().getPersistenceIssue());
            assert.equal(ctx.currentTracker().getOriginalContent(ctx.target), 'main pending review\n');
            assert.equal(changeFor(ctx.currentTracker(), ctx.target)?.currentContent, 'newer current review\n');
            assert.deepEqual(readState(ctx.storage), before);
            assert.deepEqual(fs.readFileSync(path.join(ctx.storage, BACKUP)), backup);
            assert.deepEqual(fs.readFileSync(path.join(ctx.storage, ARCHIVE)), ctx.archive);
            assert.equal(fs.existsSync(path.join(ctx.storage, INTENT)), false);
            assert.equal(fs.existsSync(path.join(ctx.storage, 'session-state.unsaved')), false);
            assert.deepEqual(tree(ctx.workspace), disk);
        }));
    }

    for (const damage of ['missing backup', 'backup digest mismatch', 'invalid intent']) {
        test(`ARCHIVE-RESTORE interrupted recovery with ${damage} blocks without overwriting preserved evidence`, () => fixture(async ctx => {
            const backup = Buffer.from(JSON.stringify(readState(ctx.storage)));
            const result = await ctx.restart(() => {
                if (damage !== 'missing backup') { fs.writeFileSync(path.join(ctx.storage, BACKUP), backup); }
                fs.writeFileSync(path.join(ctx.storage, INTENT), damage === 'invalid intent' ? '{invalid' : JSON.stringify({
                    version: 1, backupSha256: damage === 'backup digest mismatch'
                        ? '0'.repeat(64) : createHash('sha256').update(backup).digest('hex')
                }));
                fs.writeFileSync(path.join(ctx.storage, PRIMARY), ctx.archive);
            });
            assert.equal(result, 'blocked');
            assert.equal(ctx.currentTracker().getIsRecording(), false);
            assert.ok(ctx.currentTracker().getPersistenceIssue());
            assert.deepEqual(fs.readFileSync(path.join(ctx.storage, PRIMARY)), ctx.archive);
            assert.deepEqual(fs.readFileSync(path.join(ctx.storage, ARCHIVE)), ctx.archive);
            assert.equal(fs.existsSync(path.join(ctx.storage, INTENT)), true);
            if (damage !== 'missing backup') { assert.deepEqual(fs.readFileSync(path.join(ctx.storage, BACKUP)), backup); }
        }));
    }

    test('ARCHIVE-RESTORE explicit discard clears invalid intent so a rebuilt session cannot resurrect the old backup', () => fixture(async ctx => {
        const backup = Buffer.from(JSON.stringify(readState(ctx.storage)));
        assert.equal(await ctx.restart(() => {
            fs.writeFileSync(path.join(ctx.storage, BACKUP), backup);
            fs.writeFileSync(path.join(ctx.storage, INTENT), '{invalid-intent');
        }), 'blocked');
        const restarted = ctx.currentTracker();
        assert.equal(restarted.isRecoveryBlocked(), true);
        assert.equal(await restarted.discardRecoveryState(), true);
        assert.equal(fs.existsSync(path.join(ctx.storage, INTENT)), false);
        assert.deepEqual(fs.readFileSync(path.join(ctx.storage, BACKUP)), backup,
            'explicit discard leaves the separate safety backup inert and intact');
        assert.deepEqual(fs.readFileSync(path.join(ctx.storage, ARCHIVE)), ctx.archive);
        fs.writeFileSync(ctx.target, 'explicit fresh baseline\n');
        assert.equal(restarted.startRecording(), true);
        await waitUntil(() => restarted.snapshotInitialized && !restarted.baselineBuilding);
        restarted.setBaselineGitContexts([ctx.main]);
        assert.equal(await restarted.flushPendingPersistence(), true);
        assert.equal(restarted.getOriginalContent(ctx.target), 'explicit fresh baseline\n');
        assert.equal(await ctx.restart(), 'restored');
        assert.equal(ctx.currentTracker().getOriginalContent(ctx.target), 'explicit fresh baseline\n');
        assert.equal(changeFor(ctx.currentTracker(), ctx.target), undefined);
        assert.deepEqual(fs.readFileSync(path.join(ctx.storage, BACKUP)), backup);
    }));

    for (const action of ['Stop', 'dispose']) {
        test(`ARCHIVE-RESTORE ${action} during startup safety-backup read cannot install stale state`, () => fixture(async ctx => {
            const backup = Buffer.from(JSON.stringify(readState(ctx.storage)));
            const intent = Buffer.from(JSON.stringify({ version: 1,
                backupSha256: createHash('sha256').update(backup).digest('hex') }));
            const gate = pause(path.join(ctx.storage, BACKUP), 'read');
            const operation = ctx.restart(() => {
                fs.writeFileSync(path.join(ctx.storage, BACKUP), backup);
                fs.writeFileSync(path.join(ctx.storage, INTENT), intent);
                fs.writeFileSync(path.join(ctx.storage, PRIMARY), ctx.archive);
            });
            let closing;
            try {
                await Promise.race([gate.entered, operation.then(result => {
                    throw new Error(`Startup restore finished before backup-read barrier: ${result}`);
                })]);
                if (action === 'Stop') { ctx.currentTracker().stopRecording(); }
                else { closing = ctx.currentTracker().dispose(); }
            } finally { gate.release(); }
            assert.equal(await operation, 'blocked');
            await closing;
            const restarted = ctx.currentTracker();
            assert.equal(restarted.getIsRecording(), false);
            assert.equal(restarted.getOriginalContent(ctx.target), undefined,
                'a stale startup result cannot install old snapshots after a newer lifecycle request');
            assert.equal(watcherInstances.some(watcher => watcher.active), false,
                'a stale startup result cannot resurrect observation coverage');
            assert.deepEqual(fs.readFileSync(path.join(ctx.storage, ARCHIVE)), ctx.archive);
            assert.deepEqual(fs.readFileSync(path.join(ctx.storage, BACKUP)), backup);
            assert.deepEqual(fs.readFileSync(path.join(ctx.storage, INTENT)), intent);
        }));
    }

    for (const activity of ['Start', 'new review']) {
        test(`ARCHIVE-RESTORE held intent write handles ${activity} before candidate cutover`, () => fixture(async ctx => {
            const preview = await ready(ctx.tracker);
            const epoch = ctx.tracker.sessionEpoch;
            const gate = pause(path.join(ctx.storage, INTENT), 'write');
            const operation = ctx.tracker.restoreArchivedGitReview(preview.token);
            try {
                await Promise.race([gate.entered, operation.then(result => {
                    throw new Error(`Restore finished before intent barrier: ${JSON.stringify(result)}`);
                })]);
                assert.equal((await ctx.tracker.previewArchivedGitReview()).status, 'refused');
                assert.equal((await ctx.tracker.restoreArchivedGitReview(preview.token)).status, 'refused');
                assert.equal(await ctx.tracker.discardRecoveryState(), false,
                    'recovery discard must not remove the active restore transaction');
                assert.equal(fs.existsSync(path.join(ctx.storage, BACKUP)), true);
                if (activity === 'Start') {
                    ctx.tracker.startRecording();
                    assert.equal(ctx.tracker.sessionEpoch, epoch, 'Start must not replace the live session while intent is being written');
                    assert.equal(ctx.tracker.getOriginalContent(ctx.target), 'main pending review\n');
                } else {
                    fs.writeFileSync(ctx.target, 'work arriving during intent write\n');
                    await ctx.tracker.readFileAndUpdate(ctx.target, Uri.file(ctx.target));
                }
            } finally { gate.release(); }
            const result = await operation;
            assert.equal(result.status, activity === 'Start' ? 'restored' : 'refused', result.reason);
            assert.equal(ctx.tracker.getOriginalContent(ctx.target), activity === 'Start'
                ? 'main before-image\n' : 'main pending review\n');
            if (activity === 'new review') {
                assert.equal(changeFor(ctx.tracker, ctx.target)?.currentContent, 'work arriving during intent write\n');
            }
            assert.deepEqual(fs.readFileSync(path.join(ctx.storage, ARCHIVE)), ctx.archive);
            assert.equal(fs.existsSync(path.join(ctx.storage, INTENT)), false);
        }));
    }

    test('ARCHIVE-RESTORE failed publication and rollback retain intent for restart recovery', () => fixture(async ctx => {
        const preview = await ready(ctx.tracker);
        const before = readState(ctx.storage);
        const originalCopy = vscode.workspace.fs.copy;
        let failedCandidate = false;
        vscode.workspace.fs.copy = async (source, destination, options) => {
            if (path.basename(destination.fsPath) === 'session-state.last-good.json') {
                const archivedCandidate = readState(ctx.storage).fileSnapshots.some(([p, text]) =>
                    p === ctx.target && text === 'main before-image\n');
                if (archivedCandidate || failedCandidate) {
                    failedCandidate = true;
                    throw Object.assign(new Error('persistent publication failure'), { code: 'EACCES' });
                }
            }
            return originalCopy(source, destination, options);
        };
        let result;
        try { result = await ctx.tracker.restoreArchivedGitReview(preview.token); }
        finally { vscode.workspace.fs.copy = originalCopy; }
        assert.equal(failedCandidate, true);
        assert.equal(result.status, 'failed', result.reason);
        assert.equal(ctx.tracker.getIsRecording(), false);
        assert.equal(ctx.tracker.recoveryBlocked, true);
        assert.equal(fs.existsSync(path.join(ctx.storage, INTENT)), true);
        assert.deepEqual(readState(ctx.storage, BACKUP), before);
        assert.deepEqual(fs.readFileSync(path.join(ctx.storage, ARCHIVE)), ctx.archive);
        assert.equal(await ctx.restart(), 'recovered');
        assert.equal(ctx.currentTracker().getOriginalContent(ctx.target), 'main pending review\n');
        assert.equal(changeFor(ctx.currentTracker(), ctx.target)?.currentContent, 'newer current review\n');
        assert.equal(fs.existsSync(path.join(ctx.storage, INTENT)), false);
    }));

    test('ARCHIVE-RESTORE Stop during reconciliation rolls back before stopping the current session', () => fixture(async ctx => {
        const preview = await ready(ctx.tracker);
        const gate = pause(ctx.target, 'read');
        const operation = ctx.tracker.restoreArchivedGitReview(preview.token);
        try {
            await Promise.race([gate.entered, operation.then(result => {
                throw new Error(`Restore finished before Stop barrier: ${JSON.stringify(result)}`);
            })]);
            ctx.tracker.stopRecording();
        } finally { gate.release(); }
        const result = await operation;
        assert.equal(result.status, 'rolled-back', result.reason);
        assert.equal(ctx.tracker.getIsRecording(), false);
        assert.equal(ctx.tracker.getOriginalContent(ctx.target), 'main pending review\n');
        assert.equal(await ctx.tracker.flushPendingPersistence(), true);
        assert.equal(readState(ctx.storage).isRecording, false);
        assert.deepEqual(fs.readFileSync(path.join(ctx.storage, ARCHIVE)), ctx.archive);
        assert.equal(fs.existsSync(path.join(ctx.storage, INTENT)), false);
    }));

    for (const action of ['Stop', 'dispose']) {
        test(`ARCHIVE-RESTORE ${action} at final marker deletion preserves the committed restored session`, () => fixture(async ctx => {
            const preview = await ready(ctx.tracker);
            const gate = pause(path.join(ctx.storage, INTENT), 'delete');
            const operation = ctx.tracker.restoreArchivedGitReview(preview.token);
            let closing;
            try {
                await Promise.race([gate.entered, operation.then(result => {
                    throw new Error(`Restore finished before commit barrier: ${JSON.stringify(result)}`);
                })]);
                if (action === 'Stop') { ctx.tracker.stopRecording(); }
                else { closing = ctx.tracker.dispose(); }
            } finally { gate.release(); }
            const result = await operation;
            await closing;
            assert.equal(result.status, 'restored', result.reason);
            assert.equal(ctx.tracker.getOriginalContent(ctx.target), 'main before-image\n');
            assert.equal(fs.existsSync(path.join(ctx.storage, INTENT)), false);
            if (action === 'Stop') {
                assert.equal(ctx.tracker.getIsRecording(), false);
                assert.equal(await ctx.tracker.flushPendingPersistence(), true);
                assert.equal(readState(ctx.storage).isRecording, false);
            }
            assert.equal(readState(ctx.storage).fileSnapshots.find(([p]) => p === ctx.target)?.[1], 'main before-image\n');
            assert.deepEqual(fs.readFileSync(path.join(ctx.storage, ARCHIVE)), ctx.archive);
            assert.equal(await ctx.restart(), 'restored');
            assert.equal(ctx.currentTracker().getOriginalContent(ctx.target), 'main before-image\n');
        }));
    }

    for (const configured of [false, true]) {
        test(`ARCHIVE-RESTORE directory creation during final commit keeps child provenance (${configured ? 'configured' : 'legacy'} Rules)`, () => fixture(async ctx => {
            const preview = await ready(ctx.tracker);
            const gate = pause(path.join(ctx.storage, INTENT), 'delete');
            const imported = path.join(ctx.workspace, 'imported-after-preview');
            const child = path.join(imported, 'child.txt');
            const operation = ctx.tracker.restoreArchivedGitReview(preview.token);
            try {
                await Promise.race([gate.entered, operation.then(result => {
                    throw new Error(`Restore finished before import barrier: ${JSON.stringify(result)}`);
                })]);
                fs.mkdirSync(imported);
                fs.writeFileSync(child, 'new child after archive reconciliation\n');
                // Legacy Rules uses the host search API. Its fake index must reflect
                // the newly created child; configured Rules discovers it directly.
                if (!configured) { setListedFiles([Uri.file(ctx.target), Uri.file(ctx.opaque), Uri.file(child)]); }
                emitWatcher('create', Uri.file(imported));
            } finally { gate.release(); }
            const result = await operation;
            assert.equal(result.status, 'restored', result.reason);
            assert.equal(ctx.tracker.getOriginalContent(child), '',
                'an observed directory create must preserve known-absence provenance for its children');
            assert.equal(changeFor(ctx.tracker, child)?.currentContent, 'new child after archive reconciliation\n');
            const saved = readState(ctx.storage);
            assert.equal(saved.fileSnapshots.find(([p]) => p === child)?.[1], '',
                'post-commit imported child before-image must be durable before completion');
            assert.equal(saved.baselineExistingFiles.includes(child), false);
            if (configured) {
                assert.ok(saved.coverageGaps.some(([p, record]) => p === imported &&
                    (record.importedCoverageRequired === true || record.subtree?.reasonCode === 'imported-coverage-restart-required')),
                    'configured imported directory observation obligations must remain durable');
            }
            assert.deepEqual(fs.readFileSync(path.join(ctx.storage, ARCHIVE)), ctx.archive);
            assert.equal(await ctx.restart(), 'restored');
            assert.equal(ctx.currentTracker().getOriginalContent(child), '');
            assert.equal(changeFor(ctx.currentTracker(), child)?.currentContent, 'new child after archive reconciliation\n');
            assert.equal(fs.readFileSync(child, 'utf8'), 'new child after archive reconciliation\n');
        }, { configured }));
    }

    test('ARCHIVE-RESTORE concurrent disk change remains pending rather than accepted', () => fixture(async ctx => {
        const preview = await ready(ctx.tracker);
        const gate = pause(ctx.target, 'read');
        const operation = ctx.tracker.restoreArchivedGitReview(preview.token);
        try {
            await Promise.race([gate.entered, operation.then(result => {
                throw new Error(`Restore finished before filesystem reconciliation: ${JSON.stringify(result)}`);
            })]);
            fs.writeFileSync(ctx.target, 'concurrent newer work\n');
            emitWatcher('change', Uri.file(ctx.target));
        } finally { gate.release(); }
        const result = await operation;
        assert.ok(['restored', 'rolled-back', 'refused'].includes(result.status), result.reason);
        assert.equal(fs.readFileSync(ctx.target, 'utf8'), 'concurrent newer work\n');
        assert.deepEqual(fs.readFileSync(path.join(ctx.storage, ARCHIVE)), ctx.archive);
        assert.notEqual(ctx.tracker.getOriginalContent(ctx.target), 'concurrent newer work\n');
        await waitUntil(() => !!changeFor(ctx.tracker, ctx.target));
        assert.ok(changeFor(ctx.tracker, ctx.target)?.unavailableReason ||
            changeFor(ctx.tracker, ctx.target)?.currentContent === 'concurrent newer work\n');
    }));
}
