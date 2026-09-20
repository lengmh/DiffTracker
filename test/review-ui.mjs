import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';

// Production TypeScript and its generated inline script run unchanged. Only the
// VS Code API, DOM, and renderer boundaries are stubs; no tracker/UI logic is copied.
const require = createRequire(import.meta.url);
const filePath = '/workspace/研究 folder/empty.m';
const reviewToken={filePath,epoch:1,baselineRevision:'base',currentRevision:'current'};
const opaqueReviewToken={filePath,epoch:1,reviewRevision:'opaque-current'};
function harness(change = { filePath, fileName: 'empty.m', originalContent: '', currentContent: '' }) {
    const messages = [];
    const commands = [];
    const state = { changes: change ? [change] : [], result: { status: 'success' }, error: undefined };
    const vscode = {
        Uri: {
            file: value => ({ fsPath: value }),
            joinPath: (uri, ...parts) => ({ toString: () => [uri.fsPath, ...parts].join('/') })
        },
        EventEmitter: class { event() {} fire() {} dispose() {} },
        TreeItem: class { constructor(label) { this.label = label; } },
        TreeItemCollapsibleState: { None: 0, Expanded: 2 },
        Range:class {constructor(...args){this.args=args;}},
        CodeLens:class {constructor(range,command){Object.assign(this,{range,command});}},
        ThemeIcon: class { static File = 'file'; },
        ColorThemeKind: { Light: 1 },
        window: { activeColorTheme: { kind: 1 } },
        workspace: { textDocuments: [], workspaceFolders: [], getWorkspaceFolder: () => undefined,getConfiguration:()=>({get:(_k,f)=>f}) },
        commands: { async executeCommand(...args) {
            commands.push(args);
            if (state.error) { throw state.error; }
            if(state.gate) await state.gate;
            return state.result;
        } }
    };
    const cache = new Map();
    function load(relative) {
        const filename = path.resolve('src', relative);
        if (cache.has(filename)) { return cache.get(filename); }
        const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
        }).outputText;
        const module = { exports: {} };
        cache.set(filename, module.exports);
        vm.runInNewContext(output, {
            module, exports: module.exports, process, console,
            require: name => name === 'vscode' ? vscode
                : name.startsWith('.') ? load(path.relative(path.resolve('src'), path.resolve(path.dirname(filename), name + '.ts')))
                : require(name)
        }, { filename });
        return module.exports;
    }
    const tracker = {
        getTrackedChanges: () => state.changes,
        getOriginalContent: () => '',
        getChangeBlocks: () => [],
        getBaselineState: () => 'ready'
        ,getReviewToken:()=> {
            const change = state.changes[0];
            return change && change.reviewKind && change.reviewKind !== 'text' ? undefined : reviewToken;
        },getReviewTokens:()=> {
            const change = state.changes[0];
            return change && change.reviewKind && change.reviewKind !== 'text' ? [] : [reviewToken];
        },getOpaqueReviewToken:()=> {
            const change = state.changes[0];
            return change?.reviewKind === 'opaque' ? opaqueReviewToken : undefined;
        },getOpaqueReviewTokens:()=> {
            const change = state.changes[0];
            return change?.reviewKind === 'opaque' ? [opaqueReviewToken] : [];
        },getUnknownReviewPaths:()=> {
            const change = state.changes[0];
            return change?.reviewKind === 'unknown' ? [filePath] : [];
        },getIsRecording:()=>true,
        onDidTrackChanges:()=>({dispose(){}})
    };
    const panel = Object.create(load('webviewDiffPanel.ts').WebviewDiffPanel.prototype);
    Object.assign(panel, {
        filePath, diffTracker: tracker, extensionUri: { fsPath: '/extension' },
        currentStyle: 'split', currentWrap: false, currentExpandAll: false,
        disposed:false,viewGeneration:0,seenRequests:new Set(),activeRequest:undefined,disposables:[],
        panel: { dispose(){},webview: { postMessage: value => messages.push(value), asWebviewUri: uri => uri, cspSource: 'test-source' } }
    });
    return { panel, tracker, state, messages, commands, load };
}

