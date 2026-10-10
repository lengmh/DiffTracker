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
const unknownReviewToken={filePath,epoch:1,reviewRevision:'unknown-current'};
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
        },getUnknownReviewToken:(target)=> {
            const change = state.changes.find(x=>x.filePath===target);
            return change?.reviewKind==='unknown' ? {...unknownReviewToken,filePath:target} : undefined;
        },getUnknownReviewTokens:()=> state.changes.filter(x=>x.reviewKind==='unknown')
            .map(x=>({...unknownReviewToken,filePath:x.filePath})),
        getSubtreeCoverageGaps:()=>state.subtreeCoverageGaps,
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
    return { panel, tracker, state, messages, commands, load, vscode,
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
    assert.equal(diagnostic.children[0].contextValue, 'coverageDiagnosticSubtree');
    assert.equal(diagnostic.children[0].coveragePath, '/workspace/imported-tree');
    const manifest = JSON.parse(fs.readFileSync('package.json','utf8'));
    const menu = manifest.contributes.menus['view/item/context'].find(entry =>
        entry.command === 'diffTracker.excludeCoverageSubtree');
    assert.match(menu.when,/coverageDiagnosticSubtree/);
    assert.equal(menu.group,'inline','inline contribution also appears in right-click context menu');

    assert.match(diagnostic.children[0].tooltip, /Imported directory watcher failed/);
    assert.equal(roots.some(item => item.label === 'Pending Review'), false,
        'coverage diagnostics must not fabricate a file review summary');
});

await test('coverage exclude quick action stages an exact root-local request without Apply',async()=>{
    const h=harness(null);
    const root=path.resolve('coverage-scope-test-root');
    const target=path.join(root,'docs','.aws');
    const otherRoot=path.resolve('coverage-scope-other-root');
    const {pathToFileURL}=await import('node:url');
    const folder=(name,fsPath)=>({name,uri:{
        fsPath,scheme:'file',toString:()=>pathToFileURL(fsPath).toString()
    }});
    const owned=folder('primary',root),other=folder('other',otherRoot);
    h.vscode.workspace.workspaceFolders=[owned,other];
    h.vscode.workspace.getWorkspaceFolder=()=>owned;
    h.state.subtreeCoverageGaps=[{targetPath:target,reason:'watcher failure',reasonCode:'directory-runtime-coverage-gap'}];
    const roots=[owned,other].map(value=>({
        name:value.name,uri:value.uri.toString(),caseSensitive:true
    }));
    const validate=h.load('monitoringScope.ts').validateAndCanonicalizeScope;
    let request=validate({mode:'wholeWorkspace',includes:[],excludes:[
        {scope:'all',pattern:'**/*.tmp'}
    ]},roots);
    assert.equal(request.ok,true);
    const controller=Object.create(h.load('monitoringScopeController.ts').MonitoringScopeController.prototype);
    let saveCount=0,reconcileCount=0;
    Object.assign(controller,{
        tracker:h.tracker,
        scopeSettingsWriteQueue:Promise.resolve(),
        pendingScopeSettingsWrites:0,
        getWorkspaceRoots:()=>roots,
        getStatus:()=>({requested:request,legacyMigrationComplete:true,effective:{kind:'configured'}}),
        getRequestedScope:()=>request,
        reconcileRequestedScope:()=>{reconcileCount++;}
    });
    h.vscode.workspace.getConfiguration=()=>({update:async(key,value,target)=>{
        assert.equal(key,'watchExclude','the quick action must only update exclusions');
        assert.equal(target,h.vscode.ConfigurationTarget.Workspace);
        saveCount++;
        request=validate({...request.scope,excludes:value},roots);
    }});
    const first=await controller.requestExcludeCoverageSubtree(target);
    assert.equal(first.status,'saved',JSON.stringify(first));
    assert.equal(saveCount,1);assert.equal(reconcileCount,1);
    assert.equal(request.scope.excludes.length,2,'preserve existing user excludes');
    assert.ok(request.scope.excludes.some(x=>x.scope==='folder'&&x.folder==='primary'&&
        x.pattern==='/docs/.aws/'),'target only the owning workspace root');
    const second=await controller.requestExcludeCoverageSubtree(target);
    assert.equal(second.status,'alreadyExcluded');
    assert.equal(saveCount,1,'no duplicate settings write');
    h.state.subtreeCoverageGaps=[];
    assert.equal((await controller.requestExcludeCoverageSubtree(target)).status,'blocked',
        'a stale diagnostic cannot stage an exclusion');
    h.state.subtreeCoverageGaps=[{targetPath:path.join(root,'folder*','nested'),
        reason:'bad',reasonCode:'directory-runtime-coverage-gap'}];
    assert.equal((await controller.requestExcludeCoverageSubtree(path.join(root,'folder*','nested'))).status,
        'blocked','literal special characters must not turn into broad globs');
    assert.equal(saveCount,1);
});

