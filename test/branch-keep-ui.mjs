import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise production callbacks unchanged; only extension-host boundaries and
// tracker results are stubbed. Token safety itself is covered by tracker tests.
const source = ts.createSourceFile('extension.ts', fs.readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const names = ['keepAllChanges', 'acceptFolderText', 'acceptFile', 'keepBlock', 'keepAllBlocksInFile',
    'acknowledgeOpaqueChange', 'acknowledgeFolderOpaque', 'resetUnknownBaseline', 'acknowledgeLargeFileReminder'];
const callbacks = [];
const helpers = [];
function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'extractFilePath') helpers.push(node.getText(source));
    if (ts.isVariableDeclaration(node) && ['folderReviews', 'reportAction', 'missingReview'].includes(node.name.getText(source))) {
        helpers.push(`const ${node.getText(source)};`);
    }
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'vscode.commands.registerCommand' &&
        names.some(name => node.arguments[0]?.text === `diffTracker.${name}`)) {
        callbacks.push(`${JSON.stringify(node.arguments[0].text)}: ${node.arguments[1].getText(source)}`);
    }
    ts.forEachChild(node, visit);
}
visit(source);
function harness({ cross = 1, mixed = false, cancel = false, onConfirm, result, gate } = {}) {
    const token = { filePath: '/repo/file.txt', epoch: 1, baselineRevision: 'before', currentRevision: 'after', keepGitContextSignature: 'branch-b' };
    const tokens = [token];
    const opaqueToken = { filePath: '/repo/image.png', epoch: 1, reviewRevision: 'opaque' };
    const unknownToken = { filePath: '/repo/unknown', epoch: 1, reviewRevision: 'unknown' };
    const reminderToken = { filePath: '/repo/large.bin', epoch: 1, reviewRevision: 'metadata-reminder' };
    const opaque = mixed ? [opaqueToken] : [];
    const unknown = mixed ? ['/repo/unknown'] : [];
    const state = { prompts: [], calls: [], operations: [], warnings: [], info: [], reads: [], refreshes: 0 };
    const action = name => async (...captured) => {
        state.operations.push(name);
        state.calls.push(captured);
        await gate;
        return result ?? { filePath: captured[0], status: 'success' };
    };
    const diffTracker = {
        getReviewTokens: () => tokens,
        getReviewToken: () => { state.reads.push('text'); return token; },
        getOpaqueReviewToken: () => { state.reads.push('opaque'); return opaqueToken; },
        getUnknownReviewToken: () => { state.reads.push('unknown'); return unknownToken; },
        getLargeFileReminderToken: () => { state.reads.push('reminder'); return reminderToken; },
        getOpaqueReviewTokens: () => opaque,
        getUnknownReviewPaths: () => unknown,
        getCrossBranchKeepCount: captured => { state.counted = captured; return cross; },
        keepAllChanges: async captured => { state.calls.push(captured); return { succeeded: captured.length, failed: 0 }; },
        acceptAllPendingChanges: async (...captured) => { state.calls.push(captured); return { accepted: captured[0].length }; },
        keepAllChangesInFile: action('keepAllChangesInFile'),
        keepBlock: action('keepBlock'),
        acknowledgeOpaqueChange: action('acknowledgeOpaqueChange'),
        resetUnknownBaseline: action('resetUnknownBaseline'),
        acknowledgeLargeFileReminder: action('acknowledgeLargeFileReminder')
    };
    const sandbox = {
        diffTracker, displayFileName: value => value, refreshReview: () => { state.refreshes++; },
        reportBatch: (_label, value) => value, reportMixedBatch: (_label, value) => value,
        vscode: { Uri: class {}, window: {
            showInformationMessage: message => { state.info.push(message); },
            showWarningMessage: async (message, options, ...buttons) => {
                if (!options?.modal) { state.warnings.push(message); return; }
                state.prompts.push({ message, options, buttons });
                await onConfirm?.({ token, tokens, opaque, unknown, unknownToken });
                return cancel ? undefined : buttons[0];
            }
        } }
    };
    vm.runInNewContext(ts.transpileModule(`${helpers.join('\n')}globalThis.callbacks = {${callbacks.join(',')}};`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 }
    }).outputText, sandbox);
    return { token, tokens, opaqueToken, unknownToken, reminderToken, state, run: (name, ...args) => sandbox.callbacks[`diffTracker.${name}`](...args) };
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
    if (mode === 'mixed') {
        assert.equal(h.state.calls[0].length, 3, 'mixed acceptance passes only the three review categories, without single-file permissions');
    }
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
    assert.equal(h.state.prompts.length, 0, `${command}: single-file Keep completes without a modal`);
    assert.equal(h.state.calls.length, 1);
    assert.deepEqual(h.state.info, []);
    assert.deepEqual(h.state.warnings, []);
    assert.equal(h.state.refreshes, 1);
}
console.log('PASS branch Keep UI: explicit/global/mixed/folder confirmation, cancellation, frozen tokens, same-branch and file/block modal behavior');

