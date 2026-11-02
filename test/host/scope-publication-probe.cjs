// Test-only, opt-in observation of the original configuration API calls.
// No notification is delayed, replayed, suppressed or converted to success.
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');

exports.observeScopePublication=vscode=>{
    if(process.env.DIFF_TRACKER_HOST_TRACE_PUBLICATION!=='1'){
        return {configuration:section=>vscode.workspace.getConfiguration(section),finish:()=>{}};
    }
    const started=Date.now(),trace=[];
    const target=vscode.workspace.workspaceFile.fsPath;
    let closed=false;
    const folders=()=>vscode.workspace.workspaceFolders?.map(folder=>folder.name)??[];
    const disk=()=>{
        try{
            const bytes=fs.readFileSync(target);let parsed;
            try{parsed=JSON.parse(bytes);}catch{/* Record invalid/empty data without its contents. */}
            return {bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),folders:parsed?.folders?.length};
        }catch(error){return {error:error.code};}
    };
    const push=(kind,data)=>{if(!closed&&trace.length<400){trace.push({ms:Date.now()-started,kind,...data});}};
    const listeners=[
        vscode.workspace.onDidChangeWorkspaceFolders(event=>push('folders',{
            added:event.added.map(folder=>folder.name),removed:event.removed.map(folder=>folder.name),current:folders(),disk:disk()
        })),
        vscode.workspace.onDidChangeConfiguration(event=>{
            if(['diffTracker.watchInclude','files.watcherExclude'].some(key=>event.affectsConfiguration(key))){
                push('configuration',{folders:folders(),disk:disk()});
            }
        })
    ];
    const watcher=fs.watch(path.dirname(target),{persistent:false},(kind,name)=>{
        if(String(name)===path.basename(target)){push('disk',{event:kind,...disk()});}
    });
    return {
        configuration(section){
            const configuration=vscode.workspace.getConfiguration(section);
            // VS Code freezes its configuration object. Delegate through an
            // empty target rather than replacing its read-only update member.
            return new Proxy({},{get(_target,key){
                if(key==='update')return async(setting,value,target,override)=>{
                    if(closed){return configuration.update(setting,value,target,override);}
                    push('api-start',{section,setting,value,folders:folders(),disk:disk()});
                    try{return await configuration.update(setting,value,target,override);}
                    finally{push('api-end',{section,setting,folders:folders(),disk:disk()});}
                };
                const value=configuration[key];return typeof value==='function'?value.bind(configuration):value;
            }});
        },
        finish(){
            if(closed){return;}
            closed=true;watcher.close();for(const listener of listeners){listener.dispose();}
            console.log('HOST-SCOPE-PUBLICATION',JSON.stringify({version:vscode.version,trace}));
        }
    };
};
