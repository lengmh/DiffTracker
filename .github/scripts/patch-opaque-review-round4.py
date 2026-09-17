from pathlib import Path

SRC = Path('src/diffTracker.ts')
TEST = Path('test/tracker-safety.mjs')
s = SRC.read_text(encoding='utf-8')

def once(old: str, new: str, label: str) -> None:
    global s
    count = s.count(old)
    assert count == 1, f'{label}: expected 1 occurrence, got {count}'
    s = s.replace(old, new, 1)

# Preserve pre-existing baseline uncertainty instead of allowing a later binary
# reread to downgrade it into a hidden binary-only marker.
once(
"""    private markFileUnavailable(filePath: string, reason: string): void {
        if (this.isBinaryUnavailableReason(reason) && !this.baselineExistingFiles.has(filePath) &&
            !this.opaqueBaselineFiles.has(filePath)) {""",
"""    private markFileUnavailable(filePath: string, reason: string): void {
        const existingUnresolvedReason = this.unresolvedBaselineFiles.get(filePath);
        const preservedUncertaintyReason = existingUnresolvedReason &&
            !this.isStableUnsupportedBaselineReason(existingUnresolvedReason) &&
            !this.isBinaryUnavailableReason(existingUnresolvedReason)
            ? existingUnresolvedReason
            : undefined;
        if (this.isBinaryUnavailableReason(reason) && !this.baselineExistingFiles.has(filePath) &&
            !this.opaqueBaselineFiles.has(filePath) && !preservedUncertaintyReason) {""",
    'preserve unresolved uncertainty before binary suppression',
)
once(
"""            if (!this.fileSnapshots.has(filePath)) {
                this.unresolvedBaselineFiles.set(filePath, reason);
                this.schedulePersistState();
            }""",
"""            if (!this.fileSnapshots.has(filePath)) {
                this.unresolvedBaselineFiles.set(filePath, existingUnresolvedReason ?? reason);
                this.schedulePersistState();
            }""",
    'retain binary-only unresolved marker',
)
once(
"""        if (!this.fileSnapshots.has(filePath) && !this.opaqueBaselineFiles.has(filePath)) {
            if (!this.unresolvedBaselineFiles.has(filePath) && this.snapshotInitialized && !this.baselineBuilding && this.restoringEpoch === undefined) {
                this.postBaselineUnknownFiles.add(filePath);
            }
            this.unresolvedBaselineFiles.set(filePath, reason.slice(0, 1000));
            this.schedulePersistState();
        }
        const previous = this.trackedChanges.get(filePath);""",
"""        if (!this.fileSnapshots.has(filePath) && !this.opaqueBaselineFiles.has(filePath)) {
            if (!existingUnresolvedReason && this.snapshotInitialized && !this.baselineBuilding && this.restoringEpoch === undefined) {
                this.postBaselineUnknownFiles.add(filePath);
            }
            if (!preservedUncertaintyReason) {
                this.unresolvedBaselineFiles.set(filePath, reason.slice(0, 1000));
                this.schedulePersistState();
            }
        }
        const effectiveReason = preservedUncertaintyReason ?? reason;
        const previous = this.trackedChanges.get(filePath);""",
    'do not overwrite preserved uncertainty',
)
once(
"""            changes: previous?.changes ?? [], timestamp: new Date(), unavailableReason: reason
        });""",
"""            changes: previous?.changes ?? [], timestamp: new Date(), unavailableReason: effectiveReason
        });""",
    'show preserved uncertainty reason',
)

