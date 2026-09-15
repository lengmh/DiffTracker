const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const vscode = require('vscode');

const workspacePath = process.env.DIFF_TRACKER_HOST_WORKSPACE;
const uri = name => vscode.Uri.file(path.join(workspacePath, name));
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const until = async (description, predicate, timeout = 30_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const value = await predicate();
        if (value) { return value; }
        await delay(100);
    }
    throw new Error(`Timed out waiting for ${description}`);
};
const untilStable = async (description, predicate, stableMilliseconds = 750, timeout = 30_000) => {
    const deadline = Date.now() + timeout;
    let stableSince;
    let stableValue;
    while (Date.now() < deadline) {
        const value = await predicate();
        if (value) {
            stableValue = value;
            stableSince ??= Date.now();
            if (Date.now() - stableSince >= stableMilliseconds) { return stableValue; }
        } else {
            stableSince = undefined;
            stableValue = undefined;
        }
        await delay(100);
    }
    throw new Error(`Timed out waiting for stable ${description}`);
};
const state = () => vscode.commands.executeCommand('diffTracker._testState');
const pending = async name => (await state()).trackedChanges.find(item => item.filePath === uri(name).fsPath);
const reviewablePending = async name => {
    const current = await state();
    const filePath = uri(name).fsPath;
    const change = current.trackedChanges.find(item => item.filePath === filePath);
    return change && !change.unavailableReason && current.reviewTokens.some(token => token.filePath === filePath)
        ? change
        : undefined;
};
const read = async name => new TextDecoder().decode(await vscode.workspace.fs.readFile(uri(name)));
const write = (name, content) => vscode.workspace.fs.writeFile(uri(name), new TextEncoder().encode(content));
const missing = async name => {
    try { await vscode.workspace.fs.stat(uri(name)); return false; }
    catch (error) { return error instanceof vscode.FileSystemError; }
};

