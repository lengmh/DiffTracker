from pathlib import Path
import re

SRC = Path('src/diffTracker.ts')
TEST = Path('test/tracker-safety.mjs')

s = SRC.read_text(encoding='utf-8')

def once(old: str, new: str, label: str) -> None:
    global s
    count = s.count(old)
    assert count == 1, f'{label}: expected 1 occurrence, got {count}'
    s = s.replace(old, new, 1)

def replace_method(signature: str, replacement: str, label: str) -> None:
    global s
    starts = [i for i in range(len(s)) if s.startswith(signature, i)]
    assert len(starts) == 1, f'{label}: signature count={len(starts)}'
    start = starts[0]
    brace = s.index('{', start)
    depth = 0
    end = None
    for i in range(brace, len(s)):
        if s[i] == '{':
            depth += 1
        elif s[i] == '}':
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    assert end is not None, f'{label}: unterminated method'
    s = s[:start] + replacement + s[end:]

# ---------------------------------------------------------------------------
# Persisted first-class opaque baseline identity.
# ---------------------------------------------------------------------------
once(
    'interface PersistedTrackerState {',
    "interface OpaqueBaselineState {\n    reason: string;\n    size: number;\n    mtime: number;\n    fingerprint?: string;\n}\n\ninterface PersistedTrackerState {",
    'opaque interface',
)
once(
    '    unresolvedBaselineFiles: Array<[string, string]>;\n    revertHistory: PersistedRevertRecord[];',
    '    unresolvedBaselineFiles: Array<[string, string]>;\n    opaqueBaselineFiles: Array<[string, OpaqueBaselineState]>;\n    revertHistory: PersistedRevertRecord[];',
    'persisted opaque field',
)
once(
    "    | { kind: 'unavailable'; reason: string };",
    "    | { kind: 'unavailable'; reason: string; size?: number; mtime?: number; fingerprint?: string };",
    'current state metadata',
)
once(
    '    private unresolvedBaselineFiles = new Map<string, string>();\n    private trackedChanges = new Map<string, FileDiff>();',
    '    private unresolvedBaselineFiles = new Map<string, string>();\n    private opaqueBaselineFiles = new Map<string, OpaqueBaselineState>();\n    private trackedChanges = new Map<string, FileDiff>();',
    'opaque map field',
)

# Full baseline resets must forget prior opaque identities.
s, clear_count = re.subn(
    r'(?m)^(\s*)this\.unresolvedBaselineFiles\.clear\(\);$',
    r'\1this.unresolvedBaselineFiles.clear();\n\1this.opaqueBaselineFiles.clear();',
    s,
)
assert clear_count >= 2, f'opaque clear insert count={clear_count}'

# Stopped Clear uses replacement maps transactionally.
once(
    '            baselineExistingFiles: this.baselineExistingFiles, unresolvedBaselineFiles: this.unresolvedBaselineFiles,\n            revertHistory: this.revertHistory, baselineGitContexts: this.baselineGitContexts,',
    '            baselineExistingFiles: this.baselineExistingFiles, unresolvedBaselineFiles: this.unresolvedBaselineFiles,\n            opaqueBaselineFiles: this.opaqueBaselineFiles,\n            revertHistory: this.revertHistory, baselineGitContexts: this.baselineGitContexts,',
    'stopped rollback opaque',
)
once(
    '        this.unresolvedBaselineFiles = new Map();\n        this.revertHistory = [];',
    '        this.unresolvedBaselineFiles = new Map();\n        this.opaqueBaselineFiles = new Map();\n        this.revertHistory = [];',
    'stopped clear opaque',
)

# Restore persisted opaque identities.
once(
    '        this.unresolvedBaselineFiles = new Map(state.unresolvedBaselineFiles);\n        this.revertHistory = state.revertHistory.slice(-this.maxRevertHistory);',
    '        this.unresolvedBaselineFiles = new Map(state.unresolvedBaselineFiles);\n        this.opaqueBaselineFiles = new Map(state.opaqueBaselineFiles);\n        this.revertHistory = state.revertHistory.slice(-this.maxRevertHistory);',
    'restore opaque state',
)

