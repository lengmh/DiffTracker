const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const vscode = require('vscode');

const A = 'native-a.txt', B = 'native-b.txt';
const BASE_A = 'header\nalpha value=old\nseparator\nbeta value=old\nfooter\n';
const BASE_B = 'b header\nbeta value=old\nb footer\n';
const CURRENT_A = 'header\nalpha value=NEW\nseparator\nbeta value=NEW\nfooter\n';
const CURRENT_B = 'b header\nbeta value=NEW\nb footer\n';
const KEPT_A = 'header\nalpha value=NEW\nseparator\nbeta value=old\nfooter\n';
const CURRENT_SCHEME = 'diff-tracker-review-current';
const BASE_SCHEME = 'diff-tracker-review-base';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

// All projections and writes go through production commands and stable VS Code
// APIs. The two existing test commands below observe backend state only. Native
// Quick Diff payloads are supplied by its actual rendered toolbar, never here.
module.exports = async function nativeReviewCheckpoint() {
    const deadline = Date.now() + 75_000;
    const workspacePath = process.env.DIFF_TRACKER_HOST_WORKSPACE;
    assert.ok(workspacePath, 'the disposable Host workspace is required');
    const extension = vscode.extensions.getExtension('lengmh.code-diff-tracker');
    assert.ok(extension, 'the production development extension is required');
    await extension.activate();
    const extensionPath = extension.extensionPath;
    const uri = name => vscode.Uri.file(path.join(workspacePath, name));
    const read = name => fs.readFileSync(uri(name).fsPath, 'utf8');
    const write = (name, content) => fs.writeFileSync(uri(name).fsPath, content);
    const state = () => vscode.commands.executeCommand('diffTracker._testState');
    const original = name => vscode.commands.executeCommand('diffTracker._testOriginalContent', uri(name).fsPath);
    const run = (command, ...args) => vscode.commands.executeCommand(`diffTracker.nativeReview.${command}`, ...args);
    const config = vscode.workspace.getConfiguration('diffTracker');
    const previousQuickDiff = config.inspect('nativeQuickDiff')?.workspaceValue;
    const until = async (description, predicate, timeout = 10_000) => {
        const end = Math.min(deadline, Date.now() + timeout);
        while (Date.now() < end) {
            const result = await predicate();
            if (result) { return result; }
            await delay(100);
        }
        throw new Error(`Native Review Host timed out: ${description}`);
    };
    const ui = async (operation, argument) => {
        assert.ok(process.env.DIFF_TRACKER_HOST_NODE, 'launcher Node path is required');
        assert.ok(process.env.DIFF_TRACKER_HOST_CDP_PORT, 'loopback renderer port is required');
        const args = [path.join(extensionPath, 'test', 'host', 'native-ui-driver.mjs'),
            process.env.DIFF_TRACKER_HOST_CDP_PORT, operation];
        if (argument) { args.push(argument); }
        try {
            const { stdout } = await promisify(execFile)(process.env.DIFF_TRACKER_HOST_NODE, args, {
                timeout: Math.max(1, Math.min(25_000, deadline - Date.now())), maxBuffer: 1024 * 1024
            });
            return JSON.parse(stdout);
        } catch (error) {
            throw new Error(`Native UI ${operation} failed: ${error.message}\n${error.stderr || ''}`);
        }
    };
    const review = async (name, content) => until(`reviewable ${name}`, async () => {
        const current = await state();
        const change = current.trackedChanges.find(item => item.filePath === uri(name).fsPath);
        const token = current.reviewTokens.find(item => item.filePath === uri(name).fsPath);
        return current.baselineState === 'ready' && change && !change.unavailableReason && token &&
            (content === undefined || change.currentContent === content) ? { change, token } : undefined;
    });
    const cleared = name => until(`${name} review cleared`, async () =>
        !(await state()).trackedChanges.some(item => item.filePath === uri(name).fsPath));
    const active = name => until(`focused current snapshot for ${name}`, () => {
        const editor = vscode.window.activeTextEditor;
        return editor?.document.uri.scheme === CURRENT_SCHEME && editor.document.uri.fsPath === uri(name).fsPath
            ? editor : undefined;
    });
    const activeEvidence = () => {
        const editor = vscode.window.activeTextEditor;
        return editor ? { uri: editor.document.uri.toString(), viewColumn: editor.viewColumn,
            selections: editor.selections.map(selection => ({
                start: [selection.start.line, selection.start.character],
                end: [selection.end.line, selection.end.character]
            })) } : null;
    };
    const focusMulti = async (name, token) => {
        const before = activeEvidence();
        let physical;
        try {
            physical = await ui('focus-multi-diff', name);
            assert.equal(physical.clicked, true);
            const editor = await active(name);
            assert.deepEqual(JSON.parse(editor.document.uri.query), token);
            console.log('Native Review physical focus evidence:', JSON.stringify({
                name, before, after: activeEvidence(), domFocusObserved: physical.domFocusObserved,
                target: physical.before.focusTarget
            }));
            return editor;
        } catch (error) {
            console.error('Native Review physical focus failure:', JSON.stringify({
                name, before, after: activeEvidence(), physical
            }));
            throw error;
        }
    };
    const open = async name => {
        assert.deepEqual(await run('openFile', uri(name)), { mode: 'single-diff', count: 1 });
        return active(name);
    };
    const selectLine = (editor, line, start = 0) => {
        editor.selection = new vscode.Selection(line, start, line, editor.document.lineAt(line).text.length);
    };
    const conflict = async (command, context) => {
        const result = await run(command, context);
        assert.equal(result?.status, 'conflict', `${command}: ${JSON.stringify(result)}`);
    };
    const saveRealDocument = async (name, expected) => {
        const document = await vscode.workspace.openTextDocument(uri(name));
        assert.equal(document.getText(), expected);
        assert.equal(await document.save(), true);
        assert.equal(read(name), expected);
        return document;
    };
    await until('initial Ready baseline', async () => (await state()).baselineState === 'ready');
    const initial = await state();
    assert.equal(initial.isRecording, true);
    assert.equal(initial.trackedChanges.length, 0, 'checkpoint must run before other scenarios create reviews');
    const windowConfig = vscode.workspace.getConfiguration('window');
    assert.equal(windowConfig.get('titleBarStyle'), 'custom', 'disposable Host must load its custom-menu fixture');
    if (!/^1\.80\./.test(vscode.version)) {
        assert.equal(windowConfig.get('menuStyle'), 'custom', 'Stable must load its custom-menu fixture');
    }
    console.log('Native Review menu fixture:', JSON.stringify({ version: vscode.version,
        titleBarStyle: windowConfig.get('titleBarStyle'), menuStyle: windowConfig.get('menuStyle') }));
    assert.equal(config.get('nativeQuickDiff'), false, 'native Quick Diff is opt-in');
    assert.equal(await original(A), BASE_A);
    assert.equal(await original(B), BASE_B);

    let scenarioFailure;
    try {
        await config.update('nativeQuickDiff', true, vscode.ConfigurationTarget.Workspace);
        assert.equal(vscode.workspace.getConfiguration('diffTracker').get('nativeQuickDiff'), true);
        write(A, CURRENT_A); write(B, CURRENT_B);
        const firstA = await review(A, CURRENT_A), firstB = await review(B, CURRENT_B);
        const fileEditor = await vscode.window.showTextDocument(uri(A));
        selectLine(fileEditor, 1);
        await until('real Quick Diff widget', async () => {
            await vscode.commands.executeCommand('editor.action.dirtydiff.next');
            return (await ui('quick-diff-state')).state.quickDiff.length === 1;
        });
        const clicked = await ui('click-quick-diff');
        assert.equal(clicked.clicked, true);
        assert.equal(clicked.provider, 'Code Diff Tracker Review');
        assert.ok(clicked.before.quickDiff[0].actions.some(action =>
            action.enabled && action.label.includes('Open Native Review Snapshot')));
        let editor = await active(A);
        const firstUri = editor.document.uri;
        const diffInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        assert.ok(diffInput instanceof vscode.TabInputTextDiff, 'real menu must open a native Diff tab');
        assert.equal(diffInput.original.scheme, BASE_SCHEME);
        assert.equal(diffInput.modified.toString(), firstUri.toString());
        assert.equal(diffInput.original.query, firstUri.query);
        assert.deepEqual(JSON.parse(firstUri.query), firstA.token);
        assert.equal((await vscode.workspace.openTextDocument(diffInput.original)).getText(), BASE_A);
        assert.equal(editor.document.getText(), CURRENT_A);
        assert.equal(editor.selection.isEmpty, true, 'Quick Diff hunk coordinates are not action authorization');
        assert.deepEqual([editor.selection.start.line, editor.selection.start.character], [0, 0]);
        assert.deepEqual((await review(A, CURRENT_A)).token, firstA.token);
        assert.equal(read(A), CURRENT_A);
        assert.equal(await original(A), BASE_A);
        console.log('PASS HOST-NATIVE real Quick Diff menu opens a fresh immutable snapshot with no implicit selection/action');

        await conflict('keepSelectedBlock', firstUri); // empty selection
        for (const command of ['keepFile', 'revertFile', 'keepSelectedBlock', 'revertSelectedBlock']) {
            await conflict(command); // active editor alone is insufficient
        }
        selectLine(editor, 1, 1);
        await conflict('keepSelectedBlock', firstUri); // partial line
        const baselineEditor = await vscode.window.showTextDocument(diffInput.original);
        selectLine(baselineEditor, 1);
        await conflict('revertSelectedBlock', baselineEditor.document.uri);
        assert.deepEqual((await review(A, CURRENT_A)).token, firstA.token);
        assert.equal(await original(A), BASE_A);
        console.log('PASS HOST-NATIVE empty/partial selections, missing context and baseline-side actions refuse without mutation');

        editor = await open(A);
        const duplicate = await vscode.window.showTextDocument(editor.document, {
            viewColumn: vscode.ViewColumn.Beside, preview: false
        });
        await until('same snapshot visible in two editor groups', () => vscode.window.visibleTextEditors
            .filter(candidate => candidate.document.uri.toString() === firstUri.toString()).length > 1);
        selectLine(duplicate, 1);
        await conflict('keepSelectedBlock', duplicate.document.uri);
        assert.equal(await original(A), BASE_A);
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await vscode.commands.executeCommand('notifications.clearAll');
        console.log('PASS HOST-NATIVE duplicate visible snapshot instances refuse selection ambiguity');

        const supportsMulti = (await vscode.commands.getCommands(true)).includes('vscode.changes');
        assert.equal(supportsMulti, !/^1\.80\./.test(vscode.version),
            'the declared matrix must exercise real Multi Diff on Stable and its absence on VS Code 1.80');
        const opening = run('openChanges');
        let otherUri;
        if (supportsMulti) {
            assert.deepEqual(await opening, { mode: 'multi-diff', count: 2 });
            const rendered = await until('two rendered Multi Diff entries', async () => {
                const probe = (await ui('multi-diff-state')).state;
                return [A, B].every(name => probe.multiDiff.some(entry => entry.names.includes(name))) ? probe : undefined;
            });
            assert.equal(rendered.multiDiffRoots, 1);
            otherUri = (await focusMulti(B, firstB.token)).document.uri;
            editor = await focusMulti(A, firstA.token);
            console.log('PASS HOST-NATIVE real two-file Multi Diff renders both snapshots and exposes the physically focused modified child');
        } else {
            const picked = await ui('pick-native-file', A);
            assert.equal(picked.clicked, true);
            assert.equal(picked.selectedLabel, A);
            assert.deepEqual(await opening, { mode: 'single-diff-fallback', count: 2 });
            assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff);
            assert.equal((await ui('multi-diff-state')).state.multiDiffRoots, 0);
            otherUri = (await open(B)).document.uri;
            editor = await open(A);
            console.log('PASS HOST-NATIVE minimum Host uses the real file picker and native single-Diff fallback');
        }
        selectLine(editor, 1);
        await conflict('keepSelectedBlock', otherUri);
        assert.deepEqual((await review(B, CURRENT_B)).token, firstB.token);
        assert.equal(await original(A), BASE_A);
        console.log('PASS HOST-NATIVE another resource context cannot authorize the focused snapshot');

        const beforeKeepUri = editor.document.uri;
        const keptThroughMenu = await ui('click-native-action', 'Keep Selected Whole Block');
        assert.equal(keptThroughMenu.clicked, true);
        assert.ok(keptThroughMenu.before.contextMenus.some(menu => menu.some(action =>
            action.enabled && action.label === 'Keep Selected Whole Block')));
        await until('real editor/context Keep to commit its reviewed block', async () => (await original(A)) === KEPT_A);
        assert.equal(await original(A), KEPT_A);
        assert.equal((await review(A, CURRENT_A)).change.originalContent, KEPT_A);
        assert.equal(editor.document.getText(), CURRENT_A, 'Keep cannot rewrite the immutable displayed snapshot');
        assert.equal(read(B), CURRENT_B);
        await conflict('keepSelectedBlock', beforeKeepUri);
        console.log('PASS HOST-NATIVE real editor/context full-block Keep receives the snapshot URI, changes only that block and refuses the old review afterward');

        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        editor = await open(A);
        selectLine(editor, 3);
        const revertedBlock = await run('revertSelectedBlock', editor.document.uri);
        assert.equal(revertedBlock.status, 'success', revertedBlock.reason);
        const realA = await vscode.workspace.openTextDocument(uri(A));
        assert.equal(realA.isDirty, true, 'block Revert retains the established buffer-only contract');
        assert.equal(realA.getText(), KEPT_A);
        assert.equal(read(A), CURRENT_A, 'block Revert cannot silently save');
        await saveRealDocument(A, KEPT_A);
        await cleared(A);
        console.log('PASS HOST-NATIVE full-block Revert edits the actual buffer and persists only after explicit save');

        editor = await open(B);
        const keptFile = await run('keepFile', editor.document.uri);
        assert.equal(keptFile.status, 'success', keptFile.reason);
        await cleared(B);
        assert.equal(await original(B), CURRENT_B);
        console.log('PASS HOST-NATIVE reviewed-file Keep delegates to the authoritative backend');

        write(B, 'b header\nb footer\n');
        await review(B, 'b header\nb footer\n');
        editor = await open(B);
        selectLine(editor, 1);
        await conflict('revertSelectedBlock', editor.document.uri);
        assert.equal(read(B), 'b header\nb footer\n');
        const revertedDeletion = await run('revertFile', editor.document.uri);
        assert.equal(revertedDeletion.status, 'success', revertedDeletion.reason);
        assert.equal(read(B), CURRENT_B);
        await cleared(B);
        fs.unlinkSync(uri(B).fsPath);
        const missingReview = await review(B, '');
        assert.equal(missingReview.change.isDeleted, true);
        editor = await open(B);
        assert.equal(editor.document.getText(), '');
        const restoredDeletion = await run('revertFile', editor.document.uri);
        assert.equal(restoredDeletion.status, 'success', restoredDeletion.reason);
        assert.equal(read(B), CURRENT_B);
        await cleared(B);
        console.log('PASS HOST-NATIVE deleted-line selections refuse; reviewed-file Revert restores line and file deletion');

        const earlier = KEPT_A.replace('beta value=old', 'beta value=NOW');
        const later = KEPT_A.replace('beta value=old', 'beta value=NXT');
        write(A, earlier); await review(A, earlier);
        editor = await open(A);
        const staleUri = editor.document.uri;
        selectLine(editor, 3);
        write(A, later);
        await review(A, later);
        await conflict('keepSelectedBlock', staleUri);
        assert.equal(editor.document.getText(), earlier, 'external edits cannot refresh an old URI in place');
        assert.equal(read(A), later);
        assert.equal(await original(A), KEPT_A);
        console.log('PASS HOST-NATIVE same-coordinate external replacement invalidates the old snapshot');

        const workingA = await vscode.workspace.openTextDocument(uri(A));
        await vscode.window.showTextDocument(workingA, { preview: false });
        editor = await open(A);
        const beforeDirtyUri = editor.document.uri;
        await until('working document reload before dirty edit', () => workingA.getText() === later && !workingA.isDirty);
        const dirtyEdit = new vscode.WorkspaceEdit();
        dirtyEdit.replace(uri(A), new vscode.Range(3, 0, 3, workingA.lineAt(3).text.length), 'beta value=DIRTY');
        assert.equal(await vscode.workspace.applyEdit(dirtyEdit), true);
        assert.equal(workingA.isDirty, true);
        await conflict('keepFile', beforeDirtyUri);
        assert.equal(read(A), later);
        assert.equal(workingA.lineAt(3).text, 'beta value=DIRTY');
        assert.equal(await original(A), KEPT_A);
        // Restore only the test edit, then explicitly save it before further UI
        // actions or cleanup. This is not a backend mutation/test injection.
        const undoDirty = new vscode.WorkspaceEdit();
        undoDirty.replace(uri(A), new vscode.Range(3, 0, 3, workingA.lineAt(3).text.length), 'beta value=NXT');
        assert.equal(await vscode.workspace.applyEdit(undoDirty), true);
        await saveRealDocument(A, later);
        await review(A, later);
        console.log('PASS HOST-NATIVE dirty real working documents block snapshot writes and preserve both disk and buffer');

        editor = await open(A);
        await vscode.commands.executeCommand('diffTracker.stopRecording');
        await conflict('keepFile', editor.document.uri);
        assert.equal((await state()).isRecording, false);
        assert.equal(read(A), later);
        assert.equal(await original(A), KEPT_A);
        console.log('PASS HOST-NATIVE session transition invalidates previously reviewed snapshots');
    } catch (error) {
        scenarioFailure = error;
        // Cleanup must never replace the first failed acceptance assertion or
        // hide the renderer's diagnostics (especially on the minimum Host).
        console.error('Native Review primary scenario failure:', error.stack || error);
        try {
            const failedState = await state();
            console.error('Native Review state before cleanup:', JSON.stringify({
                activeEditor: activeEvidence(), isRecording: failedState.isRecording,
                baselineState: failedState.baselineState, reviewTokens: failedState.reviewTokens,
                fixtureReviews: failedState.trackedChanges.filter(change =>
                    [uri(A).fsPath, uri(B).fsPath].includes(change.filePath)),
                originalA: (await original(A)) ?? null, originalB: (await original(B)) ?? null
            }));
        } catch (diagnosticError) {
            console.error('Native Review pre-cleanup diagnostics failed:', diagnosticError.stack || diagnosticError);
        }
        throw error;
    } finally {
        try {
            // This phase owns a separate user-data/session. Restore the physical
            // fixtures, then exit while stopped. The launcher waits for process
            // exit before starting the main suite's untouched fresh profile.
            await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
            await vscode.commands.executeCommand('diffTracker.stopRecording');
            for (const [name, content] of [[A, BASE_A], [B, BASE_B]]) {
                const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.scheme === 'file' &&
                    candidate.uri.fsPath === uri(name).fsPath && !candidate.isClosed);
                if (document) {
                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(uri(name), new vscode.Range(0, 0, document.lineCount, 0), content);
                    assert.equal(await vscode.workspace.applyEdit(edit), true);
                    assert.equal(await document.save(), true);
                } else { write(name, content); }
                assert.equal(read(name), content);
            }
            await config.update('nativeQuickDiff', previousQuickDiff, vscode.ConfigurationTarget.Workspace);
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
            await vscode.commands.executeCommand('notifications.clearAll');
            assert.equal((await state()).isRecording, false, 'isolated Native phase must exit while stopped');
            assert.equal(read(A), BASE_A);
            assert.equal(read(B), BASE_B);
            assert.equal(vscode.workspace.textDocuments.some(document => document.uri.scheme === 'file' &&
                [uri(A).fsPath, uri(B).fsPath].includes(document.uri.fsPath) && document.isDirty), false);
            assert.equal(vscode.workspace.getConfiguration('diffTracker').get('nativeQuickDiff'), false);
        } catch (cleanupError) {
            console.error('Native Review cleanup failure:', cleanupError.stack || cleanupError);
            try {
                const cleanupState = await state();
                console.error('Native Review cleanup state:', JSON.stringify({
                    isRecording: cleanupState.isRecording, baselineState: cleanupState.baselineState,
                    reviewTokens: cleanupState.reviewTokens, coverageGaps: cleanupState.coverageGaps,
                    subtreeCoverageGaps: cleanupState.subtreeCoverageGaps,
                    unknownReviewPaths: cleanupState.unknownReviewPaths,
                    fixtureReviews: cleanupState.trackedChanges.filter(change =>
                        [uri(A).fsPath, uri(B).fsPath].includes(change.filePath)).map(change => ({
                        filePath: change.filePath, kind: change.reviewKind, reason: change.reviewReason,
                        unavailableReason: change.unavailableReason
                    })),
                    originalA: (await original(A)) ?? null, originalB: (await original(B)) ?? null
                }));
            } catch (diagnosticError) {
                console.error('Native Review cleanup diagnostics failed:', diagnosticError.stack || diagnosticError);
            }
            if (!scenarioFailure) { throw cleanupError; }
        }
    }
};
