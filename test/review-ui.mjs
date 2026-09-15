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
        ThemeIcon: class { static File = 'file'; },
        ColorThemeKind: { Light: 1 },
        window: { activeColorTheme: { kind: 1 } },
        workspace: { textDocuments: [], workspaceFolders: [], getWorkspaceFolder: () => undefined },
        commands: { async executeCommand(...args) {
            commands.push(args);
            if (state.error) { throw state.error; }
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
    };
    const panel = Object.create(load('webviewDiffPanel.ts').WebviewDiffPanel.prototype);
    Object.assign(panel, {
        filePath, diffTracker: tracker, extensionUri: { fsPath: '/extension' },
        currentStyle: 'split', currentWrap: false, currentExpandAll: false,
        panel: { webview: { postMessage: value => messages.push(value), asWebviewUri: uri => uri, cspSource: 'test-source' } }
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
    const window = {
        PierreDiffs: {
            FileDiff: class { render() { rendererCalls++; } },
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
        elements, sent, rendererCalls: () => rendererCalls,
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
        await h.panel.handleMessage({ command: 'keepAll', filePath, requestId: 'r1' });
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
    await h.panel.handleMessage({ command: 'revertAll', filePath, requestId: 'save' });
    assert.equal(h.messages[0].ok, false);
    assert.equal(h.messages[0].bufferChanged, true);
    assert.equal(h.messages[0].error, h.state.result.reason);
    assert.equal(h.messages[1].hasFileChange, true);
});

await test('command exception is a failed ack followed by current state', async () => {
    const h = harness();
    h.state.error = new Error('Permission denied');
    await h.panel.handleMessage({ command: 'revertBlock', filePath, requestId: 'error', changeBlockId: 'b1' });
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
            filePath: kind === 'wrongPath' ? '/other.m' : filePath, requestId: kind });
        assert.equal(h.commands.length, 0, kind);
        assert.equal(h.messages.length, 1, kind);
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
        ui.receive({ command: 'actionAck', requestId: request.requestId, ok: true });
        assert.equal(ui.elements.get('btn-keep-all').disabled, true, 'wait for refreshed state after success');
        ui.receive({ ...payload, hasFileChange: false });
        assert.match(ui.elements.get('diff-container').innerHTML, /No changes detected/);
        assert.equal(ui.elements.get('btn-keep-all').disabled, true, 'review completed, no pending target');
    });
}

await test('unavailable state is visible in generated DOM, tree and incremental payload', async () => {
    const reason = 'Permission denied <restricted>';
    const h = harness({ filePath, fileName: 'empty.m', originalContent: '', currentContent: '', unavailableReason: reason });
    h.panel.sendDataUpdate();
    assert.equal(h.messages[0].unavailableReason, reason);
    const ui = runInline(h.panel.getHtmlContent());
    assert.equal(ui.notice(), `Review unavailable: ${reason}`);
    assert.equal(ui.elements.get('btn-keep-all').disabled, true);
    assert.equal(ui.elements.get('btn-reject-all').disabled, true);
    const tree = new (h.load('diffTreeView.ts').DiffTreeDataProvider)(h.tracker);
    const leaf = (await tree.getChildren()).find(item => item.filePath === filePath);
    assert.match(leaf.description, /Unavailable: Permission denied/);
    assert.ok(leaf.tooltip.includes(reason));
    // Recovery comes from authoritative updateData and re-enables file actions.
    ui.receive({ ...h.messages[0], unavailableReason: undefined });
    assert.match(ui.notice(), /Empty file created/);
    assert.equal(ui.elements.get('btn-keep-all').disabled, false);
});

await test('failed acknowledgement unlocks the generated UI while pending file remains reviewable', () => {
    const h = harness();
    const ui = runInline(h.panel.getHtmlContent());
    ui.click('btn-reject-all');
    assert.equal(ui.elements.get('btn-reject-all').disabled, true);
    ui.receive({ command: 'actionAck', requestId: ui.sent[0].requestId, ok: false, error: 'Save failed', bufferChanged: true });
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
console.log(`${count} production review UI cases passed (VS Code, DOM and renderer boundaries mocked).`);