# Persist opaque identities.
once(
    '        if (!this.isRecording && !this.baselineBuilding && !this.snapshotInitialized && this.fileSnapshots.size === 0 && this.unresolvedBaselineFiles.size === 0) {',
    '        if (!this.isRecording && !this.baselineBuilding && !this.snapshotInitialized && this.fileSnapshots.size === 0 &&\n            this.unresolvedBaselineFiles.size === 0 && this.opaqueBaselineFiles.size === 0) {',
    'empty persisted state',
)
once(
    '            unresolvedBaselineFiles: Array.from(this.unresolvedBaselineFiles.entries())\n                .sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath)),\n            revertHistory:',
    '            unresolvedBaselineFiles: Array.from(this.unresolvedBaselineFiles.entries())\n                .sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath)),\n            opaqueBaselineFiles: Array.from(this.opaqueBaselineFiles.entries())\n                .sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath)),\n            revertHistory:',
    'build opaque state',
)

# Backward-compatible parser: v2 states without opaqueBaselineFiles are valid.
once(
    '            unresolvedBaselineFiles?: unknown;\n            revertHistory?: unknown;',
    '            unresolvedBaselineFiles?: unknown;\n            opaqueBaselineFiles?: unknown;\n            revertHistory?: unknown;',
    'parser candidate opaque',
)
parser_anchor = "\n        if (candidate.scanCoverage !== undefined &&\n"
assert s.count(parser_anchor) == 1, 'parser anchor'
opaque_parse = '''
        const rawOpaque = candidate.version === 1 ? [] : (candidate.opaqueBaselineFiles ?? []);
        if (!Array.isArray(rawOpaque) || rawOpaque.length > this.maxPersistedSnapshots) { return undefined; }
        const opaqueBaselineFiles: Array<[string, OpaqueBaselineState]> = [];
        const opaquePaths = new Set<string>();
        for (const entry of rawOpaque) {
            if (!Array.isArray(entry) || entry.length !== 2 || !entry[1] || typeof entry[1] !== 'object') { return undefined; }
            const [filePath, rawState] = entry;
            const value = rawState as Partial<OpaqueBaselineState>;
            if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !isWithinRoot(filePath) ||
                snapshotPaths.has(filePath) || unresolvedPaths.has(filePath) || opaquePaths.has(filePath) ||
                typeof value.reason !== 'string' || !this.isStableUnsupportedBaselineReason(value.reason) ||
                typeof value.size !== 'number' || !Number.isFinite(value.size) || value.size < 0 ||
                typeof value.mtime !== 'number' || !Number.isFinite(value.mtime) || value.mtime < 0 ||
                (value.fingerprint !== undefined && (typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint)))) {
                return undefined;
            }
            opaqueBaselineFiles.push([filePath, {
                reason: value.reason,
                size: value.size,
                mtime: value.mtime,
                fingerprint: value.fingerprint
            }]);
            opaquePaths.add(filePath);
        }
'''
s = s.replace(parser_anchor, opaque_parse + parser_anchor, 1)
once(
    '            unresolvedBaselineFiles,\n            revertHistory,',
    '            unresolvedBaselineFiles,\n            opaqueBaselineFiles,\n            revertHistory,',
    'parser return opaque',
)

# ---------------------------------------------------------------------------
# Stable unsupported reads carry enough identity to compare without decoding.
# ---------------------------------------------------------------------------
s, oversize_count = re.subn(
    r"return \{ kind: 'unavailable', reason: 'File exceeds the 5 MiB limit' \};",
    "return { kind: 'unavailable', reason: 'File exceeds the 5 MiB limit', size: stat.size, mtime: stat.mtime };",
    s,
)
assert oversize_count >= 1, f'oversize replacement count={oversize_count}'
once(
    "return { kind: 'unavailable', reason: 'UTF-8 BOM files require encoding preservation and are read-only in this version' };",
    "return { kind: 'unavailable', reason: 'UTF-8 BOM files require encoding preservation and are read-only in this version', size: stat.size, mtime: stat.mtime, fingerprint: createHash('sha256').update(content).digest('hex') };",
    'BOM identity',
)
once(
    "return { kind: 'unavailable', reason: 'Binary content is unsupported' };",
    "return { kind: 'unavailable', reason: 'Binary content is unsupported', size: stat.size, mtime: stat.mtime, fingerprint: createHash('sha256').update(content).digest('hex') };",
    'binary identity',
)
once(
    "return { kind: 'unavailable', reason: 'Unsupported text encoding (expected UTF-8)' };",
    "return { kind: 'unavailable', reason: 'Unsupported text encoding (expected UTF-8)', size: stat.size, mtime: stat.mtime, fingerprint: createHash('sha256').update(content).digest('hex') };",
    'invalid UTF-8 identity',
)

