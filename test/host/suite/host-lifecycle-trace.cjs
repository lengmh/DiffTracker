// Test-only, bounded metadata. No resource contents or absolute paths are logged.
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const path = require('node:path');
const keys = ['monitoringScope', 'watchInclude', 'watchExclude'];
function canonical(value) {
    if (value === undefined) { return { unset: true }; }
    if (Array.isArray(value)) { return value.map(canonical); }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    }
    return value;
}
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const category = value => !value ? undefined :
    /dirty|unsaved/i.test(value) ? 'dirty-document' : /unknown.*baseline|baseline.*unknown/i.test(value) ? 'unknown-baseline' :
    /identity|symbolic|boundary|case.sensitivity/i.test(value) ? 'identity' : /changed.*read|read.*changed/i.test(value) ? 'unstable-read' :
    /persist|sav/i.test(value) ? 'persistence' : /scope|exclu|ignor/i.test(value) ? 'scope-policy' : 'other';

exports.createHostLifecycleTrace = function(vscode, root, files, limit = 192) {
    root = vscode.Uri.file(root).fsPath;
    const targets = new Set(files.map(file => vscode.Uri.file(path.join(root, file)).fsPath));
    const began = performance.now(), entries = [], disposables = [], pending = new Set(), waiters = new Set();
    let dropped = 0, disposed = false, tracker, controller, expected;
    const relative = file => file === root ? '<root>' : targets.has(file) ? path.relative(root, file).replace(/\\/g, '/') : undefined;
    const inspect = () => {
        try {
        const config = vscode.workspace.getConfiguration('diffTracker');
        const folder = vscode.workspace.workspaceFolders?.[0];
        const scoped = folder && vscode.workspace.getConfiguration('diffTracker', folder.uri);
        return Object.fromEntries(keys.map(key => [key, {
            workspace: digest(config.inspect(key)?.workspaceValue),
            folder: digest(scoped?.inspect(key)?.workspaceFolderValue)
        }]));
        } catch { return { unavailable: true }; }
    };
    const currentDigest = () => {
        try { return digest(Object.fromEntries(keys.map(key =>
            [key, vscode.workspace.getConfiguration('diffTracker').inspect(key)?.workspaceValue]))); }
        catch { return '<unavailable>'; }
    };
    const documents = () => {
        try { return vscode.workspace.textDocuments.filter(doc => relative(doc.uri.fsPath)).slice(0, 8).map(doc => ({
            path: relative(doc.uri.fsPath), dirty: doc.isDirty, version: doc.version, closed: doc.isClosed
        })); } catch { return []; }
    };
    const snapshot = (target = [...targets][0]) => {
        tracker ??= controller?.tracker;
        const scope = tracker?.committedScopeDuringApply ?? tracker?.effectiveMonitoringScope;
        const review = target && tracker?.trackedChanges.get(target);
        return { epoch: tracker?.sessionEpoch, recording: tracker?.isRecording, ready: tracker?.snapshotInitialized,
            building: tracker?.baselineBuilding, restoring: tracker?.restoringEpoch, recheck: tracker?.coverageRecheckEpoch,
            transaction: !!tracker?.baselineTransaction, preflight: !!tracker?.scopeApplyPreflight,
            pendingScope: !!tracker?.pendingMonitoringScope, activeScopeApplications: tracker?.activeScopeApplications,
            directoryJobs: tracker?.directoryObservations.size, creations: tracker?.activeCreations.size,
            snapshotReads: tracker?.pendingSnapshotReads.size, externalOperations: tracker?.activeExternalOperations.size,
            runtimePublications: tracker?.runtimeBaselinePublications.size, initialIgnore: tracker?.initialIgnoreEpoch,
            controller: controller && { writes: controller.pendingScopeSettingsWrites, action: controller.scopeActionInProgress,
                unverified: controller.unverifiedSettingsWrite, disposed: controller.disposed },
            dirtyDocuments: vscode.workspace.textDocuments.filter(doc => doc.isDirty).length,
            scope: scope && { kind: scope.kind, mode: scope.mode, revision: scope.scopeRevision },
            baseline: target ? tracker?.fileSnapshots.has(target) : undefined,
            baselineExists: target ? tracker?.baselineExistingFiles.has(target) : undefined,
            unknown: target ? category(tracker?.unresolvedBaselineFiles.get(target)) : undefined,
            unknownEvidence: target && tracker?.unresolvedBaselineFiles.has(target) ? digest(tracker.unresolvedBaselineFiles.get(target)) : undefined,
            postBaselineUnknown: target ? tracker?.postBaselineUnknownFiles.has(target) : undefined,
            scanUncertain: target ? tracker?.scanUncertainFiles.has(target) : undefined,
            pendingWrite: target ? tracker?.pendingWriteFiles.has(target) : undefined,
            review: review && { kind: review.reviewKind, unavailable: category(review.unavailableReason), deleted: review.isDeleted },
            fileGap: target ? tracker?.coverageGaps.get(target)?.file?.reasonCode : undefined,
            timer: target ? tracker?.externalChangeTimers.has(target) : undefined };
    };
    const add = (kind, data = {}) => {
        if (disposed) { return; }
        if (entries.length >= limit) { dropped++; return; }
        entries.push({ ms: Math.round((performance.now() - began) * 10) / 10, kind, ...data });
    };
    const signal = () => { for (const waiter of [...waiters]) { waiter(); } };
    const error = value => ({ name: value?.name, code: /^[A-Z][A-Z0-9_]+$/.test(value?.code) ? value.code : undefined });
    disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
        const changed = keys.filter(key => event.affectsConfiguration(`diffTracker.${key}`));
        if (changed.length) { add('configuration', { keys: changed, inspect: inspect(), documents: documents() }); signal(); }
    }));
    for (const [name, subscribe] of [
        ['created-files', vscode.workspace.onDidCreateFiles], ['deleted-files', vscode.workspace.onDidDeleteFiles]
    ]) {
        disposables.push(subscribe(event => {
            const paths = event.files.map(uri => relative(uri.fsPath)).filter(Boolean);
            if (paths.length) { add(name, { paths, state: snapshot() }); }
        }));
    }
    for (const [name, subscribe] of [
        ['document-open', vscode.workspace.onDidOpenTextDocument], ['document-save', vscode.workspace.onDidSaveTextDocument]
    ]) {
        disposables.push(subscribe(doc => { if (relative(doc.uri.fsPath)) { add(name, { documents: documents() }); } }));
    }
    disposables.push(vscode.workspace.onDidChangeTextDocument(event => {
        if (relative(event.document.uri.fsPath)) { add('document-change', { documents: documents() }); }
    }));
    disposables.push(vscode.workspace.onWillSaveTextDocument(event => {
        if (relative(event.document.uri.fsPath)) { add('document-will-save', { documents: documents() }); }
    }));
    add('start', { phase: process.env.DIFF_TRACKER_HOST_PHASE, run: process.env.DIFF_TRACKER_HOST_DIAGNOSTIC === 'isolated' ? 'isolated' : 'full', wallMs: Date.now(), pid: process.pid, vscode: vscode.version, node: process.versions.node,
        roots: vscode.workspace.workspaceFolders?.length, inspect: inspect(), documents: documents() });
    return {
        add, inspect, documents, snapshot,
        attachController(value) { controller = value; tracker = value.tracker; },
        setExpected(value) { expected = digest(value); },
        observeApi(config, ...args) {
            const [key] = args;
            const id = {}, started = performance.now(); pending.add(id);
            add('api-start', { key, inspect: inspect(), documents: documents() });
            let response;
            try { response = config.update(...args); }
            catch (caught) { pending.delete(id); add('api-throw', { key, error: error(caught) }); signal(); throw caught; }
            Promise.resolve(response).then(() => {
                pending.delete(id); add('api-response', { key, elapsedMs: Math.round(performance.now() - started), inspect: inspect(), documents: documents() }); signal();
            }, caught => {
                pending.delete(id); add('api-rejected', { key, error: error(caught), inspect: inspect(), documents: documents() }); signal();
            });
            return response;
        },
        observeAfterFailure(milliseconds = 5000) {
            return new Promise(resolve => {
                let timer;
                const finish = () => { clearTimeout(timer); waiters.delete(check); resolve(); };
                const check = () => { if (!pending.size && expected === currentDigest()) { finish(); } };
                waiters.add(check); timer = setTimeout(finish, milliseconds); check();
            });
        },
        hookTracker(DiffTracker) {
            const saved = new Map();
            for (const name of ['getTrackedChanges', 'onExternalFileCreatedEvent', 'onExternalFileCreated', 'onExternalFileChanged',
                'onExternalFileDeleted', 'dispatchExternalEvent', 'readFileAndUpdate', 'readFileSnapshot', 'recordUnresolvedBaseline', 'markFileUnavailable', 'updateTrackedDiff',
                'isPathIgnored', 'deferPendingScopeEvent', 'deferInitialIgnoreEvent', 'mayHaveSuppressedResource', 'completeRuntimeBaseline', 'completeBaseline']) {
                const original = DiffTracker.prototype[name]; saved.set(name, original);
                DiffTracker.prototype[name] = function(...args) {
                    tracker = this;
                    const file = typeof args[0] === 'string' ? args[0] : args[0]?.fsPath;
                    const matched = relative(file) ?? (['completeBaseline','completeRuntimeBaseline'].includes(name) ? '<session>' : undefined);
                    if (matched && name !== 'getTrackedChanges') { add('tracker-entry', { method: name, path: matched,
                        event: name === 'dispatchExternalEvent' ? args[1] : undefined, state: snapshot(file) }); }
                    const result = original.apply(this, args);
                    if (matched && typeof result === 'boolean') { add('guard-result', { method: name, path: matched, result }); }
                    if (matched && result?.then) { result.then(value => add('tracker-return', { method: name, path: matched, state: snapshot(file),
                        observation: name === 'readFileSnapshot' ? { kind: value?.kind, reason: category(value?.reason) } : undefined }),
                        caught => add('tracker-rejected', { method: name, path: matched, error: error(caught), state: snapshot(file) })); }
                    return result;
                };
            }
            disposables.push({ dispose() { for (const [name, original] of saved) { DiffTracker.prototype[name] = original; } } });
        },
        dump() { return { entries, dropped, pendingApis: pending.size, expectedVisible: expected === undefined ? undefined : expected === currentDigest(), documents: documents(), state: snapshot() }; },
        dispose() { disposed = true; for (const disposable of disposables.splice(0)) { disposable.dispose(); } }
    };
};