function coverageExclusionHarness(){
    const h=harness(null);
    const root=path.resolve('.');
    const {pathToFileURL}=require('node:url');
    const folder={name:'primary',uri:{fsPath:root,scheme:'file',toString:()=>pathToFileURL(root).toString()}};
    h.vscode.workspace.workspaceFolders=[folder];
    h.vscode.workspace.getWorkspaceFolder=()=>folder;
    h.state.workspaceConfiguration={
        monitoringScope:'wholeWorkspace',
        watchInclude:[{scope:'all',path:'test'}],
        watchExclude:[{scope:'all',pattern:'**/*.tmp'}]
    };
    let writes=Promise.resolve();
    h.vscode.workspace.getConfiguration=()=>({
        get:(key,fallback)=>h.state.workspaceConfiguration[key]??h.state.configuration[key]??fallback,
        inspect:key=>({workspaceValue:h.state.workspaceConfiguration[key],globalValue:h.state.configuration[key]}),
        update:(key,value,target)=>{
            const write=writes.then(async()=>{
                h.state.updates.push([key,value,target]);
                await h.state.beforeConfigurationUpdate?.(key,value);
                await new Promise(resolve=>setImmediate(resolve));
                h.state.workspaceConfiguration[key]=structuredClone(value);
                await h.state.afterConfigurationUpdate?.(key,value);
            });
            writes=write.catch(()=>undefined);
            return write;
        }
    });
    const roots=[{name:folder.name,uri:folder.uri.toString(),caseSensitive:true}];
    const effective={kind:'configured',...h.load('monitoringScope.ts').validateAndCanonicalizeScope({
        mode:h.state.workspaceConfiguration.monitoringScope,
        includes:h.state.workspaceConfiguration.watchInclude,
        excludes:h.state.workspaceConfiguration.watchExclude
    },roots).scope};
    Object.assign(h.tracker,{
        getEffectiveMonitoringScope:()=>effective,
        getCommittedLegacyCompatibilityPolicy:()=>[],
        getExplicitlyExcludedPendingReviewPaths:()=>[],
        setPendingMonitoringScope:scope=>{h.state.pendingScope=scope;}
    });
    const workspaceState=new Map();
    const controller=new (h.load('monitoringScopeController.ts').MonitoringScopeController)(
        {workspaceState:{get:key=>workspaceState.get(key),update:async(key,value)=>workspaceState.set(key,value)}},h.tracker);
    const targets=['a','b'].map(name=>path.join(root,name));
    h.state.subtreeCoverageGaps=targets.map(targetPath=>({
        targetPath,reason:'watcher failure',reasonCode:'directory-runtime-coverage-gap'
    }));
    return {...h,controller,targets};
}

// Run the production activation statements for scope commands unchanged. The
// controller and panel are real; only the VS Code host and tracker are stubs.
function monitoringScopeCommandHarness() {
    const h = coverageExclusionHarness();
    const callbacks = new Map();
    h.state.warnings = [];
    h.state.info = [];
    h.state.applies = 0;
    h.vscode.window.showWarningMessage = message => h.state.warnings.push(message);
    h.vscode.window.showInformationMessage = message => h.state.info.push(message);
    h.vscode.commands.registerCommand = (name, callback) => {
        callbacks.set(name, callback);
        return { dispose() {} };
    };
    Object.assign(h.tracker, {
        getRetainedReviewPaths: () => [],
        getCoverageGaps: () => [],
        getCoverageGeneration: () => 1,
        getPolicyFingerprint: () => 'test-policy'
    });
    h.controller.applyPendingScope = async () => {
        h.state.applies++;
        return { status: 'applied' };
    };
    const WatchExcludePanel = h.load('watchExcludePanel.ts').WatchExcludePanel;
    const source = ts.createSourceFile('extension.ts', fs.readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
    const activation = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'activate');
    const statements = activation.body.statements;
    const commandIndex = statements.findIndex(statement => {
        let found = false;
        function visit(node) {
            if (ts.isCallExpression(node) && node.expression.getText(source) === 'vscode.commands.registerCommand' &&
                node.arguments[0]?.text === 'diffTracker.excludeCoverageSubtree') { found = true; }
            ts.forEachChild(node, visit);
        }
        visit(statement);
        return found;
    });
    assert.ok(commandIndex >= 0, 'scope commands must be registered in activation');
    let start = commandIndex;
    while (start > 0 && ts.isVariableStatement(statements[start - 1])) { start--; }
    const code = statements.slice(start, commandIndex + 1).map(statement => statement.getText(source)).join('\n');
    vm.runInNewContext(ts.transpileModule(code, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
    }).outputText, {
        vscode: h.vscode, WatchExcludePanel, diffTracker: h.tracker,
        monitoringScopeController: h.controller,
        context: { extensionUri: { fsPath: '/extension' }, subscriptions: [] },
        settingsTreeDataProvider: { refresh() {} }
    });
    return { ...h, WatchExcludePanel, run: (name, ...args) => callbacks.get(`diffTracker.${name}`)(...args) };
}

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