# ---------------------------------------------------------------------------
# Separate uncertain baseline evidence from a known opaque baseline identity.
# ---------------------------------------------------------------------------
replace_method(
    '    private recordUnresolvedBaseline(filePath: string, reason: string, publishReview = true): void ',
    '''    private recordUnresolvedBaseline(filePath: string, reason: string): void {
        this.opaqueBaselineFiles.delete(filePath);
        this.postBaselineUnknownFiles.delete(filePath);
        this.unresolvedBaselineFiles.set(filePath, reason);
        this.markFileUnavailable(filePath, reason);
        this.schedulePersistState();
    }''',
    'record unresolved',
)

stable_sig = '    private isStableUnsupportedBaselineReason(reason: string): boolean '
starts = [i for i in range(len(s)) if s.startswith(stable_sig, i)]
assert len(starts) == 1, 'stable reason helper'
start = starts[0]
brace = s.index('{', start)
depth = 0
end = None
for i in range(brace, len(s)):
    if s[i] == '{': depth += 1
    elif s[i] == '}':
        depth -= 1
        if depth == 0:
            end = i + 1
            break
assert end is not None
helpers = '''

    private isStableUnsupportedState(state: CurrentFileState): state is Extract<CurrentFileState, { kind: 'unavailable' }> & { size: number; mtime: number } {
        return state.kind === 'unavailable' && this.isStableUnsupportedBaselineReason(state.reason) &&
            typeof state.size === 'number' && Number.isFinite(state.size) &&
            typeof state.mtime === 'number' && Number.isFinite(state.mtime);
    }

    private recordOpaqueBaseline(filePath: string, state: Extract<CurrentFileState, { kind: 'unavailable' }>): void {
        if (!this.isStableUnsupportedState(state)) {
            this.recordUnresolvedBaseline(filePath, state.reason);
            return;
        }
        this.postBaselineUnknownFiles.delete(filePath);
        this.unresolvedBaselineFiles.delete(filePath);
        this.fileSnapshots.delete(filePath);
        this.fileModes.delete(filePath);
        this.baselineExistingFiles.delete(filePath);
        this.opaqueBaselineFiles.set(filePath, {
            reason: state.reason,
            size: state.size,
            mtime: state.mtime,
            fingerprint: state.fingerprint
        });
        this.deleteTrackedChange(filePath);
        this.lineChanges.delete(filePath);
        this.markLineChangesUpdated(filePath);
        this.inlineViews.delete(filePath);
        this.schedulePersistState();
    }

    private opaqueBaselineMatches(baseline: OpaqueBaselineState, state: CurrentFileState): boolean {
        if (!this.isStableUnsupportedState(state) || baseline.reason !== state.reason) { return false; }
        if (baseline.fingerprint !== undefined) {
            return baseline.fingerprint === state.fingerprint;
        }
        return baseline.size === state.size && baseline.mtime === state.mtime;
    }

    private reconcileOpaqueBaseline(filePath: string, state: CurrentFileState): boolean {
        const baseline = this.opaqueBaselineFiles.get(filePath);
        if (!baseline) { return false; }
        if (this.opaqueBaselineMatches(baseline, state)) {
            if (this.trackedChanges.has(filePath) || this.lineChanges.has(filePath) || this.inlineViews.has(filePath)) {
                this.clearFileReview(filePath);
            }
            return true;
        }
        const reason = state.kind === 'missing'
            ? 'File was deleted after an unsupported baseline was accepted; original content is unavailable'
            : state.kind === 'text'
                ? 'File changed from an unsupported baseline; original content is unavailable'
                : this.isStableUnsupportedState(state)
                    ? 'Unsupported file changed since the baseline; content cannot be reviewed'
                    : state.reason;
        this.markFileUnavailable(filePath, reason);
        return true;
    }'''
