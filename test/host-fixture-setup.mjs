import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import Module, { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const helperPath = require.resolve('./host/suite/s4d-whole-workspace.test.cjs');
const watcherPattern = 's4d-whole-workspace/watcher-excluded/**';

// Exercise the actual Host helper against real files and Git. Only VS Code's
// configuration/command boundary is modeled; no fixture logic is copied here.
async function withFixture(run) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'difftracker-host-setup-'));
    const workspacePath = path.join(root, 'primary');
    const secondRoot = path.join(root, 'second');
    fs.mkdirSync(path.join(workspacePath, 's4d-whole-workspace', 'watcher-excluded'), { recursive: true });
    fs.mkdirSync(secondRoot);
    execFileSync('git', ['init', '--quiet'], { cwd: workspacePath });
    const primaryFolder = { uri: { fsPath: workspacePath } };
    let primary = { [watcherPattern]: true };
    let secondary = {};
    let inherited = {};
    let isRecording = false;
    const updates = [];
    const delays = [];
    const vscode = {
        Uri: { file: filePath => ({ fsPath: filePath }) },
        ConfigurationTarget: { WorkspaceFolder: 3 },
        workspace: {
            textDocuments: [],
            getConfiguration(section, uri) {
                assert.equal(section, 'files');
                const isPrimary = uri.fsPath === workspacePath;
                assert.ok(isPrimary || uri.fsPath === secondRoot);
                return {
                    inspect(key) {
                        assert.equal(key, 'watcherExclude');
                        return { workspaceFolderValue: isPrimary ? primary : secondary };
                    },
                    get(key) {
                        assert.equal(key, 'watcherExclude');
                        return { ...inherited, ...(isPrimary ? primary : secondary) };
                    },
                    async update(key, value, target) {
                        updates.push({ key, value, target, isPrimary });
                        if (isPrimary) { primary = value; } else { secondary = value; }
                    }
                };
            }
        },
        commands: { executeCommand() { throw new Error('Setup must not invoke tracker commands'); } }
    };
    const originalLoad = Module._load;
    let prepare;
    try {
        Module._load = function (id, ...args) {
            return id === 'vscode' ? vscode : originalLoad.call(this, id, ...args);
        };
        delete require.cache[helperPath];
        prepare = require(helperPath);
    } finally { Module._load = originalLoad; }
    try {
        await run({
            prepare: () => prepare({
                workspacePath, secondRoot, primaryFolder,
                state: async () => ({ isRecording }),
                delay: async milliseconds => delays.push(milliseconds),
                untilStable: () => { throw new Error('Setup must not inspect outcome stability'); }
            }),
            workspacePath, updates, delays,
            get primary() { return primary; },
            set primary(value) { primary = value; },
            set secondary(value) { secondary = value; },
            set inherited(value) { inherited = value; },
            set isRecording(value) { isRecording = value; }
        });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('S4 fixture preparation verifies preseeded folder settings without a live configuration write', async () => {
    await withFixture(async fixture => {
        await fixture.prepare();
        assert.deepEqual(fixture.updates, [], 'preparation must not queue a settings save in the main Host');
        assert.deepEqual(fixture.delays, [500], 'preserve the existing fixture settling interval');
    });
});

test('S4 cleanup removes only its owned exclusion and preserves current unrelated folder entries', async () => {
    await withFixture(async fixture => {
        fixture.primary = { [watcherPattern]: true, 'unrelated/**': true };
        const proof = await fixture.prepare();
        fixture.primary = { [watcherPattern]: true, 'unrelated/**': false, 'added-later/**': true };
        await proof.restoreWatcherExclude();
        assert.deepEqual(fixture.primary, { 'unrelated/**': false, 'added-later/**': true });
        assert.deepEqual(fixture.updates, [{
            key: 'watcherExclude', value: { 'unrelated/**': false, 'added-later/**': true },
            target: 3, isPrimary: true
        }]);
    });
});

test('S4 setup refuses a missing offline watcher target rather than creating it in the Host', async () => {
    await withFixture(async fixture => {
        const target = path.join(fixture.workspacePath, 's4d-whole-workspace', 'watcher-excluded');
        fs.rmSync(target, { recursive: true });
        await assert.rejects(fixture.prepare, /launcher must preseed.*directory/i);
        assert.equal(fs.existsSync(target), false);
        assert.deepEqual(fixture.updates, []);
    });
});

test('S4 setup refuses to mutate its fixtures while recording', async () => {
    await withFixture(async fixture => {
        fixture.isRecording = true;
        await assert.rejects(fixture.prepare, /prepare.*only while stopped/i);
        assert.equal(fs.existsSync(path.join(fixture.workspacePath, 's4d-whole-workspace', 'normal')), false);
        assert.deepEqual(fixture.updates, []);
    });
});

for (const [name, value] of [['missing', undefined], ['disabled', { [watcherPattern]: false }]]) {
    test(`S4 setup rejects ${name} folder settings even when the effective value is inherited`, async () => {
        await withFixture(async fixture => {
            fixture.primary = value;
            fixture.inherited = { [watcherPattern]: true };
            await assert.rejects(fixture.prepare, /preseed.*primary folder level/i);
            assert.deepEqual(fixture.updates, [], 'no fallback configuration write is allowed');
        });
    });
}

test('S4 setup preserves the second-root exclusion isolation check', async () => {
    await withFixture(async fixture => {
        fixture.secondary = { [watcherPattern]: true };
        await assert.rejects(fixture.prepare, /must not introduce a missing target in the second root/i);
        assert.deepEqual(fixture.updates, []);
    });
});

test('S4 repeated preparation fails its original fixture precondition without rewriting settings', async () => {
    await withFixture(async fixture => {
        await fixture.prepare();
        await assert.rejects(fixture.prepare, /fixture must start absent/);
        assert.deepEqual(fixture.updates, []);
    });
});

test('S4 stopped cleanup removes the folder setting when no unrelated exclusions remain', async () => {
    await withFixture(async fixture => {
        const proof = await fixture.prepare();
        fixture.isRecording = true;
        await assert.rejects(() => proof.restoreWatcherExclude(), /only while stopped/);
        assert.deepEqual(fixture.updates, []);
        fixture.isRecording = false;
        await proof.restoreWatcherExclude();
        assert.equal(fixture.primary, undefined);
        assert.deepEqual(fixture.updates, [{ key: 'watcherExclude', value: undefined, target: 3, isPrimary: true }]);
    });
});

test('S4 settings are seeded after Native exits and restores its files, before the prepare Host launches', () => {
    // Load the unchanged launcher with only its external runTests boundary
    // replaced. No VS Code process starts, and no source text is rewritten.
    const asModule = source => `data:text/javascript,${encodeURIComponent(source)}`;
    const hostBoundary = asModule(`
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import path from 'node:path';
        export async function runTests(options) {
            const env = options.extensionTestsEnv;
            const workspace = env.DIFF_TRACKER_HOST_WORKSPACE;
            const settings = path.join(workspace, '.vscode', 'settings.json');
            const target = path.join(workspace, 's4d-whole-workspace', 'watcher-excluded');
            const storage = env.DIFF_TRACKER_HOST_RESTART_STORAGE;
            const offlineFile = path.join(workspace, 's4d-restart-owner', 'readme.txt');
            const phase = env.DIFF_TRACKER_HOST_PHASE;
            if (phase === 'native') {
                assert.equal(fs.existsSync(settings), false, 'do not alter the earlier Native fixture');
                assert.equal(fs.existsSync(target), false, 'do not alter the earlier Native fixture');
                assert.equal(fs.existsSync(path.join(workspace, 'native-opaque.bin')), true);
                await new Promise(resolve => setImmediate(resolve));
                assert.equal(fs.existsSync(settings), false, 'wait for Native exit before seeding settings');
                assert.equal(fs.existsSync(target), false, 'wait for Native exit before seeding the target');
                assert.equal(fs.existsSync(path.join(workspace, 'native-opaque.bin')), true,
                    'wait for Native exit before removing its fixture');
            } else if (phase === 'prepare') {
                assert.equal(fs.existsSync(path.join(workspace, 'native-opaque.bin')), false,
                    'Native fixture cleanup must finish first');
                assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), {
                    'files.watcherExclude': { 's4d-whole-workspace/watcher-excluded/**': true }
                }, 'final settings must already exist before the prepare Host');
                assert.equal(fs.statSync(target).isDirectory(), true);
                const secondSettings = JSON.parse(fs.readFileSync(
                    path.join(env.DIFF_TRACKER_HOST_SECOND_ROOT, '.vscode', 'settings.json'), 'utf8'));
                assert.equal(secondSettings['files.watcherExclude']['s4d-whole-workspace/watcher-excluded/**'], undefined);
                fs.mkdirSync(storage, { recursive: true });
                fs.mkdirSync(path.dirname(offlineFile), { recursive: true });
                fs.writeFileSync(offlineFile, 'restart baseline');
                fs.writeFileSync(path.join(storage, 'restart-fixture.json'), JSON.stringify({
                    phase: 'prepared', workspace, offlineFile, baseline: ['restart baseline'], offlineContent: 'offline edit'
                }));
            } else {
                assert.equal(phase, 'restore');
                assert.equal(fs.readFileSync(offlineFile, 'utf8'), 'offline edit');
                fs.rmSync(storage, { recursive: true });
            }
            console.log('FIXTURE-PHASE ' + phase);
        }
    `);
    const loader = asModule(`
        export async function resolve(specifier, context, nextResolve) {
            return specifier === '@vscode/test-electron'
                ? { url: ${JSON.stringify(hostBoundary)}, shortCircuit: true }
                : nextResolve(specifier, context);
        }
    `);
    const preload = asModule(`import { register } from 'node:module'; register(${JSON.stringify(loader)});`);
    const result = spawnSync(process.execPath, ['--import', preload, fileURLToPath(new URL('./host/run.mjs', import.meta.url))], {
        encoding: 'utf8', timeout: 15000
    });
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
    assert.deepEqual(result.stdout.match(/FIXTURE-PHASE \w+/g), [
        'FIXTURE-PHASE native', 'FIXTURE-PHASE prepare', 'FIXTURE-PHASE restore'
    ]);
});
