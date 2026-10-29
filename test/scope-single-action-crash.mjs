import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Abrupt child exits exercise actual session files. The shared harness mocks
// VS Code/native events; no orderly Dispose can repair the interrupted write.
export function registerScopeSingleActionCrashes(h, fixture, scopeFor, withController) {
    const {test, Uri, DiffTracker, vscode} = h;
    const driver = 'A5 CRASH DRIVER single-action barriers';
    if (process.env.DT_A5_CRASH_DRIVER === '1') {
        test(driver, () => fixture(async ({tracker, dir, scope}) => {
            const selected = path.join(dir, 'selected'), needed = path.join(dir, 'needed');
            fs.mkdirSync(selected); fs.mkdirSync(needed);
            const target = path.join(selected, 'tracked.txt'), included = path.join(needed, 'tracked.txt');
            const other = path.join(dir, 'other.txt');
            fs.writeFileSync(target, 'selected original'); fs.writeFileSync(included, 'released original');
            fs.writeFileSync(other, 'other original');
            h.setVsCodeExcludes({'files.watcherExclude': {'needed/**':true}});
            assert.equal((await tracker.applyConfiguredMonitoringScope(scope)).status, 'applied');
            const excluded = scopeFor(tracker, 'wholeWorkspace', [{scope:'all',pattern:'/needed/'}]);
            assert.equal((await tracker.applyConfiguredMonitoringScope(excluded)).status, 'applied');
            fs.writeFileSync(target, 'selected pending'); await tracker.readFileAndUpdate(target, Uri.file(target));
            fs.writeFileSync(other, 'other pending'); await tracker.readFileAndUpdate(other, Uri.file(other));
            fs.writeFileSync(included, 'fresh authorized baseline');
            tracker.setSubtreeCoverageGap(needed, 'supplemental-watcher-directory-change-gap', 'Unverified released interval');
            assert.equal(await tracker.flushPendingPersistence(), true);
            const barrier = process.env.DT_A5_CRASH_BARRIER;
            await withController(tracker, excluded, async ({controller, config, hooks}) => {
                const cut = () => {
                    fs.writeFileSync(process.env.DT_A5_CRASH_MANIFEST, JSON.stringify({
                        harnessRoot:path.dirname(dir), dir, storage:tracker.storageUri.fsPath,
                        requested:{mode:config.monitoringScope,includes:config.watchInclude,excludes:config.watchExclude}
                    }));
                    process.exit(86);
                };
                if (barrier === 'settings') { hooks.afterWrite = key => { if (key === 'watchExclude') { cut(); } }; }
                if (barrier === 'applied') { controller.finalizeScopeOperation = async () => cut(); }
                const recheck = tracker.recheckScopeOperationCoverage.bind(tracker);
                let verifying = false;
                tracker.recheckScopeOperationCoverage = (...args) => {
                    if (barrier === 'verification') { cut(); }
                    verifying = true;
                    return recheck(...args);
                };
                const copy = vscode.workspace.fs.copy;
                vscode.workspace.fs.copy = async (...args) => {
                    if (verifying && tracker.baselineTransaction && path.basename(args[0].fsPath) === 'session-state.json') {
                        if (barrier === 'before-copy') { cut(); }
                        const result = await copy(...args);
                        if (barrier === 'after-copy') { cut(); }
                        return result;
                    }
                    return copy(...args);
                };
                await controller.saveAndApplyScope({mode:'wholeWorkspace',includes:[],excludes:[{scope:'all',pattern:'/selected/'}]}, async () => true);
                throw new Error(`Crash barrier was not reached: ${barrier}`);
            });
        }));
        return;
    }

    for (const barrier of ['settings','applied','verification','before-copy','after-copy']) {
        test(`A5 CRASH ${barrier} ${barrier.includes('copy') ? 'retains interrupted storage guard' : 'restores scope integrity and continued observation'}`, () => fixture(async ({tracker}) => {
            const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'difftracker-a5-crash-'));
            const manifestPath = path.join(artifacts, 'manifest.json');
            let manifest;
            const folders = vscode.workspace.workspaceFolders, getFolder = vscode.workspace.getWorkspaceFolder;
            const read = vscode.workspace.fs.readFile, open = fs.promises.opendir;
            try {
                const child = spawnSync(process.execPath, ['test/tracker-safety.mjs'], {
                    cwd:process.cwd(), encoding:'utf8', timeout:30_000, maxBuffer:1024*1024,
                    env:{...process.env,DT_TEST_FILTER:driver,DT_A5_CRASH_DRIVER:'1',DT_A5_CRASH_BARRIER:barrier,DT_A5_CRASH_MANIFEST:manifestPath}
                });
                assert.equal(child.status, 86, `${child.error ?? ''}\n${child.stdout}\n${child.stderr}`);
                manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                assert.equal(path.dirname(manifest.harnessRoot), os.tmpdir());
                assert.ok(path.basename(manifest.harnessRoot).startsWith('difftracker-safety-'));
                const selected = path.join(manifest.dir, 'selected'), needed = path.join(manifest.dir, 'needed');
                const target = path.join(selected, 'tracked.txt'), included = path.join(needed, 'tracked.txt');
                const other = path.join(manifest.dir, 'other.txt');
                await tracker.dispose();
                const folder = {name:'pr12-audit',uri:Uri.file(manifest.dir),index:0};
                vscode.workspace.workspaceFolders = [folder];
                vscode.workspace.getWorkspaceFolder = uri => {
                    const relative = path.relative(manifest.dir, uri.fsPath);
                    return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ? folder : undefined;
                };
                h.setVsCodeExcludes({'files.watcherExclude': {'needed/**':true}});
                const recovered = new DiffTracker(Uri.file(manifest.storage)); h.setTracker(recovered);
                vscode.workspace.fs.readFile = async (uri, ...args) => {
                    assert.notEqual(uri.fsPath, target, 'saved or committed exclusion protects content during startup');
                    return read(uri, ...args);
                };
                fs.promises.opendir = async (directory, ...args) => {
                    assert.notEqual(path.resolve(String(directory)), selected, 'restart never enumerates the excluded subtree');
                    return open(directory, ...args);
                };
                // Match activation: requested-scope protection exists BEFORE
                // restore reads persisted baselines or discovers current files.
                await withController(recovered, manifest.requested, async ({controller}) => {
                    const interrupted = ['before-copy','after-copy'].includes(barrier);
                    const protectedFiles = ['session-state.json','session-state.last-good.json','session-state.unsaved'];
                    const diskBefore = new Map(protectedFiles.map(name => [name, fs.existsSync(path.join(manifest.storage,name)) ? fs.readFileSync(path.join(manifest.storage,name)) : undefined]));
                    const restored = await recovered.restorePersistedState();
                    if (interrupted) {
                        // An interrupted durable write keeps the existing storage
                        // guard. Recovery must not erase its marker or guess which
                        // candidate committed, even if both JSON files parse.
                        assert.equal(restored, 'blocked');
                        assert.equal(recovered.getIsRecording(), false);
                        assert.match(recovered.getPersistenceIssue(), /could not be saved completely/);
                        const outcome = await controller.saveAndApplyScope(manifest.requested, async () => true);
                        assert.notEqual(outcome.status, 'applied');
                        for (const [name,bytes] of diskBefore) {
                            if (bytes) { assert.deepEqual(fs.readFileSync(path.join(manifest.storage,name)), bytes); }
                        }
                        const primary = JSON.parse(diskBefore.get('session-state.json').toString());
                        assert.equal(new Map(primary.fileSnapshots).get(other), 'other original');
                        assert.equal(fs.readFileSync(target,'utf8'), 'selected pending');
                        assert.equal(fs.readFileSync(other,'utf8'), 'other pending');
                        return;
                    }
                    assert.ok(['restored','recovered'].includes(restored), JSON.stringify({restored,issue:recovered.getPersistenceIssue(),marker:fs.existsSync(path.join(manifest.storage,'session-state.unsaved'))}));
                    controller.reconcileRequestedScope();
                    assert.equal(recovered.getOriginalContent(other), 'other original');
                    assert.equal(recovered.getTrackedChange(other)?.currentContent, 'other pending');
                    assert.equal(recovered.getOriginalContent(target), barrier === 'settings' ? 'selected original' : undefined);
                    let approvals = 0;
                    const outcome = await controller.saveAndApplyScope(manifest.requested, async () => { approvals++; return true; });
                    assert.equal(outcome.status, 'applied', JSON.stringify(outcome));
                    assert.equal(approvals, barrier === 'settings' ? 1 : 0, 'a committed discard must not be approved twice');
                    assert.equal(recovered.getOriginalContent(target), undefined);
                    assert.equal(recovered.getTrackedChange(target), undefined);
                    assert.equal(recovered.getOriginalContent(included), 'fresh authorized baseline');
                    assert.equal(fs.readFileSync(target, 'utf8'), 'selected pending');
                    assert.equal(fs.readFileSync(other, 'utf8'), 'other pending');
                    const owner = [...h.nativeDirectoryWatchers].reverse().find(item => item.active && path.resolve(String(item.directory)) === needed);
                    assert.ok(owner, 'restored included directory has a live future owner');
                    fs.writeFileSync(included, 'native edit after crash recovery'); owner.listener('change', 'tracked.txt');
                    await h.waitUntil(() => recovered.getTrackedChange(included)?.currentContent === 'native edit after crash recovery');
                    assert.equal(recovered.getOriginalContent(included), 'fresh authorized baseline');
                    assert.equal(await recovered.flushPendingPersistence(), true);
                }, {expectBlockedPolicy:true});
            } finally {
                vscode.workspace.fs.readFile = read; fs.promises.opendir = open;
                await h.getTracker().dispose();
                vscode.workspace.workspaceFolders = folders; vscode.workspace.getWorkspaceFolder = getFolder;
                if (manifest?.harnessRoot && path.dirname(manifest.harnessRoot) === os.tmpdir() &&
                    path.basename(manifest.harnessRoot).startsWith('difftracker-safety-')) { fs.rmSync(manifest.harnessRoot, {recursive:true,force:true}); }
                fs.rmSync(artifacts, {recursive:true,force:true});
            }
        }));
    }
}
