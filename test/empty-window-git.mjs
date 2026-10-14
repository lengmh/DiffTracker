import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { createLegacyEffectiveScope, validateAndCanonicalizeScope } from '../out/monitoringScope.js';

// Execute production command/event wiring with the real tracker. Only UI and
// Git discovery are mocked; this is not an installed VS Code host test.
const source = ts.createSourceFile('extension.ts', fs.readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const declarations = new Map();
function visit(node) {
    if (ts.isVariableDeclaration(node)) declarations.set(node.name.getText(source), node.getText(source));
    ts.forEachChild(node, visit);
}
visit(source);
function wiring(tracker, vscode, snapshot) {
    const prompts = [];
    const sandbox = {
        diffTracker: tracker, runningExtensionTests: false, restoreOutcome: 'restored',
        gitPromptInFlight: new Set(), gitPromptShown: new Map(), persistGitPromptShown() {},
        refreshReview() {}, recordingRequest: 0,
        gitContextMonitor: { getSnapshot: () => snapshot },
        vscode: { ...vscode, window: {
            showWarningMessage: async (...args) => { prompts.push(args); return args[1]?.modal ? 'Archive and Rebuild' : undefined; },
            showInformationMessage() {}
        } }
    };
    const names = ['rebuildGitBaseline', 'handleGitContextEvent', 'startRecordingFlow'];
    vm.runInNewContext(ts.transpileModule(names.map(name => `const ${declarations.get(name)}; globalThis.${name} = ${name};`).join('\n'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022 }
    }).outputText, sandbox);
    return { ...sandbox, prompts };
}