const scopeEditorCommands = ['manageMonitoringScope', 'editWatchExcludes', 'applyPendingScope', 'retryScopePreparation'];
for (const command of scopeEditorCommands) {
    await test(`scope command ${command} cannot capture a draft during a quick exclusion save`, async () => {
        const h = monitoringScopeCommandHarness();
        const entered = deferred(), gate = deferred();
        h.state.beforeConfigurationUpdate = async () => { entered.resolve(); await gate.promise; };
        const save = h.run('excludeCoverageSubtree', { coveragePath: h.targets[0] });
        try {
            await entered.promise;
            await h.run(command);
            assert.equal(h.WatchExcludePanel.currentPanel, undefined,
                'no scope editor may capture the pre-save request');
            assert.equal(h.state.createdPanels.length, 0);
            assert.equal(h.state.applies, 0, 'Apply must not proceed against the pre-save request');
            assert.match(h.state.warnings.at(-1), /exclusion.*sav|sav.*exclusion/i);
        } finally {
            gate.resolve();
            await save;
        }
        await h.run(command);
        const panel = h.WatchExcludePanel.currentPanel;
        assert.ok(panel, 'normal panel opening resumes after the settings save');
        assert.equal(h.state.applies, /apply|retry/.test(command) ? 1 : 0);
        await panel.handleMessage({ command: 'reload' });
        const draft = h.messages.at(-1).rawRequested;
        assert.ok(draft.excludes.some(rule => rule.pattern === '/a/'), 'the fresh editor includes the quick exclusion');
        await panel.handleMessage({ command: 'saveRequest', ...draft });
        assert.ok(h.state.workspaceConfiguration.watchExclude.some(rule => rule.pattern === '/a/'),
            'saving the fresh editor must retain the quick exclusion');
        panel.dispose();
    });
}

await test('scope editor remains blocked until all queued quick exclusion commands settle', async () => {
    const h = monitoringScopeCommandHarness();
    const entered = [deferred(), deferred()], gates = [deferred(), deferred()];
    let writes = 0;
    h.state.beforeConfigurationUpdate = async () => {
        const index = writes++;
        entered[index].resolve();
        await gates[index].promise;
    };
    const first = h.run('excludeCoverageSubtree', h.targets[0]);
    for (const command of scopeEditorCommands) {
        await h.run(command);
        assert.equal(h.WatchExcludePanel.currentPanel, undefined, 'ownership starts before the controller queue runs');
    }
    const second = h.run('excludeCoverageSubtree', h.targets[1]);
    try {
        await entered[0].promise;
        gates[0].resolve();
        assert.equal((await first).status, 'saved');
        await entered[1].promise;
        for (const command of scopeEditorCommands) {
            await h.run(command);
            assert.equal(h.WatchExcludePanel.currentPanel, undefined,
                'settling the first write cannot release ownership held by a queued request');
        }
        assert.equal(h.state.applies, 0);
    } finally {
        gates.forEach(gate => gate.resolve());
        await Promise.all([first, second]);
    }
    await h.run('manageMonitoringScope');
    assert.ok(h.WatchExcludePanel.currentPanel);
    assert.deepEqual(h.state.workspaceConfiguration.watchExclude.map(rule => rule.pattern).sort(),
        ['**/*.tmp', '/a/', '/b/'].sort());
    h.WatchExcludePanel.currentPanel.dispose();
});