s = s[:end] + helpers + s[end:]

# markFileUnavailable must preserve an existing opaque before-image identity.
once(
    '        if (this.isBinaryUnavailableReason(reason) && !this.baselineExistingFiles.has(filePath)) {',
    '        if (this.isBinaryUnavailableReason(reason) && !this.baselineExistingFiles.has(filePath) &&\n            !this.opaqueBaselineFiles.has(filePath)) {',
    'binary opaque guard',
)
once(
    '        if (!this.fileSnapshots.has(filePath)) {\n            if (!this.unresolvedBaselineFiles.has(filePath) && this.snapshotInitialized && !this.baselineBuilding && this.restoringEpoch === undefined) {',
    '        if (!this.fileSnapshots.has(filePath) && !this.opaqueBaselineFiles.has(filePath)) {\n            if (!this.unresolvedBaselineFiles.has(filePath) && this.snapshotInitialized && !this.baselineBuilding && this.restoringEpoch === undefined) {',
    'unavailable opaque guard',
)

# ---------------------------------------------------------------------------
# Explicit baseline scan / Clear: accept stable unsupported resources as opaque.
# ---------------------------------------------------------------------------
old_scan = '''                    if (state.kind !== 'text') {
                        const reason = state.kind === 'unavailable'
                            ? state.reason
                            : 'File disappeared during baseline scan; before-image is unknown';
                        const publishReview = state.kind !== 'unavailable' || !this.isStableUnsupportedBaselineReason(reason);
                        this.recordUnresolvedBaseline(uri.fsPath, reason, publishReview);
                        return;
                    }'''
new_scan = '''                    if (state.kind !== 'text') {
                        if (this.isStableUnsupportedState(state)) {
                            const dirty = vscode.workspace.textDocuments.some(doc =>
                                doc.uri.scheme === 'file' && doc.uri.fsPath === uri.fsPath && doc.isDirty);
                            if (dirty) {
                                this.recordUnresolvedBaseline(uri.fsPath, 'Unsupported file has unsaved editor changes; save or discard them before clearing the baseline');
                            } else {
                                this.recordOpaqueBaseline(uri.fsPath, state);
                            }
                            return;
                        }
                        const reason = state.kind === 'unavailable'
                            ? state.reason
                            : 'File disappeared during baseline scan; before-image is unknown';
                        this.recordUnresolvedBaseline(uri.fsPath, reason);
                        return;
                    }'''
once(old_scan, new_scan, 'baseline scan opaque')

# Opening an unchanged opaque baseline is not a change event.
old_open = '''        const unresolvedReason = this.unresolvedBaselineFiles.get(filePath);
        if (unresolvedReason && this.isStableUnsupportedBaselineReason(unresolvedReason)) {
            // Opening an unchanged opaque-baseline resource is not evidence of a file change.
            // Actual document/file change events still surface it for explicit review.
            return;
        }
        if (unresolvedReason ||
            (this.snapshotInitialized && (!this.scanCoverage || this.scanCoverage !== this.ignoreFingerprint))) {'''
new_open = '''        if (this.opaqueBaselineFiles.has(filePath)) { return; }
        const unresolvedReason = this.unresolvedBaselineFiles.get(filePath);
        if (unresolvedReason ||
            (this.snapshotInitialized && (!this.scanCoverage || this.scanCoverage !== this.ignoreFingerprint))) {'''
once(old_open, new_open, 'document-open opaque guard')

# Restored file discovery must not classify an opaque-baseline file as a new addition.
sig = '    private async discoverRestoredFiles(epoch: number): Promise<void> '
starts = [i for i in range(len(s)) if s.startswith(sig, i)]
assert len(starts) == 1
fstart = starts[0]
fend = s.index('    private async rebuildTrackedChangesFromSnapshots()', fstart)
block = s[fstart:fend]
old_cond = 'this.fileSnapshots.has(filePath) || this.unresolvedBaselineFiles.has(filePath)'
assert block.count(old_cond) == 2, f'discover condition count={block.count(old_cond)}'
block = block.replace(old_cond, 'this.fileSnapshots.has(filePath) || this.unresolvedBaselineFiles.has(filePath) || this.opaqueBaselineFiles.has(filePath)')
s = s[:fstart] + block + s[fend:]

