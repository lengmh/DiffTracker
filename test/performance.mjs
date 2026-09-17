/** Measured synthetic-workspace smoke benchmark using the production tracker. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-tracker-performance-'));
const files = [];
for (let index = 0; index < 1_000; index++) {
    const filePath = path.join(root, 'small', `${String(index).padStart(4, '0')}.txt`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `small ${index}\n`);
    files.push(filePath);
}
const mediumContent = `${'0123456789abcdef'.repeat(2_048)}\n`;
for (let index = 0; index < 100; index++) {
    const filePath = path.join(root, 'medium', `${String(index).padStart(3, '0')}.txt`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, mediumContent);
    files.push(filePath);
}

const noopEvent = () => ({ dispose() {} });
class Emitter { event = noopEvent; fire() {} dispose() {} }
class Uri {
    constructor(fsPath) { this.fsPath = fsPath; this.path = fsPath; this.scheme = 'file'; }
    static file(value) { return new Uri(value); }
    static joinPath(uri, ...parts) { return new Uri(path.join(uri.fsPath, ...parts)); }
    toString() { return `file://${this.fsPath}`; }
}
const vscode = {
    EventEmitter: Emitter,
    Uri,
    RelativePattern: class { constructor(base, pattern) { Object.assign(this, { base, pattern }); } },
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    workspace: {
        textDocuments: [],
        workspaceFolders: [{ uri: Uri.file(root), name: 'performance' }],
        getWorkspaceFolder: uri => uri.fsPath.startsWith(root) ? { uri: Uri.file(root), name: 'performance' } : undefined,
        getConfiguration: () => ({ get: (_key, fallback) => fallback }),
        onDidChangeTextDocument: noopEvent,
        onDidOpenTextDocument: noopEvent,
        onWillSaveTextDocument: noopEvent,
        onDidSaveTextDocument: noopEvent,
        onDidCreateFiles: noopEvent,
        onDidChangeConfiguration: noopEvent,
        onDidChangeWorkspaceFolders: noopEvent,
        findFiles: async pattern => pattern.pattern === '**/*' ? files.map(Uri.file) : [],
        createFileSystemWatcher: () => ({ onDidChange: noopEvent, onDidCreate: noopEvent, onDidDelete: noopEvent, dispose() {} }),
        fs: {
            stat: async uri => {
                const stat = fs.statSync(uri.fsPath);
                return { type: stat.isDirectory() ? 2 : 1, size: stat.size, mtime: stat.mtimeMs };
            },
            readFile: async uri => new Uint8Array(fs.readFileSync(uri.fsPath))
        }
    },
    window: { showWarningMessage: async () => undefined }
};
const originalLoad = Module._load;
Module._load = function (id, ...args) { return id === 'vscode' ? vscode : originalLoad.call(this, id, ...args); };
let DiffTracker;
try { ({ DiffTracker } = require('../out/diffTracker.js')); }
finally { Module._load = originalLoad; }

const startRss = process.memoryUsage().rss;
const tracker = new DiffTracker();
const start = performance.now();
tracker.startRecording();
const deadline = Date.now() + 60_000;
while (tracker.getBaselineState() !== 'ready' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
}
const scanMilliseconds = performance.now() - start;
assert.equal(tracker.getBaselineState(), 'ready');
assert.equal(tracker.fileSnapshots.size, files.length);

const changedPath = files[files.length - 1];
fs.appendFileSync(changedPath, 'changed\n');
const updateStart = performance.now();
await tracker.readFileAndUpdate(changedPath, Uri.file(changedPath));
const updateMilliseconds = performance.now() - updateStart;
assert.ok(tracker.getTrackedChanges().some(change => change.filePath === changedPath));
assert.ok(scanMilliseconds < 60_000, `scan took ${scanMilliseconds}ms`);
assert.ok(updateMilliseconds < 5_000, `single update took ${updateMilliseconds}ms`);

const result = {
    fileCount: files.length,
    sourceBytes: files.reduce((total, filePath) => total + fs.statSync(filePath).size, 0),
    snapshotBytes: Buffer.byteLength(JSON.stringify([...tracker.fileSnapshots])),
    scanMilliseconds: Math.round(scanMilliseconds * 10) / 10,
    updateMilliseconds: Math.round(updateMilliseconds * 10) / 10,
    rssDeltaMiB: Math.round(Math.max(0, process.memoryUsage().rss - startRss) / 1024 / 1024 * 10) / 10
};
console.log(JSON.stringify(result, null, 2));

await tracker.dispose();
fs.rmSync(root, { recursive: true, force: true });
