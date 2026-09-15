import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';

// Execute production TypeScript with only the VS Code boundary mocked. Explicit
// platform selection lets Linux exercise Windows fsPath semantics as well.
const require = createRequire(import.meta.url);
function runtime(style) {
    const folders = [];
    class Uri {
        constructor(fsPath, scheme = 'file') { this.fsPath = fsPath; this.scheme = scheme; }
        static file(value) { return new Uri(value); }
        with({ scheme }) { return new Uri(this.fsPath, scheme); }
    }
    const vscode = {
        Uri,
        EventEmitter: class { event() {} fire() {} dispose() {} },
        TreeItem: class { constructor(label) { this.label = label; } },
        TreeItemCollapsibleState: { None: 0, Expanded: 2 },
        ThemeIcon: class { static File = 'file'; },
        workspace: {
            workspaceFolders: folders,
            textDocuments: [],
            getWorkspaceFolder(uri) {
                return folders.find(folder => uri.fsPath.startsWith(folder.uri.fsPath + path[style].sep));
            }
        }
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
        const localRequire = name => name === 'vscode' ? vscode
            : name === 'path' ? { ...path[style], posix: path.posix, win32: path.win32 }
            : name.startsWith('.') ? load(path.relative(path.resolve('src'), path.resolve(path.dirname(filename), name + '.ts')))
            : require(name);
        vm.runInNewContext(output, {
            module, exports: module.exports, require: localRequire,
            process: { platform: style === 'win32' ? 'win32' : 'linux' }, console
        }, { filename });
        return module.exports;
    }
    return { load, vscode, folders };
}
let passed = 0;
async function test(name, run) {
    await run();
    passed++;
    console.log(`PASS ${name}`);
}

for (const [style, root, file] of [
    ['win32', 'C:\\Users\\研究 用户\\OneDrive', 'C:\\Users\\研究 用户\\OneDrive\\项目 A\\sample.m'],
    ['win32', '\\\\server\\share', '\\\\server\\share\\中文 目录\\sample.m'],
    ['posix', '/home/研究 用户', '/home/研究 用户/项目 A/sample.m'],
    ['posix', '/home/user', '/home/user/dir\\literal/name\\literal.m']
]) {
    await test(`${style} production tree and Webview: ${file}`, async () => {
        const { load, folders } = runtime(style);
        const helper = load('utils/displayPath.ts');
        const expected = path[style].basename(file);
        assert.equal(helper.displayFileName(file), expected);
        // Explicit foreign-style samples must not inherit the host's path rules.
        assert.equal(helper.displayFileName(file, style), expected);
        folders.push({ uri: { fsPath: root }, name: 'Workspace' });
        const tracked = { filePath: file, fileName: 'stale legacy display name', isDeleted: false,
            originalContent: 'before', currentContent: 'after' };
        const tracker = {
            getTrackedChanges: () => [tracked], getBaselineState: () => 'ready',
            getChangeBlocks: () => []
        };
        const { DiffTreeDataProvider } = load('diffTreeView.ts');
        const provider = new DiffTreeDataProvider(tracker);
        const roots = await provider.getChildren();
        const directoryName = path[style].basename(path[style].dirname(file));
        const directory = roots.find(item => item.label === directoryName);
        assert.ok(directory, 'relative directory must be preserved as a single label');
        const [leaf] = await provider.getChildren(directory);
        assert.equal(leaf.label, expected);
        assert.equal(leaf.filePath, file);
        assert.equal(leaf.resourceUri.fsPath, file);
        assert.equal(leaf.command.arguments[0].filePath, file);
        assert.equal(leaf.tooltip, file);
        const { WebviewDiffPanel } = load('webviewDiffPanel.ts');
        const webview = Object.create(WebviewDiffPanel.prototype);
        const messages = [];
        webview.panel = { webview: { postMessage: value => messages.push(value) } };
        webview.diffTracker = tracker;
        webview.isInitialized = true;
        webview.update(file);
        assert.equal(webview.panel.title, `Diff: ${expected}`);
        assert.equal(messages[0].fileName, expected);
        assert.equal(messages[0].filePath, file);
        // This verifies production virtual-path conversion and provider routing
        // through a URI boundary stub; real VS Code URI behavior is NOT tested.
        const inline = load('utils/inlineDiffUri.ts');
        const uri = inline.createInlineDiffUri(file);
        assert.equal(uri.scheme, 'diff-tracker-inline');
        assert.equal(inline.toTrackedFilePath(uri.fsPath), file);
        const { InlineContentProvider } = load('inlineContentProvider.ts');
        const contentProvider = Object.create(InlineContentProvider.prototype);
        contentProvider.diffTracker = { getInlineContent: actual => {
            assert.equal(actual, file); return 'routed to original resource';
        } };
        assert.equal(contentProvider.provideTextDocumentContent(uri), 'routed to original resource');
    });
}

await test('multi-root duplicate names remain separate resources and preserve case', async () => {
    const { load, folders } = runtime('posix');
    folders.push({ uri: { fsPath: '/a' }, name: 'Root A' }, { uri: { fsPath: '/b' }, name: 'Root B' });
    const files = ['/a/src/Sample.m', '/a/src/sample.m', '/b/src/sample.m'];
    const provider = new (load('diffTreeView.ts').DiffTreeDataProvider)({
        getBaselineState: () => 'ready',
        getTrackedChanges: () => files.map(filePath => ({ filePath, fileName: 'sample.m' }))
    });
    const roots = await provider.getChildren();
    const rootA = roots.find(item => item.label === 'Root A');
    const rootB = roots.find(item => item.label === 'Root B');
    assert.ok(rootA && rootB);
    const leavesA = rootA.children[0].children;
    const leavesB = rootB.children[0].children;
    assert.equal(leavesA.length, 2);
    assert.equal(leavesB.length, 1);
    assert.deepEqual([...leavesA.map(item => item.label)].sort(), ['Sample.m', 'sample.m']);
    assert.deepEqual([...leavesA, ...leavesB].map(item => item.filePath).sort(), files);
});

await test('POSIX backslashes and workspace label separators are never guessed', () => {
    const { load } = runtime('posix');
    const { displayFileName, workspaceDisplayParts } = load('utils/displayPath.ts');
    assert.equal(displayFileName('C:\\dir\\file.m', 'posix'), 'C:\\dir\\file.m');
    assert.equal(displayFileName('C:\\dir\\file.m', 'win32'), 'file.m');
    assert.deepEqual([...workspaceDisplayParts('/a/dir\\name/file.m', { fsPath: '/a', name: 'Root / A' }, true)],
        ['Root / A', 'dir\\name', 'file.m']);
});
console.log(`${passed} production path regression cases passed (VS Code boundary mocked).`);
