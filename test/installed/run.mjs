// Bounded Ubuntu Stable installed-extension acceptance. Not a release workflow.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';
import { ROOT, ID, CANDIDATE_VERSION, RELEASE, hash, verifyVsix } from './artifacts.mjs';

assert.equal(process.platform, 'linux', 'this bounded checkpoint intentionally targets Ubuntu Stable only');
assert.ok(process.argv[2], 'usage: node test/installed/run.mjs <artifact-directory>');
const artifactRoot = path.resolve(process.argv[2]);
const candidate = path.join(artifactRoot, 'DO-NOT-PUBLISH-code-diff-tracker-0.8.0-internal.vsix');
const released = path.join(artifactRoot, RELEASE.assetName);
assert.equal(hash(readFileSync(released)), RELEASE.sha256);
const packages = {
    candidate: { file: candidate, ...verifyVsix(candidate, CANDIDATE_VERSION) },
    released: { file: released, ...verifyVsix(released, '0.7.2') }
};
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'difftracker-installed-rc-'));
const results = [];
const profiles = [];
const legacyRules = ['**/legacy-*.txt', '!**/legacy-reincluded.txt'];
const baseFiles = {
    'pending.txt': 'accepted pending baseline\n',
    'watched.txt': 'accepted watcher baseline\n',
    'offline.txt': 'accepted offline baseline\n',
    'legacy-excluded.txt': 'excluded baseline\n',
    'legacy-reincluded.txt': 'accepted legacy exception\n'
};

