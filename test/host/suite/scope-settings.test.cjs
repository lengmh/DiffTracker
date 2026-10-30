const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

module.exports = async function scopeSettingsCheckpoint() {
    const workspace = process.env.DIFF_TRACKER_HOST_WORKSPACE;
    const uri = name => vscode.Uri.file(path.join(workspace,name));
    const state = () => vscode.commands.executeCommand('diffTracker._testState');
    const scopeStatus = () => vscode.commands.executeCommand('diffTracker._testMonitoringScopeStatus');
    const trace = [];
    let stage = 'activation';
    const until = async (description,predicate) => {
        const deadline = Date.now()+10_000;
        while (Date.now()<deadline) {
            const result = await predicate();
            if (result) { return result; }
            await new Promise(resolve=>setTimeout(resolve,100));
        }
        throw new Error(`Scope settings Host timed out: ${description}; trace=${JSON.stringify(trace)}`);
    };
    await vscode.extensions.getExtension('lengmh.code-diff-tracker').activate();
    const observe = vscode.workspace.onDidChangeConfiguration(event => {
        const keys = ['monitoringScope','watchInclude','watchExclude'].filter(key=>event.affectsConfiguration(`diffTracker.${key}`));
        if (keys.length) { trace.push({stage,kind:'notification',keys}); }
    });
    const roundTrip = async value => {
        const expected = JSON.stringify(value);
        let timer;
        let listener;
        const publication = new Promise(resolve => {
            timer=setTimeout(()=>resolve(new Error('Real configuration notification did not publish the written value')),5000);
            listener=vscode.workspace.onDidChangeConfiguration(event=>{
                if (event.affectsConfiguration('diffTracker.watchInclude') &&
                    JSON.stringify(vscode.workspace.getConfiguration('diffTracker').inspect('watchInclude').workspaceValue)===expected) {
                    trace.push({stage,kind:'matching-readback'});
                    resolve();
                }
            });
        });
        try {
            await vscode.workspace.getConfiguration('diffTracker').update('watchInclude',value,vscode.ConfigurationTarget.Workspace);
            trace.push({stage,kind:'update-response',matches:JSON.stringify(
                vscode.workspace.getConfiguration('diffTracker').inspect('watchInclude').workspaceValue)===expected});
            const error=await publication;
            if(error){throw error;}
        } finally { clearTimeout(timer);listener.dispose(); }
    };
    try {
        assert.equal((await state()).isRecording,false,'the configuration checkpoint must begin stopped');
        assert.equal(vscode.workspace.getConfiguration('diffTracker').inspect('watchInclude').workspaceValue,undefined,
            'the single-folder fixture must exercise unset-to-empty settings');
        stage='stopped-save';
        const first = await vscode.commands.executeCommand('diffTracker._testSaveAndApplyScope',{
            mode:'rules',includes:[],excludes:[{scope:'all',pattern:'/prior-cache/'},{scope:'all',pattern:'/generated-cache/'}]
        });
        assert.equal(first.status,'applied',JSON.stringify({first,trace}));
        assert.equal(first.scopeCommitted,true);
        assert.equal((await state()).isRecording,false,'saving exclusions must not start recording');
        assert.deepEqual(vscode.workspace.getConfiguration('diffTracker').inspect('watchExclude').workspaceValue,[
            {scope:'all',pattern:'/generated-cache/'},{scope:'all',pattern:'/prior-cache/'}
        ]);
        stage='real-api-include';
        await roundTrip([{scope:'all',path:'watched.txt'}]);
        stage='real-api-withdraw';
        await roundTrip([]);
        const settled = await scopeStatus();
        assert.equal(settled.requested.scope.scopeRevision,settled.effective.scopeRevision);

        assert.equal(await vscode.commands.executeCommand('diffTracker.startRecording'),true);
        await until('initial baseline ready',async()=> (await state()).baselineState==='ready');
        fs.writeFileSync(uri('watched.txt').fsPath,'pending before exclusion\n');
        await until('unrelated pending text',async()=> (await state()).trackedChanges.some(change=>
            change.filePath===uri('watched.txt').fsPath && change.currentContent==='pending before exclusion\n'));
        stage='active-save';
        const active = await vscode.commands.executeCommand('diffTracker._testSaveAndApplyScope',{
            mode:'rules',includes:[],excludes:[{scope:'all',pattern:'/prior-cache/'},
                {scope:'all',pattern:'/generated-cache/'},{scope:'all',pattern:'/second-cache/'}]
        });
        assert.equal(active.status,'applied',JSON.stringify({active,trace}));
        assert.equal(active.scopeCommitted,true);
        const after = await scopeStatus();
        assert.equal(after.requested.scope.scopeRevision,after.effective.scopeRevision);
        assert.equal(await vscode.commands.executeCommand('diffTracker._testOriginalContent',uri('watched.txt').fsPath),'baseline\n');
        assert.equal(fs.readFileSync(uri('second-cache/existing.txt').fsPath,'utf8'),'cache baseline\n');
        fs.writeFileSync(uri('watched.txt').fsPath,'later observed text\n');
        fs.writeFileSync(uri('second-cache/existing.txt').fsPath,'excluded later text\n');
        await until('later real observation',async()=> (await state()).trackedChanges.some(change=>
            change.filePath===uri('watched.txt').fsPath && change.currentContent==='later observed text\n'));
        const final = await state();
        assert.equal(final.isRecording,true);
        assert.equal(final.trackedChanges.some(change=>change.filePath===uri('second-cache/existing.txt').fsPath),false);
        console.log(`PASS HOST-EXCLUDES real single-folder configuration publication and controller Save and Apply: ${JSON.stringify({vscodeVersion:vscode.version,trace})}`);
    } finally { observe.dispose(); }
};
