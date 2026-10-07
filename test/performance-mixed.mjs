/** Bounded RC workload: production scope/tracker, real files and native fs.watch.
 * VS Code configuration, discovery and host watcher events are API-boundary stubs.
 * This is not Extension Host evidence. Timings/RSS are observations, not new SLAs.
 * Run in a separate process so module stubs and RSS do not leak from the text smoke.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import Module, { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const MiB = 1024 * 1024;
// Existing product contracts, never assigned back into production internals.
const budgets = { entries: 10_000, sessionBytes: 50 * MiB, textBytes: 5 * MiB, sharedDirectWatchers: 256 };
const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-tracker-mixed-performance-'));
const root = path.join(parent, 'workspace');
const storage = path.join(parent, 'storage');
const manifest = new Map();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const describe = (bytes, kind) => ({ kind, size: bytes.length, fingerprint: hash(bytes),
    ...(kind === 'text' ? { text: bytes.toString('utf8') } : {}) });
function fixtureFile(relative, content, kind = 'text') {
    const filePath = path.join(root, relative);
    const bytes = Buffer.from(content);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, bytes);
    manifest.set(filePath, describe(bytes, kind));
    return filePath;
}
fixtureFile('.gitignore', 'node_modules/\ndist/\n');
for (let index = 0; index < 256; index++) {
    fixtureFile(`src/${index}.txt`, index % 4 === 0
        ? `${'0123456789abcdef'.repeat(2048)}\n` : `source ${index}\n`);
}
for (let directory = 0; directory < 8; directory++) {
    for (let index = 0; index < 32; index++) {
        fixtureFile(`node_modules/pkg-${directory}/${index}.txt`, `dependency ${directory}/${index}\n`);
    }
    for (let index = 0; index < 4; index++) {
        fixtureFile(`node_modules/pkg-${directory}/${index}.bin`, Buffer.alloc(8192, index), 'opaque');
    }
}
for (let index = 0; index < 4; index++) {
    // Valid UTF-8 above the text ceiling must retain an opaque identity.
    fixtureFile(`dist/${index}.txt`, Buffer.alloc(budgets.textBytes + 1, 65 + index), 'opaque');
}
const sourceBytes = [...manifest.values()].reduce((sum, file) => sum + file.size, 0);
const initialKinds = {
    text: [...manifest.values()].filter(file => file.kind === 'text').length,
    opaque: [...manifest.values()].filter(file => file.kind === 'opaque').length
};

const noopEvent = () => ({ dispose() {} });
class Emitter {
    listeners = new Set();
    event = (listener, owner) => {
        const bound = owner ? listener.bind(owner) : listener;
        this.listeners.add(bound);
        return { dispose: () => this.listeners.delete(bound) };
    };
    fire(value) { for (const listener of [...this.listeners]) { listener(value); } }
    dispose() { this.listeners.clear(); }
}
class Uri {
    constructor(fsPath) { this.fsPath = fsPath; this.path = fsPath; this.scheme = 'file'; }
    static file(value) { return new Uri(value); }
    static parse(value) { return new Uri(fileURLToPath(value)); }
    static joinPath(uri, ...parts) { return new Uri(path.join(uri.fsPath, ...parts)); }
    toString() { return pathToFileURL(this.fsPath).href; }
}
const folder = { uri: Uri.file(root), name: 'mixed-performance' };
const configuration = new Map();
const configurationChanged = new Emitter();
const hostWatchers = new Set();
const nativeWatchers = new Map();
const burstDirectoryNotifications = new Set();
const watcherMetrics = { apiBoundaryPeak: 0, realNativePeak: 0, realNativeEvents: 0, injectedHostEvents: 0 };
const warnings = [];
let phase = 'setup';
let rssPeak = process.memoryUsage().rss;
const rssStart = rssPeak;
const rssByPhase = {};
function sampleRss() {
    const rss = process.memoryUsage().rss;
    rssPeak = Math.max(rssPeak, rss);
    rssByPhase[phase] = Math.max(rssByPhase[phase] ?? 0, rss);
}
function markPhase(next) { sampleRss(); phase = next; sampleRss(); }
const nativeWatch = fs.watch;
fs.watch = (directory, options, listener) => {
    const watcher = nativeWatch(directory, options, (...args) => {
        watcherMetrics.realNativeEvents++;
        // Some native backends notify a parent about child-directory metadata
        // when entries inside that child are created, removed or replaced.
        // Record the boundary evidence without changing the production event.
        if (phase === 'burst' && args[1]) {
            const target = path.resolve(String(directory), args[1].toString());
            try {
                if (fs.lstatSync(target).isDirectory()) { burstDirectoryNotifications.add(target); }
            } catch { /* A removed file is not a directory-identity witness. */ }
        }
        listener(...args);
    });
    nativeWatchers.set(watcher, path.resolve(String(directory)));
    watcherMetrics.realNativePeak = Math.max(watcherMetrics.realNativePeak, nativeWatchers.size);
    watcher.once('close', () => nativeWatchers.delete(watcher));
    return watcher;
};
function createHostWatcher(pattern) {
    const events = { change: new Emitter(), create: new Emitter(), delete: new Emitter() };
    const watcher = {
        pattern, events,
        onDidChange: events.change.event,
        onDidCreate: events.create.event,
        onDidDelete: events.delete.event,
        dispose() {
            hostWatchers.delete(watcher);
            Object.values(events).forEach(event => event.dispose());
        }
    };
    hostWatchers.add(watcher);
    watcherMetrics.apiBoundaryPeak = Math.max(watcherMetrics.apiBoundaryPeak, hostWatchers.size);
    return watcher;
}
function emitHost(kind, filePath) {
    // The excluded subtree receives only real native events, never synthetic host events.
    if (filePath.startsWith(path.join(root, 'node_modules') + path.sep)) { return; }
    watcherMetrics.injectedHostEvents++;
    for (const watcher of hostWatchers) { watcher.events[kind].fire(Uri.file(filePath)); }
}
const vscode = {
    EventEmitter: Emitter, Uri,
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    RelativePattern: class { constructor(base, pattern) { Object.assign(this, { base, pattern }); } },
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    window: { showWarningMessage: async message => { warnings.push(message); },
        showErrorMessage: async message => { warnings.push(message); } },
    workspace: {
        isTrusted: true, textDocuments: [], workspaceFolders: [folder],
        getWorkspaceFolder: uri => {
            const relative = path.relative(root, uri.fsPath);
            return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
                ? folder : undefined;
        },
        getConfiguration: section => ({
            get: (key, fallback) => key === 'files.watcherExclude' ? { 'node_modules/**': true }
                : section === 'diffTracker' && configuration.has(key) ? configuration.get(key) : fallback,
            inspect: key => ({ workspaceValue: section === 'diffTracker' ? configuration.get(key) : undefined }),
            update: async (key, value) => {
                configuration.set(key, value);
                configurationChanged.fire({ affectsConfiguration: candidate => candidate === `diffTracker.${key}` });
            }
        }),
        onDidChangeConfiguration: configurationChanged.event,
        onDidChangeTextDocument: noopEvent, onDidOpenTextDocument: noopEvent,
        onWillSaveTextDocument: noopEvent, onDidSaveTextDocument: noopEvent,
        onDidCreateFiles: noopEvent, onDidChangeWorkspaceFolders: noopEvent,
        // Candidate inclusion is still decided by the production tracker.
        findFiles: async pattern => pattern.pattern === '**/*' ? [...manifest.keys()].map(Uri.file)
            : pattern.pattern === '**/.gitignore' ? [Uri.file(path.join(root, '.gitignore'))] : [],
        createFileSystemWatcher: createHostWatcher,
        fs: {
            stat: async uri => {
                const stat = await fs.promises.stat(uri.fsPath);
                return { type: stat.isDirectory() ? 2 : 1, size: stat.size, mtime: stat.mtimeMs };
            },
            readFile: async uri => new Uint8Array(await fs.promises.readFile(uri.fsPath)),
            writeFile: async (uri, bytes) => fs.promises.writeFile(uri.fsPath, bytes),
            createDirectory: async uri => fs.promises.mkdir(uri.fsPath, { recursive: true }),
            delete: async uri => fs.promises.unlink(uri.fsPath),
            rename: async (source, target) => fs.promises.rename(source.fsPath, target.fsPath),
            copy: async (source, target) => fs.promises.copyFile(source.fsPath, target.fsPath)
        }
    }
};
const originalLoad = Module._load;
let DiffTracker, MonitoringScopeController;
Module._load = function (id, ...args) { return id === 'vscode' ? vscode : originalLoad.call(this, id, ...args); };
try {
    ({ DiffTracker } = require('../out/diffTracker.js'));
    ({ MonitoringScopeController } = require('../out/monitoringScopeController.js'));
} finally { Module._load = originalLoad; }

