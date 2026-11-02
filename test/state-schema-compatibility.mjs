/** Persisted-schema migration and downgrade safety, using the production tracker.
 * DT_EXPECT_LEGACY_REJECTION=1 runs the downgrade subset with DT_SOURCE pointing
 * to the released 0.7.2 tracker; normal npm test exercises the current writer.
 * DT_EXPECT_V5_PREDECESSOR_REJECTION=1 with DT_TEST_FILTER='SCHEMA-DOWNGRADE V5'
 * and DT_SOURCE pointing to the preceding V4 tracker verifies the Stop boundary.
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

    function stoppedFixture() {
        const { target, state } = fixture(5);
        const text = file('schema-frozen.txt');
        const unknown = file('schema-unknown.txt');
        state.isRecording = false;
        state.fileSnapshots = [[text, 'baseline\n']];
        state.baselineExistingFiles = [text];
        state.unresolvedBaselineFiles = [[unknown, 'Baseline unavailable before Stop']];
        state.stoppedReviews = [
            {filePath:text, currentContent:'pending at Stop\n', isDeleted:false,
                reviewKind:'text', baselineExists:true, currentExists:true, timestamp:1234},
            {filePath:target, currentContent:'', isDeleted:false,
                reviewKind:'opaque', reviewReason:'Unsupported bytes changed before Stop',
                baselineExists:true, currentExists:true, baselineSize:4, currentSize:5,
                baselineFingerprint:state.opaqueBaselineFiles[0][1].fingerprint,
                currentFingerprint:'b'.repeat(64), timestamp:2345},
            {filePath:unknown, currentContent:'', isDeleted:false,
                reviewKind:'unknown', unavailableReason:'Baseline unavailable before Stop', timestamp:3456}
        ];
        return {target, text, unknown, state};
    }

    for (const layout of ['primary', 'both', 'backup', 'interrupted-upgrade']) {
        test(`SCHEMA-DOWNGRADE V5 stopped review preserves ${layout} state in older readers`, async () => {
            const {state, text:target} = stoppedFixture();
            const tracker = getTracker();
            if (process.env.DT_EXPECT_LEGACY_REJECTION !== '1' && process.env.DT_EXPECT_V5_PREDECESSOR_REJECTION !== '1') {
                assert.equal(tracker.parsePersistedState(state)?.version, 5);
                return;
            }
            assert.equal(tracker.parsePersistedState(state), undefined,
                'older readers must reject V5 rather than recapture post-Stop bytes');
            fs.writeFileSync(target, 'unrecorded edit after Stop\n');
            const storage = file('v5-downgrade-storage');
            fs.mkdirSync(storage);
            tracker.storageUri = Uri.file(storage);
            setListedFiles([Uri.file(target)]);
            if (layout !== 'backup') {
                fs.writeFileSync(path.join(storage, 'session-state.json'), JSON.stringify(state));
            }
            if (layout === 'both' || layout === 'backup') {
                fs.writeFileSync(path.join(storage, 'session-state.last-good.json'), JSON.stringify(state));
            }
            if (layout === 'interrupted-upgrade') {
                const previous = {...state, version:4};
                delete previous.stoppedReviews;
                fs.writeFileSync(path.join(storage, 'session-state.last-good.json'), JSON.stringify(previous));
                fs.writeFileSync(path.join(storage, 'session-state.unsaved'), 'Session write incomplete');
            }
            const before = new Map(fs.readdirSync(storage).map(name => [name, fs.readFileSync(path.join(storage, name))]));
            const bytes = fs.readFileSync(target);
            assert.equal(await tracker.restorePersistedState(), 'blocked');
            tracker.startRecording();
            assert.equal(tracker.getIsRecording(), false);
            assert.equal(await tracker.flushPendingPersistence(), false);
            await tracker.dispose();
            assert.deepEqual(fs.readdirSync(storage).sort(), [...before.keys()].sort());
            for (const [name, content] of before) {
                assert.deepEqual(fs.readFileSync(path.join(storage, name)), content);
            }
            assert.deepEqual(fs.readFileSync(target), bytes);
        });
    }

    test('SCHEMA-DOWNGRADE root Recheck sentinel preserves state when the reader predates it', async () => {
        const { state, target } = fixture();
        const requested = validateAndCanonicalizeScope({ mode: 'rules', includes: [], excludes: [] },
            state.effectiveMonitoringScope.roots);
        assert.equal(requested.ok, true);
        state.effectiveMonitoringScope = { kind: 'configured', ...requested.scope };
        state.coverageGaps = [[root, { subtree: { targetKind: 'subtree',
            reasonCode: 'coverage-recheck-incomplete', reason: 'Observation recheck incomplete' } }]];
        const tracker = getTracker();
        if (process.env.DT_EXPECT_LEGACY_REJECTION !== '1' && process.env.DT_EXPECT_RECHECK_PREDECESSOR_REJECTION !== '1') {
            assert.ok(tracker.parsePersistedState(state));
            return;
        }
        assert.equal(tracker.parsePersistedState(state), undefined);
        const storage = file('recheck-downgrade-storage');
        fs.mkdirSync(storage);
        tracker.storageUri = Uri.file(storage);
        for (const name of ['session-state.json', 'session-state.last-good.json']) {
            fs.writeFileSync(path.join(storage, name), JSON.stringify(state));
        }
        const before = new Map(fs.readdirSync(storage).map(name => [name, fs.readFileSync(path.join(storage, name))]));
        const bytes = fs.readFileSync(target);
        assert.equal(await tracker.restorePersistedState(), 'blocked');
        tracker.startRecording();
        assert.equal(tracker.getIsRecording(), false);
        assert.equal(await tracker.flushPendingPersistence(), false);
        await tracker.dispose();
        assert.deepEqual(fs.readdirSync(storage).sort(), [...before.keys()].sort());
        for (const [name, content] of before) { assert.deepEqual(fs.readFileSync(path.join(storage, name)), content); }
        assert.deepEqual(fs.readFileSync(target), bytes);
    });

    test('SCHEMA-V4 imported ownership marker round-trips independently of pending control', () => {
        const { state } = fixture();
        const directory = file('schema-import-owner');
        const subtree = {targetKind:'subtree', reasonCode:'pending-scope-deferred-delete',
            reason:'Pending directory deletion requires reconciliation'};
        state.coverageGaps = [[directory, {subtree, importedCoverageRequired:true}]];
        const parsed = getTracker().parsePersistedState(state);
        assert.ok(parsed);
        assert.equal(parsed.version, 4);
        assert.equal(parsed.coverageGaps[0][1].importedCoverageRequired, true);
        assert.deepEqual(parsed.coverageGaps[0][1].subtree, subtree);
        state.coverageGaps = [[directory, {...subtree, importedCoverageRequired:true}]];
        const direct = getTracker().parsePersistedState(state);
        assert.equal(direct.coverageGaps[0][1].importedCoverageRequired, true,
            'the accepted direct-evidence form must not silently strip ownership either');
    });

    for (const marker of [false, null, 0, 'true', {}, []]) {
        test(`SCHEMA-V4 rejects malformed imported ownership marker ${JSON.stringify(marker)}`, () => {
            const { state } = fixture();
            state.coverageGaps = [[file('bad-owner'), {importedCoverageRequired:marker,
                subtree:{targetKind:'subtree', reasonCode:'pending-scope-gap', reason:'Pending subtree'}}]];
            assert.equal(getTracker().parsePersistedState(state), undefined);
        });
    }

    test('SCHEMA-V4 rejects an imported ownership marker without subtree evidence', () => {
        const { state } = fixture();
        state.coverageGaps = [[file('bad-owner-kind'), {importedCoverageRequired:true,
            file:{targetKind:'file', reasonCode:'pending-scope-gap', reason:'Pending file'}}]];
        assert.equal(getTracker().parsePersistedState(state), undefined);
    });

    for(const version of [4,5]) test(`SCHEMA-ORIGIN V${version} retains provenance independently of diagnostic`,()=>{
        const {state}=fixture();state.version=version;
        const directory=file('directory-origin');
        state.coverageGaps=[[directory,{unprovenDirectoryObservation:true}]];
        const origin=getTracker().parsePersistedState(state);assert.ok(origin);
        assert.equal(origin.coverageGaps[0][1].unprovenDirectoryObservation,true);
        assert.equal(origin.coverageGaps[0][1].subtree,undefined);
        const subtree={targetKind:'subtree',reasonCode:'supplemental-watcher-capacity-gap',reason:'Synthetic native quota failure'};
        state.coverageGaps=[[directory,{subtree,unprovenDirectoryObservation:true}]];
        const mixed=getTracker().parsePersistedState(state);assert.ok(mixed);
        assert.deepEqual(mixed.coverageGaps[0][1].subtree,subtree);
        assert.equal(mixed.coverageGaps[0][1].unprovenDirectoryObservation,true);
        state.coverageGaps=[[directory,{subtree}]];
        const migrated=getTracker().parsePersistedState(state);assert.ok(migrated);
        assert.deepEqual(migrated.coverageGaps[0][1].subtree,subtree);
        assert.equal(migrated.coverageGaps[0][1].unprovenDirectoryObservation,true,'legacy uncertainty migration keeps the original health diagnostic');
    });

    for(const marker of [false,null,0,'true',{},[]]) test(`SCHEMA-ORIGIN rejects malformed marker ${JSON.stringify(marker)}`,()=>{
        const {state}=fixture();
        state.coverageGaps=[[file('invalid-origin'),{unprovenDirectoryObservation:marker,
            subtree:{targetKind:'subtree',reasonCode:'synthetic-gap',reason:'Synthetic native uncertainty'}}]];
        assert.equal(getTracker().parsePersistedState(state),undefined);
    });

    test('SCHEMA-ORIGIN cannot extend the saved workspace boundary',()=>{
        const {state}=fixture();
        state.coverageGaps=[[path.join(path.dirname(state.workspaceRoots[0]),'unrelated-origin'),{unprovenDirectoryObservation:true}]];
        assert.equal(getTracker().parsePersistedState(state),undefined);
    });

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

    for (const version of [1, 2, 3, 4, 5]) {
        test(`SCHEMA-V${version === 5 ? 5 : 4} normalize V${version} preserves existence and provenance`, async () => {
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
            if (version === 5) { state.stoppedReviews = []; }
            if (version < 4) {
                delete state.effectiveMonitoringScope;
                delete state.retainedReviewPaths;
                delete state.coverageGaps;
                delete state.legacyWatchExcludeByRoot;
            }
            const parsed = tracker.parsePersistedState(state);
            assert.ok(parsed);
            assert.equal(parsed.version, version === 5 ? 5 : 4);
            assert.equal(parsed.migratedFromV1, version === 1);
            assert.equal(parsed.scanCoverage, version === 1 ? undefined : state.scanCoverage);
            assert.deepEqual(parsed.fileSnapshots, state.fileSnapshots);
            assert.deepEqual(parsed.baselineExistingFiles, [existing]);
            assert.deepEqual(parsed.fileModes, [[existing, 0o644]]);
            assert.deepEqual(parsed.opaqueBaselineFiles, []);
            assert.deepEqual(parsed.legacyWatchExcludeByRoot, []);
            assert.deepEqual(parsed.stoppedReviews, version === 5 ? [] : undefined);
        });
    }

    for (const version of [1, 2, 3, 4]) {
        test(`SCHEMA-V${version} stopped migration preserves baseline and never guesses the missing pending review`, async () => {
            const {state} = fixture(version);
            const target = file('legacy-stopped-review.txt');
            state.isRecording = false;
            state.fileSnapshots = [[target, 'original baseline\n']];
            state.baselineExistingFiles = [target];
            state.opaqueBaselineFiles = [];
            if (version < 3) { delete state.opaqueBaselineFiles; }
            if (version < 4) {
                delete state.effectiveMonitoringScope;
                delete state.retainedReviewPaths;
                delete state.coverageGaps;
                delete state.legacyWatchExcludeByRoot;
            }
            fs.writeFileSync(target, 'unrecorded edit after Stop\n');
            const storage = file('legacy-stopped-storage');
            fs.mkdirSync(storage);
            fs.writeFileSync(path.join(storage, 'session-state.json'), JSON.stringify(state));
            const tracker = getTracker();
            tracker.storageUri = Uri.file(storage);
            setListedFiles([Uri.file(target)]);
            assert.equal(await tracker.restorePersistedState(), 'incomplete');
            assert.equal(tracker.getIsRecording(), false);
            assert.equal(tracker.getOriginalContent(target), 'original baseline\n');
            assert.equal(pending(target), undefined);
            assert.match(tracker.getPersistenceIssue() ?? '', /older stopped session/i);
            assert.equal(await tracker.flushPendingPersistence(), true);
            const saved = JSON.parse(fs.readFileSync(path.join(storage, 'session-state.json'), 'utf8'));
            assert.equal(saved.version, 5);
            assert.equal(saved.baselineState, 'building');
            assert.deepEqual(saved.fileSnapshots, state.fileSnapshots);
            assert.deepEqual(saved.baselineExistingFiles, [target]);
            assert.deepEqual(saved.stoppedReviews, []);
            assert.equal(fs.readFileSync(target, 'utf8'), 'unrecorded edit after Stop\n');
        });
    }

    test('SCHEMA-V5 stopped text, opaque and unknown reviews survive a JSON roundtrip and reload', async () => {
        const {state, target, text:targetText, unknown} = stoppedFixture();
        const tracker = getTracker();
        const parsed = tracker.parsePersistedState(JSON.parse(JSON.stringify(state)));
        assert.equal(parsed?.version, 5);
        assert.deepEqual(JSON.parse(JSON.stringify(parsed.stoppedReviews)), state.stoppedReviews);
        const storage = file('v5-stopped-roundtrip-storage');
        fs.mkdirSync(storage);
        fs.writeFileSync(path.join(storage, 'session-state.json'), JSON.stringify(state));
        fs.writeFileSync(targetText, 'unrecorded edit after Stop\n');
        fs.unlinkSync(target);
        fs.writeFileSync(unknown, 'newly readable after Stop\n');
        tracker.storageUri = Uri.file(storage);
        setListedFiles([Uri.file(targetText), Uri.file(unknown)]);
        assert.equal(await tracker.restorePersistedState(), 'restored');
        assert.equal(tracker.getIsRecording(), false);
        assert.equal(pending(targetText)?.currentContent, 'pending at Stop\n');
        assert.equal(pending(targetText)?.originalContent, 'baseline\n');
        assert.equal(pending(target)?.reviewKind, 'opaque');
        assert.equal(pending(target)?.currentExists, true, 'post-Stop deletion must not change the frozen review');
        assert.equal(pending(unknown)?.reviewKind, 'unknown');
        assert.equal(pending(unknown)?.currentContent, '');
        assert.equal(await tracker.flushPendingPersistence(), true);
        for (const name of ['session-state.json', 'session-state.last-good.json']) {
            const saved = JSON.parse(fs.readFileSync(path.join(storage, name), 'utf8'));
            assert.equal(saved.version, 5);
            assert.deepEqual(saved.stoppedReviews, [...state.stoppedReviews].sort((a, b) => a.filePath.localeCompare(b.filePath)));
        }
        assert.equal(fs.readFileSync(targetText, 'utf8'), 'unrecorded edit after Stop\n');
        assert.equal(fs.existsSync(target), false);
    });

    for (const version of [1, 2, 3, 4]) {
        test(`SCHEMA-V5 rejects frozen review payload mislabeled as V${version}`, () => {
            const {state} = stoppedFixture();
            state.version = version;
            assert.equal(getTracker().parsePersistedState(state), undefined);
        });
    }

    const malformedStoppedReviews = [
        ['missing payload', state => { delete state.stoppedReviews; }],
        ['null payload', state => { state.stoppedReviews = null; }],
        ['object payload', state => { state.stoppedReviews = {}; }],
        ['recording payload', state => { state.isRecording = true; }],
        ['null review', state => { state.stoppedReviews = [null]; }],
        ['duplicate path', state => { state.stoppedReviews.push({...state.stoppedReviews[0]}); }],
        ['relative path', state => { state.stoppedReviews[0].filePath = 'relative.txt'; }],
        ['unowned path', state => { state.stoppedReviews[0].filePath = file('unowned.txt'); }],
        ['nontext current bytes', state => { state.stoppedReviews[0].currentContent = null; }],
        ['nonboolean deletion', state => { state.stoppedReviews[0].isDeleted = 'false'; }],
        ['invalid review kind', state => { state.stoppedReviews[0].reviewKind = 'binary'; }],
        ['text without text baseline', state => { state.stoppedReviews[1].reviewKind = 'text'; }],
        ['nonfinite timestamp', state => { state.stoppedReviews[0].timestamp = Infinity; }],
        ['out-of-range date', state => { state.stoppedReviews[0].timestamp = 8.64e15 + 1; }],
        ['nonstring reason', state => { state.stoppedReviews[0].reviewReason = {}; }],
        ['oversized reason', state => { state.stoppedReviews[0].unavailableReason = 'x'.repeat(4001); }],
        ['nonboolean existence', state => { state.stoppedReviews[0].baselineExists = 1; }],
        ['contradictory deletion', state => { state.stoppedReviews[0].currentExists = false; }],
        ['negative size', state => { state.stoppedReviews[1].currentSize = -1; }],
        ['fractional size', state => { state.stoppedReviews[1].baselineSize = 1.5; }],
        ['invalid fingerprint', state => { state.stoppedReviews[1].currentFingerprint = 'bad'; }],
        ['invalid reminder', state => { state.stoppedReviews[0].largeFileReminder = {pending:true}; }]
    ];
    for (const [description, mutate] of malformedStoppedReviews) {
        test(`SCHEMA-V5 rejects ${description}`, () => {
            const {state} = stoppedFixture();
            mutate(state);
            assert.equal(getTracker().parsePersistedState(state), undefined);
        });
    }

    test('SCHEMA-V5 recording sessions omit frozen payload and stopped empty payload is explicit', () => {
        const {state} = fixture(5);
        assert.equal(getTracker().parsePersistedState(state)?.version, 5);
        state.isRecording = false;
        assert.equal(getTracker().parsePersistedState(state), undefined);
        state.stoppedReviews = [];
        assert.deepEqual(getTracker().parsePersistedState(state)?.stoppedReviews, []);
    });

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
    for (const version of [0, 6, 999, '4', '5']) {
        test(`SCHEMA-V4 rejects unsupported version ${JSON.stringify(version)}`, async () => {
            const { state } = fixture(version);
            assert.equal(getTracker().parsePersistedState(state), undefined);
        });
    }

    test('SCHEMA-V5 writes primary and backup with effective scope and opaque identities', async () => {
        const tracker = getTracker();
        const { target } = fixture();
        const storage = file('writer-storage');
        tracker.storageUri = Uri.file(storage);
        setListedFiles([Uri.file(target)]);
        assert.equal(await tracker.resetBaselineToCurrentState(), true);
        assert.equal(await tracker.flushPendingPersistence(), true);
        for (const name of ['session-state.json', 'session-state.last-good.json']) {
            const saved = JSON.parse(fs.readFileSync(path.join(storage, name), 'utf8'));
            assert.equal(saved.version, 5);
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
            assert.equal(saved.version, 5);
            assert.deepEqual(saved.opaqueBaselineFiles, state.opaqueBaselineFiles);
        });
    }

    test('SCHEMA-V4 parses saved configured scope without consulting mutable filesystem paths', async () => {
        if (process.platform === 'win32') {
            console.log('SKIP SCHEMA-V4 mutable-path parser fixture requires a case-sensitive host');
            return;
        }
        const scopeParent = file('persisted-scope-case');
        const caseDistinct = path.join(scopeParent, 'src', '.GIT');
        fs.mkdirSync(caseDistinct, { recursive: true });
        fs.writeFileSync(path.join(caseDistinct, 'HEAD'), 'case-distinct\n');
        const rootIdentity = {
            name: 'test',
            uri: Uri.file(root).toString(),
            caseSensitive: true
        };
        const relativeInclude = path.relative(root, path.join(caseDistinct, 'HEAD')).split(path.sep).join('/');
        const checked = validateAndCanonicalizeScope({
            mode: 'rules',
            includes: [{ scope: 'all', path: relativeInclude }],
            excludes: []
        }, [rootIdentity]);
        assert.equal(checked.ok, true, JSON.stringify(checked.errors));

        const { state } = fixture();
        state.effectiveMonitoringScope = { kind: 'configured', ...checked.scope };
        state.isRecording = true;
        fs.rmSync(scopeParent, { recursive: true, force: true });

        assert.ok(getTracker().parsePersistedState(state),
            'durable scope parsing must remain structural after the referenced path disappears');

        const storage = file('persisted-scope-case-storage');
        fs.mkdirSync(storage);
        for (const name of ['session-state.json', 'session-state.last-good.json']) {
            fs.writeFileSync(path.join(storage, name), JSON.stringify(state));
        }
        const tracker = new DiffTracker(Uri.file(storage));
        setTracker(tracker);
        assert.equal(await tracker.restorePersistedState(), 'incomplete',
            'current filesystem identity uncertainty must pause restoration rather than mark durable state corrupt');
        assert.equal(tracker.getIsRecording(), false);
        assert.equal(tracker.recoveryBlocked, false,
            'mutable path identity failure is recoverable context drift, not persisted-state corruption');
    });

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
        assert.equal(await tracker.restorePersistedState(), 'incomplete');
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

    test('SCHEMA-V4 stopped coverage gaps preserve baselines without inventing a current review', async () => {
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
        assert.equal(await tracker.restorePersistedState(), 'incomplete');
        assert.equal(pending(target), undefined);
        assert.equal(tracker.getOriginalContent(target), 'baseline\n');
        assert.ok(tracker.getCoverageGaps().some(([path]) => path === target));
        assert.match(tracker.persistenceIssue ?? '', /older stopped session/i);
        assert.equal(tracker.getReviewToken(target), undefined);
    });

    test('SCHEMA-V5 pending explicit exclusion preserves stopped text review without importing later disk edits', async () => {
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
            version: 5, isRecording: false, baselineState: 'ready', workspaceRoots: [root],
            scanCoverage: 'a'.repeat(64),
            fileSnapshots: [[target, 'baseline\n']], fileModes: [], baselineExistingFiles: [target],
            unresolvedBaselineFiles: [], opaqueBaselineFiles: [], revertHistory: [], gitContexts: [],
            effectiveMonitoringScope: createLegacyEffectiveScope([rootIdentity], []),
            retainedReviewPaths: [], coverageGaps: [],
            stoppedReviews: [{filePath:target, currentContent:'pending at Stop\n', isDeleted:false,
                reviewKind:'text', timestamp:Date.now()}]
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
        assert.equal(pending(target)?.reviewKind, 'text');
        assert.equal(pending(target)?.currentContent, 'pending at Stop\n');
        assert.equal(tracker.getOriginalContent(target), 'baseline\n');
        assert.deepEqual(tracker.getCoverageGaps(), []);
        assert.deepEqual(tracker.getExplicitlyExcludedPendingReviewPaths(pendingScope), [target]);
        tracker.setPendingMonitoringScope(undefined);
        assert.equal(pending(target)?.currentContent, 'pending at Stop\n');
        assert.equal(await tracker.flushPendingPersistence(), true);
        const saved = JSON.parse(fs.readFileSync(path.join(storage, 'session-state.json'), 'utf8'));
        assert.equal(saved.stoppedReviews.find(review => review.filePath === target)?.reviewKind, 'text');
        assert.deepEqual(saved.coverageGaps, []);
    });

    for (const version of [4, 5]) test(`SCHEMA-V${version} requires effective scope, retained reviews and coverage gaps`, async () => {
        for (const field of ['effectiveMonitoringScope', 'retainedReviewPaths', 'coverageGaps']) {
            const { state } = fixture(version);
            delete state[field];
            assert.equal(getTracker().parsePersistedState(state), undefined, `missing ${field} must invalidate V${version}`);
        }
    });

    test('SCHEMA-V3 migration enters legacy scope compatibility and next write is V5', async () => {
        const { state } = fixture(3);
        delete state.effectiveMonitoringScope;
        delete state.retainedReviewPaths;
        delete state.coverageGaps;
        const parsed = getTracker().parsePersistedState(state);
        assert.ok(parsed);
        assert.equal(parsed.version, 4);
        assert.equal(parsed.effectiveMonitoringScope.kind, 'legacyV3');
        const tracker = getTracker();
        const storage = file('v3-to-v5-storage');
        fs.mkdirSync(storage);
        fs.writeFileSync(path.join(storage, 'session-state.json'), JSON.stringify(state));
        tracker.storageUri = Uri.file(storage);
        assert.equal(await tracker.restorePersistedState(), 'restored');
        assert.equal(await tracker.flushPendingPersistence(), true);
        const saved = JSON.parse(fs.readFileSync(path.join(storage, 'session-state.json'), 'utf8'));
        assert.equal(saved.version, 5);
        assert.equal(saved.effectiveMonitoringScope.kind, 'legacyV3');
    });

    for (const version of [2, 3, 4, 5]) {
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
        test(`SCHEMA-V5 interrupted V2 upgrade at ${failAt} retains durable intent until retry`, async () => {
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
                assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).version, 5);
            }
        });
    }
}
