/** Regression coverage for delayed vscode.git initialization.
 * Production GitContextMonitor is loaded with only the VS Code extension boundary mocked. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';

const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'difftracker-git-ready-'));
mkdirSync(path.join(repoRoot, '.git'));

class Emitter {
    handlers = [];
    event = handler => {
        this.handlers.push(handler);
        return { dispose: () => { this.handlers = this.handlers.filter(value => value !== handler); } };
    };
    fire(value) {
        for (const handler of [...this.handlers]) { handler(value); }
    }
}

class Uri {
    constructor(fsPath) {
        this.fsPath = fsPath;
        this.scheme = 'file';
    }
    static file(value) { return new Uri(value); }
}

let installedExtension;
const vscode = {
    Uri,
    workspace: { workspaceFolders: [{ uri: Uri.file(repoRoot) }] },
    extensions: { getExtension: id => id === 'vscode.git' ? installedExtension : undefined }
};

const require = createRequire(import.meta.url);
const originalLoad = Module._load;
Module._load = function (id, ...args) {
    return id === 'vscode' ? vscode : originalLoad.call(this, id, ...args);
};
let api;
try {
    api = require('../out/gitContext.js');
} finally {
    Module._load = originalLoad;
}

const opened = new Emitter();
const closed = new Emitter();
const apiState = new Emitter();
const stateChanged = new Emitter();
const repositories = [];
const repo = {
    rootUri: Uri.file(repoRoot),
    kind: 'repository',
    state: {
        HEAD: { name: 'main', commit: 'aaa' },
        rebaseCommit: undefined,
        mergeChanges: [],
        onDidChange: stateChanged.event
    }
};
const gitApi = {
    state: 'uninitialized',
    repositories,
    onDidChangeState: apiState.event,
    onDidOpenRepository: opened.event,
    onDidCloseRepository: closed.event
};
installedExtension = {
    isActive: true,
    exports: { enabled: true, getAPI: version => { assert.equal(version, 1); return gitApi; } }
};

const events = [];
const monitor = new api.GitContextMonitor(event => events.push(event));

try {
    assert.equal(await monitor.start(), true);
    assert.equal(monitor.isReady(), false);

    // VS Code can discover/open repositories and publish repository-state changes while
    // its Git API is still uninitialized. These are startup reconciliation, not changes
    // that happened after a Code Diff Tracker baseline.
    repositories.push(repo);
    opened.fire(repo);
    repo.state.HEAD = { name: 'feature', commit: 'bbb' };
    stateChanged.fire();
    assert.deepEqual(events, []);
    assert.equal(monitor.getSnapshots()[0].headName, 'feature');

    // The first externally visible Git-context event must establish the ready boundary
    // and include the latest discovered repository state.
    gitApi.state = 'initialized';
    apiState.fire('initialized');
    assert.equal(monitor.isReady(), true);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'ready');
    assert.equal(events[0].contexts.length, 1);
    assert.equal(events[0].contexts[0].headName, 'feature');
    assert.equal(events[0].contexts[0].headCommit, 'bbb');

    // Once ready, ordinary repository changes must still be reported.
    repo.state.HEAD = { name: 'hotfix', commit: 'ccc' };
    stateChanged.fire();
    assert.equal(events.at(-1).kind, 'changed');
    assert.equal(events.at(-1).context.headName, 'hotfix');

    repositories.splice(0, repositories.length);
    closed.fire(repo);
    assert.deepEqual(events.at(-1), { kind: 'removed', repoRoot });

    console.log('PASS delayed Git initialization emits ready before repository changes');
} finally {
    monitor.dispose();
    rmSync(repoRoot, { recursive: true, force: true });
}
