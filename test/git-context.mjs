/** Git context contract tests. Production adapter is loaded with only the VS Code
 * extension boundary faked; no Git commands or repository are mutated here. */
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

class Emitter {
    handlers=[];
    event=(handler)=>{this.handlers.push(handler);return{dispose:()=>{this.handlers=this.handlers.filter(value=>value!==handler);}}};
    fire(value){for(const handler of [...this.handlers])handler(value);}
}
class Uri { constructor(fsPath){this.fsPath=fsPath;this.scheme='file';} static file(value){return new Uri(value);} }
let installedExtension;
const vscode={Uri,extensions:{getExtension:id=>id==='vscode.git'?installedExtension:undefined}};
const originalLoad=Module._load;
Module._load=function(id,...args){return id==='vscode'?vscode:originalLoad.call(this,id,...args);};
let api;
try { api=require('../out/gitContext.js'); } finally { Module._load=originalLoad; }

const context=(overrides={})=>({
    repoRoot:'/workspace/repo',kind:'repository',headName:'main',headCommit:'aaa',detached:false,inProgress:false,...overrides
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
    const repo={rootUri:Uri.file('/workspace/repo'),kind:'worktree',state:{
        HEAD:{name:undefined,commit:'abc'},rebaseCommit:{hash:'r'},mergeChanges:[],onDidChange:()=>({dispose(){}})
    }};
    assert.deepEqual(api.snapshotGitRepository(repo),context({kind:'worktree',headName:undefined,headCommit:'abc',detached:true,inProgress:true}));
});
test('monitor uses vscode.git API v1 and reports repository state changes',async()=>{
    const stateChanged=new Emitter(),opened=new Emitter(),closed=new Emitter(),apiState=new Emitter();
    const repo={rootUri:Uri.file('/workspace/repo'),kind:'repository',state:{
        HEAD:{name:'main',commit:'aaa'},rebaseCommit:undefined,mergeChanges:[],onDidChange:stateChanged.event
    }};
    const gitApi={state:'initialized',repositories:[repo],onDidChangeState:apiState.event,
        onDidOpenRepository:opened.event,onDidCloseRepository:closed.event};
    installedExtension={isActive:false,async activate(){return{enabled:true,getAPI:version=>{assert.equal(version,1);return gitApi;}};}};
    const events=[]; const monitor=new api.GitContextMonitor(event=>events.push(event));
    assert.equal(await monitor.start(),true); assert.equal(monitor.getSnapshots().length,1);
    repo.state.HEAD={name:'feature',commit:'bbb'}; stateChanged.fire();
    assert.equal(events.at(-1).kind,'changed'); assert.equal(events.at(-1).context.headName,'feature');
    closed.fire(repo); assert.deepEqual(events.at(-1),{kind:'removed',repoRoot:'/workspace/repo'});
    monitor.dispose();
});
test('Git missing or disabled degrades without throwing',async()=>{
    installedExtension=undefined; const monitor=new api.GitContextMonitor(()=>{});
    assert.equal(await monitor.start(),false); assert.deepEqual(monitor.getSnapshots(),[]); monitor.dispose();
});

let failures=0;
for(const {name,run} of tests){try{await run();console.log(`PASS ${name}`);}catch(error){failures++;console.error(`FAIL ${name}\n${error.stack}`);}}
console.log(`${tests.length-failures}/${tests.length} production Git-context adapter tests passed (VS Code Git API boundary mocked).`);
process.exitCode=failures?1:0;