# Restore re-reads every opaque identity before deciding it is still unchanged.
old_restore_tail = '''        if (!this.isCurrentEpoch(epoch)) { return; }
        for (const [filePath, reason] of this.unresolvedBaselineFiles) {
            if (!this.isPathIgnored(vscode.Uri.file(filePath)) &&
                !this.isStableUnsupportedBaselineReason(reason)) {
                this.markFileUnavailable(filePath, reason);
            }
        }
    }'''
new_restore_tail = '''        if (!this.isCurrentEpoch(epoch)) { return; }
        const opaquePaths = Array.from(this.opaqueBaselineFiles.keys());
        await this.runWithConcurrency(opaquePaths, 8, async (filePath) => {
            const uri = vscode.Uri.file(filePath);
            if (this.isPathIgnored(uri)) { return; }
            const currentState = await this.readCurrentFileState(filePath);
            if (!this.isCurrentEpoch(epoch)) { return; }
            this.reconcileOpaqueBaseline(filePath, currentState);
        });
        if (!this.isCurrentEpoch(epoch)) { return; }
        for (const [filePath, reason] of this.unresolvedBaselineFiles) {
            if (!this.isPathIgnored(vscode.Uri.file(filePath))) {
                this.markFileUnavailable(filePath, reason);
            }
        }
    }'''
once(old_restore_tail, new_restore_tail, 'restore opaque reconciliation')

# Watcher/file-event reads compare current state to the opaque baseline identity.
once(
    "        if (state.kind === 'unavailable') {\n            this.markFileUnavailable(filePath, state.reason);",
    "        if (this.reconcileOpaqueBaseline(filePath, state)) {\n            return;\n        }\n        if (state.kind === 'unavailable') {\n            this.markFileUnavailable(filePath, state.reason);",
    'read update opaque reconciliation',
)

# Parent-directory deletions must also visit opaque-baseline descendants.
once(
    '        const targets = new Set([uri.fsPath, ...[...this.fileSnapshots.keys()].filter(filePath => {',
    '        const baselinePaths = new Set([...this.fileSnapshots.keys(), ...this.opaqueBaselineFiles.keys()]);\n        const targets = new Set([uri.fsPath, ...[...baselinePaths].filter(filePath => {',
    'delete opaque descendants',
)

# Creation provenance must not overwrite an existing opaque before-image.
s = s.replace(
    'if (!duringScan && !this.fileSnapshots.has(filePath) &&\n            (!this.unresolvedBaselineFiles.has(filePath) || this.postBaselineUnknownFiles.has(filePath))) {',
    'if (!duringScan && !this.fileSnapshots.has(filePath) && !this.opaqueBaselineFiles.has(filePath) &&\n            (!this.unresolvedBaselineFiles.has(filePath) || this.postBaselineUnknownFiles.has(filePath))) {',
)
s = s.replace(
    'if (!this.fileSnapshots.has(filePath) && (!this.unresolvedBaselineFiles.has(filePath) || this.postBaselineUnknownFiles.has(filePath))) {',
    'if (!this.fileSnapshots.has(filePath) && !this.opaqueBaselineFiles.has(filePath) &&\n                (!this.unresolvedBaselineFiles.has(filePath) || this.postBaselineUnknownFiles.has(filePath))) {',
)

# Ignore-rule reconciliation includes opaque baselines.
once(
    '            for (const filePath of [...this.fileSnapshots.keys(), ...this.unresolvedBaselineFiles.keys()]) {',
    '            for (const filePath of [...this.fileSnapshots.keys(), ...this.unresolvedBaselineFiles.keys(), ...this.opaqueBaselineFiles.keys()]) {',
    'ignore refresh opaque paths',
)

