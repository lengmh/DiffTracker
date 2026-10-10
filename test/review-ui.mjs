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
    const state = { changes: change ? [change] : [], subtreeCoverageGaps: [], configuration: {}, updates: [], createdPanels: [], result: { status: 'success' }, error: undefined };
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
        ViewColumn: { One: 1, Beside: -2 },
        ConfigurationTarget: { Global: 1, Workspace: 2 },
        window: {
            activeColorTheme: { kind: 1 },
            onDidChangeActiveColorTheme: () => ({ dispose() {} }),
            createWebviewPanel: () => {
                const panel = {
                    onDidDispose: () => ({ dispose() {} }), reveal() {}, dispose() {},
                    webview: {
                        postMessage: value => messages.push(value),
                        asWebviewUri: uri => uri, cspSource: 'test-source',
                        onDidReceiveMessage: () => ({ dispose() {} })
                    }
                };
                state.createdPanels.push(panel);
                return panel;
            }
        },
        workspace: { textDocuments: [], workspaceFolders: [], getWorkspaceFolder: () => undefined,getConfiguration:()=>({get:(key,f)=>state.configuration?.[key]??f,inspect:key=>({workspaceValue:state.workspaceConfiguration?.[key]}),update:async(...args)=>state.updates.push(args)}),onDidChangeConfiguration:()=>({dispose(){}}) },
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
        },getSubtreeCoverageGaps:()=>state.subtreeCoverageGaps,
        getIsRecording:()=>true,
        onDidTrackChanges:()=>({dispose(){}})
    };
    const panel = Object.create(load('webviewDiffPanel.ts').WebviewDiffPanel.prototype);
    Object.assign(panel, {
        filePath, diffTracker: tracker, extensionUri: { fsPath: '/extension' },
        currentStyle: 'split', currentWrap: false, currentExpandAll: false,
        disposed:false,viewGeneration:0,seenRequests:new Set(),activeRequest:undefined,disposables:[],
        panel: { dispose(){},webview: { postMessage: value => messages.push(value), asWebviewUri: uri => uri, cspSource: 'test-source' } }
    });
    return { panel, tracker, state, messages, commands, load,
        open: (target = filePath) => load('webviewDiffPanel.ts').WebviewDiffPanel.createOrShow({ fsPath: '/extension' }, tracker, target) };
}