function runInline(html) {
    class Element {
        children = [];
        listeners = {};
        disabled = false;
        textContent = '';
        classList = { toggle() {} };
        set innerHTML(value) { this.html = value; this.children = []; }
        get innerHTML() { return this.html ?? ''; }
        addEventListener(event, handler) { this.listeners[event] = handler; }
        appendChild(child) { this.children.push(child); }
        querySelectorAll() { return []; }
    }
    const elements = new Map();
    const listeners = {};
    const sent = [];
    let rendererCalls = 0;
    const rendererOptions=[];
    const window = {
        PierreDiffs: {
            FileDiff: class { constructor(options){rendererOptions.push(options);} render() { rendererCalls++; } cleanUp(){} },
            parseDiffFromFile: () => ({ hunks: [] })
        },
        addEventListener: (event, handler) => { listeners[event] = handler; }
    };
    const document = {
        getElementById(id) {
            if (!elements.has(id)) { elements.set(id, new Element()); }
            return elements.get(id);
        },
        createElement: () => new Element()
    };
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 1);
    vm.runInNewContext(scripts[0][1], {
        window, document, acquireVsCodeApi: () => ({ postMessage: value => sent.push(value) }),
        console: { debug() {}, warn() {} }
    }, { filename: 'production-webview-inline.js' });
    return {
        elements, sent, rendererOptions,rendererCalls: () => rendererCalls,
        receive: message => listeners.message({ data: message }),
        notice: () => elements.get('diff-container').children.map(child => child.textContent).join(''),
        click: id => elements.get(id).listeners.click()
    };
}

let count = 0;
async function test(name, fn) {
    await fn();
    count++;
    console.log(`PASS ${name}`);
}

for (const status of ['success', 'failed', 'conflict', 'cancelled', undefined]) {
    await test(`production action ack reports ${status ?? 'missing result'} and refreshes after ack`, async () => {
        const h = harness();
        h.state.result = status ? { status, filePath, reason: status === 'success' ? undefined : 'controlled reason' } : undefined;
        await h.panel.handleMessage({ command: 'keepAll', filePath, requestId: 'r1',reviewToken,viewGeneration:0 });
        assert.equal(h.commands.length, 1);
        assert.equal(h.commands[0][0], 'diffTracker.keepAllBlocksInFile');
        assert.equal(h.commands[0][1], filePath);
        assert.deepEqual(h.messages.map(message => message.command), ['actionAck', 'updateData']);
        assert.equal(h.messages[0].ok, status === 'success');
        assert.equal(h.messages[0].status, status ?? 'failed');
        assert.equal(h.messages[0].requestId, 'r1');
        if (status !== 'success') { assert.ok(h.messages[0].error); }
        else { assert.equal(h.messages[0].error, undefined); }
    });
}

await test('failed save preserves bufferChanged and concrete reason in ack', async () => {
    const h = harness();
    h.state.result = { status: 'failed', filePath, bufferChanged: true, reason: 'Buffer changed; disk save returned false' };
    await h.panel.handleMessage({ command: 'revertAll', filePath, requestId: 'save',reviewToken,viewGeneration:0 });
    assert.equal(h.messages[0].ok, false);
    assert.equal(h.messages[0].bufferChanged, true);
    assert.equal(h.messages[0].error, h.state.result.reason);
    assert.equal(h.messages[1].hasFileChange, true);
});

await test('command exception is a failed ack followed by current state', async () => {
    const h = harness();
    h.state.error = new Error('Permission denied');
    await h.panel.handleMessage({ command: 'revertBlock', filePath, requestId: 'error', changeBlockId: 'b1',reviewToken,viewGeneration:0 });
    assert.equal(h.commands[0][2], 'b1');
    assert.equal(h.messages[0].ok, false);
    assert.match(h.messages[0].error, /Permission denied/);
    assert.equal(h.messages[1].command, 'updateData');
});

