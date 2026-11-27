const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

module.exports = async function reviewableTextHost() {
    const root = process.env.DIFF_TRACKER_HOST_WORKSPACE;
    const binary = path.join(root, 'reviewable-text-host.pdf');
    const text = path.join(root, 'reviewable-text-host.txt');
    const binaryPath = vscode.Uri.file(binary).fsPath;
    const textPath = vscode.Uri.file(text).fsPath;
    const readState = () => vscode.commands.executeCommand('diffTracker._testState');
    const until = async (description, predicate) => {
        const deadline = Date.now() + 12_000;
        while (Date.now() < deadline) {
            const value = await predicate();
            if (value) { return value; }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error('Timed out waiting for ' + description);
    };
    const config = () => vscode.workspace.getConfiguration('diffTracker');
    const key = 'onlyRecordReviewableText';
    const previous = config().inspect(key)?.globalValue;
    const originalWarning = vscode.window.showWarningMessage;
    const prompts = [];
    let choice;
    // VS Code's DialogService rejects prompts when running with
    // --extensionTestsPath, before it selects the native or browser renderer.
    // Stub only this modal's answer, not the command, file watcher, settings,
    // classification, or history. Ordinary notifications retain their real API.
    vscode.window.showWarningMessage = async function(message, ...args) {
        if (!message.startsWith('Reviewable text only:') || !args[0]?.modal) {
            return originalWarning.call(this, message, ...args);
        }
        prompts.push({ message, options: args[0], buttons: args.slice(1) });
        return choice;
    };
    const writeBinary = bytes => fs.writeFileSync(binary, Buffer.from(bytes));
    try {
        fs.writeFileSync(text, 'baseline\n');
        writeBinary([0, 1]);
        await config().update(key, false, vscode.ConfigurationTarget.Global);
        await vscode.extensions.getExtension('lengmh.code-diff-tracker').activate();
        assert.equal(await vscode.commands.executeCommand('diffTracker.startRecording'), true);
        await until('Ready baseline', async () => (await readState()).baselineState === 'ready');

        writeBinary([0, 2, 3]);
        fs.writeFileSync(text, 'pending text\n');
        await until('both review kinds', async () => {
            const changes = (await readState()).trackedChanges;
            return changes.some(c => c.filePath === binaryPath && c.reviewKind !== 'text') &&
                changes.some(c => c.filePath === textPath && c.reviewKind === 'text');
        });

        for (const decision of ['Enable and Keep Existing Reviews', 'Enable and Stop Tracking Listed Items']) {
            if (config().get(key)) { await vscode.commands.executeCommand('diffTracker.toggleSetting', key); }
            choice = decision;
            const count = prompts.length;
            await vscode.commands.executeCommand('diffTracker.toggleSetting', key);
            assert.equal(prompts.length, count + 1, 'one confirmation for this setting change');
            const prompt = prompts.at(-1);
            assert.match(prompt.message, /1 existing item/);
            assert.match(prompt.options.detail, /reviewable-text-host\.pdf/);
            assert.doesNotMatch(prompt.options.detail, /reviewable-text-host\.txt/);
            assert.deepEqual(prompt.buttons, ['Enable and Stop Tracking Listed Items', 'Enable and Keep Existing Reviews']);
            assert.equal(config().get(key), true);
            const changes = (await readState()).trackedChanges;
            assert.equal(changes.some(c => c.filePath === binaryPath), decision === 'Enable and Keep Existing Reviews');
            assert.ok(changes.some(c => c.filePath === textPath && c.reviewKind === 'text'));
        }
        assert.deepEqual(fs.readFileSync(binary), Buffer.from([0, 2, 3]));
        writeBinary([0, 4, 5, 6]);
        fs.writeFileSync(text, 'observe later text\n');
        await until('later external recording', async () => (await readState()).trackedChanges.some(
            c => c.filePath === textPath && c.currentContent === 'observe later text\n'));
        assert.ok(!(await readState()).trackedChanges.some(c => c.filePath === binaryPath));
        console.log('PASS HOST REVIEWABLE TEXT setting command requests one confirmation and removes only approved unsupported reviews');
    } finally {
        vscode.window.showWarningMessage = originalWarning;
        await vscode.commands.executeCommand('diffTracker.stopRecording');
        await config().update(key, previous, vscode.ConfigurationTarget.Global);
        fs.rmSync(binary, { force: true });
        fs.rmSync(text, { force: true });
    }
};