# A create notification can describe disk bytes while an opaque-baseline document
# has unsaved buffer edits. Never let a matching disk fingerprint clear that review.
once(
"""                if (!await this.completeBaseline(epoch)) { return; }
            }
            if (this.reconcileOpaqueBaseline(filePath, state)) {
                return;
            }
            if (state.kind === 'unavailable') {""",
"""                if (!await this.completeBaseline(epoch)) { return; }
            }
            const opaqueDocument = this.opaqueBaselineFiles.has(filePath)
                ? vscode.workspace.textDocuments.find(document =>
                    document.uri.scheme === 'file' && document.uri.fsPath === filePath)
                : undefined;
            if (opaqueDocument?.isDirty) {
                this.markFileUnavailable(filePath, 'Create notification while editor has unsaved content; reconcile disk and buffer before review');
                return;
            }
            if (this.reconcileOpaqueBaseline(filePath, state)) {
                return;
            }
            if (state.kind === 'unavailable') {""",
    'guard opaque create reconciliation against dirty editors',
)
SRC.write_text(s, encoding='utf-8')

# Regression coverage for both latest P1 findings.
t = TEST.read_text(encoding='utf-8')
marker = "test('DT-07 branch change during rebuild keeps the repository paused',async()=>{"
assert t.count(marker) == 1
regression = r'''test('DT-07 repository rebuild keeps scan-uncertain binary review visible after pending reread',async()=>{
    const repo=path.join(root,'repo-rebuild-binary-uncertainty');fs.mkdirSync(repo);
    const p=path.join(repo,'scan-binary.dat');tracker.fileSnapshots.set(p,'old text baseline');tracker.baselineExistingFiles.add(p);
    fs.writeFileSync(p,Buffer.from([0x00,0x01,0x02,0x03]));
    const base={repoRoot:repo,kind:'repository',headName:'main',headCommit:'aaa',detached:false,inProgress:false};
    const current={...base,headName:'feature',headCommit:'bbb'};tracker.setBaselineGitContexts([base]);tracker.observeGitContext(current);
    tracker.storageUri=Uri.file(path.join(root,`storage-${index++}`));listedFiles=[Uri.file(p)];
    await tracker.startExternalWatchers();const gate=pause(p,'read');const rebuild=tracker.rebuildRepositoryBaseline(repo,current);await gate.entered;
    fs.writeFileSync(p,Buffer.from([0x00,0x09,0x08,0x07]));emitWatcher('change',Uri.file(p));
    await waitUntil(()=>tracker.unresolvedBaselineFiles.has(p));gate.release();
    assert.equal(await rebuild,true);await new Promise(resolve=>setTimeout(resolve,180));
    assert.equal(tracker.opaqueBaselineFiles.has(p),false,'scan-uncertain binary content must not become an accepted opaque baseline');
    assert.ok(tracker.unresolvedBaselineFiles.has(p));
    assert.match(pending(p)?.unavailableReason??'',/before-image|baseline rebuild|scan/i,'binary reread must not hide rebuild uncertainty');
});
'''
t = t.replace(marker, regression + marker, 1)

marker = "test('DT-08 editing an open opaque-baseline document surfaces an unavailable review',async()=>{"
assert t.count(marker) == 1
regression = r'''test('DT-08 identical opaque create cannot clear a dirty editor review',async()=>{
    const p=file('opaque-dirty-create-bom.txt'),bytes=Buffer.from([0xef,0xbb,0xbf,0x61]);
    fs.writeFileSync(p,bytes);listedFiles=[Uri.file(p)];
    assert.equal(await tracker.resetBaselineToCurrentState(),true);assert.ok(tracker.opaqueBaselineFiles.has(p));
    const doc=document(p);tracker.onDocumentOpened(doc);doc.text='dirty editor content';doc.isDirty=true;doc.version++;
    tracker.onDocumentChanged({document:doc});assert.ok(pending(p)?.unavailableReason);
    fs.unlinkSync(p);fs.writeFileSync(p,bytes);await tracker.onExternalFileCreated(Uri.file(p));
    assert.equal(doc.isDirty,true);assert.ok(tracker.opaqueBaselineFiles.has(p));
    assert.match(pending(p)?.unavailableReason??'',/unsaved|unsupported baseline|Document changed/i,'create reconciliation must not erase a dirty buffer review');
});
'''
t = t.replace(marker, regression + marker, 1)
TEST.write_text(t, encoding='utf-8')