for (const failure of ['rejected operation', 'failed settings write']) {
    await test(`scope editor ownership is released after a ${failure}`, async () => {
        const h = monitoringScopeCommandHarness();
        if (failure === 'rejected operation') {
            h.tracker.getSubtreeCoverageGaps = () => { throw new Error('controlled coverage lookup failure'); };
            await assert.rejects(h.run('excludeCoverageSubtree', h.targets[0]), /controlled coverage lookup failure/);
        } else {
            h.state.beforeConfigurationUpdate = async () => { throw new Error('controlled settings failure'); };
            assert.equal((await h.run('excludeCoverageSubtree', h.targets[0])).status, 'blocked');
        }
        await h.run('manageMonitoringScope');
        assert.ok(h.WatchExcludePanel.currentPanel, 'a failed command must not leave the editor locked');
        h.WatchExcludePanel.currentPanel.dispose();
    });
}

await test('an already open scope editor still prevents quick exclusion commands', async () => {
    const h = monitoringScopeCommandHarness();
    await h.run('manageMonitoringScope');
    const panel = h.WatchExcludePanel.currentPanel;
    assert.equal(await h.run('excludeCoverageSubtree', h.targets[0]), undefined);
    assert.equal(h.state.updates.length, 0, 'the existing draft must retain exclusive ownership');
    assert.match(h.state.warnings.at(-1), /Close Manage Monitoring Scope/);
    panel.dispose();
    assert.equal((await h.run('excludeCoverageSubtree', h.targets[0])).status, 'saved');
});

await test('closing a saving scope editor preserves ownership and the next quick exclusion merges its final draft', async () => {
    const h = monitoringScopeCommandHarness();
    await h.run('manageMonitoringScope');
    const panel = h.WatchExcludePanel.currentPanel;
    const draft = { mode: 'rules', includes: [{ scope: 'all', path: 'src' }],
        excludes: [{ scope: 'all', pattern: '/editor-owned/' }] };
    const entered = deferred(), gate = deferred();
    h.state.beforeConfigurationUpdate = async () => {
        h.state.beforeConfigurationUpdate = undefined;
        entered.resolve();
        await gate.promise;
    };
    const save = panel.handleMessage({ command: 'saveRequest', ...draft });
    panel.dispose();
    const quick = h.run('excludeCoverageSubtree', h.targets[0]);
    try {
        await entered.promise;
        for (const command of scopeEditorCommands) {
            await h.run(command);
            assert.equal(h.WatchExcludePanel.currentPanel, undefined, 'a closed but still-saving editor retains ownership');
        }
        assert.deepEqual(h.state.updates.map(([key]) => key), ['monitoringScope'],
            'the quick exclusion cannot write between the editor’s settings writes');
    } finally { gate.resolve(); }
    await save;
    assert.equal((await quick).status, 'saved');
    assert.equal(h.state.workspaceConfiguration.monitoringScope, draft.mode);
    assert.deepEqual(h.state.workspaceConfiguration.watchInclude, draft.includes);
    assert.deepEqual(h.state.workspaceConfiguration.watchExclude.map(rule => rule.pattern).sort(), ['/a/', '/editor-owned/']);
    assert.deepEqual(h.state.updates.map(([key]) => key), ['monitoringScope', 'watchInclude', 'watchExclude', 'watchExclude']);
    await h.run('manageMonitoringScope');
    assert.ok(h.WatchExcludePanel.currentPanel);
    h.WatchExcludePanel.currentPanel.dispose();
});

for (const kind of ['automatic', 'manual']) {
    await test(`${kind} migration owns one queued write through its nested save and finishes without deadlock`, async () => {
        const h = monitoringScopeCommandHarness();
        h.tracker.getEffectiveMonitoringScope = () => ({ kind: 'legacyV3' });
        h.tracker.prepareLegacyCompatibilityPolicySnapshot = async () => true;
        h.state.configuration.watchExclude = [kind === 'automatic' ? '# legacy note' : 'legacy/'];
        h.state.workspaceConfiguration = {};
        const entered = deferred(), gate = deferred();
        h.state.beforeConfigurationUpdate = async () => {
            h.state.beforeConfigurationUpdate = undefined;
            entered.resolve();
            await gate.promise;
        };
        const migration = kind === 'automatic' ? h.run('migrateLegacyWatchRules')
            : h.controller.completeLegacyMigrationUsingCurrentScope({
                mode: 'rules', includes: [], excludes: [{ scope: 'all', pattern: 'legacy/' }]
            });
        try {
            await Promise.race([entered.promise, migration.then(result => assert.fail(`Migration did not reach its settings save: ${JSON.stringify(result)}`))]);
            for (const command of scopeEditorCommands) {
                await h.run(command);
                assert.equal(h.WatchExcludePanel.currentPanel, undefined, 'migration must not expose partially written settings');
            }
        } finally { gate.resolve(); }
        assert.equal((await migration).status, kind === 'automatic' ? 'migrated' : 'completed');
        assert.equal(h.controller.hasPendingScopeSettingsWrites(), false);
        assert.deepEqual(h.state.updates.map(([key]) => key), ['monitoringScope', 'watchInclude', 'watchExclude']);
        assert.equal(h.controller.getStatus().legacyMigrationComplete, true);
        await h.run('manageMonitoringScope');
        assert.ok(h.WatchExcludePanel.currentPanel);
        h.WatchExcludePanel.currentPanel.dispose();
    });
}

