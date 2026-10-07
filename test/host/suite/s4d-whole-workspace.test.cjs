const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

// Seed before Rules starts and before recording Whole Workspace Apply. Every
// directory already exists when coverage is installed; these are ordinary
// unopened-file events, not imported-directory or editor-event substitutes.
module.exports = async function prepareWholeWorkspaceProof({
    workspacePath, secondRoot, primaryFolder, state, untilStable, delay
}) {
    const fixtureRoot = 's4d-whole-workspace';
    const cohorts = ['normal', 'git-ignored', 'watcher-excluded'];
    const fixtures = [];
    const fingerprint = bytes => createHash('sha256').update(bytes).digest('hex');
    for (const cohort of cohorts) {
        fs.mkdirSync(path.join(workspacePath, fixtureRoot, cohort), { recursive: true });
        for (const kind of ['text', 'opaque']) {
            for (const operation of ['create', 'modify', 'delete']) {
                const relativePath = `${fixtureRoot}/${cohort}/${operation}.${kind === 'text' ? 'txt' : 'png'}`;
                const filePath = vscode.Uri.file(path.join(workspacePath, relativePath)).fsPath;
                const before = kind === 'text'
                    ? `${cohort} ${operation} baseline\n`
                    : Buffer.from(`\0${cohort} ${operation} baseline`);
                const after = kind === 'text'
                    ? `${cohort} ${operation} after\n`
                    : Buffer.from(`\0${cohort} ${operation} after`);
                assert.equal(fs.existsSync(filePath), false, `${relativePath} fixture must start absent`);
                if (operation !== 'create') { fs.writeFileSync(filePath, before); }
                fixtures.push({ cohort, kind, operation, relativePath, filePath, before, after });
            }
        }
    }
    fs.writeFileSync(path.join(workspacePath, fixtureRoot, '.gitignore'), '/git-ignored/\n');
    const ignored = execFileSync('git', [
        '-c', 'core.quotePath=false', 'check-ignore', '--no-index', '--',
        ...fixtures.map(fixture => fixture.relativePath)
    ], { cwd: workspacePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.deepEqual(ignored.trim().split(/\r?\n/).sort(),
        fixtures.filter(fixture => fixture.cohort === 'git-ignored')
            .map(fixture => fixture.relativePath).sort(),
        'Git must really ignore exactly the Git-ignored cohort, including absent creation paths');

    // A workspace-wide literal would also require this target in secondRoot.
    // Scope the exclusion to the primary folder, where its directory exists.
    const watcherPattern = `${fixtureRoot}/watcher-excluded/**`;
    const filesConfig = vscode.workspace.getConfiguration('files', primaryFolder.uri);
    const previousWatcherExclude = filesConfig.inspect('watcherExclude')?.workspaceFolderValue;
    await filesConfig.update('watcherExclude', {
        ...previousWatcherExclude, [watcherPattern]: true
    }, vscode.ConfigurationTarget.WorkspaceFolder);
    assert.equal(vscode.workspace.getConfiguration('files', primaryFolder.uri)
        .get('watcherExclude', {})[watcherPattern], true);
    assert.notEqual(vscode.workspace.getConfiguration('files', vscode.Uri.file(secondRoot))
        .get('watcherExclude', {})[watcherPattern], true,
        'the concrete host exclusion must not introduce a missing target in the second root');
    // Folder settings and the nested .gitignore are real workspace writes.
    // Settle their policy/watcher events before any scope preparation starts.
    await delay(500);

    const original = filePath => vscode.commands.executeCommand('diffTracker._testOriginalContent', filePath);
    const assertMode = (current, mode) => {
        assert.equal(current.isRecording, true);
        assert.equal(current.baselineState, 'ready');
        assert.equal(current.effectiveMonitoringScope.mode, mode);
    };
    return {
        async assertRulesBaseline() {
            const current = await state();
            assertMode(current, 'rules');
            for (const fixture of fixtures) {
                assert.equal(current.trackedChanges.some(change => change.filePath === fixture.filePath), false,
                    `${fixture.relativePath} must be clean before expansion`);
                if (fixture.kind === 'text') {
                    assert.equal(await original(fixture.filePath),
                        fixture.cohort === 'normal' && fixture.operation !== 'create' ? fixture.before : undefined,
                        `${fixture.relativePath}: Rules must exclude ordinary-policy-hidden baselines`);
                }
            }
        },

        async assertObservedChanges() {
            const baseline = await state();
            assertMode(baseline, 'wholeWorkspace');
            for (const fixture of fixtures) {
                assert.equal(vscode.workspace.textDocuments.some(document => document.uri.fsPath === fixture.filePath),
                    false, `${fixture.relativePath} must remain unopened`);
                assert.equal(baseline.trackedChanges.some(change => change.filePath === fixture.filePath), false,
                    `${fixture.relativePath} must have no pending change before the filesystem mutation`);
                assert.equal(fs.existsSync(fixture.filePath), fixture.operation !== 'create');
                assert.equal(await original(fixture.filePath),
                    fixture.kind === 'text' && fixture.operation !== 'create' ? fixture.before : undefined,
                    `${fixture.relativePath}: Apply must establish existing text before-images only`);
            }

            for (const fixture of fixtures) {
                if (fixture.operation === 'delete') { fs.unlinkSync(fixture.filePath); }
                else { fs.writeFileSync(fixture.filePath, fixture.after); }
            }
            // One bounded observation wait covers all 18 outcomes. No reset,
            // rescan, reopen, mode switch or synthetic event may deliver them.
            const observed = await untilStable('S4-D Whole Workspace text/opaque create/modify/delete across three path classes', async () => {
                const current = await state();
                assert.equal(current.isRecording, true);
                assert.equal(current.effectiveMonitoringScope.mode, 'wholeWorkspace');
                // New-file absence provenance passes through completeBaseline(),
                // which reports building while it durably publishes the evidence.
                // Keep the original bounded wait and require stable Ready at the
                // result, rather than failing on an intermediate publication.
                if (current.baselineState !== 'ready') { return undefined; }
                const changes = new Map(current.trackedChanges.map(change => [change.filePath, change]));
                return fixtures.every(fixture => {
                    const change = changes.get(fixture.filePath);
                    if (!change || change.reviewKind !== fixture.kind || change.unavailableReason ||
                        change.currentExists !== (fixture.operation !== 'delete')) { return false; }
                    return fixture.kind === 'text'
                        ? change.currentContent === (fixture.operation === 'delete' ? '' : fixture.after) &&
                            current.reviewTokens.some(token => token.filePath === fixture.filePath)
                        : change.currentFingerprint === (fixture.operation === 'delete' ? undefined : fingerprint(fixture.after)) &&
                            current.opaqueReviewTokens.some(token => token.filePath === fixture.filePath);
                }) ? current : undefined;
            });
            assertMode(observed, 'wholeWorkspace');
            for (const fixture of fixtures) {
                const change = observed.trackedChanges.find(item => item.filePath === fixture.filePath);
                const existed = fixture.operation !== 'create';
                const exists = fixture.operation !== 'delete';
                assert.equal(change.baselineExists, existed, `${fixture.relativePath}: baseline membership`);
                assert.equal(change.currentExists, exists, `${fixture.relativePath}: current existence`);
                assert.equal(change.isDeleted, !exists, `${fixture.relativePath}: deletion classification`);
                if (fixture.kind === 'text') {
                    assert.equal(change.originalContent, existed ? fixture.before : '');
                    assert.equal(change.currentContent, exists ? fixture.after : '');
                } else {
                    // Exact before-identity proves modify/delete used the
                    // baseline captured before mutation, not a new creation.
                    assert.equal(change.baselineFingerprint, existed ? fingerprint(fixture.before) : undefined);
                    assert.equal(change.baselineSize, existed ? fixture.before.length : undefined);
                    assert.equal(change.currentFingerprint, exists ? fingerprint(fixture.after) : undefined);
                    assert.equal(change.currentSize, exists ? fixture.after.length : undefined);
                    assert.equal(change.originalContent, '');
                    assert.equal(change.currentContent, '');
                    assert.deepEqual(change.changes, []);
                    assert.equal(observed.reviewTokens.some(token => token.filePath === fixture.filePath), false,
                        `${fixture.relativePath}: opaque identity must not expose a text action token`);
                    // Newly created opaque files retain the existing empty-string
                    // known-absence sentinel, not a prior content snapshot.
                    assert.equal(await original(fixture.filePath), existed ? undefined : '',
                        `${fixture.relativePath}: opaque review preserves only its existing baseline representation`);
                }
            }
            assert.equal((await state()).effectiveMonitoringScope.mode, 'wholeWorkspace');
            console.log('PASS HOST-S4-D Whole Workspace observes unopened text/opaque create/modify/delete in normal, Git-ignored and watcher-excluded paths (18 outcomes)');

            // Existing mixed Accept tests later assert exact global counts.
            // Use the confirmed Clear seam while the fixture still has coverage.
            assert.equal(await vscode.commands.executeCommand('diffTracker._testClearDiffs'), true);
            let lastCleanupState;
            try {
                await untilStable('S4-D cohort cleared before subsequent Host scenarios', async () => {
                    const current = await state();
                    lastCleanupState = current;
                    return current.baselineState === 'ready' && current.trackedChanges.length === 0;
                });
            } catch (error) {
                // Passive evidence only: preserve the original timeout and never
                // retry Clear or turn a safely retained unknown into a pass.
                console.error('S4-D post-Clear last observed state:', JSON.stringify(lastCleanupState && {
                    isRecording: lastCleanupState.isRecording,
                    baselineState: lastCleanupState.baselineState,
                    effectiveMonitoringScope: lastCleanupState.effectiveMonitoringScope,
                    trackedChanges: lastCleanupState.trackedChanges.map(change => ({
                        filePath: change.filePath, reviewKind: change.reviewKind,
                        reviewReason: change.reviewReason, unavailableReason: change.unavailableReason,
                        baselineExists: change.baselineExists, currentExists: change.currentExists
                    })),
                    unknownReviewPaths: lastCleanupState.unknownReviewPaths,
                    coverageGaps: lastCleanupState.coverageGaps,
                    subtreeCoverageGaps: lastCleanupState.subtreeCoverageGaps,
                    reviewTokenCount: lastCleanupState.reviewTokens.length,
                    opaqueReviewTokenCount: lastCleanupState.opaqueReviewTokens.length
                }));
                throw error;
            }
        },

        async restoreWatcherExclude() {
            assert.equal((await state()).isRecording, false, 'restore fixture settings only while stopped');
            await filesConfig.update('watcherExclude', previousWatcherExclude,
                vscode.ConfigurationTarget.WorkspaceFolder);
        }
    };
};
