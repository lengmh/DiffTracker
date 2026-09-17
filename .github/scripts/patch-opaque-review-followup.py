from pathlib import Path

SRC = Path('src/diffTracker.ts')
TEST = Path('test/tracker-safety.mjs')
s = SRC.read_text(encoding='utf-8')

# P2: create notifications for an existing opaque baseline must reconcile the
# saved identity before publishing an unavailable review. This keeps identical
# delete/create replacements quiet while still surfacing changed opaque bytes.
create_start = s.index('    private async onExternalFileCreated(')
create_end = s.index('    private async onExternalFileDeleted(', create_start)
create_block = s[create_start:create_end]
old_create = '''            if (state.kind === 'unavailable') {\n                this.markFileUnavailable(filePath, state.reason);\n                return;\n            }\n            await this.readFileAndUpdate(filePath, uri);'''
new_create = '''            if (this.reconcileOpaqueBaseline(filePath, state)) {\n                return;\n            }\n            if (state.kind === 'unavailable') {\n                this.markFileUnavailable(filePath, state.reason);\n                return;\n            }\n            await this.readFileAndUpdate(filePath, uri);'''
assert create_block.count(old_create) == 1, f'create reconciliation target count={create_block.count(old_create)}'
create_block = create_block.replace(old_create, new_create, 1)
s = s[:create_start] + create_block + s[create_end:]

# P1: repository rebuilds must honor scan uncertainty before accepting any
# stable unsupported state as a new opaque baseline. This mirrors the full
# workspace scanner and prevents a watcher-observed change from being erased.
rebuild_start = s.index('    private async performRepositoryRebuild(')
rebuild_end = s.index('    private validateResourceTarget(', rebuild_start)
rebuild_block = s[rebuild_start:rebuild_end]
old_rebuild = '''                if (state.kind !== 'text') {\n                    if (this.isStableUnsupportedState(state)) {\n                        this.recordOpaqueBaseline(uri.fsPath, state);\n                        return;\n                    }\n                    const reason = state.kind === 'unavailable'\n                        ? state.reason\n                        : 'File disappeared during baseline rebuild; before-image is unknown';\n                    this.recordUnresolvedBaseline(uri.fsPath, reason);\n                    return;\n                }\n                if (this.hasScanUncertainty(uri.fsPath)) {\n                    this.recordUnresolvedBaseline(uri.fsPath, 'File changed during repository baseline rebuild; before-image is unknown');\n                    return;\n                }'''
new_rebuild = '''                if (this.hasScanUncertainty(uri.fsPath)) {\n                    this.recordUnresolvedBaseline(uri.fsPath, 'File changed during repository baseline rebuild; before-image is unknown');\n                    return;\n                }\n                if (state.kind !== 'text') {\n                    if (this.isStableUnsupportedState(state)) {\n                        this.recordOpaqueBaseline(uri.fsPath, state);\n                        return;\n                    }\n                    const reason = state.kind === 'unavailable'\n                        ? state.reason\n                        : 'File disappeared during baseline rebuild; before-image is unknown';\n                    this.recordUnresolvedBaseline(uri.fsPath, reason);\n                    return;\n                }'''
assert rebuild_block.count(old_rebuild) == 1, f'rebuild ordering target count={rebuild_block.count(old_rebuild)}'
rebuild_block = rebuild_block.replace(old_rebuild, new_rebuild, 1)
s = s[:rebuild_start] + rebuild_block + s[rebuild_end:]
SRC.write_text(s, encoding='utf-8')

# ---------------------------------------------------------------------------
# Regression coverage for both review findings.
# ---------------------------------------------------------------------------
t = TEST.read_text(encoding='utf-8')

# P2 regression: an identical opaque file reported as newly created should be
# reconciled against its fingerprint and stay quiet.
marker_p2 = "test('DT-08 editing an open opaque-baseline document surfaces an unavailable review',async()=>{"
assert t.count(marker_p2) == 1
p2_test = r'''test('DT-08 identical opaque create event stays quiet after delete-create replacement',async()=>{
    const p=file('opaque-identical-create-bom.txt'),bytes=Buffer.from([0xef,0xbb,0xbf,0x61]);
    fs.writeFileSync(p,bytes);listedFiles=[Uri.file(p)];
    assert.equal(await tracker.resetBaselineToCurrentState(),true);assert.ok(tracker.opaqueBaselineFiles.has(p));assert.equal(pending(p),undefined);
    fs.unlinkSync(p);fs.writeFileSync(p,bytes);
    await tracker.onExternalFileCreated(Uri.file(p));
    assert.equal(pending(p),undefined,'identical opaque replacement must not become a false pending review');
    assert.ok(tracker.opaqueBaselineFiles.has(p));
});
'''
t = t.replace(marker_p2, p2_test + marker_p2, 1)

# P1 regression: while a repository rebuild is blocked in the target stat, a
# watcher event marks the opaque path uncertain. The later scan result must not
# overwrite that uncertainty with an accepted opaque baseline.
marker_p1 = "test('DT-07 branch change during rebuild keeps the repository paused',async()=>{"
assert t.count(marker_p1) == 1
p1_test = r'''test('DT-07 repository rebuild preserves scan uncertainty for opaque files',async()=>{
    const repo=path.join(root,'repo-rebuild-opaque-uncertainty');fs.mkdirSync(repo);
    const p=path.join(repo,'opaque.dat');fs.writeFileSync(p,Buffer.from([0xef,0xbb,0xbf,0x61]));
    const base={repoRoot:repo,kind:'repository',headName:'main',headCommit:'aaa',detached:false,inProgress:false};
    const current={...base,headName:'feature',headCommit:'bbb'};tracker.setBaselineGitContexts([base]);tracker.observeGitContext(current);
    tracker.storageUri=Uri.file(path.join(root,`storage-${index++}`));listedFiles=[Uri.file(p)];
    await tracker.startExternalWatchers();
    const gate=pause(p,'stat');const rebuild=tracker.rebuildRepositoryBaseline(repo,current);await gate.entered;
    fs.writeFileSync(p,Buffer.from([0xef,0xbb,0xbf,0x62]));emitWatcher('change',Uri.file(p));
    await waitUntil(()=>tracker.unresolvedBaselineFiles.has(p));gate.release();
    assert.equal(await rebuild,true);await new Promise(resolve=>setTimeout(resolve,180));
    assert.equal(tracker.opaqueBaselineFiles.has(p),false,'scan uncertainty must not be replaced by an opaque baseline');
    assert.ok(tracker.unresolvedBaselineFiles.has(p));assert.ok(pending(p)?.unavailableReason);
});
'''
t = t.replace(marker_p1, p1_test + marker_p1, 1)
TEST.write_text(t, encoding='utf-8')