# ---------------------------------------------------------------------------
# Repository baseline rebuild is transactional for opaque identities as well.
# ---------------------------------------------------------------------------
once(
    '            unresolvedBaselineFiles: new Map(this.unresolvedBaselineFiles),\n            baselineGitContexts:',
    '            unresolvedBaselineFiles: new Map(this.unresolvedBaselineFiles),\n            opaqueBaselineFiles: new Map(this.opaqueBaselineFiles),\n            baselineGitContexts:',
    'repo previous opaque',
)
once(
    '            this.unresolvedBaselineFiles = previous.unresolvedBaselineFiles;\n            this.baselineGitContexts = previous.baselineGitContexts;',
    '            this.unresolvedBaselineFiles = previous.unresolvedBaselineFiles;\n            this.opaqueBaselineFiles = previous.opaqueBaselineFiles;\n            this.baselineGitContexts = previous.baselineGitContexts;',
    'repo rollback opaque',
)
once(
    '                ...this.fileSnapshots.keys(),\n                ...this.unresolvedBaselineFiles.keys()\n            ]);',
    '                ...this.fileSnapshots.keys(),\n                ...this.unresolvedBaselineFiles.keys(),\n                ...this.opaqueBaselineFiles.keys()\n            ]);',
    'repo baseline path set',
)
once(
    '                this.unresolvedBaselineFiles.delete(filePath);\n                this.deleteTrackedChange(filePath);',
    '                this.unresolvedBaselineFiles.delete(filePath);\n                this.opaqueBaselineFiles.delete(filePath);\n                this.deleteTrackedChange(filePath);',
    'repo delete opaque',
)
old_rebuild = '''                if (state.kind !== 'text') {
                    // Stable unsupported resources can be accepted as an opaque baseline.
                    // They remain unresolved internally so a later file event can surface
                    // the path again without pretending Code Diff Tracker can decode it.
                    const reason = state.kind === 'unavailable'
                        ? state.reason
                        : 'File disappeared during baseline rebuild; before-image is unknown';
                    const publishReview = state.kind !== 'unavailable' || !this.isStableUnsupportedBaselineReason(reason);
                    this.recordUnresolvedBaseline(uri.fsPath, reason, publishReview);
                    return;
                }'''
new_rebuild = '''                if (state.kind !== 'text') {
                    if (this.isStableUnsupportedState(state)) {
                        this.recordOpaqueBaseline(uri.fsPath, state);
                        return;
                    }
                    const reason = state.kind === 'unavailable'
                        ? state.reason
                        : 'File disappeared during baseline rebuild; before-image is unknown';
                    this.recordUnresolvedBaseline(uri.fsPath, reason);
                    return;
                }'''
once(old_rebuild, new_rebuild, 'repo rebuild opaque')

SRC.write_text(s, encoding='utf-8')

# ---------------------------------------------------------------------------
# Regression tests.
# ---------------------------------------------------------------------------
t = TEST.read_text(encoding='utf-8')

def tone(old: str, new: str, label: str) -> None:
    global t
    count = t.count(old)
    assert count == 1, f'{label}: expected 1 occurrence, got {count}'
    t = t.replace(old, new, 1)

tone(
    '    assert.ok(tracker.unresolvedBaselineFiles.has(p));assert.equal(await tracker.flushPendingPersistence(),true);',
    '    assert.ok(tracker.opaqueBaselineFiles.has(p));assert.equal(tracker.unresolvedBaselineFiles.has(p),false);assert.equal(await tracker.flushPendingPersistence(),true);',
    'clear opaque assertion',
)
tone(
    "    tracker.onDocumentOpened(document(p));assert.equal(pending(p),undefined,'opening an unchanged opaque baseline must stay quiet');\n    await scan(p);assert.ok(pending(p)?.unavailableReason,'a post-baseline event must surface the unsupported path again');",
    "    tracker.onDocumentOpened(document(p));assert.equal(pending(p),undefined,'opening an unchanged opaque baseline must stay quiet');\n    if(kind==='oversized') fs.writeFileSync(p,'changed-after-clear');\n    else if(kind==='bom') fs.writeFileSync(p,Buffer.from([0xef,0xbb,0xbf,0x61,0x62]));\n    else fs.writeFileSync(p,Buffer.from([0xc3,0x28,0x41]));\n    await scan(p);assert.ok(pending(p)?.unavailableReason,'a changed opaque baseline must surface for review');",
    'changed opaque assertion',
)
tone(
    "    assert.equal(pending(p),undefined);assert.equal(tracker.unresolvedBaselineFiles.has(p),false);\n    const saved=JSON.parse(disk(path.join(storage,'session-state.json')));\n    assert.equal(saved.unresolvedBaselineFiles.length,0);assert.equal(saved.fileSnapshots.length,0);",
    "    assert.equal(pending(p),undefined);assert.equal(tracker.unresolvedBaselineFiles.has(p),false);assert.equal(tracker.opaqueBaselineFiles.has(p),false);\n    const saved=JSON.parse(disk(path.join(storage,'session-state.json')));\n    assert.equal(saved.unresolvedBaselineFiles.length,0);assert.equal(saved.opaqueBaselineFiles.length,0);assert.equal(saved.fileSnapshots.length,0);",
    'stopped clear opaque assertion',
)

