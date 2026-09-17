from pathlib import Path
import subprocess

SOURCE = Path('src/diffTracker.ts')
TEST = Path('test/tracker-safety.mjs')
assert subprocess.check_output(['git', 'hash-object', str(SOURCE)], text=True).strip() == 'eef46cd781b467064fc5953e44cf00f263a5d459', 'Source changed: rebase and review before applying'
s = SOURCE.read_text(encoding='utf-8')

def once(old, new, label):
    global s
    assert s.count(old) == 1, f'{label}: expected exactly one match, got {s.count(old)}'
    s = s.replace(old, new, 1)

# Both scanners publish through the same synchronous acceptance boundary. A
# scanner cannot replace a before-image captured by an editor while its read waited.
start = s.index('                    if (this.hasScanUncertainty(uri.fsPath)) {', s.index('private async initializeWorkspaceSnapshots'))
end_marker = '                    this.baselineExistingFiles.add(uri.fsPath);'
end = s.index(end_marker, start) + len(end_marker)
s = s[:start] + "                    this.recordScannedBaseline(uri.fsPath, state, 'workspace');" + s[end:]
start = s.index('                if (this.hasScanUncertainty(uri.fsPath)) {', s.index('private async performRepositoryRebuild'))
end_marker = '                this.baselineExistingFiles.add(uri.fsPath);'
end = s.index(end_marker, start) + len(end_marker)
s = s[:start] + "                this.recordScannedBaseline(uri.fsPath, state, 'repository');" + s[end:]

anchor = '    private recordOpaqueBaseline(filePath: string, state: Extract<CurrentFileState, { kind: \'unavailable\' }>): void {'
helpers = '''    private hasCapturedBaseline(filePath: string): boolean {
        return this.fileSnapshots.has(filePath) || this.opaqueBaselineFiles.has(filePath);
    }

    private hasDirtyDocument(filePath: string): boolean {
        return vscode.workspace.textDocuments.some(document =>
            document.uri.scheme === 'file' && document.uri.fsPath === filePath && document.isDirty);
    }

    private recordScannedBaseline(filePath: string, state: CurrentFileState, scope: 'workspace' | 'repository'): void {
        // Recheck after the scanner's await. An editor may have captured a valid
        // before-image in the meantime; neither scanner may overwrite it.
        if (this.hasCapturedBaseline(filePath) || this.isPathIgnored(vscode.Uri.file(filePath))) { return; }
        const phase = scope === 'repository' ? 'repository baseline rebuild' : 'baseline scan';
        if (this.hasScanUncertainty(filePath)) {
            this.recordUnresolvedBaseline(filePath, `File changed during ${phase}; before-image is unknown`);
            return;
        }
        if (state.kind === 'text') {
            this.unresolvedBaselineFiles.delete(filePath);
            this.fileSnapshots.set(filePath, state.content);
            if (state.mode !== undefined) { this.fileModes.set(filePath, state.mode); }
            this.baselineExistingFiles.add(filePath);
            return;
        }
        if (this.isStableUnsupportedState(state)) {
            this.recordOpaqueBaseline(filePath, state);
            return;
        }
        this.recordUnresolvedBaseline(filePath, state.kind === 'unavailable'
            ? state.reason : `File disappeared during ${phase}; before-image is unknown`);
    }

'''
once(anchor, helpers + anchor, 'shared scan publication')
once(anchor + '\n        if (!this.isStableUnsupportedState(state)) {', anchor + '''
        // Acceptance is synchronous and owns its safety checks: new callers must
        // not be able to erase dirty buffers or historical scan evidence.
        if (this.hasCapturedBaseline(filePath)) { return; }
        if (this.hasScanUncertainty(filePath)) {
            this.recordUnresolvedBaseline(filePath, 'File changed during baseline scan; before-image is unknown');
            return;
        }
        if (this.hasDirtyDocument(filePath)) {
            this.recordUnresolvedBaseline(filePath, 'Unsupported file has unsaved editor changes; save or discard them before clearing the baseline');
            return;
        }
        if (!this.isStableUnsupportedState(state)) {''', 'opaque acceptance invariants')

# Matching disk bytes never prove an unchanged dirty editor. Enforce this at the
# common reconciliation boundary, not independently in every event callback.
once('''        const baseline = this.opaqueBaselineFiles.get(filePath);
        if (!baseline) { return false; }
        if (this.opaqueBaselineMatches(baseline, state)) {''', '''        const baseline = this.opaqueBaselineFiles.get(filePath);
        if (!baseline) { return false; }
        if (this.hasDirtyDocument(filePath)) {
            this.markFileUnavailable(filePath, 'Disk notification while editor has unsaved content; reconcile disk and buffer before review');
            return true;
        }
        if (this.opaqueBaselineMatches(baseline, state)) {''', 'opaque reconciliation invariants')
