/**
 * Real Git repository scenario tests for the production context comparator.
 * Git mutations are restricted to temporary repositories created by this file.
 * The VS Code Git-extension event boundary is covered separately by git-context.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const originalLoad = Module._load;
Module._load = function (id, ...args) {
    return id === 'vscode'
        ? { extensions: { getExtension: () => undefined }, workspace: { workspaceFolders: [] } }
        : originalLoad.call(this, id, ...args);
};
let compareGitContexts, snapshotGitRepository, GitContextMonitor;
try {
    ({ compareGitContexts, snapshotGitRepository, GitContextMonitor } = require('../out/gitContext.js'));
} finally {
    Module._load = originalLoad;
}

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'diff-tracker-git-'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (cwd, ...args) => {
    try { return { ok: true, output: git(cwd, ...args) }; }
    catch (error) { return { ok: false, output: String(error.stderr ?? error.message) }; }
};
const context = (repoRoot, kind = 'repository') => {
    const branch = tryGit(repoRoot, 'symbolic-ref', '--quiet', '--short', 'HEAD');
    const commit = tryGit(repoRoot, 'rev-parse', '--verify', 'HEAD');
    return snapshotGitRepository({rootUri:{fsPath:repoRoot},kind,state:{
        HEAD:{name:branch.ok?branch.output:undefined,commit:commit.ok?commit.output:undefined},
        mergeChanges:[],onDidChange:()=>({dispose(){}})
    }});
};
const initRepo = (repoRoot) => {
    mkdirSync(repoRoot, { recursive: true });
    git(repoRoot, 'init', '-b', 'main');
    git(repoRoot, 'config', 'user.email', 'diff-tracker@example.invalid');
    git(repoRoot, 'config', 'user.name', 'Diff Tracker Test');
    git(repoRoot, 'config', 'core.autocrlf', 'false');
    writeFileSync(path.join(repoRoot, 'sample.txt'), 'base\n');
    git(repoRoot, 'add', 'sample.txt');
    git(repoRoot, 'commit', '-m', 'base');
};

const tests = [];
const test = (name, run) => tests.push({ name, run });

test('ordinary commit and pull --ff-only preserve a named-branch review context', () => {
    const origin = path.join(tempRoot, 'origin.git');
    git(tempRoot, 'init', '--bare', origin);
    const seed = path.join(tempRoot, 'seed');
    initRepo(seed);
    git(seed, 'remote', 'add', 'origin', origin);
    git(seed, 'push', '-u', 'origin', 'main');
    git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    const clone = path.join(tempRoot, 'clone');
    git(tempRoot, 'clone', origin, clone);
    git(clone, 'config', 'user.email', 'diff-tracker@example.invalid');
    git(clone, 'config', 'user.name', 'Diff Tracker Test');
    const before = context(clone);
    writeFileSync(path.join(seed, 'sample.txt'), 'base\nremote\n');
    git(seed, 'add', 'sample.txt');
    git(seed, 'commit', '-m', 'remote');
    git(seed, 'push');
    git(clone, 'pull', '--ff-only');
    const after = context(clone);
    assert.notEqual(after.headCommit, before.headCommit);
    assert.deepEqual(compareGitContexts(before, after), { compatible: true });
});

test('same commit on another branch is incompatible while a failed checkout changes nothing', () => {
    const repo = path.join(tempRoot, 'branch');
    initRepo(repo);
    const before = context(repo);
    git(repo, 'switch', '-c', 'feature');
    const switched = context(repo);
    assert.equal(switched.headCommit, before.headCommit);
    assert.equal(compareGitContexts(before, switched).compatible, false);
    const failedBefore = context(repo);
    assert.equal(tryGit(repo, 'switch', 'missing-branch').ok, false);
    assert.deepEqual(context(repo), failedBefore);
});

test('detached HEAD and a linked worktree retain distinct identities', () => {
    const repo = path.join(tempRoot, 'worktree-main');
    const linked = path.join(tempRoot, 'worktree-linked');
    initRepo(repo);
    const named = context(repo);
    git(repo, 'switch', '--detach');
    const detached = context(repo);
    assert.equal(detached.detached, true);
    assert.equal(compareGitContexts(named, detached).compatible, false);
    git(repo, 'switch', 'main');
    git(repo, 'worktree', 'add', '-b', 'linked', linked);
    const linkedBefore = context(linked, 'worktree');
    writeFileSync(path.join(linked, 'sample.txt'), 'base\nlinked\n');
    git(linked, 'add', 'sample.txt');
    git(linked, 'commit', '-m', 'linked');
    assert.deepEqual(compareGitContexts(linkedBefore, context(linked, 'worktree')), { compatible: true });
    assert.equal(compareGitContexts(context(repo), context(linked, 'worktree')).compatible, false);
});

test('merge conflicts are unstable and abort returns to a compatible context', () => {
    const repo = path.join(tempRoot, 'conflict');
    initRepo(repo);
    git(repo, 'switch', '-c', 'other');
    writeFileSync(path.join(repo, 'sample.txt'), 'other\n');
    git(repo, 'add', 'sample.txt');
    git(repo, 'commit', '-m', 'other');
    git(repo, 'switch', 'main');
    writeFileSync(path.join(repo, 'sample.txt'), 'main\n');
    git(repo, 'add', 'sample.txt');
    git(repo, 'commit', '-m', 'main');
    const before = context(repo);
    assert.equal(tryGit(repo, 'merge', 'other').ok, false);
    assert.equal(context(repo).inProgress, true);
    assert.equal(compareGitContexts(before, context(repo)).compatible, false);
    git(repo, 'merge', '--abort');
    assert.deepEqual(compareGitContexts(before, context(repo)), { compatible: true });
});

test('path restore leaves HEAD context unchanged for filesystem tracking to review', () => {
    const repo = path.join(tempRoot, 'restore');
    initRepo(repo);
    const before = context(repo);
    writeFileSync(path.join(repo, 'sample.txt'), 'changed\n');
    git(repo, 'restore', 'sample.txt');
    assert.deepEqual(context(repo), before);
    assert.equal(readFileSync(path.join(repo, 'sample.txt'), 'utf8'), 'base\n');
});

for(const linked of [false,true]) for(const finish of ['abort','commit']) test(`clean no-commit merge is detected (worktree=${linked}, ${finish})`,()=>{
    const main=path.join(tempRoot,`clean-${linked}-${finish}`);initRepo(main);
    git(main,'switch','-c','topic');writeFileSync(path.join(main,'topic.txt'),'topic');git(main,'add','.');git(main,'commit','-m','topic');git(main,'switch','main');
    const repo=linked?`${main}-linked`:main;
    if(linked) git(main,'worktree','add','-b',`linked-${finish}`,repo);
    const before=context(repo);git(repo,'merge','--no-ff','--no-commit','topic');
    assert.equal(git(repo,'ls-files','--unmerged'),'');assert.equal(context(repo).headCommit,before.headCommit);
    assert.equal(context(repo).inProgress,true);assert.equal(compareGitContexts(before,context(repo)).compatible,false);
    if(linked) assert.equal(context(main).inProgress,false,'operation state is worktree-local');
    if(finish==='abort') git(repo,'merge','--abort');else git(repo,'commit','-m','merge');
    assert.equal(context(repo).inProgress,false);assert.equal(compareGitContexts(before,context(repo)).compatible,true);
});

const createMonitor = async (root, kind = 'repository') => {
    const event = () => ({ dispose() {} });
    const repository = { rootUri: { fsPath: root }, kind, state: { mergeChanges: [], onDidChange: event } };
    const catchUp = () => {
        const current = context(root, kind);
        repository.state.HEAD = { name: current.headName, commit: current.headCommit };
    };
    catchUp();
    const gitApi = { state: 'initialized', repositories: [repository], onDidChangeState: event,
        onDidOpenRepository: event, onDidCloseRepository: event };
    const monitor = new GitContextMonitor(() => {}, () => ({ isActive: true,
        exports: { enabled: true, getAPI: () => gitApi } }));
    await monitor.start();
    return { monitor, catchUp, repository, gitApi };
};

for (const linked of [false, true]) test(`Keep verifies external checkout before cached events (worktree=${linked})`, async () => {
    const main = path.join(tempRoot, `verified-${linked}`); initRepo(main);
    const root = linked ? `${main}-linked` : main;
    if (linked) git(main, 'worktree', 'add', '-b', 'linked', root);
    const { monitor, catchUp } = await createMonitor(root, linked ? 'worktree' : 'repository');
    try {
        const original = monitor.getVerifiedSnapshots()[0];
        git(root, 'branch', 'B'); git(root, 'branch', 'C');
        // Identical commit and file bytes cannot hide a branch identity transition.
        for (const branch of ['B', 'C']) {
            git(root, 'switch', branch);
            assert.equal(git(root, 'rev-parse', 'HEAD'), original.headCommit);
            assert.equal(readFileSync(path.join(root, 'sample.txt'), 'utf8'), 'base\n');
            assert.equal(monitor.getVerifiedSnapshots()[0].inProgress, true, 'stale cached HEAD fails closed');
            catchUp();
            assert.equal(monitor.getVerifiedSnapshots()[0].headName, branch, 'cache catch-up recovers');
        }
        git(root, 'switch', '--detach');
        assert.equal(monitor.getVerifiedSnapshots()[0].inProgress, true);
        catchUp(); assert.equal(monitor.getVerifiedSnapshots()[0].detached, true);
        git(root, 'switch', 'C');
        assert.equal(monitor.getVerifiedSnapshots()[0].inProgress, true);
        catchUp(); assert.equal(monitor.getVerifiedSnapshots()[0].headName, 'C');
        git(root, 'commit', '--allow-empty', '-m', 'same bytes new commit');
        assert.equal(monitor.getVerifiedSnapshots()[0].inProgress, true, 'stale same-branch commit fails closed');
        catchUp(); assert.equal(monitor.getVerifiedSnapshots()[0].inProgress, false);
        git(root, 'pack-refs', '--all', '--prune');
        assert.equal(monitor.getVerifiedSnapshots()[0].headCommit, git(root, 'rev-parse', 'HEAD'));
        git(root, 'switch', 'B');
        assert.equal(monitor.getVerifiedSnapshots()[0].inProgress, true, 'packed refs do not hide checkout');
        catchUp(); assert.equal(monitor.getVerifiedSnapshots()[0].headName, 'B');
        const gitDir = git(root, 'rev-parse', '--absolute-git-dir');
        for (const name of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'sequencer']) {
            const marker = path.join(gitDir, name);
            writeFileSync(marker, original.headCommit);
            assert.equal(monitor.getVerifiedSnapshots()[0].inProgress, true, name);
            rmSync(marker); assert.equal(monitor.getVerifiedSnapshots()[0].inProgress, false);
        }
        if (linked) {
            writeFileSync(path.join(main, '.git', 'MERGE_HEAD'), original.headCommit);
            assert.equal(monitor.getVerifiedSnapshots()[0].inProgress, false, 'main worktree operation is not linked-worktree state');
            rmSync(path.join(main, '.git', 'MERGE_HEAD'));
        }
    } finally { monitor.dispose(); }
});

test('Keep rejects HEAD changing within a synchronous verification read', async () => {
    const root = path.join(tempRoot, 'verified-racing'); initRepo(root);
    git(root, 'branch', 'other');
    const { monitor, catchUp } = await createMonitor(root);
    const headPath = path.join(root, '.git', 'HEAD');
    const openSync = fs.openSync;
    let reads = 0;
    try {
        fs.openSync = function(file, ...args) {
            if (file === headPath && ++reads === 2) { git(root, 'switch', 'other'); }
            return openSync.call(this, file, ...args);
        };
        assert.equal(monitor.getVerifiedSnapshots()[0].inProgress, true);
    } finally { fs.openSync = openSync; }
    try {
        catchUp(); assert.equal(monitor.getVerifiedSnapshots()[0].headName, 'other');
    } finally { monitor.dispose(); }
});

for (const linked of [false, true]) for (const operation of [
    'MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'sequencer'
]) test(`Keep rejects operation starting during final HEAD read (${operation}, worktree=${linked})`, async () => {
    const main = path.join(tempRoot, `late-operation-${operation}-${linked}`); initRepo(main);
    git(main, 'switch', '-c', 'topic');
    writeFileSync(path.join(main, 'topic.txt'), 'topic\n');
    git(main, 'add', '.'); git(main, 'commit', '-m', 'topic'); git(main, 'switch', 'main');
    const root = linked ? `${main}-linked` : main;
    if (linked) git(main, 'worktree', 'add', '-b', 'linked', root);
    const { monitor } = await createMonitor(root, linked ? 'worktree' : 'repository');
    const gitDir = git(root, 'rev-parse', '--absolute-git-dir');
    const headPath = path.join(gitDir, 'HEAD');
    // Git can return a different spelling of the same temp path on Windows
    // (casing/short-name aliases). Match file identity, not the original spelling.
    const canonicalPath = file => {
        const resolved = path.normalize(fs.realpathSync.native(file));
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    const canonicalHeadPath = canonicalPath(headPath);
    const originalCommit = git(root, 'rev-parse', 'HEAD');
    const markerPath = path.join(gitDir, operation);
    const openSync = fs.openSync;
    let reads = 0, injections = 0;
    const observedHeadPaths = [];
    try {
        fs.openSync = function(file, ...args) {
            const isHead = typeof file === 'string' && path.basename(file) === 'HEAD';
            if (isHead) observedHeadPaths.push(file);
            if (isHead && canonicalPath(file) === canonicalHeadPath && ++reads === 2) {
                injections++;
                if (operation === 'MERGE_HEAD') git(root, 'merge', '--no-ff', '--no-commit', 'topic');
                else if (['rebase-merge', 'rebase-apply', 'sequencer'].includes(operation)) mkdirSync(markerPath);
                else writeFileSync(markerPath, originalCommit + '\n');
            }
            return openSync.call(this, file, ...args);
        };
        const current = monitor.getVerifiedSnapshots()[0];
        assert.equal(injections, 1, `must inject exactly once during the second HEAD read: ${JSON.stringify({ headPath, observedHeadPaths })}`);
        assert.equal(reads, 2, 'injection must target the final of the two HEAD samples');
        assert.equal(current.headCommit, originalCommit, 'operation leaves HEAD unchanged');
        assert.equal(git(root, 'rev-parse', 'HEAD'), originalCommit);
        assert.equal(current.inProgress, true, 'late operation marker must fail closed');
    } finally {
        fs.openSync = openSync;
        if (operation === 'MERGE_HEAD' && fs.existsSync(markerPath)) git(root, 'merge', '--abort');
        else rmSync(markerPath, { recursive: true, force: true });
        assert.equal(monitor.getVerifiedSnapshots()[0].inProgress, false, 'abort/cleanup restores eligibility');
        monitor.dispose();
    }
});

test('final operation scan rejects metadata identity changing during the second HEAD read', async () => {
    const root = path.join(tempRoot, 'late-metadata-identity'); initRepo(root);
    const other = `${root}-clone`; git(tempRoot, 'clone', root, other);
    const { monitor } = await createMonitor(root);
    const gitDir = path.join(root, '.git');
    const headPath = path.join(gitDir, 'HEAD');
    const commonPath = path.join(gitDir, 'commondir');
    const openSync = fs.openSync;
    let reads = 0;
    try {
        fs.openSync = function(file, ...args) {
            if (file === headPath && ++reads === 2) {
                writeFileSync(commonPath, path.relative(gitDir, path.join(other, '.git')) + '\n');
            }
            return openSync.call(this, file, ...args);
        };
        assert.equal(monitor.getVerifiedSnapshots()[0].inProgress, true,
            'final marker scan must refer to the same metadata identity as HEAD verification');
    } finally {
        fs.openSync = openSync;
        rmSync(commonPath, { force: true });
        assert.equal(monitor.getVerifiedSnapshots()[0].inProgress, false);
        monitor.dispose();
    }
});

test('Keep fails closed for missing, unreadable or invalid authoritative metadata and recovers', async () => {
    const root = path.join(tempRoot, 'verified-invalid'); initRepo(root);
    const { monitor, repository } = await createMonitor(root);
    const headPath = path.join(root, '.git', 'HEAD');
    const original = readFileSync(headPath, 'utf8');
    try {
        for (const invalid of ['', 'unknown\n', 'ref: refs/heads/../../outside\n', 'ref: refs/heads/missing\n']) {
            writeFileSync(headPath, invalid); assert.equal(monitor.getVerifiedSnapshots()[0].inProgress, true);
            writeFileSync(headPath, original); assert.equal(monitor.getVerifiedSnapshots()[0].inProgress, false);
        }
        rmSync(headPath); assert.equal(monitor.getVerifiedSnapshots()[0].inProgress, true);
        writeFileSync(headPath, original); assert.equal(monitor.getVerifiedSnapshots()[0].inProgress, false);
        const openSync = fs.openSync;
        try {
            fs.openSync = function(file, ...args) {
                if (file === headPath) { throw Object.assign(new Error('unreadable'), { code: 'EACCES' }); }
                return openSync.call(this, file, ...args);
            };
            assert.equal(monitor.getVerifiedSnapshots()[0].inProgress, true);
        } finally { fs.openSync = openSync; }
        assert.equal(monitor.getVerifiedSnapshots()[0].inProgress, false);
        const cached = repository.state.HEAD; repository.state.HEAD = undefined;
        assert.equal(monitor.getVerifiedSnapshots()[0].inProgress, true);
        repository.state.HEAD = cached; assert.equal(monitor.getVerifiedSnapshots()[0].inProgress, false);
        git(root, 'pack-refs', '--all', '--prune');
        const packedPath = path.join(root, '.git', 'packed-refs');
        const packed = readFileSync(packedPath, 'utf8');
        writeFileSync(packedPath, 'not a packed ref\n'); assert.equal(monitor.getVerifiedSnapshots()[0].inProgress, true);
        writeFileSync(packedPath, packed); assert.equal(monitor.getVerifiedSnapshots()[0].inProgress, false);
        const loosePath = path.join(root, '.git', 'refs', 'heads', 'main');
        writeFileSync(loosePath, 'invalid\n');
        assert.equal(monitor.getVerifiedSnapshots()[0].inProgress, true, 'invalid loose ref must not fall back to packed ref');
        rmSync(loosePath); assert.equal(monitor.getVerifiedSnapshots()[0].inProgress, false);
        const commonPath = path.join(root, '.git', 'commondir');
        writeFileSync(commonPath, '../missing\n'); assert.equal(monitor.getVerifiedSnapshots()[0].inProgress, true);
        rmSync(commonPath); assert.equal(monitor.getVerifiedSnapshots()[0].inProgress, false);
    } finally { monitor.dispose(); }
});

for (const nested of [false, true]) test(`unverifiable Git owners remain isolated and present (nested=${nested})`, async () => {
    const healthy = path.join(tempRoot, `isolated-${nested}`); initRepo(healthy);
    const unsafe = nested ? path.join(healthy, 'nested') : `${healthy}-other`; initRepo(unsafe);
    const primary = await createMonitor(healthy);
    const secondary = await createMonitor(unsafe, nested ? 'submodule' : 'repository');
    primary.gitApi.repositories.push(secondary.repository);
    // Discover both repository owners through a fresh monitor.
    const event = () => ({ dispose() {} });
    const combinedApi = { ...primary.gitApi, onDidOpenRepository: event };
    const monitor = new GitContextMonitor(() => {}, () => ({ isActive: true,
        exports: { enabled: true, getAPI: () => combinedApi } }));
    await monitor.start();
    const headPath = path.join(unsafe, '.git', 'HEAD');
    const originalHead = readFileSync(headPath, 'utf8');
    const originalCached = secondary.repository.state.HEAD;
    const assertIsolated = () => {
        const snapshots = monitor.getVerifiedSnapshots();
        assert.equal(snapshots.length, 2, 'unsafe repository must not disappear');
        assert.equal(snapshots.find(s => s.repoRoot === healthy).inProgress, false);
        const unsafeSnapshot = snapshots.find(s => s.repoRoot === unsafe);
        assert.equal(unsafeSnapshot.inProgress, true);
        assert.equal(unsafeSnapshot.kind, nested ? 'submodule' : 'repository');
        const file = path.join(unsafe, 'sample.txt');
        const owner = snapshots.filter(s => file.startsWith(s.repoRoot + path.sep))
            .sort((a, b) => b.repoRoot.length - a.repoRoot.length)[0];
        assert.equal(owner.repoRoot, unsafe, 'unsafe nested owner cannot fall back to healthy parent');
        assert.equal(owner.inProgress, true);
    };
    try {
        secondary.repository.state.HEAD = undefined; assertIsolated();
        secondary.repository.state.HEAD = originalCached;
        writeFileSync(headPath, 'invalid\n'); assertIsolated();
        writeFileSync(headPath, originalHead);
        const marker = path.join(unsafe, '.git', 'MERGE_HEAD');
        writeFileSync(marker, originalCached.commit); assertIsolated(); rmSync(marker);
        git(unsafe, 'switch', '-c', 'changed'); assertIsolated();
        secondary.catchUp();
        assert.equal(monitor.getVerifiedSnapshots().every(s => !s.inProgress), true);
        combinedApi.state = 'uninitialized';
        assert.equal(monitor.getVerifiedSnapshots(), undefined, 'global API unavailability remains global');
    } finally { monitor.dispose(); primary.monitor.dispose(); secondary.monitor.dispose(); }
});

let failures = 0;
try {
    for (const { name, run } of tests) {
        try { await run(); console.log(`PASS ${name}`); }
        catch (error) { failures++; console.error(`FAIL ${name}\n${error.stack}`); }
    }
} finally {
    rmSync(tempRoot, { recursive: true, force: true });
}
console.log(`${tests.length - failures}/${tests.length} real temporary Git-repository scenarios passed.`);
process.exitCode = failures ? 1 : 0;