for (const [command, tokenKey, itemKey, kind] of [
    ['acceptFile', 'token', 'reviewToken', 'text'],
    ['acknowledgeOpaqueChange', 'opaqueToken', 'opaqueReviewToken', 'opaque']
]) for (const route of ['tree', 'explicit', 'path']) {
    const h = harness({ cross: 0 });
    const token = h[tokenKey];
    const args = route === 'tree' ? [{ filePath: token.filePath, [itemKey]: token }]
        : route === 'explicit' ? [token.filePath, token] : [token.filePath];
    const result = await h.run(command, ...args);
    assert.equal(result.status, 'success');
    assert.equal(h.state.calls.length, 1, `${command}/${route}: act only on the selected file`);
    assert.equal(h.state.calls[0][0], token.filePath);
    assert.equal(h.state.calls[0][1], token);
    if (command === 'acknowledgeOpaqueChange') {
        assert.deepEqual(JSON.parse(JSON.stringify(h.state.calls[0][2])), { allowCrossBranch: true },
            `${route}: only an explicit single-file acknowledgement enables guarded cross-branch acceptance`);
        assert.equal(h.state.calls[0].length, 3);
    } else {
        assert.equal(h.state.calls[0].length, 2, 'text acceptance retains its existing tracker contract');
    }
    assert.deepEqual(h.state.reads, route === 'path' ? [kind] : [], 'only path-only commands capture a current token');
    assert.equal(h.state.prompts.length, 0, `${command}/${route}: ordinary single-file action completes without a modal`);
    assert.deepEqual(h.state.info, [], `${route}: no success toast`);
    assert.deepEqual(h.state.warnings, []);
    assert.equal(h.state.refreshes, 1);
}
console.log('PASS single-file Accept/Acknowledge: tree, explicit-token and path routes refresh without modal or success toast');

for (const command of ['acceptFile', 'acknowledgeOpaqueChange', 'keepAllBlocksInFile', 'keepBlock']) {
    for (const status of ['conflict', 'failed']) {
        const result = { filePath: '/repo/selected', status, reason: 'Approved identity changed; pending review retained' };
        const h = harness({ result });
        const token = command === 'acknowledgeOpaqueChange' ? { ...h.opaqueToken, reviewRevision: 'stale' }
            : { ...h.token, currentRevision: 'stale' };
        const args = command === 'keepBlock' ? [token.filePath, 'block-id', token] : [token.filePath, token];
        assert.equal(await h.run(command, ...args), result, `${command}: preserve the tracker failure result`);
        assert.equal(h.state.calls.length, 1, 'a conflict cannot retry against the latest review');
        assert.equal(h.state.calls[0].at(command === 'keepBlock' ? 2 : 1), token);
        if (command === 'acknowledgeOpaqueChange') {
            assert.equal(h.state.calls[0][2]?.allowCrossBranch, true,
                'cross-branch permission still preserves the original failing review token');
        }
        assert.deepEqual(h.state.reads, [], 'never replace an explicitly selected stale token');
        assert.deepEqual(h.state.warnings, [`${result.filePath}: ${result.reason}`]);
        assert.equal(h.state.refreshes, 1);
        assert.deepEqual(h.state.prompts, [], 'conflict/failure warning is nonmodal');
        assert.deepEqual(h.state.info, []);
    }
}
for (const command of ['acceptFile', 'acknowledgeOpaqueChange']) {
    const h = harness();
    const result = await h.run(command, { filePath: '/repo/selected' });
    assert.equal(result.status, 'conflict');
    assert.match(h.state.warnings[0], /Review version is unavailable/);
    assert.deepEqual(h.state.calls, []);
    assert.deepEqual(h.state.reads, [], 'an unversioned tree selection is not a path-only request');
    assert.deepEqual(h.state.prompts, []);
}
console.log('PASS single-file failures: nonmodal concrete reasons, refresh, original tokens, and no retry/recapture');