await test('wrong resource, removed target and absent block ref never execute mutations', async () => {
    for (const kind of ['wrongPath', 'removed', 'missingBlock']) {
        const h = harness();
        if (kind === 'removed') { h.state.changes = []; }
        await h.panel.handleMessage({ command: kind === 'missingBlock' ? 'keepBlock' : 'keepAll',
            filePath: kind === 'wrongPath' ? '/other.m' : filePath, requestId: kind,reviewToken,viewGeneration:0 });
        assert.equal(h.commands.length, 0, kind);
        assert.equal(h.messages.length, kind==='wrongPath'?0:2, kind);
        if(kind==='wrongPath') continue;
        assert.equal(h.messages[0].ok, false, kind);
        assert.match(h.messages[0].error, /unavailable/, kind);
    }
});

for (const isDeleted of [false, true]) {
    await test(`empty file ${isDeleted ? 'deletion' : 'creation'} remains reviewable in payload and generated DOM`, () => {
        const h = harness({ filePath, fileName: 'empty.m', originalContent: '', currentContent: '', isDeleted });
        h.panel.sendDataUpdate();
        const payload = h.messages[0];
        assert.equal(payload.hasFileChange, true);
        assert.equal(payload.isDeleted, isDeleted);
        assert.equal(payload.oldContents, '');
        assert.equal(payload.newContents, '');
        assert.equal(payload.changeBlocks.length, 0);
        const ui = runInline(h.panel.getHtmlContent());
        assert.match(ui.notice(), isDeleted ? /Empty file deleted/ : /Empty file created/);
        assert.equal(ui.elements.get('btn-keep-all').disabled, false);
        assert.equal(ui.elements.get('btn-reject-all').disabled, false);
        assert.equal(ui.rendererCalls(), 0, 'empty file state should not require a text hunk');
        ui.click('btn-keep-all');
        const request = ui.sent[0];
        assert.equal(request.filePath, filePath);
        assert.equal(request.command, 'keepAll');
        assert.equal(ui.elements.get('btn-keep-all').disabled, true);
        assert.deepEqual(JSON.parse(JSON.stringify(request.reviewToken)),reviewToken);
        ui.receive({ command: 'actionAck', requestId: request.requestId, ok: true,filePath,viewGeneration:0 });
        assert.equal(ui.elements.get('btn-keep-all').disabled, true, 'wait for refreshed state after success');
        ui.receive({ ...payload, hasFileChange: false });
        assert.match(ui.elements.get('diff-container').innerHTML, /No changes detected/);
        assert.equal(ui.elements.get('btn-keep-all').disabled, true, 'review completed, no pending target');
    });
}

await test('unknown state is visible in generated DOM, tree and incremental payload', async () => {
    const reason = 'Permission denied <restricted>';
    const h = harness({ filePath, fileName: 'empty.m', originalContent: '', currentContent: '', unavailableReason: reason });
    h.panel.sendDataUpdate();
    assert.equal(h.messages[0].unavailableReason, reason);
    const ui = runInline(h.panel.getHtmlContent());
    assert.equal(ui.notice(), `Review status unknown: ${reason}`);
    assert.equal(ui.elements.get('btn-keep-all').disabled, true);
    assert.equal(ui.elements.get('btn-reject-all').disabled, true);
    const tree = new (h.load('diffTreeView.ts').DiffTreeDataProvider)(h.tracker);
    const leaf = (await tree.getChildren()).find(item => item.filePath === filePath);
    assert.match(leaf.description, /Unknown · Permission denied/);
    assert.ok(leaf.tooltip.includes(reason));
    // Recovery comes from authoritative updateData and re-enables file actions.
    ui.receive({ ...h.messages[0], reviewKind: 'text', reviewReason: undefined, unavailableReason: undefined });
    assert.match(ui.notice(), /Empty file created/);
    assert.equal(ui.elements.get('btn-keep-all').disabled, false);
});

