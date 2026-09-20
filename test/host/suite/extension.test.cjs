const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const workspacePath = process.env.DIFF_TRACKER_HOST_WORKSPACE;
const secondRoot = process.env.DIFF_TRACKER_HOST_SECOND_ROOT;
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
        const extension = vscode.extensions.getExtension('lengmh.code-diff-tracker');
        assert.ok(extension, 'development extension is installed');
        await extension.activate();
        await until('Ready baseline', async () => (await state())?.baselineState === 'ready');
        assert.equal((await state()).isRecording, true);

        // Stable watcher contract used by S0/W1 planning:
        // recursive RelativePattern watchers inherit files.watcherExclude, while
        // a non-recursive RelativePattern can subscribe to otherwise excluded
        // direct children. The latter is observable supplemental coverage; it
        // does not prove that a separate recursive/default watcher took over.
        assert.ok(secondRoot, 'second host workspace root is required');
        const excludedTree = path.join(secondRoot, 'excluded-tree');
        fs.mkdirSync(excludedTree, { recursive: true });

        const recursiveEvents = [];
        const recursiveWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(excludedTree, '**/*')
        );
        recursiveWatcher.onDidCreate(event => recursiveEvents.push(event.fsPath));
        recursiveWatcher.onDidChange(event => recursiveEvents.push(event.fsPath));
        try {
            await delay(750);
            const recursiveProbe = path.join(excludedTree, 'recursive-probe.txt');
            fs.writeFileSync(recursiveProbe, 'recursive excluded probe\n');
            await delay(1000);
            assert.equal(
                recursiveEvents.some(filePath => filePath === recursiveProbe),
                false,
                'recursive RelativePattern must not silently bypass files.watcherExclude'
            );
        } finally {
            recursiveWatcher.dispose();
        }

        const directEvents = [];
        const directWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(excludedTree, '*')
        );
        directWatcher.onDidCreate(event => directEvents.push(event.fsPath));
        directWatcher.onDidChange(event => directEvents.push(event.fsPath));
        try {
            await delay(750);
            const directProbe = path.join(excludedTree, 'direct-probe.txt');
            fs.writeFileSync(directProbe, 'non-recursive supplemental probe\n');
            await until('non-recursive watcher coverage for watcherExclude subtree', () =>
                directEvents.some(filePath => filePath === directProbe), 10_000);
        } finally {
            directWatcher.dispose();
        }
        console.log('PASS HOST-WATCH-CONTRACT watcherExclude requires explicit supplemental coverage');

        // A native/virtual baseline document shares fsPath with the real working
        // file. Review actions must never treat the virtual document as current
        // workspace content merely because the paths match.
        await write('virtual-baseline.txt', 'alpha\nchanged\nomega\n');
        await untilStable('virtual baseline review', () => reviewablePending('virtual-baseline.txt'));
        const virtualPath = uri('virtual-baseline.txt').fsPath;
        const originalUri = uri('virtual-baseline.txt').with({ scheme: 'diff-tracker-original' });
        const originalDocument = await vscode.workspace.openTextDocument(originalUri);
        assert.equal(originalDocument.getText(), 'alpha\nbeta\nomega\n');
        assert.ok(vscode.workspace.textDocuments.some(document =>
            document.uri.scheme === 'diff-tracker-original' && document.uri.fsPath === virtualPath));

        const virtualKeep = await vscode.commands.executeCommand('diffTracker._testKeepBlock', virtualPath);
        assert.equal(virtualKeep.status, 'success', virtualKeep.reason);
        await untilStable('virtual baseline keep clears review', async () => !(await pending('virtual-baseline.txt')));

        await write('virtual-baseline.txt', 'alpha\nchanged again\nomega\n');
        const secondVirtualReview = await untilStable(
            'post-keep virtual baseline review',
            () => reviewablePending('virtual-baseline.txt')
        );
        assert.equal(
            secondVirtualReview.originalContent,
            'alpha\nchanged\nomega\n',
            'Keep must advance the real tracker baseline, not preserve the virtual document contents'
        );
        const virtualRevert = await vscode.commands.executeCommand('diffTracker._testRevertFile', virtualPath);
        assert.equal(virtualRevert.status, 'success', virtualRevert.reason);
        assert.equal(await read('virtual-baseline.txt'), 'alpha\nchanged\nomega\n');
        await untilStable('virtual baseline review cleared', async () => !(await pending('virtual-baseline.txt')));
        console.log('PASS HOST-NATIVE-BASELINE virtual baseline documents cannot impersonate file: working documents');

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
        assert.equal(emptyRevert.status, 'conflict');
        assert.match(emptyRevert.reason, /delete it manually/);
        assert.equal(await read('new-empty.txt'), '');
        await vscode.workspace.fs.delete(uri('new-empty.txt'));
        assert.equal(await missing('new-empty.txt'), true);
        await untilStable('empty creation review cleared', async () => !(await pending('new-empty.txt')));

        await write('new-nonempty.txt', 'new recovery content\n');
        await untilStable('nonempty creation pending', () => reviewablePending('new-nonempty.txt'));
        const nonemptyRevert = await vscode.commands.executeCommand('diffTracker._testRevertFile', uri('new-nonempty.txt').fsPath);
        assert.equal(nonemptyRevert.status, 'conflict');
        assert.match(nonemptyRevert.reason, /delete it manually/);
        assert.equal(await read('new-nonempty.txt'), 'new recovery content\n');
        await write('new-nonempty.txt', 'later external work\n');
        await untilStable('later new-file edit remains pending', () => reviewablePending('new-nonempty.txt'));
        assert.equal((await vscode.commands.executeCommand('diffTracker._testRevertFile', uri('new-nonempty.txt').fsPath)).status, 'conflict');
        assert.equal(await read('new-nonempty.txt'), 'later external work\n');
        await vscode.workspace.fs.delete(uri('new-nonempty.txt'));
        assert.equal(await missing('new-nonempty.txt'), true);
        await untilStable('new-file manual deletion clears review', async () => !(await pending('new-nonempty.txt')));

        // VS Code's create-file event supplies creation provenance even when the
        // filesystem watcher reports a change before (or instead of) a create.
        const createEdit = new vscode.WorkspaceEdit();
        createEdit.createFile(uri('workspace-created.txt'));
        assert.equal(await vscode.workspace.applyEdit(createEdit), true);
        await write('workspace-created.txt', 'created through WorkspaceEdit\n');
        await untilStable('WorkspaceEdit-created text review', () => reviewablePending('workspace-created.txt'));
        await vscode.workspace.fs.delete(uri('workspace-created.txt'));
        await untilStable('WorkspaceEdit-created review cleared', async () => !(await pending('workspace-created.txt')));

        await vscode.workspace.fs.writeFile(uri('new-image.png'), Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 1]));
        await delay(1000);
        assert.equal(await pending('new-image.png'), undefined, 'binary additions are excluded from text review');
        await vscode.workspace.fs.delete(uri('new-image.png'));

        await vscode.workspace.fs.delete(uri('deleted.txt'));
        await untilStable('baseline deletion pending', async () => (await pending('deleted.txt'))?.isDeleted === true);
        await vscode.commands.executeCommand('diffTracker.showOriginalAndWebviewSplit', uri('deleted.txt').fsPath);
        // Panel creation crosses the workbench boundary; command completion does
        // not imply the tab model has received the corresponding event yet.
        await until('deleted-file review tab', () => vscode.window.tabGroups.all
            .some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputWebview)));
        const deletedReviewTab = vscode.window.tabGroups.all.flatMap(group => group.tabs)
            .find(tab => tab.input instanceof vscode.TabInputWebview);
        assert.ok(deletedReviewTab, 'Deleted-file split entry must open a review panel');
        assert.equal(await missing('deleted.txt'), true);
        await vscode.window.tabGroups.close(deletedReviewTab);
        console.log('PASS HOST-REVIEW deleted-file split opens Webview without recreating file');
        const deletedRevert = await vscode.commands.executeCommand('diffTracker._testRevertFile', uri('deleted.txt').fsPath);
        assert.equal(deletedRevert.status, 'success', deletedRevert.reason);
        assert.equal(await read('deleted.txt'), 'delete baseline\n');
        if (process.platform !== 'win32') {
            assert.equal(require('node:fs').statSync(uri('deleted.txt').fsPath).mode & 0o777, 0o755);
        }
        await untilStable('deleted-file review cleared', async () => !(await pending('deleted.txt')));
        const destructiveUndo = await vscode.commands.executeCommand('diffTracker._testUndoLastRevert');
        assert.equal(destructiveUndo.succeeded, 0);
        assert.match(destructiveUndo.results[0].reason, /delete it manually/);
        assert.equal(await read('deleted.txt'), 'delete baseline\n');
        await vscode.workspace.fs.delete(uri('deleted.txt'));
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
        // New-file baseline publication is asynchronous. Wait for it to settle before
        // starting the branch-safety scenario so this assertion tests the Git pause,
        // not a transient "baseline incomplete" guard while those creations persist.
        await untilStable('bulk baseline publication', async () => (await state()).baselineState === 'ready');
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
        await write('batch-a.txt', 'stopped clear preserves disk\n');
        await untilStable('stopped clear pending', () => pending('batch-a.txt'));
        await vscode.commands.executeCommand('diffTracker.stopRecording');
        assert.equal(await vscode.commands.executeCommand('diffTracker.clearDiffs'), true);
        assert.equal((await state()).isRecording, false);
        assert.equal((await state()).trackedChanges.length, 0);
        assert.equal((await state()).reviewTokens.length, 0);
        assert.equal(await read('batch-a.txt'), 'stopped clear preserves disk\n');
        console.log('PASS HOST-REVIEW stopped clear command preserves disk and recording state');
        await require('./audit.test.cjs')(workspacePath);
};