for (const first of ['restore', 'quick']) {
    await test(`${first}-first restore and quick commands serialize complete settings writes`, async () => {
        const h = monitoringScopeCommandHarness();
        const initial = structuredClone(h.state.workspaceConfiguration);
        h.vscode.window.showWarningMessage = (message, options) => options?.modal ? 'Restore Effective Scope'
            : h.state.warnings.push(message);
        const entered = deferred(), gate = deferred();
        h.state.beforeConfigurationUpdate = async () => {
            h.state.beforeConfigurationUpdate = undefined;
            entered.resolve();
            await gate.promise;
        };
        const restore = () => h.run('restoreEffectiveScopeConfiguration');
        const quick = () => h.run('excludeCoverageSubtree', h.targets[0]);
        const earlier = first === 'restore' ? restore() : quick();
        await entered.promise;
        const later = first === 'restore' ? quick() : restore();
        try {
            for (const command of scopeEditorCommands) {
                await h.run(command);
                assert.equal(h.WatchExcludePanel.currentPanel, undefined);
            }
        } finally { gate.resolve(); }
        await Promise.all([earlier, later]);
        assert.equal(h.controller.hasPendingScopeSettingsWrites(), false);
        assert.equal(h.state.workspaceConfiguration.monitoringScope, initial.monitoringScope);
        assert.deepEqual(h.state.workspaceConfiguration.watchInclude, initial.watchInclude);
        assert.deepEqual(h.state.workspaceConfiguration.watchExclude.map(rule => rule.pattern).sort(),
            first === 'restore' ? ['**/*.tmp', '/a/'] : ['**/*.tmp'],
            'a later confirmed Restore intentionally replaces the request; a later quick action merges it');
        assert.deepEqual(h.state.updates.map(([key]) => key), first === 'restore'
            ? ['monitoringScope', 'watchInclude', 'watchExclude', 'watchExclude']
            : ['watchExclude', 'monitoringScope', 'watchInclude', 'watchExclude']);
    });
}

for (const answer of [undefined, 'Restore Effective Scope']) {
    await test(`restore confirmation ${answer ? 'acceptance' : 'cancellation'} owns no settings write before the decision`, async () => {
        const h = monitoringScopeCommandHarness();
        const decision = deferred();
        h.vscode.window.showWarningMessage = (message, options) => options?.modal ? decision.promise
            : h.state.warnings.push(message);
        const restore = h.run('restoreEffectiveScopeConfiguration');
        assert.equal(h.controller.hasPendingScopeSettingsWrites(), false);
        assert.equal((await h.run('excludeCoverageSubtree', h.targets[0])).status, 'saved');
        decision.resolve(answer);
        assert.equal(await restore, !!answer);
        assert.equal(h.controller.hasPendingScopeSettingsWrites(), false);
        assert.equal(h.state.workspaceConfiguration.watchExclude.some(rule => rule.pattern === '/a/'), !answer);
    });
}

await test('concurrent coverage exclusions preserve both requests and existing scope rules',async()=>{
    const h=coverageExclusionHarness();
    const original=structuredClone(h.state.workspaceConfiguration);
    let enter,release;
    const entered=new Promise(resolve=>{enter=resolve;});
    const gate=new Promise(resolve=>{release=resolve;});
    h.state.beforeConfigurationUpdate=async()=>{
        h.state.beforeConfigurationUpdate=undefined;
        enter();await gate;
    };
    const first=h.controller.requestExcludeCoverageSubtree(h.targets[0]);
    await Promise.race([entered,first.then(result=>assert.fail(`Save did not reach the configuration boundary: ${JSON.stringify(result)}`))]);
    const second=h.controller.requestExcludeCoverageSubtree(h.targets[1]);
    release();
    const results=await Promise.all([first,second]);
    assert.deepEqual(Array.from(results,result=>result.status),['saved','saved']);
    assert.equal(h.state.workspaceConfiguration.monitoringScope,original.monitoringScope);
    assert.deepEqual(h.state.workspaceConfiguration.watchInclude,original.watchInclude);
    assert.deepEqual(h.state.workspaceConfiguration.watchExclude.map(rule=>rule.pattern).sort(),
        ['**/*.tmp','/a/','/b/'].sort(),'a later quick action must retain the earlier saved exclusion');
    assert.ok(h.state.updates.every(([, ,target])=>target===h.vscode.ConfigurationTarget.Workspace));
    assert.deepEqual(h.state.updates.map(([key])=>key),['watchExclude','watchExclude']);
    assert.equal(h.state.pendingScope.scopeRevision,h.controller.getRequestedScope().scope.scopeRevision);
});

