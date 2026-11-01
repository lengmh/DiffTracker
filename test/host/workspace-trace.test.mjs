import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import trace from './workspace-trace.cjs';

test('workspace observation distinguishes its own empty, invalid, valid and failed reads without raw values', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-trace-'));
    const roots = ['first', 'second'].map(name => path.join(directory, name));
    roots.forEach(root => fs.mkdirSync(root));
    const file = path.join(directory, 'fixture.code-workspace');
    const seed = () => fs.writeFileSync(file, JSON.stringify({ folders: roots.map(root => ({ path: root })),
        settings: { privateSyntheticValue: 'DO_NOT_PUBLISH_SYNTHETIC_SENTINEL' } }));
    seed();
    let notify, published;
    const workspace = { workspaceFile: { fsPath: file }, workspaceFolders: roots.map(root => ({ uri: { fsPath: root } })),
        onDidChangeWorkspaceFolders(listener) { notify = listener; return { dispose() {} }; } };
    const prior = process.env.DIFF_TRACKER_HOST_TRACE_WORKSPACE, log = console.log;
    process.env.DIFF_TRACKER_HOST_TRACE_WORKSPACE = '1';
    console.log = (prefix, data) => { assert.equal(prefix, 'HOST-WORKSPACE-OBSERVATION'); published = data; };
    let observation;
    try {
        observation = trace.observeWorkspace({ workspace });
        fs.writeFileSync(file, ''); notify({ added: [], removed: [] });
        fs.writeFileSync(file, '{'); notify({ added: [], removed: [] });
        fs.unlinkSync(file); notify({ added: [], removed: [] });
        seed(); observation.finish();
        const data = JSON.parse(published);
        assert.equal(data.source, 'extension-host-disk');
        assert.deepEqual(data.events.map(event => event.disk.status), ['valid-json', 'empty', 'invalid-json', 'read-error', 'valid-json']);
        assert.equal(data.events[0].disk.expectedRoots, true);
        assert.equal(data.events[3].disk.error, 'ENOENT');
        assert.equal(published.includes(directory), false);
        assert.equal(published.includes('DO_NOT_PUBLISH'), false);
    } finally {
        observation?.finish(); console.log = log;
        if (prior === undefined) { delete process.env.DIFF_TRACKER_HOST_TRACE_WORKSPACE; }
        else { process.env.DIFF_TRACKER_HOST_TRACE_WORKSPACE = prior; }
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('standard Host trace emits only fixed metadata and keeps actual workbench reads explicitly unknown', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-trace-'));
    const workspaceFile = path.join(directory, 'fixture.code-workspace');
    const root = path.join(directory, 'first'), output = [];
    const profile = path.join(directory, 'profile');
    fs.mkdirSync(path.join(profile, 'logs', 'window1'), { recursive: true });
    fs.writeFileSync(path.join(profile, 'logs', 'window1', 'renderer.log'), [
        `Unable to read file '${workspaceFile}' SECRET_ALPHA`,
        `Ignoring the error while validating workspace folder ${root} SECRET_BETA`,
        'Error while parsing settings file unscoped-id SECRET_GAMMA',
        'unrelated credential=SECRET_DELTA'
    ].join('\n'));
    const collector = trace.createLogCollector({ workspaceFile, roots: [root], emit: (...args) => output.push(args.join(' ')) });
    try {
        collector.stdout.write('PASS HOST-S3 SECRET_CHECKPOINT\n');
        collector.stderr.write(`Unable to read file '${workspaceFile}' SECRET_STDERR\n`);
        collector.stdout.write(`[trace] File Watcher ${workspaceFile} read event error field SECRET_WATCHER\n`);
        collector.stdout.write('HOST-WORKSPACE-OBSERVATION {"source":"extension-host-disk","events":[{"kind":"folders","current":0,"password":"SECRET_JSON","disk":{"status":"empty","bytes":0}}]}\n');
        collector.stdout.write('X'.repeat(70 * 1024)); collector.stdout.write('SECRET_OVERSIZE\n');
        collector.finish(profile);
        const all = output.join('\n');
        assert.equal(all.includes('SECRET'), false);
        assert.equal(all.includes(directory), false);
        const summary = JSON.parse(output.find(line => line.startsWith('HOST-WORKSPACE-STANDARD-TRACE ')).slice(30));
        assert.equal(summary.counts['profile:workspace-read-error'], 1);
        assert.equal(summary.counts['stderr:workspace-read-error'], 1);
        assert.equal(summary.counts['profile:root-validation-warning'], 1);
        assert.equal(summary.counts['profile:configuration-parser-exception-unscoped'], 1);
        assert.equal(summary.oversizedLines, 1);
        assert.deepEqual(summary.capabilities, { actualReadContent: false, parserResult: false, successfulRootValidation: false });
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('workspace observation is disabled by default and does not access the workspace', () => {
    const prior = process.env.DIFF_TRACKER_HOST_TRACE_WORKSPACE;
    delete process.env.DIFF_TRACKER_HOST_TRACE_WORKSPACE;
    try { trace.observeWorkspace({ get workspace() { throw new Error('must not read'); } }).finish(); }
    finally { if (prior !== undefined) { process.env.DIFF_TRACKER_HOST_TRACE_WORKSPACE = prior; } }
});
