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
const largeFileReminderToken={filePath,epoch:1,reviewRevision:'large-reminder-current'};
function harness(change = { filePath, fileName: 'empty.m', originalContent: '', currentContent: '' }) {
    const messages = [];
    const commands = [];
    const state = { changes: change ? [change] : [], subtreeCoverageGaps: [], recheckBlocker:'Open Monitoring Scope to resolve the current scope first.', configuration: {}, updates: [], createdPanels: [], result: { status: 'success' }, error: undefined };
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
            module, exports: module.exports, process, console, setTimeout, clearTimeout,
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
        getLargeFileReminderToken:target=>state.changes.find(change=>change.filePath===target)?.largeFileReminder?.pending
            ? {...largeFileReminderToken,filePath:target} : undefined,
        getSubtreeCoverageGaps:()=>state.subtreeCoverageGaps,
        prepareOwnedScopeSettings:async()=>{},
        ownedScopeSettingsAreCurrent:()=>undefined,
        getObservationCoverageRecheckBlocker:()=>state.recheckBlocker,
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

await test('coverage diagnostics expose the existing guarded Recheck action without prescribing a rebuild', async () => {
    const h = harness(null);
    h.state.recheckBlocker=undefined;
    h.state.subtreeCoverageGaps=[{targetPath:'/workspace/generated-cache',reasonCode:'supplemental-watcher-runtime-gap',
        reason:'Supplemental watcher returned an unnamed event; observation coverage for the current subtree is unverified.'}];
    const tree=new (h.load('diffTreeView.ts').DiffTreeDataProvider)(h.tracker);
    let row=(await tree.getChildren()).find(item=>item.label==='Monitoring Coverage Limited').children[0];
    assert.equal(row.contextValue,'coverageDiagnosticSubtreeRecheck');
    assert.match(row.tooltip,/Recheck Observation Coverage/);
    assert.doesNotMatch(row.tooltip,/baseline rebuild/);
    const manifest=JSON.parse(fs.readFileSync('package.json','utf8'));
    const menus=manifest.contributes.menus['view/item/context'];
    assert.ok(menus.some(menu=>menu.command==='diffTracker.recheckObservationCoverage' &&
        menu.when.includes('viewItem == coverageDiagnosticSubtreeRecheck') && menu.group.startsWith('inline')));
    assert.ok(menus.some(menu=>menu.command==='diffTracker.excludeCoverageSubtree' &&
        menu.when.includes('viewItem == coverageDiagnosticSubtreeRecheck')));
    h.state.recheckBlocker='Recheck requires an active, ready configured scope.';
    row=(await tree.getChildren()).find(item=>item.label==='Monitoring Coverage Limited').children[0];
    assert.equal(row.contextValue,'coverageDiagnosticSubtree');
    assert.equal(row.command.command,'diffTracker.manageMonitoringScope');
    assert.match(row.tooltip,/Recheck requires an active, ready configured scope/);
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
        entry.command === 'diffTracker.excludeCoverageSubtree' &&
        entry.when.endsWith('viewItem == coverageDiagnosticSubtree'));
    assert.match(menu.when,/coverageDiagnosticSubtree/);
    assert.equal(menu.group,'inline','coverage diagnostics retain their hover action');

    assert.match(diagnostic.children[0].tooltip, /Imported directory watcher failed/);
    assert.equal(roots.some(item => item.label === 'Pending Review'), false,
        'coverage diagnostics must not fabricate a file review summary');
});

await test('Issue #39 tree and status bar consume the same active subtree gaps after scope Apply', async () => {
    const h = harness(null);
    const item = {show(){},dispose(){}};
    h.vscode.StatusBarAlignment = {Right: 2};
    h.vscode.ThemeColor = class {constructor(id){this.id=id;}};
    h.vscode.window.createStatusBarItem = () => item;
    h.tracker.onDidChangeRecordingState = () => ({dispose(){}});
    h.tracker.onDidChangeBaselineState = () => ({dispose(){}});
    const listeners = [];
    h.tracker.onDidTrackChanges = listener => {listeners.push(listener);return {dispose(){}};};
    h.state.subtreeCoverageGaps = [{targetPath:'/workspace/.aws',
        reasonCode:'supplemental-watcher-target-missing-gap',reason:'Deleted supplemental root'}];
    const tree = new (h.load('diffTreeView.ts').DiffTreeDataProvider)(h.tracker);
    const status = new (h.load('statusBarManager.ts').StatusBarManager)(h.tracker);
    assert.match(item.text, /Coverage Limited/);
    assert.match(item.tooltip, /1 subtree/);
    assert.ok((await tree.getChildren()).some(row => row.label === 'Monitoring Coverage Limited'));
    h.state.subtreeCoverageGaps = [];
    for (const listener of listeners) { listener({fullRefresh:true,baselineChanged:true}); }
    assert.equal((await tree.getChildren()).some(row => row.label === 'Monitoring Coverage Limited'), false);
    assert.equal(item.text, '$(circle-filled) Recording');
    assert.equal(item.command, 'diffTracker.toggleRecording');
    status.dispose();
});

for (const coverageLimited of [false, true]) {
    await test(`stopped status bar explains existing Live File diffs and the snapshot route (coverage limited=${coverageLimited})`, () => {
        const h = harness(null);
        const item = { show() {}, dispose() {} };
        h.vscode.StatusBarAlignment = { Right: 2 };
        h.vscode.ThemeColor = class { constructor(id) { this.id = id; } };
        h.vscode.window.createStatusBarItem = () => item;
        let recording = true;
        const listeners = [];
        h.tracker.getIsRecording = () => recording;
        h.tracker.onDidChangeRecordingState = listener => { listeners.push(listener); return { dispose() {} }; };
        h.tracker.onDidChangeBaselineState = () => ({ dispose() {} });
        if (coverageLimited) { h.state.subtreeCoverageGaps = [{ targetPath: '/workspace/missing' }]; }
        const status = new (h.load('statusBarManager.ts').StatusBarManager)(h.tracker);
        assert.doesNotMatch(item.tooltip, /Recording stopped|Live File/);
        recording = false;
        for (const listener of listeners) { listener(recording); }
        assert.match(item.tooltip, /Captured changes are preserved/);
        assert.match(item.tooltip, /Already-open Live File diffs still show the working file, including later edits/);
        assert.match(item.tooltip, /right-click a changed file in Change Recording and choose Open Native Review Snapshot/);
        assert.equal(item.command, coverageLimited ? 'diffTracker.manageMonitoringScope' : 'diffTracker.toggleRecording');
        const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
        assert.equal(manifest.contributes.commands.find(command => command.command === 'diffTracker.nativeReview.openFile').title,
            'Open Native Review Snapshot', 'the instruction names an existing command exactly');
        assert.ok(manifest.contributes.menus['view/item/context'].some(entry =>
            entry.command === 'diffTracker.nativeReview.openFile' && entry.when.includes('changedFile')));
        recording = true;
        for (const listener of listeners) { listener(recording); }
        assert.doesNotMatch(item.tooltip, /Recording stopped|Live File/, 'Start clears the stopped-only explanation');
        assert.deepEqual(h.commands, [], 'the explanation neither closes editors nor opens a modal');
        status.dispose();
    });
}

