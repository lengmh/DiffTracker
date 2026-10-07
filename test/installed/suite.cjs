const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const vscode = require('vscode');

const ID = 'lengmh.code-diff-tracker';
const DRIVER = 'difftracker-internal-tests.difftracker-installed-rc-driver';
const BASE = {
    'pending.txt': 'accepted pending baseline\n',
    'watched.txt': 'accepted watcher baseline\n',
    'offline.txt': 'accepted offline baseline\n',
    'legacy-excluded.txt': 'excluded baseline\n',
    'legacy-reincluded.txt': 'accepted legacy exception\n'
};
const PENDING = 'pending edit before actual Host exit\n';
const WATCHED = 'external edit after installed activation recovery\n';
const OFFLINE = 'offline edit between actual Hosts\n';
const REINCLUDED = 'changed ordered legacy exception\n';
const OPAQUE_BASE = Buffer.from([0, 12, 24, 36]);
const OPAQUE_EDIT = Buffer.from([0, 48, 60, 72]);
const hash = value => createHash('sha256').update(value).digest('hex');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

exports.run = async () => {
    const phase = process.env.DT_INSTALLED_PHASE;
    const report = { phase, status: 'failed', observations: [] };
    let watchdog;
    try {
        await Promise.race([
            scenario(phase, report),
            new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error(`${phase} exceeded 90 seconds`)), 90_000); })
        ]);
        report.status = 'passed';
        console.log(`PASS HOST-INSTALLED-RC ${phase}: ${JSON.stringify(report)}`);
    } catch (error) {
        report.error = error.stack || String(error);
        throw error;
    } finally {
        clearTimeout(watchdog);
        fs.writeFileSync(process.env.DT_INSTALLED_REPORT, JSON.stringify(report, null, 2));
    }
};

