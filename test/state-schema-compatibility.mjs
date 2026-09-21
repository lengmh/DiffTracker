/** Persisted-schema migration and downgrade safety, using the production tracker.
 * DT_EXPECT_LEGACY_REJECTION=1 runs the downgrade subset with DT_SOURCE pointing
 * to the released 0.7.2 tracker; normal npm test exercises the current writer.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createLegacyEffectiveScope, validateAndCanonicalizeScope } from '../out/monitoringScope.js';

export function registerStateSchemaCompatibility(harness) {
    const { test, root, Uri, DiffTracker, faults, file, pending,
        getTracker, setTracker, setListedFiles } = harness;

    function fixture(version = 4) {
        const target = file('schema-bom.txt');
        const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x61]);
        fs.writeFileSync(target, bytes);
        const stat = fs.statSync(target);
        return {
            target,
            state: {
                version, isRecording: true, baselineState: 'ready', workspaceRoots: [root],
                fileSnapshots: [], fileModes: [], baselineExistingFiles: [],
                unresolvedBaselineFiles: [], revertHistory: [], gitContexts: [],
                effectiveMonitoringScope: createLegacyEffectiveScope(
                    [{ name: 'test', uri: Uri.file(root).toString(), caseSensitive: process.platform !== 'win32' && process.platform !== 'darwin' }], []
                ),
                retainedReviewPaths: [], coverageGaps: [], legacyWatchExcludeByRoot: [],
                opaqueBaselineFiles: [[target, {
                    reason: 'UTF-8 BOM files require encoding preservation and are read-only in this version',
                    size: stat.size, mtime: stat.mtimeMs,
                    fingerprint: createHash('sha256').update(bytes).digest('hex')
                }]]
            }
        };
    }

    if (process.env.DT_EXPECT_LEGACY_REJECTION === '1') {
        for (const layout of ['primary', 'both', 'backup', 'interrupted-upgrade']) {
            test(`SCHEMA-DOWNGRADE released 0.7.2 preserves ${layout} V3 state`, async () => {
                const tracker = getTracker();
                const { target, state } = fixture();
                assert.equal(tracker.parsePersistedState(state), undefined,
                    'the released parser must reject rather than silently strip opaque identity');
                const storage = file('downgrade-storage');
                fs.mkdirSync(storage);
                tracker.storageUri = Uri.file(storage);
                setListedFiles([Uri.file(target)]);
                const primary = path.join(storage, 'session-state.json');
                const backup = path.join(storage, 'session-state.last-good.json');
                const intent = path.join(storage, 'session-state.unsaved');
                if (layout !== 'backup') { fs.writeFileSync(primary, JSON.stringify(state)); }
                if (layout === 'both' || layout === 'backup') { fs.writeFileSync(backup, JSON.stringify(state)); }
                if (layout === 'interrupted-upgrade') {
                    const legacy = { ...state, version: 2 };
                    delete legacy.opaqueBaselineFiles;
                    fs.writeFileSync(backup, JSON.stringify(legacy));
                    fs.writeFileSync(intent, 'Session write incomplete');
                }
                const before = new Map(fs.readdirSync(storage).map(name =>
                    [name, fs.readFileSync(path.join(storage, name))]));
                const diskBefore = fs.readFileSync(target);
                assert.equal(await tracker.restorePersistedState(), 'blocked');
                tracker.startRecording();
                assert.equal(tracker.getIsRecording(), false);
                assert.equal(await tracker.flushPendingPersistence(), false);
                await tracker.dispose();
                assert.deepEqual(fs.readdirSync(storage).sort(), [...before.keys()].sort());
                for (const [name, content] of before) {
                    assert.deepEqual(fs.readFileSync(path.join(storage, name)), content);
                }
                assert.deepEqual(fs.readFileSync(target), diskBefore);
            });
        }
        return;
    }

    for (const version of [1, 2, 3, 4]) {
        test(`SCHEMA-V4 normalize V${version} preserves existence and provenance`, async () => {
            const tracker = getTracker();
            const existing = file('existing.txt'), absent = file('new.txt');
            const state = {
                version, isRecording: false, baselineState: 'ready', workspaceRoots: [root],
                fileSnapshots: [[existing, ''], [absent, '']],
                fileModes: [[existing, 0o644]], baselineExistingFiles: [existing],
                unresolvedBaselineFiles: [], revertHistory: [], gitContexts: [],
                scanCoverage: 'a'.repeat(64),
                effectiveMonitoringScope: createLegacyEffectiveScope(
                    [{ name: 'test', uri: Uri.file(root).toString(), caseSensitive: process.platform !== 'win32' && process.platform !== 'darwin' }], []
                ),
                retainedReviewPaths: [], coverageGaps: [], legacyWatchExcludeByRoot: []
            };
            if (version >= 3) { state.opaqueBaselineFiles = []; }
            if (version < 4) {
                delete state.effectiveMonitoringScope;
                delete state.retainedReviewPaths;
                delete state.coverageGaps;
                delete state.legacyWatchExcludeByRoot;
            }
            const parsed = tracker.parsePersistedState(state);
            assert.ok(parsed);
            assert.equal(parsed.version, 4);
            assert.equal(parsed.migratedFromV1, version === 1);
            assert.equal(parsed.scanCoverage, version === 1 ? undefined : state.scanCoverage);
            assert.deepEqual(parsed.fileSnapshots, state.fileSnapshots);
            assert.deepEqual(parsed.baselineExistingFiles, [existing]);
            assert.deepEqual(parsed.fileModes, [[existing, 0o644]]);
            assert.deepEqual(parsed.opaqueBaselineFiles, []);
            assert.deepEqual(parsed.legacyWatchExcludeByRoot, []);
        });
    }

    test('SCHEMA-V4 migrates pre-release V2 opaque identities without discarding them', async () => {
        const { state } = fixture(2);
        const parsed = getTracker().parsePersistedState(state);
        assert.ok(parsed);
        assert.equal(parsed.version, 4);
        assert.deepEqual(parsed.opaqueBaselineFiles, state.opaqueBaselineFiles);
        assert.equal(parsed.migratedFromV1, false);
    });

    for (const invalid of [undefined, null]) {
        test(`SCHEMA-V4 rejects ${String(invalid)} opaque identity array`, async () => {
            const { state } = fixture();
            state.opaqueBaselineFiles = invalid;
            assert.equal(getTracker().parsePersistedState(state), undefined);
        });
    }
    for (const version of [0, 5, 999, '4']) {
        test(`SCHEMA-V4 rejects unsupported version ${JSON.stringify(version)}`, async () => {
            const { state } = fixture(version);
            assert.equal(getTracker().parsePersistedState(state), undefined);
        });
    }

    test('SCHEMA-V4 writes primary and backup with effective scope and opaque identities', async () => {
        const tracker = getTracker();
        const { target } = fixture();
        const storage = file('writer-storage');
        tracker.storageUri = Uri.file(storage);
        setListedFiles([Uri.file(target)]);
        assert.equal(await tracker.resetBaselineToCurrentState(), true);
        assert.equal(await tracker.flushPendingPersistence(), true);
        for (const name of ['session-state.json', 'session-state.last-good.json']) {
            const saved = JSON.parse(fs.readFileSync(path.join(storage, name), 'utf8'));
            assert.equal(saved.version, 4);
            assert.deepEqual(saved.opaqueBaselineFiles, [...tracker.opaqueBaselineFiles.entries()]);
            assert.equal(saved.effectiveMonitoringScope.kind, 'legacyV3');
            assert.deepEqual(saved.retainedReviewPaths, []);
            assert.deepEqual(saved.coverageGaps, []);
            assert.deepEqual(saved.legacyWatchExcludeByRoot, [[Uri.file(root).toString(), []]]);
            assert.equal(saved.fileSnapshots.some(([p]) => p === target), false);
        }
    });

    for (const layout of ['primary', 'both', 'recover-backup']) {
        test(`SCHEMA-V4 restores ${layout} opaque identity and detects offline deletion`, async () => {
            const { target, state } = fixture();
            const storage = file('restore-storage');
            fs.mkdirSync(storage);
            fs.writeFileSync(path.join(storage, 'session-state.json'),
                layout === 'recover-backup' ? 'corrupt' : JSON.stringify(state));
            if (layout !== 'primary') {
                fs.writeFileSync(path.join(storage, 'session-state.last-good.json'), JSON.stringify(state));
            }
            fs.unlinkSync(target);
            const tracker = new DiffTracker(Uri.file(storage));
            setTracker(tracker);
            assert.equal(await tracker.restorePersistedState(), layout === 'recover-backup' ? 'recovered' : 'restored');
            assert.ok(tracker.opaqueBaselineFiles.has(target));
            assert.equal(pending(target)?.reviewKind, 'opaque');
            assert.match(pending(target)?.reviewReason ?? '', /deleted.*unsupported baseline/i);
            assert.equal(await tracker.flushPendingPersistence(), true);
            const saved = JSON.parse(fs.readFileSync(path.join(storage, 'session-state.json'), 'utf8'));
            assert.equal(saved.version, 4);
            assert.deepEqual(saved.opaqueBaselineFiles, state.opaqueBaselineFiles);
        });
    }

    test('SCHEMA-V4 migrates a pre-fix directory sentinel into subtree diagnostics without a file review', async () => {
        const directory = file('legacy-directory-sentinel');
        fs.mkdirSync(directory);
        const storage = file('legacy-directory-sentinel-storage');
        fs.mkdirSync(storage);
        const state = {
            version: 4, isRecording: false, baselineState: 'ready', workspaceRoots: [root],
            scanCoverage: 'a'.repeat(64),
            fileSnapshots: [[directory, '']], fileModes: [], baselineExistingFiles: [],
            unresolvedBaselineFiles: [], opaqueBaselineFiles: [], revertHistory: [], gitContexts: [],
            effectiveMonitoringScope: createLegacyEffectiveScope(
                [{ name: 'test', uri: Uri.file(root).toString(), caseSensitive: process.platform !== 'win32' && process.platform !== 'darwin' }], []
            ),
            retainedReviewPaths: [],
            coverageGaps: [[directory, 'Imported directory watch coverage is incomplete; rebuild after resolving the watcher failure']]
        };
        fs.writeFileSync(path.join(storage, 'session-state.json'), JSON.stringify(state));
        const tracker = new DiffTracker(Uri.file(storage));
        setTracker(tracker);
        assert.equal(await tracker.restorePersistedState(), 'restored');
        assert.equal(pending(directory), undefined, 'legacy directory sentinels must not reappear as unknown file reviews');
        assert.equal(tracker.getOriginalContent(directory), undefined, 'a directory must not retain an empty text file baseline');
        assert.ok(tracker.getCoverageGaps().some(([target]) => target === directory),
            'the lost subtree coverage obligation must remain visible');
        assert.equal(await tracker.flushPendingPersistence(), true);
        const saved = JSON.parse(fs.readFileSync(path.join(storage, 'session-state.json'), 'utf8'));
        assert.equal(saved.fileSnapshots.some(([target]) => target === directory), false);
        const savedGap = saved.coverageGaps.find(([target]) => target === directory)?.[1];
        assert.equal(savedGap?.subtree?.targetKind, 'subtree');
        assert.equal(typeof savedGap?.subtree?.reasonCode, 'string');
        assert.equal(savedGap?.file, undefined);
    });

    test('SCHEMA-V4 restores coverage-gap snapshots as unknown reviews', async () => {
        const target = file('coverage-gap.txt');
        fs.writeFileSync(target, 'changed while unverified\n');
        const storage = file('coverage-gap-storage');
        fs.mkdirSync(storage);
        const state = {
            version: 4, isRecording: false, baselineState: 'ready', workspaceRoots: [root],
            scanCoverage: 'a'.repeat(64),
            fileSnapshots: [[target, 'baseline\n']], fileModes: [], baselineExistingFiles: [target],
            unresolvedBaselineFiles: [], opaqueBaselineFiles: [], revertHistory: [], gitContexts: [],
            effectiveMonitoringScope: createLegacyEffectiveScope(
                [{ name: 'test', uri: Uri.file(root).toString(), caseSensitive: process.platform !== 'win32' && process.platform !== 'darwin' }], []
            ),
            retainedReviewPaths: [],
            coverageGaps: [[target, 'Persisted observation gap requires explicit reconciliation']]
        };
        fs.writeFileSync(path.join(storage, 'session-state.json'), JSON.stringify(state));
        const tracker = new DiffTracker(Uri.file(storage));
        setTracker(tracker);
        assert.equal(await tracker.restorePersistedState(), 'restored');
        assert.equal(pending(target)?.reviewKind, 'unknown');
        assert.match(pending(target)?.unavailableReason ?? '', /observation gap/i);
        assert.equal(tracker.getReviewToken(target), undefined);
    });

    test('SCHEMA-V4 pending explicit exclusion preserves restored baseline review as unknown', async () => {
        const target = file('pending-exclude.txt');
        fs.writeFileSync(target, 'changed while pending\n');
        const storage = file('pending-exclude-storage');
        fs.mkdirSync(storage);
        const rootIdentity = {
            name: 'test',
            uri: Uri.file(root).toString(),
            caseSensitive: process.platform !== 'win32' && process.platform !== 'darwin'
        };
        const state = {
            version: 4, isRecording: false, baselineState: 'ready', workspaceRoots: [root],
            scanCoverage: 'a'.repeat(64),
            fileSnapshots: [[target, 'baseline\n']], fileModes: [], baselineExistingFiles: [target],
            unresolvedBaselineFiles: [], opaqueBaselineFiles: [], revertHistory: [], gitContexts: [],
            effectiveMonitoringScope: createLegacyEffectiveScope([rootIdentity], []),
            retainedReviewPaths: [], coverageGaps: []
        };
        fs.writeFileSync(path.join(storage, 'session-state.json'), JSON.stringify(state));
        const pendingScope = validateAndCanonicalizeScope({
            mode: 'rules',
            includes: [],
            excludes: [{ scope: 'all', pattern: path.basename(target) }]
        }, [rootIdentity]).scope;
        const tracker = new DiffTracker(Uri.file(storage));
        tracker.setPendingMonitoringScope(pendingScope);
        setTracker(tracker);
        assert.equal(await tracker.restorePersistedState(), 'restored');
        tracker.setPendingMonitoringScope(pendingScope);
        assert.equal(pending(target)?.reviewKind, 'unknown');
        assert.deepEqual(tracker.getExplicitlyExcludedPendingReviewPaths(pendingScope), [target]);
    });

    test('SCHEMA-V4 requires effective scope, retained reviews and coverage gaps', async () => {
        for (const field of ['effectiveMonitoringScope', 'retainedReviewPaths', 'coverageGaps']) {
            const { state } = fixture(4);
            delete state[field];
            assert.equal(getTracker().parsePersistedState(state), undefined, `missing ${field} must invalidate V4`);
        }
    });

    test('SCHEMA-V3 migration enters legacy scope compatibility and next write is V4', async () => {
        const { state } = fixture(3);
        delete state.effectiveMonitoringScope;
        delete state.retainedReviewPaths;
        delete state.coverageGaps;
        const parsed = getTracker().parsePersistedState(state);
        assert.ok(parsed);
        assert.equal(parsed.version, 4);
        assert.equal(parsed.effectiveMonitoringScope.kind, 'legacyV3');
        const tracker = getTracker();
        const storage = file('v3-to-v4-storage');
        fs.mkdirSync(storage);
        fs.writeFileSync(path.join(storage, 'session-state.json'), JSON.stringify(state));
        tracker.storageUri = Uri.file(storage);
        assert.equal(await tracker.restorePersistedState(), 'restored');
        assert.equal(await tracker.flushPendingPersistence(), true);
        const saved = JSON.parse(fs.readFileSync(path.join(storage, 'session-state.json'), 'utf8'));
        assert.equal(saved.version, 4);
        assert.equal(saved.effectiveMonitoringScope.kind, 'legacyV3');
    });

    for (const version of [2, 3, 4]) {
        test(`SCHEMA-MTIME V${version} accepts finite pre-epoch timestamps`, async () => {
            const { state } = fixture(version);
            state.opaqueBaselineFiles[0][1].mtime = -315619200000;
            const parsed = getTracker().parsePersistedState(state);
            assert.ok(parsed, 'finite negative mtimes must not invalidate opaque identity');
            assert.equal(parsed.opaqueBaselineFiles[0][1].mtime, -315619200000);
        });
    }
    for (const value of [NaN, Infinity, -Infinity, '1960-01-01', null]) {
        test(`SCHEMA-MTIME rejects invalid timestamp ${String(value)}`, async () => {
            const { state } = fixture();
            state.opaqueBaselineFiles[0][1].mtime = value;
            assert.equal(getTracker().parsePersistedState(state), undefined);
        });
    }
    for (const scope of ['workspace', 'repository']) {
        test(`SCHEMA-MTIME ${scope} scan persists and restores pre-epoch file`, async () => {
            let tracker = getTracker();
            const { target } = fixture();
            const stamp = new Date('1960-01-01T00:00:00Z');
            fs.utimesSync(target, stamp, stamp);
            // Some hosts do not expose a pre-epoch mtime through Node's local
            // filesystem boundary. Keep the production scan/persistence/restore
            // assertions: supply that valid metadata at the already-mocked VS Code
            // provider boundary instead of skipping the test or changing bytes.
            if (!(fs.statSync(target).mtimeMs < 0)) {
                faults.set(target, { mtime: stamp.getTime() });
            }
            try {
                assert.ok((await tracker.readFileSnapshot(Uri.file(target))).mtime < 0,
                    'the production reader must observe a valid negative provider timestamp');
                const storage = Uri.file(file('pre-epoch-storage'));
                tracker.storageUri = storage;
                setListedFiles([Uri.file(target)]);
                if (scope === 'workspace') {
                    assert.equal(await tracker.resetBaselineToCurrentState(), true);
                } else {
                    const base = { repoRoot: root, kind: 'repository', headName: 'main',
                        headCommit: 'aaa', detached: false, inProgress: false };
                    const current = { ...base, headName: 'next', headCommit: 'bbb' };
                    tracker.setBaselineGitContexts([base]);
                    tracker.observeGitContext(current);
                    assert.equal(await tracker.rebuildRepositoryBaseline(root, current), true);
                }
                assert.equal(pending(target), undefined);
                assert.ok(tracker.opaqueBaselineFiles.get(target)?.mtime < 0);
                assert.equal(await tracker.flushPendingPersistence(), true);
                await tracker.dispose();
                tracker = new DiffTracker(storage);
                setTracker(tracker);
                assert.equal(await tracker.restorePersistedState(), 'restored');
                assert.ok(tracker.opaqueBaselineFiles.get(target)?.mtime < 0);
                assert.equal(pending(target), undefined);
            } finally {
                faults.delete(target);
            }
        });
    }

    for (const failAt of ['write', 'rename', 'copy']) {
        test(`SCHEMA-V4 interrupted V2 upgrade at ${failAt} retains durable intent until retry`, async () => {
            const tracker = getTracker();
            const { state } = fixture(2);
            state.isRecording = false;
            delete state.opaqueBaselineFiles;
            const storage = file('upgrade-storage');
            fs.mkdirSync(storage);
            tracker.storageUri = Uri.file(storage);
            const primary = path.join(storage, 'session-state.json');
            const backup = path.join(storage, 'session-state.last-good.json');
            const temp = path.join(storage, 'session-state.tmp.json');
            fs.writeFileSync(primary, JSON.stringify(state));
            fs.writeFileSync(backup, JSON.stringify(state));
            assert.equal(await tracker.restorePersistedState(), 'restored');
            const faultPath = failAt === 'copy' ? primary : temp;
            faults.set(faultPath, { [failAt]: Object.assign(new Error('NoPermissions'), { code: 'NoPermissions' }) });
            try {
                assert.equal(await tracker.flushPendingPersistence(), false);
                assert.equal(fs.existsSync(path.join(storage, 'session-state.unsaved')), true);
            } finally { faults.delete(faultPath); }
            assert.equal(await tracker.flushPendingPersistence(), true);
            assert.equal(fs.existsSync(path.join(storage, 'session-state.unsaved')), false);
            for (const p of [primary, backup]) {
                assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).version, 4);
            }
        });
    }
}