const workspaceState = new Map();
const tracker = new DiffTracker(Uri.file(storage));
const controller = new MonitoringScopeController({ workspaceState: {
    get: (key, fallback) => workspaceState.get(key) ?? fallback,
    update: async (key, value) => workspaceState.set(key, value)
} }, tracker);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
// Liveness guard only. It is deliberately not used as an RC latency threshold.
const watchdog = setTimeout(() => {
    console.error('Mixed fixture liveness watchdog expired', {
        phase, warnings, baselineState: tracker.getBaselineState(),
        pending: tracker.getTrackedChanges().map(change => ({ path: path.relative(root, change.filePath),
            kind: change.reviewKind, deleted: change.isDeleted })),
        coverageGaps: tracker.getSubtreeCoverageGaps()
    });
    process.exitCode = 1;
    process.exit(1);
}, 120_000);
watchdog.unref();
const rssSampler = setInterval(sampleRss, 10);
rssSampler.unref();
async function until(predicate) { while (!predicate()) { await delay(10); } }
const elapsed = start => Math.round((performance.now() - start) * 10) / 10;
const mib = bytes => Math.round(bytes / MiB * 10) / 10;
const readSession = () => JSON.parse(fs.readFileSync(path.join(storage, 'session-state.json'), 'utf8'));
let disposed = false;
try {
    assert.equal((await controller.saveRequestedScope({ mode: 'rules', includes: [], excludes: [] })).ok, true);
    assert.equal((await controller.applyPendingScope()).status, 'applied');
    tracker.startRecording();
    await until(() => tracker.getBaselineState() === 'ready');
    assert.equal(await tracker.flushPendingPersistence(), true);
    const before = readSession();
    assert.equal(before.fileSnapshots.length, 257, 'Rules startup excludes the dependency/build workload');
    assert.equal(before.opaqueBaselineFiles.length, 0);

    const saved = await controller.saveRequestedScope({ mode: 'wholeWorkspace', includes: [], excludes: [] });
    assert.equal(saved.ok, true);
    const requested = saved.scope;
    markPhase('preflight');
    const preflightStart = performance.now();
    const preview = await tracker.preflightConfiguredMonitoringScope(requested);
    const preflightMilliseconds = elapsed(preflightStart);
    assert.equal(preview.status, 'ready', JSON.stringify(preview));
    assert.equal(preview.truncated, false);
    assert.equal(preview.entryLimit, budgets.entries);
    assert.equal(preview.candidateFiles, manifest.size);
    assert.equal(preview.unreadableDirectoryCount, 0);
    assert.equal(tracker.getEffectiveMonitoringScope().scopeRevision, before.effectiveMonitoringScope.scopeRevision,
        'advisory preflight must not publish the requested scope');

    markPhase('preparation');
    const preparationStart = performance.now();
    const applied = await controller.applyPendingScope({ grantConsent: true, expectedScopeRevision: requested.scopeRevision });
    const preparationMilliseconds = elapsed(preparationStart);
    assert.equal(applied.status, 'applied', JSON.stringify(applied));
    assert.equal(tracker.getEffectiveMonitoringScope().scopeRevision, requested.scopeRevision);
    assert.equal(tracker.getBaselineState(), 'ready');
    assert.deepEqual(tracker.getCoverageGaps(), []);
    assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
    assert.deepEqual(tracker.getTrackedChanges(), []);
    assert.equal(await tracker.flushPendingPersistence(), true);
    const prepared = readSession();
    assert.equal(prepared.version, 4);
    assert.equal(prepared.fileSnapshots.length, initialKinds.text);
    assert.equal(prepared.opaqueBaselineFiles.length, initialKinds.opaque);
    assert.equal(prepared.unresolvedBaselineFiles.length, 0);
    const snapshots = new Map(prepared.fileSnapshots);
    const opaque = new Map(prepared.opaqueBaselineFiles);
    for (const [filePath, file] of manifest) {
        if (file.kind === 'text') {
            assert.equal(snapshots.get(filePath), file.text);
            assert.ok(file.size <= budgets.textBytes);
        } else {
            assert.equal(opaque.get(filePath)?.fingerprint, file.fingerprint);
            assert.equal(opaque.get(filePath)?.size, file.size);
            assert.equal(snapshots.has(filePath), false, 'opaque content must not become a text snapshot');
        }
    }
    const preparedSessionBytes = fs.statSync(path.join(storage, 'session-state.json')).size;
    assert.ok(preparedSessionBytes <= budgets.sessionBytes);
    assert.equal(nativeWatchers.size, 9, 'the excluded dependency tree has one root and eight package owners');

    const expected = new Map();
    const temporaryPaths = [];
    const membershipChangedDirectories = new Set();
    const burstOperations = { changed: 0, created: 0, deleted: 0, tempRenameReplacements: 0 };
    function change(relative, content, kind = 'text', replace = false) {
        const filePath = path.join(root, relative);
        const bytes = Buffer.from(content);
        const beforeFile = manifest.get(filePath);
        expected.set(filePath, { before: beforeFile, after: describe(bytes, kind) });
        if (replace || !beforeFile) { membershipChangedDirectories.add(path.dirname(filePath)); }
        if (replace) {
            const temporary = `${filePath}.saving`;
            temporaryPaths.push(temporary);
            fs.writeFileSync(temporary, bytes);
            emitHost('create', temporary);
            fs.renameSync(temporary, filePath);
            emitHost('delete', temporary);
            burstOperations.tempRenameReplacements++;
        } else { fs.writeFileSync(filePath, bytes); }
        emitHost(beforeFile ? 'change' : 'create', filePath);
        burstOperations[beforeFile ? 'changed' : 'created']++;
    }
    function remove(relative) {
        const filePath = path.join(root, relative);
        expected.set(filePath, { before: manifest.get(filePath), after: undefined });
        membershipChangedDirectories.add(path.dirname(filePath));
        fs.unlinkSync(filePath);
        emitHost('delete', filePath);
        burstOperations.deleted++;
    }
    markPhase('burst');
    const burstStart = performance.now();
    for (let index = 1; index <= 8; index++) {
        change(`src/${index}.txt`, `source changed ${index}\n`);
        change(`node_modules/pkg-${index - 1}/1.txt`, `dependency changed ${index}\n`);
    }
    for (let index = 0; index < 4; index++) {
        change(`node_modules/pkg-${index}/0.bin`, Buffer.alloc(8192, 0x80 + index), 'opaque');
    }
    change('src/20.txt', 'atomic text replacement\n', 'text', true);
    change('node_modules/pkg-4/2.txt', 'atomic dependency replacement\n', 'text', true);
    change('node_modules/pkg-5/2.bin', Buffer.alloc(8192, 0xfe), 'opaque', true);
    change('dist/0.txt', Buffer.alloc(budgets.textBytes + 1, 90), 'opaque', true);
    change('src/new.txt', 'new text\n');
    change('node_modules/pkg-6/new.txt', 'new dependency\n');
    change('src/new.bin', Buffer.alloc(8192, 0xff), 'opaque');
    change('node_modules/pkg-6/new.bin', Buffer.alloc(8192, 0xff), 'opaque');
    remove('src/30.txt');
    remove('node_modules/pkg-7/3.txt');
    remove('node_modules/pkg-7/3.bin');
    remove('dist/3.txt');
    const burstWriteMilliseconds = elapsed(burstStart);
    await until(() => expected.size === tracker.getTrackedChanges().length &&
        [...expected].every(([filePath, file]) => {
            const change = tracker.getTrackedChange(filePath);
            const kind = file.after?.kind ?? file.before.kind;
            return change?.reviewKind === kind && change.isDeleted === !file.after &&
                (kind === 'text' ? change.currentContent === (file.after?.text ?? '')
                    : change.currentFingerprint === file.after?.fingerprint);
        }));
    const burstToVerifiedPendingMilliseconds = elapsed(burstStart);
    // A quiet turn also catches delayed duplicate/temporary-path events.
    await delay(250);
    const pending = tracker.getTrackedChanges();
    assert.deepEqual(new Set(pending.map(change => change.filePath)), new Set(expected.keys()));
    const pendingText = pending.filter(change => change.reviewKind === 'text').length;
    const pendingOpaque = pending.filter(change => change.reviewKind === 'opaque').length;
    assert.equal(pendingText, 22);
    assert.equal(pendingOpaque, 10);
    assert.equal(tracker.getReviewTokens().length, pendingText);
    assert.equal(tracker.getOpaqueReviewTokens().length, pendingOpaque);
    assert.deepEqual(tracker.getUnknownReviewPaths(), []);
    const burstCoverageGaps = tracker.getSubtreeCoverageGaps();
    assert.equal(tracker.getCoverageGaps().length, burstCoverageGaps.length, 'no file-level gap is allowed');
    for (const gap of burstCoverageGaps) {
        assert.equal(gap.reasonCode, 'supplemental-watcher-directory-change-gap');
        assert.equal(path.dirname(gap.targetPath), path.join(root, 'node_modules'), 'only direct package directories qualify');
        assert.ok(membershipChangedDirectories.has(gap.targetPath), 'gap must belong to a membership-mutated directory');
        assert.ok(burstDirectoryNotifications.has(gap.targetPath), 'gap must have an observed directory-target callback');
    }
    assert.deepEqual(new Set(burstCoverageGaps.map(gap => gap.targetPath)), burstDirectoryNotifications,
        'every observed directory notification must retain its precise coverage evidence');
    for (const temporary of temporaryPaths) {
        assert.equal(fs.existsSync(temporary), false);
        assert.equal(tracker.getTrackedChange(temporary), undefined);
    }
    for (const [filePath, file] of expected) {
        const change = tracker.getTrackedChange(filePath);
        assert.equal(change.baselineExists, !!file.before);
        if (change.reviewKind === 'text') {
            assert.equal(tracker.getOriginalContent(filePath), file.before?.text ?? '');
        } else { assert.equal(change.baselineFingerprint, file.before?.fingerprint); }
    }
    assert.ok(watcherMetrics.realNativeEvents > 0);
    assert.ok(watcherMetrics.realNativePeak <= budgets.sharedDirectWatchers);

    // Pending file identity and complete subtree coverage are different claims.
    // Keep the original broad watcher exclusion and preserve any precise parent
    // directory diagnostics before one explicit public Recheck. Do not retry a
    // failed/limited recheck or use Start/Reset to accept these pending changes.
    markPhase('coverageRecheck');
    assert.equal(await tracker.flushPendingPersistence(), true);
    const beforeRecheckSession = readSession();
    const persistedBurstGaps = new Map(beforeRecheckSession.coverageGaps);
    assert.deepEqual(new Set(persistedBurstGaps.keys()), new Set(burstCoverageGaps.map(gap => gap.targetPath)));
    for (const gap of burstCoverageGaps) {
        const evidence = persistedBurstGaps.get(gap.targetPath);
        assert.equal(evidence.file, undefined);
        assert.deepEqual(evidence.subtree, {
            targetKind: 'subtree', reasonCode: gap.reasonCode, reason: gap.reason
        });
    }
    const beforeTextTokens = tracker.getReviewTokens();
    const beforeOpaqueTokens = tracker.getOpaqueReviewTokens();
    const semanticReview = ({ timestamp: _timestamp, reviewReason: _reason, ...change }) => change;
    const recheckStart = performance.now();
    const rechecked = await controller.recheckObservationCoverage();
    const coverageRecheckMilliseconds = elapsed(recheckStart);
    assert.equal(rechecked.status, 'rechecked', JSON.stringify(rechecked));
    assert.equal(tracker.getEffectiveMonitoringScope().scopeRevision, requested.scopeRevision);
    assert.equal(tracker.getIsRecording(), true);
    assert.equal(tracker.getBaselineState(), 'ready');
    assert.deepEqual(tracker.getCoverageGaps(), []);
    assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
    const afterRecheck = new Map(tracker.getTrackedChanges().map(change => [change.filePath, change]));
    assert.deepEqual(new Set(afterRecheck.keys()), new Set(expected.keys()));
    let refreshedOpaqueCreationTokens = 0;
    for (const change of pending) {
        const current = afterRecheck.get(change.filePath);
        assert.deepEqual(semanticReview(current), semanticReview(change), 'Recheck must preserve each pending identity');
        if (current.reviewReason !== change.reviewReason) {
            // Creation is still pending with an absent baseline. A subsequent
            // read can refresh its explanation and conservatively invalidate
            // that opaque token; no content/identity evidence may change.
            assert.equal(change.reviewKind, 'opaque');
            assert.equal(change.baselineExists, false);
            assert.equal(change.reviewReason, 'Read-only unsupported file was created after the baseline');
            assert.equal(current.reviewReason, 'Read-only unsupported file changed after creation');
        }
    }
    for (const token of beforeTextTokens) { assert.deepEqual(tracker.getReviewToken(token.filePath), token); }
    for (const token of beforeOpaqueTokens) {
        const current = tracker.getOpaqueReviewToken(token.filePath);
        assert.ok(current, 'each opaque identity must remain reviewable after Recheck');
        const previousReview = pending.find(change => change.filePath === token.filePath);
        if (manifest.has(token.filePath) || previousReview.reviewReason === afterRecheck.get(token.filePath).reviewReason) {
            assert.deepEqual(current, token);
        } else {
            assert.equal(previousReview.baselineExists, false);
            assert.notEqual(current.reviewRevision, token.reviewRevision);
            assert.deepEqual({ ...current, reviewRevision: token.reviewRevision }, token);
            refreshedOpaqueCreationTokens++;
        }
    }
    const afterRecheckSession = readSession();
    for (const key of ['fileSnapshots', 'opaqueBaselineFiles', 'unresolvedBaselineFiles', 'baselineExistingFiles']) {
        assert.deepEqual(afterRecheckSession[key], beforeRecheckSession[key], `Recheck must preserve ${key}`);
    }
    assert.deepEqual(afterRecheckSession.coverageGaps, []);
    for (const [filePath, file] of expected) {
        if (file.after) { assert.equal(hash(fs.readFileSync(filePath)), file.after.fingerprint); }
        else { assert.equal(fs.existsSync(filePath), false); }
    }

    markPhase('mixedAccept');
    const acceptStart = performance.now();
    const accepted = await tracker.acceptAllPendingChanges();
    const mixedAcceptMilliseconds = elapsed(acceptStart);
    assert.equal(accepted.accepted, pendingText);
    assert.equal(accepted.acknowledged, pendingOpaque);
    assert.equal(accepted.succeeded, expected.size);
    for (const key of ['failed', 'needsConfirmation', 'needsAttention', 'failures', 'conflicts', 'cancelled']) {
        assert.equal(accepted[key], 0, JSON.stringify(accepted));
    }
    assert.deepEqual(tracker.getTrackedChanges(), []);
    assert.equal(await tracker.flushPendingPersistence(), true);
    const acceptedSession = readSession();
    const acceptedText = new Map(acceptedSession.fileSnapshots);
    const acceptedOpaque = new Map(acceptedSession.opaqueBaselineFiles);
    for (const [filePath, file] of expected) {
        if (!file.after) {
            assert.equal(fs.existsSync(filePath), false);
            assert.equal(acceptedSession.baselineExistingFiles.includes(filePath), false);
            assert.equal(acceptedOpaque.has(filePath), false);
        }
        else {
            assert.equal(hash(fs.readFileSync(filePath)), file.after.fingerprint,
                'mixed Accept must not rewrite workspace bytes');
            if (file.after.kind === 'text') { assert.equal(acceptedText.get(filePath), file.after.text); }
            else { assert.equal(acceptedOpaque.get(filePath)?.fingerprint, file.after.fingerprint); }
        }
    }
    const acceptedSessionBytes = fs.statSync(path.join(storage, 'session-state.json')).size;
    assert.ok(acceptedSessionBytes <= budgets.sessionBytes);
    assert.deepEqual(warnings, [], 'healthy workload must not hide a warning behind successful counts');

    // One fault probe, not a quota-exhaustion benchmark: inject the OS error at
    // the native watcher API boundary and require durable limited-coverage evidence.
    markPhase('coverageFailureProbe');
    const failedDirectory = path.join(root, 'node_modules', 'pkg-0');
    const failedOwner = [...nativeWatchers].find(([, directory]) => directory === failedDirectory)?.[0];
    assert.ok(failedOwner);
    failedOwner.emit('error', Object.assign(new Error('injected RC watcher limit probe'), { code: 'ENOSPC' }));
    assert.ok(tracker.getSubtreeCoverageGaps().some(gap => gap.reasonCode === 'supplemental-watcher-system-limit-gap'));
    assert.equal(tracker.getEffectiveMonitoringScope().scopeRevision, requested.scopeRevision);
    assert.equal(await tracker.flushPendingPersistence(), true);
    assert.ok(readSession().coverageGaps.length > 0, 'a watcher failure cannot be persisted as clean coverage');
    const coverageGapCountAfterInjectedFailure = tracker.getSubtreeCoverageGaps().length;

    markPhase('cleanup');
    const stopStart = performance.now();
    tracker.stopRecording();
    await until(() => nativeWatchers.size === 0);
    const stopAndNativeCloseMilliseconds = elapsed(stopStart);
    const afterStop = { apiBoundary: hostWatchers.size, realNative: nativeWatchers.size };
    assert.deepEqual(afterStop, { apiBoundary: 0, realNative: 0 });
    controller.dispose();
    await tracker.dispose();
    disposed = true;
    assert.equal(hostWatchers.size, 0);
    assert.equal(nativeWatchers.size, 0);
    sampleRss();
    console.log(JSON.stringify({
        fixture: 'mixed-text-opaque-rc',
        boundaries: {
            trackerAndScope: 'production public APIs; real local files and Session V4 persistence',
            vscode: 'stub configuration/discovery/host watcher callbacks; not Extension Host evidence',
            nativeWatchers: 'real OS fs.watch callbacks and close events',
            coverageRecheck: 'one explicit public Recheck after the burst; precise observed directory gaps persist first',
            failureProbe: 'one injected ENOSPC at native watcher API boundary; no real OS quota exhaustion',
            measurement: 'one warm filesystem run; new latency/RSS figures are descriptive, without performance gates'
        },
        runtime: { node: process.version, platform: process.platform, arch: process.arch },
        workload: { fileCount: manifest.size, ...initialKinds, sourceBytes,
            oversizedOpaque: 4, binaryOpaque: 32, packageDirectories: 8, burstOperations },
        existingBudgets: budgets,
        preflight: { milliseconds: preflightMilliseconds, inspectedEntries: preview.inspectedEntries,
            candidateFiles: preview.candidateFiles, candidateDirectories: preview.candidateDirectories,
            truncated: preview.truncated },
        preparation: { milliseconds: preparationMilliseconds, preparedSessionBytes },
        burst: { writeMilliseconds: burstWriteMilliseconds,
            firstWriteToVerifiedPendingMilliseconds: burstToVerifiedPendingMilliseconds,
            textPending: pendingText, opaquePending: pendingOpaque, unknownPending: 0, extraPending: 0 },
        coverageRecheck: { milliseconds: coverageRecheckMilliseconds, status: rechecked.status,
            before: burstCoverageGaps.map(gap => ({ path: path.relative(root, gap.targetPath).split(path.sep).join('/'),
                reasonCode: gap.reasonCode })), afterGapCount: 0, preservedPending: expected.size,
            refreshedOpaqueCreationTokens },
        mixedAccept: { milliseconds: mixedAcceptMilliseconds, accepted: accepted.accepted,
            acknowledged: accepted.acknowledged, stillPending: 0, acceptedSessionBytes },
        watchers: { ...watcherMetrics, afterStop, afterDispose: { apiBoundary: 0, realNative: 0 },
            stopAndNativeCloseMilliseconds, coverageGapCountAfterInjectedFailure },
        rss: { measurement: 'whole isolated Node process; 10 ms samples plus phase boundaries; no forced GC',
            startMiB: mib(rssStart), sampledPeakMiB: mib(rssPeak), sampledPeakDeltaMiB: mib(rssPeak - rssStart),
            endMiB: mib(process.memoryUsage().rss),
            phaseSampledPeakMiB: Object.fromEntries(Object.entries(rssByPhase).map(([key, bytes]) => [key, mib(bytes)])) }
    }, null, 2));
} finally {
    clearInterval(rssSampler);
    clearTimeout(watchdog);
    controller.dispose();
    if (!disposed) { await tracker.dispose(); }
    fs.watch = nativeWatch;
    for (const watcher of nativeWatchers.keys()) { watcher.close(); }
    fs.rmSync(parent, { recursive: true, force: true });
}
