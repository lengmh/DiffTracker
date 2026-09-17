from pathlib import Path

SRC = Path('src/diffTracker.ts')
TEST = Path('test/tracker-safety.mjs')
s = SRC.read_text(encoding='utf-8')

def once(old: str, new: str, label: str) -> None:
    global s
    count = s.count(old)
    assert count == 1, f'{label}: expected 1 occurrence, got {count}'
    s = s.replace(old, new, 1)

# A path accepted as an opaque file baseline is still a tracked file. If it later
# becomes a directory, do not route it through the "new untracked directory" path;
# let the normal reader/reconciler surface the type change.
once(
    '        if (this.baselineExistingFiles.has(uri.fsPath)) { return false; }',
    '        if (this.baselineExistingFiles.has(uri.fsPath) || this.opaqueBaselineFiles.has(uri.fsPath)) { return false; }',
    'opaque directory classification',
)

# Stream large files through SHA-256. The 5 MiB threshold remains a text-review
# limit, not a correctness limit for baseline identity; streaming keeps memory bounded.
anchor = '''    private async readFileSnapshot(uri: vscode.Uri): Promise<CurrentFileState> {'''
assert s.count(anchor) == 1
helper = '''    private async fingerprintLocalFile(filePath: string): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const hash = createHash('sha256');
            const stream = fs.createReadStream(filePath);
            stream.on('data', chunk => hash.update(chunk));
            stream.once('error', reject);
            stream.once('end', () => resolve(hash.digest('hex')));
        });
    }

'''
s = s.replace(anchor, helper + anchor, 1)

old = '''            if (stat.size > 5 * 1024 * 1024) {
                return { kind: 'unavailable', reason: 'File exceeds the 5 MiB limit', size: stat.size, mtime: stat.mtime };
            }'''
new = '''            if (stat.size > 5 * 1024 * 1024) {
                const fingerprint = await this.fingerprintLocalFile(uri.fsPath);
                const afterStat = await vscode.workspace.fs.stat(uri);
                if (stat.size !== afterStat.size || stat.mtime !== afterStat.mtime || stat.type !== afterStat.type) {
                    return { kind: 'unavailable', reason: 'File changed while being read; refresh before review' };
                }
                return {
                    kind: 'unavailable',
                    reason: 'File exceeds the 5 MiB limit',
                    size: stat.size,
                    mtime: stat.mtime,
                    fingerprint
                };
            }'''
once(old, new, 'large-file streaming fingerprint')

# Defensive provider-race branch: if a provider returned more than 5 MiB despite
# the initial stat, retain content identity from the bytes already read.
once(
    "                return { kind: 'unavailable', reason: 'File exceeds the 5 MiB limit', size: stat.size, mtime: stat.mtime };",
    "                return { kind: 'unavailable', reason: 'File exceeds the 5 MiB limit', size: stat.size, mtime: stat.mtime, fingerprint: createHash('sha256').update(content).digest('hex') };",
    'post-read large fingerprint',
)

# Never consider a no-fingerprint opaque state unchanged. New baselines always have
# a fingerprint for stable unsupported files; this keeps any legacy/partial state fail-closed.
old = '''        if (baseline.fingerprint !== undefined) {
            return baseline.fingerprint === state.fingerprint;
        }
        return baseline.size === state.size && baseline.mtime === state.mtime;'''
new = '''        return baseline.fingerprint !== undefined && state.fingerprint !== undefined &&
            baseline.size === state.size && baseline.fingerprint === state.fingerprint;'''
once(old, new, 'opaque fingerprint equality')

SRC.write_text(s, encoding='utf-8')

# ---------------------------------------------------------------------------
# Regressions for the latest review findings.
# ---------------------------------------------------------------------------
t = TEST.read_text(encoding='utf-8')
marker = "test('DT-08 editing an open opaque-baseline document surfaces an unavailable review',async()=>{"
assert t.count(marker) == 1
regression = r'''for(const eventKind of ['Changed','Created']) test(`DT-08 opaque file replaced by directory is reported (${eventKind})`,async()=>{
    const p=file(`opaque-to-directory-${eventKind}.dat`);fs.writeFileSync(p,Buffer.from([0xef,0xbb,0xbf,0x61]));listedFiles=[Uri.file(p)];
    assert.equal(await tracker.resetBaselineToCurrentState(),true);assert.ok(tracker.opaqueBaselineFiles.has(p));assert.equal(pending(p),undefined);
    fs.unlinkSync(p);fs.mkdirSync(p);
    await tracker[`onExternalFile${eventKind}`](Uri.file(p));
    await waitUntil(()=>!!pending(p)?.unavailableReason);
    assert.match(pending(p)?.unavailableReason??'',/directory/i);
    fs.rmSync(p,{recursive:true,force:true});
});
test('DT-08 oversized opaque baseline detects same-size same-mtime rewrite',async()=>{
    const p=file('opaque-large-same-mtime.bin');
    const size=5*1024*1024+4096,stamp=new Date(1700000000000);
    fs.writeFileSync(p,Buffer.alloc(size,0x41));fs.utimesSync(p,stamp,stamp);listedFiles=[Uri.file(p)];
    assert.equal(await tracker.resetBaselineToCurrentState(),true);const baseline=tracker.opaqueBaselineFiles.get(p);assert.ok(baseline?.fingerprint);
    fs.writeFileSync(p,Buffer.alloc(size,0x42));fs.utimesSync(p,stamp,stamp);
    const currentStat=fs.statSync(p);assert.equal(currentStat.size,size);assert.equal(currentStat.mtimeMs,stamp.getTime());
    await scan(p);assert.match(pending(p)?.unavailableReason??'',/Unsupported file changed since the baseline/i);
});
test('DT-08 restored oversized opaque baseline detects timestamp-preserving offline rewrite',async()=>{
    const p=file('opaque-large-offline-rewrite.bin'),storage=file('storage');
    const size=5*1024*1024+4096,stamp=new Date(1700000000000);
    fs.writeFileSync(p,Buffer.alloc(size,0x31));fs.utimesSync(p,stamp,stamp);listedFiles=[Uri.file(p)];tracker.storageUri=Uri.file(storage);
    assert.equal(await tracker.resetBaselineToCurrentState(),true);assert.ok(tracker.opaqueBaselineFiles.get(p)?.fingerprint);
    assert.equal(await tracker.flushPendingPersistence(),true);await tracker.dispose();
    fs.writeFileSync(p,Buffer.alloc(size,0x32));fs.utimesSync(p,stamp,stamp);tracker=new DiffTracker(Uri.file(storage));
    assert.equal(await tracker.restorePersistedState(),'restored');assert.match(pending(p)?.unavailableReason??'',/Unsupported file changed since the baseline/i);
});
'''
t = t.replace(marker, regression + marker, 1)
TEST.write_text(t, encoding='utf-8')