once('''            const opaqueDocument = this.opaqueBaselineFiles.has(filePath)
                ? vscode.workspace.textDocuments.find(document =>
                    document.uri.scheme === 'file' && document.uri.fsPath === filePath)
                : undefined;
            if (opaqueDocument?.isDirty) {
                this.markFileUnavailable(filePath, 'Create notification while editor has unsaved content; reconcile disk and buffer before review');
                return;
            }
''', '', 'remove duplicated create-only guard')

# A captured opaque identity is a real before-image even though it has no text.
once('        if (this.snapshotInitialized || this.fileSnapshots.has(filePath)) { return false; }',
     '        if (this.snapshotInitialized || this.hasCapturedBaseline(filePath)) { return false; }', 'captured opaque watcher evidence')
once('const scanEvent = this.markScanEvent(filePath) || (duringScan && !this.fileSnapshots.has(filePath));',
     'const scanEvent = this.markScanEvent(filePath) || (duringScan && !this.hasCapturedBaseline(filePath));', 'captured opaque imported create evidence')

# Unknown unsupported documents need durable scan evidence, even when autosave
# or closing the editor clears isDirty again before the scanner resumes.
once('''            if (this.opaqueBaselineFiles.has(filePath)) {
                // Opening an opaque-baseline document is quiet, but an actual editor
                // mutation must be visible even though the original bytes cannot be
                // decoded into a normal text diff.
                this.markFileUnavailable(filePath, 'Document changed from an unsupported baseline; original content is unavailable');
                return;
            }
            this.ensureSnapshotForDocument(doc);
            if (!this.fileSnapshots.has(filePath)) { return; }''', '''            if (this.opaqueBaselineFiles.has(filePath)) {
                this.processDocumentChange(doc);
                return;
            }
            this.ensureSnapshotForDocument(doc);
            if (!this.fileSnapshots.has(filePath)) {
                if (!this.snapshotInitialized) {
                    this.scanUncertainFiles.add(filePath);
                    this.recordUnresolvedBaseline(filePath, 'Document changed during baseline scan; before-image is unknown');
                }
                return;
            }''', 'durable editor scan evidence')

once('''        if (this.pendingWriteFiles.has(filePath)) { return; }
        try {
            fs.statSync(filePath);''', '''        if (this.pendingWriteFiles.has(filePath)) { return; }
        if (this.opaqueBaselineFiles.has(filePath)) {
            if (doc.isDirty) {
                this.markFileUnavailable(filePath, 'Document changed from an unsupported baseline; original content is unavailable');
            } else {
                // Save/reload/Undo may return an opaque document to its baseline.
                // Verify bytes instead of feeding undecodable content to text diff.
                void this.readFileAndUpdate(filePath, uri).catch(() => undefined);
            }
            return;
        }
        try {
            fs.statSync(filePath);''', 'opaque save and reload reconciliation')

start = s.index('    private ensureSnapshotForDocument(')
tail = s[start:]
old = '''        if (this.fileSnapshots.has(filePath)) {
            return;
        }'''
assert tail.count(old) == 1
s = s[:start] + tail.replace(old, '''        if (this.hasCapturedBaseline(filePath)) {
            return;
        }''', 1)
once('        if (this.opaqueBaselineFiles.has(filePath)) { return; }\n        const unresolvedReason', '        const unresolvedReason', 'known opaque open remains quiet')
SOURCE.write_text(s, encoding='utf-8')

# Register the matrix in the existing production harness; no duplicated tracker
# implementation and no new dependencies. All existing filters still apply.
t = TEST.read_text(encoding='utf-8')
assert "import { registerOpaqueBaselineInvariants }" not in t
anchor = "import assert from 'node:assert/strict';"
assert t.count(anchor) == 1
t = t.replace(anchor, "import { registerOpaqueBaselineInvariants } from './opaque-baseline-invariants.mjs';\n" + anchor, 1)
anchor = 'if(process.env.DT_TEST_FILTER)'
assert t.count(anchor) == 1
t = t.replace(anchor, '''registerOpaqueBaselineInvariants({
    test, root, Uri, DiffTracker, docs, counters, document, file, pending, pause, waitUntil,
    getTracker: () => tracker,
    setTracker: value => { tracker = value; },
    setListedFiles: value => { listedFiles = value; }
});

''' + anchor, 1)
TEST.write_text(t, encoding='utf-8')

changelog = Path('CHANGELOG.md')
c = changelog.read_text(encoding='utf-8')
c = c.replace('## 0.7.2\n', '''## 0.7.2

- Unify workspace and repository scan acceptance checks; preserve concurrent editor changes even if the editor is saved or closed before scanning completes.
- Keep already-captured opaque identities intact during remaining scan work, and revalidate clean save/reload notifications without dropping dirty-buffer reviews.
- Add a cross-product regression matrix for unsupported formats, scan scopes, document transitions, and follow-up file events.
''', 1)
changelog.write_text(c, encoding='utf-8')