await test('concurrent duplicate coverage exclusions perform only one settings save',async()=>{
    const h=coverageExclusionHarness();
    const results=await Promise.all([
        h.controller.requestExcludeCoverageSubtree(h.targets[0]),
        h.controller.requestExcludeCoverageSubtree(h.targets[0])
    ]);
    assert.deepEqual(Array.from(results,result=>result.status),['saved','alreadyExcluded']);
    assert.equal(h.state.updates.length,1,'the duplicate must not rewrite any scope setting');
    assert.deepEqual(h.state.workspaceConfiguration.watchExclude.map(rule=>rule.pattern).sort(),
        ['**/*.tmp','/a/'].sort());
});

await test('coverage exclusion does not overwrite an external edit after its first settings write',async()=>{
    const h=coverageExclusionHarness();
    let enter,release;
    const entered=new Promise(resolve=>{enter=resolve;});
    const gate=new Promise(resolve=>{release=resolve;});
    h.state.afterConfigurationUpdate=async()=>{
        h.state.afterConfigurationUpdate=undefined;
        enter();await gate;
    };
    const operation=h.controller.requestExcludeCoverageSubtree(h.targets[0]);
    await Promise.race([entered,operation.then(result=>assert.fail(`Save did not reach the configuration boundary: ${JSON.stringify(result)}`))]);
    const external={
        monitoringScope:'wholeWorkspace',
        watchInclude:[{scope:'all',path:'src'}],
        watchExclude:[{scope:'all',pattern:'/external/'}]
    };
    h.state.workspaceConfiguration=structuredClone(external);
    release();
    const result=await operation;
    assert.deepEqual(h.state.workspaceConfiguration,external,
        'a quick exclusion must not overwrite externally edited scope settings');
    assert.equal(result.status,'blocked','a concurrent settings edit must not be reported as saved');
    assert.match(result.reason,/changed during the save/);
    assert.deepEqual(h.state.updates.map(([key])=>key),['watchExclude']);
});

function deferLegacyCoverageSnapshot(h){
    h.tracker.getEffectiveMonitoringScope=()=>({kind:'legacyV3'});
    h.state.workspaceConfiguration.watchExclude=[];
    let enter,release;
    const entered=new Promise(resolve=>{enter=resolve;});
    const gate=new Promise(resolve=>{release=resolve;});
    h.tracker.prepareLegacyCompatibilityPolicySnapshot=async()=>{
        enter();return gate;
    };
    return {entered,release};
}

await test('coverage exclusion waits for a durable legacy policy snapshot before its single write',async()=>{
    const h=coverageExclusionHarness();
    const snapshot=deferLegacyCoverageSnapshot(h);
    const operation=h.controller.requestExcludeCoverageSubtree(h.targets[0]);
    await Promise.race([snapshot.entered,operation.then(result=>assert.fail(`Save did not prepare legacy policy: ${JSON.stringify(result)}`))]);
    assert.equal(h.state.updates.length,0,'no settings write before the snapshot is durable');
    snapshot.release(true);
    assert.equal((await operation).status,'saved');
    assert.deepEqual(h.state.updates.map(([key])=>key),['watchExclude']);
});

await test('coverage exclusion leaves settings unchanged when legacy policy cannot be persisted',async()=>{
    const h=coverageExclusionHarness();
    const snapshot=deferLegacyCoverageSnapshot(h);
    const original=structuredClone(h.state.workspaceConfiguration);
    const operation=h.controller.requestExcludeCoverageSubtree(h.targets[0]);
    await Promise.race([snapshot.entered,operation.then(result=>assert.fail(`Save did not prepare legacy policy: ${JSON.stringify(result)}`))]);
    snapshot.release(false);
    const result=await operation;
    assert.equal(result.status,'blocked');
    assert.match(result.reason,/Cannot persist the committed legacy monitoring policy/);
    assert.deepEqual(h.state.workspaceConfiguration,original);
    assert.equal(h.state.updates.length,0);
});

