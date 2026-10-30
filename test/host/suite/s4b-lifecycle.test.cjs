// Native-only coverage first, followed by the real mixed native/Host sources
// installed by public Recheck. The final identity test stays native-only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');
const { DiffTracker } = require('../../../out/diffTracker.js');
const { validateAndCanonicalizeScope } = require('../../../out/monitoringScope.js');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(description, predicate, diagnostics) {
    const deadline = Date.now() + 15000;
    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for ${description}${diagnostics ? `: ${JSON.stringify(diagnostics())}` : ''}`);
        }
        await delay(50);
    }
}

async function directoryChangeHost(workspace) {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'difftracker-directory-change-host-'));
    const root = vscode.Uri.file(path.join(workspace, 's4b-change-owner')).fsPath;
    const child = path.join(root, 'existing');
    const target = path.join(child, 'tracked.txt');
    const nativeUnknownTarget = path.join(child, 'unproven.txt');
    const sibling = path.join(root, 'sibling.txt');
    const liveTargets=Array.from({length:3},(_,index)=>path.join(root,`live-${index}`,'tracked.txt'));
    const tracker = new DiffTracker(vscode.Uri.file(storage));
    const nativeWatch = fs.watch;
    const nativeLstat = fs.lstatSync;
    let observedNotifications = 0;
    const notifications = [];
    const nativeFileNotifications = new Map();
    const providerFallbacks = [];
    let traceRecurrence = false;
    const directoryTrace = [];
    const relativeTracePath = target => tracker.pathBelongsToRoot(target,root)
        ? path.relative(root,target) : tracker.pathBelongsToRoot(root,target) ? '[ancestor]' : '[outside fixture]';
    const scopedTracePath = target => !tracker.pathBelongsToRoot(target,child) &&
        (tracker.pathBelongsToRoot(target,root) || tracker.pathBelongsToRoot(root,target) ||
        (path.dirname(target)===path.dirname(root) && path.basename(target).startsWith(`${path.basename(root)}-incoming-`)));
    const providerTrace = [];
    const policyTrace = [];
    const runtimePublicationCallers = {};
    const createdDirectoryIdentities = new Map();
    const observedCreationMatches = directory => {
        const creation = createdDirectoryIdentities.get(directory);
        if (!creation || creation.epoch!==tracker.sessionEpoch) { return false; }
        try {
            const current = fs.lstatSync(directory,{bigint:true});
            return current.isDirectory() && current.dev===creation.identity.dev && current.ino===creation.identity.ino &&
                current.birthtimeNs===creation.identity.birthtimeNs;
        } catch { return false; }
    };
    const ignoredPath = tracker.isPathIgnored;
    tracker.isPathIgnored = function(uri,...args) {
        const result = ignoredPath.call(this,uri,...args);
        if (traceRecurrence && scopedTracePath(uri.fsPath) && policyTrace.length<24) {
            policyTrace.push({path:relativeTracePath(uri.fsPath),directory:args[0]===true,ignored:result});
        }
        return result;
    };
    const providerApi = vscode.workspace.fs, providerStat = providerApi.stat;
    const providerDescriptor = Object.getOwnPropertyDescriptor(providerApi,'stat');
    const providerTracing = providerDescriptor?.writable === true;
    if (providerTracing) {
        providerApi.stat = function(uri,...args) {
            const trace = traceRecurrence && scopedTracePath(uri.fsPath) && providerTrace.length<32
                ? {path:relativeTracePath(uri.fsPath),pending:true} : undefined;
            if (trace) { providerTrace.push(trace); }
            let result;
            try { result=providerStat.call(this,uri,...args); }
            catch (error) {
                if (trace) { trace.error={name:error?.name,code:error?.code};trace.pending=false; }
                throw error;
            }
            if (!trace) { return result; }
            return Promise.resolve(result).then(value=>{
                trace.type=value.type;trace.pending=false;return value;
            },error=>{
                trace.error={name:error?.name,code:error?.code};trace.pending=false;throw error;
            });
        };
    }
    const traceState = uri => ({path:relativeTracePath(uri.fsPath),epoch:tracker.sessionEpoch,
        recording:tracker.isRecording,external:tracker.externalWatcherEnabled,snapshot:tracker.snapshotInitialized,
        building:tracker.baselineBuilding,transaction:!!tracker.baselineTransaction,restoring:tracker.restoringEpoch,
        rechecking:tracker.coverageRecheckEpoch,initialIgnore:tracker.initialIgnoreEpoch,
        scopeApplyPreflight:tracker.scopeApplyPreflight,scopeApplications:tracker.activeScopeApplications,
        pending:!!tracker.pendingMonitoringScope,git:tracker.gitContextPending,gitPauses:tracker.pausedGitRepositories.size,
        recovery:tracker.recoveryBlocked,persistence:tracker.persistenceFailed,workspaceChanged:tracker.workspaceContextChanged,
        fileGap:!!tracker.coverageGaps.get(uri.fsPath)?.file,baselineFile:tracker.baselineExistingFiles.has(uri.fsPath),
        opaqueFile:tracker.opaqueBaselineFiles.has(uri.fsPath),hostWatchers:tracker.fileWatchers.length,
        generation:tracker.coverageGeneration,watcherRevision:tracker.watcherCoverageRevision,ignoreRevision:tracker.ignorePolicyRevision,
        jobs:[...tracker.directoryObservations].slice(0,8).map(([key,job])=>
            ({root:relativeTracePath(key),path:relativeTracePath(job.directory),dirty:job.dirty,current:job.current()})),
        dirtyUnderPath:vscode.workspace.textDocuments.filter(doc=>doc.uri.scheme==='file'&&doc.isDirty&&
            tracker.pathBelongsToRoot(doc.uri.fsPath,uri.fsPath)).length});
    const completeRuntimeBaseline = tracker.completeRuntimeBaseline;
    tracker.completeRuntimeBaseline = async function(...args) {
        const caller = new Error().stack.split('\n').find(line=>/onExternalFileCreated|ensureSnapshotForDocument/.test(line))
            ?.match(/onExternalFileCreated|ensureSnapshotForDocument/)?.[0] ?? 'other';
        if (traceRecurrence) { runtimePublicationCallers[caller]=(runtimePublicationCallers[caller]??0)+1; }
        const trace = traceRecurrence && directoryTrace.length<24 ? {method:'completeRuntimeBaseline',
            caller,pending:true} : undefined;
        if (trace) { directoryTrace.push(trace); }
        try { return await completeRuntimeBaseline.apply(this,args); }
        finally { if (trace) { trace.pending=false; } }
    };
    for (const method of ['onExternalFileChanged','isUntrackedDirectory','reconcileDirectoryObservation']) {
        const original = tracker[method];
        tracker[method] = async function(uri,...args) {
            if (method==='reconcileDirectoryObservation' && args[1] && scopedTracePath(uri.fsPath) &&
                createdDirectoryIdentities.size<16) { createdDirectoryIdentities.set(uri.fsPath,{epoch:args[0],identity:args[1]}); }
            const trace = traceRecurrence && scopedTracePath(uri.fsPath) && directoryTrace.length<24
                ? {method,before:traceState(uri),pending:true} : undefined;
            if (trace && method==='reconcileDirectoryObservation') { trace.creationIdentity=!!args[1]; }
            if (trace) { directoryTrace.push(trace); }
            try {
                const result = await original.call(this,uri,...args);
                if (trace && method==='isUntrackedDirectory') {
                    trace.directory=result;
                    try { trace.nodeDirectory=fs.lstatSync(uri.fsPath).isDirectory(); } catch (error) { trace.nodeError=error?.code; }
                }
                return result;
            } catch (error) {
                if (trace) { trace.error={name:error?.name,code:error?.code}; }
                throw error;
            } finally {
                if (trace) { trace.pending=false;trace.after=traceState(uri); }
            }
        };
    }
    fs.lstatSync = function(target, ...args) {
        const result = nativeLstat.call(this, target, ...args);
        if (String(target).startsWith(`${root}${path.sep}`) && providerFallbacks.length < 32 &&
            new Error().stack.split('\n').some(line=>line.includes('isUntrackedDirectory') &&
                /(?:out\/diffTracker\.js|src\/diffTracker\.ts):/.test(line.replace(/\\/g,'/')))) {
            providerFallbacks.push({path:path.relative(root,String(target)),directory:result.isDirectory()});
        }
        return result;
    };
    fs.watch = function(directory, ...args) {
        const listener = args[args.length - 1];
        const watchedDirectory=String(directory);
        if (tracker.pathBelongsToRoot(watchedDirectory,root) && typeof listener === 'function') {
            args[args.length - 1] = (kind, filename) => {
                if(watchedDirectory===root){
                    if (notifications.length < 128) { notifications.push({kind,filename:String(filename)}); }
                    if (String(filename) === 'existing') { observedNotifications++; }
                }
                if(filename!==null&&filename!==undefined){
                    const changed=path.join(watchedDirectory,String(filename));
                    if(changed===nativeUnknownTarget||changed===sibling||liveTargets.includes(changed)){
                        nativeFileNotifications.set(changed,(nativeFileNotifications.get(changed)??0)+1);
                    }
                }
                listener(kind, filename);
            };
        }
        return nativeWatch.call(this, directory, ...args);
    };
    try {
        fs.mkdirSync(child, {recursive:true});
        fs.writeFileSync(target, 'known before\n');
        fs.writeFileSync(nativeUnknownTarget, 'unproven before native observation\n');
        fs.writeFileSync(sibling, 'sibling before\n');
        const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));
        const requested = validateAndCanonicalizeScope({mode:'rules',
            includes:[{scope:'folder',folder:folder.name,path:'s4b-change-owner'}], excludes:[]
        }, tracker.currentWorkspaceRootIdentities());
        assert.equal(requested.ok, true);
        tracker.effectiveMonitoringScope = {kind:'configured', ...requested.scope};
        tracker.sessionWorkspaceRoots = tracker.getWorkspaceRoots();
        tracker.isRecording = true;
        tracker.externalWatcherEnabled = true;
        tracker.snapshotInitialized = true;
        tracker.fileSnapshots.set(target, 'known before\n');
        tracker.baselineExistingFiles.add(target);
        tracker.fileSnapshots.set(sibling, 'sibling before\n');
        tracker.baselineExistingFiles.add(sibling);
        await tracker.installSupplementalCoverageTargets([root], tracker.sessionEpoch, true);
        tracker.commitSupplementalCoverageTargets([root]);
        assert.equal(tracker.fileWatchers.length, 0, 'only native observation may deliver this scenario');
        fs.utimesSync(child, new Date(), new Date(Date.now() + 2000));
        // libuv may classify directory metadata as rename (Linux) or change.
        // Deterministic tests exercise both callback branches separately; this
        // scenario must use the platform's real callback without rewriting it.
        await until('a real native directory notification', () => observedNotifications > 0);
        await until('directory verification to finish automatically', () =>
            tracker.directoryObservations.size === 0 && tracker.getSubtreeCoverageGaps().length === 0);
        assert.equal(tracker.getOriginalContent(target), 'known before\n');
        const nativeUnknown = tracker.getUnknownReviewToken(nativeUnknownTarget);assert.ok(nativeUnknown);
        assert.equal(tracker.getOriginalContent(nativeUnknownTarget),undefined);
        const nativeUnknownEvents=nativeFileNotifications.get(nativeUnknownTarget)??0;
        fs.writeFileSync(nativeUnknownTarget,'later native Unknown edit\n');
        await until('continued native-only Unknown observation',()=>
            (nativeFileNotifications.get(nativeUnknownTarget)??0)>nativeUnknownEvents &&
            tracker.getUnknownReviewToken(nativeUnknownTarget)?.reviewRevision!==nativeUnknown.reviewRevision);
        assert.ok(tracker.getUnknownReviewToken(nativeUnknownTarget));
        assert.equal(tracker.getOriginalContent(nativeUnknownTarget),undefined);
        console.log('PASS HOST-ISSUE-55 native-only directory observation preserves Unknown and later child edits without creation provenance');
        fs.writeFileSync(target, 'later observed edit\n');
        await until('continued native child observation after directory verification', () =>
            tracker.getTrackedChange(target)?.currentContent === 'later observed edit\n');
        assert.equal(tracker.getOriginalContent(target), 'known before\n');
        console.log('PASS HOST-ISSUE-55 real directory notification reconciles automatically and keeps observing child edits');
        const excluded = validateAndCanonicalizeScope({mode:'rules', includes:requested.scope.includes,
            excludes:[{scope:'folder',folder:folder.name,pattern:'/s4b-change-owner/existing/'}]
        }, tracker.currentWorkspaceRootIdentities());
        assert.equal(excluded.ok, true);
        tracker.setSubtreeCoverageGap(child, 'supplemental-watcher-directory-change-gap', 'Earlier directory uncertainty');
        const result = await tracker.applyConfiguredMonitoringScope(excluded.scope, true);
        assert.equal(result.status, 'applied', JSON.stringify(result));
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), [], 'Apply completes excluded diagnostics without Recheck');
        assert.equal(tracker.supplementalDirectoryWatchers.has(child), false);
        assert.ok(tracker.coverageGaps.get(child)?.subtree, 'unscanned excluded evidence remains durable');
        fs.mkdirSync(path.join(child, 'excluded-new-directory'));
        fs.writeFileSync(path.join(child, 'excluded-new-directory', 'ignored.txt'), 'excluded contents\n');
        await delay(300);
        assert.deepEqual(tracker.getSubtreeCoverageGaps(), []);
        fs.writeFileSync(sibling, 'sibling observed after exclusion\n');
        await until('continued sibling observation after child exclusion', () =>
            tracker.getTrackedChange(sibling)?.currentContent === 'sibling observed after exclusion\n');
        assert.equal(tracker.getOriginalContent(sibling), 'sibling before\n');
        console.log('PASS HOST-ISSUE-55 Apply retires excluded diagnostics and owners while native sibling observation continues');
        const excludedEvidence = tracker.coverageGaps.get(child)?.subtree;
        assert.ok(excludedEvidence);
        // Recheck installs real Host watchers as well. A platform may provide
        // an actual create identity for a moved path; a native notification
        // alone must still retain Unknown, and existing Unknown stays intact.
        assert.equal((await tracker.recheckObservationCoverage()).status, 'rechecked');
        assert.equal(tracker.coverageGaps.get(child)?.subtree, excludedEvidence);
        traceRecurrence = true;
        const originalEvidence = {...excludedEvidence}, reactivated = [];
        const observedUnknowns=new Set(),changedUnknownBeforeImages=[];
        const diagnostics = tracker.onDidTrackChanges(() => {
            reactivated.push(...tracker.getSubtreeCoverageGaps().filter(gap => gap.targetPath === child));
            for(const filePath of liveTargets){
                if(tracker.getTrackedChange(filePath)?.reviewKind==='unknown'){observedUnknowns.add(filePath);}
                if(observedUnknowns.has(filePath)&&tracker.getOriginalContent(filePath)!==undefined){
                    changedUnknownBeforeImages.push(path.relative(root,filePath));
                }
            }
        });
        const opendir = fs.promises.opendir; let excludedEnumerations = 0;
        fs.promises.opendir = async (directory, ...args) => {
            if (String(directory) === child || String(directory).startsWith(`${child}${path.sep}`)) { excludedEnumerations++; }
            return opendir(directory, ...args);
        };
        try {
            for (let round = 0; round < 3; round++) {
                const before = observedNotifications;
                const inner = path.join(child, `created-${round}`); fs.mkdirSync(inner);
                fs.writeFileSync(path.join(inner, 'ignored.txt'), `excluded modification ${round}\n`);
                fs.renameSync(inner, path.join(child, `renamed-${round}`));
                fs.rmSync(child, {recursive:true}); fs.mkdirSync(child);
                await until(`real excluded-directory delete/recreate notification ${round}`, () => observedNotifications > before);
                const incoming = `${root}-incoming-${round}`, live = path.join(root, `live-${round}`);
                assert.equal(fs.existsSync(live),false,'the incoming path must be absent before its actual move');
                fs.mkdirSync(incoming); fs.writeFileSync(path.join(incoming, 'tracked.txt'), `imported ${round}\n`);
                fs.renameSync(incoming, live);
                const current = path.join(live, 'tracked.txt');
                await until(`automatic observation of moved directory ${round}`, () =>
                    tracker.supplementalDirectoryWatchers.get(live)?.epoch === tracker.sessionEpoch &&
                    tracker.directoryObservations.size === 0 &&
                    (tracker.getTrackedChange(current)?.reviewKind === 'unknown' ||
                        (observedCreationMatches(live) && tracker.getTrackedChange(current)?.reviewKind === 'text' &&
                            tracker.getOriginalContent(current)==='')), () => ({
                        notifications,providerFallbacks,directoryTrace,providerTracing,providerTrace,policyTrace,runtimePublicationCallers,
                        epoch:tracker.sessionEpoch,recording:tracker.getIsRecording(),
                        externalWatcherEnabled:tracker.externalWatcherEnabled,snapshotInitialized:tracker.snapshotInitialized,
                        baselineBuilding:tracker.baselineBuilding,baselineTransaction:!!tracker.baselineTransaction,
                        restoringEpoch:tracker.restoringEpoch,coverageRecheckEpoch:tracker.coverageRecheckEpoch,
                        scopeApplyPreflight:tracker.scopeApplyPreflight,activeScopeApplications:tracker.activeScopeApplications,
                        pendingScope:tracker.pendingMonitoringScope?.scopeRevision,scopeKind:tracker.effectiveMonitoringScope.kind,
                        recoveryBlocked:tracker.recoveryBlocked,persistenceFailed:tracker.persistenceFailed,persistenceIssue:tracker.persistenceIssue,
                        workspaceChanged:tracker.workspaceContextChanged,gitPending:tracker.gitContextPending,
                        ignoredDirectory:tracker.isPathIgnored(vscode.Uri.file(live),true),
                        ignoredFile:tracker.testIgnorePath(live),workspaceOwner:tracker.owningWorkspaceFolderForTraversal(live)?.name,
                        canonicalPath:path.relative(root,tracker.canonicalTrackingPath(live)),
                        owners:[...tracker.supplementalDirectoryWatchers].map(([directory,owner])=>
                            ({path:path.relative(root,directory),epoch:owner.epoch,coverageRoot:path.relative(root,owner.coverageRoot)})),
                        jobs:[...tracker.directoryObservations].map(([directory,job])=>({path:path.relative(root,directory),dirty:job.dirty})),
                        gaps:tracker.getSubtreeCoverageGaps().map(gap=>({path:path.relative(root,gap.targetPath),reasonCode:gap.reasonCode})),
                        reviewKind:tracker.getTrackedChange(current)?.reviewKind,
                        currentContent:tracker.getTrackedChange(current)?.currentContent,
                        originalKnown:tracker.getOriginalContent(current)!==undefined
                    }));
                const unknown = tracker.getUnknownReviewToken(current);
                if (unknown) { assert.equal(tracker.getOriginalContent(current),undefined); }
                else {
                    assert.equal(observedCreationMatches(live),true,'text creation requires the actual Host create identity');
                    assert.equal(tracker.getOriginalContent(current),'');
                    assert.equal(tracker.getTrackedChange(current)?.currentContent,`imported ${round}\n`);
                }
                const childEvents=nativeFileNotifications.get(current)??0;
                fs.writeFileSync(current, `later native child edit ${round}\n`);
                await until(`continued moved-directory native observation ${round}`, () =>
                    (nativeFileNotifications.get(current)??0)>childEvents &&
                    (unknown ? tracker.getUnknownReviewToken(current)?.reviewRevision !== unknown.reviewRevision
                        : tracker.getTrackedChange(current)?.currentContent === `later native child edit ${round}\n`));
                assert.equal(tracker.getTrackedChange(current)?.reviewKind,unknown?'unknown':'text');
                assert.equal(tracker.getOriginalContent(current),unknown?undefined:'');
                const siblingEvents=nativeFileNotifications.get(sibling)??0;
                fs.writeFileSync(sibling, `later native sibling edit ${round}\n`);
                await until(`continued retained-parent native observation ${round}`, () =>
                    (nativeFileNotifications.get(sibling)??0)>siblingEvents &&
                    tracker.getTrackedChange(sibling)?.currentContent === `later native sibling edit ${round}\n`);
                await until(`bounded directory work after round ${round}`, () => tracker.directoryObservations.size === 0);
                assert.deepEqual(tracker.getSubtreeCoverageGaps(), [], `Limited must not recur after round ${round}`);
                assert.equal(tracker.coverageGaps.get(child)?.subtree, excludedEvidence);
                assert.deepEqual(excludedEvidence, originalEvidence);
                assert.deepEqual(reactivated, [], 'the same old excluded gap must stay inactive throughout native callbacks');
                assert.deepEqual(changedUnknownBeforeImages,[],'an observed Unknown must never become an accepted before-image');
                assert.equal(tracker.supplementalDirectoryWatchers.has(child), false);
                assert.equal(tracker.getOriginalContent(sibling), 'sibling before\n');
            }
            assert.equal(excludedEnumerations, 0);
        } finally { fs.promises.opendir = opendir; diagnostics.dispose(); }
        console.log(`HOST-ISSUE-55 provider fallback metadata: ${JSON.stringify(providerFallbacks)}`);
        console.log(`HOST-ISSUE-55 runtime Ready publication callers: ${JSON.stringify(runtimePublicationCallers)}`);
        console.log('PASS HOST-ISSUE-55 cleared Limited stays clear through three excluded create/modify/rename/delete-recreate and included move/native-edit rounds');
    } finally {
        fs.watch = nativeWatch;
        fs.lstatSync = nativeLstat;
        if (providerTracing) { providerApi.stat=providerStat; }
        await tracker.dispose();
        fs.rmSync(root, {recursive:true,force:true});
        for (let round = 0; round < 3; round++) { fs.rmSync(`${root}-incoming-${round}`, {recursive:true,force:true}); }
        fs.rmSync(storage, {recursive:true,force:true});
    }
}

module.exports = async function s4bLifecycleHost(workspace) {
    await directoryChangeHost(workspace);
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'difftracker-s4b-host-'));
    const root = vscode.Uri.file(path.join(workspace, 's4b-identity-owner')).fsPath;
    const moved = `${root}-moved`;
    const target = path.join(root, 'tracked.txt');
    const tracker = new DiffTracker(vscode.Uri.file(storage));
    try {
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(target, 'known before\n');
        const requested = validateAndCanonicalizeScope({
            mode: 'rules', includes: [{scope:'all', path:'s4b-identity-owner'}], excludes: []
        }, tracker.currentWorkspaceRootIdentities());
        assert.equal(requested.ok, true);
        tracker.effectiveMonitoringScope = {kind:'configured', ...requested.scope};
        tracker.sessionWorkspaceRoots = tracker.getWorkspaceRoots();
        tracker.isRecording = true;
        tracker.snapshotInitialized = true;
        tracker.fileSnapshots.set(target, 'known before\n');
        tracker.baselineExistingFiles.add(target);
        await tracker.installSupplementalCoverageTargets([root], tracker.sessionEpoch, true);
        tracker.commitSupplementalCoverageTargets([root]);
        assert.equal(tracker.fileWatchers.length, 0);
        assert.equal(tracker.getSubtreeCoverageGaps().length, 0);
        await delay(250);
        fs.renameSync(root, moved);
        // Recreate the path before queued callbacks run. Existence alone cannot
        // prove that the old native handle follows this replacement directory.
        fs.mkdirSync(root);
        fs.writeFileSync(target, 'replacement contents\n');
        const deadline = Date.now() + 15000;
        while (!tracker.getSubtreeCoverageGaps().some(gap => gap.targetPath === root)) {
            if (Date.now() > deadline) { throw new Error('Replaced native owner produced no visible coverage gap'); }
            await delay(50);
        }
        assert.equal(tracker.supplementalDirectoryWatchers.get(root)?.epoch, -1);
        assert.equal(tracker.getOriginalContent(target), 'known before\n');
        assert.equal(fs.readFileSync(target, 'utf8'), 'replacement contents\n');
        assert.equal(await tracker.flushPendingPersistence(), true);
        const saved = JSON.parse(fs.readFileSync(path.join(storage, 'session-state.json'), 'utf8'));
        assert.ok(saved.coverageGaps.some(([directory, record]) => directory === root && record.subtree));
        console.log('PASS HOST-S4-B replaced direct directory identity retains baseline and durable gap without parent watcher');
    } finally {
        await tracker.dispose();
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(moved, { recursive: true, force: true });
        fs.rmSync(storage, { recursive: true, force: true });
    }
};
