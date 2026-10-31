const assert = require('node:assert/strict');
const fs = require('node:fs');
const vscode = require('vscode');
const { DiffTracker } = require('../../../out/diffTracker.js');
const { createHostLifecycleTrace } = require('./host-lifecycle-trace.cjs');

module.exports = async function workspaceEditCreation({ workspace, uri, write, untilStable, reviewablePending, pending }) {
    const lifecycle = createHostLifecycleTrace(vscode, workspace, ['workspace-created.txt']);
    lifecycle.hookTracker(DiffTracker);
    try {
        // These operations and their ordering match the full-scenario contract.
        // No diagnostic await is inserted between applyEdit and the write.
        lifecycle.add('workspace-edit-start', { state: lifecycle.snapshot() });
        const edit = new vscode.WorkspaceEdit();
        edit.createFile(uri('workspace-created.txt'));
        assert.equal(await vscode.workspace.applyEdit(edit), true);
        lifecycle.add('workspace-edit-response', { state: lifecycle.snapshot() });
        await write('workspace-created.txt', 'created through WorkspaceEdit\n');
        lifecycle.add('provider-write-response', { state: lifecycle.snapshot() });
        const review = await untilStable('WorkspaceEdit-created text review', () => reviewablePending('workspace-created.txt'));
        assert.equal(review.currentContent, 'created through WorkspaceEdit\n');
        assert.equal(review.reviewKind, 'text');
        await vscode.workspace.fs.delete(uri('workspace-created.txt'));
        await untilStable('WorkspaceEdit-created review cleared', async () => !(await pending('workspace-created.txt')));
        console.log('HOST-LIFECYCLE WorkspaceEdit success:', JSON.stringify(lifecycle.dump()));
    } catch (error) {
        let disk;
        try {
            const stat = fs.lstatSync(uri('workspace-created.txt').fsPath);
            disk = { exists: true, file: stat.isFile(), bytes: stat.size, birthtimeMs: stat.birthtimeMs, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
        } catch (caught) { disk = { exists: false, code: caught.code }; }
        console.error('HOST-LIFECYCLE WorkspaceEdit failure:', JSON.stringify({ ...lifecycle.dump(), disk }));
        throw error;
    } finally { lifecycle.dispose(); }
};