await test('opaque file review is visible, read-only and carries identity metadata', async () => {
    const fingerprint = 'a'.repeat(64);
    const h = harness({
        filePath,
        fileName: 'image.png',
        originalContent: '',
        currentContent: '',
        isDeleted: false,
        reviewKind: 'opaque',
        reviewReason: 'Read-only unsupported file was created after the baseline',
        baselineExists: false,
        currentExists: true,
        currentSize: 6,
        currentFingerprint: fingerprint,
        changes: []
    });
    h.panel.sendDataUpdate();
    const payload = h.messages[0];
    assert.equal(payload.reviewKind, 'opaque');
    assert.equal(payload.reviewToken, undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(payload.opaqueReviewToken)),opaqueReviewToken);
    assert.equal(payload.currentSize, 6);
    assert.equal(payload.currentFingerprint, fingerprint);

    const ui = runInline(h.panel.getHtmlContent());
    assert.match(ui.notice(), /Read-only file change:/);
    assert.match(ui.notice(), /Baseline: missing/);
    assert.match(ui.notice(), /Current: exists \(6 B\)/);
    assert.equal(ui.elements.get('btn-keep-all').disabled, false);
    assert.equal(ui.elements.get('btn-keep-all').textContent, 'Acknowledge');
    assert.equal(ui.elements.get('btn-reject-all').disabled, true);
    assert.equal(ui.rendererCalls(), 0);
    ui.click('btn-keep-all');
    assert.equal(ui.sent[0].command,'acknowledge');
    assert.equal(ui.sent[0].reviewToken,null);
    assert.deepEqual(JSON.parse(JSON.stringify(ui.sent[0].opaqueReviewToken)),opaqueReviewToken);

    const tree = new (h.load('diffTreeView.ts').DiffTreeDataProvider)(h.tracker);
    const root = await tree.getChildren();
    const leaf = root.find(item => item.filePath === filePath);
    assert.match(leaf.description, /Read-only · Added · 6 B/);
    assert.equal(leaf.contextValue, 'opaqueFile');
    assert.ok(leaf.tooltip.includes(fingerprint));
    assert.equal(leaf.reviewToken, undefined);
});

await test('opaque acknowledgement routes through the production command with the captured opaque token',async()=>{
    const h=harness({
        filePath,fileName:'image.png',originalContent:'',currentContent:'',isDeleted:false,
        reviewKind:'opaque',reviewReason:'read-only',baselineExists:false,currentExists:true,
        currentSize:3,currentFingerprint:'b'.repeat(64),changes:[]
    });
    await h.panel.handleMessage({
        command:'acknowledge',filePath,requestId:'opaque-ack',
        opaqueReviewToken,viewGeneration:0
    });
    assert.equal(h.commands.length,1);
    assert.equal(h.commands[0][0],'diffTracker.acknowledgeOpaqueChange');
    assert.equal(h.commands[0][1],filePath);
    assert.deepEqual(JSON.parse(JSON.stringify(h.commands[0][2])),opaqueReviewToken);
    assert.deepEqual(h.messages.map(message=>message.command),['actionAck','updateData']);
});
await test('failed acknowledgement unlocks the generated UI while pending file remains reviewable', () => {
    const h = harness();
    const ui = runInline(h.panel.getHtmlContent());
    ui.click('btn-reject-all');
    assert.equal(ui.elements.get('btn-reject-all').disabled, true);
    ui.receive({ command: 'actionAck', requestId: ui.sent[0].requestId, ok: false, error: 'Save failed', bufferChanged: true,filePath,viewGeneration:0 });
    assert.equal(ui.elements.get('btn-reject-all').disabled, false);
    assert.match(ui.notice(), /Empty file created/);
});

