import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const extensionDevelopmentPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const extensionTestsPath = path.join(extensionDevelopmentPath, 'test', 'host', 'suite', 'index.cjs');
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'diff-tracker-host-'));
const workspacePath = path.join(tempRoot, 'workspace 中文');
const secondRoot = path.join(tempRoot, 'second root');
const workspaceFile = path.join(tempRoot, 'host.code-workspace');
const restartStorage = path.join(tempRoot, 's4d-restart-storage');
const userDataPath = path.join(tempRoot, 'user-data');
const nativeUserDataPath = path.join(tempRoot, 'native-user-data');
const git = (...args) => execFileSync('git', args, {
    cwd: workspacePath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
});

// Preserve only logs and this extension's disposable session-state files. Never
// copy general User settings, databases, globalStorage, profiles or credentials.
// This runs after a failed Host exits and before the unchanged normal cleanup.
function preserveFailureDiagnostics() {
    const destination = process.env.DIFF_TRACKER_HOST_DIAGNOSTICS_DIR;
    if (process.env.DIFF_TRACKER_SCOPE_DIAGNOSTICS !== '1' || !destination) { return; }
    const output = path.resolve(destination);
    const relativeOutput = path.relative(tempRoot, output);
    if (!relativeOutput || !relativeOutput.startsWith(`..${path.sep}`) && relativeOutput !== '..' && !path.isAbsolute(relativeOutput)) {
        throw new Error('Host diagnostics must be outside the temporary Host root');
    }
    mkdirSync(output, { recursive: true });
    const sessionNames = new Set(['session-state.json', 'session-state.tmp.json',
        'session-state.last-good.json', 'session-state.unsaved']);
    const manifest = { platform: process.platform, node: process.version,
        requestedVscodeVersion: process.env.DIFF_TRACKER_VSCODE_VERSION || 'stable',
        copiedBytes: 0, files: [], skipped: [], skippedCount: 0 };
    const skipped = (relative, reason) => {
        manifest.skippedCount++;
        if (manifest.skipped.length < 64) { manifest.skipped.push({ path: relative.slice(0, 1024), reason }); }
    };
    const copyTree = (source, label, sessionOnly = false) => {
        if (!existsSync(source)) { return; }
        const pending = [{ absolute: source, relative: '', depth: 0 }];
        while (pending.length) {
            const entry = pending.pop();
            try {
                const stat = lstatSync(entry.absolute);
                if (stat.isSymbolicLink()) { skipped(`${label}/${entry.relative}`, 'symlink'); continue; }
                if (stat.isDirectory()) {
                    if (entry.depth >= 8) { skipped(`${label}/${entry.relative}`, 'depth-limit'); continue; }
                    for (const name of readdirSync(entry.absolute)) {
                        // workspaceStorage traversal is restricted to workspace IDs
                        // and the extension's own storage folder within each ID.
                        if (sessionOnly && entry.depth === 1 && name !== 'lengmh.code-diff-tracker') { continue; }
                        if (sessionOnly && entry.depth >= 2 && !sessionNames.has(name)) { continue; }
                        pending.push({ absolute: path.join(entry.absolute, name),
                            relative: path.join(entry.relative, name), depth: entry.depth + 1 });
                    }
                    continue;
                }
                if (!stat.isFile() || sessionOnly &&
                    (entry.depth !== 3 || !sessionNames.has(path.basename(entry.relative)))) { continue; }
                if (manifest.files.length >= 2048 || stat.size > 64 * 1024 * 1024 ||
                    manifest.copiedBytes + stat.size > 256 * 1024 * 1024) {
                    skipped(`${label}/${entry.relative}`, 'copy-limit'); continue;
                }
                const target = path.join(output, label, entry.relative);
                mkdirSync(path.dirname(target), { recursive: true });
                copyFileSync(entry.absolute, target);
                manifest.files.push({ path: path.join(label, entry.relative), bytes: stat.size });
                manifest.copiedBytes += stat.size;
            } catch (error) { skipped(`${label}/${entry.relative}`, String(error).slice(0, 1024)); }
        }
    };
    copyTree(path.join(userDataPath, 'logs'), 'main-logs');
    copyTree(path.join(nativeUserDataPath, 'logs'), 'native-logs');
    copyTree(path.join(userDataPath, 'User', 'workspaceStorage'), 'main-session-storage', true);
    copyTree(path.join(nativeUserDataPath, 'User', 'workspaceStorage'), 'native-session-storage', true);
    writeFileSync(path.join(output, 'preservation-manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(`Preserved failed Host diagnostics: ${manifest.files.length} files, ${manifest.copiedBytes} bytes; ${manifest.skippedCount} skipped`);
}

async function availableLoopbackPort() {
    const server = createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return port;
}

try {
    // VS Code 1.80 on Linux otherwise uses an OS-native context menu, which
    // cannot be inspected through the renderer. Select the real workbench's
    // custom menu at startup (these application settings require a restart).
    mkdirSync(path.join(nativeUserDataPath, 'User'), { recursive: true });
    writeFileSync(path.join(nativeUserDataPath, 'User', 'settings.json'), JSON.stringify({
        'window.titleBarStyle': 'custom',
        'window.menuStyle': 'custom'
    }));
    mkdirSync(workspacePath, { recursive: true });
    for (const [name, content] of [
        ['existing.txt', 'base\n'],
        ['virtual-baseline.txt', 'alpha\nbeta\nomega\n'],
        ['crlf.txt', 'one\r\ntwo\r\n'],
        ['deleted.txt', 'delete baseline\n'],
        ['batch-a.txt', 'batch a\n'],
        ['batch-b.txt', 'batch b\n'],
        ['native-a.txt', 'header\nalpha value=old\nseparator\nbeta value=old\nfooter\n'],
        ['native-b.txt', 'b header\nbeta value=old\nb footer\n'],
        ['audit-source.txt', 'base\n'],
        ['audit-target.txt', 'edit\n'],
        ['audit-recovery.txt', 'base\n'],
        ['node_modules/audit-ignored.txt', 'ignored dependency\n'],
        ['out/audit-ignored.txt', 'ignored output\n'],
        ['audit-parent-file/nested/child.txt', 'parent baseline\n'],
        ['audit-parent-batch/nested/child.txt', 'parent baseline\n']
    ]) {
        mkdirSync(path.dirname(path.join(workspacePath, name)), { recursive: true });
        writeFileSync(path.join(workspacePath, name), content);
        if (name === 'deleted.txt' && process.platform !== 'win32') { chmodSync(path.join(workspacePath, name), 0o755); }
    }
    mkdirSync(path.join(secondRoot, '.vscode'), { recursive: true });
    for (const folder of [workspacePath, secondRoot]) {
        for (const name of ['scope-files.txt', 'scope-watcher.txt', 'scope-search.txt']) {
            writeFileSync(path.join(folder, name), 'scope baseline\n');
        }
    }
    writeFileSync(path.join(secondRoot, '.vscode', 'settings.json'), JSON.stringify({
        'files.exclude': { 'scope-files.txt': true },
        'files.watcherExclude': {
            'scope-watcher.txt': true,
            'excluded-tree/**': true
        },
        'search.exclude': { 'scope-search.txt': true }
    }));
    writeFileSync(workspaceFile, JSON.stringify({ folders: [{ path: workspacePath }, { path: secondRoot }] }));
    git('init', '-b', 'main');
    git('config', 'user.email', 'diff-tracker@example.invalid');
    git('config', 'user.name', 'Diff Tracker Host Test');
    git('config', 'core.autocrlf', 'false');
    git('add', '.');
    git('commit', '-m', 'host baseline');

    // This resource belongs only to Native fallback acceptance, not to the
    // shared Git baseline or the later scope/recovery fixtures.
    const nativeOpaquePath = path.join(workspacePath, 'native-opaque.bin');
    writeFileSync(nativeOpaquePath, Buffer.from([0, 1, 2, 3]));

    // Test-only renderer access for actual Quick Diff menu clicks and Multi
    // Diff child focus. The helper runs with this Node, not the old Host's Node.
    // Nothing is registered in production or included in the VSIX.
    const cdpPort = await availableLoopbackPort();
    const hostOptions = {
        version: process.env.DIFF_TRACKER_VSCODE_VERSION || 'stable',
        extensionDevelopmentPath,
        extensionTestsPath,
        extensionTestsEnv: {
            DIFF_TRACKER_HOST_WORKSPACE: workspacePath,
            DIFF_TRACKER_HOST_SECOND_ROOT: secondRoot,
            DIFF_TRACKER_HOST_RESTART_STORAGE: restartStorage,
            DIFF_TRACKER_HOST_CDP_PORT: String(cdpPort),
            DIFF_TRACKER_HOST_NODE: process.execPath,
            DIFF_TRACKER_SCOPE_DIAGNOSTICS: process.env.DIFF_TRACKER_SCOPE_DIAGNOSTICS ?? ''
        },
        launchArgs: [
            workspaceFile,
            `--user-data-dir=${userDataPath}`,
            `--extensions-dir=${path.join(tempRoot, 'extensions')}`,
            '--remote-debugging-address=127.0.0.1',
            `--remote-debugging-port=${cdpPort}`,
            '--locale=en',
            '--disable-workspace-trust',
            '--skip-welcome',
            '--skip-release-notes'
        ]
    };
    // Native acceptance owns a distinct temporary session. Its cleanup restores
    // file bytes but must not rebuild through still-queued save/watcher events.
    // Await process exit before the original fresh prepare/restore pair starts.
    await runTests({
        ...hostOptions,
        launchArgs: hostOptions.launchArgs.map(argument => argument.startsWith('--user-data-dir=')
            ? `--user-data-dir=${nativeUserDataPath}` : argument),
        extensionTestsEnv: { ...hostOptions.extensionTestsEnv, DIFF_TRACKER_HOST_PHASE: 'native' }
    });
    assert.equal(readFileSync(path.join(workspacePath, 'native-a.txt'), 'utf8'),
        'header\nalpha value=old\nseparator\nbeta value=old\nfooter\n');
    assert.equal(readFileSync(path.join(workspacePath, 'native-b.txt'), 'utf8'),
        'b header\nbeta value=old\nb footer\n');
    assert.deepEqual(readFileSync(nativeOpaquePath), Buffer.from([0, 1, 2, 3]));
    rmSync(nativeOpaquePath);
    assert.equal(existsSync(nativeOpaquePath), false, 'Native-only opaque fixture must not enter the main Host');
    await runTests({
        ...hostOptions,
        extensionTestsEnv: { ...hostOptions.extensionTestsEnv, DIFF_TRACKER_HOST_PHASE: 'prepare' }
    });

    // runTests resolves only after the prepare VS Code process exits. Keep the
    // same workspace, user-data, extensions and dedicated session storage, and
    // make the offline edit here rather than from either Extension Host.
    const manifestPath = path.join(restartStorage, 'restart-fixture.json');
    const restart = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(restart.phase, 'prepared');
    assert.equal(path.resolve(restart.workspace), path.resolve(workspacePath));
    const offlineFile = path.join(workspacePath, 's4d-restart-owner', 'readme.txt');
    assert.equal(path.relative(offlineFile, restart.offlineFile), '',
        'the offline edit must target the known fixture, including Windows drive-letter normalization');
    assert.equal(readFileSync(offlineFile, 'utf8'), restart.baseline[0]);
    writeFileSync(offlineFile, restart.offlineContent);
    writeFileSync(manifestPath, JSON.stringify({ ...restart, phase: 'offline-edited' }));
    await runTests({
        ...hostOptions,
        extensionTestsEnv: { ...hostOptions.extensionTestsEnv, DIFF_TRACKER_HOST_PHASE: 'restore' }
    });
    assert.equal(existsSync(restartStorage), false, 'second Host must clean up restart fixture storage');
} catch (error) {
    console.error('Code Diff Tracker Extension Host tests failed.', error);
    process.exitCode = 1;
} finally {
    if (process.exitCode) {
        try { preserveFailureDiagnostics(); }
        catch (error) { console.warn('Unable to preserve failed Host diagnostics:', error); }
    }
    try { rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch (error) { console.warn(`Unable to remove host-test workspace ${tempRoot}:`, error); }
}
