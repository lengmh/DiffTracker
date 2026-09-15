/**
 * Real Git repository scenario tests for the production context comparator.
 * Git mutations are restricted to temporary repositories created by this file.
 * The VS Code Git-extension event boundary is covered separately by git-context.mjs.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const originalLoad = Module._load;
Module._load = function (id, ...args) {
    return id === 'vscode'
        ? { extensions: { getExtension: () => undefined } }
        : originalLoad.call(this, id, ...args);
};
let compareGitContexts;
try {
    ({ compareGitContexts } = require('../out/gitContext.js'));
} finally {
    Module._load = originalLoad;
}

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'diff-tracker-git-'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (cwd, ...args) => {
    try { return { ok: true, output: git(cwd, ...args) }; }
    catch (error) { return { ok: false, output: String(error.stderr ?? error.message) }; }
};
const gitPath = (cwd, name) => path.resolve(cwd, git(cwd, 'rev-parse', '--git-path', name));
const exists = filePath => {
    try { statSync(filePath); return true; } catch { return false; }
};
const context = (repoRoot, kind = 'repository') => {
    const branch = tryGit(repoRoot, 'symbolic-ref', '--quiet', '--short', 'HEAD');
    const commit = tryGit(repoRoot, 'rev-parse', '--verify', 'HEAD');
    const rebaseMerge = gitPath(repoRoot, 'rebase-merge');
    const rebaseApply = gitPath(repoRoot, 'rebase-apply');
    return {
        repoRoot,
        kind,
        headName: branch.ok ? branch.output : undefined,
        headCommit: commit.ok ? commit.output : undefined,
        detached: commit.ok && !branch.ok,
        inProgress: exists(gitPath(repoRoot, 'MERGE_HEAD')) || exists(rebaseMerge) || exists(rebaseApply)
    };
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
