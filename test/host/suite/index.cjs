async function bounded(description, scenario, milliseconds) {
    let timeout;
    try {
        await Promise.race([
            scenario(),
            new Promise((_, reject) => {
                timeout = setTimeout(
                    () => reject(new Error(`Code Diff Tracker ${description} timed out`)),
                    milliseconds
                );
            })
        ]);
    } finally {
        if (timeout) {
            clearTimeout(timeout);
        }
    }
}

exports.run = async () => {
    const restart = require('./s4d-restart.test.cjs');
    const phase = process.env.DIFF_TRACKER_HOST_PHASE;
    if (phase === 'lifecycle-diagnostics') {
        await bounded('Monitoring lifecycle diagnostics',()=>require('./monitoring-lifecycle-status.test.cjs')(process.env.DIFF_TRACKER_HOST_WORKSPACE),60000);
        return;
    }
    if (phase === 'deleted-coverage') {
        await bounded('Deleted directory coverage lifecycle',()=>require('./deleted-directory-coverage.test.cjs')(process.env.DIFF_TRACKER_HOST_WORKSPACE),60000);
        return;
    }
    if (phase === 'scope-settings') {
        await bounded('Scope settings publication checkpoint', require('./scope-settings.test.cjs'), 60_000);
        return;
    }
    if (phase === 'workspace-edit') {
        await bounded('Isolated WorkspaceEdit lifecycle', async () => {
            const assert = require('node:assert/strict');
            const path = require('node:path');
            const vscode = require('vscode');
            const root = process.env.DIFF_TRACKER_HOST_WORKSPACE;
            const uri = name => vscode.Uri.file(path.join(root, name));
            const state = () => vscode.commands.executeCommand('diffTracker._testState');
            await vscode.extensions.getExtension('lengmh.code-diff-tracker').activate();
            assert.equal(await vscode.commands.executeCommand('diffTracker.startRecording'), true);
            const untilStable = async (description, predicate, stableMilliseconds = 750, timeout = 30000) => {
                const deadline = Date.now() + timeout;
                let since;
                while (Date.now() < deadline) {
                    const result = await predicate();
                    if (result) {
                        since ??= Date.now();
                        if (Date.now() - since >= stableMilliseconds) { return result; }
                    } else { since = undefined; }
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                throw new Error(`Timed out waiting for stable ${description}`);
            };
            await untilStable('isolated baseline ready', async () => (await state()).baselineState === 'ready', 0);
            const pending = async name => (await state()).trackedChanges.find(change => change.filePath === uri(name).fsPath);
            await require('./workspace-edit-creation.test.cjs')({ workspace: root, uri,
                write: (name, text) => vscode.workspace.fs.writeFile(uri(name), new TextEncoder().encode(text)), untilStable, pending,
                reviewablePending: async name => {
                    const current = await state();
                    const file = uri(name).fsPath;
                    const change = current.trackedChanges.find(item => item.filePath === file);
                    return change && !change.unavailableReason && current.reviewTokens.some(token => token.filePath === file) ? change : undefined;
                }
            });
        }, 45000);
        return;
    }
    if (phase === 'native') {
        await bounded('Native Review UI checkpoint', require('./native-review.test.cjs'), 90_000);
        return;
    }
    if (phase === 'restore') {
        // A dedicated second process phase must not re-run the full suite or
        // reset the prepared review before inspecting the offline edit.
        await bounded('S4-D process restart restore', restart.restore, 45_000);
        return;
    }
    if (phase !== 'prepare') { throw new Error(`Unknown Extension Host phase: ${phase}`); }
    // Preserve the existing full-scenario and per-assertion time budgets. The
    // small process-restart fixture has its own bounded prepare/restore phases.
    await bounded('Extension Host scenario', async () => {
        const assert = require('node:assert/strict');
        const path = require('node:path');
        const vscode = require('vscode');
        await vscode.extensions.getExtension('lengmh.code-diff-tracker').activate();
        assert.equal((await vscode.commands.executeCommand('diffTracker._testState')).isRecording, false,
            'fresh prepare session must remain stopped until explicitly started');
        assert.equal(await vscode.commands.executeCommand('diffTracker.startRecording'), true);
        let initial;
        const deadline = Date.now() + 30_000;
        do {
            initial = await vscode.commands.executeCommand('diffTracker._testState');
            if (initial.baselineState === 'ready') { break; }
            await new Promise(resolve => setTimeout(resolve, 100));
        } while (Date.now() < deadline);
        assert.equal(initial.baselineState, 'ready');
        const isNativeFixture = filePath => ['native-a.txt', 'native-b.txt'].includes(path.basename(filePath));
        assert.equal(initial.trackedChanges.some(change => isNativeFixture(change.filePath)), false,
            'the fresh main session must not inherit any Native acceptance review');
        for (const [name, expected] of [
            ['native-a.txt', 'header\nalpha value=old\nseparator\nbeta value=old\nfooter\n'],
            ['native-b.txt', 'b header\nbeta value=old\nb footer\n']
        ]) {
            assert.equal(await vscode.commands.executeCommand('diffTracker._testOriginalContent',
                vscode.Uri.file(path.join(process.env.DIFF_TRACKER_HOST_WORKSPACE, name)).fsPath), expected,
            'the fresh main session must capture each exact restored fixture baseline');
        }
        await require('./extension.test.cjs')();
    }, 150_000);
    console.log('PASS Code Diff Tracker real Extension Host scenario');
    await bounded('S4-D process restart prepare', restart.prepare, 45_000);
};