// VS Code TreeMenus separates group `inline` (primary/hover) from all other
// groups (secondary/right-click). One contribution does not provide both.
// https://github.com/microsoft/vscode/blob/1.80.2/src/vs/workbench/browser/parts/views/treeView.ts#L1500-L1522
for (const [command, contextValue] of [
    ['diffTracker.excludeCoverageSubtree', 'coverageDiagnosticSubtree'],
    ['diffTracker.excludeCoverageSubtree', 'coverageDiagnosticSubtreeRecheck'],
    ['diffTracker.recheckObservationCoverage', 'coverageDiagnosticSubtreeRecheck'],
    ['diffTracker.acceptFile', 'changedFile'],
    ['diffTracker.revertFile', 'changedFile'],
    ['diffTracker.acknowledgeOpaqueChange', 'opaqueFile'],
    ['diffTracker.acknowledgeLargeFileReminder', 'largeFileReminder'],
    ['diffTracker.resetUnknownBaseline', 'unknownFile']
]) {
    await test(`${command} has distinct scoped hover and right-click contributions`, () => {
        const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
        const entries = manifest.contributes.menus['view/item/context']
            .filter(item => item.command === command &&
                item.when === `view == diffTracker.changesView && viewItem == ${contextValue}`);
        assert.equal(entries.length, 2, 'exactly one entry per menu surface');
        for (const entry of entries) {
            assert.equal(entry.when,
                `view == diffTracker.changesView && viewItem == ${contextValue}`,
                'both surfaces must retain the same owning view and row category');
        }
        assert.equal(entries.filter(item => item.group?.split('@')[0] === 'inline').length, 1,
            'one primary hover action');
        assert.equal(entries.filter(item => item.group && item.group.split('@')[0] !== 'inline').length, 1,
            'one secondary right-click action, separate from the hover contribution');
        const declarations = manifest.contributes.commands.filter(item => item.command === command);
        assert.equal(declarations.length, 1, 'both surfaces reuse one command/handler');
        assert.ok(declarations[0].icon, 'the hover action retains its icon');
    });
}

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
    const workspaceSettings={monitoringScope:request.scope.mode,watchInclude:request.scope.includes,watchExclude:request.scope.excludes};
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
    h.vscode.workspace.getConfiguration=()=>({inspect:key=>({workspaceValue:workspaceSettings[key]}),update:async(key,value,target)=>{
        assert.equal(key,'watchExclude','the quick action must only update exclusions');
        assert.equal(target,h.vscode.ConfigurationTarget.Workspace);
        saveCount++;
        workspaceSettings[key]=value;
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
    const roots=[{name:folder.name,uri:folder.uri.toString(),
        caseSensitive:h.load('utils/pathIdentity.ts').detectLocalPathCaseSensitivity(root)}];
    let effective={kind:'configured',...h.load('monitoringScope.ts').validateAndCanonicalizeScope({
        mode:h.state.workspaceConfiguration.monitoringScope,
        includes:h.state.workspaceConfiguration.watchInclude,
        excludes:h.state.workspaceConfiguration.watchExclude
    },roots).scope};
    Object.assign(h.tracker,{
        getEffectiveMonitoringScope:()=>effective,
        getCommittedLegacyCompatibilityPolicy:()=>[],
        getExplicitlyExcludedPendingReviewPaths:()=>[],
        getExplicitlyExcludedReviewRevision:()=> 'stable-empty-review',
        captureScopeOperationObservation:()=>({activity:{active:true},wasMonitored:()=>undefined,hadGapTarget:()=>false}),
        getScopeOperationRecoveryTargets:()=>h.state.scopeRecoveryTargets??[],
        getScopeOperationCoverageGaps:()=>({related:h.state.relatedScopeCoverageGaps??[],
            unrelated:h.state.unrelatedScopeCoverageGaps??h.tracker.getCoverageGaps?.()??[]}),
        retainScopeOperationRecovery:async()=>true,
        recheckScopeOperationCoverage:(...args)=>h.tracker.recheckObservationCoverage(...args),
        applyConfiguredMonitoringScope:async(scope,discard,current)=>{
            assert.equal(current(),true,'the applied request must still be current');
            effective={kind:'configured',...scope};
            h.state.quickApplies=(h.state.quickApplies??0)+1;
            return {status:'applied'};
        },
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

function scopeEditorScriptHarness(onPost = () => undefined, savedState) {
    const elements = new Map(), sent = [], listeners = {};
    let persisted = savedState;
    const element = id => {
        if (!elements.has(id)) { elements.set(id,{value:'',textContent:'',disabled:false,listeners:{},
            addEventListener(event,handler){this.listeners[event]=handler;}}); }
        return elements.get(id);
    };
    const receive = message => listeners.message({data:message});
    vm.runInNewContext(fs.readFileSync('webview/watchExcludePanel.js','utf8'),{
        document:{getElementById:element},window:{addEventListener:(event,handler)=>{listeners[event]=handler;}},
        acquireVsCodeApi:()=>({postMessage:message=>{sent.push(message);return onPost(message);},
            getState:()=>persisted,setState:value=>{persisted=structuredClone(value);}})
    });
    return {elements,sent,receive,state:()=>persisted,
        input:(id,value)=>{const e=element(id);e.value=value;e.listeners.input?.();e.listeners.change?.();},
        click:id=>element(id).listeners.click()};
}

await test('scope editor retains raw invalid JSON when newer scope status arrives', () => {
    const ui=scopeEditorScriptHarness();
    ui.receive({command:'scopeStatus',requestVersion:'base',rawRequested:{mode:'rules',includes:[],excludes:[]}});
    ui.input('excludes','[ unparsed private draft');
    ui.receive({command:'scopeStatus',requestVersion:'newer',rawRequested:{mode:'wholeWorkspace',includes:[],excludes:[{scope:'all',pattern:'/other/'}]}});
    assert.equal(ui.elements.get('excludes').value,'[ unparsed private draft');
    assert.equal(ui.elements.get('mode').value,'rules');
});

await test('scope editor primary action freezes one version and only its matching completion accepts the draft', () => {
    const ui=scopeEditorScriptHarness();
    ui.receive({command:'scopeStatus',requestVersion:'base',rawRequested:{mode:'rules',includes:[],excludes:[]}});
    const raw='[ { "scope": "all", "pattern": "/a/" } ]';
    ui.input('excludes',raw);
    ui.click('save-apply');
    const action=ui.sent.find(message=>message.command==='saveAndApply');
    assert.ok(action);assert.equal(action.baseVersion,'base');
    assert.equal(ui.elements.get('excludes').disabled,true);
    ui.receive({command:'scopeStatus',requestVersion:'other',rawRequested:{mode:'wholeWorkspace',includes:[],excludes:[]}});
    assert.equal(ui.elements.get('excludes').value,raw);
    ui.receive({command:'scopeOperation',actionId:action.actionId-1,draftRevision:action.draftRevision,acceptDraft:true,outcome:{status:'applied'}});
    assert.equal(ui.elements.get('excludes').disabled,true,'an old completion cannot unlock the current action');
    ui.receive({command:'scopeOperation',actionId:action.actionId,draftRevision:action.draftRevision,acceptDraft:false,outcome:{status:'cancelled'}});
    assert.equal(ui.elements.get('excludes').disabled,false);
    ui.receive({command:'scopeStatus',requestVersion:'other',rawRequested:{mode:'wholeWorkspace',includes:[],excludes:[]}});
    assert.equal(ui.elements.get('excludes').value,raw,'Cancel preserves the raw draft');
    const restored=scopeEditorScriptHarness(()=>undefined,ui.state());
    restored.receive({command:'scopeStatus',requestVersion:'other',rawRequested:{mode:'wholeWorkspace',includes:[],excludes:[]}});
    assert.equal(restored.elements.get('excludes').value,raw,'webview reload preserves unsaved JSON');
});

// Run the production activation statements for scope commands unchanged. The
// controller and panel are real; only the VS Code host and tracker are stubs.
function monitoringScopeCommandHarness() {
    const h = coverageExclusionHarness();
    const callbacks = new Map();
    h.state.warnings = [];
    h.state.info = [];
    h.state.applies = 0;
    h.state.editorApplies = 0;
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
    const saveAndApplyScope=h.controller.saveAndApplyScope.bind(h.controller);
    h.controller.saveAndApplyScope=async(...args)=>{h.state.editorApplies++;return saveAndApplyScope(...args);};
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
        fs, vscode: h.vscode, WatchExcludePanel, diffTracker: h.tracker,
        monitoringScopeController: h.controller,
        context: { extensionUri: { fsPath: '/extension' }, subscriptions: [] },
        settingsTreeDataProvider: { refresh() {} }
    });
    return { ...h, WatchExcludePanel, run: (name, ...args) => callbacks.get(`diffTracker.${name}`)(...args) };
}

function connectScopeEditor(h) {
    const panel=h.WatchExcludePanel.currentPanel;
    const waiting=[];
    let ui,lastAction;
    h.state.createdPanels.at(-1).webview.postMessage=message=>{
        h.messages.push(message);
        if(ui)ui.receive(message);else waiting.push(message);
        return true;
    };
    ui=scopeEditorScriptHarness(message=>{
        const action=panel.handleMessage(message);
        if(['saveAndApply','saveRequest','restoreEffective','discardDraft','reviewConflict','apply','completeLegacyMigration'].includes(message.command))lastAction=action;
        return action;
    });
    waiting.forEach(message=>ui.receive(message));
    return {...ui,action:()=>lastAction};
}

await test('a clean open scope editor allows one quick exclusion and refreshes after its bounded draft lock', async () => {
    const h=monitoringScopeCommandHarness();await h.run('manageMonitoringScope');
    const panel=h.WatchExcludePanel.currentPanel,ui=connectScopeEditor(h);
    const outcome=await h.run('excludeCoverageSubtree',h.targets[0]);
    assert.equal(outcome?.status,'applied');
    assert.equal(h.WatchExcludePanel.currentPanel,panel);
    assert.ok(JSON.parse(ui.elements.get('excludes').value).some(rule=>rule.pattern==='/a/'));
    assert.equal(ui.elements.get('excludes').disabled,false);
    assert.equal(h.state.createdPanels.length,1);
    panel.dispose();
});

await test('an unsaved raw scope draft blocks quick exclusion and remains visible', async () => {
    const h=monitoringScopeCommandHarness();await h.run('manageMonitoringScope');
    const panel=h.WatchExcludePanel.currentPanel,ui=connectScopeEditor(h);
    ui.input('excludes','[ invalid unsaved JSON');
    assert.equal(await h.run('excludeCoverageSubtree',h.targets[0]),undefined);
    assert.equal(h.state.updates.length,0);
    assert.equal(ui.elements.get('excludes').value,'[ invalid unsaved JSON');
    assert.match(h.state.warnings.at(-1),/draft.*preserved/i);
    panel.dispose();
});

await test('a queued draft change during quick settings save invalidates the editor lease and preserves the input', async () => {
    const h=monitoringScopeCommandHarness();await h.run('manageMonitoringScope');
    const panel=h.WatchExcludePanel.currentPanel,ui=connectScopeEditor(h);
    const entered=deferred(),gate=deferred();
    const before=structuredClone(h.state.workspaceConfiguration);
    h.state.beforeConfigurationUpdate=async()=>{h.state.beforeConfigurationUpdate=undefined;entered.resolve();await gate.promise;};
    const operation=h.run('excludeCoverageSubtree',h.targets[0]);
    try {await entered.promise;ui.input('excludes','[ newer queued input');} finally {gate.resolve();}
    assert.equal((await operation).status,'conflict');
    assert.deepEqual(h.state.workspaceConfiguration,before);
    assert.equal(h.state.quickApplies??0,0);
    assert.equal(ui.elements.get('excludes').value,'[ newer queued input');
    assert.equal(ui.elements.get('excludes').disabled,false);
    panel.dispose();
});

await test('an unresponsive clean scope editor times out without settings writes and releases the scope action', async () => {
    const h=monitoringScopeCommandHarness();await h.run('manageMonitoringScope');
    const panel=h.WatchExcludePanel.currentPanel;
    await panel.handleMessage({command:'draftChanged',dirty:false,draftRevision:0});
    assert.equal(await h.run('excludeCoverageSubtree',h.targets[0]),undefined);
    assert.equal(h.state.updates.length,0);
    await panel.handleMessage({command:'saveAndApply',mode:'wholeWorkspace',includes:[],excludes:h.state.workspaceConfiguration.watchExclude,
        draftRevision:1,actionId:1,baseVersion:h.controller.getRequestVersion()});
    assert.equal(h.state.quickApplies,1,'the timed-out editor handshake cannot leave the action owned');
    panel.dispose();
});

await test('a closed webview transport cannot strand a quick-exclusion editor lock',async()=>{
    const h=monitoringScopeCommandHarness();await h.run('manageMonitoringScope');
    const panel=h.WatchExcludePanel.currentPanel;
    await panel.handleMessage({command:'draftChanged',dirty:false,draftRevision:0});
    const webview=h.state.createdPanels.at(-1).webview,post=webview.postMessage;
    webview.postMessage=()=>{throw new Error('Controlled closed webview transport');};
    try{assert.equal(await h.run('excludeCoverageSubtree',h.targets[0]),undefined);}
    finally{webview.postMessage=post;}
    assert.equal(h.state.updates.length,0);
    await panel.handleMessage({command:'saveAndApply',mode:'wholeWorkspace',includes:[],excludes:h.state.workspaceConfiguration.watchExclude,
        draftRevision:1,actionId:1,baseVersion:h.controller.getRequestVersion()});
    assert.equal(h.state.quickApplies,1);
    panel.dispose();
});

for(const answer of [false,true])await test(`scope editor explicit draft discard ${answer?'accepts':'cancels'} without settings or review changes`,async()=>{
    const h=monitoringScopeCommandHarness();await h.run('manageMonitoringScope');
    const panel=h.WatchExcludePanel.currentPanel,ui=connectScopeEditor(h);
    h.vscode.window.showWarningMessage=async(_message,_options,...buttons)=>answer?buttons[0]:undefined;
    const raw='[ unsaved draft';ui.input('excludes',raw);
    ui.click('discard-draft');await ui.action();
    assert.equal(h.state.updates.length,0);
    if(answer)assert.deepEqual(JSON.parse(ui.elements.get('excludes').value),h.state.workspaceConfiguration.watchExclude);
    else assert.equal(ui.elements.get('excludes').value,raw);
    assert.equal(ui.elements.get('excludes').disabled,false);
    panel.dispose();
});

await test('scope editor Restore preserves an unsaved draft while restoring the saved request',async()=>{
    const h=monitoringScopeCommandHarness();await h.run('manageMonitoringScope');
    const panel=h.WatchExcludePanel.currentPanel,ui=connectScopeEditor(h);
    const initial=structuredClone(h.state.workspaceConfiguration);
    ui.input('excludes','[ keep this raw draft');
    h.state.workspaceConfiguration.watchExclude.push({scope:'all',pattern:'/external/'});h.controller.reconcileRequestedScope();
    h.vscode.window.showWarningMessage=async(_message,_options,...buttons)=>buttons[0];
    ui.click('restore');await ui.action();
    assert.deepEqual(h.state.workspaceConfiguration,initial);
    assert.equal(ui.elements.get('excludes').value,'[ keep this raw draft');
    assert.equal(ui.elements.get('excludes').disabled,false);
    panel.dispose();
});

await test('scope editor reviews a settings conflict without overwriting its raw draft or the newer settings',async()=>{
    const h=monitoringScopeCommandHarness();await h.run('manageMonitoringScope');
    const panel=h.WatchExcludePanel.currentPanel,ui=connectScopeEditor(h);
    const raw='[ { "scope": "all", "pattern": "/my-draft/" } ]';ui.input('excludes',raw);
    h.state.workspaceConfiguration.watchExclude.push({scope:'all',pattern:'/external/'});h.controller.reconcileRequestedScope();
    await panel.handleMessage({command:'reload'});
    ui.click('save');await ui.action();
    assert.equal(h.state.updates.length,0,'stale Save Only cannot overwrite external settings');
    assert.equal(ui.elements.get('excludes').value,raw);
    h.vscode.window.showWarningMessage=async(_message,_options,...buttons)=>buttons[0];
    ui.click('review-conflict');await ui.action();
    assert.equal(h.state.updates.length,0,'reviewing the conflict does not save settings');
    assert.equal(ui.elements.get('excludes').value,raw);
    assert.ok(h.state.workspaceConfiguration.watchExclude.some(rule=>rule.pattern==='/external/'));
    ui.click('save-apply');await ui.action();
    assert.ok(h.state.workspaceConfiguration.watchExclude.some(rule=>rule.pattern==='/my-draft/'));
    assert.equal(h.state.quickApplies,1);
    panel.dispose();
});

await test('scope editor Save Request Only rejects malformed rules instead of replacing them with empty arrays',async()=>{
    const h=monitoringScopeCommandHarness();await h.run('manageMonitoringScope');
    const panel=h.WatchExcludePanel.currentPanel;
    await panel.handleMessage({command:'saveRequest',mode:'wholeWorkspace',includes:[],excludes:{invalid:true},
        baseVersion:h.controller.getRequestVersion(),draftRevision:1,actionId:1});
    assert.equal(h.state.updates.length,0);
    assert.equal(h.messages.find(message=>message.command==='scopeOperation').outcome.status,'conflict');
    panel.dispose();
});

await test('scope editor refuses an older save message after a newer draft revision arrives',async()=>{
    const h=monitoringScopeCommandHarness();await h.run('manageMonitoringScope');
    const panel=h.WatchExcludePanel.currentPanel;
    await panel.handleMessage({command:'draftChanged',dirty:true,draftRevision:2});
    await panel.handleMessage({command:'saveRequest',mode:'wholeWorkspace',includes:[],excludes:[],
        baseVersion:h.controller.getRequestVersion(),draftRevision:1,actionId:1});
    assert.equal(h.state.updates.length,0);
    assert.equal(h.messages.find(message=>message.command==='scopeOperation').outcome.status,'conflict');
    panel.dispose();
});

await test('stale Apply Saved Request replaces an older success result with the current conflict',async()=>{
    const h=monitoringScopeCommandHarness();await h.run('manageMonitoringScope');
    const panel=h.WatchExcludePanel.currentPanel,ui=connectScopeEditor(h);
    assert.equal((await panel.applyInteractively()).status,'applied');
    h.state.updates.length=0;
    h.state.workspaceConfiguration.watchExclude.push({scope:'all',pattern:'/external/'});h.controller.reconcileRequestedScope();
    ui.click('apply');await ui.action();
    assert.equal(h.state.updates.length,0);
    assert.equal(JSON.parse(ui.elements.get('status').textContent).operationOutcome.status,'conflict');
    assert.equal(ui.elements.get('excludes').disabled,false);
    panel.dispose();
});

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
        assert.equal(h.state.editorApplies, /apply|retry/.test(command) ? 1 : 0);
        await panel.handleMessage({ command: 'reload' });
        const draft = h.messages.at(-1).rawRequested;
        assert.ok(draft.excludes.some(rule => rule.pattern === '/a/'), 'the fresh editor includes the quick exclusion');
        await panel.handleMessage({ command: 'saveRequest', ...draft,baseVersion:h.controller.getRequestVersion() });
        assert.ok(h.state.workspaceConfiguration.watchExclude.some(rule => rule.pattern === '/a/'),
            'saving the fresh editor must retain the quick exclusion');
        panel.dispose();
    });
}

