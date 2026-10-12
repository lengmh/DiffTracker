import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise production callbacks unchanged; only extension-host boundaries and
// tracker results are stubbed. Token safety itself is covered by tracker tests.
const source = ts.createSourceFile('extension.ts', fs.readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const names = ['keepAllChanges', 'acceptFolderText', 'acceptFile', 'keepBlock', 'keepAllBlocksInFile'];
const callbacks = [];
const helpers = [];
function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'extractFilePath') helpers.push(node.getText(source));
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'folderReviews') helpers.push(`const ${node.getText(source)};`);
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'vscode.commands.registerCommand' &&
        names.some(name => node.arguments[0]?.text === `diffTracker.${name}`)) {
        callbacks.push(`${JSON.stringify(node.arguments[0].text)}: ${node.arguments[1].getText(source)}`);
    }
    ts.forEachChild(node, visit);
}
visit(source);
function harness({ cross = 1, mixed = false, cancel = false, onConfirm } = {}) {
    const token = { filePath: '/repo/file.txt', epoch: 1, baselineRevision: 'before', currentRevision: 'after', keepGitContextSignature: 'branch-b' };
    const tokens = [token];
    const opaque = mixed ? [{ filePath: '/repo/image.png', epoch: 1, reviewRevision: 'opaque' }] : [];
    const unknown = mixed ? ['/repo/unknown'] : [];
    const state = { prompts: [], calls: [] };
    const diffTracker = {
        getReviewTokens: () => tokens,
        getReviewToken: () => token,
        getOpaqueReviewTokens: () => opaque,
        getUnknownReviewPaths: () => unknown,
        getCrossBranchKeepCount: captured => { state.counted = captured; return cross; },
        keepAllChanges: async captured => { state.calls.push(captured); return { succeeded: captured.length, failed: 0 }; },
        acceptAllPendingChanges: async (...captured) => { state.calls.push(captured); return { accepted: captured[0].length }; },
        keepAllChangesInFile: async (...captured) => { state.calls.push(captured); return { status: 'success' }; },
        keepBlock: async (...captured) => { state.calls.push(captured); return { status: 'success' }; }
    };
    const sandbox = {
        diffTracker, displayFileName: value => value, missingReview: () => assert.fail('missing token'),
        reportBatch: (_label, value) => value, reportMixedBatch: (_label, value) => value, reportAction: value => value,
        vscode: { window: {
            showInformationMessage() {},
            showWarningMessage: async (message, options, ...buttons) => {
                state.prompts.push({ message, options, buttons });
                await onConfirm?.({ token, tokens, opaque, unknown });
                return cancel ? undefined : buttons[0];
            }
        } }
    };
    vm.runInNewContext(ts.transpileModule(`${helpers.join('\n')}globalThis.callbacks = {${callbacks.join(',')}};`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 }
    }).outputText, sandbox);
    return { token, tokens, state, run: (name, ...args) => sandbox.callbacks[`diffTracker.${name}`](...args) };
}
for (const mode of ['explicit', 'global', 'mixed', 'folder']) {
    const run = h => mode === 'folder'
        ? h.run('acceptFolderText', { reviewEntries: [{ filePath: h.token.filePath, reviewToken: h.token }] })
        : h.run('keepAllChanges', ...(mode === 'explicit' ? [h.tokens] : []));
    const h = harness({ mixed: mode === 'mixed', onConfirm: ({ token, tokens }) => {
        token.keepGitContextSignature = 'branch-c';
        token.currentRevision = 'newer';
        tokens.push({ ...token, filePath: '/repo/added-later.txt' });
    } });
    await run(h);
    assert.equal(h.state.prompts.length, 1, `${mode}: one confirmation`);
    assert.match(h.state.prompts[0].message, /1 eligible text file\(s\) across Git branches/);
    assert.match(h.state.prompts[0].options.detail, /Revert across branches remains blocked/);
    const captured = ['global', 'mixed'].includes(mode) ? h.state.calls[0][0] : h.state.calls[0];
    assert.equal(captured.length, 1, `${mode}: selection frozen before confirmation`);
    assert.equal(captured[0].currentRevision, 'after', `${mode}: stale review evidence retained`);
    assert.equal(captured[0].keepGitContextSignature, 'branch-b', `${mode}: Git context frozen before confirmation`);
    const cancelled = harness({ mixed: mode === 'mixed', cancel: true });
    await run(cancelled);
    assert.equal(cancelled.state.calls.length, 0, `${mode}: cancellation is non-mutating`);
}
for (const explicit of [false, true]) {
    const h = harness({ cross: 0 });
    await h.run('keepAllChanges', ...(explicit ? [h.tokens] : []));
    assert.equal(h.state.prompts.length, 0, 'same-branch text-only Keep remains frictionless');
}
for (const command of ['keepBlock', 'keepAllBlocksInFile', 'acceptFile']) {
    const h = harness();
    await h.run(command, h.token.filePath, ...(command === 'keepBlock' ? ['block-id', h.token] : [h.token]));
    assert.equal(h.state.prompts.length, command === 'acceptFile' ? 1 : 0, `${command}: no additional branch modal`);
    assert.equal(h.state.calls.length, 1);
}
console.log('PASS branch Keep UI: explicit/global/mixed/folder confirmation, cancellation, frozen tokens, same-branch and file/block modal behavior');

