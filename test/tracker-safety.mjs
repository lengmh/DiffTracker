/** Production regression tests. Only the VS Code API boundary is faked.
 * No diff, existence, acceptance or recovery algorithm is copied into this test.
 * DT_SOURCE may point at an archived baseline source for red/green comparison.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
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
let watchExclude=[];
let listedFiles=[];
let listedIgnores=[];
let vscodeExcludes={};
let workspaceChanged;
let workspaceFilesCreated;
const docs = [];
const watcherInstances = [];
const counters = { apply: 0, save: 0, write: 0 };
const nativeDirectoryWatchers = [];
const nativeWatch = fs.watch;
fs.watch = (directory, options, listener) => {
    fault(root, 'watcher');
    const actual = process.env.DT_REAL_DIRECTORY_WATCH ? nativeWatch(directory, options, listener) : undefined;
    const watcher = {directory, listener, active:true, close(){this.active=false;actual?.close();}, on(event,handler){this[event]=handler;actual?.on(event,handler);return this;}};
    nativeDirectoryWatchers.push(watcher);return watcher;
};
const nativeLink = fs.promises.link;
fs.promises.link = async (source, destination) => {
    await boundary(destination,'publish');fault(destination,'publish');
    await nativeLink(source,destination);
    await boundary(destination,'afterPublish');
};
const noopEvent = () => ({ dispose() {} });
function createWatcher(pattern) {
    fault(root,'watcher');
    const handlers = { change: [], create: [], delete: [] };
    const watcher = {
        active: true, pattern,
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
        getWorkspaceFolder:uri => {
            // Native path.relative preserves Windows case-insensitive membership.
            const relative=path.relative(root,uri.fsPath);
            return relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative)
                ? { uri:Uri.file(root), name:'test' } : undefined;
        },
        getConfiguration:()=>({ get:(key, fallback)=>key==='onlyTrackAutomatedChanges'?automationOnly:key==='watchExclude'?watchExclude:key in vscodeExcludes?vscodeExcludes[key]:fallback }),
        onDidChangeTextDocument:noopEvent, onDidOpenTextDocument:noopEvent,
        onWillSaveTextDocument:noopEvent, onDidSaveTextDocument:noopEvent,
        onDidCreateFiles:handler=>{workspaceFilesCreated=handler;return {dispose(){}};},
        onDidChangeConfiguration:noopEvent,
        onDidChangeWorkspaceFolders:handler=>{workspaceChanged=handler;return {dispose(){}};},
        findFiles:async pattern=>{if(pattern.pattern!=='**/*') await boundary(root,'ignoreScan');return pattern.pattern==='**/*'?listedFiles:pattern.pattern==='**/.gitignore'?listedIgnores:[];},
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
            async stat(uri) { await boundary(uri.fsPath,'stat'); fault(uri.fsPath,'stat'); const stat=fs.statSync(uri.fsPath); return {type:stat.isDirectory()?2:1,size:fault(uri.fsPath,'size')??stat.size,mtime:stat.mtimeMs}; },
            async readFile(uri) { fault(uri.fsPath,'read'); const bytes=new Uint8Array(fs.readFileSync(uri.fsPath)); await boundary(uri.fsPath,'read'); return bytes; },
            async writeFile(uri, bytes) { counters.write++; fault(uri.fsPath,'write'); await boundary(uri.fsPath,'write'); fs.writeFileSync(uri.fsPath,bytes); },
            async createDirectory(uri) { fs.mkdirSync(uri.fsPath,{recursive:true}); },
            async delete(uri) { await boundary(uri.fsPath,'delete'); fault(uri.fsPath,'delete'); fs.rmSync(uri.fsPath); await boundary(uri.fsPath,'afterDelete'); },
            async rename(source, target, options) {
                await boundary(source.fsPath,'rename');
                fault(source.fsPath,'rename');
                if (options?.overwrite) fs.rmSync(target.fsPath,{force:true});
                fs.renameSync(source.fsPath,target.fsPath);
            },
            async copy(source, target, options) {
                await boundary(source.fsPath,'copy');
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
        mod.filename=mod.id;
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
test('DT-02 empty new file remains pending until manual deletion',async()=>{
    const p=file(); fs.writeFileSync(p,''); await tracker.onExternalFileCreated(Uri.file(p));
    assert.ok(pending(p)); assert.equal(pending(p).isDeleted,false);
    assert.equal((await tracker.revertFile(p)).status,'conflict');assert.equal(disk(p),'');assert.ok(pending(p));
    fs.unlinkSync(p);await tracker.onExternalFileDeleted(Uri.file(p));assert.equal(pending(p),undefined);
});
test('DT-02 deleting baseline empty file has pending and Revert recreates it',async()=>{
    const p=file(); seed(p,''); fs.unlinkSync(p); await tracker.onExternalFileDeleted(Uri.file(p));
    assert.equal(pending(p)?.isDeleted,true); assert.ok(succeeded(await tracker.revertFile(p))); assert.equal(disk(p),'');
});
test('DT-02 unaccepted new file Revert preserves content and dispatches no edit',async()=>{
    const p=file(); fs.writeFileSync(p,'new\n'); await tracker.onExternalFileCreated(Uri.file(p));
    const before=counters.apply;assert.equal((await tracker.revertFile(p)).status,'conflict');assert.equal(disk(p),'new\n');assert.equal(counters.apply,before);assert.ok(pending(p));
});
test('DT-02 VS Code create event repairs a change-first new text file',async()=>{
    const p=file('workspace-created.txt');fs.writeFileSync(p,'new text');
    await tracker.onExternalFileChanged(Uri.file(p));await waitUntil(()=>!!pending(p)?.unavailableReason);
    workspaceFilesCreated({files:[Uri.file(p)]});
    await waitUntil(()=>!!pending(p)&&pending(p).unavailableReason===undefined);
    assert.equal(tracker.getOriginalContent(p),'');assert.equal(tracker.baselineExistingFiles.has(p),false);
    assert.ok(succeeded(await tracker.keepAllChangesInFile(p)));
});
test('DT-02 newly created binary files are excluded from text review',async()=>{
    const p=file('image.png');fs.writeFileSync(p,Buffer.from([0x89,0x50,0x4e,0x47,0x00,0x01]));
    await tracker.onExternalFileCreated(Uri.file(p));
    assert.equal(pending(p),undefined);assert.equal(tracker.getOriginalContent(p),'');
    assert.equal(tracker.baselineExistingFiles.has(p),false);
});
test('DT-02 hunk Keep on a new file establishes existence for later Revert',async()=>{
    const p=file(); fs.writeFileSync(p,'accepted\n'); await tracker.onExternalFileCreated(Uri.file(p));
    const block=tracker.getChangeBlocks(p)[0]; assert.ok(block);
    assert.ok(succeeded(await tracker.keepBlock(p,block.blockId))); assert.ok(tracker.baselineExistingFiles.has(p));
    fs.writeFileSync(p,'accepted\nremaining\n'); await scan(p);
    assert.ok(succeeded(await tracker.revertFile(p))); assert.equal(disk(p),'accepted\n');
});
test('DT-02 accepted deletion followed by recreation requires manual deletion',async()=>{
    const p=file(); seed(p,'old\n'); fs.unlinkSync(p); await tracker.onExternalFileDeleted(Uri.file(p));
    assert.ok(succeeded(await tracker.keepAllChangesInFile(p))); assert.equal(tracker.baselineExistingFiles.has(p),false);
    fs.writeFileSync(p,'reborn\n'); await tracker.onExternalFileCreated(Uri.file(p));
    assert.equal((await tracker.revertFile(p)).status,'conflict');assert.equal(disk(p),'reborn\n');assert.ok(pending(p));
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
    const before={...counters}; const revert=await tracker.revertFile(p);const keep=await tracker.keepAllChangesInFile(p);
    assert.equal(succeeded(revert),false);assert.equal(succeeded(keep),false);
    assert.match(revert.reason??'',/save/i);assert.match(keep.reason??'',/save/i);
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
    assert.equal(counters.apply,before.apply); assert.equal(counters.save,before.save);
    assert.ok(fs.existsSync(path.join(storage,'session-state.unsaved')));
    faults.delete(temp);
});
test('DT-09 legacy recovery record still recreates an unaccepted new file',async()=>{
    const p=file(); fs.writeFileSync(p,'new content'); await tracker.onExternalFileCreated(Uri.file(p));
    await tracker.prepareRevertRecord([tracker.createFileRevertItem(p)]);fs.unlinkSync(p);
    const undo=await tracker.undoLastRevert(); assert.equal(undo.succeeded,1); assert.equal(disk(p),'new content'); assert.ok(pending(p));
});
test('DT-09 failed exclusive recovery publication retains the record without creating the resource',async()=>{
    const p=file(); fs.writeFileSync(p,'new content'); await tracker.onExternalFileCreated(Uri.file(p));
    await tracker.prepareRevertRecord([tracker.createFileRevertItem(p)]);fs.unlinkSync(p);
    faults.set(p,{publish:error('NoPermissions')});
    const undo=await tracker.undoLastRevert();
    assert.equal(undo.succeeded,0); assert.equal(undo.results[0].status,'conflict'); assert.equal(undo.results[0].bufferChanged,false);
    assert.equal(fs.existsSync(p),false);
    assert.equal(tracker.revertHistory.length,1,'partial recovery remains retryable');
});
test('DT-09 destructive recovery requires manual deletion and retains its record until verified',async()=>{
    const p=file(); seed(p,'baseline'); fs.unlinkSync(p); await tracker.onExternalFileDeleted(Uri.file(p));
    assert.ok(succeeded(await tracker.revertFile(p))); assert.equal(disk(p),'baseline');
    const before={...counters};const undo=await tracker.undoLastRevert();assert.equal(undo.succeeded,0);
    assert.equal(disk(p),'baseline');assert.deepEqual(counters,before);assert.equal(tracker.revertHistory.length,1);
    fs.writeFileSync(p,'new external work');assert.equal((await tracker.undoLastRevert()).succeeded,0);assert.equal(disk(p),'new external work');
    fs.unlinkSync(p);assert.equal((await tracker.undoLastRevert()).succeeded,1);assert.equal(tracker.revertHistory.length,0);
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
    const binary=path.join(repo,'image.png');fs.writeFileSync(binary,Buffer.from([0,1,2]));
    const base={repoRoot:repo,kind:'repository',headName:'main',headCommit:'aaa',detached:false,inProgress:false};
    const current={...base,headName:'feature'};tracker.setBaselineGitContexts([base]);tracker.observeGitContext(current);
    tracker.storageUri=Uri.file(path.join(root,`storage-${index++}`));listedFiles=[Uri.file(p),Uri.file(binary)];
    const gate=pause(p,'read');const rebuild=tracker.rebuildRepositoryBaseline(repo,current);await gate.entered;
    tracker.observeGitContext({...base,headName:'third'});gate.release();
    assert.equal(await rebuild,false);assert.ok(tracker.getGitPauseReason(p));assert.equal(tracker.getOriginalContent(p),'old');
    assert.equal(tracker.unresolvedBaselineFiles.has(binary),false);
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
    assert.equal((await tracker.revertFile(p)).status,'conflict');assert.equal(disk(p),'new content');
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
test('AUDIT-21 stopped clear persists empty baseline and history without resuming recording',async()=>{
    const p=file(),q=file();seed(p,'before','current');seed(q,'q before','q current');await scan(p);await scan(q);assert.ok(succeeded(await tracker.revertFile(q)));
    const storage=file('storage');tracker.storageUri=Uri.file(storage);tracker.stopRecording();await tracker.flushPendingPersistence();
    await tracker.resetBaselineToCurrentState();await tracker.flushPendingPersistence();
    assert.equal(tracker.getIsRecording(),false);assert.equal(disk(p),'current');assert.equal(disk(q),'q before');assert.equal(tracker.getOriginalContent(p),undefined);
    const saved=JSON.parse(disk(path.join(storage,'session-state.json')));
    assert.equal(saved.fileSnapshots.length,0);assert.equal(saved.baselineExistingFiles.length,0);assert.equal(saved.revertHistory.length,0);
    await tracker.dispose();tracker=new DiffTracker(Uri.file(storage));assert.equal(await tracker.restorePersistedState(),'restored');
    assert.equal(tracker.getIsRecording(),false);assert.equal(tracker.getTrackedChanges().length,0);assert.equal((await tracker.undoLastRevert()).succeeded,0);
});
for(const phase of ['write','rename','copy'])test(`AUDIT-21 failed stopped clear at ${phase} retains review and reloadable history`,async()=>{
    const p=file(),q=file();seed(p,'before','current');seed(q,'q before','q current');await scan(p);await scan(q);assert.ok(succeeded(await tracker.revertFile(q)));
    const storage=file('storage');tracker.storageUri=Uri.file(storage);tracker.stopRecording();await tracker.flushPendingPersistence();
    const oldHistory=JSON.stringify(tracker.revertHistory),target=path.join(storage,phase==='copy'?'session-state.json':'session-state.tmp.json');faults.set(target,{[phase]:error('NoPermissions')});
    assert.equal(await tracker.resetBaselineToCurrentState(),false);assert.equal(tracker.getOriginalContent(p),'before');assert.ok(pending(p));assert.equal(JSON.stringify(tracker.revertHistory),oldHistory);
    faults.clear();assert.equal(await tracker.flushPendingPersistence(),true);await tracker.dispose();tracker=new DiffTracker(Uri.file(storage));
    assert.equal(await tracker.restorePersistedState(),'restored');assert.ok(pending(p));assert.equal((await tracker.undoLastRevert()).succeeded,1);assert.equal(disk(q),'q current');
});
for(const transition of ['stop','restart','dispose'])test(`AUDIT-21 ${transition} cancels pending stopped clear without stale rollback`,async()=>{
    const p=file();seed(p,'before','current');await scan(p);const storage=file('storage');tracker.storageUri=Uri.file(storage);tracker.stopRecording();await tracker.flushPendingPersistence();
    const gate=pause(path.join(storage,'session-state.tmp.json'),'write'),op=tracker.resetBaselineToCurrentState();await gate.entered;
    let ending;
    if(transition==='dispose')ending=tracker.dispose();else {tracker.stopRecording();if(transition==='restart'){listedFiles=[Uri.file(p)];tracker.startRecording();}}
    gate.release();assert.equal(await op,false);await ending;
    if(transition==='restart'){await waitUntil(()=>tracker.getBaselineState()==='ready');assert.equal(tracker.getOriginalContent(p),'current');}
    else {assert.equal(tracker.getOriginalContent(p),'before');assert.ok(pending(p));}
    await tracker.flushPendingPersistence();const saved=JSON.parse(disk(path.join(storage,'session-state.json')));
    assert.equal(new Map(saved.fileSnapshots).get(p),transition==='restart'?'current':'before');
});
test('AUDIT-21 stopped clear handles empty, missing, unknown and dirty resources without disk mutation',async()=>{
    const empty=file(),deleted=file(),dirty=file(),unknown=file();seed(empty,'');seed(deleted,'gone');seed(dirty,'before','saved');
    fs.unlinkSync(deleted);await tracker.onExternalFileDeleted(Uri.file(deleted));const doc=document(dirty);doc.text='unsaved';doc.isDirty=true;tracker.processDocumentChange(doc);
    fs.writeFileSync(unknown,Buffer.from([0,1]));await tracker.onExternalFileCreated(Uri.file(unknown));assert.equal(pending(unknown),undefined);
    const storage=file('storage');tracker.storageUri=Uri.file(storage);tracker.stopRecording();assert.equal(await tracker.resetBaselineToCurrentState(),true);
    assert.equal(disk(empty),'');assert.equal(fs.existsSync(deleted),false);assert.equal(disk(dirty),'saved');assert.equal(doc.getText(),'unsaved');assert.equal(doc.isDirty,true);
    const saved=JSON.parse(disk(path.join(storage,'session-state.json')));assert.equal(saved.unresolvedBaselineFiles.length,0);assert.equal(saved.fileSnapshots.length,0);
    await tracker.dispose();tracker=new DiffTracker(Uri.file(storage));assert.equal(await tracker.restorePersistedState(),'restored');assert.equal(tracker.getTrackedChanges().length,0);
});
test('AUDIT-21 blocked recovery cannot be cleared by the ordinary reset command',async()=>{
    const p=file();seed(p,'before','current');await scan(p);tracker.stopRecording();tracker.recoveryBlocked=true;
    assert.equal(await tracker.resetBaselineToCurrentState(),false);assert.equal(tracker.getOriginalContent(p),'before');assert.ok(pending(p));
});
test('DT-06 reset after reverting a new file remains reloadable',async()=>{
    const p=file();fs.writeFileSync(p,'new');await tracker.onExternalFileCreated(Uri.file(p));
    tracker.storageUri=Uri.file(path.join(root,`storage-${index++}`));const storage=tracker.storageUri;
    assert.equal((await tracker.revertFile(p)).status,'conflict');fs.unlinkSync(p);await tracker.onExternalFileDeleted(Uri.file(p));
    const stable=file();seed(stable,'stable');listedFiles=[Uri.file(stable)];
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
for(const phase of ['open','apply']) test(`DT-09 Undo preserves disk changed during ${phase}`,async()=>{
    const p=file();seed(p,'base','changed');await scan(p);
    tracker.storageUri=Uri.file(path.join(root,`storage-${index++}`));
    assert.equal(succeeded(await tracker.revertFile(p)),true);
    const gate=pause(p,phase),operation=tracker.undoLastRevert();await gate.entered;
    fs.writeFileSync(p,'new external work');gate.release();const result=await operation;
    assert.equal(result.succeeded,0);assert.equal(disk(p),'new external work');assert.equal(tracker.revertHistory.length,1);
});
for(const limit of ['maxPersistedSnapshots','maxPersistedBytes']) test(`DT-08 baseline stays blocked when ${limit} is exceeded`,async()=>{
    const p=file();seed(p,'base','changed');await scan(p);
    tracker.storageUri=Uri.file(path.join(root,`storage-${index++}`));tracker[limit]=0;
    tracker.snapshotInitialized=false;tracker.baselineBuilding=true;
    await tracker.initializeWorkspaceSnapshots();assert.equal(tracker.getBaselineState(),'building');
    assert.equal(succeeded(await tracker.keepAllChangesInFile(p)),false);assert.equal(tracker.getOriginalContent(p),'base');
});
for(const building of [false,true]) test(`DT-08 directory watcher events do not create reviews (building=${building})`,async()=>{
    const dir=file('folder');fs.mkdirSync(dir);tracker.snapshotInitialized=!building;tracker.baselineBuilding=building;
    await tracker.onExternalFileCreated(Uri.file(dir));await tracker.onExternalFileChanged(Uri.file(dir));
    await new Promise(resolve=>setTimeout(resolve,150));
    assert.equal(pending(dir),undefined);assert.equal(tracker.unresolvedBaselineFiles.has(dir),false);
    fs.rmdirSync(dir);await tracker.onExternalFileDeleted(Uri.file(dir));assert.equal(pending(dir),undefined);
});
test('DT-08 baseline persistence failure blocks review and a successful retry stores ready',async()=>{
    const p=file();seed(p,'base','changed');await scan(p);
    const storage=path.join(root,`storage-${index++}`),temp=path.join(storage,'session-state.tmp.json');
    tracker.storageUri=Uri.file(storage);tracker.snapshotInitialized=false;tracker.baselineBuilding=true;
    faults.set(temp,{write:error('NoPermissions')});await tracker.initializeWorkspaceSnapshots();
    assert.equal(tracker.getBaselineState(),'building');assert.equal(succeeded(await tracker.keepAllChangesInFile(p)),false);
    faults.delete(temp);await tracker.initializeWorkspaceSnapshots();assert.equal(tracker.getBaselineState(),'ready');
    assert.equal(JSON.parse(fs.readFileSync(path.join(storage,'session-state.json'),'utf8')).baselineState,'ready');
});
test('DT-08 ignoring a directory create still tracks deletion of its baseline children',async()=>{
    const dir=file('folder');fs.mkdirSync(dir);const p=path.join(dir,'child.m');seed(p,'base');
    await tracker.onExternalFileCreated(Uri.file(dir));assert.equal(pending(dir),undefined);
    fs.rmSync(dir,{recursive:true});await tracker.onExternalFileDeleted(Uri.file(dir));
    assert.equal(pending(p)?.isDeleted,true);assert.equal(pending(dir),undefined);
});
test('DT-09 Undo rejects a document refreshed to newer content while opening',async()=>{
    const p=file();seed(p,'base','changed');await scan(p);
    tracker.storageUri=Uri.file(path.join(root,`storage-${index++}`));await tracker.revertFile(p);
    const gate=pause(p,'open'),operation=tracker.undoLastRevert();await gate.entered;
    document(p).text='new editor content';gate.release();assert.equal((await operation).succeeded,0);
    assert.equal(document(p).getText(),'new editor content');assert.equal(disk(p),'base');assert.equal(tracker.revertHistory.length,1);
});
test('DT-08 delayed watcher read cannot erase a newer dirty editor review',async()=>{
    const p=file();seed(p,'base');const doc=document(p),gate=pause(p,'read');
    const operation=scan(p);await gate.entered;doc.text='native Undo content';doc.isDirty=true;doc.version++;
    tracker.processDocumentChange(doc);assert.ok(pending(p));gate.release();await operation;
    assert.ok(pending(p));assert.equal(doc.getText(),'native Undo content');assert.equal(disk(p),'base');
});
for(const baselineState of ['ready','building']) test(`DT-06 zero-file ${baselineState} baseline is valid`,async()=>{
    const storage=path.join(root,`storage-${index++}`);tracker.storageUri=Uri.file(storage);
    tracker.baselineBuilding=baselineState==='building';tracker.snapshotInitialized=!tracker.baselineBuilding;
    assert.equal(await tracker.flushPendingPersistence(),true);
    const restored=new DiffTracker(Uri.file(storage));
    try {assert.equal(await restored.restorePersistedState(),baselineState==='ready'?'restored':'incomplete');assert.equal(restored.isRecoveryBlocked(),false);}
    finally {await restored.dispose();}
    const again=new DiffTracker(Uri.file(storage));
    try {assert.equal(await again.restorePersistedState(),baselineState==='ready'?'restored':'incomplete');}
    finally {await again.dispose();}
});
for(const via of ['create','document']) test(`DT-06 Ready baseline growth via ${via} exceeding limits blocks actions and restart`,async()=>{
    const p=file();seed(p,'base');const storage=path.join(root,`storage-${index++}`);tracker.storageUri=Uri.file(storage);
    await tracker.initializeWorkspaceSnapshots();tracker.maxPersistedSnapshots=1;assert.equal(await tracker.flushPendingPersistence(),true);
    const q=file();fs.writeFileSync(q,'new');
    if(via==='create') await tracker.onExternalFileCreated(Uri.file(q));else tracker.ensureSnapshotForDocument(document(q));
    await tracker.flushPendingPersistence();assert.equal(tracker.getBaselineState(),'building');
    assert.equal(succeeded(await tracker.keepAllChangesInFile(q)),false);assert.equal(disk(q),'new');
    const restored=new DiffTracker(Uri.file(storage));
    try {assert.equal(await restored.restorePersistedState(),'blocked');assert.equal(restored.isRecoveryBlocked(),true);}
    finally {await restored.dispose();}
    assert.ok(fs.existsSync(path.join(storage,'session-state.unsaved')));
});
for(const action of ['file','block']) test(`DT-06 ${action} Keep exceeding byte limit keeps baseline and review`,async()=>{
    const p=file();seed(p,'base','x'.repeat(5000));await scan(p);
    tracker.storageUri=Uri.file(path.join(root,`storage-${index++}`));tracker.maxPersistedBytes=2000;
    assert.equal(await tracker.flushPendingPersistence(),true);
    const result=action==='file'?await tracker.keepAllChangesInFile(p):await tracker.keepBlock(p,tracker.getChangeBlocks(p)[0].blockId);
    assert.equal(succeeded(result),false);assert.equal(tracker.getOriginalContent(p),'base');assert.ok(pending(p));
});
test('DT-06 new-file review stays blocked until its durable snapshot is written',async()=>{
    const storage=path.join(root,`storage-${index++}`);tracker.storageUri=Uri.file(storage);
    const p=file();fs.writeFileSync(p,'new');const gate=pause(path.join(storage,'session-state.tmp.json'),'write');
    const operation=tracker.onExternalFileCreated(Uri.file(p));await gate.entered;
    assert.equal(tracker.getBaselineState(),'building');assert.equal(succeeded(await tracker.keepAllChangesInFile(p)),false);
    gate.release();await operation;assert.equal(tracker.getBaselineState(),'ready');assert.ok(pending(p));
    assert.equal(fs.existsSync(path.join(storage,'session-state.unsaved')),false);
});
for(const action of ['file','block']) test(`DT-06 ${action} Keep preserves edits arriving while persistence waits`,async()=>{
    const p=file();seed(p,'base','reviewed');await scan(p);
    const storage=path.join(root,`storage-${index++}`);tracker.storageUri=Uri.file(storage);
    const gate=pause(path.join(storage,'session-state.tmp.json'),'write');
    const operation=action==='file'?tracker.keepAllChangesInFile(p):tracker.keepBlock(p,tracker.getChangeBlocks(p)[0].blockId);
    await gate.entered;fs.writeFileSync(p,'newer external');gate.release();assert.equal(succeeded(await operation),true);
    assert.equal(tracker.getOriginalContent(p),'reviewed');assert.equal(pending(p)?.currentContent,'newer external');
});
test('DT-08 fresh Start retains startup change evidence while deferring document capture',async()=>{
    const p=file();fs.writeFileSync(p,'before');document(p);listedFiles=[Uri.file(p)];
    const gate=pause(root,'ignoreScan');tracker.startRecording();await gate.entered;
    assert.ok(watcherInstances.some(w=>w.active));
    fs.writeFileSync(p,'external during startup');emitWatcher('change',Uri.file(p));gate.release();
    await waitUntil(()=>tracker.getBaselineState()==='ready');
    assert.equal(tracker.getOriginalContent(p),undefined);assert.ok(pending(p)?.unavailableReason);
    assert.equal(succeeded(await tracker.keepAllChangesInFile(p)),false);assert.equal(disk(p),'external during startup');
});
test('AUDIT-18 fresh Start excludes open documents and startup events after ignore discovery',async()=>{
    watchExclude=['custom-excluded/**'];
    const ignored=['.git','node_modules','out','custom-excluded'].map(dir=>path.join(root,dir,`${index++}.txt`));
    for(const p of ignored){fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,'ignored');document(p);}
    const allowed=file();fs.writeFileSync(allowed,'included');document(allowed);listedFiles=[...ignored,allowed].map(Uri.file);
    const storage=file('storage');tracker.storageUri=Uri.file(storage);
    const gate=pause(root,'ignoreScan');tracker.startRecording();await gate.entered;
    assert.ok(watcherInstances.some(w=>w.active));
    for(const p of ignored){emitWatcher('change',Uri.file(p));tracker.onDocumentChanged({document:document(p)});tracker.onDidSaveDocument(document(p));}
    // A path not present in the open-document list must not become unresolved.
    const created=path.join(root,'node_modules',`${index++}.txt`);fs.writeFileSync(created,'dependency');emitWatcher('create',Uri.file(created));
    gate.release();await waitUntil(()=>tracker.getBaselineState()==='ready');await tracker.flushPendingPersistence();
    assert.equal(tracker.getOriginalContent(allowed),'included');
    const state=JSON.parse(disk(path.join(storage,'session-state.json')));
    for(const p of [...ignored,created]){
        assert.equal(tracker.getOriginalContent(p),undefined);assert.equal(pending(p),undefined);
        assert.equal(state.fileSnapshots.some(([name])=>name===p),false);
        assert.equal(state.unresolvedBaselineFiles.some(([name])=>name===p),false);
    }
});
test('DT-08 fresh Start watcher failure keeps baseline incomplete',async()=>{
    const p=file();fs.writeFileSync(p,'before');document(p);listedFiles=[Uri.file(p)];faults.set(root,{watcher:error('ENOSPC')});
    tracker.startRecording();await new Promise(resolve=>setTimeout(resolve,150));
    assert.equal(tracker.getBaselineState(),'building');assert.equal(tracker.getOriginalContent(p),undefined);
    assert.equal(watcherInstances.some(w=>w.active),false);
});
for(const kind of ['create','change','delete','document','save']) test(`AUDIT-18 included ${kind} during ignore discovery stays unknown after reload`,async()=>{
    const p=file();fs.writeFileSync(p,'before');const doc=document(p);listedFiles=[Uri.file(p)];
    const storage=file('storage');tracker.storageUri=Uri.file(storage);
    const gate=pause(root,'ignoreScan');tracker.startRecording();await gate.entered;
    if(kind==='delete')fs.unlinkSync(p);else fs.writeFileSync(p,'later');
    if(kind==='document'||kind==='save'){
        doc.text='later';doc.version++;doc.isDirty=kind==='document';
        if(kind==='document')tracker.onDocumentChanged({document:doc});else tracker.onDidSaveDocument(doc);
    }else emitWatcher(kind,Uri.file(p));
    gate.release();await waitUntil(()=>tracker.getBaselineState()==='ready');
    assert.equal(tracker.getOriginalContent(p),undefined);assert.ok(pending(p)?.unavailableReason);
    await tracker.flushPendingPersistence();await tracker.dispose();tracker=new DiffTracker(Uri.file(storage));
    assert.equal(await tracker.restorePersistedState(),'restored');assert.equal(tracker.getOriginalContent(p),undefined);assert.ok(pending(p)?.unavailableReason);
});
test('AUDIT-18 ignored startup churn cannot exhaust persistent baseline capacity',async()=>{
    const ignored=path.join(root,'node_modules',`${index++}.txt`);fs.mkdirSync(path.dirname(ignored),{recursive:true});fs.writeFileSync(ignored,'x'.repeat(20000));document(ignored);
    const p=file();fs.writeFileSync(p,'included');listedFiles=[Uri.file(p)];
    const storage=file('storage');tracker.storageUri=Uri.file(storage);tracker.maxPersistedBytes=10000;
    const gate=pause(root,'ignoreScan');tracker.startRecording();await gate.entered;
    for(let i=0;i<200;i++)emitWatcher('change',Uri.file(path.join(root,'node_modules',`${index++}.txt`)));
    gate.release();await waitUntil(()=>tracker.getBaselineState()==='ready');assert.equal(await tracker.flushPendingPersistence(),true);
    await tracker.dispose();tracker=new DiffTracker(Uri.file(storage));assert.equal(await tracker.restorePersistedState(),'restored');assert.equal(tracker.getOriginalContent(p),'included');
});
test('AUDIT-18 cancelled ignore discovery cannot replay paths into a fresh session',async()=>{
    const p=file();fs.writeFileSync(p,'old');document(p);listedFiles=[Uri.file(p)];
    const gate=pause(root,'ignoreScan');tracker.startRecording();await gate.entered;
    emitWatcher('change',Uri.file(p));tracker.stopRecording();fs.writeFileSync(p,'new');document(p).text='new';
    tracker.startRecording();await waitUntil(()=>tracker.getBaselineState()==='ready');gate.release();await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(tracker.getOriginalContent(p),'new');assert.equal(pending(p),undefined);
});
test('AUDIT-18 deleting an open document parent during ignore discovery cannot accept absence',async()=>{
    const dir=file('parent'),p=path.join(dir,'child');fs.mkdirSync(dir);fs.writeFileSync(p,'before');document(p);listedFiles=[];
    const gate=pause(root,'ignoreScan');tracker.startRecording();await gate.entered;
    fs.rmSync(dir,{recursive:true});emitWatcher('delete',Uri.file(dir));gate.release();
    await waitUntil(()=>tracker.getBaselineState()==='ready');assert.equal(tracker.getOriginalContent(p),undefined);assert.ok(pending(p)?.unavailableReason);
});
test('AUDIT-18 refreshing ignore rules retains exclusions until replacement is ready',async()=>{
    const p=path.join(root,'node_modules',`${index++}.txt`);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,'ignored');
    tracker.startRecording();await waitUntil(()=>tracker.getBaselineState()==='ready');
    const gate=pause(root,'ignoreScan'),refresh=tracker.refreshIgnoreMatchers();await gate.entered;
    tracker.onDocumentOpened(document(p));emitWatcher('create',Uri.file(p));gate.release();await refresh;
    assert.equal(tracker.getOriginalContent(p),undefined);assert.equal(pending(p),undefined);
});
test('AUDIT-18 directory creation during ignore discovery cannot accept its children',async()=>{
    const dir=file('new-parent'),p=path.join(dir,'child');listedFiles=[Uri.file(p)];
    const gate=pause(root,'ignoreScan');tracker.startRecording();await gate.entered;
    fs.mkdirSync(dir);fs.writeFileSync(p,'new child');emitWatcher('create',Uri.file(dir));gate.release();
    await waitUntil(()=>tracker.getBaselineState()==='ready');assert.equal(tracker.getOriginalContent(p),undefined);assert.ok(pending(p)?.unavailableReason);
});
for(const resource of ['directory','file']) test(`AUDIT-19 startup transient ${resource} leaves no persistent review entry`,async()=>{
    const p=file('transient'),storage=file('storage');tracker.storageUri=Uri.file(storage);
    const gate=pause(root,'ignoreScan');tracker.startRecording();await gate.entered;
    if(resource==='directory')fs.mkdirSync(p);else fs.writeFileSync(p,'temporary');
    emitWatcher('create',Uri.file(p));emitWatcher('change',Uri.file(p));
    fs.rmSync(p,{recursive:true});emitWatcher('delete',Uri.file(p));gate.release();
    await waitUntil(()=>tracker.getBaselineState()==='ready');assert.equal(pending(p),undefined);
    assert.equal(await tracker.flushPendingPersistence(),true);
    const saved=JSON.parse(disk(path.join(storage,'session-state.json')));
    assert.equal(saved.unresolvedBaselineFiles.some(([name])=>name===p),false);
    await tracker.dispose();tracker=new DiffTracker(Uri.file(storage));assert.equal(await tracker.restorePersistedState(),'restored');assert.equal(pending(p),undefined);
});
for(const kinds of [
    ['create','delete','create'], ['delete','create','delete'], ['change','create','delete'], ['delete']
]) test(`AUDIT-19 startup ${kinds.join('-')} preserves unresolved evidence`,async()=>{
    const p=file();fs.writeFileSync(p,'before');
    const gate=pause(root,'ignoreScan');tracker.startRecording();await gate.entered;
    for(const kind of kinds){if(kind==='delete')fs.rmSync(p,{force:true});else fs.writeFileSync(p,'current');emitWatcher(kind,Uri.file(p));}
    gate.release();await waitUntil(()=>tracker.getBaselineState()==='ready');
    assert.equal(tracker.getOriginalContent(p),undefined);assert.ok(pending(p)?.unavailableReason);
});
test('AUDIT-19 multiple completed startup incarnations leave no review entry',async()=>{
    const p=file();const gate=pause(root,'ignoreScan');tracker.startRecording();await gate.entered;
    for(let i=0;i<2;i++){fs.writeFileSync(p,'temporary');emitWatcher('create',Uri.file(p));fs.unlinkSync(p);emitWatcher('delete',Uri.file(p));}
    gate.release();await waitUntil(()=>tracker.getBaselineState()==='ready');assert.equal(pending(p),undefined);
});
for(const mode of ['preexisting','dirty','clean']) test(`AUDIT-19 transient path respects ${mode} document evidence`,async()=>{
    const p=file();if(mode==='preexisting'){fs.writeFileSync(p,'before');document(p);}
    const gate=pause(root,'ignoreScan');tracker.startRecording();await gate.entered;
    fs.writeFileSync(p,'temporary');emitWatcher('create',Uri.file(p));const doc=document(p);doc.isDirty=mode==='dirty';
    fs.unlinkSync(p);emitWatcher('delete',Uri.file(p));gate.release();
    await waitUntil(()=>tracker.getBaselineState()==='ready');
    if(mode==='clean'){assert.equal(pending(p),undefined);assert.equal(tracker.getOriginalContent(p),undefined);}
    else {assert.ok(pending(p)?.unavailableReason);assert.equal(tracker.getOriginalContent(p),undefined);}
});
test('AUDIT-19 inability to stat a create-delete path never proves absence',async()=>{
    const p=file();const gate=pause(root,'ignoreScan');tracker.startRecording();await gate.entered;
    fs.writeFileSync(p,'temporary');emitWatcher('create',Uri.file(p));fs.unlinkSync(p);emitWatcher('delete',Uri.file(p));faults.set(p,{stat:error('NoPermissions')});
    gate.release();await waitUntil(()=>tracker.getBaselineState()==='ready');assert.ok(pending(p)?.unavailableReason);
});
test('AUDIT-19 deletion during another path classification retains the earlier create event',async()=>{
    const p=file(),q=file();fs.writeFileSync(q,'before');
    const gate=pause(root,'ignoreScan');tracker.startRecording();await gate.entered;
    fs.writeFileSync(p,'temporary');emitWatcher('create',Uri.file(p));emitWatcher('change',Uri.file(q));
    const statGate=pause(q,'stat');gate.release();await statGate.entered;
    fs.unlinkSync(p);emitWatcher('delete',Uri.file(p));statGate.release();
    await waitUntil(()=>tracker.getBaselineState()==='ready');assert.equal(pending(p),undefined);assert.ok(pending(q)?.unavailableReason);
});
test('AUDIT-19 recreation during classification invalidates transient cancellation',async()=>{
    const p=file();const gate=pause(root,'ignoreScan');tracker.startRecording();await gate.entered;
    fs.writeFileSync(p,'temporary');emitWatcher('create',Uri.file(p));fs.unlinkSync(p);emitWatcher('delete',Uri.file(p));
    const statGate=pause(p,'stat');gate.release();await statGate.entered;
    fs.writeFileSync(p,'survivor');emitWatcher('create',Uri.file(p));statGate.release();
    await waitUntil(()=>tracker.getBaselineState()==='ready');assert.ok(pending(p)?.unavailableReason);assert.equal(disk(p),'survivor');assert.equal(tracker.getOriginalContent(p),undefined);
});
test('AUDIT-19 stopped classifier cannot publish into restarted session',async()=>{
    const p=file();const gate=pause(root,'ignoreScan');tracker.startRecording();await gate.entered;
    fs.writeFileSync(p,'temporary');emitWatcher('create',Uri.file(p));const statGate=pause(p,'stat');gate.release();await statGate.entered;
    tracker.stopRecording();listedFiles=[Uri.file(p)];fs.writeFileSync(p,'new baseline');tracker.startRecording();
    await waitUntil(()=>tracker.getBaselineState()==='ready');statGate.release();await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(tracker.getOriginalContent(p),'new baseline');assert.equal(pending(p),undefined);
});
test('AUDIT-19 parent and child transient events leave no stale entries from enumeration',async()=>{
    const dir=file('parent'),p=path.join(dir,'child');listedFiles=[Uri.file(p)];
    const gate=pause(root,'ignoreScan');tracker.startRecording();await gate.entered;
    fs.mkdirSync(dir);emitWatcher('create',Uri.file(dir));fs.writeFileSync(p,'temporary');emitWatcher('create',Uri.file(p));
    fs.rmSync(dir,{recursive:true});emitWatcher('delete',Uri.file(p));emitWatcher('delete',Uri.file(dir));gate.release();
    await waitUntil(()=>tracker.getBaselineState()==='ready');assert.equal(pending(p),undefined);assert.equal(pending(dir),undefined);
});
test('AUDIT-19 transient parent evidence never hides a pre-existing open child',async()=>{
    const dir=file('parent'),p=path.join(dir,'child');fs.mkdirSync(dir);fs.writeFileSync(p,'before');document(p);
    const gate=pause(root,'ignoreScan');tracker.startRecording();await gate.entered;
    emitWatcher('create',Uri.file(dir));fs.rmSync(dir,{recursive:true});emitWatcher('delete',Uri.file(dir));gate.release();
    await waitUntil(()=>tracker.getBaselineState()==='ready');assert.equal(pending(dir),undefined);assert.ok(pending(p)?.unavailableReason);assert.equal(tracker.getOriginalContent(p),undefined);
});
test('DT-08 Stop during initial ignore discovery prevents late watcher or Ready publication',async()=>{
    const gate=pause(root,'ignoreScan');tracker.startRecording();await gate.entered;tracker.stopRecording();gate.release();
    await new Promise(resolve=>setTimeout(resolve,150));assert.equal(tracker.getIsRecording(),false);
    assert.equal(watcherInstances.some(w=>w.active),false);assert.notEqual(tracker.getBaselineState(),'ready');
});
test('DT-04 batch Revert preserves new files while reverting existing files',async()=>{
    const p=file(),q=file();seed(p,'base','changed');await scan(p);fs.writeFileSync(q,'new');await tracker.onExternalFileCreated(Uri.file(q));
    const result=await tracker.revertAllChanges();assert.equal(result.succeeded,1);assert.equal(result.failed,1);
    assert.equal(disk(p),'base');assert.equal(disk(q),'new');assert.ok(pending(q));
});
for(const action of ['revert','undo']) for(const transition of ['branch','operation']) test(`DT-07 block ${action} retains recovery when ${transition} pauses during apply`,async()=>{
    const p=file();seed(p,'base\n','changed\n');await scan(p);
    const context={repoRoot:root,kind:'repository',headName:'main',headCommit:'aaa',detached:false,inProgress:false};
    tracker.setBaselineGitContexts([context]);const block=tracker.getChangeBlocks(p)[0];
    if(action==='undo') assert.ok(succeeded(await tracker.revertBlock(p,block.blockId)));
    const gate=pause(p,'apply'),operation=action==='undo'?tracker.undoLastRevert():tracker.revertBlock(p,block.blockId);
    await gate.entered;tracker.observeGitContext({...context,...(transition==='branch'?{headName:'other'}:{inProgress:true})});gate.release();
    const outcome=await operation,result=action==='undo'?outcome.results[0]:outcome;
    assert.equal(result.status,'conflict');assert.equal(result.bufferChanged,true);assert.equal(tracker.revertHistory.length,1);
    assert.equal(disk(p),'changed\n');assert.equal(document(p).isDirty,true);
});
for(const action of ['revert','undo']) test(`DT-08 late block ${action} completion cannot mutate new-session review or flags`,async()=>{
    const p=file();seed(p,'base\n','changed\n');await scan(p);const block=tracker.getChangeBlocks(p)[0];
    if(action==='undo') await tracker.revertBlock(p,block.blockId);
    const gate=pause(p,'apply'),operation=action==='undo'?tracker.undoLastRevert():tracker.revertBlock(p,block.blockId);
    await gate.entered;tracker.advanceEpoch();tracker.fileSnapshots.set(p,'new baseline');tracker.updateTrackedDiff(p,'new pending');
    tracker.pendingWriteFiles.add(p);tracker.activeWriteFiles.add(p);const current=pending(p);
    gate.release();const outcome=await operation,result=action==='undo'?outcome.results[0]:outcome;
    assert.notEqual(result.status,'success');assert.equal(result.bufferChanged,true);
    assert.equal(pending(p),current);assert.equal(tracker.pendingWriteFiles.has(p),true);assert.equal(tracker.activeWriteFiles.has(p),true);
});
test('DT-04 block Revert revalidates after recovery persistence before touching newer editor content',async()=>{
    const p=file();seed(p,'base\n','changed\n');await scan(p);const block=tracker.getChangeBlocks(p)[0];
    const storage=path.join(root,`storage-${index++}`);tracker.storageUri=Uri.file(storage);
    const gate=pause(path.join(storage,'session-state.tmp.json'),'write'),before=counters.apply;
    const operation=tracker.revertBlock(p,block.blockId);await gate.entered;
    const doc=document(p);doc.text='new editor work';doc.isDirty=true;doc.version++;gate.release();
    assert.equal((await operation).status,'conflict');assert.equal(counters.apply,before);assert.equal(doc.getText(),'new editor work');
});
test('DT-09 buffer Undo retains recovery if baseline changes during apply',async()=>{
    const p=file();seed(p,'base\n','changed\n');await scan(p);await tracker.revertBlock(p,tracker.getChangeBlocks(p)[0].blockId);
    const gate=pause(p,'apply'),operation=tracker.undoLastRevert();await gate.entered;
    tracker.fileSnapshots.set(p,'replacement baseline');gate.release();const result=(await operation).results[0];
    assert.equal(result.status,'conflict');assert.equal(result.bufferChanged,true);assert.equal(tracker.revertHistory.length,1);
    assert.equal(tracker.getOriginalContent(p),'replacement baseline');assert.equal(disk(p),'changed\n');
});
test('DT-09 buffer Undo reports changed buffer when applyEdit throws after mutation',async()=>{
    const p=file();seed(p,'base\n','changed\n');await scan(p);await tracker.revertBlock(p,tracker.getChangeBlocks(p)[0].blockId);
    faults.set(p,{afterApply:error('after edit')});const result=(await tracker.undoLastRevert()).results[0];
    assert.equal(result.status,'failed');assert.equal(result.bufferChanged,true);assert.equal(tracker.revertHistory.length,1);
    assert.equal(disk(p),'changed\n');assert.equal(document(p).isDirty,true);
});
test('DT-09 old recovery cleanup cannot remove a new-session record with the same ID',async()=>{
    const p=file();seed(p,'base','changed');await scan(p);await tracker.revertBlock(p,tracker.getChangeBlocks(p)[0].blockId);
    const old=tracker.revertHistory[0],replacement={...old,items:[...old.items]};tracker.advanceEpoch();tracker.revertHistory=[replacement];
    await tracker.removeRevertRecord(old);assert.equal(tracker.revertHistory[0],replacement);
});
for(const phase of ['save','publish','afterPublish']) for(const change of ['branch','operation']) test(`DT-07 file Revert retains review on ${change} during ${phase}`,async()=>{
    const p=file();seed(p,'base','changed');if(phase!=='save')fs.unlinkSync(p);await scan(p);
    const context={repoRoot:root,kind:'repository',headName:'main',headCommit:'aaa',detached:false,inProgress:false};tracker.setBaselineGitContexts([context]);
    const gate=pause(p,phase),operation=tracker.revertFile(p);await gate.entered;
    tracker.observeGitContext({...context,...(change==='branch'?{headName:'other'}:{inProgress:true})});gate.release();const result=await operation;
    assert.equal(result.status,'conflict');assert.equal(result.bufferChanged,true);assert.equal(tracker.revertHistory.length,1);assert.ok(pending(p));
    if(phase!=='save')assert.equal(disk(p),'base');
});
for(const version of [1,2]) test(`DT-07 only actual V1 restoration adopts initial Git context (V${version})`,async()=>{
    const p=file();seed(p,'base','changed');const storage=path.join(root,`storage-${index++}`);fs.mkdirSync(storage);
    fs.writeFileSync(path.join(storage,'session-state.json'),JSON.stringify({version,isRecording:true,baselineState:'ready',workspaceRoots:[root],fileSnapshots:[[p,'base']],baselineExistingFiles:[p],unresolvedBaselineFiles:[],revertHistory:[],gitContexts:[]}));
    tracker.storageUri=Uri.file(storage);assert.equal(await tracker.restorePersistedState(),'restored');
    tracker.reconcileRestoredGitContexts([{repoRoot:root,kind:'repository',headName:'main',headCommit:'aaa',detached:false,inProgress:false}]);
    assert.equal(!!tracker.getGitPauseReason(p),version===2);assert.equal(succeeded(await tracker.keepAllChangesInFile(p)),version===1);
});
for(const phase of ['publish','afterPublish']) test(`DT-07 Undo recreation retains recovery on Git pause during ${phase}`,async()=>{
    const p=file();fs.writeFileSync(p,'reviewed');await tracker.onExternalFileCreated(Uri.file(p));
    await tracker.prepareRevertRecord([tracker.createFileRevertItem(p)]);fs.unlinkSync(p);
    const context={repoRoot:root,kind:'repository',headName:'main',headCommit:'aaa',detached:false,inProgress:false};tracker.setBaselineGitContexts([context]);
    const gate=pause(p,phase),operation=tracker.undoLastRevert();await gate.entered;tracker.observeGitContext({...context,headName:'other'});gate.release();
    const result=(await operation).results[0];assert.equal(result.status,'conflict');assert.equal(result.bufferChanged,true);assert.equal(tracker.revertHistory.length,1);
    assert.equal(disk(p),'reviewed');
});
test('DT-07 V1 migration adoption cannot be reused for a later appearing repository',async()=>{
    const p=file(),storage=path.join(root,`storage-${index++}`);seed(p,'base');fs.mkdirSync(storage);
    fs.writeFileSync(path.join(storage,'session-state.json'),JSON.stringify({version:1,isRecording:true,fileSnapshots:[[p,'base']],baselineExistingFiles:[p]}));
    tracker.storageUri=Uri.file(storage);await tracker.restorePersistedState();tracker.reconcileRestoredGitContexts([]);
    tracker.reconcileRestoredGitContexts([{repoRoot:root,kind:'repository',headName:'main',headCommit:'aaa',detached:false,inProgress:false}]);
    assert.ok(tracker.getGitPauseReason(p));
});
for(const mixed of [false,true]) test(`DT-06 unsupported workspace scan round-trips safely (mixed=${mixed})`,async()=>{
    const folders=vscode.workspace.workspaceFolders, findFiles=vscode.workspace.findFiles;
    const remote=Uri.file(path.join(root,'virtual','remote.txt'));remote.scheme='vscode-remote';
    const virtualFolder={uri:Uri.file(path.join(root,'virtual')),name:'virtual'};virtualFolder.uri.scheme='vscode-remote';
    const local=file();fs.writeFileSync(local,'local baseline');
    const scanned=[];
    try {
        vscode.workspace.workspaceFolders=mixed?[...folders,virtualFolder]:[virtualFolder];
        vscode.workspace.findFiles=async pattern=>{
            scanned.push(pattern.base.uri.scheme);
            return pattern.pattern==='**/*'?(pattern.base.uri.scheme==='file'?[Uri.file(local),remote]:[remote]):[];
        };
        await tracker.dispose();const storage=path.join(root,`storage-${index++}`);tracker=new DiffTracker(Uri.file(storage));
        tracker.isRecording=true;tracker.baselineBuilding=true;tracker.snapshotInitialized=false;
        tracker.activateExternalWatchers(tracker.createExternalWatchers(tracker.sessionEpoch));
        await tracker.initializeWorkspaceSnapshots();await tracker.flushPendingPersistence();
        const saved=JSON.parse(fs.readFileSync(path.join(storage,'session-state.json'),'utf8'));
        assert.ok(tracker.parsePersistedState(saved),'writer must produce restorable state');
        assert.deepEqual(saved.unresolvedBaselineFiles,[]);
        assert.deepEqual(saved.fileSnapshots,mixed?[[local,'local baseline']]:[]);
        assert.ok(scanned.every(scheme=>scheme==='file'),'do not query unsupported folders');
        assert.equal(tracker.fileWatchers.length,mixed?1:0);
        await tracker.dispose();tracker=new DiffTracker(Uri.file(storage));
        assert.equal(await tracker.restorePersistedState(),'restored');
        assert.equal(tracker.isRecoveryBlocked(),false);
        if(mixed){fs.writeFileSync(local,'changed');await scan(local);assert.equal(pending(local)?.currentContent,'changed');}
    } finally {await tracker.dispose();vscode.workspace.workspaceFolders=folders;vscode.workspace.findFiles=findFiles;}
});
test('DT-06 non-file events cannot mutate a same-path local review',async()=>{
    const p=file();seed(p,'base','changed');await scan(p);const before=pending(p);
    const uri=Uri.file(p);uri.scheme='virtual';
    await tracker.onExternalFileCreated(uri);await tracker.onExternalFileChanged(uri);await tracker.onExternalFileDeleted(uri);
    tracker.onDocumentOpened({uri,getText:()=> 'virtual contents'});
    assert.equal(pending(p),before);assert.equal(tracker.getOriginalContent(p),'base');
});
for(const kind of ['binary','bom','oversized','unreadable','missing','all-unsupported']) test(`DT-07 rebuild persists unresolved ${kind} files without blocking supported files`,async()=>{
    const repo=file('repo');fs.mkdirSync(repo);const p=path.join(repo,'unsupported.dat'),q=path.join(repo,'text.m');
    seed(q,'old','new baseline');fs.writeFileSync(p,kind==='bom'?Buffer.from([0xef,0xbb,0xbf,65]):kind==='binary'||kind==='all-unsupported'?Buffer.from([0,1,2]):'data');
    if(kind==='oversized')faults.set(p,{size:6*1024*1024});
    if(kind==='unreadable')faults.set(p,{read:error('NoPermissions')});
    if(kind==='missing')fs.unlinkSync(p);
    const base={repoRoot:repo,kind:'repository',headName:'main',headCommit:'aaa',detached:false,inProgress:false};
    const current={...base,headName:'feature',headCommit:'bbb'};tracker.setBaselineGitContexts([base]);tracker.observeGitContext(current);
    const storage=path.join(root,`storage-${index++}`);tracker.storageUri=Uri.file(storage);
    listedFiles=kind==='all-unsupported'?[Uri.file(p)]:[Uri.file(p),Uri.file(q)];
    assert.equal(await tracker.rebuildRepositoryBaseline(repo,current),true);
    const binary=kind==='binary'||kind==='all-unsupported';
    assert.equal(tracker.getGitPauseReason(p),undefined);
    if(binary)assert.equal(pending(p),undefined);else assert.ok(pending(p)?.unavailableReason);
    assert.equal(tracker.getReviewToken(p),undefined);assert.equal(tracker.getOriginalContent(p),undefined);
    const saved=JSON.parse(fs.readFileSync(path.join(storage,'session-state.json'),'utf8'));
    assert.ok(saved.unresolvedBaselineFiles.some(([f])=>f===p));assert.ok(tracker.parsePersistedState(saved));
    await tracker.dispose();tracker=new DiffTracker(Uri.file(storage));assert.equal(await tracker.restorePersistedState(),'restored');
    tracker.reconcileRestoredGitContexts([current]);
    if(binary)assert.equal(pending(p),undefined);else assert.ok(pending(p)?.unavailableReason);
    assert.equal(tracker.getReviewToken(p),undefined);
    assert.equal(succeeded(await tracker.revertFile(p)),false);
    if(kind!=='all-unsupported'){assert.equal(tracker.getOriginalContent(q),'new baseline');fs.writeFileSync(q,'later change');await scan(q);assert.equal(succeeded(await tracker.keepAllChangesInFile(q)),true);}
});
for(const firstBlock of [false,true]) for(const secondBlock of [false,true]) test(`DT-06 Keep transactions serialize across files (${firstBlock}/${secondBlock})`,async()=>{
    const p=file(),q=file();for(const f of [p,q]){seed(f,'old\n','new\n');await scan(f);}
    const storage=path.join(root,`storage-${index++}`);tracker.storageUri=Uri.file(storage);await tracker.flushPendingPersistence();
    const firstToken=tracker.getReviewToken(p),secondToken=tracker.getReviewToken(q);
    const firstId=tracker.getChangeBlocks(p)[0].blockId,secondId=tracker.getChangeBlocks(q)[0].blockId;
    const gate=pause(p,'read'),secondGate=pause(q,'read');
    const one=firstBlock?tracker.keepBlock(p,firstId,firstToken):tracker.keepAllChangesInFile(p,firstToken);
    await gate.entered;
    const two=secondBlock?tracker.keepBlock(q,secondId,secondToken):tracker.keepAllChangesInFile(q,secondToken);
    await new Promise(r=>setTimeout(r,20));
    const serialized=barriers.has(`${q}:read`);secondGate.release();
    faults.set(path.join(storage,'session-state.tmp.json'),{write:error('NoPermissions')});gate.release();
    const results=await Promise.all([one,two]);assert.equal(serialized,true,'second transaction must not enter while first is active');
    assert.equal(results[0].status,'failed');assert.equal(succeeded(results[1]),false);
    faults.clear();assert.equal(await tracker.completeBaseline(tracker.sessionEpoch),true);
    assert.equal(succeeded(secondBlock?await tracker.keepBlock(q,secondId):await tracker.keepAllChangesInFile(q)),true);
    await tracker.dispose();tracker=new DiffTracker(Uri.file(storage));assert.equal(await tracker.restorePersistedState(),'restored');
    assert.equal(tracker.getOriginalContent(p),'old\n');assert.ok(pending(p));assert.equal(tracker.getOriginalContent(q),'new\n');
});
for(const undo of [false,true]) for(const replacement of ['file','symlink']) test(`DT-09 exclusive creation preserves concurrent ${replacement} (undo=${undo})`,async()=>{
    const p=file();seed(p,'baseline','reviewed');await scan(p);
    if(undo)await tracker.prepareRevertRecord([tracker.createFileRevertItem(p)]);
    fs.unlinkSync(p);await scan(p);
    if(undo){tracker.revertHistory[0].items[0].after={exists:false,content:''};}
    const gate=pause(p,'publish');const operation=undo?tracker.undoLastRevert():tracker.revertFile(p);await gate.entered;
    const target=file();fs.writeFileSync(target,'external bytes');
    if(replacement==='symlink')fs.symlinkSync(target,p);else fs.writeFileSync(p,'external bytes');
    gate.release();const raw=await operation;const result=undo?raw.results[0]:raw;
    assert.equal(result.status,'conflict');assert.equal(disk(p),'external bytes');assert.equal(disk(target),'external bytes');
    if(undo)assert.equal(tracker.revertHistory.length,1);else assert.ok(pending(p));
});
for(const block of [false,true]) for(const transition of ['stop','dispose','restart']) test(`DT-06 Keep rollback survives ${transition} (block=${block})`,async()=>{
    const p=file();seed(p,'base\n','pending\n');await scan(p);
    const storage=path.join(root,`storage-${index++}`);tracker.storageUri=Uri.file(storage);await tracker.flushPendingPersistence();
    const gate=pause(path.join(storage,'session-state.tmp.json'),'write');
    const action=block?tracker.keepBlock(p,tracker.getChangeBlocks(p)[0].blockId):tracker.keepAllChangesInFile(p);
    await gate.entered;let ending;
    if(transition==='dispose')ending=tracker.dispose();else {tracker.stopRecording();if(transition==='restart')tracker.startRecording();}
    if(transition!=='restart')assert.equal(tracker.getOriginalContent(p),'base\n','rollback precedes transition persistence');
    gate.release();assert.equal(succeeded(await action),false);if(ending)await ending;
    if(transition!=='dispose')await tracker.flushPendingPersistence();
    if(transition==='restart'){assert.notEqual(tracker.getOriginalContent(p),'base\n','old action must not overwrite fresh baseline');return;}
    await tracker.dispose();tracker=new DiffTracker(Uri.file(storage));assert.equal(await tracker.restorePersistedState(),'restored');
    assert.equal(tracker.getOriginalContent(p),'base\n');assert.ok(pending(p));
});
for(const fail of [false,true]) for(const block of [false,true]) test(`DT-09 Keep prunes history transactionally (block=${block}, fail=${fail})`,async()=>{
    const p=file(),q=file();for(const f of [p,q]){seed(f,'base\n','edit\n');await scan(f);}
    const storage=path.join(root,`storage-${index++}`);tracker.storageUri=Uri.file(storage);
    await tracker.revertFile(q);await tracker.revertFile(p);
    fs.writeFileSync(p,'accepted\n');document(p).text='accepted\n';await scan(p);
    const oldHistory=JSON.stringify(tracker.revertHistory);
    if(fail)faults.set(path.join(storage,'session-state.tmp.json'),{write:error('NoPermissions')});
    const result=block?await tracker.keepBlock(p,tracker.getChangeBlocks(p)[0].blockId):await tracker.keepAllChangesInFile(p);
    if(fail){assert.equal(result.status,'failed');assert.equal(JSON.stringify(tracker.revertHistory),oldHistory);faults.clear();return;}
    assert.equal(result.status,'success');assert.equal(tracker.revertHistory.some(r=>r.items.some(i=>i.filePath===p)),false);
    await tracker.dispose();tracker=new DiffTracker(Uri.file(storage));assert.equal(await tracker.restorePersistedState(),'restored');
    assert.equal((await tracker.undoLastRevert()).succeeded,1);assert.equal(disk(q),'edit\n');
});
for(const stop of [false,true]) test(`DT-07 failed long rebuild never persists a partial candidate (stop=${stop})`,async()=>{
    const repo=file('repo');fs.mkdirSync(repo);const p=path.join(repo,'text'),binary=path.join(repo,'image');seed(p,'old','new');fs.writeFileSync(binary,Buffer.from([0,1]));await scan(p);
    const base={repoRoot:repo,kind:'repository',headName:'main',headCommit:'aaa',detached:false,inProgress:false},next={...base,headName:'next'};
    tracker.setBaselineGitContexts([base]);tracker.observeGitContext(next);
    const storage=path.join(root,`storage-${index++}`);tracker.storageUri=Uri.file(storage);await tracker.flushPendingPersistence();
    listedFiles=[Uri.file(binary),Uri.file(p)];const gate=pause(p,'read');const rebuild=tracker.rebuildRepositoryBaseline(repo,next);await gate.entered;
    await waitUntil(()=>tracker.unresolvedBaselineFiles.has(binary));await new Promise(r=>setTimeout(r,350));
    const saved=JSON.parse(fs.readFileSync(path.join(storage,'session-state.json'),'utf8'));
    assert.ok(saved.fileSnapshots.some(([f,c])=>f===p&&c==='old'));assert.equal(saved.baselineState,'ready');
    if(stop)tracker.stopRecording();else tracker.observeGitContext({...base,headName:'third'});
    gate.release();assert.equal(await rebuild,false);await tracker.flushPendingPersistence();await tracker.dispose();
    tracker=new DiffTracker(Uri.file(storage));assert.equal(await tracker.restorePersistedState(),'restored');assert.equal(tracker.getOriginalContent(p),'old');assert.ok(pending(p));
});
for(const mode of [0o644,0o755]) for(const undo of [false,true]) test(`DT-09 POSIX mode round-trip ${mode.toString(8)} (undo=${undo})`,async()=>{
    if(process.platform==='win32')return;
    const p=file();fs.writeFileSync(p,'baseline');fs.chmodSync(p,mode);listedFiles=[Uri.file(p)];
    const storage=path.join(root,`storage-${index++}`);tracker.storageUri=Uri.file(storage);await tracker.initializeWorkspaceSnapshots();
    if(undo){fs.writeFileSync(p,'before revert');await scan(p);const item=tracker.createFileRevertItem(p);item.after={exists:false,content:''};await tracker.prepareRevertRecord([item]);}
    fs.unlinkSync(p);await scan(p);await tracker.flushPendingPersistence();await tracker.dispose();
    tracker=new DiffTracker(Uri.file(storage));assert.equal(await tracker.restorePersistedState(),'restored');
    const result=undo?(await tracker.undoLastRevert()).results[0]:await tracker.revertFile(p);
    assert.equal(result.status,'success',result.reason);assert.equal(fs.statSync(p).mode&0o777,mode);
});
test('DT-09 Keep preserves other members of a batch recovery record',async()=>{
    const p=file(),q=file();for(const f of [p,q]){seed(f,'base\n','edit\n');await scan(f);}
    assert.equal((await tracker.revertAllChanges()).succeeded,2);assert.equal(tracker.revertHistory.length,1);
    fs.writeFileSync(p,'accepted\n');document(p).text='accepted\n';await scan(p);assert.equal(succeeded(await tracker.keepAllChangesInFile(p)),true);
    assert.deepEqual(tracker.revertHistory[0].items.map(i=>i.filePath),[q]);assert.equal((await tracker.undoLastRevert()).succeeded,1);
    assert.equal(disk(p),'accepted\n');assert.equal(disk(q),'edit\n');
});
test('DT-06 mode metadata rejects malformed values and accepts legacy omission',async()=>{
    const p=file();seed(p,'base');tracker.storageUri=Uri.file(path.join(root,`storage-${index++}`));
    const saved=tracker.buildPersistedState();delete saved.fileModes;assert.ok(tracker.parsePersistedState(saved));
    for(const mode of [-1,0o1000,1.5,'755'])assert.equal(tracker.parsePersistedState({...saved,fileModes:[[p,mode]]}),undefined);
    assert.equal(tracker.parsePersistedState({...saved,fileModes:[[p,0o755],[p,0o644]]}),undefined);
});
test('AUDIT-1 writer rejects unresolved entries beyond its reader limit',async()=>{
    const p=file();seed(p,'base');const storage=file('storage');tracker.storageUri=Uri.file(storage);
    assert.equal(await tracker.flushPendingPersistence(),true);
    const previous=disk(path.join(storage,'session-state.json'));
    for(let i=0;i<10001;i++)tracker.unresolvedBaselineFiles.set(path.join(root,`unsupported-${i}`),'unavailable');
    assert.equal(await tracker.flushPendingPersistence(),false);
    assert.equal(disk(path.join(storage,'session-state.json')),previous);
    assert.ok(tracker.parsePersistedState(JSON.parse(previous)));
});
test('AUDIT-2 parent rebuild preserves child repository baseline and history',async()=>{
    const repo=file('repo'),child=path.join(repo,'child');fs.mkdirSync(child,{recursive:true});
    const p=path.join(repo,'parent.txt'),q=path.join(child,'child.txt');seed(p,'parent base','parent edit');seed(q,'child base','child edit');await scan(p);await scan(q);
    const base={repoRoot:repo,kind:'repository',headName:'main',headCommit:'aaa',detached:false,inProgress:false};
    const nested={...base,repoRoot:child},next={...base,headName:'next',headCommit:'bbb'};
    tracker.setBaselineGitContexts([base,nested]);tracker.observeGitContext(next);
    tracker.storageUri=Uri.file(file('storage'));listedFiles=[Uri.file(p),Uri.file(q)];
    assert.equal(await tracker.rebuildRepositoryBaseline(repo,next),true);
    assert.equal(tracker.getOriginalContent(q),'child base');assert.ok(pending(q));
    tracker.observeGitContext({...next,headName:'third'});assert.equal(tracker.getGitPauseReason(q),undefined);
});
for(const block of [false,true]) test(`AUDIT-3 Git pause during Keep rejects acceptance (block=${block})`,async()=>{
    const p=file();seed(p,'base\n','edit\n');await scan(p);
    const base={repoRoot:root,kind:'repository',headName:'main',headCommit:'aaa',detached:false,inProgress:false};tracker.setBaselineGitContexts([base]);
    const storage=file('storage');tracker.storageUri=Uri.file(storage);await tracker.flushPendingPersistence();
    const gate=pause(path.join(storage,'session-state.tmp.json'),'write');
    const op=block?tracker.keepBlock(p,tracker.getChangeBlocks(p)[0].blockId):tracker.keepAllChangesInFile(p);
    await gate.entered;tracker.observeGitContext({...base,headName:'other',headCommit:'bbb'});gate.release();
    assert.equal(succeeded(await op),false);assert.equal(tracker.getOriginalContent(p),'base\n');assert.ok(pending(p));
    await tracker.flushPendingPersistence();assert.equal(new Map(JSON.parse(disk(path.join(storage,'session-state.json'))).fileSnapshots).get(p),'base\n');
});
test('AUDIT-4 restored watcher covers writes during reconciliation',async()=>{
    const p=file(),q=file();seed(p,'base');seed(q,'base');const storage=file('storage');tracker.storageUri=Uri.file(storage);await tracker.flushPendingPersistence();await tracker.dispose();
    tracker=new DiffTracker(Uri.file(storage));const gate=pause(q,'read');const restore=tracker.restorePersistedState();await gate.entered;
    fs.writeFileSync(p,'external');emitWatcher('change',Uri.file(p));gate.release();assert.equal(await restore,'restored');
    await new Promise(r=>setTimeout(r,180));assert.equal(pending(p)?.currentContent,'external');
});
test('AUDIT-5 binary new file remains excluded from text review after restart',async()=>{
    const p=file(),q=file();seed(p,'base');fs.writeFileSync(q,Buffer.from([0,1,2]));await tracker.onExternalFileCreated(Uri.file(q));assert.equal(pending(q),undefined);
    const storage=file('storage');tracker.storageUri=Uri.file(storage);await tracker.flushPendingPersistence();await tracker.dispose();
    tracker=new DiffTracker(Uri.file(storage));assert.equal(await tracker.restorePersistedState(),'restored');assert.equal(pending(q),undefined);
});
test('AUDIT-6 failed old recovery preparation cannot resurrect old history',async()=>{
    const p=file(),q=file();for(const f of [p,q]){seed(f,'base','edit');await scan(f);}await tracker.revertFile(q);
    const storage=file('storage');tracker.storageUri=Uri.file(storage);await tracker.flushPendingPersistence();
    const temp=path.join(storage,'session-state.tmp.json'),gate=pause(temp,'write');const op=tracker.revertFile(p);await gate.entered;
    tracker.stopRecording();tracker.startRecording();faults.set(temp,{rename:error('NoPermissions')});gate.release();await op;faults.clear();
    assert.equal(tracker.revertHistory.length,0);
});
for(const [entry,transition,phase] of [
    ['file','stop','write'],['block','stop','write'],['batch','stop','write'],
    ['file','dispose','rename'],['block','dispose','copy'],['batch','stop','afterDelete']
]) test(`AUDIT-18 ${transition} during ${entry} recovery ${phase} preserves all ten valid Undo records`,async()=>{
    const oldFiles=[];
    for(let i=0;i<10;i++){const p=file();oldFiles.push(p);seed(p,'base\n','edit\n');await scan(p);assert.ok(succeeded(await tracker.revertFile(p)));}
    const p=file();seed(p,'base\n','edit\n');await scan(p);
    const storage=file('storage');tracker.storageUri=Uri.file(storage);await tracker.flushPendingPersistence();
    const before=JSON.parse(disk(path.join(storage,'session-state.json'))).revertHistory;
    const target=phase==='copy'?'session-state.json':phase==='afterDelete'?'session-state.unsaved':'session-state.tmp.json';
    const gate=pause(path.join(storage,target),phase);
    const operation=entry==='file'?tracker.revertFile(p):entry==='block'?tracker.revertBlock(p,tracker.getChangeBlocks(p)[0].blockId):tracker.revertAllChanges();
    await gate.entered;const ending=transition==='dispose'?tracker.dispose():tracker.stopRecording();
    // Capture the stopped state while the cancelled writer is still blocked.
    const persisted=tracker.flushPendingPersistence();gate.release();await operation;await ending;assert.equal(await persisted,true);
    assert.equal(disk(p),'edit\n');
    assert.deepEqual(JSON.parse(disk(path.join(storage,'session-state.json'))).revertHistory,before);
    assert.deepEqual(JSON.parse(disk(path.join(storage,'session-state.last-good.json'))).revertHistory,before);
    await tracker.dispose();tracker=new DiffTracker(Uri.file(storage));assert.equal(await tracker.restorePersistedState(),'restored');
    for(const old of [...oldFiles].reverse()){assert.equal((await tracker.undoLastRevert()).succeeded,1);assert.equal(disk(old),'edit\n');}
});
test('AUDIT-7 Undo verifies saved contents and retains recovery on save participant edits',async()=>{
    const p=file();seed(p,'base','edit');await scan(p);assert.ok(succeeded(await tracker.revertFile(p)));
    const gate=pause(p,'save'),op=tracker.undoLastRevert();await gate.entered;document(p).text='save participant output';document(p).version++;gate.release();
    const result=await op;assert.equal(result.succeeded,0);assert.equal(tracker.revertHistory.length,1);assert.equal(disk(p),'save participant output');
});
test('AUDIT-8 replacement symlink within workspace cannot redirect Revert',async()=>{
    const p=file(),q=file();seed(p,'base','edit');fs.writeFileSync(q,'edit');await scan(p);fs.unlinkSync(p);fs.symlinkSync(q,p);await scan(p);
    assert.equal(succeeded(await tracker.revertFile(p)),false);assert.equal(disk(q),'edit');
});
for(const entry of ['file','block','batch']) for(const phase of ['rename','copy','afterDelete']) test(`AUDIT-3 Keep ${entry} revalidates Git at ${phase}`,async()=>{
    const p=file();seed(p,'base\n','edit\n');await scan(p);
    const base={repoRoot:root,kind:'repository',headName:'main',headCommit:'aaa',detached:false,inProgress:false};tracker.setBaselineGitContexts([base]);
    const storage=file('storage');tracker.storageUri=Uri.file(storage);await tracker.flushPendingPersistence();
    const target=path.join(storage,phase==='rename'?'session-state.tmp.json':phase==='copy'?'session-state.json':tracker.persistenceFailureFileName);
    const gate=pause(target,phase);const op=entry==='block'?tracker.keepBlock(p,tracker.getChangeBlocks(p)[0].blockId):entry==='batch'?tracker.keepAllChanges():tracker.keepAllChangesInFile(p);
    await gate.entered;tracker.observeGitContext({...base,headName:'other'});gate.release();const result=await op;
    assert.equal(entry==='batch'?result.succeeded>0:succeeded(result),false);assert.equal(tracker.getOriginalContent(p),'base\n');
    assert.equal(new Map(JSON.parse(disk(path.join(storage,'session-state.json'))).fileSnapshots).get(p),'base\n');assert.ok(pending(p));
});
for(const entry of ['block','batch']) test(`AUDIT-6 stale ${entry} recovery preparation leaves new session untouched`,async()=>{
    const p=file(),q=file();for(const f of [p,q]){seed(f,'base\n','edit\n');await scan(f);}await tracker.revertFile(q);
    const storage=file('storage');tracker.storageUri=Uri.file(storage);await tracker.flushPendingPersistence();
    const temp=path.join(storage,'session-state.tmp.json'),gate=pause(temp,'write');
    const op=entry==='block'?tracker.revertBlock(p,tracker.getChangeBlocks(p)[0].blockId):tracker.revertAllChanges();await gate.entered;
    tracker.stopRecording();tracker.startRecording();faults.set(temp,{rename:error('NoPermissions')});gate.release();await op;faults.clear();
    assert.equal(tracker.revertHistory.length,0);assert.equal(disk(p),'edit\n');
});
test('AUDIT-6 old batch finalizer cannot prune a reused record ID',async()=>{
    const p=file();seed(p,'base','edit');await scan(p);const old=await tracker.prepareRevertRecord([tracker.createFileRevertItem(p)]);
    const fresh={...old,items:[...old.items]};tracker.revertHistory=[fresh];await tracker.finalizeBatchRevertRecord({record:old,retainPaths:new Set()});
    assert.equal(tracker.revertHistory[0],fresh);assert.equal(fresh.items.length,1);
});
for(const kind of ['submodule','worktree']) test(`AUDIT-2 parent rebuild leaves dirty ${kind} and recovery history untouched`,async()=>{
    const repo=file('repo'),child=path.join(repo,'child');fs.mkdirSync(child,{recursive:true});const p=path.join(repo,'p'),q=path.join(child,'q');
    seed(p,'parent base','parent edit');seed(q,'child base','child edit');await scan(p);await scan(q);
    const base={repoRoot:repo,kind:'repository',headName:'main',headCommit:'aaa',detached:false,inProgress:false},nested={...base,repoRoot:child,kind},next={...base,headName:'next'};
    tracker.setBaselineGitContexts([base,nested]);assert.ok(succeeded(await tracker.revertFile(q)));const history=JSON.stringify(tracker.revertHistory);
    document(q).text='unsaved child';document(q).isDirty=true;tracker.observeGitContext(next);tracker.storageUri=Uri.file(file('storage'));listedFiles=[Uri.file(p),Uri.file(q)];
    assert.equal(await tracker.rebuildRepositoryBaseline(repo,next),true);assert.equal(tracker.getOriginalContent(q),'child base');assert.equal(document(q).text,'unsaved child');
    assert.equal(JSON.stringify(tracker.revertHistory),history);assert.equal(tracker.getGitPauseReason(q),undefined);
});
for(const entry of ['block','batch','undo']) for(const directoryLink of [false,true]) test(`AUDIT-8 ${entry} rejects internal ${directoryLink?'directory':'file'} symlink`,async()=>{
    const dir=file('dir');fs.mkdirSync(dir);const p=path.join(dir,'p'),q=file();seed(p,'base\n','edit\n');fs.writeFileSync(q,'edit\n');await scan(p);
    if(entry==='undo')assert.ok(succeeded(await tracker.revertFile(p)));
    const token=tracker.getReviewToken(p),id=tracker.getChangeBlocks(p)[0]?.blockId;
    if(directoryLink){fs.unlinkSync(p);fs.rmdirSync(dir);const target=file('target-dir');fs.mkdirSync(target);fs.writeFileSync(path.join(target,'p'),entry==='undo'?'base\n':'edit\n');fs.symlinkSync(target,dir,process.platform==='win32'?'junction':'dir');}
    else {fs.unlinkSync(p);if(entry==='undo')fs.writeFileSync(q,'base\n');fs.symlinkSync(q,p);}
    const before=disk(p);const result=entry==='block'?await tracker.revertBlock(p,id,token):entry==='batch'?await tracker.revertAllChanges([token]):await tracker.undoLastRevert();
    assert.equal(entry==='block'?succeeded(result):result.succeeded>0,false);assert.equal(disk(p),before);
});
test('AUDIT-5 unknown change is durable and cannot be promoted by create after restart',async()=>{
    const p=file();fs.writeFileSync(p,'unknown');await scan(p);const storage=file('storage');tracker.storageUri=Uri.file(storage);assert.equal(await tracker.flushPendingPersistence(),true);await tracker.dispose();
    tracker=new DiffTracker(Uri.file(storage));assert.equal(await tracker.restorePersistedState(),'restored');await tracker.onExternalFileCreated(Uri.file(p));assert.ok(pending(p)?.unavailableReason);assert.equal(tracker.getOriginalContent(p),undefined);
});
test('AUDIT-4 restoration blocks Undo while ignore rules are loading',async()=>{
    const p=file();seed(p,'base','edit');await scan(p);assert.ok(succeeded(await tracker.revertFile(p)));
    const storage=file('storage');tracker.storageUri=Uri.file(storage);await tracker.flushPendingPersistence();await tracker.dispose();
    tracker=new DiffTracker(Uri.file(storage));const gate=pause(root,'ignoreScan');const restore=tracker.restorePersistedState();await gate.entered;
    const undo=await tracker.undoLastRevert();gate.release();await restore;
    assert.equal(undo.succeeded,0);assert.equal(disk(p),'base');assert.equal(tracker.revertHistory.length,1);
});
for(const ending of ['change','delete','recreate']) test(`AUDIT-4 restore retains create provenance before ${ending}`,async()=>{
    const p=file(),q=file();seed(q,'base');const storage=file('storage');tracker.storageUri=Uri.file(storage);await tracker.flushPendingPersistence();await tracker.dispose();
    tracker=new DiffTracker(Uri.file(storage));const gate=pause(q,'read'),restore=tracker.restorePersistedState();await gate.entered;
    fs.writeFileSync(p,'new content');emitWatcher('create',Uri.file(p));emitWatcher('change',Uri.file(p));
    if(ending!=='change'){fs.unlinkSync(p);emitWatcher('delete',Uri.file(p));}
    if(ending==='recreate'){fs.writeFileSync(p,'replacement');emitWatcher('create',Uri.file(p));emitWatcher('change',Uri.file(p));}
    gate.release();assert.equal(await restore,'restored');
    if(ending==='delete'){assert.equal(pending(p),undefined);return;}
    assert.equal(pending(p)?.unavailableReason,undefined);assert.equal(tracker.getOriginalContent(p),'');assert.equal(tracker.baselineExistingFiles.has(p),false);
    assert.equal(pending(p)?.currentContent,ending==='change'?'new content':'replacement');
});
for(const entry of ['file','batch','undo']) test(`PARENT recovery recreates nested parents (${entry})`,async()=>{
    const dir=file('deleted-parent'),p=path.join(dir,'nested','p'),q=path.join(dir,'nested','q');fs.mkdirSync(path.dirname(p),{recursive:true});seed(p,'base','edit');seed(q,'other');await scan(p);
    if(entry==='undo')await tracker.prepareRevertRecord([tracker.createRevertItem(p,{exists:true,content:'edit'},{exists:false,content:''},'disk')]);
    fs.rmSync(dir,{recursive:true});await tracker.onExternalFileDeleted(Uri.file(dir));assert.ok(pending(p)?.isDeleted);
    const result=entry==='file'?await tracker.revertFile(p):entry==='batch'?await tracker.revertAllChanges():await tracker.undoLastRevert();
    assert.equal(entry==='file'?succeeded(result):result.succeeded===(entry==='batch'?2:1),true,JSON.stringify(result));
    assert.equal(disk(p),entry==='undo'?'edit':'base');if(entry==='batch')assert.equal(disk(q),'other');
});
for(const entry of ['file','batch','undo']) test(`AUDIT-20 ${entry} recovery creates private parents without changing file mode`,async()=>{
    if(process.platform==='win32')return;
    const previous=process.umask(0o022);
    try{
        const dir=file('private'),p=path.join(dir,'nested','p');fs.mkdirSync(path.dirname(p),{recursive:true,mode:0o700});seed(p,'base');tracker.fileModes.set(p,0o644);
        if(entry==='undo')await tracker.prepareRevertRecord([tracker.createRevertItem(p,{exists:true,content:'base',mode:0o644},{exists:false,content:''},'disk')]);
        fs.rmSync(dir,{recursive:true});await tracker.onExternalFileDeleted(Uri.file(dir));
        const r=entry==='file'?await tracker.revertFile(p):entry==='batch'?await tracker.revertAllChanges():await tracker.undoLastRevert();
        assert.equal(entry==='file'?succeeded(r):r.succeeded===1,true);
        assert.equal(fs.statSync(dir).mode&0o777,0o700);assert.equal(fs.statSync(path.dirname(p)).mode&0o777,0o700);assert.equal(fs.statSync(p).mode&0o777,0o644);
    }finally{process.umask(previous);}
});
for(const restart of [false,true]) test(`AUDIT-20 completed staging exclusions expire${restart?' across restart':''}`,async()=>{
    tracker.creationTempGraceMs=20;
    for(let i=0;i<3;i++){const p=file();seed(p,'base');fs.unlinkSync(p);await tracker.onExternalFileDeleted(Uri.file(p));assert.ok(succeeded(await tracker.revertFile(p)));}
    const roots=[...tracker.creationTempRoots];assert.ok(roots.length>0);
    for(const dir of roots){assert.equal(fs.existsSync(dir),false);assert.equal(tracker.isPathIgnored(Uri.file(path.join(dir,'content'))),true);}
    if(restart){tracker.stopRecording();tracker.startRecording();await waitUntil(()=>tracker.getBaselineState()==='ready');}
    await waitUntil(()=>tracker.creationTempRoots.size===0,300);
    for(const dir of roots)assert.equal(tracker.isPathIgnored(Uri.file(path.join(dir,'content'))),false);
});
test('AUDIT-20 existing parent permissions remain unchanged',async()=>{
    if(process.platform==='win32')return;
    const dir=file('existing'),p=path.join(dir,'nested','p');fs.mkdirSync(path.dirname(p),{recursive:true});fs.chmodSync(dir,0o750);seed(p,'base');
    fs.rmSync(path.dirname(p),{recursive:true});await tracker.onExternalFileDeleted(Uri.file(path.dirname(p)));
    assert.ok(succeeded(await tracker.revertFile(p)));assert.equal(fs.statSync(dir).mode&0o777,0o750);assert.equal(fs.statSync(path.dirname(p)).mode&0o777,0o700);
});
for(const ending of ['success','failure','restart','dispose','unexpected-child']) test(`AUDIT-20 active staging survives grace interval then cleans up on ${ending}`,async()=>{
    tracker.creationTempGraceMs=20;
    const p=file();seed(p,'base');fs.unlinkSync(p);await tracker.onExternalFileDeleted(Uri.file(p));
    const gate=pause(p,'publish'),op=tracker.revertFile(p);await gate.entered;
    const [staging]=tracker.creationTempRoots;assert.ok(staging);const payload=path.join(staging,'content');
    await new Promise(resolve=>setTimeout(resolve,40));assert.equal(tracker.isPathIgnored(Uri.file(payload)),true);
    emitWatcher('create',Uri.file(payload));emitWatcher('change',Uri.file(payload));assert.equal(pending(payload),undefined);
    if(process.platform==='win32')assert.equal(tracker.isPathIgnored(Uri.file(payload.toUpperCase())),true);
    if(ending==='restart'){tracker.stopRecording();listedFiles=[Uri.file(payload)];tracker.startRecording();await waitUntil(()=>tracker.getBaselineState()==='ready');assert.equal(tracker.isPathIgnored(Uri.file(payload)),true);}
    if(ending==='failure')faults.set(p,{publish:error('NoPermissions')});
    if(ending==='unexpected-child')fs.writeFileSync(path.join(staging,'other'),'preserve me');
    if(ending==='dispose')await tracker.dispose();
    gate.release();const result=await op;
    assert.equal(succeeded(result),ending==='success'||ending==='unexpected-child');
    await waitUntil(()=>tracker.creationTempRoots.size===0,300);assert.equal(tracker.creationTempExpiryTimers.size,0);
    if(ending==='unexpected-child'){assert.equal(disk(path.join(staging,'other')),'preserve me');assert.equal(tracker.isPathIgnored(Uri.file(path.join(staging,'other'))),false);}
});
test('AUDIT-20 dispose before staging allocation returns cannot resurrect exclusion timers',async()=>{
    const p=file();seed(p,'base');fs.unlinkSync(p);await tracker.onExternalFileDeleted(Uri.file(p));
    const native=fs.promises.mkdtemp,entered=deferred(),release=deferred();
    fs.promises.mkdtemp=async(...args)=>{const dir=await native(...args);entered.resolve();await release.promise;return dir;};
    try{const op=tracker.revertFile(p);await entered.promise;await tracker.dispose();release.resolve();assert.equal(succeeded(await op),false);}
    finally{release.resolve();fs.promises.mkdtemp=native;}
    assert.equal(tracker.creationTempRoots.size,0);assert.equal(tracker.creationTempExpiryTimers.size,0);assert.equal(fs.existsSync(p),false);
});
for(const obstruction of ['file','symlink']) test(`PARENT recovery rejects parent ${obstruction}`,async()=>{
    const dir=file('parent'),p=path.join(dir,'nested','p');fs.mkdirSync(path.dirname(p),{recursive:true});seed(p,'base');fs.rmSync(dir,{recursive:true});await tracker.onExternalFileDeleted(Uri.file(dir));
    const target=file('target');fs.mkdirSync(target);
    if(obstruction==='file')fs.writeFileSync(dir,'do not replace');else fs.symlinkSync(target,dir,process.platform==='win32'?'junction':'dir');
    assert.equal(succeeded(await tracker.revertFile(p)),false);assert.equal(fs.existsSync(path.join(target,'nested')),false);assert.ok(pending(p));
    if(obstruction==='file')assert.equal(disk(dir),'do not replace');
});
for(const interruption of ['stop','symlink','permission']) test(`PARENT recovery stops safely on ${interruption} during directory creation`,async()=>{
    const dir=file('parent'),p=path.join(dir,'nested','p'),target=file('target');fs.mkdirSync(path.dirname(p),{recursive:true});fs.mkdirSync(target);seed(p,'base');fs.rmSync(dir,{recursive:true});await tracker.onExternalFileDeleted(Uri.file(dir));
    const mkdir=fs.mkdirSync;
    fs.mkdirSync=function(name,...args){
        if(name===dir && interruption==='permission')throw error('EACCES');
        const result=mkdir.call(this,name,...args);
        if(name===dir){if(interruption==='stop')tracker.stopRecording();else if(interruption==='symlink'){fs.rmdirSync(dir);fs.symlinkSync(target,dir,process.platform==='win32'?'junction':'dir');}}
        return result;
    };
    try{assert.equal(succeeded(await tracker.revertFile(p)),false);}finally{fs.mkdirSync=mkdir;}
    assert.equal(fs.existsSync(p),false);assert.equal(fs.existsSync(path.join(target,'nested')),false);assert.ok(pending(p));
});

for(const content of ['', 'offline addition\n']) test(`RESTORE-OFFLINE discovers ${content?'text':'empty'} additions and persists absence`,async()=>{
    const p=file(),q=file(),storage=file('storage');seed(p,'old','changed');tracker.storageUri=Uri.file(storage);
    await tracker.initializeWorkspaceSnapshots();await tracker.dispose();fs.writeFileSync(q,content);listedFiles=[Uri.file(p),Uri.file(q)];
    tracker=new DiffTracker(Uri.file(storage));assert.equal(await tracker.restorePersistedState(),'restored');
    assert.equal(tracker.getOriginalContent(p),'old');assert.equal(pending(p)?.currentContent,'changed');
    assert.equal(tracker.getOriginalContent(q),'');assert.equal(tracker.baselineExistingFiles.has(q),false);assert.ok(pending(q));
    tracker.onDocumentOpened(document(q));assert.equal(tracker.getOriginalContent(q),'');
    await tracker.dispose();tracker=new DiffTracker(Uri.file(storage));assert.equal(await tracker.restorePersistedState(),'restored');
    assert.ok(pending(q));assert.equal(tracker.baselineExistingFiles.has(q),false);
    assert.equal((await tracker.revertFile(q)).status,'conflict');assert.equal(disk(q),content);
    assert.equal((await tracker.keepAllChangesInFile(q)).status,'success');assert.equal(tracker.baselineExistingFiles.has(q),true);
});
for(const kind of ['dirty','binary','unreadable']) test(`RESTORE-OFFLINE ${kind} addition stays protected`,async()=>{
    const p=file(),q=file(),storage=file('storage');seed(p,'old');tracker.storageUri=Uri.file(storage);await tracker.initializeWorkspaceSnapshots();await tracker.dispose();
    fs.writeFileSync(q,kind==='binary'?Buffer.from([0,1,2]):'disk');listedFiles=[Uri.file(q)];
    if(kind==='dirty'){const doc=document(q);doc.text='unsaved';doc.isDirty=true;}
    if(kind==='unreadable')faults.set(q,{read:error('EACCES')});
    tracker=new DiffTracker(Uri.file(storage));assert.equal(await tracker.restorePersistedState(),'restored');
    assert.equal(tracker.getOriginalContent(q),'');
    if(kind==='binary')assert.equal(pending(q),undefined);else assert.ok(pending(q)?.unavailableReason);
    assert.equal(tracker.baselineExistingFiles.has(q),false);
    assert.equal((await tracker.revertFile(q)).status,'conflict');if(kind==='dirty')assert.equal(document(q).text,'unsaved');
});
test('RESTORE-OFFLINE excludes ignored paths and preserves unresolved baselines',async()=>{
    const p=file(),q=file(),storage=file('storage');seed(p,'old');tracker.unresolvedBaselineFiles.set(q,'unknown before close');
    tracker.storageUri=Uri.file(storage);await tracker.dispose();fs.writeFileSync(q,'new bytes');
    const ignored=file('skip.txt');fs.writeFileSync(ignored,'ignored');watchExclude=[path.basename(ignored)];
    listedFiles=[Uri.file(ignored),Uri.file(q)];tracker=new DiffTracker(Uri.file(storage));
    assert.equal(await tracker.restorePersistedState(),'restored');assert.equal(tracker.fileSnapshots.has(ignored),false);assert.equal(pending(ignored),undefined);
    assert.equal(tracker.fileSnapshots.has(q),false);assert.ok(pending(q)?.unavailableReason);
});
for(const stopped of [true,false]) test(`RESTORE-OFFLINE ${stopped?'stopped':'partial'} sessions do not infer absence`,async()=>{
    const p=file(),q=file(),storage=file('storage');seed(p,'old');tracker.storageUri=Uri.file(storage);
    if(stopped)tracker.stopRecording();else tracker.baselineBuilding=true;
    await tracker.dispose();fs.writeFileSync(q,'new');listedFiles=[Uri.file(q)];tracker=new DiffTracker(Uri.file(storage));
    assert.equal(await tracker.restorePersistedState(),stopped?'restored':'incomplete');assert.equal(tracker.fileSnapshots.has(q),false);
});
test('RESTORE-OFFLINE watcher covers ignore discovery and editor open cannot accept addition',async()=>{
    const p=file(),q=file(),storage=file('storage');seed(p,'old');tracker.storageUri=Uri.file(storage);await tracker.dispose();
    tracker=new DiffTracker(Uri.file(storage));const gate=pause(root,'ignoreScan'),restoring=tracker.restorePersistedState();await gate.entered;
    fs.writeFileSync(q,'new');tracker.onDocumentOpened(document(q));assert.equal(tracker.fileSnapshots.has(q),false);
    emitWatcher('create',Uri.file(q));emitWatcher('change',Uri.file(q));gate.release();
    assert.equal(await restoring,'restored');assert.equal(tracker.getOriginalContent(q),'');assert.ok(pending(q));
});
for(const action of ['stop','scan-error','persist-error']) test(`RESTORE-OFFLINE ${action} preserves previous durable review`,async()=>{
    const p=file(),q=file(),storage=file('storage');seed(p,'old','edit');tracker.storageUri=Uri.file(storage);await tracker.dispose();
    const primary=path.join(storage,'session-state.json'),before=fs.readFileSync(primary,'utf8'),find=vscode.workspace.findFiles;
    fs.writeFileSync(q,'new');tracker=new DiffTracker(Uri.file(storage));
    vscode.workspace.findFiles=async pattern=>{
        if(pattern.pattern!=='**/*')return [];
        if(action==='stop')tracker.stopRecording();
        if(action==='scan-error')throw error('EACCES');
        return [Uri.file(q)];
    };
    if(action==='persist-error')faults.set(path.join(storage,'session-state.tmp.json'),{write:error('EACCES')});
    try {assert.equal(await tracker.restorePersistedState(),'blocked');assert.equal(tracker.getOriginalContent(p),'old');
        if(action!=='stop')assert.equal(fs.readFileSync(primary,'utf8'),before);
        assert.equal(tracker.getIsRecording(),false);
    } finally {vscode.workspace.findFiles=find;}
});

for(const event of ['change','delete','recreate']) test(`RESTORE-OFFLINE replays ${event} during discovery`,async()=>{
    const p=file(),q=file(),storage=file('storage');seed(p,'old');tracker.storageUri=Uri.file(storage);await tracker.initializeWorkspaceSnapshots();await tracker.dispose();
    fs.writeFileSync(q,'first');listedFiles=[Uri.file(q)];tracker=new DiffTracker(Uri.file(storage));
    const gate=pause(q,'stat'),restoring=tracker.restorePersistedState();await gate.entered;
    if(event!=='change'){fs.unlinkSync(q);emitWatcher('delete',Uri.file(q));}
    if(event!=='delete'){fs.writeFileSync(q,'latest');emitWatcher(event==='change'?'change':'create',Uri.file(q));}
    gate.release();assert.equal(await restoring,'restored');assert.equal(tracker.getOriginalContent(q),'');
    if(event==='delete')assert.equal(pending(q),undefined);else assert.equal(pending(q)?.currentContent,'latest');
});
// Hold only the event's stat; the concurrent baseline worker must remain free.
for (const kind of ['Created','Changed']) {
    for (const listed of [true,false]) test(`SCAN-STAT ${kind} ${listed?'enumerated':'unlisted'} event stays unknown after scan completes`,async()=>{
        const p=file(),blocker=file(),storage=file('storage');
        fs.writeFileSync(p,'new content');fs.writeFileSync(blocker,'stable');
        listedFiles=[Uri.file(blocker),...(listed?[Uri.file(p)]:[])];
        tracker.storageUri=Uri.file(storage);tracker.snapshotInitialized=false;tracker.baselineBuilding=true;
        const read=pause(listed?p:blocker,'read'),scanning=tracker.initializeWorkspaceSnapshots();await read.entered;
        const stat=pause(p,'stat'),event=tracker[`onExternalFile${kind}`](Uri.file(p));await stat.entered;
        try { read.release();await scanning; } finally { stat.release();await event; }
        assert.equal(tracker.fileSnapshots.has(p),false);assert.ok(pending(p)?.unavailableReason);
        assert.equal(await tracker.flushPendingPersistence(),true);await tracker.dispose();
        tracker=new DiffTracker(Uri.file(storage));assert.equal(await tracker.restorePersistedState(),'restored');
        assert.ok(pending(p)?.unavailableReason);assert.equal(tracker.getReviewToken(p),undefined);
    });
}
for (const kind of ['Created','Changed']) {
    test(`SCAN-STAT ${kind} directory protects descendants without phantom file`,async()=>{
        const parent=file('dir'),p=path.join(parent,'child.m');fs.mkdirSync(parent);fs.writeFileSync(p,'new');
        tracker.snapshotInitialized=false;tracker.baselineBuilding=true;
        const stat=pause(parent,'stat'),event=tracker[`onExternalFile${kind}`](Uri.file(parent));await stat.entered;
        listedFiles=[Uri.file(p)];await tracker.initializeWorkspaceSnapshots();stat.release();await event;
        assert.equal(tracker.fileSnapshots.has(p),false);assert.ok(pending(p)?.unavailableReason);
        assert.equal(pending(parent),undefined);assert.equal(tracker.unresolvedBaselineFiles.has(parent),false);
    });
    test(`SCAN-STAT ${kind} editor open during stat cannot accept content`,async()=>{
        const p=file();fs.writeFileSync(p,'new');tracker.snapshotInitialized=false;
        const stat=pause(p,'stat'),event=tracker[`onExternalFile${kind}`](Uri.file(p));await stat.entered;
        tracker.onDocumentOpened(document(p));stat.release();await event;
        assert.equal(tracker.fileSnapshots.has(p),false);assert.ok(pending(p)?.unavailableReason);
    });
    test(`SCAN-STAT ${kind} late classification cannot change a new session`,async()=>{
        const p=file();fs.writeFileSync(p,'new');tracker.snapshotInitialized=false;
        const stat=pause(p,'stat'),event=tracker[`onExternalFile${kind}`](Uri.file(p));await stat.entered;
        tracker.stopRecording();await tracker.startRecording();seed(p,'next baseline');stat.release();await event;
        assert.equal(tracker.getOriginalContent(p),'next baseline');assert.equal(pending(p),undefined);
        assert.equal(tracker.scanUncertainFiles.has(p),false);
    });
    test(`SCAN-STAT ${kind} preserves known baseline during scan`,async()=>{
        const p=file();seed(p,'before','after');tracker.snapshotInitialized=false;
        await tracker[`onExternalFile${kind}`](Uri.file(p));await scan(p);
        assert.equal(tracker.getOriginalContent(p),'before');assert.equal(pending(p)?.currentContent,'after');
        assert.equal(tracker.scanUncertainFiles.has(p),false);assert.equal(tracker.unresolvedBaselineFiles.has(p),false);
    });
    test(`SCAN-STAT ${kind} ignores excluded paths before marking uncertainty`,async()=>{
        const p=file('ignored.m');fs.writeFileSync(p,'new');watchExclude=['*ignored.m'];
        await tracker.refreshIgnoreMatchers();tracker.snapshotInitialized=false;
        await tracker[`onExternalFile${kind}`](Uri.file(p));
        assert.equal(tracker.scanUncertainFiles.has(p),false);assert.equal(pending(p),undefined);
    });
}
for(const action of ['keepAllChangesInFile','revertFile','keepBlock','revertBlock','keepAllChanges','revertAllChanges','undoLastRevert','resetBaselineToCurrentState']) test(`GIT-INIT blocks ${action} and preserves restored data`,async()=>{
    const p=file(),storage=file('storage');seed(p,'base\n','changed\n');await scan(p);
    if(action==='undoLastRevert')assert.ok(succeeded(await tracker.revertFile(p)));
    // Fill recovery history to expose even a transient rejected batch pruning it.
    if(action==='revertAllChanges'){
        const item=tracker.createFileRevertItem(p);
        tracker.revertHistory=Array.from({length:10},(_,i)=>({id:`prior-${i}`,createdAt:new Date().toISOString(),items:[{...item}]}));
    }
    tracker.storageUri=Uri.file(storage);await tracker.dispose();docs.length=0;
    tracker=new DiffTracker(Uri.file(storage));tracker.setGitContextPending?.(true);
    assert.equal(await tracker.restorePersistedState(),'restored');
    const beforeDisk=disk(p),beforeOriginal=tracker.getOriginalContent(p),beforeHistory=JSON.stringify(tracker.revertHistory);
    const beforeCounters={...counters},block=tracker.getChangeBlocks(p)[0];
    const result=action.endsWith('Block')?await tracker[action](p,block.blockId):
        ['keepAllChangesInFile','revertFile'].includes(action)?await tracker[action](p):await tracker[action]();
    assert.equal(result===true||result?.status==='success'||result?.succeeded>0,false);
    assert.equal(disk(p),beforeDisk);assert.equal(tracker.getOriginalContent(p),beforeOriginal);
    assert.equal(JSON.stringify(tracker.revertHistory),beforeHistory);
    assert.equal(counters.apply,beforeCounters.apply);assert.equal(counters.save,beforeCounters.save);
    if(action!=='undoLastRevert')assert.ok(pending(p));
});
for(const outcome of ['same','branch','worktree','removed','appeared']) test(`GIT-INIT reconciliation ${outcome} releases only compatible reviews`,async()=>{
    const p=file(),storage=file('storage'),base={repoRoot:root,kind:'repository',headName:'main',headCommit:'aaa',detached:false,inProgress:false};
    seed(p,'base','changed');await scan(p);tracker.setBaselineGitContexts(outcome==='appeared'?[]:[base]);
    tracker.storageUri=Uri.file(storage);await tracker.dispose();tracker=new DiffTracker(Uri.file(storage));
    tracker.setGitContextPending(true);assert.equal(await tracker.restorePersistedState(),'restored');
    assert.match(tracker.getGitPauseReason(p),/initialization/);
    const current={...base,...(outcome==='branch'?{headName:'feature'}:outcome==='worktree'?{kind:'worktree'}:{})};
    tracker.reconcileRestoredGitContexts(outcome==='removed'?[]:[current]);
    // Per-repository events must not release the global gate ahead of ready.
    assert.match(tracker.getGitPauseReason(p),/initialization/);tracker.setGitContextPending(false);
    assert.equal(succeeded(await tracker.keepAllChangesInFile(p)),outcome==='same');
    assert.equal(disk(p),'changed');if(outcome!=='same')assert.ok(pending(p));
});
test('GIT-INIT stop does not bypass the gate; disposed tracker cannot be released',async()=>{
    const p=file();seed(p,'base','changed');await scan(p);tracker.setGitContextPending(true);tracker.stopRecording();
    assert.equal(succeeded(await tracker.keepAllChangesInFile(p)),false);
    assert.equal(await tracker.resetBaselineToCurrentState(),false);
    await tracker.dispose();tracker.setGitContextPending(false);assert.match(tracker.getGitPauseReason(p),/initialization/);
});
for(const mode of ['file','batch','block']) test(`AUDIT-25 rejected ${mode} Revert preserves all bounded recovery history`,async()=>{
    const p=file();seed(p,'base\n','changed\n');await scan(p);
    const item=tracker.createFileRevertItem(p);
    tracker.revertHistory=Array.from({length:10},(_,i)=>({id:`old-${i}`,createdAt:new Date().toISOString(),items:[{...item}]}));
    const before=JSON.stringify(tracker.revertHistory);
    faults.set(p,{apply:false});
    const result=mode==='batch'?await tracker.revertAllChanges():mode==='block'?await tracker.revertBlock(p,tracker.getChangeBlocks(p)[0].blockId):await tracker.revertFile(p);
    assert.equal(mode==='batch'?result.succeeded:succeeded(result),mode==='batch'?0:false);
    assert.equal(JSON.stringify(tracker.revertHistory),before);assert.equal(disk(p),'changed\n');
});
test('AUDIT-25 scan deletion cannot disappear behind a pending baseline read',async()=>{
    const p=file();fs.writeFileSync(p,'old');listedFiles=[Uri.file(p)];tracker.snapshotInitialized=false;tracker.baselineBuilding=true;
    const gate=pause(p,'read'),scanTask=tracker.initializeWorkspaceSnapshots();await gate.entered;
    fs.unlinkSync(p);await tracker.onExternalFileDeleted(Uri.file(p));gate.release();await scanTask;
    assert.ok(pending(p)?.unavailableReason);assert.equal(tracker.fileSnapshots.has(p),false);
});
for(const mode of ['file','batch']) test(`AUDIT-25 ${mode} final read Git pause cannot report success`,async()=>{
    const p=file();seed(p,'base','changed');await scan(p);
    const base={repoRoot:root,kind:'repository',headName:'main',headCommit:'aaa',detached:false,inProgress:false};tracker.setBaselineGitContexts([base]);
    const read=tracker.readCurrentFileState.bind(tracker);let paused=false;
    tracker.readCurrentFileState=async f=>{const value=await read(f);if(f===p&&disk(p)==='base'&&!tracker.activeWriteFiles.has(p)&&!paused){paused=true;tracker.observeGitContext({...base,headName:'feature'});}return value;};
    const result=mode==='file'?await tracker.revertFile(p):await tracker.revertAllChanges();
    assert.equal(paused,true);assert.equal(mode==='file'?succeeded(result):result.succeeded,mode==='file'?false:0);
    assert.ok(pending(p));assert.equal(tracker.revertHistory.length,1);
});
test('AUDIT-25 offline ignore removal is unknown rather than an absent baseline',async()=>{
    const p=file(),q=file(),storage=file('storage');fs.writeFileSync(p,'base');fs.writeFileSync(q,'pre-existing ignored');
    watchExclude=[path.basename(q)];listedFiles=[Uri.file(p),Uri.file(q)];tracker.storageUri=Uri.file(storage);tracker.snapshotInitialized=false;
    await tracker.initializeWorkspaceSnapshots();await tracker.dispose();watchExclude=[];
    tracker=new DiffTracker(Uri.file(storage));assert.equal(await tracker.restorePersistedState(),'restored');
    assert.equal(tracker.fileSnapshots.has(q),false);assert.ok(pending(q)?.unavailableReason);
    tracker.onDocumentOpened(document(q));assert.equal(tracker.fileSnapshots.has(q),false);
});
test('AUDIT-25 ignore refresh restores previously hidden pending reviews',async()=>{
    const p=file();seed(p,'base','changed');await scan(p);watchExclude=[path.basename(p)];await tracker.refreshIgnoreMatchers();assert.equal(pending(p),undefined);
    watchExclude=[];await tracker.refreshIgnoreMatchers();assert.equal(pending(p)?.currentContent,'changed');
});
for(const rule of ['files.exclude','files.watcherExclude','search.exclude','gitignore','deleted-gitignore']) test(`AUDIT-25 offline ${rule} removal preserves unknown before-image`,async()=>{
    const p=file(),q=file(),storage=file('storage'),ignorePath=file('.gitignore');
    fs.writeFileSync(p,'base');fs.writeFileSync(q,'pre-existing');listedFiles=[Uri.file(p),Uri.file(q)];
    if(rule.includes('gitignore')){fs.writeFileSync(ignorePath,path.basename(q));listedIgnores=[Uri.file(ignorePath)];}
    else vscodeExcludes[rule]={[path.basename(q)]:true};
    tracker.storageUri=Uri.file(storage);tracker.snapshotInitialized=false;await tracker.initializeWorkspaceSnapshots();
    assert.equal(tracker.fileSnapshots.has(q),false);await tracker.dispose();
    if(rule==='deleted-gitignore'){fs.unlinkSync(ignorePath);listedIgnores=[];}else if(rule==='gitignore')fs.writeFileSync(ignorePath,'');else vscodeExcludes={};
    tracker=new DiffTracker(Uri.file(storage));assert.equal(await tracker.restorePersistedState(),'restored');
    assert.equal(tracker.fileSnapshots.has(q),false);assert.ok(pending(q)?.unavailableReason);
    await tracker.dispose();tracker=new DiffTracker(Uri.file(storage));assert.equal(await tracker.restorePersistedState(),'restored');assert.ok(pending(q)?.unavailableReason);
});
test('AUDIT-25 legacy state without scan provenance cannot prove absence',async()=>{
    const p=file(),q=file(),storage=file('storage');seed(p,'base');tracker.storageUri=Uri.file(storage);await tracker.dispose();
    fs.writeFileSync(q,'may predate scan');listedFiles=[Uri.file(q)];tracker=new DiffTracker(Uri.file(storage));
    assert.equal(await tracker.restorePersistedState(),'restored');assert.equal(tracker.fileSnapshots.has(q),false);assert.ok(pending(q)?.unavailableReason);
});
test('AUDIT-25 opening a genuinely new file after a complete scan cannot accept its bytes',async()=>{
    const p=file(),q=file();fs.writeFileSync(p,'base');listedFiles=[Uri.file(p)];tracker.snapshotInitialized=false;await tracker.initializeWorkspaceSnapshots();
    fs.writeFileSync(q,'new');tracker.onDocumentOpened(document(q));assert.equal(tracker.getOriginalContent(q),'');assert.ok(pending(q));
});
test('AUDIT-25 unreadable ignore rules cannot establish complete scan coverage',async()=>{
    const p=file(),ignorePath=file('.gitignore');fs.writeFileSync(p,'base');fs.writeFileSync(ignorePath,'*.m');
    listedFiles=[Uri.file(p)];listedIgnores=[Uri.file(ignorePath)];tracker.snapshotInitialized=false;tracker.baselineBuilding=true;
    faults.set(ignorePath,{read:error('EACCES')});await assert.rejects(tracker.initializeWorkspaceSnapshots());
    assert.equal(tracker.scanCoverage,undefined);assert.equal(tracker.getBaselineState(),'building');
});
test('AUDIT-25 earlier ignore refresh cannot replace later rules',async()=>{
    const p=file();seed(p,'base','changed');await scan(p);await tracker.refreshIgnoreMatchers();
    watchExclude=[path.basename(p)];const gate=pause(root,'ignoreScan'),first=tracker.refreshIgnoreMatchers();await gate.entered;
    watchExclude=[];await tracker.refreshIgnoreMatchers();gate.release();await first;
    assert.equal(tracker.isPathIgnored(Uri.file(p)),false);assert.equal(pending(p)?.currentContent,'changed');
});
test('AUDIT-25 changing rules during a scan cannot certify offline absence',async()=>{
    const p=file();fs.writeFileSync(p,'base');listedFiles=[Uri.file(p)];tracker.snapshotInitialized=false;tracker.baselineBuilding=true;
    const gate=pause(p,'read'),scanning=tracker.initializeWorkspaceSnapshots();await gate.entered;
    watchExclude=['old-rule'];await tracker.refreshIgnoreMatchers();watchExclude=[];await tracker.refreshIgnoreMatchers();
    gate.release();await scanning;assert.equal(tracker.scanCoverage,undefined);
});
test('AUDIT-25 live gitignore edits rediscover newly included files',async()=>{
    const p=file(),q=file();fs.writeFileSync(p,'base');fs.writeFileSync(q,'previously ignored');
    const original=path.join(root,'.gitignore');fs.writeFileSync(original,path.basename(q));listedIgnores=[Uri.file(original)];listedFiles=[Uri.file(p),Uri.file(q)];
    tracker.startRecording();await waitUntil(()=>tracker.getBaselineState()==='ready');assert.equal(tracker.fileSnapshots.has(q),false);
    fs.writeFileSync(original,'');emitWatcher('change',Uri.file(original));await waitUntil(()=>!!pending(q)?.unavailableReason);
    assert.equal(tracker.fileSnapshots.has(q),false);fs.unlinkSync(original);
});
test('AUDIT-25 directory-only create notification discovers nested ignore rules',async()=>{
    tracker.snapshotInitialized=false;await tracker.initializeWorkspaceSnapshots();assert.ok(tracker.scanCoverage);
    const dir=file('directory'),p=path.join(dir,'existing.txt'),ignorePath=path.join(dir,'.gitignore');fs.mkdirSync(dir);fs.writeFileSync(p,'existing');fs.writeFileSync(ignorePath,'existing.txt\n');
    listedIgnores=[Uri.file(ignorePath)];listedFiles=[Uri.file(p),Uri.file(ignorePath)];
    await tracker.onExternalFileCreated(Uri.file(dir));
    assert.equal(tracker.isPathIgnored(Uri.file(p)),true);assert.equal(tracker.scanCoverage,undefined);assert.equal(pending(p),undefined);assert.equal(pending(dir),undefined);
});
for(const partial of [false,true]) test(`AUDIT-25 bounded history commits only when Revert mutates (partial=${partial})`,async()=>{
    const p=file(),q=file(),storage=file('storage');seed(p,'base','changed');seed(q,'base','changed');await scan(p);await scan(q);
    const item=tracker.createFileRevertItem(p);tracker.revertHistory=Array.from({length:10},(_,i)=>({id:`old-${i}`,createdAt:new Date().toISOString(),items:[{...item}]}));tracker.storageUri=Uri.file(storage);
    faults.set(p,{apply:false});if(!partial)faults.set(q,{apply:false});const result=await tracker.revertAllChanges();assert.equal(result.succeeded,partial?1:0);
    assert.equal(tracker.revertHistory.length,10);assert.equal(tracker.revertHistory[0].id,partial?'old-1':'old-0');
    if(partial)assert.deepEqual(tracker.revertHistory.at(-1).items.map(i=>i.filePath),[q]);
    const history=JSON.stringify(tracker.revertHistory);await tracker.dispose();tracker=new DiffTracker(Uri.file(storage));assert.equal(await tracker.restorePersistedState(),'restored');assert.equal(JSON.stringify(tracker.revertHistory),history);
});
for(const restoring of [false,true]) for(const transient of ['removed','permission']) test(`IGNORE-RETRY ${transient} during ${restoring?'restore':'initial scan'} rediscovers complete rules`,async()=>{
    const p=file(),q=file(),ignorePath=path.join(root,'.gitignore'),storage=file('storage');fs.writeFileSync(p,'known');fs.writeFileSync(q,'previously ignored');fs.writeFileSync(ignorePath,path.basename(q));
    listedFiles=[Uri.file(p),Uri.file(q)];listedIgnores=[Uri.file(ignorePath)];tracker.storageUri=Uri.file(storage);tracker.snapshotInitialized=false;
    if(restoring){await tracker.initializeWorkspaceSnapshots();await tracker.dispose();tracker=new DiffTracker(Uri.file(storage));}
    const read=vscode.workspace.fs.readFile;let attempts=0;
    vscode.workspace.fs.readFile=async uri=>{if(uri.fsPath===ignorePath&&attempts++===0){if(transient==='removed'){fs.unlinkSync(ignorePath);listedIgnores=[];}throw error(transient==='removed'?'FileNotFound':'NoPermissions');}return read(uri);};
    try {
        if(restoring)assert.equal(await tracker.restorePersistedState(),'restored');else await tracker.initializeWorkspaceSnapshots();
        assert.equal(tracker.getBaselineState(),'ready');
        if(transient==='permission'){assert.equal(attempts,2);assert.equal(tracker.isPathIgnored(Uri.file(q)),true);assert.equal(pending(q),undefined);}
        else if(restoring){assert.equal(tracker.getOriginalContent(q),undefined);assert.ok(pending(q)?.unavailableReason);}
        else assert.equal(tracker.getOriginalContent(q),'previously ignored');
        const fingerprint=tracker.ignoreFingerprint;await tracker.refreshIgnoreMatchers();assert.equal(tracker.ignoreFingerprint,fingerprint,'Failed attempt evidence must not contaminate the fingerprint');
    }finally{vscode.workspace.fs.readFile=read;fs.rmSync(ignorePath,{force:true});}
});
test('IGNORE-RETRY info exclude disappearing after exists check is rediscovered',async()=>{
    const p=file(),exclude=path.join(root,'.git','info','exclude');fs.mkdirSync(path.dirname(exclude),{recursive:true});fs.writeFileSync(exclude,'*.ignored');fs.writeFileSync(p,'known');listedFiles=[Uri.file(p)];tracker.snapshotInitialized=false;
    const read=fs.readFileSync;let failed=false;fs.readFileSync=function(filePath,...args){if(filePath===exclude&&!failed){failed=true;fs.unlinkSync(exclude);throw error('ENOENT');}return read.call(this,filePath,...args);};
    try{await tracker.initializeWorkspaceSnapshots();assert.equal(failed,true);assert.equal(tracker.getBaselineState(),'ready');assert.equal(tracker.getOriginalContent(p),'known');const fingerprint=tracker.ignoreFingerprint;await tracker.refreshIgnoreMatchers();assert.equal(tracker.ignoreFingerprint,fingerprint);}
    finally{fs.readFileSync=read;fs.rmSync(path.join(root,'.git'),{recursive:true,force:true});}
});
for(const setting of ['files.exclude','files.watcherExclude','search.exclude']) test(`ROUND26 folder-scoped ${setting} excludes only its own workspace root`,async()=>{
    const a=file('root-a'),b=file('root-b');fs.mkdirSync(a);fs.mkdirSync(b);const pa=path.join(a,'generated.txt'),pb=path.join(b,'generated.txt');fs.writeFileSync(pa,'generated');fs.writeFileSync(pb,'source');
    const folders=vscode.workspace.workspaceFolders,configuration=vscode.workspace.getConfiguration,folderFor=vscode.workspace.getWorkspaceFolder;
    vscode.workspace.workspaceFolders=[a,b].map(p=>({uri:Uri.file(p),name:path.basename(p)}));
    vscode.workspace.getWorkspaceFolder=uri=>vscode.workspace.workspaceFolders.find(f=>uri.fsPath.startsWith(f.uri.fsPath+path.sep));
    vscode.workspace.getConfiguration=(section,resource)=>({get:(key,fallback)=>!section&&key===setting&&resource?.fsPath===a?{'generated.txt':true}:fallback});
    listedFiles=[Uri.file(pa),Uri.file(pb)];
    try {tracker.startRecording();await waitUntil(()=>tracker.getBaselineState()==='ready');assert.equal(tracker.getOriginalContent(pa),undefined);assert.equal(tracker.getOriginalContent(pb),'source');fs.writeFileSync(pa,'changed');fs.writeFileSync(pb,'changed');emitWatcher('change',Uri.file(pa));emitWatcher('change',Uri.file(pb));await waitUntil(()=>!!pending(pb));assert.equal(pending(pa),undefined);}
    finally{vscode.workspace.workspaceFolders=folders;vscode.workspace.getConfiguration=configuration;vscode.workspace.getWorkspaceFolder=folderFor;}
});
for(const scopeName of ['sub[1]','#scope','!scope']) test(`ROUND26 nested ignore semantics agree with Git (${scopeName})`,async()=>{
    const dir=file('git-oracle'),sub=path.join(dir,scopeName);fs.mkdirSync(sub,{recursive:true});
    const top=path.join(dir,'.gitignore'),nested=path.join(sub,'.gitignore');
    fs.writeFileSync(top,'*.tmp\n');fs.writeFileSync(nested,'   \n*.log\n!keep.log\n/root.txt\ncache/\nlocal/file.txt\n\\#secret\n\\!secret\n leading.txt\n');
    assert.equal(spawnSync('git',['init','-q',dir]).status,0);
    const names=['a.log','deep/a.log','deep/keep.log','root.txt','deep/root.txt','cache/a.txt','deep/cache/a.txt','local/file.txt','deep/local/file.txt','#secret','deep/!secret',' leading.txt','normal.txt','deep/a.tmp'];
    const files=names.map(name=>path.join(sub,name));for(const p of files){fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,'content');}
    const folders=vscode.workspace.workspaceFolders,folderFor=vscode.workspace.getWorkspaceFolder;vscode.workspace.workspaceFolders=[{uri:Uri.file(dir),name:'oracle'}];vscode.workspace.getWorkspaceFolder=uri=>uri.fsPath.startsWith(dir+path.sep)?vscode.workspace.workspaceFolders[0]:undefined;
    listedIgnores=[Uri.file(top),Uri.file(nested)];listedFiles=files.map(Uri.file);
    try{tracker.startRecording();await waitUntil(()=>tracker.getBaselineState()==='ready');for(const p of files){const result=spawnSync('git',['check-ignore','--no-index','-q','--',path.relative(dir,p)],{cwd:dir});assert.ok(result.status===0||result.status===1);assert.equal(tracker.testIgnorePath(p).ignored,result.status===0,path.relative(dir,p));assert.equal(tracker.getOriginalContent(p),result.status===0?undefined:'content',path.relative(dir,p));}}
    finally{vscode.workspace.workspaceFolders=folders;vscode.workspace.getWorkspaceFolder=folderFor;}
});
test('ROUND26 populated directory notification records every included descendant without rule changes',async()=>{
    const storage=file('storage');tracker.storageUri=Uri.file(storage);tracker.startRecording();await waitUntil(()=>tracker.getBaselineState()==='ready');
    const dir=file('copied'),a=path.join(dir,'a.txt'),b=path.join(dir,'deep','empty.txt');fs.mkdirSync(path.dirname(b),{recursive:true});fs.writeFileSync(a,'copied');fs.writeFileSync(b,'');listedFiles=[Uri.file(a),Uri.file(b)];
    emitWatcher('create',Uri.file(dir));await waitUntil(()=>!!pending(a)&&!!pending(b));
    assert.equal(tracker.getOriginalContent(a),'');assert.equal(tracker.getOriginalContent(b),'');assert.equal(pending(a).unavailableReason,undefined);assert.equal(pending(b).unavailableReason,undefined);assert.equal(pending(dir),undefined);
    await tracker.dispose();tracker=new DiffTracker(Uri.file(storage));assert.equal(await tracker.restorePersistedState(),'restored');assert.ok(pending(a));assert.ok(pending(b));assert.equal(tracker.getOriginalContent(a),'');
});
for(const rulesChanged of [false,true]) test(`ROUND26 copied directory preserves known and unknown baselines and filters descendants (rules=${rulesChanged})`,async()=>{
    const dir=file('copy'),a=path.join(dir,'a.txt'),b=path.join(dir,'deep','b.txt'),ignored=path.join(dir,'deep','skip.log'),old=path.join(dir,'old.txt'),unknown=path.join(dir,'unknown.txt');
    tracker.startRecording();await waitUntil(()=>tracker.getBaselineState()==='ready');fs.mkdirSync(path.dirname(b),{recursive:true});for(const p of [a,b,ignored,old,unknown])fs.writeFileSync(p,'new');
    tracker.fileSnapshots.set(old,'old');tracker.baselineExistingFiles.add(old);tracker.recordUnresolvedBaseline(unknown,'unknown before copy');
    const rule=path.join(dir,'.gitignore');if(rulesChanged){fs.writeFileSync(rule,'*.log');listedIgnores=[Uri.file(rule)];}else{watchExclude=['**/*.log'];await tracker.refreshIgnoreMatchers();}
    listedFiles=[a,b,ignored,old,unknown].map(Uri.file);await tracker.onExternalFileCreated(Uri.file(dir));
    for(const p of [a,b]){assert.equal(tracker.getOriginalContent(p),'');assert.equal(pending(p)?.currentContent,'new');assert.equal(pending(p)?.unavailableReason,undefined);}
    assert.equal(pending(ignored),undefined);assert.equal(tracker.getOriginalContent(old),'old');assert.ok(pending(unknown)?.unavailableReason);assert.equal(tracker.getOriginalContent(unknown),undefined);assert.equal(pending(dir),undefined);
});
for(const lifecycle of ['stop','restart','dispose']) test(`ROUND26 ${lifecycle} cancels a pending directory enumeration`,async()=>{
    tracker.startRecording();await waitUntil(()=>tracker.getBaselineState()==='ready');const dir=file('cancel-dir'),p=path.join(dir,'a.txt');fs.mkdirSync(dir);fs.writeFileSync(p,'late');
    const find=vscode.workspace.findFiles,gate=pause(dir,'directoryScan');vscode.workspace.findFiles=async pattern=>{if(pattern.base===dir){await boundary(dir,'directoryScan');return [Uri.file(p)];}return find(pattern);};
    try{const work=tracker.onExternalFileCreated(Uri.file(dir));await gate.entered;if(lifecycle==='dispose')await tracker.dispose();else{tracker.stopRecording();if(lifecycle==='restart'){tracker.startRecording();await waitUntil(()=>tracker.getBaselineState()==='ready');}}const state=JSON.stringify(tracker.buildPersistedState());gate.release();await work;assert.equal(JSON.stringify(tracker.buildPersistedState()),state);assert.equal(pending(p),undefined);}
    finally{gate.release();vscode.workspace.findFiles=find;}
});
test('ROUND26 directory event observed during scan remains unknown after scan completion',async()=>{
    const p=file(),dir=file('scan-dir'),child=path.join(dir,'child.txt');fs.writeFileSync(p,'base');listedFiles=[Uri.file(p)];const scanning=pause(p,'read');tracker.startRecording();await scanning.entered;
    fs.mkdirSync(dir);fs.writeFileSync(child,'during scan');const stat=pause(dir,'stat');const event=tracker.onExternalFileCreated(Uri.file(dir));await stat.entered;listedFiles=[Uri.file(p),Uri.file(child)];scanning.release();await waitUntil(()=>tracker.getBaselineState()==='ready');stat.release();await event;
    assert.equal(tracker.getOriginalContent(child),undefined);assert.ok(pending(child)?.unavailableReason);assert.equal(tracker.getOriginalContent(p),'base');
});
test('ROUND26 directory scan failure is visible and never accepts its children',async()=>{
    tracker.startRecording();await waitUntil(()=>tracker.getBaselineState()==='ready');const dir=file('failed-dir');fs.mkdirSync(dir);const find=vscode.workspace.findFiles;vscode.workspace.findFiles=async pattern=>{if(pattern.base===dir)throw error('EACCES');return find(pattern);};
    try{await tracker.onExternalFileCreated(Uri.file(dir));assert.ok(pending(dir)?.unavailableReason);assert.equal(tracker.getOriginalContent(dir),'');assert.equal(succeeded(await tracker.keepAllChangesInFile(dir)),false);assert.equal(succeeded(await tracker.revertFile(dir)),false);}finally{vscode.workspace.findFiles=find;}
});
test('ROUND26 overlapping ignore refresh retains directory creation evidence before stat completes',async()=>{
    tracker.startRecording();await waitUntil(()=>tracker.getBaselineState()==='ready');const dir=file('racing-dir'),p=path.join(dir,'child.txt'),rule=path.join(dir,'.gitignore');fs.mkdirSync(dir);fs.writeFileSync(p,'new');fs.writeFileSync(rule,'*.log');listedFiles=[Uri.file(p)];listedIgnores=[Uri.file(rule)];
    const gate=pause(dir,'stat'),event=tracker.onExternalFileCreated(Uri.file(dir));await gate.entered;await tracker.refreshIgnoreMatchers();gate.release();await event;assert.equal(tracker.getOriginalContent(p),'');assert.equal(pending(p)?.unavailableReason,undefined);assert.equal(pending(p)?.currentContent,'new');
});
test('ROUND26 repository info excludes have lower precedence than nested rules',async()=>{
    const dir=file('precedence'),sub=path.join(dir,'sub');fs.mkdirSync(sub,{recursive:true});assert.equal(spawnSync('git',['init','-q',dir]).status,0);const info=path.join(dir,'.git','info','exclude'),rule=path.join(sub,'.gitignore'),p=path.join(sub,'keep.cfg');fs.writeFileSync(info,'*.cfg\n');fs.writeFileSync(rule,'!keep.cfg\n');fs.writeFileSync(p,'source');
    const folders=vscode.workspace.workspaceFolders;vscode.workspace.workspaceFolders=[{uri:Uri.file(dir),name:'repository'}];const folderFor=vscode.workspace.getWorkspaceFolder;vscode.workspace.getWorkspaceFolder=uri=>uri.fsPath.startsWith(dir+path.sep)?vscode.workspace.workspaceFolders[0]:undefined;
    listedIgnores=[Uri.file(rule)];listedFiles=[Uri.file(p)];try{tracker.startRecording();await waitUntil(()=>tracker.getBaselineState()==='ready');assert.equal(spawnSync('git',['check-ignore','--no-index','-q','--','sub/keep.cfg'],{cwd:dir}).status,1);assert.equal(tracker.getOriginalContent(p),'source');}finally{vscode.workspace.workspaceFolders=folders;vscode.workspace.getWorkspaceFolder=folderFor;}
});
test('ROUND26 imported descendants remain watched after Keep and Stop/restart',async()=>{
    tracker.startRecording();await waitUntil(()=>tracker.getBaselineState()==='ready');const dir=file('watched-import'),p=path.join(dir,'deep','child.txt');fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,'new');listedFiles=[Uri.file(p)];await tracker.onExternalFileCreated(Uri.file(dir));assert.equal((await tracker.keepAllChangesInFile(p)).status,'success');
    const notify=()=>{for(const watcher of nativeDirectoryWatchers){if(watcher.active&&watcher.directory===path.dirname(p))watcher.listener('change',path.basename(p));}};
    fs.writeFileSync(p,'after Keep');if(!process.env.DT_REAL_DIRECTORY_WATCH)notify();await waitUntil(()=>pending(p)?.currentContent==='after Keep');assert.equal((await tracker.keepAllChangesInFile(p)).status,'success');
    tracker.stopRecording();assert.equal(nativeDirectoryWatchers.filter(w=>w.active).length,0);tracker.startRecording();await waitUntil(()=>tracker.getBaselineState()==='ready');fs.writeFileSync(p,'after restart');if(!process.env.DT_REAL_DIRECTORY_WATCH)notify();await waitUntil(()=>pending(p)?.currentContent==='after restart');
    fs.rmSync(dir,{recursive:true});await tracker.onExternalFileDeleted(Uri.file(dir));assert.equal(nativeDirectoryWatchers.filter(w=>w.active).length,0);assert.equal(pending(p)?.isDeleted,true);
});

for(const existed of [false,true]) test(`ROUND27 directory replacement respects baseline existence (${existed})`,async()=>{
    const dir=file('replacement'),p=path.join(dir,'child.txt');seed(dir,'','',existed);await scan(dir);fs.unlinkSync(dir);fs.mkdirSync(dir);fs.writeFileSync(p,'new');listedFiles=[Uri.file(p)];
    await tracker.onExternalFileCreated(Uri.file(dir));
    if(existed){assert.ok(pending(dir)?.unavailableReason);assert.equal(pending(p),undefined);}
    else{assert.equal(pending(dir),undefined);assert.equal(pending(p)?.currentContent,'new');assert.equal(pending(p)?.unavailableReason,undefined);assert.equal(tracker.getOriginalContent(p),'');}
});
for(const ignoredOnly of [false,true]) test(`ROUND27 imported empty or ignored-only subdirectory receives later files (${ignoredOnly})`,async()=>{
    watchExclude=['**/*.log','**/excluded/'];await tracker.refreshIgnoreMatchers();
    const dir=file('empty-import'),sub=path.join(dir,'deep','empty'),excluded=path.join(dir,'excluded');fs.mkdirSync(sub,{recursive:true});fs.mkdirSync(excluded);
    if(ignoredOnly)fs.writeFileSync(path.join(sub,'skip.log'),'ignored');listedFiles=[];
    await tracker.onExternalFileCreated(Uri.file(dir));
    const p=path.join(sub,'later.txt');fs.writeFileSync(p,'later');
    if(!process.env.DT_REAL_DIRECTORY_WATCH)for(const w of nativeDirectoryWatchers)if(w.active&&w.directory===sub)w.listener('rename','later.txt');
    await waitUntil(()=>pending(p)?.currentContent==='later');assert.equal(pending(p)?.unavailableReason,undefined);
    assert.equal(nativeDirectoryWatchers.some(w=>w.active&&w.directory===excluded),false);
});
for(const block of [false,true]) for(const failure of ['write','git']) for(const change of ['external','unnotified','buffer','deleted','equal-candidate']) test(`ROUND27 Keep rollback refreshes ${change} after ${failure} (block=${block})`,async()=>{
    const p=file();seed(p,'base\n','reviewed\n');await scan(p);
    const context={repoRoot:root,kind:'repository',headName:'main',headCommit:'aaa',detached:false,inProgress:false};tracker.setBaselineGitContexts([context]);
    const storage=file('storage');tracker.storageUri=Uri.file(storage);await tracker.flushPendingPersistence();
    const temp=path.join(storage,'session-state.tmp.json'),gate=pause(temp,'write');
    const op=block?tracker.keepBlock(p,tracker.getChangeBlocks(p)[0].blockId):tracker.keepAllChangesInFile(p);await gate.entered;
    if(change==='buffer'){const doc=document(p);doc.text='latest buffer\n';doc.isDirty=true;doc.version++;tracker.updateTrackedDiff(p,doc.text);}
    else{if(change==='deleted')fs.unlinkSync(p);else fs.writeFileSync(p,change==='equal-candidate'?'reviewed\n':'latest disk\n');if(change!=='unnotified')await scan(p);}
    if(failure==='git')tracker.observeGitContext({...context,headName:'other'});
    // The write boundary has already passed its fault check; fail the following rename.
    else faults.set(temp,{rename:error('NoPermissions')});
    gate.release();assert.equal(succeeded(await op),false);faults.clear();assert.equal(tracker.getOriginalContent(p),'base\n');
    assert.equal(pending(p)?.currentContent,change==='buffer'?'latest buffer\n':change==='deleted'?'':change==='equal-candidate'?'reviewed\n':'latest disk\n');
    if(change==='deleted')assert.equal(pending(p)?.isDeleted,true);
    if(failure==='git')assert.ok(tracker.getGitPauseReason(p));
});


for(const failure of ['limit','quota','read']) test(`ROUND27 watcher ${failure} cleans partial coverage and still discovers files`,async()=>{
    const existing=file('watched-existing');fs.mkdirSync(existing);tracker.watchImportedDirectory(existing,tracker.sessionEpoch);
    const dir=file('watch-limit'),child=path.join(dir,'deep'),p=path.join(child,'file.txt');fs.mkdirSync(child,{recursive:true});fs.writeFileSync(p,'imported');listedFiles=[Uri.file(p)];
    const originalWatch=fs.watch,originalRead=fs.promises.readdir;
    if(failure==='limit')tracker.maxImportedDirectoryWatchers=2;
    if(failure==='quota')fs.watch=(directory,...args)=>{if(directory===child)throw error('ENOSPC');return originalWatch(directory,...args);};
    if(failure==='read')fs.promises.readdir=async(directory,...args)=>{if(directory===child)throw error('EACCES');return originalRead(directory,...args);};
    try{
        for(let attempt=0;attempt<2;attempt++){
            await tracker.onExternalFileCreated(Uri.file(dir));
            assert.equal(pending(p)?.currentContent,'imported');assert.equal(pending(p)?.unavailableReason,undefined);
            assert.match(pending(dir)?.unavailableReason??'',/watch coverage is incomplete/);
            assert.deepEqual(nativeDirectoryWatchers.filter(w=>w.active).map(w=>w.directory),[existing]);
        }
    }finally{fs.watch=originalWatch;fs.promises.readdir=originalRead;}
});


for(const source of ['setting','gitignore']) test(`ROUND27 ${source} changes reclaim imported watch capacity across restart`,async()=>{
    tracker.startRecording();await waitUntil(()=>tracker.getBaselineState()==='ready');tracker.maxImportedDirectoryWatchers=2;
    const dir=file('reclaim'),sub=path.join(dir,'deep');fs.mkdirSync(sub,{recursive:true});await tracker.onExternalFileCreated(Uri.file(dir));assert.equal(nativeDirectoryWatchers.filter(w=>w.active).length,2);
    if(source==='setting')watchExclude=[path.basename(dir)+'/'];else{const rule=file('.gitignore');fs.writeFileSync(rule,path.basename(dir)+'/');listedIgnores=[Uri.file(rule)];}
    await tracker.refreshIgnoreMatchers();assert.equal(nativeDirectoryWatchers.filter(w=>w.active).length,0);
    tracker.stopRecording();tracker.startRecording();await waitUntil(()=>tracker.getBaselineState()==='ready');assert.equal(nativeDirectoryWatchers.filter(w=>w.active).length,0);
    const next=file('next-import'),p=path.join(next,'later.txt');fs.mkdirSync(next);fs.writeFileSync(p,'new');listedFiles=[Uri.file(p)];await tracker.onExternalFileCreated(Uri.file(next));assert.equal(pending(next),undefined);assert.equal(pending(p)?.currentContent,'new');
});
for(const restore of [false,true]) test(`ROUND27 deleting a failed-watch tree clears its persisted marker (restore=${restore})`,async()=>{
    const storage=file('storage');tracker.storageUri=Uri.file(storage);tracker.maxImportedDirectoryWatchers=0;
    const dir=file('failed-watch-delete'),p=path.join(dir,'child.txt');fs.mkdirSync(dir);fs.writeFileSync(p,'new');listedFiles=[Uri.file(p)];await tracker.onExternalFileCreated(Uri.file(dir));assert.ok(pending(dir)?.unavailableReason);
    if(restore){await tracker.dispose();tracker=new DiffTracker(Uri.file(storage));assert.equal(await tracker.restorePersistedState(),'restored');}
    fs.rmSync(dir,{recursive:true});await tracker.onExternalFileDeleted(Uri.file(dir));assert.equal(pending(dir),undefined);assert.equal(pending(p),undefined);assert.equal(tracker.unresolvedBaselineFiles.has(dir),false);
    await tracker.flushPendingPersistence();await tracker.dispose();tracker=new DiffTracker(Uri.file(storage));listedFiles=[];assert.equal(await tracker.restorePersistedState(),'restored');assert.equal(pending(dir),undefined);assert.equal(pending(p),undefined);
});


for(const uncertainty of ['scan','older']) test(`ROUND27 failed directory coverage preserves ${uncertainty} uncertainty`,async()=>{
    const dir=file('unknown-watch');fs.mkdirSync(dir);tracker.maxImportedDirectoryWatchers=0;
    if(uncertainty==='scan')tracker.snapshotInitialized=false;else tracker.recordUnresolvedBaseline(dir,'pre-existing unknown path');
    await tracker.onExternalFileCreated(Uri.file(dir));assert.equal(tracker.getOriginalContent(dir),undefined);assert.ok(pending(dir)?.unavailableReason);
    fs.rmSync(dir,{recursive:true});await tracker.onExternalFileDeleted(Uri.file(dir));assert.ok(pending(dir)?.unavailableReason);assert.equal(tracker.getOriginalContent(dir),undefined);
});


for(const source of ['setting','gitignore']) test(`ROUND27 unignoring ${source} reinstalls coverage including newly nested directories`,async()=>{
    tracker.startRecording();await waitUntil(()=>tracker.getBaselineState()==='ready');const dir=file('unignore'),sub=path.join(dir,'deep'),p=path.join(sub,'known.txt');fs.mkdirSync(sub,{recursive:true});fs.writeFileSync(p,'base');listedFiles=[Uri.file(p)];await tracker.onExternalFileCreated(Uri.file(dir));assert.equal((await tracker.keepAllChangesInFile(p)).status,'success');
    const rule=file('.gitignore');if(source==='setting')watchExclude=[path.basename(dir)+'/'];else{fs.writeFileSync(rule,path.basename(dir)+'/');listedIgnores=[Uri.file(rule)];}
    await tracker.refreshIgnoreMatchers();assert.equal(nativeDirectoryWatchers.filter(w=>w.active).length,0);
    const nested=path.join(sub,'created-while-ignored');fs.mkdirSync(nested);
    if(source==='setting')watchExclude=[];else fs.writeFileSync(rule,'');await tracker.refreshIgnoreMatchers();
    fs.writeFileSync(p,'after unignore');if(!process.env.DT_REAL_DIRECTORY_WATCH)for(const w of nativeDirectoryWatchers)if(w.active&&w.directory===sub)w.listener('change','known.txt');
    await waitUntil(()=>pending(p)?.currentContent==='after unignore');assert.equal(tracker.getOriginalContent(p),'base');
    const q=path.join(nested,'new.txt');fs.writeFileSync(q,'new');if(!process.env.DT_REAL_DIRECTORY_WATCH)for(const w of nativeDirectoryWatchers)if(w.active&&w.directory===nested)w.listener('rename','new.txt');await waitUntil(()=>pending(q)?.currentContent==='new');
});
for(const restore of [false,true]) for(const kind of ['error','unnamed']) test(`ROUND27 asynchronous watcher ${kind} records deletable absence (restore=${restore})`,async()=>{
    tracker.storageUri=Uri.file(file('storage'));const storage=tracker.storageUri;const dir=file('async-watch'),sub=path.join(dir,'deep');fs.mkdirSync(sub,{recursive:true});await tracker.onExternalFileCreated(Uri.file(dir));
    const watcher=nativeDirectoryWatchers.find(w=>w.active&&w.directory===sub);assert.ok(watcher);if(kind==='error')watcher.error(error('ENOSPC'));else watcher.listener('rename',null);
    await waitUntil(()=>!!pending(sub)?.unavailableReason);assert.equal(tracker.getOriginalContent(sub),'');
    if(restore){await tracker.dispose();tracker=new DiffTracker(storage);assert.equal(await tracker.restorePersistedState(),'restored');}
    fs.rmSync(dir,{recursive:true});await tracker.onExternalFileDeleted(Uri.file(dir));assert.equal(pending(sub),undefined);assert.equal(tracker.unresolvedBaselineFiles.has(sub),false);
});


test('ROUND27 failed watch resume retains discovery for a later successful retry',async()=>{
    const dir=file('retry-unignore'),sub=path.join(dir,'deep');fs.mkdirSync(sub,{recursive:true});await tracker.onExternalFileCreated(Uri.file(dir));watchExclude=[path.basename(dir)+'/'];await tracker.refreshIgnoreMatchers();
    tracker.maxImportedDirectoryWatchers=1;watchExclude=[];await tracker.refreshIgnoreMatchers();assert.ok(tracker.importedDirectoryWatchers.has(dir));assert.ok(nativeDirectoryWatchers.filter(w=>w.active).length<=1);
    tracker.maxImportedDirectoryWatchers=2;await tracker.refreshIgnoreMatchers();for(const p of [dir,sub])assert.ok(nativeDirectoryWatchers.some(w=>w.active&&w.directory===p));
});
test('ROUND27 asynchronous failure during scan never certifies absence',async()=>{
    tracker.snapshotInitialized=false;const dir=file('scan-async');fs.mkdirSync(dir);await tracker.onExternalFileCreated(Uri.file(dir));const watcher=nativeDirectoryWatchers.find(w=>w.active&&w.directory===dir);watcher.error(error('ENOSPC'));
    await waitUntil(()=>!!pending(dir)?.unavailableReason);assert.equal(tracker.getOriginalContent(dir),undefined);
});


for(const failScan of [false,true]) test(`ROUND27 same-fingerprint watch retry reconciles gap and clears durable marker (scanRetry=${failScan})`,async()=>{
    tracker.storageUri=Uri.file(file('storage'));const storage=tracker.storageUri;tracker.startRecording();await waitUntil(()=>tracker.getBaselineState()==='ready');
    const dir=file('gap'),sub=path.join(dir,'deep'),p=path.join(sub,'known.txt'),deleted=path.join(sub,'deleted.txt');fs.mkdirSync(sub,{recursive:true});for(const f of [p,deleted])fs.writeFileSync(f,'base');listedFiles=[p,deleted].map(Uri.file);await tracker.onExternalFileCreated(Uri.file(dir));for(const f of [p,deleted])assert.equal((await tracker.keepAllChangesInFile(f)).status,'success');
    watchExclude=[path.basename(dir)+'/'];await tracker.refreshIgnoreMatchers();watchExclude=[];tracker.maxImportedDirectoryWatchers=0;await tracker.refreshIgnoreMatchers();assert.ok(pending(dir)?.unavailableReason);
    fs.writeFileSync(p,'gap edit');fs.unlinkSync(deleted);const q=path.join(sub,'gap-new.txt');fs.writeFileSync(q,'gap new');listedFiles=[p,q].map(Uri.file);const fingerprint=tracker.ignoreFingerprint;tracker.maxImportedDirectoryWatchers=256;
    const find=vscode.workspace.findFiles;
    if(failScan){vscode.workspace.findFiles=async pattern=>{if(pattern.pattern==='**/*')throw error('scan failed');return find(pattern);};try{await assert.rejects(tracker.refreshIgnoreMatchers());}finally{vscode.workspace.findFiles=find;}assert.ok(pending(dir)?.unavailableReason);}
    await tracker.refreshIgnoreMatchers();assert.equal(tracker.ignoreFingerprint,fingerprint);assert.equal(pending(p)?.currentContent,'gap edit');assert.equal(pending(deleted)?.isDeleted,true);assert.ok(pending(q));assert.ok(pending(q)?.unavailableReason,'unobserved gap creation keeps unknown before-image');assert.equal(pending(dir),undefined);assert.equal(tracker.fileSnapshots.has(dir),false);
    await tracker.dispose();tracker=new DiffTracker(storage);assert.equal(await tracker.restorePersistedState(),'restored');assert.equal(pending(dir),undefined);assert.equal(pending(p)?.currentContent,'gap edit');assert.ok(pending(q)?.unavailableReason);
});


for(const failResume of [false,true]) test(`ROUND27 stale failed ${failResume?'watch resume':'reconciliation'} cannot overwrite a newer success`,async()=>{
    tracker.storageUri=Uri.file(file('storage'));tracker.startRecording();await waitUntil(()=>tracker.getBaselineState()==='ready');const dir=file('stale-reconcile'),p=path.join(dir,'known.txt');fs.mkdirSync(dir);fs.writeFileSync(p,'base');listedFiles=[Uri.file(p)];await tracker.onExternalFileCreated(Uri.file(dir));await tracker.keepAllChangesInFile(p);
    const watcher=nativeDirectoryWatchers.find(w=>w.active&&w.directory===dir);watcher.error(error('ENOSPC'));await waitUntil(()=>!!pending(dir)?.unavailableReason);
    const entered=deferred(),release=deferred(),find=vscode.workspace.findFiles,read=fs.promises.readdir;let first=true;
    if(failResume)fs.promises.readdir=async(directory,...args)=>{if(directory===dir&&first){first=false;entered.resolve();await release.promise;throw error('old resume');}return read(directory,...args);};
    else vscode.workspace.findFiles=async pattern=>{if(pattern.pattern==='**/*'&&first){first=false;entered.resolve();await release.promise;throw error('old scan');}return find(pattern);};
    const old=tracker.refreshIgnoreMatchers();const oldResult=old.then(()=>null,e=>e);
    try{await entered.promise;if(failResume){nativeDirectoryWatchers.find(w=>w.active&&w.directory===dir).error(error('ENOSPC'));}fs.writeFileSync(p,'latest');const latest=tracker.refreshIgnoreMatchers();if(failResume)release.resolve();await latest;assert.equal(pending(p)?.currentContent,'latest');assert.equal(pending(dir),undefined);release.resolve();assert.equal(await oldResult,null);assert.equal(pending(dir),undefined);assert.equal(tracker.fileSnapshots.has(dir),false);}
    finally{release.resolve();await oldResult;vscode.workspace.findFiles=find;fs.promises.readdir=read;}
});


for(const stop of [false,true]) test(`ROUND27 overlapping successful watch resume retains reconciliation (stop=${stop})`,async()=>{
    tracker.startRecording();await waitUntil(()=>tracker.getBaselineState()==='ready');const dir=file('overlap-resume'),sub=dir,p=path.join(sub,'known.txt'),deleted=path.join(sub,'deleted.txt');fs.mkdirSync(sub,{recursive:true});for(const f of [p,deleted])fs.writeFileSync(f,'base');listedFiles=[p,deleted].map(Uri.file);await tracker.onExternalFileCreated(Uri.file(dir));for(const f of [p,deleted])await tracker.keepAllChangesInFile(f);
    watchExclude=[path.basename(dir)+'/'];await tracker.refreshIgnoreMatchers();fs.writeFileSync(p,'gap edit');fs.unlinkSync(deleted);const q=path.join(sub,'gap-new.txt');fs.writeFileSync(q,'gap new');listedFiles=[p,q].map(Uri.file);watchExclude=[];
    const read=fs.promises.readdir,entered=deferred(),release=deferred();let first=true;fs.promises.readdir=async(directory,...args)=>{if(directory===dir&&first){first=false;entered.resolve();await release.promise;}return read(directory,...args);};
    const old=tracker.refreshIgnoreMatchers();try{await entered.promise;const newer=tracker.refreshIgnoreMatchers();if(stop)tracker.stopRecording();release.resolve();await Promise.all([old,newer]);if(stop){assert.equal(nativeDirectoryWatchers.filter(w=>w.active).length,0);assert.equal(tracker.pendingImportedDirectoryReconciliation.size,0);return;}assert.equal(pending(p)?.currentContent,'gap edit');assert.equal(pending(deleted)?.isDeleted,true);assert.ok(pending(q));assert.ok(pending(q)?.unavailableReason);assert.equal(tracker.pendingImportedDirectoryReconciliation.size,0);}
    finally{release.resolve();await old;fs.promises.readdir=read;}
});

if(process.env.DT_TEST_FILTER) {const selected=tests.filter(t=>t.name.includes(process.env.DT_TEST_FILTER));tests.splice(0,tests.length,...selected);}
if(process.env.DT_PARENT_ONLY==='1') { const selected=tests.filter(t=>t.name.startsWith('PARENT '));tests.splice(0,tests.length,...selected); }
if(process.env.DT_AUDIT_ONLY==='1') { const selected=tests.filter(t=>t.name.startsWith('AUDIT-'));tests.splice(0,tests.length,...selected); }
if(process.env.DT_KNOWN_P0==='1'||process.env.DT_LEGACY_MANUAL==='1') {tests.splice(stage1Count+4);tests.splice(0,stage1Count+(process.env.DT_LEGACY_MANUAL==='1'?2:0));}
let failures=0;
for(const {name,run} of tests) {
    docs.length=0; watcherInstances.length=0; nativeDirectoryWatchers.length=0; faults.clear(); barriers.clear(); automationOnly=false;watchExclude=[];listedFiles=[];listedIgnores=[];vscodeExcludes={}; tracker=new DiffTracker();
    tracker.isRecording=true; tracker.externalWatcherEnabled=true; tracker.snapshotInitialized=true;
    try { await run(); console.log(`PASS ${name}`); }
    catch(e) { failures++; console.error(`FAIL ${name}\n${e.stack}`); }
    finally { await tracker.dispose(); }
}
fs.rmSync(root,{recursive:true,force:true});
console.log(`${tests.length-failures}/${tests.length} ${process.env.DT_LEGACY_MANUAL==='1'?'historical authorship-inference diagnostics':process.env.DT_KNOWN_P0==='1'?'known-P0 conservative safety probes':'production tracker regressions'} passed (mocked VS Code boundary; not Extension Host).`);
process.exitCode=failures?1:0;