await test('scope editor stays blocked through each applied quick exclusion and concurrent intents must retry', async () => {
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
        assert.equal((await first).status, 'applied');
        assert.equal((await second).status, 'conflict', 'overlapping confirmed actions must not silently merge');
        const retry = h.run('excludeCoverageSubtree', h.targets[1]);
        await entered[1].promise;
        for (const command of scopeEditorCommands) {
            await h.run(command);
            assert.equal(h.WatchExcludePanel.currentPanel, undefined,
                'settling the first write cannot release ownership held by a queued request');
        }
        assert.equal(h.state.applies, 0);
        gates[1].resolve();
        assert.equal((await retry).status, 'applied');
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
    await test(`scope editor preserves the correct ownership after a ${failure}`, async () => {
        const h = monitoringScopeCommandHarness();
        if (failure === 'rejected operation') {
            h.tracker.getSubtreeCoverageGaps = () => { throw new Error('controlled coverage lookup failure'); };
            await assert.rejects(h.run('excludeCoverageSubtree', h.targets[0]), /controlled coverage lookup failure/);
        } else {
            h.state.beforeConfigurationUpdate = async () => { throw new Error('controlled settings failure'); };
            const result = await h.run('excludeCoverageSubtree', h.targets[0]);
            assert.equal(result.status, 'partial');
            assert.match(result.reason,/controlled settings failure/);
            assert.equal(h.controller.hasPendingScopeSettingsWrites(),true);
            await h.run('manageMonitoringScope');
            assert.equal(h.WatchExcludePanel.currentPanel,undefined);
            assert.match(h.state.warnings.at(-1),/unverified.*reload/i);
            h.controller.dispose();
            return;
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
    assert.match(h.state.warnings.at(-1), /draft.*preserved/i);
    panel.dispose();
    assert.equal((await h.run('excludeCoverageSubtree', h.targets[0])).status, 'applied');
});

await test('closing a saving scope editor blocks quick exclusion until its final draft is applied', async () => {
    const h = monitoringScopeCommandHarness();
    await h.run('manageMonitoringScope');
    const panel = h.WatchExcludePanel.currentPanel;
    const draft = { mode: 'wholeWorkspace', includes: [{ scope: 'all', path: 'src' }],
        excludes: [{ scope: 'all', pattern: '/editor-owned/' }] };
    const entered = deferred(), gate = deferred();
    h.state.beforeConfigurationUpdate = async () => {
        h.state.beforeConfigurationUpdate = undefined;
        entered.resolve();
        await gate.promise;
    };
    const save = panel.handleMessage({ command: 'saveRequest', ...draft,baseVersion:h.controller.getRequestVersion() });
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
    assert.equal((await quick).status, 'conflict');
    assert.deepEqual(h.state.updates.map(([key]) => key), ['monitoringScope', 'watchInclude', 'watchExclude']);
    assert.equal((await h.controller.excludeCoverageSubtree(h.targets[0], async()=>true)).status, 'conflict',
        'a saved request must be resolved before a fresh quick action');
    const requested=h.controller.getRequestedScope().scope;
    await h.tracker.applyConfiguredMonitoringScope(requested,false,()=>true);
    assert.equal((await h.run('excludeCoverageSubtree', h.targets[0])).status,'applied');
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

for(const changed of ['external-settings','closed-panel','newer-draft','unchanged']) await test(`PR60 REVIEW manual migration preserves ${changed} during confirmation`,async()=>{
    const h=monitoringScopeCommandHarness(),effective=h.tracker.getEffectiveMonitoringScope(),waits=[];
    h.tracker.getEffectiveMonitoringScope=()=>({kind:'legacyV3',roots:effective.roots,scopeRevision:'legacy'});
    h.tracker.prepareLegacyCompatibilityPolicySnapshot=async()=>true;
    h.state.configuration.watchExclude=['legacy/'];
    h.state.workspaceConfiguration={monitoringScope:'rules',watchInclude:[],watchExclude:[{scope:'all',pattern:'/old/'}]};
    h.controller.reconcileRequestedScope();
    h.vscode.window.showWarningMessage=(message,options)=>options?.modal?new Promise(resolve=>waits.push(resolve)):h.state.warnings.push(message);
    await h.run('manageMonitoringScope');const panel=h.WatchExcludePanel.currentPanel,ui=connectScopeEditor(h);
    ui.input('excludes',JSON.stringify([{scope:'all',pattern:'/old/'}]));
    ui.click('complete-migration');const action=ui.action();assert.equal(waits.length,1);
    if(changed==='external-settings'){
        h.state.workspaceConfiguration.watchExclude=[{scope:'all',pattern:'/newer/'}];h.controller.reconcileRequestedScope();
    }else if(changed==='closed-panel'){panel.dispose();}
    else if(changed==='newer-draft'){ui.input('excludes',JSON.stringify([{scope:'all',pattern:'/newer-draft/'}]));}
    waits[0]('Save and Mark Migration Complete');await action;
    if(changed!=='closed-panel'){assert.equal(ui.elements.get('complete-migration').disabled,false,'every terminal acknowledgement releases the editor');}
    if(changed==='unchanged'){
        assert.equal(h.state.updates.length,3);assert.equal(h.controller.getStatus().legacyMigrationComplete,true);panel.dispose();return;
    }
    assert.equal(h.state.updates.length,0,'a stale or closed confirmation cannot write settings');
    assert.deepEqual(h.state.workspaceConfiguration.watchExclude,[{scope:'all',pattern:changed==='external-settings'?'/newer/':'/old/'}]);
    assert.equal(h.controller.getStatus().legacyMigrationComplete,false);
    assert.equal(h.tracker.getEffectiveMonitoringScope().kind,'legacyV3');panel.dispose();
});

await test('PR60 REVIEW a closed migration confirmation cannot overwrite a newer panel result',async()=>{
    const h=monitoringScopeCommandHarness(),effective=h.tracker.getEffectiveMonitoringScope(),waits=[];
    h.tracker.getEffectiveMonitoringScope=()=>({kind:'legacyV3',roots:effective.roots,scopeRevision:'legacy'});
    h.tracker.prepareLegacyCompatibilityPolicySnapshot=async()=>true;
    h.state.configuration.watchExclude=['legacy/'];h.state.workspaceConfiguration={monitoringScope:'rules',watchInclude:[],watchExclude:[]};
    h.vscode.window.showWarningMessage=(_message,options)=>options?.modal?new Promise(resolve=>waits.push(resolve)):undefined;
    await h.run('manageMonitoringScope');const oldPanel=h.WatchExcludePanel.currentPanel,oldUI=connectScopeEditor(h);
    oldUI.input('excludes',JSON.stringify([{scope:'all',pattern:'/old/'}]));oldUI.click('complete-migration');const old=oldUI.action();oldPanel.dispose();
    await h.run('manageMonitoringScope');const panel=h.WatchExcludePanel.currentPanel,ui=connectScopeEditor(h);
    ui.input('excludes',JSON.stringify([{scope:'all',pattern:'/newer/'}]));ui.click('complete-migration');const newer=ui.action();
    assert.equal(waits.length,2);waits[1]('Save and Mark Migration Complete');await newer;
    const diagnostic=JSON.stringify(h.controller.getStatus().operationOutcome);
    waits[0]('Save and Mark Migration Complete');await old;
    assert.equal(JSON.stringify(h.controller.getStatus().operationOutcome),diagnostic);
    assert.deepEqual(h.state.workspaceConfiguration.watchExclude,[{scope:'all',pattern:'/newer/'}]);
    assert.equal(h.state.updates.length,3);panel.dispose();
});

await test('PR60 REVIEW a queued manual migration cannot replace a newer completed request',async()=>{
    const h=monitoringScopeCommandHarness(),effective=h.tracker.getEffectiveMonitoringScope();
    h.tracker.getEffectiveMonitoringScope=()=>({kind:'legacyV3',roots:effective.roots,scopeRevision:'legacy'});
    h.tracker.prepareLegacyCompatibilityPolicySnapshot=async()=>true;
    h.state.configuration.watchExclude=['legacy/'];h.state.workspaceConfiguration={monitoringScope:'rules',watchInclude:[],watchExclude:[]};
    const entered=deferred(),gate=deferred();let held=false;
    h.state.beforeConfigurationUpdate=async()=>{if(!held){held=true;entered.resolve();await gate.promise;}};
    const proposal=pattern=>({mode:'rules',includes:[],excludes:[{scope:'all',pattern}]});
    const first=h.controller.completeLegacyMigrationUsingCurrentScope(proposal('/newer/'));let second;
    try{await entered.promise;second=h.controller.completeLegacyMigrationUsingCurrentScope(proposal('/old/'));}
    finally{gate.resolve();await first;}
    const outcome=await second;
    assert.equal(outcome.status,'conflict',JSON.stringify(outcome));
    assert.deepEqual(h.state.workspaceConfiguration.watchExclude,[{scope:'all',pattern:'/newer/'}]);
    assert.equal(h.state.updates.length,3);
});

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
            first === 'restore' ? ['**/*.tmp'] : ['**/*.tmp', '/a/'],
            'quick actions conflict with an active Restore; a later Restore preserves an already applied exclusion');
        assert.deepEqual(h.state.updates.map(([key]) => key), first === 'restore'
            ? ['monitoringScope', 'watchInclude', 'watchExclude']
            : ['watchExclude'], 'a Restore confirmed against a superseded effective scope must not write');
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
        assert.equal((await h.run('excludeCoverageSubtree', h.targets[0])).status, 'applied');
        decision.resolve(answer);
        assert.equal(await restore, false,'a completed quick action invalidates the older Restore confirmation');
        assert.equal(h.controller.hasPendingScopeSettingsWrites(), false);
        assert.equal(h.state.workspaceConfiguration.watchExclude.some(rule => rule.pattern === '/a/'), true,
            'Restore uses the current effective scope, including a completed quick action');
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

function largeReminderHarness({ reviewKind = 'unknown', pending = true, retainedReview = false, currentExists = true } = {}) {
    const h = harness({
        filePath, fileName: 'large.bin', originalContent: 'retained baseline', currentContent: 'retained review',
        isDeleted: !currentExists, reviewKind, reviewReason: 'Prior review evidence is retained',
        unavailableReason: 'Too large for content review', changes: [],
        largeFileReminder: { pending, retainedReview, currentExists, currentSize: currentExists ? 80 * 1024 * 1024 : undefined }
    });
    // The backend owns capability policy. A metadata reminder cannot supply
    // content-review tokens, even when an older underlying review is retained.
    h.tracker.getReviewToken = h.tracker.getOpaqueReviewToken = h.tracker.getUnknownReviewToken = () => undefined;
    h.tracker.getReviewTokens = h.tracker.getOpaqueReviewTokens = h.tracker.getUnknownReviewTokens = () => [];
    return h;
}

for (const reviewKind of ['text', 'opaque', 'unknown']) {
    await test(`${reviewKind} large-file reminder gets a distinct metadata-only tree action`, async () => {
        const h = largeReminderHarness({ reviewKind, retainedReview: true });
        const tree = new (h.load('diffTreeView.ts').DiffTreeDataProvider)(h.tracker);
        const root = await tree.getChildren();
        const leaf = root.find(item => item.filePath === filePath);
        assert.equal(leaf.contextValue, 'largeFileReminder');
        assert.match(leaf.description, /Large-file reminder/);
        assert.match(leaf.description, /80\.0 MiB/);
        assert.match(leaf.tooltip, /content.*not.*compared/i);
        assert.match(leaf.tooltip, /prior review.*Undo/i);
        assert.doesNotMatch(leaf.tooltip, /SHA-256|new baseline|Renamed/);
        assert.deepEqual(JSON.parse(JSON.stringify(leaf.largeFileReminderToken)), largeFileReminderToken);
        assert.equal(leaf.command.command, 'diffTracker.showWebviewDiff');
        assert.equal(leaf.reviewToken, undefined);
        assert.equal(leaf.opaqueReviewToken, undefined);
        assert.equal(leaf.unknownReviewToken, undefined);
        assert.equal(root.some(item => item.command?.command === 'diffTracker.resetAllUnknownBaselines'), false);
        assert.equal(root.some(item => item.command?.command === 'diffTracker.keepAllChanges'), false);
        assert.match(root.find(item => item.label === 'Pending Review').description, /1 large-file reminder/);
    });
}
await test('acknowledged large-file reminder retains an old-review row without another acknowledgement', async () => {
    const h = largeReminderHarness({ pending: false, retainedReview: true });
    const tree = new (h.load('diffTreeView.ts').DiffTreeDataProvider)(h.tracker);
    const root = await tree.getChildren();
    const leaf = root.find(item => item.filePath === filePath);
    assert.equal(leaf.contextValue, 'retainedLargeFileReview');
    assert.match(leaf.description, /Prior review retained/);
    assert.match(leaf.tooltip, /reminder.*acknowledged/i);
    assert.equal(leaf.largeFileReminderToken, undefined);
    assert.match(root.find(item => item.label === 'Pending Review').description, /1 retained review/);
});

await test('large-file reminders expose only reminder dismissal and inspection; retained rows are inspect-only', () => {
    const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const entries = manifest.contributes.menus['view/item/context'];
    for (const [contextValue, expected] of [
        ['largeFileReminder', ['diffTracker.acknowledgeLargeFileReminder', 'diffTracker.showWebviewDiff']],
        ['retainedLargeFileReview', ['diffTracker.showWebviewDiff']]
    ]) {
        const commands = entries.filter(item => (item.when ?? '').includes(`viewItem == ${contextValue}`)).map(item => item.command);
        assert.deepEqual([...new Set(commands)].sort(), expected.sort());
    }
});

await test('large-file Webview is metadata-only and permits reminder dismissal even with retained Unknown evidence', () => {
    const h = largeReminderHarness({ retainedReview: true });
    h.tracker.getOriginalContent = () => { throw new Error('Reminder must not read baseline text'); };
    h.tracker.getChangeBlocks = () => { throw new Error('Reminder must not build content diff blocks'); };
    h.vscode.workspace.textDocuments = [{ uri: { scheme: 'file', fsPath: filePath }, getText: () => { throw new Error('Reminder must not read editor text'); } }];
    h.panel.sendDataUpdate();
    const payload = h.messages[0];
    assert.deepEqual(payload.largeFileReminder, h.state.changes[0].largeFileReminder);
    assert.deepEqual(JSON.parse(JSON.stringify(payload.largeFileReminderToken)), largeFileReminderToken);
    assert.equal(payload.oldContents, '');
    assert.equal(payload.newContents, '');
    assert.deepEqual(Array.from(payload.changeBlocks), []);
    const ui = runInline(h.panel.getHtmlContent());
    assert.match(ui.notice(), /Large-file metadata reminder/);
    assert.match(ui.notice(), /80\.0 MiB/);
    assert.match(ui.notice(), /content.*not.*compared/i);
    assert.match(ui.notice(), /prior review.*Undo/i);
    assert.doesNotMatch(ui.notice(), /SHA-256|Baseline: exists/);
    assert.equal(ui.rendererCalls(), 0);
    assert.equal(ui.elements.get('btn-keep-all').textContent, 'Acknowledge Reminder');
    assert.equal(ui.elements.get('btn-keep-all').disabled, false);
    assert.equal(ui.elements.get('btn-reject-all').disabled, true);
    ui.click('btn-keep-all');
    assert.equal(ui.sent[0].command, 'acknowledgeReminder');
    assert.deepEqual(JSON.parse(JSON.stringify(ui.sent[0].largeFileReminderToken)), largeFileReminderToken);
    assert.equal(ui.elements.get('btn-keep-all').disabled, true);
});

await test('large-file Webview routes its captured reminder token through the independent command', async () => {
    const h = largeReminderHarness();
    await h.panel.handleMessage({ command: 'acknowledgeReminder', filePath, requestId: 'reminder-ack',
        largeFileReminderToken, viewGeneration: 0 });
    assert.equal(h.commands.length, 1);
    assert.equal(h.commands[0][0], 'diffTracker.acknowledgeLargeFileReminder');
    assert.equal(h.commands[0][1], filePath);
    assert.deepEqual(JSON.parse(JSON.stringify(h.commands[0][2])), largeFileReminderToken);
    assert.deepEqual(h.messages.map(message => message.command), ['actionAck', 'updateData']);
    assert.equal(h.messages[0].ok, true);
});

await test('deleted large-file reminders describe missing metadata without inventing a rename or content identity', async () => {
    const h = largeReminderHarness({ currentExists: false });
    const tree = new (h.load('diffTreeView.ts').DiffTreeDataProvider)(h.tracker);
    const leaf = (await tree.getChildren()).find(item => item.filePath === filePath);
    assert.match(leaf.description, /Large-file reminder · Deleted/);
    assert.doesNotMatch(leaf.tooltip, /SHA-256|Renamed/);
    const ui = runInline(h.panel.getHtmlContent());
    assert.match(ui.notice(), /Current: deleted/);
    assert.equal(ui.elements.get('btn-keep-all').disabled, false);
    assert.equal(ui.elements.get('btn-reject-all').disabled, true);
});

await test('large-file reminder success preserves the retained review notice and removes the repeated action', () => {
    const h = largeReminderHarness({ retainedReview: true });
    const ui = runInline(h.panel.getHtmlContent());
    ui.click('btn-keep-all');
    const request = ui.sent[0];
    ui.receive({ command: 'actionAck', requestId: request.requestId, ok: true, filePath, viewGeneration: 0 });
    assert.equal(ui.elements.get('btn-keep-all').disabled, true, 'wait for authoritative refresh');
    h.state.changes[0].largeFileReminder.pending = false;
    h.panel.sendDataUpdate();
    ui.receive(h.messages.at(-1));
    assert.match(ui.notice(), /reminder acknowledged/i);
    assert.match(ui.notice(), /prior review remains pending/i);
    assert.equal(ui.elements.get('btn-keep-all').hidden, true);
    assert.equal(ui.elements.get('btn-keep-all').disabled, true);
    assert.equal(ui.elements.get('btn-reject-all').hidden, true);
    ui.click('btn-keep-all');
    assert.equal(ui.sent.length, 1, 'an acknowledged reminder cannot be sent again');

    const nextToken = { ...largeFileReminderToken, reviewRevision: 'new-size-reminder' };
    h.state.changes[0].largeFileReminder = { pending: true, retainedReview: true, currentExists: true, currentSize: 90 * 1024 * 1024 };
    h.tracker.getLargeFileReminderToken = () => nextToken;
    h.panel.sendDataUpdate();
    ui.receive(h.messages.at(-1));
    assert.match(ui.notice(), /90\.0 MiB/);
    assert.equal(ui.elements.get('btn-keep-all').hidden, false);
    assert.equal(ui.elements.get('btn-keep-all').disabled, false);
    ui.click('btn-keep-all');
    assert.deepEqual(JSON.parse(JSON.stringify(ui.sent[1].largeFileReminderToken)), nextToken);
    ui.receive({ command: 'actionAck', requestId: request.requestId, ok: true, filePath, viewGeneration: 0 });
    assert.equal(ui.elements.get('btn-keep-all').disabled, true, 'an old acknowledgement cannot unlock a newer request');
});

await test('large-file reminder refresh can remove a dismissed-only row or return to ordinary opaque review', () => {
    for (const next of ['removed', 'opaque']) {
        const h = largeReminderHarness();
        const ui = runInline(h.panel.getHtmlContent());
        h.state.changes = next === 'removed' ? [] : [{
            filePath, fileName: 'image.png', originalContent: '', currentContent: '', isDeleted: false,
            reviewKind: 'opaque', currentSize: 20, currentExists: true, changes: []
        }];
        h.tracker.getOpaqueReviewToken = () => next === 'opaque' ? opaqueReviewToken : undefined;
        h.panel.sendDataUpdate();
        ui.receive(h.messages.at(-1));
        assert.doesNotMatch(ui.notice(), /Large-file/);
        if (next === 'removed') {
            assert.equal(ui.elements.get('btn-keep-all').disabled, true);
            ui.click('btn-keep-all');
            assert.deepEqual(ui.sent, []);
        } else {
            assert.equal(ui.elements.get('btn-keep-all').textContent, 'Acknowledge');
            assert.equal(ui.elements.get('btn-keep-all').hidden, false);
            assert.equal(ui.elements.get('btn-reject-all').hidden, false, 'restore ordinary opaque toolbar presentation');
            ui.click('btn-keep-all');
            assert.equal(ui.sent[0].command, 'acknowledge');
            assert.deepEqual(JSON.parse(JSON.stringify(ui.sent[0].opaqueReviewToken)), opaqueReviewToken);
            assert.equal(ui.sent[0].largeFileReminderToken, undefined);
        }
    }
});

await test('successful large-file reminder dismissal never reads an open large editor after removing its review row', async () => {
    const h = largeReminderHarness();
    const ui = runInline(h.panel.getHtmlContent());
    let textReads = 0;
    h.vscode.workspace.textDocuments = [{ uri: { scheme: 'file', fsPath: filePath }, getText() {
        textReads++;
        throw new Error('Do not read the large editor after reminder dismissal');
    } }];
    h.tracker.getOriginalContent = () => 'unreviewed baseline content';
    ui.click('btn-keep-all');
    const pending = h.panel.handleMessage(ui.sent[0]);
    h.state.changes = []; // The independent ledger remains; only the pending projection disappears.
    await pending;
    assert.equal(textReads, 0);
    assert.equal(h.messages[0].ok, true);
    const payload = h.messages.at(-1);
    assert.equal(payload.hasFileChange, false);
    assert.equal(payload.oldContents, '');
    assert.equal(payload.newContents, '');
    assert.deepEqual(Array.from(payload.changeBlocks), []);
    for (const message of h.messages) { ui.receive(message); }
    assert.equal(ui.elements.get('btn-keep-all').disabled, true);
    assert.equal(ui.elements.get('btn-reject-all').disabled, true);
    assert.equal(ui.rendererCalls(), 0);
});

await test('an ordinary file without an authoritative review renders an empty disabled view without reading text', () => {
    const h = harness(null);
    let textReads = 0;
    const unexpectedRead = () => { textReads++; throw new Error('No review means no text to display'); };
    h.tracker.getOriginalContent = unexpectedRead;
    h.tracker.getChangeBlocks = unexpectedRead;
    h.vscode.workspace.textDocuments = [{ uri: { scheme: 'file', fsPath: filePath }, getText: unexpectedRead }];
    const ui = runInline(h.panel.getHtmlContent());
    h.panel.sendDataUpdate();
    const payload = h.messages.at(-1);
    ui.receive(payload);
    assert.equal(textReads, 0);
    assert.equal(payload.hasFileChange, false);
    assert.equal(payload.oldContents, '');
    assert.equal(payload.newContents, '');
    assert.deepEqual(Array.from(payload.changeBlocks), []);
    assert.equal(ui.rendererCalls(), 0);
    assert.equal(ui.elements.get('btn-keep-all').disabled, true);
    assert.equal(ui.elements.get('btn-reject-all').disabled, true);
});

await test('large-file reminder request locking rejects duplicates and never substitutes another token', async () => {
    const h = largeReminderHarness();
    const gate = deferred();
    h.state.gate = gate.promise;
    const request = { command: 'acknowledgeReminder', filePath, requestId: 'reminder-busy', largeFileReminderToken, viewGeneration: 0 };
    const pending = h.panel.handleMessage(request);
    try {
        assert.equal(h.commands.length, 1);
        await h.panel.handleMessage(request);
        await h.panel.handleMessage({ ...request, requestId: 'other-reminder' });
        assert.equal(h.commands.length, 1);
        assert.match(h.messages[0].error, /Another review action is in progress/);
        assert.deepEqual(JSON.parse(JSON.stringify(h.commands[0][2])), largeFileReminderToken);
    } finally {
        gate.resolve();
        await pending;
    }
    assert.equal(h.messages.at(-2).requestId, request.requestId);
    assert.equal(h.messages.at(-2).ok, true);
});

for (const issue of ['missing-token', 'wrong-token-kind', 'wrong-path', 'old-view']) {
    await test(`large-file reminder ${issue} never executes a mutation`, async () => {
        const h = largeReminderHarness();
        await h.panel.handleMessage({ command: 'acknowledgeReminder', filePath: issue === 'wrong-path' ? '/other.bin' : filePath,
            requestId: issue, viewGeneration: issue === 'old-view' ? -1 : 0,
            largeFileReminderToken: ['missing-token', 'wrong-token-kind'].includes(issue) ? undefined : largeFileReminderToken,
            opaqueReviewToken: issue === 'wrong-token-kind' ? opaqueReviewToken : undefined });
        assert.deepEqual(h.commands, []);
        if (['missing-token', 'wrong-token-kind'].includes(issue)) {
            assert.equal(h.messages[0].ok, false);
            assert.match(h.messages[0].error, /Review target is unavailable/);
        }
    });
}

await test('failed large-file reminder dismissal remains visible and actionable after the current-state refresh', async () => {
    const h = largeReminderHarness();
    const ui = runInline(h.panel.getHtmlContent());
    h.state.result = { filePath, status: 'conflict', reason: 'Size changed; reminder retained' };
    ui.click('btn-keep-all');
    await h.panel.handleMessage(ui.sent[0]);
    assert.equal(h.messages[0].ok, false);
    assert.equal(h.messages[0].error, h.state.result.reason);
    for (const message of h.messages) { ui.receive(message); }
    assert.match(ui.notice(), /Large-file metadata reminder/);
    assert.equal(ui.elements.get('btn-keep-all').disabled, false);
});

await test('a size update during reminder dismissal stays locked and requires a new explicit click with the new token', async () => {
    const h = largeReminderHarness();
    const ui = runInline(h.panel.getHtmlContent());
    const gate = deferred();
    h.state.gate = gate.promise;
    ui.click('btn-keep-all');
    const pending = h.panel.handleMessage(ui.sent[0]);
    const nextToken = { ...largeFileReminderToken, reviewRevision: 'concurrent-size-change' };
    try {
        h.state.changes[0].largeFileReminder.currentSize = 96 * 1024 * 1024;
        h.tracker.getLargeFileReminderToken = () => nextToken;
        h.panel.sendDataUpdate();
        assert.equal(h.messages.at(-1).mutationBusy, true);
        ui.receive(h.messages.at(-1));
        assert.equal(ui.elements.get('btn-keep-all').disabled, true);
        ui.click('btn-keep-all');
        assert.equal(ui.sent.length, 1);
        assert.deepEqual(JSON.parse(JSON.stringify(h.commands[0][2])), largeFileReminderToken);
        h.state.result = { filePath, status: 'conflict', reason: 'Size changed; reminder retained' };
    } finally {
        gate.resolve();
        await pending;
    }
    assert.equal(h.commands.length, 1, 'do not retry an old approval against the new metadata');
    for (const message of h.messages.slice(1)) { ui.receive(message); }
    assert.match(ui.notice(), /96\.0 MiB/);
    assert.equal(ui.elements.get('btn-keep-all').disabled, false);
    ui.click('btn-keep-all');
    assert.deepEqual(JSON.parse(JSON.stringify(ui.sent[1].largeFileReminderToken)), nextToken);
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
    const names=new Set(['diffTracker.openDiffDefault','diffTracker.showOriginalAndWebviewSplit','diffTracker.showWebviewDiff','diffTracker.showSideBySideDiff','diffTracker.showSideBySideDiffActive','diffTracker.clearDiffs','diffTracker.selectDefaultOpenMode','diffTracker.selectWebviewDiffStyle',archiveRestoreCommand]);
    function visit(node){
        if(ts.isVariableDeclaration(node)&&['startRecordingAfterPrechecks','startRecordingFlow','stopRecordingFlow'].includes(node.name.getText(source)))helpers.push(`const ${node.getText(source)};`);
        if(ts.isFunctionDeclaration(node)&&['extractFilePath','extractIsDeleted','getDefaultOpenMode','isDeletedReview'].includes(node.name?.text))helpers.push(node.getText(source));
        if(ts.isCallExpression(node)&&node.expression.getText(source)==='vscode.commands.registerCommand'&&names.has(node.arguments[0]?.text))callbacks.push(`${JSON.stringify(node.arguments[0].text)}:${node.arguments[1].getText(source)}`);
        ts.forEachChild(node,visit);
    }
    visit(source);
    class Uri {constructor(fsPath,scheme='file'){this.fsPath=fsPath;this.scheme=scheme;}static file(p){return new Uri(p);}with(change){return Object.assign(new Uri(this.fsPath,this.scheme),change);}}
    let sandbox;
    const vscode={Uri,ConfigurationTarget:{Global:1,Workspace:2},ViewColumn:{One:1,Two:2},
        workspace:{workspaceFolders:[{uri:Uri.file('/workspace')}],getConfiguration:()=>({get:(_key,fallback)=>state.mode??fallback,inspect:key=>({workspaceValue:state.workspaceConfiguration?.[key]}),update:async(...args)=>state.updates.push(args)}),openTextDocument:async()=>{state.opened++;if(state.deleted)throw Object.assign(new Error('FileNotFound'),{code:'FileNotFound'});return{};}},
        window:{
            get activeTextEditor(){return state.activeTextEditor;},
            showErrorMessage:()=>{state.recoveryPrompts=(state.recoveryPrompts??0)+1;return state.recoveryGate??'Discard Saved Session and Rebuild';},
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
                    if(args.includes('Replace Review and Start')) return state.replaceAnswer ?? 'Replace Review and Start';
                    if(args.includes('Rebuild Baseline')) return state.rebuildGate??'Rebuild Baseline';
                    if(state.clearGate) return state.clearGate;
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
        isRecoveryBlocked:()=>state.recoveryBlocked??false,getBaselineState:()=>state.baselineState??'ready',
        discardRecoveryState:async()=>{state.discards=(state.discards??0)+1;await state.discardGate;return state.discardResult??true;},
        stopRecording:()=>{state.recording=false;},
        startRecording:()=>{state.archiveEvents.push('start');state.starts++;if(state.startResult)state.recording=true;return state.startResult;},
        setBaselineGitContexts:contexts=>{state.archiveEvents.push('setBaselineGitContexts');state.baselineGitContexts.push(contexts);},
        resetBaselineToCurrentState:async()=>{state.resets++;await state.resetGate;return state.resetResult;},clearDiffs:()=>{state.legacyClears++;},
        reconcileRestoredGitContexts:contexts=>{state.archiveEvents.push('reconcile');state.reconciliations.push(contexts);},
        previewArchivedGitReview:async()=>{state.archiveEvents.push('preview');state.previews++;await state.archivePreviewGate;return state.archivePreview;},
        restoreArchivedGitReview:async token=>{state.archiveEvents.push('restore');state.restoreTokens.push(token);state.onArchiveRestore?.(token);await state.archiveRestoreGate;return state.archiveResult;}};
    const gitContextMonitor=state.noGitMonitor?undefined:{
        setObserving:()=>{},
        whenReady:()=>state.gitGate??true,
        isReady:()=>{state.archiveEvents.push('ready');return state.gitReady;},
        getSnapshots:()=>{state.archiveEvents.push('snapshots');return state.gitSnapshots;}
    };
    sandbox={monitoringScopeController:{getStatus:()=>({requested:{ok:true},expansionReasons:[],consented:true,effective:{kind:'legacyV3'},workspaceRequestPresent:false})},recordingRequest:0,vscode,diffTracker:tracker,displayFileName:path.basename,context:{extensionUri:{}},WebviewDiffPanel:{createOrShow:()=>state.panels++},
        settingsTreeDataProvider:{refresh(){}},refreshChangesTree:()=>{},decorationManager:{clearAllDecorations:()=>{}},
        setRecordingContext:value=>{state.archiveEvents.push('setRecordingContext');state.recordingContexts.push(value);},
        gitContextMonitor,refreshReview:()=>{state.archiveEvents.push('refresh');state.reviewRefreshes++;},console};
    vm.createContext(sandbox);
    vm.runInContext(ts.transpileModule(`${helpers.join('\n')}globalThis.callbacks={${callbacks.join(',')}};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,sandbox);
    return {state,Uri,startFlow:()=>vm.runInContext('startRecordingFlow()',sandbox),stopFlow:()=>vm.runInContext('stopRecordingFlow()',sandbox),startRecording:()=>vm.runInContext('startRecordingAfterPrechecks()',sandbox),registeredCommands:callbacks.map(callback=>JSON.parse(callback.slice(0,callback.indexOf(':')))),run:(name,...args)=>sandbox.callbacks[name](...args)};
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
for (const recording of [false, true]) {
    await test(`side-by-side opens ${recording ? 'the live file while recording' : 'a captured review while stopped'}`, async () => {
        const h = commandHarness({ recording, deleted: false });
        for (const target of [filePath, { filePath }, new h.Uri(filePath)]) {
            h.state.executed.length = 0;
            await h.run('diffTracker.showSideBySideDiff', target);
            const call = h.state.executed[0];
            assert.equal(h.state.executed.length, 1, 'choose exactly one review route');
            if (recording) {
                assert.equal(call[0], 'vscode.diff');
                assert.equal(call[1].scheme, 'diff-tracker-original');
                assert.equal(call[2].scheme, 'file');
                assert.equal(call[2].fsPath, filePath);
                assert.match(call[3], /Original  ↔  Live File:/, 'a live tab remains explicitly labeled even after Stop');
            } else {
                assert.deepEqual(call, ['diffTracker.nativeReview.openFile', filePath],
                    'the existing adapter supplies immutable text and safe opaque/unknown fallback');
            }
        }
        assert.equal(h.state.opened, 0, 'do not read a working document to capture a stopped review');
        assert.deepEqual(h.state.updates, [], 'the selected open mode remains unchanged');
    });
}
await test('side-by-side handles a missing target without opening a live or snapshot editor', async () => {
    const h = commandHarness();
    await h.run('diffTracker.showSideBySideDiff');
    assert.deepEqual(h.state.executed, []);
});
await test('side-by-side active-file command uses the same stopped snapshot route', async () => {
    const h = commandHarness({ deleted: false });
    h.state.activeTextEditor = { document: { uri: new h.Uri(filePath) } };
    await h.run('diffTracker.showSideBySideDiffActive');
    assert.deepEqual(h.state.executed, [
        ['diffTracker.showSideBySideDiff', filePath], ['diffTracker.nativeReview.openFile', filePath]
    ]);
    h.state.executed.length = 0;
    h.state.activeTextEditor = { document: { uri: new h.Uri(filePath, 'diff-tracker-review-current') } };
    await h.run('diffTracker.showSideBySideDiffActive');
    assert.deepEqual(h.state.executed, [], 'virtual snapshot is not reinterpreted as a working file');
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
await test('opaque exposes Acknowledge and unknown exposes explicit Baseline Reset plus inspection',()=>{
    const manifest=JSON.parse(fs.readFileSync('package.json','utf8'));
    const items=manifest.contributes.menus['view/item/context'];
    const opaqueCommands=items
        .filter(item=>(item.when??'').includes('viewItem == opaqueFile'))
        .map(item=>item.command);
    assert.deepEqual([...new Set(opaqueCommands)].sort(),['diffTracker.acknowledgeOpaqueChange','diffTracker.showWebviewDiff']);
    const unknownCommands=items
        .filter(item=>(item.when??'').includes('viewItem == unknownFile'))
        .map(item=>item.command);
    assert.deepEqual([...new Set(unknownCommands)].sort(),['diffTracker.resetUnknownBaseline','diffTracker.showWebviewDiff']);
});

// Execute production command closures, with deferred VS Code confirmations and
// Git initialization. Clear invalidates only requests older than its commit.
for (const [confirmClear, resetResult] of [[true,true],[false,true],[true,false]]) {
    await test(`Clear command pending Start: accepted=${confirmClear}, reset=${resetResult}`, async()=>{
        const gate=deferred();const h=commandHarness({gitGate:gate.promise,confirmClear,resetResult});
        const start=h.startFlow();await Promise.resolve();
        assert.equal(await h.run('diffTracker.clearDiffs'),confirmClear&&resetResult);
        gate.resolve(true);assert.equal(await start,!confirmClear);
        assert.equal(h.state.starts,confirmClear?0:1);
    });
}
await test('Clear completion does not cancel a newer Start waiting for Git',async()=>{
    const reset=deferred(),git=deferred();const h=commandHarness({resetGate:reset.promise,gitGate:git.promise});
    const clear=h.run('diffTracker.clearDiffs');await Promise.resolve();assert.equal(h.state.resets,1);
    const start=h.startFlow();reset.resolve();assert.equal(await clear,true);
    git.resolve(true);assert.equal(await start,true);assert.equal(h.state.starts,1);
});
for (const boundary of ['rebuild','recovery','discard']) {
    for (const cancel of ['clear','stop']) {
        await test(`Start ${boundary} continuation obeys later ${cancel}`,async()=>{
            const gate=deferred();const options=boundary==='rebuild'?{baselineState:'building',rebuildGate:gate.promise}:boundary==='recovery'?{recoveryBlocked:true,recoveryGate:gate.promise}:{recoveryBlocked:true,discardGate:gate.promise};
            const h=commandHarness(options);const start=h.startFlow();
            await Promise.resolve();await Promise.resolve();await Promise.resolve();
            if(boundary==='discard')assert.equal(h.state.discards,1);
            if(cancel==='clear')assert.equal(await h.run('diffTracker.clearDiffs'),true);else h.stopFlow();
            gate.resolve(boundary==='rebuild'?'Rebuild Baseline':'Discard Saved Session and Rebuild');
            assert.equal(await start,false);assert.equal(h.state.starts,0);
            if(boundary==='recovery')assert.equal(h.state.discards??0,0,'stale confirmation must not discard recovery');
        });
    }
}
await test('Clear rejected for changed recording state does not cancel pending Start',async()=>{
    const confirm=deferred(),git=deferred();const h=commandHarness({clearGate:confirm.promise,gitGate:git.promise});
    const clear=h.run('diffTracker.clearDiffs');const start=h.startFlow();h.state.recording=true;
    confirm.resolve('Clear Diffs');assert.equal(await clear,false);assert.equal(h.state.resets,0);
    git.resolve(true);assert.equal(await start,true);
});


await test('ordinary file and folder quick exclusions use exact rooted rules without coverage warnings',async()=>{
    const h=coverageExclusionHarness();h.state.subtreeCoverageGaps=[];
    const root=path.resolve('.');
    assert.equal((await h.controller.requestExcludeResource(path.join(root,'plain'),false)).status,'saved');
    assert.equal((await h.controller.requestExcludeResource(path.join(root,'folder'),true)).status,'saved');
    const patterns=h.state.workspaceConfiguration.watchExclude.map(rule=>rule.pattern);
    assert.ok(patterns.includes('/plain'));assert.ok(patterns.includes('/folder/'));
    const match=require('ignore')().add(patterns);
    assert.ok(match.ignores('plain'));assert.equal(match.ignores('nested/plain'),false);
    assert.equal(match.ignores('plain-extra'),false);assert.ok(match.ignores('folder/child'));
    assert.equal(match.ignores('folder-extra/child'),false);
    for(const name of ['a*','a?','a[1]','space ','#comment','!negation']) {
        assert.equal((await h.controller.requestExcludeResource(path.join(root,name),false)).status,'blocked');
    }
    assert.equal((await h.controller.requestExcludeResource(root,true)).status,'blocked');
    assert.equal(h.state.updates.length,2,'refused paths must never alter settings');
    const backslashResult=await h.controller.requestExcludeResource(path.join(root,'a\\b'),false);
    if(path.sep==='\\') {
        assert.equal(backslashResult.status,'saved','Windows backslashes identify path components');
        const exact=h.state.workspaceConfiguration.watchExclude.find(rule=>rule.pattern==='/a/b');
        assert.ok(exact,'Windows separators must canonicalize to the exact nested path');
        const windowsMatch=require('ignore')().add(exact.pattern);
        assert.ok(windowsMatch.ignores('a/b'));
        assert.equal(windowsMatch.ignores('aXb'),false);
        assert.equal(windowsMatch.ignores('a/bc'),false);
        assert.equal(h.state.updates.length,3);
    } else {
        assert.equal(backslashResult.status,'blocked','literal backslashes cannot become exclusion escapes');
        assert.equal(h.state.updates.length,2);
    }
});


for(const pattern of ['/plain/','/plain/*'])await test(`file exclusion is not confused with directory rule ${pattern}`,async()=>{
    const h=coverageExclusionHarness();h.state.subtreeCoverageGaps=[];
    h.state.workspaceConfiguration.watchExclude=[{scope:'all',pattern}];
    const outcome=await h.controller.requestExcludeResource(path.resolve('plain'),false);
    assert.equal(outcome.status,'saved');assert.ok(h.state.workspaceConfiguration.watchExclude.some(rule=>rule.pattern==='/plain'));
});

for(const scenario of ['success','disabled','failed','conflict','cancelled','remaining','switch','switch-back','paused','last']) {
    await test(`auto-next navigation ${scenario}`,async()=>{
        const h=harness(null);h.state.configuration.autoOpenNextPendingFile=scenario!=='disabled';
        let listener;const originalEditor={};h.vscode.window.activeTextEditor=originalEditor;
        h.vscode.window.onDidChangeActiveTextEditor=fn=>{listener=fn;return{dispose(){listener=undefined;}};};
        let changes=['/b','/c','/a'].map(filePath=>({filePath}));
        if(scenario==='last')changes=[{filePath:'/b'}];
        Object.assign(h.tracker,{getTrackedChanges:()=>changes,getTrackedChange:p=>changes.find(c=>c.filePath===p),
            getPausedGitRepositories:()=>scenario==='paused'?[{}]:[]});
        const run=h.load('reviewNavigation.ts').withReviewNavigation;
        const status=['failed','conflict','cancelled'].includes(scenario)?scenario:'success';
        const result=await run(h.tracker,'/b',async()=>{
            if(scenario!=='remaining')changes=changes.filter(c=>c.filePath!=='/b');
            if(scenario.startsWith('switch')){h.vscode.window.activeTextEditor={};listener();}
            if(scenario==='switch-back'){h.vscode.window.activeTextEditor=originalEditor;listener();}
            return{status,filePath:'/b'};
        });
        assert.equal(result.status,status);
        const navigations=h.commands.filter(command=>command[0]==='diffTracker.openDiffDefault');
        assert.equal(navigations.length,scenario==='success'?1:0);
        if(navigations.length)assert.equal(navigations[0][1],'/c','stable path order independent of timestamps');
        assert.equal(listener,undefined,'temporary listener must be disposed');
    });
}


for(const mode of ['original','inline','splitOriginalWebview','sideBySide','nativeReview'])await test(`auto-next rechecks focus after ${mode} document loading`,async()=>{
    const h=harness(null);h.state.configuration.autoOpenNextPendingFile=true;
    let editorListener;h.vscode.window.activeTextEditor={};
    h.vscode.window.onDidChangeActiveTextEditor=fn=>{editorListener=fn;return{dispose(){}};};
    let changes=[{filePath:'/a'},{filePath:'/b'}],shown=0;
    Object.assign(h.tracker,{getTrackedChanges:()=>changes,getTrackedChange:p=>changes.find(c=>c.filePath===p),getPausedGitRepositories:()=>[]});
    const loading=deferred(),release=deferred();
    h.vscode.workspace.openTextDocument=async()=>{loading.resolve();await release.promise;return{};};
    h.vscode.window.showTextDocument=async()=>{shown++;return{};};
    const source=ts.createSourceFile('extension.ts',fs.readFileSync('src/extension.ts','utf8'),ts.ScriptTarget.Latest,true);
    const names=new Set(['openDiffDefault','openOriginalFile','showInlineDiff','showOriginalAndWebviewSplit','showSideBySideDiff'].map(name=>'diffTracker.'+name));
    const entries=[];function visit(node){
        if(ts.isCallExpression(node)&&node.expression.getText(source)==='vscode.commands.registerCommand'&&names.has(node.arguments[0]?.text))
            entries.push(`${JSON.stringify(node.arguments[0].text)}:${node.arguments[1].getText(source)}`);
        ts.forEachChild(node,visit);
    }visit(source);
    h.vscode.Uri.file=value=>({fsPath:value,with:fields=>({fsPath:value,...fields})});
    h.tracker.getIsRecording=()=>true;
    const sandbox={vscode:h.vscode,displayFileName:path.basename,extractFilePath:value=>value,getDefaultOpenMode:()=>mode,isDeletedReview:()=>false,
        createInlineDiffUri:value=>value,decorationManager:{updateDecorations(){}},WebviewDiffPanel:{createOrShow(){shown++;}},
        context:{extensionUri:{}},diffTracker:h.tracker};
    vm.runInNewContext(ts.transpileModule(`globalThis.callbacks={${entries.join(',')}}`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,sandbox);
    const adapter=Object.create(h.load('nativeReviewAdapter.ts').NativeReviewAdapter.prototype);
    adapter.tracker=h.tracker;
    h.vscode.commands.executeCommand=(name,...args)=>{
        if(name==='vscode.diff'){shown++;return;}
        if(name==='diffTracker.nativeReview.openFile')return adapter.openFile(...args);
        return sandbox.callbacks[name](...args);
    };
    const run=h.load('reviewNavigation.ts').withReviewNavigation;
    const operation=run(h.tracker,'/a',async()=>{changes=changes.filter(c=>c.filePath!=='/a');return{status:'success',filePath:'/a'};});
    await loading.promise;h.vscode.window.activeTextEditor={};editorListener();release.resolve();
    assert.equal((await operation).status,'success');assert.equal(shown,0,'delayed navigation must never show after user focus changes');
});


await test('auto-next cancels after opening and closing an active webview tab',async()=>{
    const h=harness(null);h.state.configuration.autoOpenNextPendingFile=true;
    h.vscode.window.activeTextEditor=undefined;
    h.vscode.window.onDidChangeActiveTextEditor=()=>({dispose(){}});
    let tabListener;const original={isActive:true};const other={isActive:true};
    const group={activeTab:original};
    h.vscode.window.tabGroups={activeTabGroup:group,
        onDidChangeTabs:fn=>{tabListener=fn;return{dispose(){}};},onDidChangeTabGroups:()=>({dispose(){}})};
    let changes=[{filePath:'/a'},{filePath:'/b'}];
    Object.assign(h.tracker,{getTrackedChanges:()=>changes,getTrackedChange:p=>changes.find(c=>c.filePath===p),getPausedGitRepositories:()=>[]});
    const run=h.load('reviewNavigation.ts').withReviewNavigation;
    await run(h.tracker,'/a',async()=>{
        group.activeTab=other;original.isActive=false;
        tabListener({opened:[other],changed:[original],closed:[]});
        group.activeTab=original;original.isActive=true;
        tabListener({opened:[],changed:[original],closed:[other]});
        changes=changes.slice(1);return{status:'success',filePath:'/a'};
    });
    assert.equal(h.commands.length,0,'an intervening active webview must permanently cancel navigation');
});


function quickExclusionHarness(coverage = false) {
    const h = monitoringScopeCommandHarness();
    h.vscode.Uri = class {
        constructor(fsPath) { this.fsPath = fsPath; this.scheme = 'file'; }
        static file(p) { return new this(p); }
        static joinPath(uri, ...parts) { return new this(path.join(uri.fsPath, ...parts)); }
        toString() { return `file://${this.fsPath}`; }
    };
    const target = h.targets[0];
    assert.equal(h.controller.getStatus().requested.scope?.scopeRevision,
        h.tracker.getEffectiveMonitoringScope().scopeRevision,
        'fixture must begin from the actual host filesystem case semantics, with no pending request');
    assert.equal(h.state.pendingScope, undefined, 'initial fixture must not manufacture pending scope');
    h.state.changes = [{ filePath: path.join(target, 'pending.txt'), reviewKind: 'text', currentContent: 'pending' }];
    h.state.epoch = 1;
    let effective = h.tracker.getEffectiveMonitoringScope();
    h.tracker.getEffectiveMonitoringScope = () => effective;
    h.tracker.getExplicitlyExcludedPendingReviewPaths = () => h.state.changes.map(item => item.filePath);
    h.tracker.getExplicitlyExcludedReviewRevision = () => JSON.stringify([h.state.epoch, h.state.changes]);
    h.tracker.setPendingMonitoringScope = scope => {
        h.state.pendingScope = scope;
        if (scope) { h.state.changes.forEach(item => { item.reviewKind = 'unknown'; }); }
    };
    h.state.afterConfigurationUpdate = () => h.controller.reconcileRequestedScope();
    h.tracker.applyConfiguredMonitoringScope = async (scope, discard, current, revision) => {
        h.state.applies++;
        assert.equal(current(), true);
        assert.equal(revision, h.tracker.getExplicitlyExcludedReviewRevision(scope));
        if (h.state.applyFailure) { return { status: 'failed', reason: 'injected save failure' }; }
        assert.equal(discard, h.state.changes.length > 0);
        effective = { kind: 'configured', ...scope };
        h.state.changes = [];
        return { status: 'applied' };
    };
    // Model the old panel's confirmation too so this is a red regression on
    // v0.8.9 rather than merely an assertion about a newly added method.
    h.controller.applyPendingScope = async () => ({ status: 'needsDiscardConfirmation', affectedReviewPaths: h.state.changes.map(item => item.filePath) });
    h.state.dialogs = [];
    h.vscode.window.showWarningMessage = async (message, options, ...buttons) => {
        h.state.dialogs.push({ message, options, buttons });
        if (options?.modal) { await h.state.duringConfirmation?.(); return h.state.confirm ? buttons[0] : undefined; }
        return undefined;
    };
    return { ...h, target, exclude: () => coverage
        ? h.run('excludeCoverageSubtree', { coveragePath: target })
        : h.run('excludeResource', { exclusionPath: target }) };
}

for (const coverage of [false,true]) await test(`quick exclusion diagnostics retain failure before opening the scope panel (coverage=${coverage})`,async()=>{
    const h=quickExclusionHarness(coverage);
    h.state.confirm=true;h.state.applyFailure=true;
    const outcome=await h.exclude();
    assert.equal(outcome.status,'failed');
    assert.equal(outcome.settingsStatus,'restored');
    assert.equal(outcome.scopeCommitted,false);
    assert.equal(outcome.coverageStatus,'notRun');
    assert.deepEqual(h.controller.getStatus().operationOutcome,outcome);
    await h.run('manageMonitoringScope');
    await h.WatchExcludePanel.currentPanel.handleMessage({command:'reload'});
    const status=h.messages.filter(message=>message.command==='scopeStatus').at(-1);
    assert.deepEqual(status.operationOutcome,outcome);
    h.WatchExcludePanel.currentPanel.dispose();
});

for(const next of ['restoreEffectiveScopeConfiguration','recheckObservationCoverage','migrateLegacyWatchRules'])
await test(`command ${next} replaces an older quick failure in scope diagnostics`,async()=>{
    const h=quickExclusionHarness(true);h.state.confirm=true;h.state.applyFailure=true;
    assert.equal((await h.exclude()).status,'failed');h.state.applyFailure=false;
    if(next==='recheckObservationCoverage'){h.tracker.recheckObservationCoverage=async()=>({status:'rechecked'});}
    const result=await h.run(next);
    const expected=next==='restoreEffectiveScopeConfiguration'?'restored':result.status;
    assert.equal(h.controller.getStatus().operationOutcome.status,expected);
    await h.run('manageMonitoringScope');await h.WatchExcludePanel.currentPanel.handleMessage({command:'reload'});
    assert.equal(h.messages.filter(message=>message.command==='scopeStatus').at(-1).operationOutcome.status,expected);
    h.WatchExcludePanel.currentPanel.dispose();
});

for(const action of ['saved','draft']) await test(`scope ${action} completion remains diagnostic after its panel closes`,async()=>{
    const h=quickExclusionHarness(true);h.state.confirm=true;h.state.applyFailure=true;
    assert.equal((await h.exclude()).status,'failed');h.state.applyFailure=false;
    if(action==='saved'){
        h.state.workspaceConfiguration.watchExclude.push({scope:'all',pattern:'/a/'});h.controller.reconcileRequestedScope();
    }
    await h.run('manageMonitoringScope');const panel=h.WatchExcludePanel.currentPanel,ui=connectScopeEditor(h);
    let enter,release,held=false;const entered=new Promise(resolve=>{enter=resolve;});const gate=new Promise(resolve=>{release=resolve;});
    const update=h.controller.context.workspaceState.update;
    h.controller.context.workspaceState.update=async(key,value)=>{
        if(key.endsWith('dismissedRevision.v1')&&!held){held=true;enter();await gate;}
        return update(key,value);
    };
    let operation;
    if(action==='saved'){operation=panel.applyInteractively();}
    else{ui.input('excludes',JSON.stringify([{scope:'all',pattern:'/a/'}]));ui.click('save-apply');operation=ui.action();}
    try{await Promise.race([entered,operation.then(()=>assert.fail('Scope never reached its committed-state boundary'))]);panel.dispose();}
    finally{release();await operation;}
    assert.equal(h.controller.getStatus().operationOutcome.status,'applied');
    assert.equal(h.controller.getStatus().operationOutcome.scopeCommitted,true);
});

for(const newer of ['operation','settings']) await test(`late read-only scope feedback cannot replace ${newer}`,async()=>{
    const h=quickExclusionHarness(true);h.state.confirm=true;h.state.applyFailure=true;
    await h.exclude();h.state.applyFailure=false;
    const token=h.controller.captureOperationOutcomeToken();
    if(newer==='operation'){assert.equal(await h.run('restoreEffectiveScopeConfiguration'),true);}
    else{h.state.workspaceConfiguration.watchExclude.push({scope:'all',pattern:'/external/'});h.controller.reconcileRequestedScope();}
    const before=JSON.stringify(h.controller.getStatus().operationOutcome);
    h.controller.recordUnchangedOperationOutcome({status:'restored',settingsStatus:'unchanged',scopeCommitted:false,
        coverageStatus:'notRun',reason:'An old settings review completed'},token);
    assert.equal(JSON.stringify(h.controller.getStatus().operationOutcome),before);
});

await test('a late scope completion cannot replace a newer initiated diagnostic',async()=>{
    const h=quickExclusionHarness(true);h.state.confirm=true;
    let enter,release,held=false;const entered=new Promise(resolve=>{enter=resolve;});const gate=new Promise(resolve=>{release=resolve;});
    const update=h.controller.context.workspaceState.update;
    h.controller.context.workspaceState.update=async(key,value)=>{
        if(key.endsWith('dismissedRevision.v1')&&!held){held=true;enter();await gate;}return update(key,value);
    };
    const first=h.exclude();
    try{
        await Promise.race([entered,first.then(()=>assert.fail('First action did not reach its committed boundary'))]);
        const newer=await h.controller.saveAndApplyScope(h.controller.getRequestedRawScope(),async()=>true);
        assert.equal(newer.status,'conflict');
        assert.deepEqual(h.controller.getStatus().operationOutcome,newer);
    }finally{release();await first;}
    assert.equal(h.controller.getStatus().operationOutcome.status,'conflict');
});

for(const action of ['saveAndApply','apply']) await test(`a duplicate in-flight panel ${action} cannot consume its completion diagnostic`,async()=>{
    const h=quickExclusionHarness(true);h.state.confirm=true;
    if(action==='apply'){h.state.workspaceConfiguration.watchExclude.push({scope:'all',pattern:'/a/'});h.controller.reconcileRequestedScope();}
    await h.run('manageMonitoringScope');const panel=h.WatchExcludePanel.currentPanel;
    let enter,release,held=false;const entered=new Promise(resolve=>{enter=resolve;});const gate=new Promise(resolve=>{release=resolve;});
    const update=h.controller.context.workspaceState.update;
    h.controller.context.workspaceState.update=async(key,value)=>{
        if(key.endsWith('dismissedRevision.v1')&&!held){held=true;enter();await gate;}return update(key,value);
    };
    const message={command:action,mode:'rules',includes:[],excludes:[{scope:'all',pattern:'/a/'}],
        baseVersion:h.controller.getRequestVersion(),draftRevision:1,actionId:109};
    const first=panel.handleMessage(message);
    try{
        await Promise.race([entered,first.then(()=>assert.fail('Action did not reach its committed boundary'))]);
        await panel.handleMessage(message);
    }finally{release();await first;}
    assert.equal(h.state.applies,1);
    assert.equal(h.controller.getStatus().operationOutcome.status,'applied');
    assert.equal(h.messages.filter(message=>message.command==='scopeOperation'&&message.actionId===109).length,1);panel.dispose();
});

await test('duplicate migration confirmation retains one initiation and cancellation outcome',async()=>{
    const h=quickExclusionHarness(true),waits=[];
    h.vscode.window.showWarningMessage=(_message,options)=>options?.modal?new Promise(resolve=>waits.push(resolve)):undefined;
    await h.run('manageMonitoringScope');const panel=h.WatchExcludePanel.currentPanel;
    const message={command:'completeLegacyMigration',actionId:110,mode:'rules',includes:[],excludes:[],draftRevision:0};
    const action=panel.handleMessage(message);assert.equal(waits.length,1);
    await panel.handleMessage(message);assert.equal(waits.length,1);
    waits[0](undefined);await action;
    assert.equal(h.controller.getStatus().operationOutcome.status,'cancelled');
    assert.equal(h.state.updates.length,0);assert.equal(h.state.applies,0);panel.dispose();
});

await test('read-only scope confirmations retain the latest panel initiation',async()=>{
    const h=quickExclusionHarness(true),waits=[];
    h.vscode.window.showWarningMessage=(_message,options)=>options?.modal?new Promise(resolve=>waits.push(resolve)):undefined;
    await h.run('manageMonitoringScope');const firstPanel=h.WatchExcludePanel.currentPanel;
    const first=firstPanel.handleMessage({command:'discardDraft',actionId:101,draftRevision:0});
    assert.equal(waits.length,1);firstPanel.dispose();
    await h.run('manageMonitoringScope');const secondPanel=h.WatchExcludePanel.currentPanel;
    const second=secondPanel.handleMessage({command:'discardDraft',actionId:102,draftRevision:0});assert.equal(waits.length,2);
    waits[0]('Discard Draft and Reload');await first;
    waits[1]('Discard Draft and Reload');await second;
    assert.equal(h.messages.filter(message=>message.command==='scopeOperation'&&message.actionId===102).at(-1).outcome.status,'restored');
    assert.equal(h.controller.getStatus().operationOutcome.status,'restored');secondPanel.dispose();
});

for (const answer of [false, true]) await test(`coverage-row single action ${answer ? 'applies' : 'cancels'} one bound review confirmation`, async () => {
    const h = quickExclusionHarness(true); h.state.confirm = answer;
    const before = structuredClone(h.state.changes);
    const result = await h.exclude();
    assert.equal(result.status, answer ? 'applied' : 'cancelled');
    assert.equal(h.state.dialogs.filter(item => item.options?.modal).length, 1);
    assert.equal(h.state.applies, answer ? 1 : 0);
    assert.equal(h.state.updates.length, answer ? 1 : 0);
    assert.equal(h.state.pendingScope, undefined);
    assert.equal(h.state.createdPanels.length, 0);
    assert.deepEqual(h.state.changes, answer ? [] : before);
    if (answer) { assert.doesNotMatch(h.state.info.at(-1), /Use Apply Pending|request saved/i); }
});

await test('scope panel Save and Apply uses one confirmation before saving expansion and exclusions', async () => {
    const h=quickExclusionHarness();h.state.confirm=true;
    await h.run('manageMonitoringScope');
    const panel=h.WatchExcludePanel.currentPanel;
    h.state.duringConfirmation=()=>{assert.equal(h.state.updates.length,0);assert.equal(h.state.changes[0].reviewKind,'text');};
    await panel.handleMessage({command:'saveAndApply',mode:'wholeWorkspace',
        includes:[{scope:'all',path:'additional'}],excludes:[{scope:'all',pattern:'/a/'}],
        baseVersion:h.controller.getRequestVersion(),draftRevision:1,actionId:1});
    assert.equal(h.state.applies,1);
    assert.equal(h.state.dialogs.filter(item=>item.options?.modal).length,1);
    assert.match(h.state.dialogs.find(item=>item.options?.modal).options.detail,/pending\.txt/);
    assert.deepEqual(h.state.changes,[]);
    const ack=h.messages.find(message=>message.command==='scopeOperation');
    assert.equal(ack.outcome.status,'applied');assert.equal(ack.acceptDraft,true);
    panel.dispose();
});

for(const scenario of ['cancel','partial','newer-draft'])await test(`scope editor ${scenario} keeps its draft and effective-result feedback consistent`,async()=>{
    const h=quickExclusionHarness();h.state.confirm=scenario!=='cancel';
    await h.run('manageMonitoringScope');
    const panel=h.WatchExcludePanel.currentPanel,ui=connectScopeEditor(h);
    const raw='[ { "scope": "all", "pattern": "**/*.tmp" }, { "scope": "all", "pattern": "/a/" } ]';
    ui.input('excludes',raw);
    if(scenario==='partial'){
        h.state.scopeRecoveryTargets=[{path:h.targets[1],kind:'subtree',workspaceRoot:h.tracker.getEffectiveMonitoringScope().roots[0].uri}];
        h.state.relatedScopeCoverageGaps=[[h.targets[1],'Required operation observation failure']];
        h.tracker.getCoverageGaps=()=>h.state.relatedScopeCoverageGaps;
        h.tracker.recheckObservationCoverage=async()=>({status:'limited',reason:'Required operation observation failure'});
    }
    if(scenario==='newer-draft')h.state.duringConfirmation=()=>ui.input('excludes','[ newer queued draft');
    ui.click('save-apply');await ui.action();
    const feedback=JSON.parse(ui.elements.get('status').textContent).operationOutcome;
    assert.equal(feedback.status,scenario==='cancel'?'cancelled':scenario==='partial'?'partial':'conflict');
    assert.equal(h.state.dialogs.filter(item=>item.options?.modal).length,1);
    assert.equal(ui.elements.get('excludes').disabled,false);
    if(scenario==='partial'){
        assert.equal(feedback.scopeCommitted,true);assert.equal(feedback.settingsStatus,'saved');assert.equal(feedback.coverageStatus,'limited');
        assert.ok(h.state.workspaceConfiguration.watchExclude.some(rule=>rule.pattern==='/a/'));
        assert.deepEqual(h.state.changes,[]);
        assert.match(h.state.dialogs.at(-1).message,/scope applied.*retained.*incomplete/i);
    }else{
        assert.equal(h.state.updates.length,0);
        assert.equal(ui.elements.get('excludes').value,scenario==='cancel'?raw:'[ newer queued draft');
        assert.equal(h.state.changes[0].reviewKind,'text');
    }
    panel.dispose();
});

await test('scope completion with unrelated coverage stays consistent across panel tree and status bar',async()=>{
    const h=quickExclusionHarness();h.state.confirm=true;
    const [selected,other]=h.targets;
    h.tracker.getCoverageGaps=()=>h.state.subtreeCoverageGaps.map(gap=>[gap.targetPath,gap.reason]);
    const apply=h.tracker.applyConfiguredMonitoringScope;
    h.tracker.applyConfiguredMonitoringScope=async(...args)=>{
        const outcome=await apply(...args);
        h.state.subtreeCoverageGaps=h.state.subtreeCoverageGaps.filter(gap=>gap.targetPath!==selected);
        return outcome;
    };
    h.tracker.recheckObservationCoverage=async()=>{throw new Error('An unrelated warning must not cause full Recheck');};
    const item={show(){},dispose(){}},listeners=[];
    h.vscode.StatusBarAlignment={Right:2};h.vscode.ThemeColor=class{constructor(id){this.id=id;}};
    h.vscode.window.createStatusBarItem=()=>item;
    h.tracker.onDidChangeRecordingState=()=>({dispose(){}});h.tracker.onDidChangeBaselineState=()=>({dispose(){}});
    h.tracker.onDidTrackChanges=listener=>{listeners.push(listener);return{dispose(){}};};
    const tree=new(h.load('diffTreeView.ts').DiffTreeDataProvider)(h.tracker);
    const status=new(h.load('statusBarManager.ts').StatusBarManager)(h.tracker);
    assert.match(item.tooltip,/2 subtree/);
    await h.run('manageMonitoringScope');
    const panel=h.WatchExcludePanel.currentPanel,ui=connectScopeEditor(h);
    ui.input('excludes',JSON.stringify([{scope:'all',pattern:'/a/'}]));
    ui.click('save-apply');await ui.action();
    for(const listener of listeners)listener({fullRefresh:true});
    const shown=JSON.parse(ui.elements.get('status').textContent);
    assert.equal(shown.operationOutcome.status,'applied');assert.equal(shown.operationOutcome.coverageStatus,'verified');
    assert.deepEqual(shown.operationOutcome.unrelatedCoverageGaps.map(([file])=>file),[other]);
    assert.match(shown.operationOutcome.reason,/Related observation work is complete; other coverage problems remain/);
    assert.deepEqual(shown.coverageGaps.map(([file])=>file),[other]);
    const diagnostic=(await tree.getChildren()).find(row=>row.label==='Monitoring Coverage Limited');
    assert.deepEqual(diagnostic.children.map(row=>row.coveragePath),[other]);
    assert.match(item.text,/Coverage Limited/);assert.match(item.tooltip,/1 subtree/);
    assert.equal(item.command,'diffTracker.manageMonitoringScope');
    assert.equal(h.state.dialogs.filter(dialog=>dialog.options?.modal).length,1);
    panel.dispose();status.dispose();
});

await test('coverage-row confirmation owns the scope action before writing settings and releases on Cancel', async () => {
    const h = quickExclusionHarness(true);
    const entered = deferred(), gate = deferred();
    h.state.duringConfirmation = async () => { entered.resolve(); await gate.promise; };
    const exclusion = h.exclude();
    try {
        await entered.promise;
        assert.equal(h.controller.hasPendingScopeSettingsWrites(),false,'confirmation itself saves nothing');
        for (const command of scopeEditorCommands) {
            await h.run(command);
            assert.equal(h.WatchExcludePanel.currentPanel,undefined,'a draft cannot open behind an active confirmation');
        }
        assert.equal(h.state.updates.length,0);
    } finally { gate.resolve(); await exclusion; h.WatchExcludePanel.currentPanel?.dispose(); }
    await h.run('manageMonitoringScope');
    assert.ok(h.WatchExcludePanel.currentPanel,'Cancel releases ownership');
    h.WatchExcludePanel.currentPanel.dispose();
});

await test('QUICK-EXCLUSION Cancel does not save settings, pause reads, create Unknown or open a scope editor', async () => {
    const h = quickExclusionHarness();
    const before = structuredClone(h.state.changes);
    await h.exclude();
    assert.equal(h.state.updates.length, 0);
    assert.deepEqual(h.state.changes, before);
    assert.equal(h.state.pendingScope, undefined);
    assert.equal(h.state.applies, 0);
    assert.equal(h.state.createdPanels.length, 0);
});

for (const change of ['settings', 'review', 'lifecycle']) await test(`QUICK-EXCLUSION ${change} changing during confirmation cannot consume stale approval`, async () => {
    const h = quickExclusionHarness(); h.state.confirm = true;
    h.state.duringConfirmation = () => {
        if (change === 'settings') { h.state.workspaceConfiguration.watchExclude.push({ scope: 'all', pattern: '/unrelated/' }); }
        if (change === 'review') { h.state.changes[0].currentContent = 'newer edit'; }
        if (change === 'lifecycle') { h.state.epoch++; }
    };
    await h.exclude();
    assert.equal(h.state.updates.length, 0);
    assert.equal(h.state.applies, 0);
    assert.equal(h.state.changes[0].reviewKind, 'text');
});

await test('QUICK-EXCLUSION approved target is applied once without synthetic Unknown or second confirmation', async () => {
    const h = quickExclusionHarness(); h.state.confirm = true;
    await h.exclude();
    assert.equal(h.state.applies, 1);
    assert.equal(h.state.dialogs.filter(item => item.options?.modal).length, 1);
    assert.deepEqual(h.state.changes, []);
    assert.equal(h.state.pendingScope, undefined);
    assert.equal(h.state.createdPanels.length, 0);
});

await test('QUICK-EXCLUSION failed Apply restores its own settings without consuming pending review', async () => {
    const h = quickExclusionHarness(); h.state.confirm = true; h.state.applyFailure = true;
    const configuration = structuredClone(h.state.workspaceConfiguration);
    const review = structuredClone(h.state.changes);
    await h.exclude();
    assert.deepEqual(h.state.workspaceConfiguration, configuration);
    assert.deepEqual(h.state.changes, review);
    assert.equal(h.state.pendingScope, undefined);
});

await test('QUICK-EXCLUSION refuses an unrelated pending request without silently applying it', async () => {
    const h = quickExclusionHarness(); h.state.confirm = true;
    h.state.workspaceConfiguration.watchExclude.push({ scope: 'all', pattern: '/unrelated/' });
    await h.exclude();
    assert.equal(h.state.updates.length, 0);
    assert.equal(h.state.applies, 0);
    assert.equal(h.state.dialogs.filter(item => item.options?.modal).length, 0);
});

console.log(`${count} production review UI cases passed (VS Code, DOM and renderer boundaries mocked).`);

await test('Start while recording preserves the current baseline without confirmation', async () => {
    const h = commandHarness({ recording: true });
    assert.equal(await h.startFlow(), true);
    assert.equal(h.state.starts, 0);
    assert.equal(h.state.prompts.length, 0);
});
await test('Start with a stopped review preserves it when replacement is cancelled', async () => {
    const h = commandHarness({ replaceAnswer: 'Cancel' });
    assert.equal(await h.startFlow(), false);
    assert.equal(h.state.starts, 0);
    assert.equal(h.state.recording, false);
    assert.equal(h.state.prompts.length, 1);
});

await test('Start recovery uses only its dedicated confirmation with pending review', async () => {
    for (const answer of ['Cancel', 'Discard Saved Session and Rebuild']) {
        const h = commandHarness({ recoveryBlocked: true, recoveryGate: answer, replaceAnswer: 'Cancel' });
        const approved = answer === 'Discard Saved Session and Rebuild';
        assert.equal(await h.startFlow(), approved);
        assert.equal(h.state.recoveryPrompts, 1);
        assert.equal(h.state.prompts.length, 0, 'do not ask to replace review again after recovery discard');
        assert.equal(h.state.discards ?? 0, approved ? 1 : 0);
        assert.equal(h.state.starts, approved ? 1 : 0);
    }
});
