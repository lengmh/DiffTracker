from pathlib import Path

source = Path('src/diffTracker.ts')
s = source.read_text(encoding='utf-8')
old = '''        if (!this.fileSnapshots.has(filePath)) {
            this.ensureSnapshotForDocument(doc);
            if (!this.fileSnapshots.has(filePath)) { return; }
        }'''
new = '''        if (!this.fileSnapshots.has(filePath)) {
            if (this.opaqueBaselineFiles.has(filePath)) {
                // Opening an opaque-baseline document is quiet, but an actual editor
                // mutation must be visible even though the original bytes cannot be
                // decoded into a normal text diff.
                this.markFileUnavailable(filePath, 'Document changed from an unsupported baseline; original content is unavailable');
                return;
            }
            this.ensureSnapshotForDocument(doc);
            if (!this.fileSnapshots.has(filePath)) { return; }
        }'''
assert s.count(old) == 1, f'onDocumentChanged target count={s.count(old)}'
source.write_text(s.replace(old, new, 1), encoding='utf-8')

test = Path('test/tracker-safety.mjs')
t = test.read_text(encoding='utf-8')
marker = "test('DT-08 deleting an accepted opaque baseline surfaces an unavailable review',async()=>{"
assert t.count(marker) == 1
regression = '''test('DT-08 editing an open opaque-baseline document surfaces an unavailable review',async()=>{
    const p=file('opaque-document-edit-bom.txt');fs.writeFileSync(p,Buffer.from([0xef,0xbb,0xbf,0x61]));listedFiles=[Uri.file(p)];
    assert.equal(await tracker.resetBaselineToCurrentState(),true);assert.ok(tracker.opaqueBaselineFiles.has(p));assert.equal(pending(p),undefined);
    const doc=document(p);tracker.onDocumentOpened(doc);assert.equal(pending(p),undefined,'opening alone must stay quiet');
    doc.text='edited in memory';doc.isDirty=true;doc.version++;tracker.onDocumentChanged({document:doc});
    assert.match(pending(p)?.unavailableReason??'',/Document changed from an unsupported baseline/i);
    assert.ok(tracker.opaqueBaselineFiles.has(p),'document edits must not erase the opaque before-image identity');
});
'''
test.write_text(t.replace(marker, regression + marker, 1), encoding='utf-8')