// The activation installs a live provider, rather than retaining the initial
// snapshots or treating an unavailable monitor as an empty repository set.
let providerInstall;
let gitEventHandler;
function findGitWiring(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'diffTracker.setGitContextProvider') providerInstall = node.getText(source);
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'handleGitContextEvent') gitEventHandler = node.getText(source);
    ts.forEachChild(node, findGitWiring);
}
findGitWiring(source);
assert.ok(providerInstall);
const providerSandbox = { diffTracker: { setGitContextProvider: provider => { providerSandbox.provider = provider; } }, gitContextMonitor: undefined };
vm.runInNewContext(ts.transpileModule(providerInstall, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, providerSandbox);
assert.equal(providerSandbox.provider(), undefined);
let ready = false;
let snapshots = [{ headName: 'branch-b' }];
providerSandbox.gitContextMonitor = { isReady: () => ready, getVerifiedSnapshots: () => snapshots };
assert.equal(providerSandbox.provider(), undefined);
ready = true;
assert.equal(providerSandbox.provider(), snapshots);
snapshots = [{ headName: 'branch-c' }];
assert.equal(providerSandbox.provider(), snapshots);
ready = false;
assert.equal(providerSandbox.provider(), undefined, 'invalidated monitor does not yield authoritative snapshots');

for (const [reason, count, expected] of [
    ['Git branch changed from main to feature; review actions for this repository are paused', 1, /Verified text Keep \/ Accept can remain available/],
    ['Git branch changed from main to feature; review actions for this repository are paused', 0, /Verified text Keep \/ Accept can remain available/],
    ['Git operation is in progress or its metadata cannot be verified', 1, /Keep \/ Accept and Revert remain blocked/],
    ['Git changed between a named branch and detached HEAD', 1, /Keep \/ Accept and Revert remain blocked/]
]) {
    const prompts = [];
    const sandbox = {
        path: { sep: '/' }, runningExtensionTests: false,
        gitPromptInFlight: new Set(), gitPromptShown: new Map(), persistGitPromptShown() {},
        diffTracker: {
            observeGitContext: () => reason,
            getReviewTokens: () => [{ filePath: '/repo/file.txt' }, { filePath: '/another/file.txt' }],
            getCrossBranchKeepCount: tokens => { assert.equal(tokens.length, 1); return count; }
        },
        vscode: { window: { showWarningMessage: async (...args) => { prompts.push(args); } } }
    };
    vm.runInNewContext(ts.transpileModule(`const ${gitEventHandler}; globalThis.handle = handleGitContextEvent;`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 }
    }).outputText, sandbox);
    await sandbox.handle({ kind: 'changed', context: { repoRoot: '/repo' } });
    assert.equal(prompts.length, 1);
    if (reason.startsWith('Git branch changed from ')) {
        assert.match(prompts[0][0], /Revert and other workspace-writing actions remain blocked/);
        assert.doesNotMatch(prompts[0][0], /review actions.*paused/);
    } else {
        assert.equal(prompts[0][0], `Code Diff Tracker: ${reason}`);
    }
    assert.match(prompts[0][1].detail, expected);
    assert.match(prompts[0][1].detail, /Revert remain[s]? blocked/);
}
console.log('PASS branch Keep UI: live monitor provider and eligible/unsafe Git alert copy');