module.exports = async function runExtensionHostScenario() {
        assert.ok(workspacePath, 'host workspace environment is required');
        const extension = vscode.extensions.getExtension('lengmh.diff-tracker');
        assert.ok(extension, 'development extension is installed');
        await extension.activate();
        await until('Ready baseline', async () => (await state())?.baselineState === 'ready');
        assert.equal((await state()).isRecording, true);

        // Whole-file WorkspaceEdit/save participates in native editor Undo/Redo.
        await write('existing.txt', 'whole changed\n');
        await untilStable('whole-file pending review', () => pending('existing.txt'));
        const wholeRevert = await vscode.commands.executeCommand('diffTracker._testRevertFile', uri('existing.txt').fsPath);
        assert.equal(wholeRevert.status, 'success', wholeRevert.reason);
        assert.equal(await read('existing.txt'), 'base\n');
        const existingDocument = await vscode.workspace.openTextDocument(uri('existing.txt'));
        await vscode.window.showTextDocument(existingDocument);
        await vscode.commands.executeCommand('undo');
        await until('native whole-file Undo', () => existingDocument.getText() === 'whole changed\n');
        await untilStable('review refresh after native whole-file Undo', () => pending('existing.txt'));
        const recoveryAfterNativeUndo = await vscode.commands.executeCommand('diffTracker._testUndoLastRevert');
        assert.equal(recoveryAfterNativeUndo.succeeded, 1, 'native Undo is recognized without a second inverse edit');
        assert.equal(existingDocument.getText(), 'whole changed\n');
        await vscode.commands.executeCommand('redo');
        await until('native whole-file Redo', () => existingDocument.getText() === 'base\n');
        await existingDocument.save();
        await untilStable('clean review after native whole-file Redo', async () => !(await pending('existing.txt')));

        // Hunk WorkspaceEdit is buffer-only and native Undo/Redo keeps disk untouched until save.
        await write('existing.txt', 'hunk changed\n');
        await untilStable('hunk pending review', () => pending('existing.txt'));
        await until('clean editor reload after external write', () => existingDocument.getText() === 'hunk changed\n');
        const hunkResult = await vscode.commands.executeCommand('diffTracker._testRevertBlock', uri('existing.txt').fsPath);
        assert.equal(hunkResult.status, 'success');
        assert.equal(existingDocument.getText(), 'base\n');
        assert.equal(existingDocument.isDirty, true);
        assert.equal(await read('existing.txt'), 'hunk changed\n');
        await vscode.commands.executeCommand('undo');
        await until('native hunk Undo', () => existingDocument.getText() === 'hunk changed\n');
        await vscode.commands.executeCommand('redo');
        await until('native hunk Redo', () => existingDocument.getText() === 'base\n');
        await existingDocument.save();
        await untilStable('clean review after hunk Redo', async () => !(await pending('existing.txt')));

        // Windows-style CRLF bytes survive a real filesystem review/revert round trip.
        await write('crlf.txt', 'one\r\nchanged\r\n');
        await untilStable('CRLF file pending review', () => pending('crlf.txt'));
        const crlfRevert = await vscode.commands.executeCommand('diffTracker._testRevertFile', uri('crlf.txt').fsPath);
        assert.equal(crlfRevert.status, 'success', crlfRevert.reason);
        assert.equal(await read('crlf.txt'), 'one\r\ntwo\r\n');

        // Extension recovery covers file creation/deletion without overwriting later work.
        await write('new-empty.txt', '');
        await untilStable('empty creation pending', () => reviewablePending('new-empty.txt'));
        const emptyRevert = await vscode.commands.executeCommand('diffTracker._testRevertFile', uri('new-empty.txt').fsPath);
        assert.equal(emptyRevert.status, 'success', emptyRevert.reason);
        assert.equal(await missing('new-empty.txt'), true);
        await untilStable('empty creation review cleared', async () => !(await pending('new-empty.txt')));
        const emptyUndo = await vscode.commands.executeCommand('diffTracker._testUndoLastRevert');
        assert.equal(emptyUndo.succeeded, 1, JSON.stringify(emptyUndo.results));
        assert.equal(await read('new-empty.txt'), '');
        await untilStable('review refresh after empty-file recovery Undo', () => pending('new-empty.txt'));
        const emptyAgain = await vscode.commands.executeCommand('diffTracker._testRevertFile', uri('new-empty.txt').fsPath);
        assert.equal(emptyAgain.status, 'success', emptyAgain.reason);

        await write('new-nonempty.txt', 'new recovery content\n');
        await untilStable('nonempty creation pending', () => reviewablePending('new-nonempty.txt'));
        const nonemptyRevert = await vscode.commands.executeCommand('diffTracker._testRevertFile', uri('new-nonempty.txt').fsPath);
        assert.equal(nonemptyRevert.status, 'success', nonemptyRevert.reason);
        assert.equal(await missing('new-nonempty.txt'), true);
        const nonemptyUndo = await vscode.commands.executeCommand('diffTracker._testUndoLastRevert');
        assert.equal(nonemptyUndo.succeeded, 1, JSON.stringify(nonemptyUndo.results));
        assert.equal(await read('new-nonempty.txt'), 'new recovery content\n');
        await untilStable('review refresh after nonempty-file recovery Undo', () => pending('new-nonempty.txt'));
        assert.equal((await vscode.commands.executeCommand('diffTracker._testRevertFile', uri('new-nonempty.txt').fsPath)).status, 'success');

        await vscode.workspace.fs.delete(uri('deleted.txt'));
        await untilStable('baseline deletion pending', async () => (await pending('deleted.txt'))?.isDeleted === true);
        const deletedRevert = await vscode.commands.executeCommand('diffTracker._testRevertFile', uri('deleted.txt').fsPath);
        assert.equal(deletedRevert.status, 'success', deletedRevert.reason);
        assert.equal(await read('deleted.txt'), 'delete baseline\n');
        await untilStable('deleted-file review cleared', async () => !(await pending('deleted.txt')));
        assert.equal((await vscode.commands.executeCommand('diffTracker._testUndoLastRevert')).succeeded, 1);
        assert.equal(await missing('deleted.txt'), true);
        await untilStable('review refresh after deleted-file recovery Undo', async () =>
            (await pending('deleted.txt'))?.isDeleted === true);
        const deletedAgain = await vscode.commands.executeCommand('diffTracker._testRevertFile', uri('deleted.txt').fsPath);
        assert.equal(deletedAgain.status, 'success', deletedAgain.reason);

        // A batch creates one bounded recovery record for its successful members.
        await write('batch-a.txt', 'batch a changed\n');
        await write('batch-b.txt', 'batch b changed\n');
        await untilStable('batch pending reviews', async () => await pending('batch-a.txt') && await pending('batch-b.txt'));
        const batch = await vscode.commands.executeCommand('diffTracker._testRevertAll');
        assert.equal(batch.failed, 0);
        assert.equal(batch.succeeded, 2);
        await untilStable('batch reviews cleared', async () =>
            !(await pending('batch-a.txt')) && !(await pending('batch-b.txt')));
        const batchUndo = await vscode.commands.executeCommand('diffTracker._testUndoLastRevert');
        assert.equal(batchUndo.succeeded, 2);
        assert.equal(await read('batch-a.txt'), 'batch a changed\n');
        assert.equal(await read('batch-b.txt'), 'batch b changed\n');
        await untilStable('review refresh after batch recovery Undo', async () =>
            await pending('batch-a.txt') && await pending('batch-b.txt'));
        assert.equal((await vscode.commands.executeCommand('diffTracker._testRevertAll')).failed, 0);

        // Twenty external files update the overview without opening twenty editors.
        const visibleBefore = vscode.window.visibleTextEditors.length;
        for (let index = 0; index < 20; index++) {
            await write(`bulk-${String(index).padStart(2, '0')}.txt`, `bulk ${index}\n`);
        }
        await until('20 bulk pending files', async () => (await state()).reviewTokens.filter(token =>
            path.basename(token.filePath).startsWith('bulk-')).length === 20);
        assert.equal(vscode.window.visibleTextEditors.length, visibleBefore);

        // The real built-in Git extension reports a branch switch and blocks writes.
        execFileSync('git', ['switch', '-c', 'host-feature'], { cwd: workspacePath, stdio: 'pipe' });
        await until('Git branch safety pause', async () => (await state()).gitPauses.length === 1, 45_000);
        const blocked = await vscode.commands.executeCommand('diffTracker._testRevertFile', uri('bulk-00.txt').fsPath);
        assert.equal(blocked.status, 'conflict');
        assert.match(blocked.reason, /branch|Git/i);
        const [pausedRepository] = (await state()).gitPauses;
        assert.ok(pausedRepository?.repoRoot, 'paused repository root is exposed for explicit recovery');
        assert.equal(await vscode.commands.executeCommand('diffTracker._testRebuildGitBaseline', pausedRepository.repoRoot), true);
        await until('Git baseline rebuild', async () => (await state()).gitPauses.length === 0 && (await state()).reviewTokens.length === 0);
};