async function freePort() {
    const server = createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

function profile(name, legacy) {
    const root = path.join(tempRoot, name);
    const workspace = path.join(root, 'workspace 中文');
    const userData = path.join(root, 'user-data');
    const extensions = path.join(root, 'extensions');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(path.join(userData, 'User'), { recursive: true });
    mkdirSync(extensions);
    for (const [name, content] of Object.entries(baseFiles)) { writeFileSync(path.join(workspace, name), content); }
    if (!legacy) { writeFileSync(path.join(workspace, 'opaque.bin'), Buffer.from([0, 12, 24, 36])); }
    const settings = {
        'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false,
        'update.mode': 'none', 'window.restoreWindows': 'none',
        'workbench.startupEditor': 'none', 'workbench.enableExperiments': false,
        ...(legacy ? { 'diffTracker.watchExclude': legacyRules } : {})
    };
    const settingsPath = path.join(userData, 'User', 'settings.json');
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    const git = (...args) => execFileSync('git', args, { cwd: workspace, stdio: 'pipe' });
    git('init', '-b', 'main');
    git('config', 'user.name', 'Installed RC fixture');
    git('config', 'user.email', 'installed-rc@example.invalid');
    git('add', '.');
    git('commit', '-m', 'fixture baseline');
    const result = { root, workspace, userData, extensions, settingsPath, legacy };
    profiles.push(result);
    return result;
}

let succeeded = false;
try {
    const executable = await downloadAndUnzipVSCode('stable');
    const [cli, ...cliPrefix] = resolveCliArgsFromVSCodeExecutablePath(executable, { reuseMachineInstall: true });
    const cliArgs = fixture => [...cliPrefix, '--no-sandbox', `--user-data-dir=${fixture.userData}`, `--extensions-dir=${fixture.extensions}`];
    const install = (fixture, kind) => {
        const pkg = packages[kind];
        execFileSync(cli, [...cliArgs(fixture), '--install-extension', pkg.file, '--force'],
            { stdio: 'inherit', timeout: 90_000 });
        const installed = execFileSync(cli, [...cliArgs(fixture), '--list-extensions', '--show-versions'],
            { encoding: 'utf8', timeout: 45_000 });
        assert.ok(installed.split(/\r?\n/).includes(`${ID}@${pkg.manifest.version}`), installed);
    };
    const phase = async (fixture, name, kind) => {
        const beforeSettings = readFileSync(fixture.settingsPath);
        const port = await freePort();
        const report = path.join(artifactRoot, `${name}.json`);
        await runTests({
            vscodeExecutablePath: executable,
            // NEVER the product checkout: this unrelated driver owns test mode.
            extensionDevelopmentPath: path.join(ROOT, 'test/installed/driver'),
            extensionTestsPath: path.join(ROOT, 'test/installed/suite.cjs'),
            extensionTestsEnv: {
                DT_INSTALLED_PHASE: name, DT_INSTALLED_ROOT: fixture.root,
                DT_INSTALLED_WORKSPACE: fixture.workspace, DT_INSTALLED_EXTENSIONS: fixture.extensions,
                DT_INSTALLED_VERSION: packages[kind].manifest.version,
                DT_INSTALLED_ENTRY_HASH: packages[kind].entryHash,
                DT_INSTALLED_REPORT: report, DT_INSTALLED_PORT: String(port),
                DT_INSTALLED_NODE: process.execPath, DT_INSTALLED_LEGACY: fixture.legacy ? '1' : '0'
            },
            launchArgs: [fixture.workspace, `--user-data-dir=${fixture.userData}`, `--extensions-dir=${fixture.extensions}`,
                '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`,
                '--locale=en', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes']
        });
        assert.deepEqual(readFileSync(fixture.settingsPath), beforeSettings, 'activation must not migrate/rewrite Global rules');
        assert.equal(existsSync(path.join(fixture.workspace, '.vscode/settings.json')), false,
            'no automatic structured-scope migration may write Workspace settings');
        const evidence = JSON.parse(readFileSync(report, 'utf8'));
        assert.equal(evidence.phase, name);
        assert.equal(evidence.status, 'passed');
        // Product shutdown is part of the boundary, not a direct dispose call.
        const state = JSON.parse(readFileSync(evidence.statePath, 'utf8'));
        assert.equal(state.isRecording, evidence.recording);
        assert.equal(state.version, kind === 'released' ? 3 : 4);
        if (kind === 'candidate') {
            assert.equal(state.effectiveMonitoringScope.kind, fixture.legacy ? 'legacyV3' : 'configured');
            if (!fixture.legacy) { assert.equal(state.effectiveMonitoringScope.mode, 'rules'); }
        }
        assert.equal(existsSync(path.join(path.dirname(evidence.statePath), 'session-state.unsaved')), false);
        results.push(evidence);
    };

    const fresh = profile('first-install', false);
    install(fresh, 'candidate');
    await phase(fresh, 'candidate-first-install', 'candidate');
    writeFileSync(path.join(fresh.workspace, 'offline.txt'), 'offline edit between actual Hosts\n');
    await phase(fresh, 'candidate-recording-reload', 'candidate');
    await phase(fresh, 'candidate-stopped-reload', 'candidate');

    const upgrade = profile('released-upgrade', true);
    install(upgrade, 'released');
    await phase(upgrade, 'released-prepare', 'released');
    const beforeUpgrade = JSON.parse(readFileSync(path.join(artifactRoot, 'released-prepare.json'), 'utf8'));
    const originalSession = readFileSync(beforeUpgrade.statePath);
    assert.equal(JSON.parse(originalSession).version, 3, 'upgrade starts with an actual released V3 session');
    writeFileSync(path.join(artifactRoot, 'released-session-before-upgrade.json'), originalSession);
    install(upgrade, 'candidate');
    assert.deepEqual(readFileSync(beforeUpgrade.statePath), originalSession, 'install must preserve the existing session');
    writeFileSync(path.join(upgrade.workspace, 'offline.txt'), 'offline edit between actual Hosts\n');
    await phase(upgrade, 'candidate-upgrade', 'candidate');
    assert.equal(results.at(-1).statePath, beforeUpgrade.statePath, 'same extension ID must retain actual workspace storage');
    const upgraded = JSON.parse(readFileSync(beforeUpgrade.statePath, 'utf8'));
    assert.deepEqual(upgraded.fileSnapshots, JSON.parse(originalSession).fileSnapshots,
        'V3→V4 upgrade must preserve every accepted text before-image');
    assert.equal(upgraded.effectiveMonitoringScope.kind, 'legacyV3', 'schema migration is not user-authorized scope migration');
    succeeded = true;
    console.log('PASS HOST-INSTALLED-RC: first install, recording/stopped activation recovery, released 0.7.2 upgrade');
} finally {
    writeFileSync(path.join(artifactRoot, 'installed-summary.json'), JSON.stringify({
        warning: 'INTERNAL TEST EVIDENCE. DO NOT PUBLISH THE STAGED VSIX.',
        status: succeeded ? 'passed' : 'failed', results,
        boundaries: 'Ubuntu Stable only. Real second VS Code process and installed product activation; not a Reload Window menu test. Existing three development Host jobs retain their independent coverage.'
    }, null, 2));
    for (const fixture of profiles) {
        const logs = path.join(fixture.userData, 'logs');
        if (existsSync(logs)) {
            cpSync(logs, path.join(artifactRoot, `${path.basename(fixture.root)}-host-logs`), { recursive: true });
        }
    }
    // Keep failure profiles only in this disposable runner for diagnostics.
    if (succeeded) { rmSync(tempRoot, { recursive: true, force: true }); }
    else { console.error(`Disposable failed Host profiles/logs: ${tempRoot}`); }
}
