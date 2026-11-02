// Opt-in diagnostics for the disposable Host. Only public events, ordinary
// filesystem reads and VS Code's supported --log trace output are observed.
const fs = require('node:fs');
const path = require('node:path');
const { Writable } = require('node:stream');
const { StringDecoder } = require('node:string_decoder');
const { pathToFileURL } = require('node:url');

const errors = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM']);
const errorKind = error => errors.has(error?.code) ? error.code : 'other-error';
const LIMIT = 128;

exports.observeWorkspace = vscode => {
    if (process.env.DIFF_TRACKER_HOST_TRACE_WORKSPACE !== '1') { return { finish() {} }; }
    const target = vscode.workspace.workspaceFile?.fsPath;
    if (!target) { return { finish() {} }; }
    const roots = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
    const expected = new Set(roots.map(root => path.resolve(root)));
    const events = [], started = Date.now();
    let closed = false, dropped = 0;
    const snapshot = () => {
        const physical = roots.map(root => {
            try { return fs.statSync(root).isDirectory() ? 'directory' : 'other-type'; }
            catch (error) { return errorKind(error); }
        });
        try {
            if (fs.statSync(target).size > 512 * 1024) { return { status: 'size-limit', physical }; }
            const content = fs.readFileSync(target);
            if (!content.length) { return { status: 'empty', bytes: 0, physical }; }
            let parsed;
            try { parsed = JSON.parse(content.toString('utf8')); }
            catch { return { status: 'invalid-json', bytes: content.length, physical }; }
            const folders = Array.isArray(parsed?.folders) ? parsed.folders : [];
            const declared = folders.map(folder => typeof folder?.path === 'string'
                ? path.resolve(path.dirname(target), folder.path) : undefined);
            return { status: 'valid-json', bytes: content.length, declaredRoots: folders.length,
                expectedRoots: declared.length === expected.size && new Set(declared).size === expected.size &&
                    declared.every(root => expected.has(root)), physical };
        } catch (error) { return { status: 'read-error', error: errorKind(error), physical }; }
    };
    const push = (kind, detail = {}) => {
        if (closed) { return; }
        if (events.length >= LIMIT) { dropped++; return; }
        events.push({ ms: Date.now() - started, kind, current: vscode.workspace.workspaceFolders?.length ?? 0,
            ...detail, disk: snapshot() });
    };
    const listener = vscode.workspace.onDidChangeWorkspaceFolders(event => push('folders', {
        added: event.added.length, removed: event.removed.length
    }));
    const watcher = fs.watch(path.dirname(target), { persistent: false }, (_kind, name) => {
        if (String(name) === path.basename(target)) { push('file-notification'); }
    });
    watcher.on('error', error => push('watch-error', { error: errorKind(error) }));
    push('start');
    return { finish() {
        if (closed) { return; }
        push('finish'); closed = true; watcher.close(); listener.dispose();
        console.log('HOST-WORKSPACE-OBSERVATION', JSON.stringify({ source: 'extension-host-disk', startedAt: started, events, dropped }));
    } };
};

