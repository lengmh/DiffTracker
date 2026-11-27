const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
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
    const driver = path.join(__dirname, '..', 'native-ui-driver.mjs');
    const decide = async (label) => {
        const { stdout } = await promisify(execFile)(process.env.DIFF_TRACKER_HOST_NODE,
            [driver, process.env.DIFF_TRACKER_HOST_CDP_PORT, 'text-filter-dialog', label],
            { timeout: 25_000 });
        return JSON.parse(stdout);
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

        for (const choice of ['Enable and Keep Existing Reviews', 'Enable and Stop Tracking Listed Items']) {
            if (config().get(key)) { await vscode.commands.executeCommand('diffTracker.toggleSetting', key); }
            const action = vscode.commands.executeCommand('diffTracker.toggleSetting', key);
            const response = await decide(choice);
            assert.equal(response.clicked, true);
            assert.match(response.text, /reviewable-text-host\.pdf/);
            assert.doesNotMatch(response.text, /reviewable-text-host\.txt/);
            await action;
            assert.equal(config().get(key), true);
            const changes = (await readState()).trackedChanges;
            assert.equal(changes.some(c => c.filePath === binaryPath), choice === 'Enable and Keep Existing Reviews');
            assert.ok(changes.some(c => c.filePath === textPath && c.reviewKind === 'text'));
        }
        assert.deepEqual(fs.readFileSync(binary), Buffer.from([0, 2, 3]));
        writeBinary([0, 4, 5, 6]);
        fs.writeFileSync(text, 'observe later text\n');
        await until('later external recording', async () => (await readState()).trackedChanges.some(
            c => c.filePath === textPath && c.currentContent === 'observe later text\n'));
        assert.ok(!(await readState()).trackedChanges.some(c => c.filePath === binaryPath));
        console.log('PASS HOST REVIEWABLE TEXT setting command offers a real confirmation and removes only approved unsupported reviews');
    } finally {
        await vscode.commands.executeCommand('diffTracker.stopRecording');
        await config().update(key, previous, vscode.ConfigurationTarget.Global);
        fs.rmSync(binary, { force: true });
        fs.rmSync(text, { force: true });
    }
};