function runInline(html) {
    class Element {
        children = [];
        listeners = {};
        disabled = false;
        textContent = '';
        classList = { values: new Set(), toggle(name, enabled) { if (enabled) this.values.add(name); else this.values.delete(name); }, contains(name) { return this.values.has(name); } };
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

await test('subtree coverage diagnostics are visible and actionable without becoming file review items', async () => {
    const h = harness(null);
    h.state.subtreeCoverageGaps = [{
        targetPath: '/workspace/imported-tree',
        reasonCode: 'directory-runtime-coverage-gap',
        reason: 'Imported directory watcher failed'
    }];
    const tree = new (h.load('diffTreeView.ts').DiffTreeDataProvider)(h.tracker);
    const roots = await tree.getChildren();
    const diagnostic = roots.find(item => item.label === 'Monitoring Coverage Limited');
    assert.ok(diagnostic, 'coverage-limited state must be visible in the Changes Tree');
    assert.equal(diagnostic.description, '1 subtree(s)');
    assert.equal(diagnostic.filePath, undefined, 'subtree diagnostics are not file review resources');
    assert.equal(diagnostic.children.length, 1);
    assert.equal(diagnostic.children[0].command.command, 'diffTracker.manageMonitoringScope');
    assert.match(diagnostic.children[0].tooltip, /Imported directory watcher failed/);
    assert.equal(roots.some(item => item.label === 'Pending Review'), false,
        'coverage diagnostics must not fabricate a file review summary');
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
const archiveRestoreCommand = 'diffTracker.restoreArchivedGitReview';
function archivedReviewPreview(gitOverrides={}) {
    return {
        status: 'ready', token: 'preview-bound-archive-token',
        archive: {
            workspaceRoots: ['/home/test/研究 workspace', '/home/test/other-root'],
            gitContext: {
                repoRoot: '/home/test/研究 workspace', kind: 'worktree',
                headName: 'feature/archive-review', headCommit: '0123456789abcdef',
                inProgress: false, ...gitOverrides
            },
            textBaselines: 7, opaqueBaselines: 3, unknownBaselines: 2,
            recoveryRecords: 4, isRecording: true
        }
    };
}
function commandHarness(options={}) {
    const state={deleted:true,mode:'splitOriginalWebview',recording:false,resetResult:true,confirmClear:true,opened:0,panels:0,resets:0,legacyClears:0,info:[],warnings:[],prompts:[],executed:[],updates:[],pickerItems:[],
        archivePreview:archivedReviewPreview(),archiveResult:{status:'restored'},archiveAnswer:'Restore Archived Review',
        startResult:true,starts:0,baselineGitContexts:[],recordingContexts:[],gitReady:true,gitSnapshots:[],archiveEvents:[],reconciliations:[],restoreTokens:[],previews:0,reviewRefreshes:0,...options};
    const source=ts.createSourceFile('extension.ts',fs.readFileSync('src/extension.ts','utf8'),ts.ScriptTarget.Latest,true);
    const helpers=[],callbacks=[];
    const names=new Set(['diffTracker.openDiffDefault','diffTracker.showOriginalAndWebviewSplit','diffTracker.showWebviewDiff','diffTracker.clearDiffs','diffTracker.selectDefaultOpenMode','diffTracker.selectWebviewDiffStyle',archiveRestoreCommand]);
    function visit(node){
        if(ts.isVariableDeclaration(node)&&node.name.getText(source)==='startRecordingAfterPrechecks')helpers.push(`const ${node.getText(source)};`);
        if(ts.isFunctionDeclaration(node)&&['extractFilePath','extractIsDeleted','getDefaultOpenMode','isDeletedReview'].includes(node.name?.text))helpers.push(node.getText(source));
        if(ts.isCallExpression(node)&&node.expression.getText(source)==='vscode.commands.registerCommand'&&names.has(node.arguments[0]?.text))callbacks.push(`${JSON.stringify(node.arguments[0].text)}:${node.arguments[1].getText(source)}`);
        ts.forEachChild(node,visit);
    }
    visit(source);
    class Uri {constructor(fsPath,scheme='file'){this.fsPath=fsPath;this.scheme=scheme;}static file(p){return new Uri(p);}}
    let sandbox;
    const vscode={Uri,ConfigurationTarget:{Global:1,Workspace:2},ViewColumn:{One:1,Two:2},
        workspace:{getConfiguration:()=>({get:(_key,fallback)=>state.mode??fallback,inspect:key=>({workspaceValue:state.workspaceConfiguration?.[key]}),update:async(...args)=>state.updates.push(args)}),openTextDocument:async()=>{state.opened++;if(state.deleted)throw Object.assign(new Error('FileNotFound'),{code:'FileNotFound'});return{};}},
        window:{
            showTextDocument:async()=>{},
            showQuickPick:async items=>{state.pickerItems=items;return items.find(item=>item.value===state.chooseMode);},
            showInformationMessage:m=>{state.archiveEvents.push('information');state.info.push(m);},
            showWarningMessage:(message,...args)=>{
                const modal=args.find(value=>value&&typeof value==='object'&&value.modal===true);
                if(modal){
                    state.prompts.push({message,args});
                    if(args.includes('Restore Archived Review')) {
                        state.archiveEvents.push('confirmation');
                        return Promise.resolve(state.onArchiveConfirmation?.()).then(()=>state.archiveAnswer);
                    }
                    if(state.toggleRecordingOnConfirm) state.recording=!state.recording;
                    return state.confirmClear?'Clear Diffs':undefined;
                }
                state.archiveEvents.push('warning');
                state.warnings.push(message);
                return undefined;
            }
        },
        commands:{executeCommand:async(name,...args)=>{state.executed.push([name,...args]);return sandbox.callbacks[name]?.(...args);}}};
    const tracker={getTrackedChanges:()=>[{filePath,isDeleted:state.deleted}],getIsRecording:()=>state.recording,
        startRecording:()=>{state.archiveEvents.push('start');state.starts++;if(state.startResult)state.recording=true;return state.startResult;},
        setBaselineGitContexts:contexts=>{state.archiveEvents.push('setBaselineGitContexts');state.baselineGitContexts.push(contexts);},
        resetBaselineToCurrentState:async()=>{state.resets++;return state.resetResult;},clearDiffs:()=>{state.legacyClears++;},
        reconcileRestoredGitContexts:contexts=>{state.archiveEvents.push('reconcile');state.reconciliations.push(contexts);},
        previewArchivedGitReview:async()=>{state.archiveEvents.push('preview');state.previews++;await state.archivePreviewGate;return state.archivePreview;},
        restoreArchivedGitReview:async token=>{state.archiveEvents.push('restore');state.restoreTokens.push(token);state.onArchiveRestore?.(token);await state.archiveRestoreGate;return state.archiveResult;}};
    const gitContextMonitor=state.noGitMonitor?undefined:{
        isReady:()=>{state.archiveEvents.push('ready');return state.gitReady;},
        getSnapshots:()=>{state.archiveEvents.push('snapshots');return state.gitSnapshots;}
    };
    sandbox={vscode,diffTracker:tracker,context:{extensionUri:{}},WebviewDiffPanel:{createOrShow:()=>state.panels++},
        settingsTreeDataProvider:{refresh(){}},refreshChangesTree:()=>{},decorationManager:{clearAllDecorations:()=>{}},
        setRecordingContext:value=>{state.archiveEvents.push('setRecordingContext');state.recordingContexts.push(value);},
        gitContextMonitor,refreshReview:()=>{state.archiveEvents.push('refresh');state.reviewRefreshes++;},console};
    vm.createContext(sandbox);
    vm.runInContext(ts.transpileModule(`${helpers.join('\n')}globalThis.callbacks={${callbacks.join(',')}};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,sandbox);
    return {state,Uri,startRecording:()=>vm.runInContext('startRecordingAfterPrechecks()',sandbox),registeredCommands:callbacks.map(callback=>JSON.parse(callback.slice(0,callback.indexOf(':')))),run:(name,...args)=>sandbox.callbacks[name](...args)};
}
// Exercise the real constructor and generated inline script, including the
// one-time default boundary. No settings initializer is copied into this test.
for (const style of ['split', 'unified']) {
    for (const wrap of [false, true]) {
        for (const expand of [false, true]) {
            await test(`new WebView initializes ${style}, wrap=${wrap}, expand=${expand}`, () => {
                const h = harness({ filePath, fileName: 'empty.m', originalContent: 'before', currentContent: 'after' });
                h.state.configuration = { webviewDiffStyle: style, webviewWordWrap: wrap, webviewExpandUnchanged: expand };
                const panel = h.open();
                const ui = runInline(h.state.createdPanels[0].webview.html);
                const options = ui.rendererOptions.at(-1);
                assert.equal(options.diffStyle, style);
                assert.equal(options.overflow, wrap ? 'wrap' : 'scroll');
                assert.equal(options.expandUnchanged, expand);
                assert.equal(ui.elements.get('btn-split').classList.contains('secondary'), style !== 'split');
                assert.equal(ui.elements.get('btn-unified').classList.contains('secondary'), style !== 'unified');
                assert.equal(ui.elements.get('btn-wrap').classList.contains('secondary'), !wrap);
                assert.equal(ui.elements.get('btn-expand').classList.contains('secondary'), !expand);
                assert.deepEqual(h.state.updates, [], 'opening a panel does not write settings');
                panel.dispose();
            });
        }
    }
}
await test('missing and invalid WebView defaults retain Split, Wrap off and Expand off', () => {
    for (const configuration of [{}, { webviewDiffStyle: 'sideBySide', webviewWordWrap: 'true', webviewExpandUnchanged: 1 }]) {
        const h = harness();
        h.state.configuration = configuration;
        const panel = h.open();
        panel.sendDataUpdate();
        const update = h.messages.at(-1);
        assert.equal(update.style, 'split');
        assert.equal(update.wrap, false);
        assert.equal(update.expandAll, false);
        panel.dispose();
    }
});
await test('WebView toolbar choices survive refresh and file navigation; reopening samples new settings', async () => {
    const change = { filePath, fileName: 'empty.m', originalContent: 'before', currentContent: 'after' };
    const h = harness(change);
    h.state.configuration = { webviewDiffStyle: 'unified', webviewWordWrap: true, webviewExpandUnchanged: true };
    const panel = h.open();
    const ui = runInline(h.state.createdPanels[0].webview.html);
    for (const id of ['btn-split', 'btn-wrap', 'btn-expand']) {
        ui.click(id);
        await panel.handleMessage(ui.sent.at(-1));
    }
    assert.equal(ui.rendererOptions.at(-1).diffStyle, 'split');
    assert.equal(ui.rendererOptions.at(-1).overflow, 'scroll');
    assert.equal(ui.rendererOptions.at(-1).expandUnchanged, false);
    const assertToolbarChoices = () => {
        const update = h.messages.at(-1);
        assert.equal(update.style, 'split');
        assert.equal(update.wrap, false);
        assert.equal(update.expandAll, false);
        ui.receive(update);
        assert.equal(ui.rendererOptions.at(-1).diffStyle, 'split');
        assert.equal(ui.rendererOptions.at(-1).overflow, 'scroll');
        assert.equal(ui.rendererOptions.at(-1).expandUnchanged, false);
    };
    panel.update(filePath);
    assertToolbarChoices();
    assert.equal(h.open(), panel, 'reveal reuses the same panel');
    const secondPath = '/workspace/second.m';
    h.state.changes.push({ ...change, filePath: secondPath });
    assert.equal(h.open(secondPath), panel);
    assertToolbarChoices();
    h.state.configuration = { webviewDiffStyle: 'unified', webviewWordWrap: false, webviewExpandUnchanged: true };
    panel.update(secondPath);
    assertToolbarChoices();
    assert.deepEqual(h.state.updates, [], 'toolbar controls never persist settings');
    panel.dispose();
    const reopened = h.open(secondPath);
    assert.notEqual(reopened, panel);
    const freshUI = runInline(h.state.createdPanels[1].webview.html);
    assert.equal(freshUI.rendererOptions.at(-1).diffStyle, 'unified');
    assert.equal(freshUI.rendererOptions.at(-1).overflow, 'scroll');
    assert.equal(freshUI.rendererOptions.at(-1).expandUnchanged, true);
    // Both directions remain interactive after using configured defaults.
    for (const id of ['btn-split', 'btn-unified', 'btn-wrap', 'btn-wrap', 'btn-expand', 'btn-expand']) freshUI.click(id);
    assert.equal(freshUI.rendererOptions.at(-1).diffStyle, 'unified');
    assert.equal(freshUI.rendererOptions.at(-1).overflow, 'scroll');
    assert.equal(freshUI.rendererOptions.at(-1).expandUnchanged, true);
    reopened.dispose();
});
await test('WebView settings have matching manifest defaults and sidebar controls', async () => {
    const properties = JSON.parse(fs.readFileSync('package.json', 'utf8')).contributes.configuration.properties;
    assert.deepEqual(properties['diffTracker.webviewDiffStyle'].enum, ['split', 'unified']);
    for (const [key, expected] of [['webviewDiffStyle', 'split'], ['webviewWordWrap', false], ['webviewExpandUnchanged', false]]) {
        assert.equal(properties[`diffTracker.${key}`].default, expected);
        assert.equal(properties[`diffTracker.${key}`].scope, 'window');
    }
    const h = harness();
    const provider = new (h.load('settingsTreeView.ts').SettingsTreeDataProvider)();
    const display = provider.getChildren().find(item => item.label === 'Display');
    let items = provider.getChildren(display);
    assert.equal(items.find(item => item.command?.command === 'diffTracker.selectWebviewDiffStyle').label, 'WebView default layout: Split');
    for (const key of ['webviewWordWrap', 'webviewExpandUnchanged']) {
        assert.equal(items.find(item => item.settingKey === key).isEnabled, false);
        await provider.toggleSetting(key);
        assert.deepEqual(h.state.updates.at(-1), [key, true, 1]);
    }
    h.state.configuration = { webviewDiffStyle: 'unified', webviewWordWrap: true, webviewExpandUnchanged: true };
    items = provider.getChildren(display);
    assert.equal(items.find(item => item.command?.command === 'diffTracker.selectWebviewDiffStyle').label, 'WebView default layout: Unified');
    for (const key of ['webviewWordWrap', 'webviewExpandUnchanged']) {
        assert.equal(items.find(item => item.settingKey === key).isEnabled, true);
        await provider.toggleSetting(key);
        assert.deepEqual(h.state.updates.at(-1), [key, false, 1]);
    }
    provider.dispose();
});
await test('WebView layout picker preserves selections and cancellation without changing the frontend mode', async () => {
    for (const style of ['split', 'unified']) {
        const h = commandHarness({ mode: style, chooseMode: style });
        await h.run('diffTracker.selectWebviewDiffStyle');
        assert.deepEqual(Array.from(h.state.pickerItems, item => item.value), ['split', 'unified']);
        assert.match(h.state.pickerItems.find(item => item.value === style).label, /^\$\(check\)/);
        assert.deepEqual(h.state.updates, [['webviewDiffStyle', style, 1]]);
    }
    const cancel = commandHarness();
    await cancel.run('diffTracker.selectWebviewDiffStyle');
    assert.deepEqual(cancel.state.updates, []);
});
await test('WebView sidebar changes update existing workspace overrides instead of hidden global values', async () => {
    const h = harness();
    h.state.configuration = { webviewWordWrap: false, webviewExpandUnchanged: true };
    h.state.workspaceConfiguration = { ...h.state.configuration };
    const provider = new (h.load('settingsTreeView.ts').SettingsTreeDataProvider)();
    await provider.toggleSetting('webviewWordWrap');
    await provider.toggleSetting('webviewExpandUnchanged');
    assert.deepEqual(h.state.updates, [['webviewWordWrap', true, 2], ['webviewExpandUnchanged', false, 2]]);
    provider.dispose();
    const picker = commandHarness({ mode: 'split', chooseMode: 'unified', workspaceConfiguration: { webviewDiffStyle: 'split' } });
    await picker.run('diffTracker.selectWebviewDiffStyle');
    assert.deepEqual(picker.state.updates, [['webviewDiffStyle', 'unified', 2]]);
});
await test('settings tree shows the selected Native Review label',()=>{
    const h=harness();h.state.configuration={defaultOpenMode:'nativeReview'};
    const provider=new (h.load('settingsTreeView.ts').SettingsTreeDataProvider)();
    const display=provider.getChildren().find(item=>item.label==='Display');
    const item=provider.getChildren(display)[0];
    assert.equal(item.label,'Default open mode: Native Review');
    assert.equal(item.command.command,'diffTracker.selectDefaultOpenMode');
    provider.dispose();
});
await test('settings picker exposes Native Review while preserving manifest values and factory defaults',async()=>{
    const h=commandHarness({mode:'webview',chooseMode:'nativeReview'});
    await h.run('diffTracker.selectDefaultOpenMode');
    assert.deepEqual(h.state.updates,[['defaultOpenMode','nativeReview',1]]);
    assert.deepEqual(Array.from(h.state.pickerItems,item=>item.value),
        ['webview','inline','sideBySide','original','splitOriginalWebview','nativeReview']);
    const properties=JSON.parse(fs.readFileSync('package.json','utf8')).contributes.configuration.properties;
    assert.equal(properties['diffTracker.defaultOpenMode'].default,'webview');
    assert.deepEqual(properties['diffTracker.defaultOpenMode'].enum,
        ['webview','inline','sideBySide','original','splitOriginalWebview','nativeReview']);
    assert.equal(properties['diffTracker.nativeQuickDiff'].default,false);
    const cancel=commandHarness();await cancel.run('diffTracker.selectDefaultOpenMode');
    assert.deepEqual(cancel.state.updates,[]);
});
await test('ordinary open retains old modes, invalid-value Webview fallback and missing-target no-op',async()=>{
    for(const [mode,command] of [
        [undefined,'diffTracker.showWebviewDiff'],['webview','diffTracker.showWebviewDiff'],
        ['invalid','diffTracker.showWebviewDiff'],['inline','diffTracker.showInlineDiff'],
        ['sideBySide','diffTracker.showSideBySideDiff'],['original','diffTracker.openOriginalFile'],
        ['splitOriginalWebview','diffTracker.showOriginalAndWebviewSplit']
    ]) {
        const h=commandHarness({mode,deleted:false});await h.run('diffTracker.openDiffDefault',filePath);
        assert.equal(h.state.executed[0][0],command);
        assert.deepEqual(h.state.updates,[],'opening a review cannot rewrite settings');
    }
    const h=commandHarness({mode:'nativeReview'});await h.run('diffTracker.openDiffDefault');
    assert.deepEqual(h.state.executed,[]);
});
await test('native default delegates the unchanged target to the guarded adapter',async()=>{
    const h=commandHarness({mode:'nativeReview',deleted:false});
    for(const target of [filePath,{filePath},new h.Uri(filePath),new h.Uri(filePath,'git')]) {
        await h.run('diffTracker.openDiffDefault',target);
        assert.equal(h.state.executed.at(-1)[0],'diffTracker.nativeReview.openFile');
        assert.equal(h.state.executed.at(-1)[1],target,'preserve the original URI scheme and adapter validation');
    }
    assert.equal(h.state.panels,0);
});
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

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}


for (const alreadyRecording of [false, true]) {
    await test(`refused recording start never replaces Git baselines or context (previous recording=${alreadyRecording})`, () => {
        const preserved = [{ ...archivedReviewPreview().archive.gitContext, headCommit: 'preserved-before-image-head' }];
        const latest = [{ ...preserved[0], headCommit: 'unreviewed-current-head' }];
        const h = commandHarness({ startResult: false, recording: alreadyRecording, gitSnapshots: latest, baselineGitContexts: [preserved] });
        assert.equal(h.startRecording(), false);
        assert.equal(h.state.starts, 1);
        assert.equal(h.state.recording, alreadyRecording);
        assert.deepEqual(h.state.baselineGitContexts, [preserved], 'busy restore must preserve the Git context belonging to old before-images');
        assert.deepEqual(h.state.recordingContexts, [], 'refused start cannot publish a recording-context update');
        assert.deepEqual(h.state.archiveEvents, ['start'], 'return immediately without reading/capturing current Git state');
        assert.deepEqual(h.state.executed, []);
        assert.deepEqual(h.state.info, []);
        assert.deepEqual(h.state.warnings, []);
    });
}

await test('successful recording start captures ready Git context and reports the returned boolean', () => {
    const snapshots = [archivedReviewPreview().archive.gitContext];
    const h = commandHarness({ startResult: true, recording: false, gitSnapshots: snapshots });
    assert.equal(h.startRecording(), true);
    assert.equal(h.state.starts, 1);
    assert.equal(h.state.recording, true);
    assert.equal(h.state.baselineGitContexts[0], snapshots);
    assert.deepEqual(h.state.recordingContexts, [true]);
    assert.deepEqual(h.state.archiveEvents, ['start', 'ready', 'snapshots', 'setBaselineGitContexts', 'setRecordingContext']);
});

await test('Restore Archived Git Review is registered once and discoverable in the command palette', () => {
    const h = commandHarness();
    const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const contributions = manifest.contributes.commands.filter(item => item.command === archiveRestoreCommand);
    assert.equal(contributions.length, 1);
    assert.equal(contributions[0].title, 'Restore Archived Git Review');
    assert.equal(contributions[0].category, 'Code Diff Tracker');
    assert.equal(h.registeredCommands.filter(command => command === archiveRestoreCommand).length, 1);
    assert.equal(manifest.contributes.menus.commandPalette.some(item =>
        item.command === archiveRestoreCommand && item.when === 'false'), false);
});

for (const unavailable of ['missing monitor', 'initializing monitor']) {
    await test(`archive restore refuses ${unavailable} before reading the archive`, async () => {
        const h = commandHarness({ noGitMonitor: unavailable === 'missing monitor', gitReady: false });
        assert.equal(await h.run(archiveRestoreCommand), false);
        assert.equal(h.state.previews, 0);
        assert.deepEqual(h.state.reconciliations, []);
        assert.deepEqual(h.state.restoreTokens, []);
        assert.deepEqual(h.state.prompts, []);
        assert.deepEqual(h.state.info, []);
        assert.equal(h.state.reviewRefreshes, 0);
        assert.equal(h.state.warnings.length, 1);
        assert.match(h.state.warnings[0], /Git context initialization/i);
    });
}

for (const status of ['missing', 'invalid', 'refused']) {
    await test(`archive ${status} preview is reported without confirmation or mutation`, async () => {
        const reason = `${status}: controlled archive verification reason`;
        const snapshots = [archivedReviewPreview().archive.gitContext];
        const h = commandHarness({ archivePreview: { status, reason }, gitSnapshots: snapshots });
        assert.equal(await h.run(archiveRestoreCommand), false);
        assert.equal(h.state.previews, 1);
        assert.equal(h.state.reconciliations[0], snapshots);
        assert.deepEqual(h.state.archiveEvents, ['ready', 'snapshots', 'reconcile', 'preview', 'warning']);
        assert.deepEqual(h.state.restoreTokens, []);
        assert.deepEqual(h.state.prompts, []);
        assert.deepEqual(h.state.info, []);
        assert.equal(h.state.reviewRefreshes, 0);
        assert.equal(h.state.warnings.length, 1);
        assert.ok(h.state.warnings[0].includes(reason));
    });
}

for (const isRecording of [true, false]) {
    await test(`archive confirmation discloses identity, saved ${isRecording ? 'recording' : 'stopped'} state and full replacement scope`, async () => {
        const preview = archivedReviewPreview();
        preview.archive.isRecording = isRecording;
        const h = commandHarness({ archivePreview: preview, archiveAnswer: undefined });
        assert.equal(await h.run(archiveRestoreCommand), false);
        assert.equal(h.state.prompts.length, 1);
        const prompt = h.state.prompts[0];
        const modal = prompt.args.find(value => value && typeof value === 'object');
        assert.equal(modal.modal, true);
        assert.match(prompt.message, /replace the current DiffTracker review state/i);
        assert.equal(prompt.args.at(-1), 'Restore Archived Review');
        for (const value of [preview.archive.gitContext.repoRoot, preview.archive.gitContext.kind,
            preview.archive.gitContext.headName, preview.archive.gitContext.headCommit,
            ...preview.archive.workspaceRoots]) {
            assert.ok(modal.detail.includes(value), `confirmation must disclose ${value}`);
        }
        assert.match(modal.detail, isRecording ? /Saved recording state: recording/i : /Saved recording state: stopped/i);
        assert.match(modal.detail, /7 text baseline\(s\)/);
        assert.match(modal.detail, /3 read-only baseline\(s\)/);
        assert.match(modal.detail, /2 unknown before-image\(s\)/);
        assert.match(modal.detail, /4 recovery record\(s\)/);
        assert.match(modal.detail, /pending changes are recalculated against current files/i);
        assert.match(modal.detail, /not a historical pending-change count/i);
        assert.match(modal.detail, /entire current DiffTracker review state will be replaced/i);
        assert.match(modal.detail, /first saved in a separate pre-restore safety backup/i);
        assert.match(modal.detail, /on-disk files and Git history are unaffected/i);
        assert.match(modal.detail, /only the most recent Archive and Rebuild archive/i);
        assert.match(modal.detail, /next rebuild overwrites it/i);
        assert.match(modal.detail, /not per-branch history/i);
        assert.match(modal.detail, /storage belongs to this extension host/i);
        assert.match(modal.detail, /Remote-WSL.*WSL-side workspace storage/i);
        assert.match(modal.detail, /pause external automation/i);
        assert.deepEqual(h.state.restoreTokens, []);
        assert.equal(h.state.reviewRefreshes, 0);
        assert.deepEqual(h.state.info, []);
        assert.deepEqual(h.state.warnings, []);
    });
}

await test('archive confirmation labels detached and unborn HEAD without inventing branch metadata', async () => {
    const h = commandHarness({ archivePreview: archivedReviewPreview({ headName: undefined, headCommit: undefined }), archiveAnswer: undefined });
    assert.equal(await h.run(archiveRestoreCommand), false);
    const detail = h.state.prompts[0].args[0].detail;
    assert.match(detail, /Branch: \(detached HEAD\); HEAD: \(unborn\)/);
    assert.doesNotMatch(detail, /undefined|null/);
});

await test('archive preview and modal are awaited; dismissal never starts restore or changes files/settings', async () => {
    const previewGate = deferred(), modalGate = deferred(), modalEntered = deferred();
    const h = commandHarness({
        archivePreviewGate: previewGate.promise, archiveAnswer: undefined,
        onArchiveConfirmation: () => { modalEntered.resolve(); return modalGate.promise; }
    });
    let settled = false;
    const pending = h.run(archiveRestoreCommand).then(result => { settled = true; return result; });
    assert.equal(h.state.previews, 1);
    assert.deepEqual(h.state.prompts, [], 'confirmation must wait for archive verification');
    assert.equal(settled, false);
    previewGate.resolve();
    await modalEntered.promise;
    assert.deepEqual(h.state.restoreTokens, [], 'restore must wait for explicit approval');
    assert.equal(settled, false);
    modalGate.resolve();
    assert.equal(await pending, false);
    assert.equal(h.state.reconciliations.length, 1, 'cancel does not proceed with a second restore preparation');
    assert.deepEqual(h.state.restoreTokens, []);
    assert.equal(h.state.resets, 0);
    assert.equal(h.state.legacyClears, 0);
    assert.equal(h.state.opened, 0);
    assert.deepEqual(h.state.executed, [], 'no Git checkout, shell command, or alternate restore');
    assert.deepEqual(h.state.updates, []);
    assert.equal(h.state.reviewRefreshes, 0);
    assert.deepEqual(h.state.info, []);
    assert.deepEqual(h.state.warnings, []);
});

await test('archive restore re-reads Git snapshots after confirmation and passes the original preview token', async () => {
    const oldSnapshots = [archivedReviewPreview().archive.gitContext];
    const latestSnapshots = [{ ...oldSnapshots[0], headName: 'changed-during-modal', headCommit: 'fedcba9876543210' }];
    const modalGate = deferred(), modalEntered = deferred();
    const reason = 'Git context changed after preview. Preview and confirm again.';
    const h = commandHarness({
        gitSnapshots: oldSnapshots, archiveResult: { status: 'refused', reason },
        onArchiveConfirmation: () => { modalEntered.resolve(); return modalGate.promise; }
    });
    const pending = h.run(archiveRestoreCommand);
    await modalEntered.promise;
    assert.equal(h.state.reconciliations[0], oldSnapshots);
    h.state.gitSnapshots = latestSnapshots;
    modalGate.resolve();
    assert.equal(await pending, false);
    assert.equal(h.state.reconciliations.length, 2);
    assert.equal(h.state.reconciliations[1], latestSnapshots, 'never use the pre-confirmation Git snapshot');
    assert.equal(h.state.previews, 1, 'never silently replace the user-approved archive preview');
    assert.deepEqual(h.state.restoreTokens, [h.state.archivePreview.token]);
    assert.deepEqual(h.state.archiveEvents.filter(event => event !== 'ready'), [
        'snapshots', 'reconcile', 'preview', 'confirmation', 'snapshots', 'reconcile', 'restore', 'refresh', 'warning'
    ]);
    assert.deepEqual(h.state.info, []);
    assert.ok(h.state.warnings[0].includes(reason));
    assert.deepEqual(h.state.executed, []);
});

for (const status of ['restored', 'refused', 'rolled-back', 'failed']) {
    await test(`archive ${status} result is awaited and ${status === 'restored' ? 'alone reports success' : 'returns false without success claims'}`, async () => {
        const restoreGate = deferred(), restoreEntered = deferred();
        const reason = `${status}: controlled durable restore outcome`;
        const h = commandHarness({
            archiveResult: { status, reason }, archiveRestoreGate: restoreGate.promise,
            onArchiveRestore: () => restoreEntered.resolve()
        });
        let settled = false;
        const pending = h.run(archiveRestoreCommand).then(result => { settled = true; return result; });
        await restoreEntered.promise;
        assert.equal(settled, false, 'command must await the durable restore result');
        assert.deepEqual(h.state.info, []);
        assert.deepEqual(h.state.warnings, []);
        assert.equal(h.state.reviewRefreshes, 0, 'do not render a not-yet-settled restore as complete');
        restoreGate.resolve();
        assert.equal(await pending, status === 'restored');
        assert.deepEqual(h.state.restoreTokens, [h.state.archivePreview.token]);
        assert.equal(h.state.reviewRefreshes, 1);
        assert.deepEqual(h.state.archiveEvents.slice(-2), ['refresh', status === 'restored' ? 'information' : 'warning']);
        if (status === 'restored') {
            assert.equal(h.state.info.length, 1);
            assert.match(h.state.info[0], /restored and saved/i);
            assert.match(h.state.info[0], /files and Git history were not changed/i);
            assert.match(h.state.info[0], /previous review is separately backed up/i);
            assert.deepEqual(h.state.warnings, []);
        } else {
            assert.deepEqual(h.state.info, []);
            assert.equal(h.state.warnings.length, 1);
            assert.ok(h.state.warnings[0].includes(reason));
        }
        assert.equal(h.state.resets, 0);
        assert.equal(h.state.legacyClears, 0);
        assert.equal(h.state.opened, 0);
        assert.deepEqual(h.state.executed, []);
        assert.deepEqual(h.state.updates, []);
    });
}

await test('archive failure without a reason still reports its non-success status', async () => {
    const h = commandHarness({ archiveResult: { status: 'failed' } });
    assert.equal(await h.run(archiveRestoreCommand), false);
    assert.deepEqual(h.state.info, []);
    assert.equal(h.state.warnings.length, 1);
    assert.match(h.state.warnings[0], /failed/);
    assert.doesNotMatch(h.state.warnings[0], /undefined|null/);
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
