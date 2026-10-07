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
    assert.equal((await state()).isRecording, false, 'prepare S4 fixtures only while stopped');
    const fixtureRoot = 's4d-whole-workspace';
    const watcherTarget = path.join(workspacePath, fixtureRoot, 'watcher-excluded');
    assert.ok(fs.existsSync(watcherTarget) && fs.statSync(watcherTarget).isDirectory(),
        'launcher must preseed the concrete S4 watcher directory before the prepare Host');
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
    // The launcher seeds the final primary-folder setting between Host processes.
    // Assert it here: updating it in this Host can leave delayed settings events
    // that correctly invalidate the subsequent scope transaction.
    const watcherPattern = `${fixtureRoot}/watcher-excluded/**`;
    const filesConfig = vscode.workspace.getConfiguration('files', primaryFolder.uri);
    assert.equal(filesConfig.inspect('watcherExclude')?.workspaceFolderValue?.[watcherPattern], true,
        'launcher must preseed the S4 exclusion at the primary folder level');
    assert.equal(vscode.workspace.getConfiguration('files', primaryFolder.uri)
        .get('watcherExclude', {})[watcherPattern], true);
    assert.notEqual(vscode.workspace.getConfiguration('files', vscode.Uri.file(secondRoot))
        .get('watcherExclude', {})[watcherPattern], true,
        'the concrete host exclusion must not introduce a missing target in the second root');
    // Preserve the existing settling interval for the remaining fixture writes.
    // This delay is not a guarantee that filesystem event queues are drained.
    await delay(500);

    const original = filePath => vscode.commands.executeCommand('diffTracker._testOriginalContent', filePath);
    const textEvidence = value => typeof value === 'string'
        ? { utf8Bytes: Buffer.byteLength(value), fingerprint: fingerprint(Buffer.from(value)) }
        : null;
    const changeEvidence = change => change ? {
        filePath: change.filePath, reviewKind: change.reviewKind,
        reviewReason: change.reviewReason, unavailableReason: change.unavailableReason,
        baselineExists: change.baselineExists, currentExists: change.currentExists,
        isDeleted: change.isDeleted,
        originalText: textEvidence(change.originalContent), currentText: textEvidence(change.currentContent),
        baselineFingerprint: change.baselineFingerprint ?? null, currentFingerprint: change.currentFingerprint ?? null,
        baselineSize: change.baselineSize ?? null, currentSize: change.currentSize ?? null
    } : null;
    const contextEvidence = current => current ? {
        isRecording: current.isRecording, baselineState: current.baselineState,
        effectiveMonitoringScope: current.effectiveMonitoringScope,
        policyFingerprint: current.policyFingerprint, coverageGeneration: current.coverageGeneration,
        gitPauses: current.gitPauses, unknownReviewPaths: current.unknownReviewPaths,
        retainedReviewPaths: current.retainedReviewPaths,
        coverageGaps: current.coverageGaps, subtreeCoverageGaps: current.subtreeCoverageGaps,
        trackedChangeCount: current.trackedChanges.length,
        reviewTokenCount: current.reviewTokens.length, opaqueReviewTokenCount: current.opaqueReviewTokens.length
    } : null;
    const diskEvidence = filePath => {
        // Failure-only and read-only: inspect just the 18 known fixture paths,
        // with at most one bounded content read per regular file. Never open a
        // document, rescan through the tracker, or follow a fixture symlink.
        let descriptor, evidence;
        try {
            const stat = fs.lstatSync(filePath);
            evidence = {
                exists: true, type: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' :
                    stat.isSymbolicLink() ? 'symlink' : 'other',
                size: stat.size, mode: stat.mode, mtimeMs: stat.mtimeMs,
                ctimeMs: stat.ctimeMs, birthtimeMs: stat.birthtimeMs
            };
            if (!stat.isFile()) { return evidence; }
            const readLimit = 64 * 1024;
            descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
            const before = fs.fstatSync(descriptor);
            const bytes = Buffer.alloc(readLimit + 1);
            const bytesRead = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
            const after = fs.fstatSync(descriptor);
            const stable = before.isFile() && before.dev === stat.dev && before.ino === stat.ino &&
                before.size === stat.size && before.mtimeMs === stat.mtimeMs && before.ctimeMs === stat.ctimeMs &&
                before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
            return { ...evidence, bytesRead, readLimit, stable,
                fingerprint: stable && bytesRead === before.size && bytesRead <= readLimit
                    ? fingerprint(bytes.subarray(0, bytesRead)) : null,
                contentReadComplete: stable && bytesRead === before.size && bytesRead <= readLimit };
        } catch (error) {
            return { ...evidence, exists: error.code === 'ENOENT' ? false : evidence?.exists ?? null,
                error: { code: error.code, message: error.message } };
        } finally {
            if (descriptor !== undefined) {
                try { fs.closeSync(descriptor); } catch { /* Diagnostics cannot replace the original failure. */ }
            }
        }
    };
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
            const baselineOriginals = new Map();
            assertMode(baseline, 'wholeWorkspace');
            for (const fixture of fixtures) {
                assert.equal(vscode.workspace.textDocuments.some(document => document.uri.fsPath === fixture.filePath),
                    false, `${fixture.relativePath} must remain unopened`);
                assert.equal(baseline.trackedChanges.some(change => change.filePath === fixture.filePath), false,
                    `${fixture.relativePath} must have no pending change before the filesystem mutation`);
                assert.equal(fs.existsSync(fixture.filePath), fixture.operation !== 'create');
                const baselineOriginal = await original(fixture.filePath);
                baselineOriginals.set(fixture.filePath, textEvidence(baselineOriginal));
                assert.equal(baselineOriginal,
                    fixture.kind === 'text' && fixture.operation !== 'create' ? fixture.before : undefined,
                    `${fixture.relativePath}: Apply must establish existing text before-images only`);
            }

            for (const fixture of fixtures) {
                if (fixture.operation === 'delete') { fs.unlinkSync(fixture.filePath); }
                else { fs.writeFileSync(fixture.filePath, fixture.after); }
            }
            // One bounded observation wait covers all 18 outcomes. No reset,
            // rescan, reopen, mode switch or synthetic event may deliver them.
            let observed, lastObservedState, lastObservedAt;
            let observationCount = 0, readyObservationCount = 0, matchingObservationCount = 0;
            let firstMatchingObservationAt, lastMatchingObservationAt;
            const observationStartedAt = Date.now();
            try {
                observed = await untilStable('S4-D Whole Workspace text/opaque create/modify/delete across three path classes', async () => {
                    const current = await state();
                    lastObservedState = current;
                    lastObservedAt = Date.now();
                    observationCount++;
                    assert.equal(current.isRecording, true);
                    assert.equal(current.effectiveMonitoringScope.mode, 'wholeWorkspace');
                    // New-file absence provenance passes through completeBaseline(),
                    // which reports building while it durably publishes the evidence.
                    // Keep the original bounded wait and require stable Ready at the
                    // result, rather than failing on an intermediate publication.
                    if (current.baselineState !== 'ready') { return undefined; }
                    readyObservationCount++;
                    const changes = new Map(current.trackedChanges.map(change => [change.filePath, change]));
                    const matches = fixtures.every(fixture => {
                        const change = changes.get(fixture.filePath);
                        if (!change || change.reviewKind !== fixture.kind || change.unavailableReason ||
                            change.currentExists !== (fixture.operation !== 'delete')) { return false; }
                        return fixture.kind === 'text'
                            ? change.currentContent === (fixture.operation === 'delete' ? '' : fixture.after) &&
                                current.reviewTokens.some(token => token.filePath === fixture.filePath)
                            : change.currentFingerprint === (fixture.operation === 'delete' ? undefined : fingerprint(fixture.after)) &&
                                current.opaqueReviewTokens.some(token => token.filePath === fixture.filePath);
                    });
                    if (matches) {
                        matchingObservationCount++;
                        firstMatchingObservationAt ??= lastObservedAt;
                        lastMatchingObservationAt = lastObservedAt;
                    }
                    return matches ? current : undefined;
                });
            } catch (error) {
                try {
                    const current = lastObservedState;
                    const changes = new Map((current?.trackedChanges ?? []).map(change => [change.filePath, change]));
                    const fixturePaths = new Set(fixtures.map(fixture => fixture.filePath));
                    const unrelated = (current?.trackedChanges ?? []).filter(change => !fixturePaths.has(change.filePath));
                    const rows = fixtures.map(fixture => {
                        const change = changes.get(fixture.filePath);
                        const existed = fixture.operation !== 'create';
                        const exists = fixture.operation !== 'delete';
                        const textToken = !!current?.reviewTokens.some(token => token.filePath === fixture.filePath);
                        const opaqueToken = !!current?.opaqueReviewTokens.some(token => token.filePath === fixture.filePath);
                        const clauses = {
                            ready: current?.baselineState === 'ready', present: !!change,
                            reviewKind: change?.reviewKind === fixture.kind,
                            available: !!change && !change.unavailableReason,
                            currentExists: change?.currentExists === exists,
                            currentIdentity: fixture.kind === 'text'
                                ? !!change && change.currentContent === (exists ? fixture.after : '')
                                : !!change && change.currentFingerprint === (exists ? fingerprint(fixture.after) : undefined),
                            token: fixture.kind === 'text' ? textToken : opaqueToken
                        };
                        return {
                            path: fixture.relativePath, cohort: fixture.cohort, kind: fixture.kind, operation: fixture.operation,
                            expected: { baselineExists: existed, currentExists: exists, isDeleted: !exists,
                                originalText: fixture.kind === 'text' ? textEvidence(existed ? fixture.before : '') : null,
                                currentText: fixture.kind === 'text' ? textEvidence(exists ? fixture.after : '') : null,
                                baselineFingerprint: existed ? fingerprint(fixture.before) : null,
                                currentFingerprint: exists ? fingerprint(fixture.after) : null,
                                baselineSize: existed ? Buffer.byteLength(fixture.before) : null,
                                currentSize: exists ? Buffer.byteLength(fixture.after) : null,
                                tokenKind: fixture.kind },
                            observed: changeEvidence(change), textToken, opaqueToken,
                            clauses, mismatches: Object.keys(clauses).filter(key => !clauses[key]),
                            baselineOriginalBeforeMutation: baselineOriginals.get(fixture.filePath),
                            disk: diskEvidence(fixture.filePath)
                        };
                    });
                    console.error('S4-D observation failure evidence:', JSON.stringify({
                        runtime: { vscode: vscode.version, platform: process.platform, node: process.version },
                        observation: { startedAt: observationStartedAt, lastObservedAt, failedAt: Date.now(),
                            observationCount, readyObservationCount, matchingObservationCount,
                            firstMatchingObservationAt, lastMatchingObservationAt },
                        baseline: contextEvidence(baseline), lastObserved: contextEvidence(current), rows,
                        unrelatedPendingCount: unrelated.length,
                        unrelatedPending: unrelated.slice(0, 64).map(changeEvidence),
                        unrelatedPendingTruncated: unrelated.length > 64,
                        limitation: 'Public tracker snapshots and bounded fixture disk reads only; native callbacks and watcher ownership are not traced.'
                    }));
                } catch (diagnosticError) {
                    console.error('S4-D observation diagnostic failed:', diagnosticError);
                }
                throw error;
            }
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
            const remaining = { ...filesConfig.inspect('watcherExclude')?.workspaceFolderValue };
            delete remaining[watcherPattern];
            await filesConfig.update('watcherExclude', Object.keys(remaining).length ? remaining : undefined,
                vscode.ConfigurationTarget.WorkspaceFolder);
        }
    };
};