marker = "test('DT-08 explicit baseline reset accepts the current dirty editor content',async()=>{"
assert t.count(marker) == 1
extra = r'''test('DT-08 deleting an accepted opaque baseline surfaces an unavailable review',async()=>{
    const p=file('opaque-delete-bom.txt');fs.writeFileSync(p,Buffer.from([0xef,0xbb,0xbf,0x61]));listedFiles=[Uri.file(p)];
    assert.equal(await tracker.resetBaselineToCurrentState(),true);assert.ok(tracker.opaqueBaselineFiles.has(p));assert.equal(pending(p),undefined);
    fs.unlinkSync(p);await tracker.onExternalFileDeleted(Uri.file(p));
    assert.match(pending(p)?.unavailableReason??'',/deleted.*unsupported baseline/i);
});
test('DT-08 restored opaque baseline detects offline replacement with ordinary text',async()=>{
    const p=file('opaque-offline-replace.txt'),storage=file('storage');fs.writeFileSync(p,Buffer.from([0xef,0xbb,0xbf,0x61]));
    tracker.storageUri=Uri.file(storage);listedFiles=[Uri.file(p)];assert.equal(await tracker.resetBaselineToCurrentState(),true);
    assert.ok(tracker.opaqueBaselineFiles.has(p));assert.equal(await tracker.flushPendingPersistence(),true);await tracker.dispose();
    fs.writeFileSync(p,'ordinary text after restart');tracker=new DiffTracker(Uri.file(storage));
    assert.equal(await tracker.restorePersistedState(),'restored');assert.match(pending(p)?.unavailableReason??'',/unsupported baseline/i);
});
test('DT-08 restored opaque baseline detects offline deletion',async()=>{
    const p=file('opaque-offline-delete.txt'),storage=file('storage');fs.writeFileSync(p,Buffer.from([0xef,0xbb,0xbf,0x61]));
    tracker.storageUri=Uri.file(storage);listedFiles=[Uri.file(p)];assert.equal(await tracker.resetBaselineToCurrentState(),true);
    assert.equal(await tracker.flushPendingPersistence(),true);await tracker.dispose();fs.unlinkSync(p);tracker=new DiffTracker(Uri.file(storage));
    assert.equal(await tracker.restorePersistedState(),'restored');assert.match(pending(p)?.unavailableReason??'',/deleted.*unsupported baseline/i);
});
'''
t = t.replace(marker, extra + marker, 1)

# Repository rebuild expectations: stable unsupported paths persist as opaque identities;
# actual uncertainty (unreadable/missing) remains unresolved and visible.
old = "    const saved=JSON.parse(fs.readFileSync(path.join(storage,'session-state.json'),'utf8'));\n    assert.ok(saved.unresolvedBaselineFiles.some(([f])=>f===p));assert.ok(tracker.parsePersistedState(saved));"
new = "    const saved=JSON.parse(fs.readFileSync(path.join(storage,'session-state.json'),'utf8'));\n    if(quiet)assert.ok(saved.opaqueBaselineFiles.some(([f])=>f===p));else assert.ok(saved.unresolvedBaselineFiles.some(([f])=>f===p));\n    assert.ok(tracker.parsePersistedState(saved));"
tone(old, new, 'repo persisted opaque expectation')

TEST.write_text(t, encoding='utf-8')