// Raw workbench logs can contain paths, arguments and settings. They never go
// to public output/artifacts: reconstruct only counts and fixed enum metadata.
exports.createLogCollector = ({ workspaceFile, roots, emit = console.log }) => {
    const variants = value => [value, value.replaceAll('\\', '/'), pathToFileURL(value).toString()];
    const workspaceNames = variants(workspaceFile), rootNames = roots.flatMap(variants);
    const counts = {}, checkpoints = new Set(), events = [], startedAt = Date.now();
    let discardedLines = 0, oversizedLines = 0, scannedBytes = 0, scannedFiles = 0;
    const increment = kind => { counts[kind] = (counts[kind] ?? 0) + 1; };
    const evidence = (kind, channel, line) => {
        increment(`${channel}:${kind}`);
        if (events.length < LIMIT) { events.push({ kind, channel, observedMs: Date.now() - startedAt,
            logTime: /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}/.exec(line)?.[0] }); }
    };
    const keys = new Set(['source', 'startedAt', 'events', 'dropped', 'ms', 'kind', 'current', 'added', 'removed',
        'disk', 'status', 'bytes', 'declaredRoots', 'expectedRoots', 'physical', 'error']);
    const enums = new Set(['extension-host-disk', 'start', 'finish', 'folders', 'file-notification',
        'watch-error', 'size-limit', 'empty', 'invalid-json', 'valid-json', 'read-error',
        'directory', 'other-type', 'other-error', ...errors]);
    const safe = value => {
        if (typeof value === 'number') { return Number.isFinite(value) ? value : null; }
        if (typeof value === 'boolean' || value === null) { return value; }
        if (typeof value === 'string') { return enums.has(value) ? value : 'redacted'; }
        if (Array.isArray(value)) { return value.slice(0, LIMIT).map(safe); }
        if (value && typeof value === 'object') {
            return Object.fromEntries(Object.entries(value).filter(([key]) => keys.has(key)).map(([key, item]) => [key, safe(item)]));
        }
        return null;
    };
    const consume = (line, channel) => {
        line = line.replace(/\x1b\[[0-9;]*m/g, '');
        const own = line.indexOf('HOST-WORKSPACE-OBSERVATION ');
        if (own >= 0 && channel === 'stdout') {
            try { emit('HOST-WORKSPACE-OBSERVATION', JSON.stringify(safe(JSON.parse(line.slice(own + 27))))); }
            catch { increment('observation-decode-error'); }
            return;
        }
        const checkpoint = /^PASS (HOST-[A-Z0-9-]+)\b/.exec(line);
        if (checkpoint && channel === 'stdout' && !checkpoints.has(checkpoint[1])) {
            checkpoints.add(checkpoint[1]); emit('HOST-WORKSPACE-CHECKPOINT', checkpoint[1]); return;
        }
        const workspace = workspaceNames.some(name => line.includes(name));
        const root = rootNames.some(name => line.includes(name));
        if (workspaceNames.some(name => line.includes(`Unable to read file '${name}'`) ||
            line.includes(`Error while resolving configuration file '${name}'`))) {
            evidence('workspace-read-error', channel, line);
        } else if (root && line.includes('Ignoring the error while validating workspace folder')) {
            evidence('root-validation-warning', channel, line);
        } else if (line.includes('Error while parsing settings file')) {
            // VS Code identifies parsers by an internal ID, not always a URI.
            evidence('configuration-parser-exception-unscoped', channel, line);
        } else if (workspace && /File Watcher|FileWatcher/.test(line)) {
            increment(`${channel}:workspace-file-watch-log`);
        } else if (line.includes('Monitoring scope preparation is blocked by the current workspace or Git context')) {
            increment(`${channel}:scope-context-conflict`);
        } else if (line.includes('AssertionError')) { increment(`${channel}:assertion`); }
        else { discardedLines++; }
    };
    const stream = channel => {
        const decoder = new StringDecoder('utf8');
        let pending = '', discarding = false;
        const flush = text => {
            for (const part of text.split(/(?<=\n)/)) {
                if (!discarding) { pending += part; }
                if (pending.length > 64 * 1024) { pending = ''; discarding = true; oversizedLines++; }
                if (part.endsWith('\n')) {
                    if (!discarding) { consume(pending.trimEnd(), channel); }
                    pending = ''; discarding = false;
                }
            }
        };
        return new Writable({ write(chunk, _encoding, done) { flush(decoder.write(chunk)); done(); },
            final(done) { flush(decoder.end()); if (pending) { consume(pending, channel); } done(); } });
    };
    const stdout = stream('stdout'), stderr = stream('stderr');
    return { stdout, stderr, finish(profile) {
        stdout.end(); stderr.end();
        const visit = (directory, depth = 0) => {
            if (depth > 5 || scannedFiles >= 64 || scannedBytes >= 8 * 1024 * 1024) { return; }
            let entries; try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
            for (const entry of entries.slice(0, 128)) {
                const name = path.join(directory, entry.name);
                if (entry.isDirectory()) { visit(name, depth + 1); }
                else if (entry.isFile() && entry.name.endsWith('.log') && scannedFiles < 64 && scannedBytes < 8 * 1024 * 1024) {
                    const descriptor = fs.openSync(name, 'r');
                    try {
                        const buffer = Buffer.alloc(Math.min(1024 * 1024, 8 * 1024 * 1024 - scannedBytes));
                        const bytes = fs.readSync(descriptor, buffer); scannedBytes += bytes; scannedFiles++;
                        for (const line of buffer.subarray(0, bytes).toString('utf8').split('\n')) { consume(line, 'profile'); }
                    } finally { fs.closeSync(descriptor); }
                }
            }
        };
        visit(path.join(profile, 'logs'));
        emit('HOST-WORKSPACE-STANDARD-TRACE', JSON.stringify({ startedAt, counts, events, scannedFiles, scannedBytes,
            discardedLines, oversizedLines, capabilities: { actualReadContent: false, parserResult: false, successfulRootValidation: false } }));
    } };
};
