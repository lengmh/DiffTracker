/** Production regression tests. Only the VS Code API boundary is faked.
 * No diff, existence, acceptance or recovery algorithm is copied into this test.
 * DT_SOURCE may point at an archived baseline source for red/green comparison.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'difftracker-safety-'));
const faults = new Map();
const barriers = new Map();
function deferred() { let resolve; const promise=new Promise(r=>{resolve=r;}); return {promise,resolve}; }
function pause(p,operation) { const entered=deferred(),release=deferred(); barriers.set(`${p}:${operation}`,{entered,release}); return {entered:entered.promise,release:release.resolve}; }
async function boundary(p,operation) { const key=`${p}:${operation}`, barrier=barriers.get(key); if(barrier){barriers.delete(key); barrier.entered.resolve(); await barrier.release.promise;} }
let automationOnly=false;
let listedFiles=[];
let workspaceChanged;
const docs = [];
const watcherInstances = [];
const counters = { apply: 0, save: 0, write: 0 };
const noopEvent = () => ({ dispose() {} });
function createWatcher() {
    const handlers = { change: [], create: [], delete: [] };
    const watcher = {
        active: true,
        onDidChange(handler) { handlers.change.push(handler); return { dispose() {} }; },
        onDidCreate(handler) { handlers.create.push(handler); return { dispose() {} }; },
        onDidDelete(handler) { handlers.delete.push(handler); return { dispose() {} }; },
        emit(kind, uri) { if(this.active) for(const handler of handlers[kind]) handler(uri); },
        dispose() { this.active=false; }
    };
    watcherInstances.push(watcher);
    return watcher;
}
function emitWatcher(kind, uri) { for(const watcher of watcherInstances) watcher.emit(kind,uri); }
async function waitUntil(predicate, timeoutMs=1000) {
    const deadline=Date.now()+timeoutMs;
    while(!predicate()) { if(Date.now()>=deadline) throw new Error('Timed out waiting for test condition'); await new Promise(resolve=>setTimeout(resolve,5)); }
}
class Emitter { event = noopEvent; fire() {} dispose() {} }
class Uri {
    constructor(p) { this.fsPath = p; this.path = p; this.scheme = 'file'; }
    static file(p) { return new Uri(p); }
    static joinPath(uri, ...parts) { return new Uri(path.join(uri.fsPath, ...parts)); }
    toString() { return `file://${this.fsPath}`; }
}
class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range {
    constructor(a,b,c,d) {
        this.start = typeof a === 'number' ? new Position(a,b) : a;
        this.end = typeof a === 'number' ? new Position(c,d) : b;
    }
}
class WorkspaceEdit {
    ops = [];
    replace(uri, range, text) { this.ops.push({ type:'replace', uri, range, text }); }
    createFile(uri, options) {
        if (options && Object.prototype.hasOwnProperty.call(options,'contents')) {
            throw new Error('VS Code 1.80 WorkspaceEdit.createFile does not support contents');
        }
        this.ops.push({ type:'create', uri, options });
    }
    deleteFile(uri, options) { this.ops.push({ type:'delete', uri, options }); }
    insert(uri, position, text) { this.ops.push({ type:'replace', uri, text }); }
}
const error = (code) => Object.assign(new Error(code), { code });
function fault(p, operation) {
    const value = faults.get(p)?.[operation];
    if (value instanceof Error) throw value;
    return value;
}
function document(p) {
    let doc = docs.find(d => d.uri.fsPath === p);
    if (doc) return doc;
    fault(p, 'open');
    const text = fs.readFileSync(p, 'utf8');
    doc = {
        uri: Uri.file(p), text, isDirty: false, version: 1,
        getText() { return this.text; },
        get lineCount() { return this.text.split('\n').length; },
        lineAt(i) {
            const lines = this.text.split('\n');
            const end = i + 1 < lines.length ? new Position(i+1,0) : new Position(i,lines[i].length);
            return { text: lines[i], range: new Range(i,0,i,lines[i].length), rangeIncludingLineBreak:new Range(new Position(i,0),end) };
        },
        async save() {
            counters.save++;
            await boundary(p,'save');
            if (fault(p,'save') === false) return false;
            fs.writeFileSync(p,this.text); this.isDirty = false; return true;
        }
    };
    docs.push(doc); return doc;
}
const vscode = {
    EventEmitter: Emitter, Uri, Range, Position, WorkspaceEdit,
    RelativePattern:class {
        constructor(base,pattern){
            if (base instanceof Uri) throw new Error('VS Code 1.80 RelativePattern does not accept Uri');
            Object.assign(this,{base,pattern});
        }
    },
    FileType: { File:1, Directory:2, SymbolicLink:64 },
    FileSystemError: { FileNotFound:()=>error('FileNotFound'), NoPermissions:()=>error('NoPermissions') },
    window: { showWarningMessage:async()=>undefined, showErrorMessage:async()=>undefined },
    workspace: {
        textDocuments: docs,
        workspaceFolders:[{ uri:Uri.file(root), name:'test' }],
        getWorkspaceFolder:uri => uri.fsPath.startsWith(root) ? { uri:Uri.file(root), name:'test' } : undefined,
        getConfiguration:()=>({ get:(key, fallback)=>key==='onlyTrackAutomatedChanges'?automationOnly:fallback }),
        onDidChangeTextDocument:noopEvent, onDidOpenTextDocument:noopEvent,
        onWillSaveTextDocument:noopEvent, onDidSaveTextDocument:noopEvent,
        onDidChangeConfiguration:noopEvent,
        onDidChangeWorkspaceFolders:handler=>{workspaceChanged=handler;return {dispose(){}};},
        findFiles:async pattern=>{if(pattern.pattern!=='**/*') await boundary(root,'ignoreScan');return pattern.pattern==='**/*'?listedFiles:[];},
        createFileSystemWatcher:createWatcher,
        async openTextDocument(uri) { await boundary(uri.fsPath,'open'); return document(uri.fsPath); },
        async applyEdit(edit) {
            counters.apply++;
            // Keep the compatibility seam conservative: resource creation and
            // document text edits must also work on hosts/providers that reject a
            // mixed WorkspaceEdit even though each operation is supported alone.
            if (edit.ops.some(op=>op.type==='create') && edit.ops.some(op=>op.type==='replace')) return false;
            for (const op of edit.ops) {
                await boundary(op.uri.fsPath,'apply');
                if (fault(op.uri.fsPath,'apply') === false) return false;
            }
            for (const op of edit.ops) {
                const p=op.uri.fsPath;
                if (op.type==='delete') fs.rmSync(p,{force:!!op.options?.ignoreIfNotExists});
                else if (op.type==='create') { fs.mkdirSync(path.dirname(p),{recursive:true}); fs.writeFileSync(p,op.options?.contents??''); }
                else { const doc=document(p); doc.text=op.text; doc.isDirty=true; doc.version++; }
            }
            for(const op of edit.ops) if(fault(op.uri.fsPath,'afterApply')===false) return false;
            return true;
        },
        fs: {
            async stat(uri) { fault(uri.fsPath,'stat'); const stat=fs.statSync(uri.fsPath); return {type:stat.isDirectory()?2:1,size:fault(uri.fsPath,'size')??stat.size,mtime:stat.mtimeMs}; },
            async readFile(uri) { fault(uri.fsPath,'read'); const bytes=new Uint8Array(fs.readFileSync(uri.fsPath)); await boundary(uri.fsPath,'read'); return bytes; },
            async writeFile(uri, bytes) { counters.write++; fault(uri.fsPath,'write'); fs.writeFileSync(uri.fsPath,bytes); },
            async createDirectory(uri) { fs.mkdirSync(uri.fsPath,{recursive:true}); },
            async delete(uri) { fault(uri.fsPath,'delete'); fs.rmSync(uri.fsPath); },
            async rename(source, target, options) {
                fault(source.fsPath,'rename');
                if (options?.overwrite) fs.rmSync(target.fsPath,{force:true});
                fs.renameSync(source.fsPath,target.fsPath);
            },
            async copy(source, target, options) {
                fault(source.fsPath,'copy');
                if (!options?.overwrite && fs.existsSync(target.fsPath)) throw error('FileExists');
                fs.copyFileSync(source.fsPath,target.fsPath);
            }
        }
    }
};
const originalLoad = Module._load;
Module._load = function(id,...args) { return id==='vscode' ? vscode : originalLoad.call(this,id,...args); };
let DiffTracker;
try {
    if (process.env.DT_SOURCE) {
        const ts=require('typescript');
        const source=fs.readFileSync(process.env.DT_SOURCE,'utf8');
        const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText;
        const mod=new Module(path.resolve('out/baseline-diffTracker.js'));
        mod.paths=Module._nodeModulePaths(path.resolve('out'));
        mod._compile(code,mod.id); DiffTracker=mod.exports.DiffTracker;
    } else ({DiffTracker}=require('../out/diffTracker.js'));
} finally { Module._load=originalLoad; }
const tests=[];
function test(name,run) { tests.push({name,run}); }
const succeeded = r => r===true || r?.status==='success';
let tracker;
let index=0;
function file(name='sample.m') { return path.join(root,`${index++}-${name}`); }
function seed(p,baseline,current=baseline,exists=true) {
    tracker.fileSnapshots.set(p,baseline);
    if(exists) tracker.baselineExistingFiles.add(p);
    fs.writeFileSync(p,current);
}
async function scan(p) { await tracker.readFileAndUpdate(p,Uri.file(p)); }
function pending(p) { return tracker.getTrackedChanges().find(c=>c.filePath===p); }
function disk(p) { return fs.readFileSync(p,'utf8'); }

test('DT-02 nonempty → empty Keep → write → Revert preserves existing empty file',async()=>{
    const p=file(); seed(p,'old\n',''); await scan(p);
    assert.equal(pending(p)?.isDeleted,false);
    assert.ok(succeeded(await tracker.keepAllChangesInFile(p)));
    assert.ok(tracker.baselineExistingFiles.has(p));
    fs.writeFileSync(p,'next\n'); await scan(p);
    assert.ok(succeeded(await tracker.revertFile(p))); assert.equal(disk(p),''); assert.equal(pending(p),undefined);
});
test('DT-02 empty new file has file-level pending and Revert deletes it',async()=>{
    const p=file(); fs.writeFileSync(p,''); await tracker.onExternalFileCreated(Uri.file(p));
    assert.ok(pending(p)); assert.equal(pending(p).isDeleted,false);
    assert.ok(succeeded(await tracker.revertFile(p))); assert.equal(fs.existsSync(p),false);
});
test('DT-02 deleting baseline empty file has pending and Revert recreates it',async()=>{
    const p=file(); seed(p,''); fs.unlinkSync(p); await tracker.onExternalFileDeleted(Uri.file(p));
    assert.equal(pending(p)?.isDeleted,true); assert.ok(succeeded(await tracker.revertFile(p))); assert.equal(disk(p),'');
});
test('DT-02 unaccepted nonempty new file Revert uses existing deletion path',async()=>{
    const p=file(); fs.writeFileSync(p,'new\n'); await tracker.onExternalFileCreated(Uri.file(p));
    assert.ok(succeeded(await tracker.revertFile(p))); assert.equal(fs.existsSync(p),false);
});
test('DT-02 hunk Keep on a new file establishes existence for later Revert',async()=>{
    const p=file(); fs.writeFileSync(p,'accepted\n'); await tracker.onExternalFileCreated(Uri.file(p));
    const block=tracker.getChangeBlocks(p)[0]; assert.ok(block);
    assert.ok(succeeded(await tracker.keepBlock(p,block.blockId))); assert.ok(tracker.baselineExistingFiles.has(p));
    fs.writeFileSync(p,'accepted\nremaining\n'); await scan(p);
    assert.ok(succeeded(await tracker.revertFile(p))); assert.equal(disk(p),'accepted\n');
});
test('DT-02 accepted deletion followed by recreation Revert deletes recreation',async()=>{
    const p=file(); seed(p,'old\n'); fs.unlinkSync(p); await tracker.onExternalFileDeleted(Uri.file(p));
    assert.ok(succeeded(await tracker.keepAllChangesInFile(p))); assert.equal(tracker.baselineExistingFiles.has(p),false);
    fs.writeFileSync(p,'reborn\n'); await tracker.onExternalFileCreated(Uri.file(p));
    assert.ok(succeeded(await tracker.revertFile(p))); assert.equal(fs.existsSync(p),false);
});
test('DT-02 clean cached document cannot hide disk deletion',async()=>{
    const p=file(); seed(p,'old\n'); document(p); fs.unlinkSync(p);
    assert.equal((await tracker.readCurrentFileState(p)).kind,'missing');
});
for(const [label,inject] of [
    ['permission',p=>faults.set(p,{read:error('NoPermissions')})],
    ['binary',p=>fs.writeFileSync(p,Buffer.from([65,0,66]))],
    ['invalid UTF-8',p=>fs.writeFileSync(p,Buffer.from([0xc3,0x28]))],
    ['size limit',p=>faults.set(p,{size:6*1024*1024})]
]) test(`DT-03 ${label} retains baseline and pending with reason on change/create`,async()=>{
    const p=file(); seed(p,'baseline\n','pending\n'); await scan(p); inject(p);
    assert.equal((await tracker.readCurrentFileState(p)).kind,'unavailable');
    await scan(p); assert.equal(tracker.getOriginalContent(p),'baseline\n'); assert.ok(pending(p)); assert.ok(pending(p).unavailableReason);
    await tracker.onExternalFileCreated(Uri.file(p)); assert.equal(tracker.getOriginalContent(p),'baseline\n'); assert.ok(tracker.baselineExistingFiles.has(p)); assert.ok(pending(p));
    assert.equal(succeeded(await tracker.keepAllChangesInFile(p)),false); assert.equal(succeeded(await tracker.revertFile(p)),false); assert.ok(pending(p));
});
for(const save of [false,error('NoPermissions')]) test(`DT-03 save ${save===false?'false':'throws'} keeps pending and baseline; no write fallback`,async()=>{
    const p=file(); seed(p,'baseline\n','changed\n'); await scan(p); faults.set(p,{save});
    const before=counters.write; const result=await tracker.revertFile(p);
    assert.equal(succeeded(result),false); assert.equal(result.bufferChanged,true);
    assert.equal(disk(p),'changed\n'); assert.equal(document(p).getText(),'baseline\n'); assert.equal(document(p).isDirty,true);
    assert.equal(counters.write,before); assert.equal(tracker.getOriginalContent(p),'baseline\n'); assert.ok(pending(p));
    assert.equal(tracker.revertHistory.length,1,'a partial buffer mutation must retain its durable recovery record');
    tracker.processDocumentChange(document(p)); await scan(p); assert.ok(pending(p), 'save failure pending survives buffer and watcher refresh');
});
test('DT-09 save failure retains its recovery record in durable session state',async()=>{
    const p=file(); seed(p,'baseline','changed'); await scan(p); faults.set(p,{save:false});
    const storage=path.join(root,`storage-${index++}`); tracker.storageUri=Uri.file(storage);
    const result=await tracker.revertFile(p); assert.equal(result.bufferChanged,true);
    const saved=JSON.parse(fs.readFileSync(path.join(storage,'session-state.json'),'utf8'));
    assert.equal(saved.revertHistory.length,1); assert.equal(saved.revertHistory[0].items[0].before.content,'changed');
});
test('DT-03 applyEdit false never saves and keeps pending',async()=>{
    const p=file(); seed(p,'baseline','changed'); await scan(p); faults.set(p,{apply:false}); const before=counters.save;
    assert.equal(succeeded(await tracker.revertFile(p)),false); assert.equal(counters.save,before); assert.equal(disk(p),'changed'); assert.ok(pending(p));
});
test('DT-03 arbitrary open failure cannot rebuild/overwrite existing file',async()=>{
    const p=file(); seed(p,'baseline','changed'); await scan(p); faults.set(p,{open:error('NoPermissions')}); const before=counters.write;
    assert.equal(succeeded(await tracker.revertFile(p)),false); assert.equal(disk(p),'changed'); assert.equal(counters.write,before); assert.ok(pending(p));
});
test('DT-03 dirty document is skipped without apply/save or acceptance',async()=>{
    const p=file(); seed(p,'baseline','changed'); await scan(p); const doc=document(p); doc.text='unsaved manual'; doc.isDirty=true;
    const before={...counters}; assert.equal(succeeded(await tracker.revertFile(p)),false); assert.equal(succeeded(await tracker.keepAllChangesInFile(p)),false);
    assert.deepEqual(counters,before); assert.equal(doc.text,'unsaved manual'); assert.equal(disk(p),'changed');
    assert.equal(pending(p)?.currentContent,'unsaved manual','rejected actions must retain the dirty buffer as the pending review');
});
test('DT-03 three-file batch removes only successes, save-false remains pending',async()=>{
    const files=[file('first.m'),file('second.m'),file('third.m')];
    for(const p of files){seed(p,'baseline','changed'); await scan(p);}
    faults.set(files[1],{save:false}); const result=await tracker.revertAllChanges();
    assert.equal(result.succeeded??result,2); assert.equal(pending(files[0]),undefined); assert.ok(pending(files[1])); assert.equal(pending(files[2]),undefined);
    assert.equal(disk(files[0]),'baseline'); assert.equal(disk(files[1]),'changed'); assert.equal(disk(files[2]),'baseline');
});
test('DT-03 three-file batch success/failure/dirty conflict reports true counts',async()=>{
    const files=[file(),file(),file()]; for(const p of files){seed(p,'base','changed'); await scan(p);}
    faults.set(files[1],{apply:false}); document(files[2]).isDirty=true;
    const result=await tracker.revertAllChanges(); assert.equal(result.succeeded??result,1);
    assert.equal(pending(files[0]),undefined); assert.ok(pending(files[1])); assert.ok(pending(files[2]));
});
test('DT-02 deleted nonempty file is recreated with exact baseline content',async()=>{
    const p=file(); seed(p,'恢复内容\r\nnext'); fs.unlinkSync(p); await tracker.onExternalFileDeleted(Uri.file(p));
    assert.ok(succeeded(await tracker.revertFile(p))); assert.equal(disk(p),'恢复内容\r\nnext');
});
test('DT-02 Keep empty creation establishes an existing empty baseline',async()=>{
    const p=file(); fs.writeFileSync(p,''); await tracker.onExternalFileCreated(Uri.file(p));
    assert.ok(succeeded(await tracker.keepAllChangesInFile(p))); assert.ok(tracker.baselineExistingFiles.has(p));
    fs.unlinkSync(p); await tracker.onExternalFileDeleted(Uri.file(p)); assert.equal(pending(p)?.isDeleted,true);
    assert.ok(succeeded(await tracker.revertFile(p))); assert.equal(disk(p),'');
});
test('DT-03 stat permission failure is unavailable, not missing',async()=>{
    const p=file(); seed(p,'old','pending'); await scan(p); faults.set(p,{stat:error('NoPermissions')});
    assert.equal((await tracker.readCurrentFileState(p)).kind,'unavailable'); await scan(p);
    assert.ok(pending(p)); assert.equal(tracker.getOriginalContent(p),'old');
});
test('DT-03 Keep All accepts readable clean files only',async()=>{
    const files=[file(),file(),file()]; for(const p of files){ seed(p,'old','pending'); await scan(p); }
    faults.set(files[1],{read:error('NoPermissions')}); document(files[2]).isDirty=true;
    const result=await tracker.keepAllChanges(); assert.equal(result.succeeded??result,1);
    assert.equal(tracker.getOriginalContent(files[0]),'pending'); assert.equal(pending(files[0]),undefined);
    for(const p of files.slice(1)){ assert.equal(tracker.getOriginalContent(p),'old'); assert.ok(pending(p)); }
});
test('existing V1 persistence preserves absent versus empty baseline and paused session',async()=>{
    const empty=file(); const absent=file(); seed(empty,''); seed(absent,'','new',false);
    const storage=path.join(root,`storage-${index++}`); tracker.storageUri=Uri.file(storage); tracker.isRecording=false;
    await tracker.flushPersistState();
    const saved=JSON.parse(fs.readFileSync(path.join(storage,'session-state.json'),'utf8'));
    assert.equal(saved.version,2); assert.equal(saved.isRecording,false); assert.equal(saved.baselineState,'ready');
    const loaded=await tracker.loadPersistedState(); assert.equal(loaded.isRecording,false);
    assert.ok(loaded.baselineExistingFiles.includes(empty)); assert.equal(loaded.baselineExistingFiles.includes(absent),false);
    assert.ok(loaded.fileSnapshots.some(([p,t])=>p===absent&&t===''));
});
test('DT-06 atomic persistence keeps a last-good state and recovers a corrupted primary',async()=>{
    const p=file(); seed(p,'baseline','pending'); await scan(p);
    const storage=path.join(root,`storage-${index++}`); tracker.storageUri=Uri.file(storage);
    assert.equal(await tracker.flushPersistState(),true);
    const primary=path.join(storage,'session-state.json');
    const backup=path.join(storage,'session-state.last-good.json');
    assert.equal(fs.existsSync(backup),true);
    const valid=JSON.parse(fs.readFileSync(backup,'utf8')); assert.equal(valid.version,2);
    fs.writeFileSync(primary,'{"version":2,');

    tracker=new DiffTracker(Uri.file(storage));
    assert.equal(await tracker.restorePersistedState(),'recovered');
    assert.equal(tracker.getOriginalContent(p),'baseline'); assert.equal(pending(p)?.currentContent,'pending');
    assert.match(tracker.getPersistenceIssue()??'',/last-good/i);
});
test('DT-06 corrupt primary and backup block automatic replacement',async()=>{
    const storage=path.join(root,`storage-${index++}`); fs.mkdirSync(storage);
    const primary=path.join(storage,'session-state.json');
    const backup=path.join(storage,'session-state.last-good.json');
    fs.writeFileSync(primary,'corrupt primary'); fs.writeFileSync(backup,'corrupt backup');
    tracker.storageUri=Uri.file(storage);
    assert.equal(await tracker.restorePersistedState(),'blocked');
    assert.equal(tracker.isRecoveryBlocked(),true);
    tracker.startRecording();
    assert.equal(tracker.getIsRecording(),false);
    assert.equal(fs.readFileSync(primary,'utf8'),'corrupt primary');
});
test('DT-06 invalid V1 entries reject the whole state instead of opening a partial review',async()=>{
    const p=file(), outside=path.join(os.tmpdir(),`outside-${index++}.m`);
    const storage=path.join(root,`storage-${index++}`); fs.mkdirSync(storage);
    fs.writeFileSync(path.join(storage,'session-state.json'),JSON.stringify({
        version:1,isRecording:false,fileSnapshots:[[p,'valid'],[outside,42]],baselineExistingFiles:[p,outside]
    }));
    tracker.storageUri=Uri.file(storage);
    assert.equal(await tracker.restorePersistedState(),'blocked');
    assert.equal(tracker.getOriginalContent(p),undefined);
});
test('DT-06 partial-scan V2 restores paused and cannot perform review writes',async()=>{
    const p=file(); fs.writeFileSync(p,'current');
    const storage=path.join(root,`storage-${index++}`); fs.mkdirSync(storage);
    fs.writeFileSync(path.join(storage,'session-state.json'),JSON.stringify({
        version:2,isRecording:true,baselineState:'building',workspaceRoots:[root],
        fileSnapshots:[[p,'baseline']],baselineExistingFiles:[p],revertHistory:[]
    }));
    tracker.storageUri=Uri.file(storage);
    assert.equal(await tracker.restorePersistedState(),'incomplete');
    assert.equal(tracker.getIsRecording(),false); assert.equal(tracker.getBaselineState(),'building');
    assert.equal(succeeded(await tracker.revertFile(p)),false); assert.equal(disk(p),'current');
});
test('DT-06 failed atomic state write reports failure and preserves the previous valid primary',async()=>{
    const p=file(); seed(p,'first');
    const storage=path.join(root,`storage-${index++}`); tracker.storageUri=Uri.file(storage);
    assert.equal(await tracker.flushPersistState(),true);
    const primary=path.join(storage,'session-state.json'); const before=fs.readFileSync(primary,'utf8');
    tracker.fileSnapshots.set(p,'second');
    faults.set(path.join(storage,'session-state.tmp.json'),{write:error('NoPermissions')});
    assert.equal(await tracker.flushPersistState(),false);
    assert.equal(fs.readFileSync(primary,'utf8'),before); assert.match(tracker.getPersistenceIssue()??'',/persist/i);
    faults.delete(path.join(storage,'session-state.tmp.json'));
});
test('DT-06 awaited dispose flushes a queued state mutation',async()=>{
    const p=file(); seed(p,'baseline');
    const storage=path.join(root,`storage-${index++}`); tracker.storageUri=Uri.file(storage);
    tracker.schedulePersistState(); await tracker.dispose();
    const saved=JSON.parse(fs.readFileSync(path.join(storage,'session-state.json'),'utf8'));
    assert.ok(saved.fileSnapshots.some(([savedPath,text])=>savedPath===p&&text==='baseline'));
});
test('DT-09 Undo Last Revert restores reviewed file without changing its baseline',async()=>{
    const p=file(); seed(p,'baseline','changed'); await scan(p);
    assert.ok(succeeded(await tracker.revertFile(p))); assert.equal(disk(p),'baseline');
    const undo=await tracker.undoLastRevert(); assert.equal(undo.succeeded,1);
    assert.equal(disk(p),'changed'); assert.equal(tracker.getOriginalContent(p),'baseline');
    assert.equal(pending(p)?.currentContent,'changed');
});
test('DT-09 Undo Last Revert restores all successful members of a partial batch',async()=>{
    const p=file(),q=file(); for(const f of [p,q]){seed(f,'base','changed');await scan(f);}
    faults.set(q,{save:false}); const reverted=await tracker.revertAllChanges(); assert.equal(reverted.succeeded,1);
    const undo=await tracker.undoLastRevert(); assert.equal(undo.succeeded,1);
    assert.equal(disk(p),'changed'); assert.equal(disk(q),'changed'); assert.ok(pending(p)); assert.ok(pending(q));
});
test('DT-09 Revert All larger than the history limit remains one fully recoverable action',async()=>{
    const files=Array.from({length:12},()=>file('batch.m'));
    for(const p of files){seed(p,'base','changed');await scan(p);}
    const reverted=await tracker.revertAllChanges(); assert.equal(reverted.succeeded,files.length);
    assert.equal(tracker.revertHistory.length,1); assert.equal(tracker.revertHistory[0].items.length,files.length);
    const undo=await tracker.undoLastRevert(); assert.equal(undo.succeeded,files.length);
    for(const p of files){assert.equal(disk(p),'changed');assert.equal(pending(p)?.currentContent,'changed');}
});
test('DT-09 large Revert All is durably one complete action before its final mutation',async()=>{
    const files=Array.from({length:12},()=>file('durable-batch.m'));
    for(const p of files){seed(p,'base','changed');await scan(p);}
    const storage=path.join(root,`storage-${index++}`); tracker.storageUri=Uri.file(storage);
    const hold=pause(files.at(-1),'open'); const batchPromise=tracker.revertAllChanges();
    await hold.entered;
    try {
        const saved=JSON.parse(fs.readFileSync(path.join(storage,'session-state.json'),'utf8'));
        assert.equal(saved.revertHistory.length,1);
        assert.equal(saved.revertHistory[0].items.length,files.length);
        assert.equal(tracker.parsePersistedState(saved)?.revertHistory[0].items.length,files.length);
    } finally { hold.release(); }
    assert.equal((await batchPromise).succeeded,files.length);
});
test('DT-09 native Undo invalidates the recovery record without applying a second inverse edit',async()=>{
    const p=file(); seed(p,'baseline','changed'); await scan(p); assert.ok(succeeded(await tracker.revertFile(p)));
    const doc=document(p); doc.text='changed'; doc.isDirty=true; doc.version++; tracker.processDocumentChange(doc);
    const before={...counters}; const undo=await tracker.undoLastRevert();
    assert.equal(undo.succeeded,1); assert.deepEqual(counters,before); assert.equal(doc.getText(),'changed');
});
test('DT-09 concurrent Undo Last Revert consumes one recovery record only once',async()=>{
    const p=file();seed(p,'baseline','changed');await scan(p);assert.ok(succeeded(await tracker.revertFile(p)));
    const hold=pause(p,'apply');const first=tracker.undoLastRevert();await hold.entered;
    const second=tracker.undoLastRevert();await new Promise(resolve=>setImmediate(resolve));hold.release();
    const results=await Promise.all([first,second]);
    assert.equal(results.reduce((total,result)=>total+result.succeeded,0),1);
    assert.equal(disk(p),'changed');assert.equal(tracker.revertHistory.length,0);
});
test('DT-08 queued Undo calls cannot mutate after the recording session stops',async()=>{
    const p=file();seed(p,'baseline','changed');await scan(p);assert.ok(succeeded(await tracker.revertFile(p)));
    const hold=pause(p,'read');const first=tracker.undoLastRevert();await hold.entered;
    const second=tracker.undoLastRevert();tracker.stopRecording();hold.release();
    const results=await Promise.all([first,second]);
    assert.equal(results.reduce((total,result)=>total+result.succeeded,0),0);
    assert.equal(disk(p),'baseline');assert.equal(tracker.revertHistory.length,1);
});
test('DT-06 valid V1 state migrates in memory and the next durable write is strict V2',async()=>{
    const p=file(); fs.writeFileSync(p,'changed');
    const storage=path.join(root,`storage-${index++}`); fs.mkdirSync(storage);
    fs.writeFileSync(path.join(storage,'session-state.json'),JSON.stringify({
        version:1,isRecording:false,fileSnapshots:[[p,'baseline']],baselineExistingFiles:[p]
    }));
    tracker.storageUri=Uri.file(storage); assert.equal(await tracker.restorePersistedState(),'restored');
    assert.equal(tracker.getOriginalContent(p),'baseline'); assert.ok(pending(p));
    assert.equal(await tracker.flushPendingPersistence(),true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(storage,'session-state.json'),'utf8')).version,2);
});
test('DT-06 explicit discard is required before a blocked session can start',async()=>{
    const storage=path.join(root,`storage-${index++}`); fs.mkdirSync(storage);
    const primary=path.join(storage,'session-state.json'); fs.writeFileSync(primary,'corrupt');
    tracker.storageUri=Uri.file(storage); assert.equal(await tracker.restorePersistedState(),'blocked');
    tracker.startRecording(); assert.equal(tracker.getIsRecording(),false); assert.equal(fs.existsSync(primary),true);
    assert.equal(await tracker.discardRecoveryState(),true); tracker.startRecording();
    assert.equal(tracker.getIsRecording(),true); assert.equal(tracker.isRecoveryBlocked(),false);
});
test('DT-09 recovery record persistence failure blocks file Revert before mutation',async()=>{
    const p=file(); seed(p,'baseline','changed'); await scan(p);
    const storage=path.join(root,`storage-${index++}`); tracker.storageUri=Uri.file(storage);
    assert.equal(await tracker.flushPendingPersistence(),true);
    const temp=path.join(storage,'session-state.tmp.json'); faults.set(temp,{write:error('NoPermissions')});
    const before={...counters}; const result=await tracker.revertFile(p);
    assert.equal(succeeded(result),false); assert.match(result.reason,/recovery record/i);
    assert.equal(disk(p),'changed'); assert.equal(document(p).getText(),'changed');
    assert.equal(counters.apply,before.apply); assert.equal(counters.save,before.save); assert.equal(counters.write,before.write+1);
    faults.delete(temp);
});
test('DT-09 Undo Last Revert recreates an unaccepted new file',async()=>{
    const p=file(); fs.writeFileSync(p,'new content'); await tracker.onExternalFileCreated(Uri.file(p));
    assert.ok(succeeded(await tracker.revertFile(p))); assert.equal(fs.existsSync(p),false);
    const undo=await tracker.undoLastRevert(); assert.equal(undo.succeeded,1); assert.equal(disk(p),'new content'); assert.ok(pending(p));
});
test('DT-09 failed recovery content write retains the record after creating the resource',async()=>{
    const p=file(); fs.writeFileSync(p,'new content'); await tracker.onExternalFileCreated(Uri.file(p));
    assert.ok(succeeded(await tracker.revertFile(p))); assert.equal(fs.existsSync(p),false);
    faults.set(p,{write:error('NoPermissions')});
    const undo=await tracker.undoLastRevert();
    assert.equal(undo.succeeded,0); assert.equal(undo.failed,1); assert.equal(undo.results[0].bufferChanged,true);
    assert.equal(fs.existsSync(p),true); assert.equal(disk(p),'');
    assert.equal(tracker.revertHistory.length,1,'partial recovery remains retryable');
});
test('DT-09 Undo Last Revert restores a reviewed deletion after Revert recreated the file',async()=>{
    const p=file(); seed(p,'baseline'); fs.unlinkSync(p); await tracker.onExternalFileDeleted(Uri.file(p));
    assert.ok(succeeded(await tracker.revertFile(p))); assert.equal(disk(p),'baseline');
    const undo=await tracker.undoLastRevert(); assert.equal(undo.succeeded,1); assert.equal(fs.existsSync(p),false); assert.equal(pending(p)?.isDeleted,true);
});
test('DT-09 block recovery restores only the dirty buffer and never saves it',async()=>{
    const p=file(); seed(p,'base\n','changed\n'); await scan(p); const block=tracker.getChangeBlocks(p)[0];
    assert.ok(succeeded(await tracker.revertBlock(p,block.blockId))); const doc=document(p);
    assert.equal(doc.getText(),'base\n'); assert.equal(doc.isDirty,true); assert.equal(disk(p),'changed\n');
    const beforeSave=counters.save; const undo=await tracker.undoLastRevert();
    assert.equal(undo.succeeded,1); assert.equal(doc.getText(),'changed\n'); assert.equal(doc.isDirty,true);
    assert.equal(disk(p),'changed\n'); assert.equal(counters.save,beforeSave);
});
test('DT-09 persisted recovery history survives reload and restores the reviewed file',async()=>{
    const p=file(); seed(p,'baseline','changed'); await scan(p);
    const storage=path.join(root,`storage-${index++}`); tracker.storageUri=Uri.file(storage);
    assert.ok(succeeded(await tracker.revertFile(p))); await tracker.flushPendingPersistence();
    tracker=new DiffTracker(Uri.file(storage)); assert.equal(await tracker.restorePersistedState(),'restored');
    const undo=await tracker.undoLastRevert(); assert.equal(undo.succeeded,1); assert.equal(disk(p),'changed'); assert.ok(pending(p));
});
test('DT-09 a later file change conflicts instead of being overwritten by recovery',async()=>{
    const p=file(); seed(p,'baseline','changed'); await scan(p); assert.ok(succeeded(await tracker.revertFile(p)));
    fs.writeFileSync(p,'newer work'); await scan(p); const before={...counters};
    const undo=await tracker.undoLastRevert(); assert.equal(undo.succeeded,0); assert.equal(undo.failed,1);
    assert.equal(disk(p),'newer work'); assert.deepEqual(counters,before);
});
test('DT-07 ordinary commit on the same branch does not pause review actions',async()=>{
    const repo=path.join(root,'repo-same'); fs.mkdirSync(repo); const p=path.join(repo,'sample.m'); seed(p,'base','changed'); await scan(p);
    tracker.setBaselineGitContexts([{repoRoot:repo,kind:'repository',headName:'main',headCommit:'aaa',detached:false,inProgress:false}]);
    tracker.observeGitContext({repoRoot:repo,kind:'repository',headName:'main',headCommit:'bbb',detached:false,inProgress:false});
    assert.equal(tracker.getGitPauseReason(p),undefined); assert.ok(succeeded(await tracker.keepAllChangesInFile(p)));
});
test('DT-07 same commit on another branch pauses only that repository',async()=>{
    const repoA=path.join(root,'repo-a'),repoB=path.join(root,'repo-b'); fs.mkdirSync(repoA);fs.mkdirSync(repoB);
    const p=path.join(repoA,'a.m'),q=path.join(repoB,'b.m'); for(const f of [p,q]){seed(f,'base','changed');await scan(f);}
    tracker.setBaselineGitContexts([
        {repoRoot:repoA,kind:'repository',headName:'main',headCommit:'aaa',detached:false,inProgress:false},
        {repoRoot:repoB,kind:'repository',headName:'main',headCommit:'aaa',detached:false,inProgress:false}
    ]);
    tracker.observeGitContext({repoRoot:repoA,kind:'repository',headName:'feature',headCommit:'aaa',detached:false,inProgress:false});
    assert.match(tracker.getGitPauseReason(p)??'',/branch/i); assert.equal(tracker.getGitPauseReason(q),undefined);
    assert.equal(succeeded(await tracker.revertFile(p)),false); assert.ok(succeeded(await tracker.keepAllChangesInFile(q)));
});
test('DT-07 detached HEAD movement and merge conflicts pause the affected repository',async()=>{
    const repo=path.join(root,'repo-detached'); fs.mkdirSync(repo); const p=path.join(repo,'sample.m'); seed(p,'base','changed'); await scan(p);
    tracker.setBaselineGitContexts([{repoRoot:repo,kind:'worktree',headName:undefined,headCommit:'aaa',detached:true,inProgress:false}]);
    tracker.observeGitContext({repoRoot:repo,kind:'worktree',headName:undefined,headCommit:'bbb',detached:true,inProgress:false});
    assert.match(tracker.getGitPauseReason(p)??'',/detached|commit/i);
    tracker.setBaselineGitContexts([{repoRoot:repo,kind:'worktree',headName:'main',headCommit:'bbb',detached:false,inProgress:false}]);
    tracker.observeGitContext({repoRoot:repo,kind:'worktree',headName:'main',headCommit:'bbb',detached:false,inProgress:true});
    assert.match(tracker.getGitPauseReason(p)??'',/merge|rebase|progress/i);
});
test('DT-07 missing Git repository observation pauses persisted repository review',async()=>{
    const repo=path.join(root,'repo-removed'); fs.mkdirSync(repo); const p=path.join(repo,'sample.m'); seed(p,'base','changed'); await scan(p);
    tracker.setBaselineGitContexts([{repoRoot:repo,kind:'repository',headName:'main',headCommit:'aaa',detached:false,inProgress:false}]);
    tracker.observeGitRepositoryRemoved(repo); assert.match(tracker.getGitPauseReason(p)??'',/unavailable|closed/i);
    assert.equal(succeeded(await tracker.revertFile(p)),false);
});
test('DT-07 persisted Git identity detects a branch change after reload',async()=>{
    const repo=path.join(root,'repo-reload');fs.mkdirSync(repo);const p=path.join(repo,'sample.m');seed(p,'base','changed');await scan(p);
    const storage=path.join(root,`storage-${index++}`);tracker.storageUri=Uri.file(storage);
    tracker.setBaselineGitContexts([{repoRoot:repo,kind:'repository',headName:'main',headCommit:'aaa',detached:false,inProgress:false}]);
    assert.equal(await tracker.flushPendingPersistence(),true);
    const saved=JSON.parse(fs.readFileSync(path.join(storage,'session-state.json'),'utf8'));
    assert.equal(saved.gitContexts[0].headName,'main');
    tracker=new DiffTracker(Uri.file(storage));assert.equal(await tracker.restorePersistedState(),'restored');
    tracker.reconcileRestoredGitContexts([{repoRoot:repo,kind:'repository',headName:'feature',headCommit:'aaa',detached:false,inProgress:false}]);
    assert.match(tracker.getGitPauseReason(p)??'',/branch/i);assert.equal(succeeded(await tracker.revertFile(p)),false);
});
test('DT-07 explicit archive-and-rebuild resets only the changed repository',async()=>{
    const repoA=path.join(root,'repo-rebuild-a'),repoB=path.join(root,'repo-rebuild-b');fs.mkdirSync(repoA);fs.mkdirSync(repoB);
    const p=path.join(repoA,'a.m'),q=path.join(repoB,'b.m');for(const f of [p,q]){seed(f,'base','changed');await scan(f);}
    const originalA={repoRoot:repoA,kind:'repository',headName:'main',headCommit:'aaa',detached:false,inProgress:false};
    const currentA={...originalA,headName:'feature',headCommit:'bbb'};
    tracker.setBaselineGitContexts([originalA,{repoRoot:repoB,kind:'repository',headName:'main',headCommit:'aaa',detached:false,inProgress:false}]);
    tracker.observeGitContext(currentA);
    const storage=path.join(root,`storage-${index++}`);tracker.storageUri=Uri.file(storage);listedFiles=[Uri.file(p)];
    assert.equal(await tracker.rebuildRepositoryBaseline(repoA,currentA),true);
    assert.equal(tracker.getOriginalContent(p),'changed');assert.equal(pending(p),undefined);assert.equal(tracker.getGitPauseReason(p),undefined);
    assert.equal(tracker.getOriginalContent(q),'base');assert.ok(pending(q));
    assert.equal(fs.existsSync(path.join(storage,'session-state.archive.json')),true);
    const archive=JSON.parse(fs.readFileSync(path.join(storage,'session-state.archive.json'),'utf8'));
    assert.ok(archive.fileSnapshots.some(([savedPath,text])=>savedPath===p&&text==='base'));
});
test('DT-07 repository rebuild watches files already captured while later files are scanning',async()=>{
    const repo=path.join(root,'repo-rebuild-watcher-gap');fs.mkdirSync(repo);
    const p=path.join(repo,'first.m'),q=path.join(repo,'blocked.m');seed(p,'old','branch baseline');seed(q,'old','branch baseline');
    const base={repoRoot:repo,kind:'repository',headName:'main',headCommit:'aaa',detached:false,inProgress:false};
    const current={...base,headName:'feature',headCommit:'bbb'};tracker.setBaselineGitContexts([base]);tracker.observeGitContext(current);
    tracker.storageUri=Uri.file(path.join(root,`storage-${index++}`));listedFiles=[Uri.file(p),Uri.file(q)];
    await tracker.startExternalWatchers();const gate=pause(q,'read');const rebuild=tracker.rebuildRepositoryBaseline(repo,current);
    await gate.entered;await waitUntil(()=>tracker.getOriginalContent(p)==='branch baseline');
    fs.writeFileSync(p,'late external');emitWatcher('change',Uri.file(p));gate.release();
    assert.equal(await rebuild,true);await new Promise(resolve=>setTimeout(resolve,180));
    assert.equal(tracker.getOriginalContent(p),'branch baseline');assert.equal(pending(p)?.currentContent,'late external');
});
test('DT-07 branch change during rebuild keeps the repository paused',async()=>{
    const repo=file('repo');fs.mkdirSync(repo);const p=path.join(repo,'a.m');seed(p,'old','branch');
    const base={repoRoot:repo,kind:'repository',headName:'main',headCommit:'aaa',detached:false,inProgress:false};
    const current={...base,headName:'feature'};tracker.setBaselineGitContexts([base]);tracker.observeGitContext(current);
    tracker.storageUri=Uri.file(path.join(root,`storage-${index++}`));listedFiles=[Uri.file(p)];
    const gate=pause(p,'read');const rebuild=tracker.rebuildRepositoryBaseline(repo,current);await gate.entered;
    tracker.observeGitContext({...base,headName:'third'});gate.release();
    assert.equal(await rebuild,false);assert.ok(tracker.getGitPauseReason(p));assert.equal(tracker.getOriginalContent(p),'old');
});
test('DT-07 stale dialog context cannot rebuild after a second branch change',async()=>{
    const repo=file('repo');fs.mkdirSync(repo);const p=path.join(repo,'a.m');seed(p,'old','branch');
    const base={repoRoot:repo,kind:'repository',headName:'main',headCommit:'aaa',detached:false,inProgress:false};
    const first={...base,headName:'first'};tracker.setBaselineGitContexts([base]);tracker.observeGitContext(first);
    tracker.observeGitContext({...base,headName:'second'});
    tracker.storageUri=Uri.file(path.join(root,`storage-${index++}`));listedFiles=[Uri.file(p)];
    assert.equal(await tracker.rebuildRepositoryBaseline(repo,first),false);
    assert.equal(tracker.getOriginalContent(p),'old');assert.ok(tracker.getGitPauseReason(p));
});
test('DT-07 repository rebuild removes unresolved baseline paths that disappeared',async()=>{
    const repo=path.join(root,'repo-rebuild-unresolved');fs.mkdirSync(repo);
    const unresolved=path.join(repo,'unreadable.m'),stable=path.join(repo,'stable.m');
    fs.writeFileSync(unresolved,'unknown');fs.writeFileSync(stable,'stable');
    listedFiles=[Uri.file(unresolved),Uri.file(stable)];tracker.baselineBuilding=true;tracker.snapshotInitialized=false;
    const storage=path.join(root,`storage-${index++}`);tracker.storageUri=Uri.file(storage);
    faults.set(unresolved,{read:error('NoPermissions')});await tracker.initializeWorkspaceSnapshots();
    assert.ok(pending(unresolved)?.unavailableReason);faults.delete(unresolved);fs.unlinkSync(unresolved);
    const base={repoRoot:repo,kind:'repository',headName:'main',headCommit:'aaa',detached:false,inProgress:false};
    const current={...base,headName:'feature',headCommit:'bbb'};tracker.setBaselineGitContexts([base]);tracker.observeGitContext(current);
    assert.equal(await tracker.flushPendingPersistence(),true);listedFiles=[Uri.file(stable)];
    assert.equal(await tracker.rebuildRepositoryBaseline(repo,current),true);
    assert.equal(pending(unresolved),undefined);
    const saved=JSON.parse(fs.readFileSync(path.join(storage,'session-state.json'),'utf8'));
    assert.equal(saved.unresolvedBaselineFiles.some(([savedPath])=>savedPath===unresolved),false);
});
test('DT-07 dirty buffer or unstable Git state cannot rebuild a paused repository',async()=>{
    const repo=path.join(root,'repo-rebuild-blocked');fs.mkdirSync(repo);const p=path.join(repo,'a.m');seed(p,'base','changed');await scan(p);
    const base={repoRoot:repo,kind:'repository',headName:'main',headCommit:'aaa',detached:false,inProgress:false};
    tracker.setBaselineGitContexts([base]);tracker.observeGitContext({...base,headName:'feature'});
    const storage=path.join(root,`storage-${index++}`);tracker.storageUri=Uri.file(storage);document(p).isDirty=true;
    assert.equal(await tracker.rebuildRepositoryBaseline(repo,{...base,headName:'feature'}),false);
    assert.equal(tracker.getOriginalContent(p),'base');assert.ok(pending(p));assert.ok(tracker.getGitPauseReason(p));
    document(p).isDirty=false;
    assert.equal(await tracker.rebuildRepositoryBaseline(repo,{...base,headName:'feature',inProgress:true}),false);
    assert.equal(tracker.getOriginalContent(p),'base');assert.ok(tracker.getGitPauseReason(p));
});
test('existing automation session interface balances overlapping resource sessions',async()=>{
    const p=file(); const first=tracker.beginAutomationSession({filePaths:[p]}); const second=tracker.beginAutomationSession({filePaths:[p]});
    assert.equal(tracker.isAutomationChangeAllowed(p),true); tracker.endAutomationSession(first);
    assert.equal(tracker.isAutomationChangeAllowed(p),true); tracker.endAutomationSession(second);
    assert.equal(tracker.isAutomationChangeAllowed(p),false);
});
test('DT-02 Keep hunk after new file vanishes cannot accept existence',async()=>{
    const p=file(); fs.writeFileSync(p,'new\n'); await tracker.onExternalFileCreated(Uri.file(p));
    const block=tracker.getChangeBlocks(p)[0]; fs.unlinkSync(p);
    assert.equal(succeeded(await tracker.keepBlock(p,block.blockId)),false);
    assert.equal(tracker.baselineExistingFiles.has(p),false); assert.equal(tracker.getOriginalContent(p),'');
});
test('DT-03 UTF-8 BOM is explicitly unsupported without stripping bytes',async()=>{
    const p=file(); seed(p,'baseline','pending'); await scan(p);
    const bytes=Buffer.from([0xef,0xbb,0xbf,0x61]); fs.writeFileSync(p,bytes); await scan(p);
    assert.equal((await tracker.readCurrentFileState(p)).kind,'unavailable'); assert.ok(pending(p)?.unavailableReason);
    assert.equal(succeeded(await tracker.revertFile(p)),false); assert.deepEqual(fs.readFileSync(p),bytes);
    assert.equal(tracker.getOriginalContent(p),'baseline');
});
for(const symlink of [false,true]) test(`DT-03 ${symlink?'symlink escape':'outside restored resource'} blocks read/write actions`,async()=>{
    const outside=fs.mkdtempSync(path.join(os.tmpdir(),'difftracker-outside-'));
    try {
        const target=path.join(outside,'victim.m'); fs.writeFileSync(target,'outside user content');
        const p=symlink?file('link.m'):target; if(symlink) fs.symlinkSync(target,p);
        tracker.fileSnapshots.set(p,'review baseline'); tracker.baselineExistingFiles.add(p);
        tracker.updateTrackedDiff(p,'outside user content'); const before={...counters};
        assert.equal(succeeded(await tracker.revertFile(p)),false); assert.equal(succeeded(await tracker.keepAllChangesInFile(p)),false);
        assert.equal((await tracker.readCurrentFileState(p)).kind,'unavailable');
        assert.equal(fs.readFileSync(target,'utf8'),'outside user content'); assert.deepEqual(counters,before);
        assert.equal(tracker.getOriginalContent(p),'review baseline');
    } finally { fs.rmSync(outside,{recursive:true,force:true}); }
});
test('DT-03 applyEdit throws after text mutation retains failed buffer and pending',async()=>{
    const p=file(); seed(p,'baseline','changed'); await scan(p);
    faults.set(p,{afterApply:error('injected post-mutation failure')});
    const result=await tracker.revertFile(p); assert.equal(succeeded(result),false); assert.equal(result.bufferChanged,true);
    assert.equal(document(p).getText(),'baseline'); assert.equal(disk(p),'changed');
    tracker.processDocumentChange(document(p)); await scan(p); assert.ok(pending(p));
    assert.equal(tracker.getOriginalContent(p),'baseline');
});
for(const afterApply of [false,error('injected hunk post-mutation failure')]) test(`DT-03 hunk applyEdit ${afterApply===false?'false':'throws'} after mutation retains pending`,async()=>{
    const p=file(); seed(p,'base\n','changed\n'); await scan(p);
    const storage=path.join(root,`storage-${index++}`); tracker.storageUri=Uri.file(storage);
    const block=tracker.getChangeBlocks(p)[0]; faults.set(p,{afterApply});
    const beforeSave=counters.save; const result=await tracker.revertBlock(p,block.blockId);
    assert.equal(succeeded(result),false); assert.equal(result.bufferChanged,true);
    assert.equal(document(p).getText(),'base\n'); assert.equal(disk(p),'changed\n'); assert.equal(counters.save,beforeSave);
    assert.equal(tracker.revertHistory.length,1,'a partially applied hunk must retain its durable recovery record');
    assert.equal(JSON.parse(fs.readFileSync(path.join(storage,'session-state.json'),'utf8')).revertHistory.length,1);
    tracker.processDocumentChange(document(p)); await scan(p); assert.ok(pending(p)); assert.equal(tracker.getOriginalContent(p),'base\n');
});
const stage1Count=tests.length;
{
    test('DT-04 pure insertion Keep Y uses its baseline coordinate',async()=>{
        const p=file(); seed(p,'a\nb\nc\nd\ne\n','X\na\nb\nc\nY\nd\ne\n'); await scan(p);
        const working=disk(p); const block=tracker.getChangeBlocks(p).find(b=>b.changes.some(c=>c.newText==='Y'));
        assert.ok(block); await tracker.keepBlock(p,block.blockId);
        assert.equal(disk(p),working); assert.equal(tracker.getOriginalContent(p),'a\nb\nc\nY\nd\ne\n');
    });
    test('DT-04 old block ID is rejected after same-line external replacement',async()=>{
        const p=file(); seed(p,'a\nb\nc\n','a\nB\nc\n'); await scan(p); const old=tracker.getChangeBlocks(p)[0].blockId;
        fs.writeFileSync(p,'a\nZ\nc\n'); await scan(p); const current=tracker.getChangeBlocks(p)[0].blockId;
        const result=await tracker.keepBlock(p,old);
        assert.equal(succeeded(result),false);
        assert.notEqual(old,current); assert.equal(tracker.getOriginalContent(p),'a\nb\nc\n');
    });
    for(const delay of [200,2000]) test(`DT-05 unknown-source save then external write after ${delay}ms`,async()=>{
        automationOnly=true; const p=file(); seed(p,'A=old\nseparator\nB=old\n'); const doc=document(p);
        doc.text='A=manual\nseparator\nB=old\n'; doc.isDirty=true;
        tracker.onDocumentChanged({document:doc,contentChanges:[{text:'A=manual'}]});
        tracker.onWillSaveDocument({document:doc}); await doc.save(); tracker.onDidSaveDocument(doc);
        await new Promise(resolve=>setTimeout(resolve,delay));
        fs.writeFileSync(p,'A=manual\nseparator\nB=external\n');
        await tracker.onExternalFileChanged(Uri.file(p)); await new Promise(resolve=>setTimeout(resolve,180));
        const change=pending(p);
        assert.ok(change,'external change must be visible');
        assert.ok(change.currentContent.includes('B=external'),'external write must be represented');
        if(process.env.DT_LEGACY_MANUAL==='1') {
            assert.ok(change.originalContent.includes('A=manual'),'LEGACY desired attribution: previously untracked manual-only save must not reappear as pending');
        } else {
            assert.ok(change.originalContent.includes('A=old'),'unknown document-event authorship must remain conservative, not silently accept text');
        }
    });
}
for(const order of [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]]) {
    for(const kept of [[],[0],[1],[0,2],[0,1,2]]) test(`DT-04 insertion permutation ${order} Keep ${kept}`,async()=>{
        const p=file(), base='a\nb\nc\nd\ne\nf\ng\nh\ni\n';
        const render=ids=>`${ids.includes(0)?'X\n':''}a\nb\nc\n${ids.includes(1)?'Y\n':''}d\ne\nf\n${ids.includes(2)?'Z\n':''}g\nh\ni\n`;
        seed(p,base,render([0,1,2])); await scan(p);
        const accepted=[], remaining=[0,1,2];
        for(const id of order) {
            const block=tracker.getChangeBlocks(p).find(b=>b.changes.some(c=>c.newText===['X','Y','Z'][id])); assert.ok(block);
            const before=disk(p);
            if(kept.includes(id)){assert.ok(succeeded(await tracker.keepBlock(p,block.blockId)));accepted.push(id);assert.equal(disk(p),before);}
            else {
                assert.ok(succeeded(await tracker.revertBlock(p,block.blockId)));remaining.splice(remaining.indexOf(id),1);
                assert.equal(document(p).getText(),render(remaining),'Revert edits the buffer');
                assert.equal(disk(p),before,'hunk Revert preserves existing unsaved behavior');
                assert.ok(await document(p).save());await scan(p);
            }
            assert.equal(tracker.getOriginalContent(p),render(accepted),'only selected Keep enters baseline');
            assert.equal(disk(p),render(remaining),'only selected Revert changes working file');
        }
        assert.equal(disk(p),render(kept)); assert.equal(pending(p),undefined);
    });
}
for(const action of ['keepAllChangesInFile','revertFile']) {
    test(`DT-04 ${action} rejects stale explicit file token`,async()=>{
        const p=file();seed(p,'base','first');await scan(p);const token=tracker.getReviewToken(p);
        fs.writeFileSync(p,'second');await scan(p);
        assert.equal(succeeded(await tracker[action](p,token)),false);assert.equal(disk(p),'second');assert.equal(tracker.getOriginalContent(p),'base');
    });
    test(`DT-04 ${action} detects external replacement across read await`,async()=>{
        const p=file();seed(p,'base','first');await scan(p);const token=tracker.getReviewToken(p);
        const gate=pause(p,'read');const operation=tracker[action](p,token);await gate.entered;
        fs.writeFileSync(p,'second');gate.release();const result=await operation;
        assert.equal(succeeded(result),false);assert.equal(disk(p),'second');assert.equal(tracker.getOriginalContent(p),'base');
    });
}
test('DT-04 duplicate queued Keep uses original token and only succeeds once',async()=>{
    const p=file();seed(p,'base','first');await scan(p);const token=tracker.getReviewToken(p);
    const gate=pause(p,'read');const first=tracker.keepAllChangesInFile(p,token);await gate.entered;
    const second=tracker.keepAllChangesInFile(p,token);gate.release();
    assert.ok(succeeded(await first));assert.equal(succeeded(await second),false);assert.equal(tracker.getOriginalContent(p),'first');
});
for(const action of ['keepAllChanges','revertAllChanges']) test(`DT-04 ${action} snapshot excludes new files and changed targets`,async()=>{
    const p=file(),q=file();seed(p,'base','first');await scan(p);const tokens=tracker.getReviewTokens();
    fs.writeFileSync(p,'later');await scan(p);seed(q,'qbase','qpending');await scan(q);
    const result=await tracker[action](tokens);assert.equal(result.succeeded,0);
    assert.equal(disk(p),'later');assert.equal(disk(q),'qpending');assert.ok(pending(p));assert.ok(pending(q));
});
test('DT-05 mixed AI pending plus unknown save never accepts full file',async()=>{
    automationOnly=true;const p=file();seed(p,'a\nseparator\nb\n','AI\nseparator\nb\n');await scan(p);
    const doc=document(p);doc.text='AI\nseparator\nmanual\n';doc.isDirty=true;doc.version++;
    tracker.onDocumentChanged({document:doc,contentChanges:[{text:'manual'}]});
    tracker.onWillSaveDocument({document:doc});await doc.save();tracker.onDidSaveDocument(doc);await scan(p);
    assert.equal(tracker.getOriginalContent(p),'a\nseparator\nb\n');assert.ok(pending(p));assert.equal(disk(p),doc.text);
});
for(const reason of [1,2,undefined]) test(`DT-05 undo/redo/formatter event ${reason} refreshes automation-only review`,async()=>{
    automationOnly=true;const p=file();seed(p,'base','changed');await scan(p);const doc=document(p);
    doc.text='base';doc.isDirty=true;doc.version++;
    tracker.onDocumentChanged({document:doc,contentChanges:[{text:'base'}],reason});
    await new Promise(r=>setTimeout(r,180));assert.equal(pending(p),undefined);
    doc.text='changed';doc.version++;tracker.onDocumentChanged({document:doc,contentChanges:[{text:'changed'}],reason});
    await new Promise(r=>setTimeout(r,180));assert.ok(pending(p));assert.equal(tracker.getOriginalContent(p),'base');
});
for(const stop of ['stopRecording','dispose']) test(`DT-08 old read cannot publish after ${stop}`,async()=>{
    const p=file();seed(p,'base','changed');const gate=pause(p,'read');const operation=scan(p);await gate.entered;
    tracker[stop]();gate.release();await operation;assert.equal(pending(p),undefined);assert.equal(tracker.getOriginalContent(p),'base');
});
test('DT-08 atomic replacement delete event reads actual replacement',async()=>{
    const p=file();seed(p,'base','replacement');await tracker.onExternalFileDeleted(Uri.file(p));
    assert.equal(pending(p)?.isDeleted,false);assert.equal(pending(p)?.currentContent,'replacement');
});
test('DT-08 change-before-create watcher order still recognizes a post-baseline new file',async()=>{
    const p=file('watcher-race-new.m');fs.writeFileSync(p,'new content');
    await tracker.onExternalFileChanged(Uri.file(p));await new Promise(resolve=>setTimeout(resolve,180));
    assert.ok(pending(p)?.unavailableReason,'the early change event has no before-image yet');
    await tracker.onExternalFileCreated(Uri.file(p));
    assert.equal(pending(p)?.unavailableReason,undefined);
    assert.equal(tracker.getOriginalContent(p),'');
    assert.equal(tracker.baselineExistingFiles.has(p),false);
    assert.ok(succeeded(await tracker.revertFile(p)));
    assert.equal(fs.existsSync(p),false);
});
test('DT-08 parent-only deletion event discovers baseline child deletion',async()=>{
    const dir=file('directory');fs.mkdirSync(dir);const p=path.join(dir,'child.m');seed(p,'base');fs.rmSync(dir,{recursive:true});
    await tracker.onExternalFileDeleted(Uri.file(dir));assert.equal(pending(p)?.isDeleted,true);
});
test('DT-06 removed workspace roots preserve a reloadable paused session',async()=>{
    const p=file();seed(p,'preserved');tracker.storageUri=Uri.file(path.join(root,`storage-${index++}`));
    await tracker.flushPendingPersistence();const storage=tracker.storageUri;const folders=vscode.workspace.workspaceFolders;
    try {
        vscode.workspace.workspaceFolders=[];workspaceChanged({added:[],removed:folders});
        assert.equal(await tracker.flushPendingPersistence(),true);await tracker.dispose();
        tracker=new DiffTracker(storage);assert.equal(await tracker.restorePersistedState(),'incomplete');
        assert.equal(tracker.getOriginalContent(p),'preserved');
    } finally { vscode.workspace.workspaceFolders=folders; }
});
test('DT-06 reset after reverting a new file remains reloadable',async()=>{
    const p=file();fs.writeFileSync(p,'new');await tracker.onExternalFileCreated(Uri.file(p));
    tracker.storageUri=Uri.file(path.join(root,`storage-${index++}`));const storage=tracker.storageUri;
    assert.ok(succeeded(await tracker.revertFile(p)));const stable=file();seed(stable,'stable');listedFiles=[Uri.file(stable)];
    await tracker.resetBaselineToCurrentState();await tracker.flushPendingPersistence();await tracker.dispose();
    tracker=new DiffTracker(storage);
    assert.notEqual(await tracker.restorePersistedState(),'blocked');
});
test('DT-08 reset cannot scan ahead of replacement watcher registration',async()=>{
    const p=file();seed(p,'old','current');listedFiles=[Uri.file(p)];
    const gate=pause(root,'ignoreScan');const reset=tracker.resetBaselineToCurrentState();await gate.entered;
    await new Promise(resolve=>setTimeout(resolve,30));
    const scanned=tracker.getOriginalContent(p)==='current';
    fs.writeFileSync(p,'external');emitWatcher('change',Uri.file(p));gate.release();await reset;
    await new Promise(resolve=>setTimeout(resolve,180));
    assert.ok(!scanned || pending(p)?.currentContent==='external','a scanned file must have live watcher coverage');
});
test('DT-08 explicit baseline reset accepts the current dirty editor content',async()=>{
    const p=file('dirty-reset.m');seed(p,'old baseline','saved disk');const doc=document(p);
    doc.text='dirty current';doc.isDirty=true;doc.version++;
    listedFiles=[Uri.file(p)];await tracker.resetBaselineToCurrentState();
    assert.equal(tracker.getOriginalContent(p),'dirty current');assert.equal(pending(p),undefined);
    doc.text='later edit';doc.version++;tracker.processDocumentChange(doc);
    assert.equal(pending(p)?.originalContent,'dirty current');assert.equal(pending(p)?.currentContent,'later edit');
});
for(const transition of ['startRecording','resetBaselineToCurrentState']) test(`DT-08 old scan cannot publish across ${transition}`,async()=>{
    const p=file();fs.writeFileSync(p,'old scan');listedFiles=[Uri.file(p)];tracker.baselineBuilding=true;tracker.snapshotInitialized=false;
    const gate=pause(p,'read');const old=tracker.initializeWorkspaceSnapshots();await gate.entered;
    listedFiles=[];await tracker[transition]();tracker.fileSnapshots.set(p,'new baseline');tracker.baselineExistingFiles.add(p);
    gate.release();await old;assert.equal(tracker.getOriginalContent(p),'new baseline');
});
test('DT-08 create during scan has unknown before-image, not silently accepted',async()=>{
    const p=file();fs.writeFileSync(p,'scanned');listedFiles=[Uri.file(p)];tracker.baselineBuilding=true;tracker.snapshotInitialized=false;
    const gate=pause(p,'read');const old=tracker.initializeWorkspaceSnapshots();await gate.entered;
    fs.writeFileSync(p,'replacement');await tracker.onExternalFileCreated(Uri.file(p));gate.release();await old;
    assert.ok(pending(p)?.unavailableReason);assert.notEqual(tracker.getOriginalContent(p),'replacement');
});
test('DT-08 unreadable baseline entry remains unavailable after Ready persistence and restart',async()=>{
    const unavailable=file('unreadable.m'),stable=file('stable.m');
    fs.writeFileSync(unavailable,'unknown before');fs.writeFileSync(stable,'stable baseline');
    listedFiles=[Uri.file(unavailable),Uri.file(stable)];tracker.baselineBuilding=true;tracker.snapshotInitialized=false;
    const storage=path.join(root,`storage-${index++}`);tracker.storageUri=Uri.file(storage);
    faults.set(unavailable,{read:error('NoPermissions')});await tracker.initializeWorkspaceSnapshots();
    assert.equal(tracker.getBaselineState(),'ready');assert.ok(pending(unavailable)?.unavailableReason);
    assert.equal(await tracker.flushPendingPersistence(),true);
    const saved=JSON.parse(fs.readFileSync(path.join(storage,'session-state.json'),'utf8'));
    assert.ok(saved.unresolvedBaselineFiles.some(([savedPath])=>savedPath===unavailable));
    faults.delete(unavailable);tracker=new DiffTracker(Uri.file(storage));
    assert.equal(await tracker.restorePersistedState(),'restored');
    assert.ok(pending(unavailable)?.unavailableReason);assert.equal(tracker.getReviewToken(unavailable),undefined);
    assert.equal(tracker.getOriginalContent(stable),'stable baseline');
});
test('DT-08 an all-unresolved baseline restores its review instead of being treated as empty corruption',async()=>{
    const unavailable=file('only-unreadable.m');fs.writeFileSync(unavailable,'unknown before');
    listedFiles=[Uri.file(unavailable)];tracker.baselineBuilding=true;tracker.snapshotInitialized=false;
    const storage=path.join(root,`storage-${index++}`);tracker.storageUri=Uri.file(storage);
    faults.set(unavailable,{read:error('NoPermissions')});await tracker.initializeWorkspaceSnapshots();
    assert.equal(await tracker.flushPendingPersistence(),true);faults.delete(unavailable);
    tracker=new DiffTracker(Uri.file(storage));assert.equal(await tracker.restorePersistedState(),'restored');
    assert.ok(pending(unavailable)?.unavailableReason);assert.equal(tracker.isRecoveryBlocked(),false);
});
test('DT-08 late change outside scan enumeration persists an unknown baseline across restart',async()=>{
    const changed=file('late-change.m'),stable=file('late-stable.m');
    fs.writeFileSync(changed,'appeared during scan');seed(stable,'stable baseline');
    listedFiles=[];tracker.baselineBuilding=true;tracker.snapshotInitialized=false;
    const storage=path.join(root,`storage-${index++}`);tracker.storageUri=Uri.file(storage);
    await tracker.onExternalFileChanged(Uri.file(changed));await tracker.initializeWorkspaceSnapshots();
    assert.ok(pending(changed)?.unavailableReason);assert.equal(await tracker.flushPendingPersistence(),true);
    const saved=JSON.parse(fs.readFileSync(path.join(storage,'session-state.json'),'utf8'));
    assert.ok(saved.unresolvedBaselineFiles.some(([savedPath])=>savedPath===changed));
    tracker=new DiffTracker(Uri.file(storage));assert.equal(await tracker.restorePersistedState(),'restored');
    assert.ok(pending(changed)?.unavailableReason);assert.equal(tracker.getReviewToken(changed),undefined);
});
test('DT-08 save completion after stop/start cannot clear new session review',async()=>{
    const p=file();seed(p,'base','changed');await scan(p);const gate=pause(p,'save');const operation=tracker.revertFile(p);await gate.entered;
    tracker.stopRecording();tracker.startRecording();tracker.fileSnapshots.set(p,'new baseline');tracker.baselineExistingFiles.add(p);
    tracker.updateTrackedDiff(p,'new pending');gate.release();const result=await operation;
    assert.equal(succeeded(result),false);assert.equal(tracker.getOriginalContent(p),'new baseline');assert.ok(pending(p));
});
test('DT-08 workspace membership event pauses and invalidates captured action',async()=>{
    const p=file();seed(p,'base','changed');await scan(p);const token=tracker.getReviewToken(p);
    workspaceChanged({added:[],removed:[vscode.workspace.workspaceFolders[0]]});
    assert.equal(tracker.getIsRecording(),false);assert.equal(succeeded(await tracker.revertFile(p,token)),false);assert.equal(disk(p),'changed');
});
for(const action of ['keepBlock','revertBlock']) test(`DT-04 ${action} rejects stale clean editor content`,async()=>{
    const p=file();seed(p,'base','old edit');document(p);fs.writeFileSync(p,'new edit');await scan(p);
    const block=tracker.getChangeBlocks(p)[0],token=tracker.getReviewToken(p),before={...counters};
    assert.equal(succeeded(await tracker[action](p,block.blockId,token)),false);
    assert.equal(disk(p),'new edit');assert.equal(document(p).getText(),'old edit');assert.equal(tracker.getOriginalContent(p),'base');assert.deepEqual(counters,before);
});
test('DT-08 failed old save cannot mark new session pending-write or replace its review',async()=>{
    const p=file();seed(p,'base','changed');await scan(p);const gate=pause(p,'save');faults.set(p,{save:error('old save error')});
    const operation=tracker.revertFile(p);await gate.entered;tracker.stopRecording();tracker.startRecording();
    tracker.fileSnapshots.set(p,'new baseline');tracker.baselineExistingFiles.add(p);tracker.updateTrackedDiff(p,'new pending');
    gate.release();assert.equal(succeeded(await operation),false);
    assert.equal(tracker.getOriginalContent(p),'new baseline');assert.equal(pending(p)?.currentContent,'new pending');assert.equal(tracker.pendingWriteFiles.has(p),false);
});
for(const action of ['keepAllChanges','revertAllChanges']) test(`DT-04 ${action} rechecks later target after earlier await`,async()=>{
    const p=file(),q=file();for(const f of [p,q]){seed(f,'base','pending');await scan(f);}
    const tokens=tracker.getReviewTokens(),gate=pause(p,'read');const operation=tracker[action](tokens);await gate.entered;
    fs.writeFileSync(q,'later external');await scan(q);gate.release();const result=await operation;
    assert.equal(result.succeeded,1);assert.equal(disk(q),'later external');assert.equal(tracker.getOriginalContent(q),'base');assert.ok(pending(q));
});
for(const kind of ['file','block']) test(`DT-07 ${kind} Keep rechecks Git pause after its reads`,async()=>{
    const p=file();seed(p,'base\n','changed\n');await scan(p);
    const context={repoRoot:root,kind:'repository',headName:'main',headCommit:'aaa',detached:false,inProgress:false};
    tracker.setBaselineGitContexts([context]);const token=tracker.getReviewToken(p);const block=tracker.getChangeBlocks(p)[0];
    // The initial queue verification reads once; pause the following action read.
    const first=pause(p,'read');const action=kind==='file'?tracker.keepAllChangesInFile(p,token):tracker.keepBlock(p,block.blockId,token);
    await first.entered;const second=pause(p,'read');first.release();await second.entered;
    tracker.observeGitContext({...context,headName:'other'});second.release();
    assert.equal(succeeded(await action),false);assert.equal(tracker.getOriginalContent(p),'base\n');
});
test('DT-09 Undo waits for the complete in-flight Revert All',async()=>{
    const p=file(),q=file();for(const f of [p,q]){seed(f,'base','changed');await scan(f);}
    tracker.storageUri=Uri.file(path.join(root,`storage-${index++}`));
    const gate=pause(p,'apply');const revert=tracker.revertAllChanges();await gate.entered;
    let undoCompleted=false;const undo=tracker.undoLastRevert().then(result=>{undoCompleted=true;return result;});
    await new Promise(resolve=>setTimeout(resolve,30));const premature=undoCompleted;gate.release();
    assert.equal((await revert).succeeded,2);assert.equal((await undo).succeeded,2);
    assert.equal(premature,false);assert.equal(disk(p),'changed');assert.equal(disk(q),'changed');
});
if(process.env.DT_KNOWN_P0==='1'||process.env.DT_LEGACY_MANUAL==='1') {tests.splice(stage1Count+4);tests.splice(0,stage1Count+(process.env.DT_LEGACY_MANUAL==='1'?2:0));}
let failures=0;
for(const {name,run} of tests) {
    docs.length=0; watcherInstances.length=0; faults.clear(); barriers.clear(); automationOnly=false;listedFiles=[]; tracker=new DiffTracker();
    tracker.isRecording=true; tracker.externalWatcherEnabled=true; tracker.snapshotInitialized=true;
    try { await run(); console.log(`PASS ${name}`); }
    catch(e) { failures++; console.error(`FAIL ${name}\n${e.stack}`); }
    finally { await tracker.dispose(); }
}
fs.rmSync(root,{recursive:true,force:true});
console.log(`${tests.length-failures}/${tests.length} ${process.env.DT_LEGACY_MANUAL==='1'?'historical authorship-inference diagnostics':process.env.DT_KNOWN_P0==='1'?'known-P0 conservative safety probes':'production tracker regressions'} passed (mocked VS Code boundary; not Extension Host).`);
process.exitCode=failures?1:0;
