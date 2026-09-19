import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const extensionDevelopmentPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const extensionTestsPath = path.join(extensionDevelopmentPath, 'test', 'host', 'suite', 'index.cjs');
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'diff-tracker-host-'));
const workspacePath = path.join(tempRoot, 'workspace 中文');
const secondRoot = path.join(tempRoot, 'second root');
const workspaceFile = path.join(tempRoot, 'host.code-workspace');
const git = (...args) => execFileSync('git', args, {
    cwd: workspacePath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
});

try {
    mkdirSync(workspacePath, { recursive: true });
    for (const [name, content] of [
        ['existing.txt', 'base\n'],
        ['virtual-baseline.txt', 'alpha\nbeta\nomega\n'],
        ['crlf.txt', 'one\r\ntwo\r\n'],
        ['deleted.txt', 'delete baseline\n'],
        ['batch-a.txt', 'batch a\n'],
        ['batch-b.txt', 'batch b\n'],
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
        'files.watcherExclude': { 'scope-watcher.txt': true },
        'search.exclude': { 'scope-search.txt': true }
    }));
    writeFileSync(workspaceFile, JSON.stringify({ folders: [{ path: workspacePath }, { path: secondRoot }] }));
    git('init', '-b', 'main');
    git('config', 'user.email', 'diff-tracker@example.invalid');
    git('config', 'user.name', 'Diff Tracker Host Test');
    git('config', 'core.autocrlf', 'false');
    git('add', '.');
    git('commit', '-m', 'host baseline');

    await runTests({
        version: process.env.DIFF_TRACKER_VSCODE_VERSION || 'stable',
        extensionDevelopmentPath,
        extensionTestsPath,
        extensionTestsEnv: {
            DIFF_TRACKER_HOST_WORKSPACE: workspacePath,
            DIFF_TRACKER_HOST_SECOND_ROOT: secondRoot
        },
        launchArgs: [
            workspaceFile,
            `--user-data-dir=${path.join(tempRoot, 'user-data')}`,
            `--extensions-dir=${path.join(tempRoot, 'extensions')}`,
            '--disable-workspace-trust',
            '--skip-welcome',
            '--skip-release-notes'
        ]
    });
} catch (error) {
    console.error('Code Diff Tracker Extension Host tests failed.', error);
    process.exitCode = 1;
} finally {
    try { rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch (error) { console.warn(`Unable to remove host-test workspace ${tempRoot}:`, error); }
}