for(const scenario of [
    {name:'scope edit',change:h=>{
        h.state.workspaceConfiguration.watchInclude=[{scope:'all',path:'src'}];
        h.state.workspaceConfiguration.watchExclude=[{scope:'all',pattern:'/external/'}];
    },reason:/requested monitoring scope changed/},
    {name:'legacy source edit',change:h=>{
        h.state.workspaceConfiguration.watchExclude=['external/'];
    },reason:/legacy watch-rule migration/},
    {name:'workspace root change',change:h=>{
        h.vscode.workspace.workspaceFolders[0].name='renamed';
    },reason:/requested monitoring scope changed/},
    {name:'owning folder change',change:h=>{
        const folder=h.vscode.workspace.workspaceFolders[0];
        h.vscode.workspace.getWorkspaceFolder=()=>({...folder,name:'different'});
    },reason:/owning workspace folder changed/},
    {name:'resolved warning',change:h=>{
        h.state.subtreeCoverageGaps=[];
    },reason:/coverage warning no longer exists/}
]){
    await test(`coverage exclusion revalidates ${scenario.name} after legacy snapshot preparation`,async()=>{
        const h=coverageExclusionHarness();
        const snapshot=deferLegacyCoverageSnapshot(h);
        const operation=h.controller.requestExcludeCoverageSubtree(h.targets[0]);
        await Promise.race([snapshot.entered,operation.then(result=>assert.fail(`Save did not prepare legacy policy: ${JSON.stringify(result)}`))]);
        scenario.change(h);
        const external=structuredClone(h.state.workspaceConfiguration);
        snapshot.release(true);
        const result=await operation;
        assert.equal(result.status,'blocked');
        assert.match(result.reason,scenario.reason);
        assert.deepEqual(h.state.workspaceConfiguration,external);
        assert.equal(h.state.updates.length,0,'stale quick actions must not write settings');
    });
}

await test('coverage exclusion queue recovers after a rejected operation',async()=>{
    const h=coverageExclusionHarness();
    const gaps=h.tracker.getSubtreeCoverageGaps;
    h.tracker.getSubtreeCoverageGaps=()=>{
        h.tracker.getSubtreeCoverageGaps=gaps;
        throw new Error('controlled coverage lookup failure');
    };
    const [first,second]=await Promise.allSettled([
        h.controller.requestExcludeCoverageSubtree(h.targets[0]),
        h.controller.requestExcludeCoverageSubtree(h.targets[1])
    ]);
    assert.equal(first.status,'rejected');
    assert.match(first.reason.message,/controlled coverage lookup failure/);
    assert.equal(second.status,'fulfilled');
    assert.equal(second.value.status,'saved');
    assert.deepEqual(h.state.workspaceConfiguration.watchExclude.map(rule=>rule.pattern).sort(),
        ['**/*.tmp','/b/'].sort());
});

