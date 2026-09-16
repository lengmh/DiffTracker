/** Git context contract tests. Production adapter is loaded with only the VS Code
 * extension boundary faked; no Git commands or repository are mutated here. */
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const repoRoot=mkdtempSync(path.join(os.tmpdir(),'difftracker-adapter-'));
mkdirSync(path.join(repoRoot,'.git'));
import Module, { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

class Emitter {
    handlers=[];
    event=(handler)=>{this.handlers.push(handler);return{dispose:()=>{this.handlers=this.handlers.filter(value=>value!==handler);}}};
    fire(value){for(const handler of [...this.handlers])handler(value);}
}
class Uri { constructor(fsPath){this.fsPath=fsPath;this.scheme='file';} static file(value){return new Uri(value);} }
let installedExtension;
const vscode={Uri,workspace:{workspaceFolders:[{uri:Uri.file(repoRoot)}]},extensions:{getExtension:id=>id==='vscode.git'?installedExtension:undefined}};
const originalLoad=Module._load;
Module._load=function(id,...args){return id==='vscode'?vscode:originalLoad.call(this,id,...args);};
let api;
try { api=require('../out/gitContext.js'); } finally { Module._load=originalLoad; }

const context=(overrides={})=>({
    repoRoot:repoRoot,kind:'repository',headName:'main',headCommit:'aaa',detached:false,inProgress:false,...overrides
});
const tests=[]; const test=(name,run)=>tests.push({name,run});

test('ordinary commit and fast-forward on the same branch remain compatible',()=>{
    assert.deepEqual(api.compareGitContexts(context(),context({headCommit:'bbb'})),{compatible:true});
});
test('same commit on a different branch is a context change',()=>{
    const result=api.compareGitContexts(context(),context({headName:'feature'}));
    assert.equal(result.compatible,false); assert.match(result.reason,/branch/i);
});
test('detached HEAD identity follows its commit',()=>{
    const base=context({headName:undefined,headCommit:'aaa',detached:true});
    assert.equal(api.compareGitContexts(base,context({headName:undefined,headCommit:'aaa',detached:true})).compatible,true);
    assert.equal(api.compareGitContexts(base,context({headName:undefined,headCommit:'bbb',detached:true})).compatible,false);
});
test('merge or rebase conflict state is never treated as stable',()=>{
    assert.equal(api.compareGitContexts(context(),context({inProgress:true})).compatible,false);
});
test('repository snapshot uses public root, kind, HEAD and conflict fields',()=>{
    const repo={rootUri:Uri.file(repoRoot),kind:'worktree',state:{
        HEAD:{name:undefined,commit:'abc'},rebaseCommit:{hash:'r'},mergeChanges:[],onDidChange:()=>({dispose(){}})
    }};
    assert.deepEqual(api.snapshotGitRepository(repo),context({kind:'worktree',headName:undefined,headCommit:'abc',detached:true,inProgress:true}));
});
test('repository snapshot defaults the public vscode.git v1 shape to repository kind',()=>{
    const repo={rootUri:Uri.file(repoRoot),state:{
        HEAD:{name:'main',commit:'abc'},rebaseCommit:undefined,mergeChanges:[],onDidChange:()=>({dispose(){}})
    }};
    assert.deepEqual(api.snapshotGitRepository(repo),context({headCommit:'abc'}));
});
test('monitor uses vscode.git API v1 and reports repository state changes',async()=>{
    const stateChanged=new Emitter(),opened=new Emitter(),closed=new Emitter(),apiState=new Emitter();
    const repo={rootUri:Uri.file(repoRoot),kind:'repository',status:async()=>{},state:{
        HEAD:{name:'main',commit:'aaa'},rebaseCommit:undefined,mergeChanges:[],onDidChange:stateChanged.event
    }};
    const gitApi={state:'initialized',repositories:[repo],onDidChangeState:apiState.event,
        onDidOpenRepository:opened.event,onDidCloseRepository:closed.event};
    installedExtension={isActive:false,async activate(){return{enabled:true,getAPI:version=>{assert.equal(version,1);return gitApi;}};}};
    const events=[]; const monitor=new api.GitContextMonitor(event=>events.push(event));
    assert.equal(await monitor.start(),true); assert.equal(monitor.getSnapshots().length,1);
    repo.state.HEAD={name:'feature',commit:'bbb'}; stateChanged.fire();
    assert.equal(events.at(-1).kind,'changed'); assert.equal(events.at(-1).context.headName,'feature');
    closed.fire(repo); assert.deepEqual(events.at(-1),{kind:'removed',repoRoot:repoRoot});
    monitor.dispose();
});
test('monitor discovers an existing workspace repository before baseline capture',async()=>{
    const opened=new Emitter(),closed=new Emitter(),apiState=new Emitter(),stateChanged=new Emitter();
    const repo={rootUri:Uri.file(repoRoot),kind:'repository',state:{
        HEAD:undefined,rebaseCommit:undefined,mergeChanges:[],onDidChange:stateChanged.event
    }};
    const repositories=[];
    const gitApi={state:'initialized',repositories,onDidChangeState:apiState.event,
        onDidOpenRepository:opened.event,onDidCloseRepository:closed.event,
        async getRepositoryRoot(uri){assert.equal(uri.fsPath,repoRoot);return uri;},
        async openRepository(){repositories.push(repo);return repo;}};
    repo.status=async()=>{repo.state.HEAD={name:'main',commit:'aaa'};};
    installedExtension={isActive:true,exports:{enabled:true,getAPI:()=>gitApi}};
    const events=[];const monitor=new api.GitContextMonitor(event=>events.push(event));
    assert.equal(await monitor.start(),true);assert.equal(monitor.isReady(),true);
    assert.equal(monitor.getSnapshots()[0].headName,'main');assert.deepEqual(events,[]);
    monitor.dispose();
});
test('Git missing or disabled degrades without throwing',async()=>{
    installedExtension=undefined; const monitor=new api.GitContextMonitor(()=>{});
    assert.equal(await monitor.start(),false); assert.deepEqual(monitor.getSnapshots(),[]); monitor.dispose();
});

test('monitor detects clean merge metadata even when the conflict list is empty',async()=>{
    const stateChanged=new Emitter(),opened=new Emitter(),closed=new Emitter(),apiState=new Emitter();
    const repo={rootUri:Uri.file(repoRoot),state:{HEAD:{name:'main',commit:'aaa'},mergeChanges:[],onDidChange:stateChanged.event}};
    installedExtension={isActive:true,exports:{enabled:true,getAPI:()=>({state:'initialized',repositories:[repo],onDidChangeState:apiState.event,onDidOpenRepository:opened.event,onDidCloseRepository:closed.event})}};
    const events=[],monitor=new api.GitContextMonitor(event=>events.push(event));await monitor.start();
    const marker=path.join(repoRoot,'.git','MERGE_HEAD');
    try {
        writeFileSync(marker,'commit');stateChanged.fire();assert.equal(events.at(-1).context.inProgress,true);
        assert.equal(monitor.getSnapshot(repoRoot).inProgress,true);
        rmSync(marker);stateChanged.fire();assert.equal(events.at(-1).context.inProgress,false);
    } finally {rmSync(marker,{force:true});monitor.dispose();}
});
test('relative gitfile resolves worktree-local operation metadata',()=>{
    const root=path.join(repoRoot,'relative'),metadata=path.join(repoRoot,'metadata');mkdirSync(root);mkdirSync(metadata);
    writeFileSync(path.join(root,'.git'),'gitdir: ../metadata\n');
    const repo={rootUri:Uri.file(root),state:{HEAD:{name:'main',commit:'aaa'},mergeChanges:[]}};
    assert.equal(api.snapshotGitRepository(repo).inProgress,false);
    for(const name of ['MERGE_HEAD','rebase-merge','rebase-apply','CHERRY_PICK_HEAD','REVERT_HEAD','sequencer']){
        const marker=path.join(metadata,name);writeFileSync(marker,'pending');
        assert.equal(api.snapshotGitRepository(repo).inProgress,true,name);rmSync(marker);
    }
});
test('invalid or unavailable git metadata fails closed',()=>{
    const root=path.join(repoRoot,'invalid');mkdirSync(root);
    const repo={rootUri:Uri.file(root),state:{HEAD:{name:'main',commit:'aaa'},mergeChanges:[]}};
    assert.equal(api.snapshotGitRepository(repo).inProgress,true);
    writeFileSync(path.join(root,'.git'),'invalid');assert.equal(api.snapshotGitRepository(repo).inProgress,true);
    writeFileSync(path.join(root,'.git'),'gitdir: ../missing\n');assert.equal(api.snapshotGitRepository(repo).inProgress,true);
});
let failures=0;
for(const {name,run} of tests){try{await run();console.log(`PASS ${name}`);}catch(error){failures++;console.error(`FAIL ${name}\n${error.stack}`);}}
console.log(`${tests.length-failures}/${tests.length} production Git-context adapter tests passed (VS Code Git API boundary mocked).`);
rmSync(repoRoot,{recursive:true,force:true});
process.exitCode=failures?1:0;
