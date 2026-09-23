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

        // S3: a fresh workspace with no legacy Global watch rules adopts the
        // default configured Rules scope before automatic recording starts.
        const configuredScope = await vscode.commands.executeCommand('diffTracker._testMonitoringScopeStatus');
        assert.equal(configuredScope.effective.kind, 'configured');
        assert.equal(configuredScope.effective.mode, 'rules');
        assert.equal(configuredScope.legacyMigrationComplete, true);
        assert.equal(configuredScope.requested.scope.scopeRevision, configuredScope.effective.scopeRevision);
        console.log('PASS HOST-S3 fresh workspace starts with configured Rules scope');

        // Explicit includes must baseline existing resources hidden by ordinary
        // default exclusions. Do not require subsequent watcher events here:
        // supplemental observation coverage for host-excluded subtrees is S4-W.
        const privateDir = path.join(workspacePath, 'dist', 's3-private');
        const privatePath = path.join(privateDir, 'existing.txt');
        const privateTrackedPath = vscode.Uri.file(privatePath).fsPath;
        fs.mkdirSync(privateDir, { recursive: true });
        fs.writeFileSync(privatePath, 's3 private baseline\n');
        const primaryFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(privatePath));
        assert.ok(primaryFolder, 'primary host workspace folder must be resolvable');
        const privateInclude = {
            scope: 'folder',
            folder: primaryFolder.name,
            path: 'dist/s3-private/existing.txt'
        };
        assert.equal(
            await vscode.commands.executeCommand('diffTracker._testOriginalContent', privateTrackedPath),
            undefined,
            'ordinary excluded path must not already have a baseline'
        );
        const scopeConfig = vscode.workspace.getConfiguration('diffTracker');
        await scopeConfig.update('watchInclude', [privateInclude],
            vscode.ConfigurationTarget.Workspace);
        const includeApply = await vscode.commands.executeCommand('diffTracker._testApplyMonitoringScope', {
            grantConsent: true
        });
        assert.equal(includeApply.status, 'applied', JSON.stringify(includeApply));
        assert.equal(
            await vscode.commands.executeCommand('diffTracker._testOriginalContent', privateTrackedPath),
            's3 private baseline\n',
            'explicit include must capture the existing ignored resource as its current baseline'
        );
        console.log('PASS HOST-S3 explicit include baselines resources hidden by ordinary exclusions');

        // S3 can baseline an ordinary ignored subtree, but it must not publish
        // an include whose future events are suppressed by files.watcherExclude.
        const filesConfig = vscode.workspace.getConfiguration('files');
        const previousWatcherExclude = filesConfig.inspect('watcherExclude')?.workspaceValue;

        // The Start command must project the backend's actual post-start state.
        // Create a real S3 refusal: an already-effective explicit include becomes
        // unobservable because files.watcherExclude changes after publication.
        await vscode.commands.executeCommand('diffTracker.stopRecording');
        await filesConfig.update('watcherExclude', { '**/dist/s3-private/**': true },
            vscode.ConfigurationTarget.Workspace);
        await delay(250);
        const refusedStart = await vscode.commands.executeCommand('diffTracker._testStartRecordingAfterPrechecks');
        assert.equal(refusedStart, false, 'backend must refuse Start while the effective include lacks observation coverage');
        const refusedStartState = await state();
        assert.equal(refusedStartState.isRecording, false);
        assert.equal(refusedStartState.recordingContext, false,
            'the command context must remain false when DiffTracker.startRecording() refuses');
        await filesConfig.update('watcherExclude', previousWatcherExclude, vscode.ConfigurationTarget.Workspace);
        await delay(250);
        assert.equal(await vscode.commands.executeCommand('diffTracker._testStartRecordingAfterPrechecks'), true,
            'restoring observation coverage must leave a valid recovery path');
        await until('Ready baseline after rejected Start recovery', async () => (await state()).baselineState === 'ready');
        console.log('PASS HOST-S3 rejected Start keeps recording command context false');

        await filesConfig.update('watcherExclude', { '**/watcher-hidden/**': true },
            vscode.ConfigurationTarget.Workspace);
        await scopeConfig.update('watchInclude', [
            privateInclude,
            { scope: 'folder', folder: primaryFolder.name, path: 'watcher-hidden/private' }
        ], vscode.ConfigurationTarget.Workspace);
        const watcherExcludedApply = await vscode.commands.executeCommand('diffTracker._testApplyMonitoringScope', {
            grantConsent: true
        });
        assert.equal(watcherExcludedApply.status, 'requiresS4', JSON.stringify(watcherExcludedApply));

        await filesConfig.update('watcherExclude', { '**/generated/**': true },
            vscode.ConfigurationTarget.Workspace);
        await scopeConfig.update('watchInclude', [{
            scope: 'folder',
            folder: primaryFolder.name,
            path: 'dist/s3-private'
        }], vscode.ConfigurationTarget.Workspace);
        const descendantWatcherApply = await vscode.commands.executeCommand('diffTracker._testApplyMonitoringScope', {
            grantConsent: true
        });
        assert.equal(descendantWatcherApply.status, 'requiresS4', JSON.stringify(descendantWatcherApply));

        await scopeConfig.update('watchInclude', [privateInclude],
            vscode.ConfigurationTarget.Workspace);
        await filesConfig.update('watcherExclude', previousWatcherExclude, vscode.ConfigurationTarget.Workspace);
        console.log('PASS HOST-S3 watcher-excluded explicit include remains pending for S4-W');

        // Confirmation must be bound to the exact scope revision shown to the
        // user. A settings edit while the modal is open invalidates that approval.
        const stableIncludes = [privateInclude];
        await scopeConfig.update('watchInclude', [
            ...stableIncludes,
            { scope: 'all', path: 'dist/revision-a' }
        ], vscode.ConfigurationTarget.Workspace);
        const stalePrompt = await vscode.commands.executeCommand('diffTracker._testApplyMonitoringScope');
        assert.equal(stalePrompt.status, 'needsConsent', JSON.stringify(stalePrompt));
        assert.ok(stalePrompt.scopeRevision);
        await scopeConfig.update('watchInclude', [
            ...stableIncludes,
            { scope: 'all', path: 'dist/revision-b' }
        ], vscode.ConfigurationTarget.Workspace);
        const staleApproval = await vscode.commands.executeCommand('diffTracker._testApplyMonitoringScope', {
            grantConsent: true,
            expectedScopeRevision: stalePrompt.scopeRevision
        });
        assert.equal(staleApproval.status, 'conflict', JSON.stringify(staleApproval));
        await scopeConfig.update('watchInclude', stableIncludes, vscode.ConfigurationTarget.Workspace);
        console.log('PASS HOST-S3 stale scope approval cannot authorize a newer revision');

        // S4-A: when host watcher exclusions are explicitly disabled for the
        // fixture, Whole Workspace can publish transactionally. Recording Apply
        // baselines current resources immediately; stopped Apply publishes only
        // the scope, and the next Start rebuilds under that effective scope.
        await vscode.commands.executeCommand('diffTracker.stopRecording');
        const mergedWatcherExclude = filesConfig.get('watcherExclude', {});
        const coverageSafeWatcherExclude = Object.fromEntries(
            Object.keys(mergedWatcherExclude).map(pattern => [pattern, false])
        );
        await filesConfig.update('watcherExclude', coverageSafeWatcherExclude,
            vscode.ConfigurationTarget.Workspace);
        const secondRootFilesConfig = vscode.workspace.getConfiguration('files', vscode.Uri.file(secondRoot));
        const previousSecondRootWatcherExclude =
            secondRootFilesConfig.inspect('watcherExclude')?.workspaceFolderValue;
        const mergedSecondRootWatcherExclude = secondRootFilesConfig.get('watcherExclude', {});
        const coverageSafeSecondRootWatcherExclude = Object.fromEntries(
            Object.keys(mergedSecondRootWatcherExclude).map(pattern => [pattern, false])
        );
        await secondRootFilesConfig.update('watcherExclude', coverageSafeSecondRootWatcherExclude,
            vscode.ConfigurationTarget.WorkspaceFolder);
        // Updating a WorkspaceFolder setting writes secondRoot/.vscode/settings.json,
        // which is itself a monitored workspace resource. Let that real watcher
        // event settle before opening the scope transaction; late events must
        // continue to invalidate preparation rather than being ignored.
        await delay(500);
        await scopeConfig.update('watchInclude', [], vscode.ConfigurationTarget.Workspace);
        await scopeConfig.update('watchExclude', [], vscode.ConfigurationTarget.Workspace);

        // Existing-before-Start but ordinary-policy-ignored is the precise
        // expansion fixture: Rules must not baseline it, while Whole Workspace
        // must adopt its current contents as the candidate before-image.
        const recordingWholePath = path.join(workspacePath, 'node_modules', 's4-recording-whole.txt');
        const recordingWholeTrackedPath = vscode.Uri.file(recordingWholePath).fsPath;
        fs.mkdirSync(path.dirname(recordingWholePath), { recursive: true });
        fs.writeFileSync(recordingWholePath, 'recording whole baseline\n');

        await delay(250);
        assert.equal(await vscode.commands.executeCommand('diffTracker._testStartRecordingAfterPrechecks'), true,
            'Rules recording must restart after fixture watcher exclusions are made coverage-safe');
        await until('Rules baseline before recording Whole Workspace Apply',
            async () => (await state()).baselineState === 'ready');
        assert.equal(
            await vscode.commands.executeCommand('diffTracker._testOriginalContent', recordingWholeTrackedPath),
            undefined,
            'Rules baseline must not include the ordinary-policy-ignored expansion fixture'
        );

        await scopeConfig.update('monitoringScope', 'wholeWorkspace', vscode.ConfigurationTarget.Workspace);
        const recordingWholeApply = await vscode.commands.executeCommand('diffTracker._testApplyMonitoringScope', {
            grantConsent: true
        });
        assert.equal(recordingWholeApply.status, 'applied', JSON.stringify(recordingWholeApply));
        assert.equal(
            await vscode.commands.executeCommand('diffTracker._testOriginalContent', recordingWholeTrackedPath),
            'recording whole baseline\n'
        );
        assert.equal((await vscode.commands.executeCommand('diffTracker._testMonitoringScopeStatus')).effective.mode,
            'wholeWorkspace');
        console.log('PASS HOST-S4A recording Whole Workspace apply captures candidate baseline');

        await scopeConfig.update('monitoringScope', 'rules', vscode.ConfigurationTarget.Workspace);
        const rulesApply = await vscode.commands.executeCommand('diffTracker._testApplyMonitoringScope');
        assert.equal(rulesApply.status, 'applied', JSON.stringify(rulesApply));

        await vscode.commands.executeCommand('diffTracker.stopRecording');
        const stoppedWholePath = path.join(workspacePath, 's4-stopped-whole.txt');
        const stoppedWholeTrackedPath = vscode.Uri.file(stoppedWholePath).fsPath;
        fs.writeFileSync(stoppedWholePath, 'stopped whole baseline\n');
        await scopeConfig.update('monitoringScope', 'wholeWorkspace', vscode.ConfigurationTarget.Workspace);
        const stoppedWholeApply = await vscode.commands.executeCommand('diffTracker._testApplyMonitoringScope', {
            grantConsent: true
        });
        assert.equal(stoppedWholeApply.status, 'applied', JSON.stringify(stoppedWholeApply));
        assert.equal(
            await vscode.commands.executeCommand('diffTracker._testOriginalContent', stoppedWholeTrackedPath),
            undefined,
            'stopped scope Apply must not acquire a new before-image'
        );
        assert.equal(await vscode.commands.executeCommand('diffTracker._testStartRecordingAfterPrechecks'), true);
        await until('Whole Workspace baseline after stopped Apply', async () => (await state()).baselineState === 'ready');
        assert.equal(
            await vscode.commands.executeCommand('diffTracker._testOriginalContent', stoppedWholeTrackedPath),
            'stopped whole baseline\n'
        );
        console.log('PASS HOST-S4A stopped Whole Workspace apply defers baseline acquisition until Start');

        await scopeConfig.update('monitoringScope', 'rules', vscode.ConfigurationTarget.Workspace);
        const restoreRulesApply = await vscode.commands.executeCommand('diffTracker._testApplyMonitoringScope');
        assert.equal(restoreRulesApply.status, 'applied', JSON.stringify(restoreRulesApply));
        await vscode.commands.executeCommand('diffTracker.stopRecording');
        await secondRootFilesConfig.update('watcherExclude', previousSecondRootWatcherExclude,
            vscode.ConfigurationTarget.WorkspaceFolder);
        await filesConfig.update('watcherExclude', previousWatcherExclude, vscode.ConfigurationTarget.Workspace);
        await delay(250);
        assert.equal(await vscode.commands.executeCommand('diffTracker._testStartRecordingAfterPrechecks'), true);
        await until('Rules baseline after restoring watcher fixture',
            async () => (await state()).baselineState === 'ready');

        // A directly edited explicit exclusion is only a requested scope until
        // Apply. Pause new reads for the affected path, and if the request is
        // withdrawn surface the observed gap conservatively instead of silently
        // treating it as unchanged.
        const pendingExcludeDoc = await vscode.workspace.openTextDocument(uri('existing.txt'));
        await scopeConfig.update('watchExclude', [{ scope: 'all', pattern: 'existing.txt' }],
            vscode.ConfigurationTarget.Workspace);
        await delay(250);
        const excludedEdit = new vscode.WorkspaceEdit();
        excludedEdit.replace(
            uri('existing.txt'),
            new vscode.Range(
                pendingExcludeDoc.positionAt(0),
                pendingExcludeDoc.positionAt(pendingExcludeDoc.getText().length)
            ),
            'pending scope exclusion edit\n'
        );
        assert.equal(await vscode.workspace.applyEdit(excludedEdit), true);
        assert.equal(await pendingExcludeDoc.save(), true);
        await delay(500);
        const pausedReview = await pending('existing.txt');
        assert.equal(pausedReview?.reviewKind, 'unknown',
            'pending explicit exclusion must preserve the prior baseline as unverified review');
        assert.match(pausedReview?.unavailableReason ?? '', /pending explicit exclusion|paused.*exclusion/i);
        assert.equal((await state()).reviewTokens.some(token => token.filePath === uri('existing.txt').fsPath), false,
            'unverified pending-exclusion review must not expose a text action token');

        await scopeConfig.update('watchExclude', [], vscode.ConfigurationTarget.Workspace);
        const gapReview = await untilStable(
            'pending-scope gap becomes visible after request withdrawal',
            () => pending('existing.txt')
        );
        assert.equal(gapReview.reviewKind, 'unknown');
        assert.match(gapReview.unavailableReason ?? gapReview.reviewReason ?? '', /paused.*exclusion|requires review/i);

        const restoreEdit = new vscode.WorkspaceEdit();
        restoreEdit.replace(
            uri('existing.txt'),
            new vscode.Range(
                pendingExcludeDoc.positionAt(0),
                pendingExcludeDoc.positionAt(pendingExcludeDoc.getText().length)
            ),
            'base\n'
        );
        assert.equal(await vscode.workspace.applyEdit(restoreEdit), true);
        assert.equal(await pendingExcludeDoc.save(), true);
        await delay(300);
        assert.equal((await pending('existing.txt'))?.reviewKind, 'unknown',
            'ordinary reads must not silently erase a durable pending-scope coverage gap');
        assert.equal(await vscode.commands.executeCommand('diffTracker._testClearDiffs'), true);
        await untilStable('pending-scope gap clears only after explicit baseline rebuild',
            async () => (await state()).baselineState === 'ready' && !(await pending('existing.txt')));
        console.log('PASS HOST-S3 pending explicit exclusion preserves a conservative evidence gap');

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

        // Run #203 proved that a simple non-recursive VS Code RelativePattern
        // cannot be relied upon to recover this excluded subtree on Stable,
        // VS Code 1.80, Linux or Windows. Use an independently owned direct
        // watcher as the positive control for supplemental coverage instead.
        const directEvents = [];
        const directWatcher = fs.watch(excludedTree, { persistent: false }, (kind, filename) => {
            directEvents.push({ kind, filename: filename?.toString(), observedAt: Date.now() });
        });
        try {
            await delay(500);
            const directProbeName = 'direct-probe.txt';
            const directProbe = path.join(excludedTree, directProbeName);
            const directProbeFinalContent = 'direct supplemental probe\nfollow-up\n';
            const directProbeStartedAt = Date.now();
            fs.writeFileSync(directProbe, 'direct supplemental probe\n');
            await delay(250);
            fs.appendFileSync(directProbe, 'follow-up\n');
            try {
                await until('direct watcher coverage for watcherExclude subtree', () => {
                    const matchingNamedEvent = directEvents.some(event =>
                        event.filename &&
                        path.basename(event.filename).toLocaleLowerCase() === directProbeName.toLocaleLowerCase()
                    );
                    if (matchingNamedEvent) { return true; }

                    // Node explicitly permits fs.watch events without a filename.
                    // In this isolated probe directory, accept such an event only
                    // when it was observed after the probe started and the probe
                    // itself has reached the expected post-write state.
                    const unnamedProbeWindowEvent = directEvents.some(event =>
                        !event.filename && event.observedAt >= directProbeStartedAt
                    );
                    if (!unnamedProbeWindowEvent) { return false; }
                    try {
                        return fs.readFileSync(directProbe, 'utf8') === directProbeFinalContent;
                    } catch {
                        return false;
                    }
                }, 10_000);
            } catch (error) {
                throw new Error(`${error.message}; direct watcher events=${JSON.stringify(directEvents)}`);
            }
        } finally {
            directWatcher.close();
        }
        console.log('PASS HOST-WATCH-CONTRACT watcherExclude requires independently owned supplemental coverage');

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
        const binaryReview = await untilStable('binary addition read-only review', async () => {
            const current = await state();
            const filePath = uri('new-image.png').fsPath;
            const change = current.trackedChanges.find(item => item.filePath === filePath);
            return change?.reviewKind === 'opaque' &&
                !current.reviewTokens.some(token => token.filePath === filePath) ? change : undefined;
        });
        assert.equal(binaryReview.baselineExists, false);
        assert.equal(binaryReview.currentExists, true);
        assert.equal(binaryReview.currentSize, 6);
        assert.match(binaryReview.currentFingerprint ?? '', /^[a-f0-9]{64}$/);

        const initialBinaryBytes = Array.from(await vscode.workspace.fs.readFile(uri('new-image.png')));
        const acknowledged = await vscode.commands.executeCommand(
            'diffTracker._testAcknowledgeOpaque',
            uri('new-image.png').fsPath
        );
        assert.equal(acknowledged.status, 'success', acknowledged.reason);
        assert.deepEqual(Array.from(await vscode.workspace.fs.readFile(uri('new-image.png'))), initialBinaryBytes);
        await untilStable('opaque acknowledge clears review', async () => !(await pending('new-image.png')));
        console.log('PASS HOST-S2 Acknowledge advances binary identity without workspace mutation');

        await write('existing.txt', 'mixed accept text\n');
        const mixedAcceptBinary = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 2]);
        await vscode.workspace.fs.writeFile(uri('new-image.png'), mixedAcceptBinary);
        await untilStable('S2 mixed Accept text review', () => reviewablePending('existing.txt'));
        await untilStable('S2 mixed Accept opaque review', async () => (await pending('new-image.png'))?.reviewKind === 'opaque');
        const mixedAccept = await vscode.commands.executeCommand('diffTracker._testAcceptAllPending');
        assert.equal(mixedAccept.accepted, 1, JSON.stringify(mixedAccept));
        assert.equal(mixedAccept.acknowledged, 1, JSON.stringify(mixedAccept));
        assert.equal(mixedAccept.needsAttention, 0, JSON.stringify(mixedAccept));
        assert.equal(mixedAccept.succeeded, 2, JSON.stringify(mixedAccept));
        assert.equal(await read('existing.txt'), 'mixed accept text\n');
        assert.deepEqual(Array.from(await vscode.workspace.fs.readFile(uri('new-image.png'))), Array.from(mixedAcceptBinary));
        await untilStable('S2 mixed Accept clears handled reviews', async () =>
            !(await pending('existing.txt')) && !(await pending('new-image.png')));
        console.log('PASS HOST-S2 mixed Accept keeps text and acknowledges opaque identity');

        await write('existing.txt', 'mixed revert text\n');
        const mixedRevertBinary = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 3]);
        await vscode.workspace.fs.writeFile(uri('new-image.png'), mixedRevertBinary);
        await untilStable('S2 mixed Revert text review', () => reviewablePending('existing.txt'));
        await untilStable('S2 mixed Revert opaque review', async () => (await pending('new-image.png'))?.reviewKind === 'opaque');
        const mixedRevert = await vscode.commands.executeCommand('diffTracker._testRevertAllPending');
        assert.equal(mixedRevert.reverted, 1, JSON.stringify(mixedRevert));
        assert.equal(mixedRevert.needsConfirmation, 1, JSON.stringify(mixedRevert));
        assert.equal(mixedRevert.needsAttention, 0, JSON.stringify(mixedRevert));
        assert.equal(await read('existing.txt'), 'mixed accept text\n');
        assert.deepEqual(Array.from(await vscode.workspace.fs.readFile(uri('new-image.png'))), Array.from(mixedRevertBinary));
        assert.equal((await pending('new-image.png'))?.reviewKind, 'opaque');
        assert.equal(await pending('existing.txt'), undefined);
        console.log('PASS HOST-S2 mixed Revert mutates text only and retains opaque review');

        assert.equal(
            (await vscode.commands.executeCommand('diffTracker._testAcknowledgeOpaque', uri('new-image.png').fsPath)).status,
            'success'
        );
        await untilStable('S2 opaque cleanup acknowledgement', async () => !(await pending('new-image.png')));
        await vscode.workspace.fs.delete(uri('new-image.png'));
        await untilStable('S2 opaque deletion review', async () => (await pending('new-image.png'))?.reviewKind === 'opaque');
        assert.equal(
            (await vscode.commands.executeCommand('diffTracker._testAcknowledgeOpaque', uri('new-image.png').fsPath)).status,
            'success'
        );
        assert.equal(await missing('new-image.png'), true);
        await untilStable('S2 acknowledged opaque deletion clears review', async () => !(await pending('new-image.png')));

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
        assert.equal(await vscode.commands.executeCommand('diffTracker._testClearDiffs'), true);
        assert.equal((await state()).isRecording, false);
        assert.equal((await state()).trackedChanges.length, 0);
        assert.equal((await state()).reviewTokens.length, 0);
        assert.equal(await read('batch-a.txt'), 'stopped clear preserves disk\n');
        console.log('PASS HOST-REVIEW stopped clear command preserves disk and recording state');
        await require('./audit.test.cjs')(workspacePath);
};