await test('OriginalContentProvider distinguishes empty baseline from absent baseline', () => {
    const h = harness();
    const provider = Object.create(h.load('originalContentProvider.ts').OriginalContentProvider.prototype);
    let result = '';
    provider.diffTracker = { getOriginalContent: actual => { assert.equal(actual, filePath); return result; } };
    assert.equal(provider.provideTextDocumentContent({ fsPath: filePath }), '');
    result = undefined;
    assert.equal(provider.provideTextDocumentContent({ fsPath: filePath }), '// Original content not available');
});
for(const end of ['switch','dispose']) await test(`late action acknowledgement is suppressed after ${end}`,async()=>{
    const h=harness();let release;h.state.gate=new Promise(r=>release=r);
    const operation=h.panel.handleMessage({command:'keepAll',filePath,requestId:'late',reviewToken,viewGeneration:0});
    assert.equal(h.commands.length,1);
    if(end==='dispose')h.panel.dispose();else {h.panel.update('/other.m');h.messages.length=0;}
    release();await operation;assert.equal(h.messages.length,0);
});
await test('duplicate request IDs execute production command once and stale generation executes none',async()=>{
    const h=harness();let release;h.state.gate=new Promise(r=>release=r);
    const request={command:'keepAll',filePath,requestId:'same',reviewToken,viewGeneration:0};
    const operation=h.panel.handleMessage(request);await h.panel.handleMessage(request);
    await h.panel.handleMessage({...request,requestId:'old',viewGeneration:-1});
    assert.equal(h.commands.length,1);assert.equal(h.commands[0][2],reviewToken);
    release();await operation;await h.panel.handleMessage(request);assert.equal(h.commands.length,1);
});
await test('old acknowledgement cannot unlock a new DOM request',()=>{
    const h=harness(),ui=runInline(h.panel.getHtmlContent());ui.click('btn-keep-all');
    ui.receive({command:'actionAck',requestId:ui.sent[0].requestId,ok:false,filePath,viewGeneration:-1});
    assert.equal(ui.elements.get('btn-keep-all').disabled,true);
    ui.receive({command:'actionAck',requestId:ui.sent[0].requestId,ok:false,filePath,viewGeneration:0});
    assert.equal(ui.elements.get('btn-keep-all').disabled,false);
});
await test('mid-action authoritative update keeps DOM busy until completion update',()=>{
    const h=harness(),ui=runInline(h.panel.getHtmlContent());ui.click('btn-keep-all');
    h.panel.activeRequest='active';h.panel.sendDataUpdate();ui.receive(h.messages[0]);
    assert.equal(ui.elements.get('btn-keep-all').disabled,true);
    ui.receive({...h.messages[0],mutationBusy:false});assert.equal(ui.elements.get('btn-keep-all').disabled,false);
});
await test('CodeLens and tree carry captured review tokens for block/file/batch actions',async()=>{
    const h=harness();h.tracker.getChangeBlocks=()=>[{blockId:'block',startLine:1,endLine:1}];
    const provider=new (h.load('codeLensProvider.ts').DiffCodeLensProvider)(h.tracker);
    const lenses=provider.provideCodeLenses({uri:{scheme:'file',fsPath:filePath},version:1},{});
    for(const lens of lenses.filter(v=>/keep|revert/i.test(v.command.command))) assert.equal(lens.command.arguments.at(-1),reviewToken);
    const tree=new (h.load('diffTreeView.ts').DiffTreeDataProvider)(h.tracker),items=await tree.getChildren();
    assert.equal(items.find(i=>i.filePath===filePath).reviewToken,reviewToken);
    for(const item of items.filter(i=>/^(diffTracker.keepAllChanges|diffTracker.revertAllChanges)$/.test(i.command?.command))) {
        assert.equal(item.command.arguments,undefined,'mixed root actions capture text/opaque/unknown state at invocation');
    }
});
await test('detached old annotation button sends its captured old review token',()=>{
    const h=harness({filePath,fileName:'empty.m',originalContent:'before',currentContent:'after'});
    const ui=runInline(h.panel.getHtmlContent());
    const wrapper=ui.rendererOptions[0].renderAnnotation({metadata:{blockId:'old-block',blockIndex:0}});
    h.panel.sendDataUpdate();const next={...reviewToken,currentRevision:'new'};
    ui.receive({...h.messages[0],reviewToken:next,newContents:'later'});
    wrapper.children[1].listeners.click({stopPropagation(){}});
    assert.equal(ui.sent[0].reviewToken.currentRevision,'current');assert.equal(ui.sent[0].changeBlockId,'old-block');
});
function commandHarness(options={}) {
    const state={deleted:true,mode:'splitOriginalWebview',recording:false,resetResult:true,confirmClear:true,opened:0,panels:0,resets:0,legacyClears:0,info:[],warnings:[],prompts:[],...options};
    const source=ts.createSourceFile('extension.ts',fs.readFileSync('src/extension.ts','utf8'),ts.ScriptTarget.Latest,true);
    const helpers=[],callbacks=[];
    const names=new Set(['diffTracker.openDiffDefault','diffTracker.showOriginalAndWebviewSplit','diffTracker.showWebviewDiff','diffTracker.clearDiffs']);
    function visit(node){
        if(ts.isFunctionDeclaration(node)&&['extractFilePath','extractIsDeleted','getDefaultOpenMode','isDeletedReview'].includes(node.name?.text))helpers.push(node.getText(source));
        if(ts.isCallExpression(node)&&node.expression.getText(source)==='vscode.commands.registerCommand'&&names.has(node.arguments[0]?.text))callbacks.push(`${JSON.stringify(node.arguments[0].text)}:${node.arguments[1].getText(source)}`);
        ts.forEachChild(node,visit);
    }
    visit(source);
    class Uri {constructor(fsPath){this.fsPath=fsPath;}static file(p){return new Uri(p);}}
    let sandbox;
    const vscode={Uri,ViewColumn:{One:1,Two:2},
        workspace:{getConfiguration:()=>({get:()=>state.mode}),openTextDocument:async()=>{state.opened++;if(state.deleted)throw Object.assign(new Error('FileNotFound'),{code:'FileNotFound'});return{};}},
        window:{
            showTextDocument:async()=>{},
            showInformationMessage:m=>state.info.push(m),
            showWarningMessage:(message,...args)=>{
                const modal=args.find(value=>value&&typeof value==='object'&&value.modal===true);
                if(modal){
                    state.prompts.push({message,args});
                    if(state.toggleRecordingOnConfirm) state.recording=!state.recording;
                    return state.confirmClear?'Clear Diffs':undefined;
                }
                state.warnings.push(message);
                return undefined;
            }
        },
        commands:{executeCommand:async(name,...args)=>sandbox.callbacks[name](...args)}};
    const tracker={getTrackedChanges:()=>[{filePath,isDeleted:state.deleted}],getIsRecording:()=>state.recording,
        resetBaselineToCurrentState:async()=>{state.resets++;return state.resetResult;},clearDiffs:()=>{state.legacyClears++;}};
    sandbox={vscode,diffTracker:tracker,context:{extensionUri:{}},WebviewDiffPanel:{createOrShow:()=>state.panels++},
        refreshChangesTree:()=>{},decorationManager:{clearAllDecorations:()=>{}},console};
    vm.createContext(sandbox);
    vm.runInContext(ts.transpileModule(`${helpers.join('\n')}globalThis.callbacks={${callbacks.join(',')}};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,sandbox);
    return {state,run:(name,...args)=>sandbox.callbacks[name](...args)};
}
for(const command of ['diffTracker.openDiffDefault','diffTracker.showOriginalAndWebviewSplit'])await test(`deleted-file ${command} opens a panel without opening a missing resource`,async()=>{
    const h=commandHarness();await h.run(command,filePath);assert.equal(h.state.opened,0);assert.equal(h.state.panels,1);
});
await test('current deleted review overrides a stale non-deleted tree item',async()=>{
    const h=commandHarness();await h.run('diffTracker.openDiffDefault',{filePath,isDeleted:false});assert.equal(h.state.opened,0);assert.equal(h.state.panels,1);
});
await test('existing file split still opens its editor and panel',async()=>{
    const h=commandHarness({deleted:false});await h.run('diffTracker.showOriginalAndWebviewSplit',filePath);assert.equal(h.state.opened,1);assert.equal(h.state.panels,1);
});
for(const recording of [false,true])for(const success of [false,true])await test(`clear command confirms and awaits durable result (recording=${recording}, success=${success})`,async()=>{
    const h=commandHarness({recording,resetResult:success});await h.run('diffTracker.clearDiffs');
    assert.equal(h.state.prompts.length,1);assert.equal(h.state.resets,1);assert.equal(h.state.legacyClears,0);
    assert.equal(h.state.info.length,success?1:0);assert.equal(h.state.warnings.length,success?0:1);
    assert.match(h.state.prompts[0].message,recording?/rebuilding the review baseline/i:/clear the saved review baseline/i);
});
await test('clear command aborts when recording mode changes while confirmation is open',async()=>{
    const h=commandHarness({recording:true,toggleRecordingOnConfirm:true});
    assert.equal(await h.run('diffTracker.clearDiffs'),false);
    assert.equal(h.state.prompts.length,1);assert.equal(h.state.resets,0);
    assert.equal(h.state.info.length,0);assert.equal(h.state.warnings.length,1);
    assert.match(h.state.warnings[0],/Recording state changed/i);
});
await test('clear command cancellation performs no baseline reset',async()=>{
    const h=commandHarness({confirmClear:false});assert.equal(await h.run('diffTracker.clearDiffs'),false);
    assert.equal(h.state.prompts.length,1);assert.equal(h.state.resets,0);assert.equal(h.state.info.length,0);assert.equal(h.state.warnings.length,0);
});
await test('workspace document lookups distinguish file working documents from virtual documents',()=>{
    const sourceText=fs.readFileSync('src/diffTracker.ts','utf8');
    const sourceFile=ts.createSourceFile('diffTracker.ts',sourceText,ts.ScriptTarget.Latest,true);
    const offenders=[];
    const visit=node=>{
        if(ts.isCallExpression(node)&&node.expression.getText(sourceFile)==='vscode.workspace.textDocuments.find'){
            const callback=node.arguments[0]?.getText(sourceFile)??'';
            if(callback.includes('.uri.fsPath')&&!callback.includes('.uri.scheme'))offenders.push(callback);
        }
        ts.forEachChild(node,visit);
    };
    visit(sourceFile);
    assert.deepEqual(offenders,[]);
});
await test('opaque exposes Acknowledge plus inspection while unknown remains inspection-only',()=>{
    const manifest=JSON.parse(fs.readFileSync('package.json','utf8'));
    const items=manifest.contributes.menus['view/item/context'];
    const opaqueCommands=items
        .filter(item=>(item.when??'').includes('viewItem == opaqueFile'))
        .map(item=>item.command).sort();
    assert.deepEqual(opaqueCommands,['diffTracker.acknowledgeOpaqueChange','diffTracker.showWebviewDiff']);
    const unknownCommands=items
        .filter(item=>(item.when??'').includes('viewItem == unknownFile'))
        .map(item=>item.command).sort();
    assert.deepEqual(unknownCommands,['diffTracker.showWebviewDiff']);
});
console.log(`${count} production review UI cases passed (VS Code, DOM and renderer boundaries mocked).`);
