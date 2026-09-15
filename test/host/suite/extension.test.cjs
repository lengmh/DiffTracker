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
const state = () => vscode.commands.executeCommand('diffTracker._testState');
const pending = async name => (await state()).trackedChanges.find(item => item.filePath === uri(name).fsPath);
const read = async name => new TextDecoder().decode(await vscode.workspace.fs.readFile(uri(name)));
const write = (name, content) => vscode.workspace.fs.writeFile(uri(name), new TextEncoder().encode(content));
const missing = async name => {
    try { await vscode.workspace.fs.stat(uri(name)); return false; }
    catch (error) { return error instanceof vscode.FileSystemError; }
};

suite('Diff Tracker real Extension Host', () => {
    test('review, recovery, lifecycle, Git pause and no-tab behavior', async () => {
        assert.ok(workspacePath, 'host workspace environment is required');
        const extension = vscode.extensions.getExtension('lengmh.diff-tracker');
        assert.ok(extension, 'development extension is installed');
        await extension.activate();
        await until('Ready baseline', async () => (await state())?.baselineState === 'ready');
        assert.equal((await state()).isRecording, true);

        // Whole-file WorkspaceEdit/save participates in native editor Undo/Redo.
        await write('existing.txt', 'whole changed\n');
        await until('whole-file pending review', () => pending('existing.txt'));
        assert.equal((await vscode.commands.executeCommand('diffTracker._testRevertFile', uri('existing.txt').fsPath)).status, 'success');
        assert.equal(await read('existing.txt'), 'base\n');
        const existingDocument = await vscode.workspace.openTextDocument(uri('existing.txt'));
        await vscode.window.showTextDocument(existingDocument);
        await vscode.commands.executeCommand('undo');
        await until('native whole-file Undo', () => existingDocument.getText() === 'whole changed\n');
        await until('review refresh after native whole-file Undo', () => pending('existing.txt'));
        const recoveryAfterNativeUndo = await vscode.commands.executeCommand('diffTracker._testUndoLastRevert');
        assert.equal(recoveryAfterNativeUndo.succeeded, 1, 'native Undo is recognized without a second inverse edit');
        assert.equal(existingDocument.getText(), 'whole changed\n');
        await vscode.commands.executeCommand('redo');
        await until('native whole-file Redo', () => existingDocument.getText() === 'base\n');
        await existingDocument.save();
        await until('clean review after native whole-file Redo', async () => !(await pending('existing.txt')));

        // Hunk WorkspaceEdit is buffer-only and native Undo/Redo keeps disk untouched until save.
        await write('existing.txt', 'hunk changed\n');
        await until('hunk pending review', () => pending('existing.txt'));
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
        await until('clean review after hunk Redo', async () => !(await pending('existing.txt')));

        // Extension recovery covers file creation/deletion without overwriting later work.
        await write('new-empty.txt', '');
        await until('empty creation pending', () => pending('new-empty.txt'));
        assert.equal((await vscode.commands.executeCommand('diffTracker._testRevertFile', uri('new-empty.txt').fsPath)).status, 'success');
        assert.equal(await missing('new-empty.txt'), true);
        assert.equal((await vscode.commands.executeCommand('diffTracker._testUndoLastRevert')).succeeded, 1);
        assert.equal(await read('new-empty.txt'), '');
        assert.equal((await vscode.commands.executeCommand('diffTracker._testRevertFile', uri('new-empty.txt').fsPath)).status, 'success');

        await vscode.workspace.fs.delete(uri('deleted.txt'));
        await until('baseline deletion pending', async () => (await pending('deleted.txt'))?.isDeleted === true);
        assert.equal((await vscode.commands.executeCommand('diffTracker._testRevertFile', uri('deleted.txt').fsPath)).status, 'success');
        assert.equal(await read('deleted.txt'), 'delete baseline\n');
        assert.equal((await vscode.commands.executeCommand('diffTracker._testUndoLastRevert')).succeeded, 1);
        assert.equal(await missing('deleted.txt'), true);
        assert.equal((await vscode.commands.executeCommand('diffTracker._testRevertFile', uri('deleted.txt').fsPath)).status, 'success');

        // A batch creates one bounded recovery record for its successful members.
        await write('batch-a.txt', 'batch a changed\n');
        await write('batch-b.txt', 'batch b changed\n');
        await until('batch pending reviews', async () => await pending('batch-a.txt') && await pending('batch-b.txt'));
        const batch = await vscode.commands.executeCommand('diffTracker._testRevertAll');
        assert.equal(batch.failed, 0);
        assert.equal(batch.succeeded, 2);
        const batchUndo = await vscode.commands.executeCommand('diffTracker._testUndoLastRevert');
        assert.equal(batchUndo.succeeded, 2);
        assert.equal(await read('batch-a.txt'), 'batch a changed\n');
        assert.equal(await read('batch-b.txt'), 'batch b changed\n');
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
        assert.equal(await vscode.commands.executeCommand('diffTracker._testRebuildGitBaseline', workspacePath), true);
        await until('Git baseline rebuild', async () => (await state()).gitPauses.length === 0 && (await state()).reviewTokens.length === 0);
    });
});