for (const [command, tokenKey] of [['acceptFile', 'token'], ['acknowledgeOpaqueChange', 'opaqueToken'],
    ['acknowledgeLargeFileReminder', 'reminderToken']]) {
    let release;
    const h = harness({ gate: new Promise(resolve => { release = resolve; }) });
    const token = h[tokenKey];
    let finished = false;
    const pending = h.run(command, token.filePath, token).then(value => { finished = true; return value; });
    await Promise.resolve();
    assert.equal(h.state.calls.length, 1);
    assert.equal(finished, false, 'wait for the guarded transaction result');
    assert.equal(h.state.refreshes, 0, 'do not show a pending transaction as complete');
    assert.deepEqual(h.state.prompts, []);
    assert.deepEqual(h.state.info, []);
    release();
    assert.equal((await pending).status, 'success');
    assert.equal(h.state.refreshes, 1);
}
console.log('PASS single-file actions await completion before refreshing');

for (const cancel of [false, true]) {
    const h = harness({ cancel, onConfirm: ({ unknownToken }) => { unknownToken.reviewRevision = 'newer'; } });
    const selected = { ...h.unknownToken };
    await h.run('resetUnknownBaseline', { filePath: selected.filePath, unknownReviewToken: selected });
    assert.equal(h.state.prompts.length, 1, 'Unknown Reset remains an explicit independent operation');
    assert.match(h.state.prompts[0].message, /Reset the unknown baseline/);
    assert.equal(h.state.calls.length, cancel ? 0 : 1);
    if (!cancel) {
        assert.deepEqual(h.state.operations, ['resetUnknownBaseline']);
        assert.equal(h.state.calls[0].length, 2, 'Unknown Reset retains its strict tracker contract');
        assert.equal(h.state.calls[0][1], selected, 'confirmation never recaptures a newer Unknown review');
        assert.equal(selected.reviewRevision, 'unknown');
    }
    assert.deepEqual(h.state.reads, []);
}
for (const command of ['acceptFolderText', 'acknowledgeFolderOpaque']) for (const cancel of [false, true]) {
    const h = harness({ cross: 0, cancel });
    const token = command === 'acceptFolderText' ? h.token : h.opaqueToken;
    const itemKey = command === 'acceptFolderText' ? 'reviewToken' : 'opaqueReviewToken';
    await h.run(command, { reviewEntries: [{ filePath: token.filePath, [itemKey]: token }] });
    assert.equal(h.state.prompts.length, 1, 'even a one-file folder selection retains its confirmation');
    assert.equal(h.state.calls.length, cancel ? 0 : 1);
    if (!cancel && command === 'acknowledgeFolderOpaque') {
        assert.equal(h.state.calls[0].length, 2, 'folder acknowledgement cannot opt into single-file permissions');
    }
}
console.log('PASS Unknown Reset and one-file folder selections retain confirmation and cancellation semantics');

for (const route of ['tree', 'explicit', 'path']) {
    for (const status of ['success', 'conflict', 'failed']) {
        const result = { filePath: '/repo/large.bin', status, reason: status === 'success' ? undefined : 'Reminder changed; prior review retained' };
        const h = harness({ result });
        const args = route === 'tree' ? [{ filePath: result.filePath, largeFileReminderToken: h.reminderToken }]
            : route === 'explicit' ? [result.filePath, h.reminderToken] : [result.filePath];
        assert.equal(await h.run('acknowledgeLargeFileReminder', ...args), result);
        assert.deepEqual(h.state.operations, ['acknowledgeLargeFileReminder'], 'never dispatch through baseline acceptance/reset');
        assert.equal(h.state.calls.length, 1);
        assert.equal(h.state.calls[0].length, 2);
        assert.equal(h.state.calls[0][1], h.reminderToken);
        assert.deepEqual(h.state.reads, route === 'path' ? ['reminder'] : []);
        assert.equal(h.state.refreshes, 1);
        assert.deepEqual(h.state.prompts, []);
        assert.deepEqual(h.state.info, [], 'no reminder success notification');
        assert.deepEqual(h.state.warnings, status === 'success' ? [] : [`${result.filePath}: ${result.reason}`]);
    }
}
{
    const h = harness();
    const result = await h.run('acknowledgeLargeFileReminder', { filePath: '/repo/large.bin' });
    assert.equal(result.status, 'conflict');
    assert.deepEqual(h.state.calls, []);
    assert.deepEqual(h.state.reads, [], 'an acknowledged or stale row cannot recapture a new reminder');
}
console.log('PASS large-file reminder command: independent token-bound dismissal, no baseline action or routine popup');

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
