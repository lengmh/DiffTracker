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
    const {DiffTracker}=require('../../../out/diffTracker.js');
    const wrapped=new Map();
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
    const configurationSources=()=>({
        workspace:vscode.workspace.getConfiguration('diffTracker').inspect('watchExclude').workspaceValue,
        folder:vscode.workspace.getConfiguration('diffTracker',vscode.workspace.workspaceFolders[0].uri)
            .inspect('watchExclude').workspaceFolderValue
    });
    for(const method of ['prepareOwnedScopeSettings','recordBaselineTransactionEvent','commitPreparedScopePersistence']){
        const original=DiffTracker.prototype[method];wrapped.set(method,original);
        DiffTracker.prototype[method]=function(...args){
            const transaction=this.baselineTransaction;
            const enabled=method!=='recordBaselineTransactionEvent'||!!transaction;
            const details=()=>({epoch:this.sessionEpoch,ignoreRevision:this.ignorePolicyRevision,
                ignoreRefresh:this.ignoreRefreshVersion,scope:this.getEffectiveMonitoringScope().scopeRevision,
                proof:method==='prepareOwnedScopeSettings'?this.settledScopeSettings.has(args[0]):!!transaction?.settledSettingsWrite,
                events:[...(transaction?.observedEvents?.values()??[])].map(event=>({
                    kind:event.kind,path:path.relative(workspace,event.uri.fsPath).startsWith('..')?'outside fixture':path.relative(workspace,event.uri.fsPath)
                }))});
            const entry=enabled&&trace.length<64?{stage,kind:method,before:details()}:undefined;
            if(entry){trace.push(entry);}
            if(method==='recordBaselineTransactionEvent'){
                const result=original.apply(this,args);if(entry){entry.after=details();}return result;
            }
            return Promise.resolve(original.apply(this,args)).finally(()=>{if(entry){entry.after=details();}});
        };
    }
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
        trace.push({stage,kind:'sources-before',...configurationSources()});
        const first = await vscode.commands.executeCommand('diffTracker._testSaveAndApplyScope',{
            mode:'rules',includes:[],excludes:[{scope:'all',pattern:'/prior-cache/'},{scope:'all',pattern:'/generated-cache/'}]
        });
        trace.push({stage,kind:'sources-after',...configurationSources()});
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
        stage='active-shortcut';
        const shortcut=await vscode.commands.executeCommand('diffTracker.excludeResource',uri('quick-cache'));
        assert.equal(shortcut.status,'applied',JSON.stringify({shortcut,trace}));
        assert.equal(shortcut.scopeCommitted,true);
        const quickStatus=await scopeStatus();
        assert.equal(quickStatus.requested.scope.scopeRevision,quickStatus.effective.scopeRevision);
        assert.ok(quickStatus.effective.excludes.some(rule=>rule.pattern==='/quick-cache/'));

        stage='apply-saved-request';
        const savedExcludes=[...quickStatus.effective.excludes,{scope:'all',pattern:'/saved-cache/'}];
        await vscode.workspace.getConfiguration('diffTracker').update('watchExclude',savedExcludes,vscode.ConfigurationTarget.Workspace);
        const savedConfirmation=await vscode.commands.executeCommand('diffTracker._testApplyMonitoringScope');
        assert.equal(savedConfirmation.status,'needsDiscardConfirmation',JSON.stringify({savedConfirmation,trace}));
        assert.deepEqual(savedConfirmation.affectedReviewPaths,[uri('saved-cache/existing.txt').fsPath]);
        assert.equal((await scopeStatus()).effective.scopeRevision,quickStatus.effective.scopeRevision,
            'manual pending settings cannot commit before the bound review confirmation');
        const appliedSaved=await vscode.commands.executeCommand('diffTracker._testApplyMonitoringScope',{
            discardExplicitlyExcludedReviews:true,expectedScopeRevision:savedConfirmation.scopeRevision,
            expectedAffectedReviewRevision:savedConfirmation.affectedReviewRevision
        });
        assert.equal(appliedSaved.status,'applied',JSON.stringify({appliedSaved,trace}));
        const appliedStatus=await scopeStatus();
        assert.equal(appliedStatus.requested.scope.scopeRevision,appliedStatus.effective.scopeRevision);

        stage='restore-saved-request';
        await vscode.workspace.getConfiguration('diffTracker').update('watchExclude',
            [...savedExcludes,{scope:'all',pattern:'/temporary-draft/'}],vscode.ConfigurationTarget.Workspace);
        const restored=await vscode.commands.executeCommand('diffTracker._testRestoreEffectiveScope');
        assert.equal(restored.status,'restored',JSON.stringify({restored,trace}));
        const restoredStatus=await scopeStatus();
        assert.equal(restoredStatus.requested.scope.scopeRevision,appliedStatus.effective.scopeRevision);
        assert.equal(restoredStatus.effective.scopeRevision,appliedStatus.effective.scopeRevision);
        assert.equal(await vscode.commands.executeCommand('diffTracker._testOriginalContent',uri('watched.txt').fsPath),'baseline\n');
        assert.equal(fs.readFileSync(uri('second-cache/existing.txt').fsPath,'utf8'),'cache baseline\n');
        fs.writeFileSync(uri('watched.txt').fsPath,'later observed text\n');
        fs.writeFileSync(uri('second-cache/existing.txt').fsPath,'excluded later text\n');
        fs.writeFileSync(uri('quick-cache/existing.txt').fsPath,'excluded shortcut text\n');
        fs.writeFileSync(uri('saved-cache/existing.txt').fsPath,'excluded saved request text\n');
        await until('later real observation',async()=> (await state()).trackedChanges.some(change=>
            change.filePath===uri('watched.txt').fsPath && change.currentContent==='later observed text\n'));
        const final = await state();
        assert.equal(final.isRecording,true);
        assert.equal(final.trackedChanges.some(change=>change.filePath===uri('second-cache/existing.txt').fsPath),false);
        for(const folder of ['quick-cache','saved-cache']){
            assert.equal(final.trackedChanges.some(change=>change.filePath===uri(`${folder}/existing.txt`).fsPath),false);
        }
        console.log(`PASS HOST-EXCLUDES real configuration Save and Apply, shortcut, Apply Saved Request, Restore and continued observation: ${JSON.stringify({vscodeVersion:vscode.version,trace})}`);
    } finally { observe.dispose();for(const [method,original] of wrapped){DiffTracker.prototype[method]=original;} }
};