await test('review tree exposes versioned Unknown Reset, text Accept and bounded folder actions',async()=>{
    const h=harness(null);
    const pathRoot=path.resolve('review-tree-scoped');
    const text=path.join(pathRoot,'mixed','text.txt');
    const opaque=path.join(pathRoot,'mixed','binary.png');
    const unknown=path.join(pathRoot,'mixed','uncertain.dat');
    const paths=[text,opaque,unknown];
    h.state.changes=paths.map((filePath,index)=>({
        filePath,fileName:path.basename(filePath),originalContent:'prior',currentContent:'changed',
        isDeleted:false,reviewKind:['text','opaque','unknown'][index]
    }));
    h.tracker.getReviewToken=target=>target===text?{...reviewToken,filePath:target}:undefined;
    h.tracker.getReviewTokens=()=>[{...reviewToken,filePath:text}];
    h.tracker.getOpaqueReviewToken=target=>target===opaque?{...opaqueReviewToken,filePath:target}:undefined;
    h.tracker.getOpaqueReviewTokens=()=>[{...opaqueReviewToken,filePath:opaque}];
    h.tracker.getUnknownReviewToken=target=>target===unknown?{...unknownReviewToken,filePath:target}:undefined;
    h.tracker.getUnknownReviewTokens=()=>[{...unknownReviewToken,filePath:unknown}];
    const originalGetFolder=h.vscode.workspace.getWorkspaceFolder;
    h.vscode.workspace.getWorkspaceFolder=()=>({
        name:'local',uri:{fsPath:pathRoot,scheme:'file'}
    });
    try{
        const tree=new (h.load('diffTreeView.ts').DiffTreeDataProvider)(h.tracker);
        const root=await tree.getChildren();
        const resetAll=root.find(item=>item.command?.command==='diffTracker.resetAllUnknownBaselines');
        assert.ok(resetAll);
        assert.equal(resetAll.command.arguments[0][0].filePath,unknown);
        const folder=root.find(item=>item.contextValue==='reviewFolder');
        assert.ok(folder,'a virtual folder groups only its actual pending descendants');
        const leaves=folder.children;
        const textLeaf=leaves.find(item=>item.filePath===text);
        const opaqueLeaf=leaves.find(item=>item.filePath===opaque);
        const unknownLeaf=leaves.find(item=>item.filePath===unknown);
        assert.equal(textLeaf.contextValue,'changedFile');
        assert.equal(opaqueLeaf.contextValue,'opaqueFile');
        assert.equal(unknownLeaf.contextValue,'unknownFile');
        assert.equal(unknownLeaf.unknownReviewToken.filePath,unknown);
        assert.deepEqual(Array.from(folder.reviewEntries,entry=>entry.filePath).sort(),paths.sort());
        assert.equal(folder.reviewEntries.filter(entry=>entry.reviewToken).length,1);
        assert.equal(folder.reviewEntries.filter(entry=>entry.opaqueReviewToken).length,1);
        const manifest=JSON.parse(fs.readFileSync('package.json','utf8'));
        const menus=manifest.contributes.menus['view/item/context'];
        for(const command of ['diffTracker.acceptFolderText','diffTracker.revertFolderText','diffTracker.acknowledgeFolderOpaque']){
            assert.ok(menus.some(item=>item.command===command&&item.when.includes('reviewFolder')),
                `${command} must be scoped to virtual directory rows`);
        }
        assert.ok(menus.some(item=>item.command==='diffTracker.acceptFile'&&item.group==='inline'));
        assert.ok(menus.some(item=>item.command==='diffTracker.resetUnknownBaseline'&&item.group==='inline'));
    }finally{h.vscode.workspace.getWorkspaceFolder=originalGetFolder;}
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
    const state={deleted:true,mode:'splitOriginalWebview',recording:false,resetResult:true,confirmClear:true,opened:0,panels:0,resets:0,legacyClears:0,info:[],warnings:[],prompts:[],executed:[],updates:[],pickerItems:[],...options};
    const source=ts.createSourceFile('extension.ts',fs.readFileSync('src/extension.ts','utf8'),ts.ScriptTarget.Latest,true);
    const helpers=[],callbacks=[];
    const names=new Set(['diffTracker.openDiffDefault','diffTracker.showOriginalAndWebviewSplit','diffTracker.showWebviewDiff','diffTracker.clearDiffs','diffTracker.selectDefaultOpenMode','diffTracker.selectWebviewDiffStyle']);
    function visit(node){
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
        commands:{executeCommand:async(name,...args)=>{state.executed.push([name,...args]);return sandbox.callbacks[name]?.(...args);}}};
    const tracker={getTrackedChanges:()=>[{filePath,isDeleted:state.deleted}],getIsRecording:()=>state.recording,
        resetBaselineToCurrentState:async()=>{state.resets++;return state.resetResult;},clearDiffs:()=>{state.legacyClears++;}};
    sandbox={vscode,diffTracker:tracker,context:{extensionUri:{}},WebviewDiffPanel:{createOrShow:()=>state.panels++},
        settingsTreeDataProvider:{refresh(){}},refreshChangesTree:()=>{},decorationManager:{clearAllDecorations:()=>{}},console};
    vm.createContext(sandbox);
    vm.runInContext(ts.transpileModule(`${helpers.join('\n')}globalThis.callbacks={${callbacks.join(',')}};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,sandbox);
    return {state,Uri,run:(name,...args)=>sandbox.callbacks[name](...args)};
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
await test('opaque exposes Acknowledge and unknown exposes explicit Baseline Reset plus inspection',()=>{
    const manifest=JSON.parse(fs.readFileSync('package.json','utf8'));
    const items=manifest.contributes.menus['view/item/context'];
    const opaqueCommands=items
        .filter(item=>(item.when??'').includes('viewItem == opaqueFile'))
        .map(item=>item.command).sort();
    assert.deepEqual(opaqueCommands,['diffTracker.acknowledgeOpaqueChange','diffTracker.showWebviewDiff']);
    const unknownCommands=items
        .filter(item=>(item.when??'').includes('viewItem == unknownFile'))
        .map(item=>item.command).sort();
    assert.deepEqual(unknownCommands,['diffTracker.resetUnknownBaseline','diffTracker.showWebviewDiff']);
});
console.log(`${count} production review UI cases passed (VS Code, DOM and renderer boundaries mocked).`);
