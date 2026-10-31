// One fresh-process comparison after a full Host run. Never retries it.
import { runTests } from '@vscode/test-electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const selected = process.argv[2];
if (!['scope-settings', 'workspace-edit', 'deleted-coverage', 'lifecycle-diagnostics'].includes(selected)) { throw new Error('Select scope-settings, workspace-edit, deleted-coverage or lifecycle-diagnostics'); }
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'difftracker-host-isolation-'));
const workspace = path.join(temporary, 'workspace');
fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
fs.writeFileSync(path.join(workspace, 'ProbeName'), 'synthetic before-image');
fs.writeFileSync(path.join(workspace, 'watched.txt'), 'baseline\n');
for (const name of ['prior-cache', 'generated-cache', 'second-cache', 'quick-cache', 'saved-cache']) {
    fs.mkdirSync(path.join(workspace, name));
    fs.writeFileSync(path.join(workspace, name, 'existing.txt'), 'cache baseline\n');
}
fs.writeFileSync(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({
    'diffTracker.watchExclude': selected === 'scope-settings' ? [{ scope: 'all', pattern: '/prior-cache/' }] : [],
    ...(selected === 'lifecycle-diagnostics' ? {
        'diffTracker.monitoringScope':'rules',
        'diffTracker.watchInclude':[]
    } : {})
}));
try {
    console.log('HOST-LIFECYCLE isolated launch:', JSON.stringify({ scenario: selected, version: process.env.DIFF_TRACKER_VSCODE_VERSION || 'stable' }));
    await runTests({
        version: process.env.DIFF_TRACKER_VSCODE_VERSION || 'stable',
        vscodeExecutablePath: process.env.DIFF_TRACKER_VSCODE_EXECUTABLE,
        extensionDevelopmentPath: repository,
        extensionTestsPath: path.join(repository, 'test/host/suite/index.cjs'),
        extensionTestsEnv: { DIFF_TRACKER_HOST_WORKSPACE: workspace, DIFF_TRACKER_HOST_PHASE: selected,
            DIFF_TRACKER_HOST_DIAGNOSTIC: 'isolated' },
        launchArgs: [workspace, `--user-data-dir=${path.join(temporary, 'profile')}`,
            `--extensions-dir=${path.join(temporary, 'extensions')}`, '--locale=en', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes']
    });
} finally { fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
