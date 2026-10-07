import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
        ['native-opaque.bin', Buffer.from([0, 1, 2, 3])],
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
            DIFF_TRACKER_HOST_NODE: process.execPath
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
    try { rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch (error) { console.warn(`Unable to remove host-test workspace ${tempRoot}:`, error); }
}