export function registerEmptyWindowGit(h) {
    const { test, vscode, Uri, DiffTracker, file, seed, scan, getTracker, setTracker, setListedFiles } = h;
    const context = repoRoot => ({ repoRoot, kind: 'repository', headName: 'main', headCommit: 'a'.repeat(40), detached: false, inProgress: false });
    for (const scope of ['legacy', 'configured']) {
        for (const recording of [true, false]) {
            test(`EMPTY-WINDOW persisted zero-root ${scope} recording=${recording} restores stopped across reloads`, async () => {
                const previousFolders = vscode.workspace.workspaceFolders;
                const storage = file(`empty-saved-${scope}-${recording}`);
                fs.mkdirSync(storage);
                const configured = validateAndCanonicalizeScope({ mode: 'rules', includes: [], excludes: [] }, []);
                assert.equal(configured.ok, true);
                const state = {
                    version: 4, isRecording: recording, baselineState: 'ready', workspaceRoots: [],
                    fileSnapshots: [], fileModes: [], baselineExistingFiles: [], unresolvedBaselineFiles: [],
                    opaqueBaselineFiles: [], revertHistory: [], gitContexts: [],
                    effectiveMonitoringScope: scope === 'legacy' ? createLegacyEffectiveScope([], [])
                        : { kind: 'configured', ...configured.scope },
                    retainedReviewPaths: [], coverageGaps: [], legacyWatchExcludeByRoot: []
                };
                fs.writeFileSync(path.join(storage, 'session-state.json'), JSON.stringify(state));
                vscode.workspace.workspaceFolders = [];
                try {
                    for (let reload = 0; reload < 2; reload++) {
                        await getTracker().dispose();
                        const tracker = new DiffTracker(Uri.file(storage)); setTracker(tracker);
                        assert.equal(await tracker.restorePersistedState(), 'restored');
                        assert.equal(tracker.getIsRecording(), false);
                        assert.equal(tracker.externalWatcherEnabled, false);
                        assert.equal(await tracker.flushPendingPersistence(), true);
                        assert.equal(JSON.parse(fs.readFileSync(path.join(storage, 'session-state.json'))).isRecording, false);
                    }
                } finally { vscode.workspace.workspaceFolders = previousFolders; }
            });
        }
    }
    for (const state of ['fresh', 'reopened', 'restored']) {
        test(`EMPTY-WINDOW ${state} ignores Git events and stays quiet before recording`, async () => {
            const tracker = getTracker(), previousFolders = vscode.workspace.workspaceFolders;
            const ctx = context(file('empty-window-repository'));
            tracker.isRecording = false;
            tracker.snapshotInitialized = state === 'restored';
            if (state === 'restored') tracker.baselineGitContexts.set(ctx.repoRoot, ctx);
            const before = [...tracker.baselineGitContexts];
            vscode.workspace.workspaceFolders = state === 'fresh' ? undefined : [];
            try {
                const ui = wiring(tracker, vscode, ctx);
                assert.equal(await ui.startRecordingFlow(), false);
                assert.equal(tracker.startRecording(), false);
                for (let i = 0; i < 3; i++) {
                    await ui.handleGitContextEvent({ kind: 'changed', context: ctx });
                    await ui.handleGitContextEvent({ kind: 'changed', context: context(`${ctx.repoRoot}-${i}`) });
                }
                await ui.handleGitContextEvent({ kind: 'removed', repoRoot: ctx.repoRoot });
                await ui.handleGitContextEvent({ kind: 'ready', contexts: [] });
                assert.equal(ui.prompts.length, 0);
                assert.deepEqual(tracker.getPausedGitRepositories(), []);
                assert.deepEqual([...tracker.baselineGitContexts], before, 'existing review identity is preserved');
                tracker.setBaselineGitContexts([ctx]);
                assert.equal(tracker.baselineGitContexts.size, 0, 'fresh baselines do not import loose-file repositories');
            } finally { vscode.workspace.workspaceFolders = previousFolders; }
        });
    }
    test('EMPTY-WINDOW unrelated sibling repository is ignored; parent and nested repositories remain guarded', async () => {
        const tracker = getTracker(), previousFolders = vscode.workspace.workspaceFolders;
        const root = file('git-scope');
        vscode.workspace.workspaceFolders = [{ uri: Uri.file(path.join(root, 'workspace')) }];
        try {
            const sibling = context(path.join(root, 'workspace-other'));
            const parent = context(root);
            const nested = context(path.join(root, 'workspace', 'nested'));
            tracker.setBaselineGitContexts([sibling, parent]);
            assert.deepEqual([...tracker.baselineGitContexts.keys()], [root]);
            assert.equal(tracker.observeGitContext(sibling), undefined);
            assert.match(tracker.observeGitContext(nested), /appeared after/);
            assert.match(tracker.observeGitContext({ ...parent, headName: 'feature' }), /branch changed/);
            assert.equal(tracker.getPausedGitRepositories().length, 2);
        } finally { vscode.workspace.workspaceFolders = previousFolders; }
    });
    for (const rebuildSucceeds of [false, true]) {
        test(`EMPTY-WINDOW relevant repository repeated events do not loop after rebuild (success=${rebuildSucceeds})`, async () => {
            const tracker = getTracker();
            const repo = file(`git-rebuild-${rebuildSucceeds}`); fs.mkdirSync(repo);
            const target = path.join(repo, 'file.txt'); seed(target, 'before\n', 'after\n'); await scan(target);
            const ctx = context(repo);
            setListedFiles([Uri.file(target)]);
            tracker.storageUri = Uri.file(file(`git-rebuild-storage-${rebuildSucceeds}`));
            tracker.setGitContextProvider(() => [ctx]);
            if (!rebuildSucceeds) tracker.gitContextPending = true;
            const ui = wiring(tracker, vscode, ctx);
            await ui.handleGitContextEvent({ kind: 'changed', context: ctx });
            for (let i = 0; i < 3; i++) await ui.handleGitContextEvent({ kind: 'changed', context: ctx });
            assert.equal(ui.prompts.filter(args => args[1]?.modal).length, 1);
            assert.equal(tracker.getPausedGitRepositories().length, rebuildSucceeds ? 0 : 1);
            assert.equal(fs.readFileSync(target, 'utf8'), 'after\n');
            if (rebuildSucceeds) assert.equal(tracker.getOriginalContent(target), 'after\n');
            else assert.equal(tracker.getOriginalContent(target), 'before\n');
        });
    }
}