async function scenario(phase, report) {
    const workspace = process.env.DT_INSTALLED_WORKSPACE;
    const legacy = process.env.DT_INSTALLED_LEGACY === '1';
    const prepared = phase === 'candidate-first-install' || phase === 'released-prepare';
    const stopped = phase === 'candidate-stopped-reload';
    const candidate = process.env.DT_INSTALLED_VERSION !== '0.7.2';
    const file = name => path.join(workspace, name);
    const uri = name => vscode.Uri.file(file(name));
    const read = name => fs.readFileSync(file(name));
    const write = (name, bytes) => fs.writeFileSync(file(name), bytes);
    const contents = () => Object.fromEntries(fs.readdirSync(workspace).filter(name =>
        fs.lstatSync(file(name)).isFile()).map(name => [name, read(name).toString('base64')]));
    const beforeActivation = contents();
    const driver = await vscode.extensions.getExtension(DRIVER).activate();
    assert.ok(driver.storageUri, 'real VS Code workspace storage is required');
    // VS Code allocates each extension a sibling under this workspace's real
    // storage root. No product context or custom storage directory is injected.
    const storage = path.join(path.dirname(driver.storageUri.fsPath), ID);
    report.statePath = path.join(storage, 'session-state.json');
    assert.ok(storage.startsWith(path.join(process.env.DT_INSTALLED_ROOT, 'user-data', 'User', 'workspaceStorage') + path.sep));
    const extension = vscode.extensions.getExtension(ID);
    assert.ok(extension, 'the CLI-installed product must be discoverable');
    assert.equal(extension.packageJSON.version, process.env.DT_INSTALLED_VERSION);
    const installedRelative = path.relative(process.env.DT_INSTALLED_EXTENSIONS, extension.extensionPath);
    assert.ok(installedRelative && !installedRelative.startsWith('..') && !path.isAbsolute(installedRelative),
        `product must load from isolated installed extensions: ${extension.extensionPath}`);
    assert.equal(hash(fs.readFileSync(path.join(extension.extensionPath, 'out/extension.js'))), process.env.DT_INSTALLED_ENTRY_HASH);
    assert.equal(fs.existsSync(path.join(extension.extensionPath, 'test')), false);
    await extension.activate();
    assert.equal(extension.isActive, true);
    const commands = await vscode.commands.getCommands(true);
    assert.equal(commands.some(command => command.startsWith('diffTracker._test')), false,
        'installed product must execute in production mode, without development-only test commands');
    report.installedPath = extension.extensionPath;
    report.version = extension.packageJSON.version;
    report.entryHash = hash(fs.readFileSync(path.join(extension.extensionPath, 'out/extension.js')));
    report.productionActivation = true;
    report.vscodeVersion = vscode.version;
    assert.deepEqual(contents(), beforeActivation, 'activation/recovery must never alter workspace file bytes');

    const until = async (description, predicate, milliseconds = 20_000) => {
        const deadline = Date.now() + milliseconds;
        let lastError;
        while (Date.now() < deadline) {
            try {
                const result = await predicate();
                if (result) { return result; }
            } catch (error) { lastError = error; }
            await delay(150);
        }
        throw new Error(`Timed out: ${description}${lastError ? `; ${lastError.message}` : ''}`);
    };
    const state = () => JSON.parse(fs.readFileSync(report.statePath, 'utf8'));
    const baseline = name => new Map(state().fileSnapshots).get(file(name));
    const checkBaselines = () => {
        const persisted = state();
        for (const [name, expected] of Object.entries(BASE)) {
            if (legacy && name === 'legacy-excluded.txt') {
                assert.equal(new Map(persisted.fileSnapshots).has(file(name)), false);
                assert.equal(persisted.baselineExistingFiles.includes(file(name)), false);
            } else { assert.equal(baseline(name), expected, `accepted text must survive: ${name}`); }
        }
        assert.equal(fs.existsSync(path.join(storage, 'session-state.unsaved')), false);
        assert.equal(fs.existsSync(path.join(storage, 'session-state.archive.json')), false,
            'recovery must not silently archive/discard and rebuild a review');
        if (!legacy) {
            const identity = new Map(persisted.opaqueBaselineFiles).get(file('opaque.bin'));
            assert.ok(identity, 'candidate-created opaque baseline must persist');
            assert.equal(identity.fingerprint, hash(OPAQUE_BASE));
            assert.equal(identity.size, OPAQUE_BASE.length);
            assert.equal(new Map(persisted.fileSnapshots).has(file('opaque.bin')), false,
                'opaque content must not be stored as a text before-image');
        }
    };
    await until('durable ready baseline at actual context.storageUri', () => state().baselineState === 'ready' &&
        Object.keys(BASE).every(name => legacy && name === 'legacy-excluded.txt' || baseline(name) === BASE[name]) &&
        !fs.existsSync(path.join(storage, 'session-state.unsaved')));
    const committedBaselines = () => until('committed persistence with retained baselines', () => {
        // Primary publication precedes last-good copy and intent-marker removal.
        // A visible ready primary alone is not yet the durable commit barrier.
        checkBaselines();
        return true;
    });
    await committedBaselines();
    assert.equal(state().isRecording, !stopped);
    await vscode.commands.executeCommand('diffTracker.changesView.focus');
    const tree = async () => {
        const result = await promisify(execFile)(process.env.DT_INSTALLED_NODE,
            [path.join(__dirname, 'tree-observer.mjs'), process.env.DT_INSTALLED_PORT], { timeout: 12_000 });
        return JSON.parse(result.stdout);
    };
    const treeHas = async (names, opaque = false, recording = !stopped) => until('rendered pending review and recording state', async () => {
        const observed = await tree();
        report.lastTree = observed;
        if (!observed.found || !names.every(name => observed.rows.some(row => row.label === name))) { return false; }
        if (!observed.rows.some(row => row.label === (recording ? 'Recording' : 'Start Recording'))) { return false; }
        if (legacy && observed.rows.some(row => row.label === 'legacy-excluded.txt')) {
            throw new Error('legacy excluded file leaked into pending review');
        }
        if (opaque && !observed.rows.some(row => row.label === 'opaque.bin' && /Read-only.*Changed/.test(row.description))) { return false; }
        return observed;
    });
    const original = async name => (await vscode.workspace.openTextDocument(uri(name).with({ scheme: 'diff-tracker-original' }))).getText();
    const nativeReview = async (name, expectedCurrent) => {
        assert.equal(candidate, true);
        const result = await vscode.commands.executeCommand('diffTracker.nativeReview.openFile', uri(name));
        assert.deepEqual(result, { mode: 'single-diff', count: 1 }, 'pending text must remain safely reviewable');
        const current = await until('public Native Review current snapshot', () => {
            const editor = vscode.window.activeTextEditor;
            return editor?.document.uri.scheme === 'diff-tracker-review-current' && editor.document.uri.fsPath === file(name)
                ? editor.document : undefined;
        });
        assert.equal(current.getText(), expectedCurrent);
        const before = await vscode.workspace.openTextDocument(current.uri.with({ scheme: 'diff-tracker-review-base' }));
        assert.equal(before.getText(), BASE[name], 'restoration must not accept the pending bytes');
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    };

    if (legacy) {
        const config = vscode.workspace.getConfiguration('diffTracker');
        assert.deepEqual(config.inspect('watchExclude').globalValue, ['**/legacy-*.txt', '!**/legacy-reincluded.txt']);
        assert.equal(config.inspect('watchExclude').workspaceValue, undefined);
        if (candidate) {
            const persisted = state();
            // It may still be the original V3 until the regular writer flushes.
            if (persisted.version === 4) { assert.equal(persisted.effectiveMonitoringScope.kind, 'legacyV3'); }
            report.observations.push('Unchanged ordered Global legacy rules; no automatic scope migration');
        }
    }
    if (prepared) {
        write('pending.txt', PENDING);
        if (legacy) {
            write('legacy-excluded.txt', 'excluded edit before upgrade\n');
            write('legacy-reincluded.txt', REINCLUDED);
        } else { write('opaque.bin', OPAQUE_EDIT); }
        // Never open the physical document: these changes must reach the real
        // tracker through its watcher, not via document-open or explicit reads.
        await treeHas(legacy ? ['pending.txt', 'legacy-reincluded.txt'] : ['pending.txt', 'opaque.bin'], !legacy);
        assert.equal(await original('pending.txt'), BASE['pending.txt']);
        if (candidate) { await nativeReview('pending.txt', PENDING); }
        report.observations.push(legacy ? 'Official 0.7.2 produced pending text + ordered legacy exclusion evidence' :
            'First installed candidate produced text and opaque pending reviews through real watchers');
    } else {
        const names = ['pending.txt', 'offline.txt', ...(legacy ? ['legacy-reincluded.txt'] : ['opaque.bin']),
            ...(stopped ? ['watched.txt'] : [])];
        await treeHas(names, !legacy);
        assert.equal(await original('pending.txt'), BASE['pending.txt']);
        await nativeReview('pending.txt', PENDING);
        await nativeReview('offline.txt', OFFLINE);
        if (legacy) { await nativeReview('legacy-reincluded.txt', REINCLUDED); }
        report.observations.push('Pending text restored with original before-image and current snapshot after real activation');
        if (!legacy) {
            assert.deepEqual(read('opaque.bin'), OPAQUE_EDIT);
            report.observations.push('Candidate-created opaque identity remains baseline; changed bytes remain read-only pending');
        }
        if (!stopped) {
            write('watched.txt', WATCHED);
            if (legacy) { write('legacy-excluded.txt', 'excluded edit after candidate upgrade\n'); }
            await treeHas([...names, 'watched.txt'], !legacy);
            await nativeReview('watched.txt', WATCHED);
            report.observations.push('Post-activation external edit observed through newly acquired production watchers');
        } else {
            await nativeReview('watched.txt', WATCHED);
            report.observations.push('Stopped session stayed stopped while all existing pending reviews remained available');
        }
        if (phase === 'candidate-recording-reload') {
            await vscode.commands.executeCommand('diffTracker.stopRecording');
            await until('public Stop command durably saved stopped session', () => state().isRecording === false &&
                !fs.existsSync(path.join(storage, 'session-state.unsaved')));
            await treeHas([...names, 'watched.txt'], true, false);
        }
    }
    await committedBaselines();
    // Verify expected fixture bytes, including every file not edited by this
    // phase. Neither review entry nor migration is permitted to write content.
    assert.equal(read('pending.txt').toString(), PENDING);
    assert.equal(read('offline.txt').toString(), prepared ? BASE['offline.txt'] : OFFLINE);
    assert.equal(read('watched.txt').toString(), prepared ? BASE['watched.txt'] : WATCHED);
    assert.equal(read('legacy-reincluded.txt').toString(), legacy ? REINCLUDED : BASE['legacy-reincluded.txt']);
    assert.equal(read('legacy-excluded.txt').toString(), legacy
        ? (prepared ? 'excluded edit before upgrade\n' : 'excluded edit after candidate upgrade\n') : BASE['legacy-excluded.txt']);
    if (!legacy) { assert.deepEqual(read('opaque.bin'), OPAQUE_EDIT); }
    report.recording = phase !== 'candidate-recording-reload' && !stopped;
    report.observations.push('No Clear/Start/Rebuild/Revert/migration commands used; accepted baseline and workspace bytes preserved');
}
