import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export type GitRepositoryKind = 'repository' | 'submodule' | 'worktree';

export interface GitContextSnapshot {
    repoRoot: string;
    kind: GitRepositoryKind;
    headName?: string;
    headCommit?: string;
    detached: boolean;
    inProgress: boolean;
}

export interface GitContextComparison {
    compatible: boolean;
    reason?: string;
}

interface GitHeadLike {
    name?: string;
    commit?: string;
}

interface GitRepositoryLike {
    rootUri: vscode.Uri;
    kind?: GitRepositoryKind;
    state: {
        HEAD?: GitHeadLike;
        rebaseCommit?: unknown;
        mergeChanges: readonly unknown[];
        onDidChange: vscode.Event<void>;
    };
    onDidCheckout?: vscode.Event<void>;
    status?(): Promise<void>;
}

interface GitApiLike {
    state: 'uninitialized' | 'initialized';
    repositories: readonly GitRepositoryLike[];
    onDidChangeState: vscode.Event<'uninitialized' | 'initialized'>;
    onDidOpenRepository: vscode.Event<GitRepositoryLike>;
    onDidCloseRepository: vscode.Event<GitRepositoryLike>;
    getRepositoryRoot?(uri: vscode.Uri): Promise<vscode.Uri | null>;
    openRepository?(root: vscode.Uri): Promise<GitRepositoryLike | null>;
}

interface GitExtensionExportsLike {
    enabled: boolean;
    getAPI(version: 1): GitApiLike;
}

export type GitContextEvent =
    | { kind: 'changed'; context: GitContextSnapshot }
    | { kind: 'removed'; repoRoot: string }
    | { kind: 'ready'; contexts: GitContextSnapshot[] };

/** Bound synchronous metadata reads used by the final Keep transaction guard. */
function readGitMetadata(file: string, limit = 65536): string {
    const descriptor = fs.openSync(file, 'r');
    try {
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile() || stat.size > limit) { throw new Error('Invalid Git metadata'); }
        return fs.readFileSync(descriptor, 'utf8');
    } finally { fs.closeSync(descriptor); }
}

function resolveGitDirectory(repoRoot: string): string {
    const entry = path.join(repoRoot, '.git');
    const stat = fs.statSync(entry);
    let gitDir = entry;
    if (stat.isFile()) {
        const match = /^gitdir: (.+?)(?:\r?\n)?$/.exec(readGitMetadata(entry));
        if (!match) { throw new Error('Invalid gitfile'); }
        gitDir = path.resolve(repoRoot, match[1]);
    } else if (!stat.isDirectory()) { throw new Error('Invalid Git directory'); }
    if (!fs.statSync(gitDir).isDirectory()) { throw new Error('Missing Git directory'); }
    return gitDir;
}

function optionalGitMetadata(file: string, limit?: number): string | undefined {
    try { return readGitMetadata(file, limit); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
        throw error;
    }
}

function validBranchRef(ref: string): boolean {
    return ref.startsWith('refs/heads/') && !/[\x00-\x20\x7f~^:?*\[\\]/.test(ref)
        && !ref.includes('..') && !ref.includes('@{') && !ref.endsWith('.')
        && ref.split('/').every(part => !!part && !part.startsWith('.') && !part.endsWith('.lock'));
}

function resolveGitMetadata(repoRoot: string): { gitDir: string; commonDir: string; identity: string } {
    const gitDir = resolveGitDirectory(repoRoot);
    const common = optionalGitMetadata(path.join(gitDir, 'commondir'));
    if (common !== undefined && !/^.+?(?:\r?\n)?$/.test(common)) { throw new Error('Invalid commondir'); }
    const commonDir = common === undefined ? gitDir : path.resolve(gitDir, common.replace(/\r?\n$/, ''));
    if (!fs.statSync(commonDir).isDirectory()) { throw new Error('Missing common directory'); }
    const identity = JSON.stringify([fs.realpathSync(gitDir), fs.realpathSync(commonDir)]);
    return { gitDir, commonDir, identity };
}

function readDiskHead(repoRoot: string): { headName?: string; headCommit: string; identity: string } {
    const { gitDir, commonDir, identity } = resolveGitMetadata(repoRoot);
    const head = readGitMetadata(path.join(gitDir, 'HEAD')).replace(/\r?\n$/, '');
    const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
    if (oid.test(head)) { return { headCommit: head, identity }; }
    const ref = head.startsWith('ref: ') ? head.slice(5) : '';
    if (!validBranchRef(ref)) { throw new Error('Unknown HEAD'); }
    const loose = optionalGitMetadata(path.join(commonDir, ...ref.split('/')));
    if (loose !== undefined) {
        const commit = loose.replace(/\r?\n$/, '');
        if (!oid.test(commit)) { throw new Error('Unknown branch ref'); }
        return { headName: ref.slice('refs/heads/'.length), headCommit: commit, identity };
    }
    const packed = optionalGitMetadata(path.join(commonDir, 'packed-refs'), 16 * 1024 * 1024);
    let commit: string | undefined;
    for (const line of (packed ?? '').split(/\r?\n/)) {
        if (!line || line.startsWith('#') || /^\^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(line)) { continue; }
        const match = /^([0-9a-f]{40}|[0-9a-f]{64}) (refs\/\S+)$/.exec(line);
        if (!match) { throw new Error('Invalid packed refs'); }
        if (match[2] === ref) {
            if (commit) { throw new Error('Duplicate packed ref'); }
            commit = match[1];
        }
    }
    if (!commit) { throw new Error('Missing branch ref'); }
    return { headName: ref.slice('refs/heads/'.length), headCommit: commit, identity };
}

function hasUnfinishedGitOperation(repoRoot: string, expectedIdentity?: string): boolean {
    try {
        const metadata = expectedIdentity === undefined ? undefined : resolveGitMetadata(repoRoot);
        if (metadata && metadata.identity !== expectedIdentity) { return true; }
        const gitDir = metadata?.gitDir ?? resolveGitDirectory(repoRoot);
        // These belong to the worktree gitdir, never its shared commondir.
        // mergeChanges only contains conflicts, not a clean --no-commit merge.
        for (const marker of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'sequencer']) {
            try { fs.statSync(path.join(gitDir, marker)); return true; }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { return true; }
            }
        }
        return false;
    } catch {
        // Unreadable/invalid metadata cannot establish a safe review context.
        return true;
    }
}

export function snapshotGitRepository(repository: GitRepositoryLike): GitContextSnapshot {
    const headName = repository.state.HEAD?.name;
    const headCommit = repository.state.HEAD?.commit;
    return {
        repoRoot: repository.rootUri.fsPath,
        kind: repository.kind ?? 'repository',
        headName,
        headCommit,
        detached: !!headCommit && !headName,
        inProgress: !!repository.state.rebaseCommit || repository.state.mergeChanges.length > 0
            || hasUnfinishedGitOperation(repository.rootUri.fsPath)
    };
}

export function compareGitContexts(baseline: GitContextSnapshot, current: GitContextSnapshot): GitContextComparison {
    if (baseline.repoRoot !== current.repoRoot || baseline.kind !== current.kind) {
        return { compatible: false, reason: 'Git repository or worktree identity changed' };
    }
    if (current.inProgress) {
        return { compatible: false, reason: 'Git operation is in progress or its metadata cannot be verified' };
    }
    if (baseline.detached !== current.detached) {
        return { compatible: false, reason: 'Git changed between a named branch and detached HEAD' };
    }
    if (baseline.detached) {
        return baseline.headCommit === current.headCommit
            ? { compatible: true }
            : { compatible: false, reason: 'Detached HEAD commit changed' };
    }
    if (baseline.headName || current.headName) {
        return baseline.headName === current.headName
            ? { compatible: true }
            : { compatible: false, reason: `Git branch changed from ${baseline.headName ?? '(unknown)'} to ${current.headName ?? '(unknown)'}` };
    }
    return baseline.headCommit === current.headCommit
        ? { compatible: true }
        : { compatible: false, reason: 'Git unborn or unnamed HEAD identity changed' };
}

/** Baseline-only text acceptance may cross named branches, never uncertain Git states. */
export function canKeepAcrossGitBranches(baseline: GitContextSnapshot, current: GitContextSnapshot): boolean {
    return baseline.repoRoot === current.repoRoot && baseline.kind === current.kind &&
        !baseline.inProgress && !current.inProgress && !baseline.detached && !current.detached &&
        !!baseline.headName && !!current.headName && !!baseline.headCommit && !!current.headCommit;
}

export class GitContextMonitor implements vscode.Disposable {
    private readyWaiters: Array<(ready: boolean) => void> = [];

    public whenReady(): Promise<boolean> {
        if (this.disposed) { return Promise.resolve(false); }
        if ((!this.api && !this.starting) || this.ready) { return Promise.resolve(true); }
        return new Promise(resolve => this.readyWaiters.push(resolve));
    }
    private readonly disposables: vscode.Disposable[] = [];
    private readonly repositoryDisposables = new Map<string, vscode.Disposable[]>();
    private readonly repositories = new Map<string, GitRepositoryLike>();
    private api: GitApiLike | undefined;
    private disposed = false;
    private ready = false;
    private starting = false;

    constructor(
        private readonly onContextEvent: (event: GitContextEvent) => void,
        private readonly extensionProvider: () => vscode.Extension<GitExtensionExportsLike> | undefined =
            () => vscode.extensions.getExtension<GitExtensionExportsLike>('vscode.git')
    ) { }

    public async start(): Promise<boolean> {
        if (this.disposed) { return false; }
        this.starting = true;
        try {
            const extension = this.extensionProvider();
            if (!extension) { return false; }
            const exports = extension.isActive ? extension.exports : await extension.activate();
            if (this.disposed || !exports?.enabled) { return false; }
            this.api = exports.getAPI(1);
            await this.discoverInitialRepositories();
            if (this.disposed) { return false; }
            this.disposables.push(
                this.api.onDidOpenRepository(repository => this.attachRepository(repository, this.ready)),
                this.api.onDidCloseRepository(repository => this.detachRepository(repository.rootUri.fsPath, this.ready)),
                this.api.onDidChangeState(state => {
                    if (state === 'initialized' && !this.ready) {
                        // Initial Git discovery establishes the reconciliation boundary. Repository
                        // events observed before this point belong to startup state and must not be
                        // mistaken for post-baseline Git changes.
                        this.refreshRepositories(false);
                        this.ready = true;
                        this.onContextEvent({ kind: 'ready', contexts: this.getSnapshots() });
                        this.readyWaiters.splice(0).forEach(resolve => resolve(true));
                        return;
                    }
                    this.refreshRepositories(this.ready);
                })
            );
            this.refreshRepositories(false);
            this.ready = this.api.state === 'initialized';
            return true;
        } catch {
            this.api = undefined;
            return false;
        } finally {
            this.starting = false;
            if (!this.api || this.ready || this.disposed) {
                this.readyWaiters.splice(0).forEach(resolve => resolve(!this.disposed));
            }
        }
    }

    private async discoverInitialRepositories(): Promise<void> {
        if (!this.api || this.disposed) { return; }
        const api = this.api;
        const initialRepositories = new Map(api.repositories.map(repository => [repository.rootUri.fsPath, repository]));
        if (api.getRepositoryRoot && api.openRepository) {
            for (const folder of vscode.workspace.workspaceFolders ?? []) {
                if (folder.uri.scheme !== 'file') { continue; }
                try {
                    if (this.disposed) { return; }
                    const root = await api.getRepositoryRoot(folder.uri);
                    if (this.disposed) { return; }
                    if (root && !initialRepositories.has(root.fsPath)) {
                        const repository = await api.openRepository(root);
                        if (this.disposed) { return; }
                        if (repository) { initialRepositories.set(repository.rootUri.fsPath, repository); }
                    }
                } catch {
                    // Git discovery is optional. Existing repository events remain active.
                }
            }
        }
        await Promise.all([...initialRepositories.values()].map(async repository => {
            try { await repository.status?.(); }
            catch { /* Later state events can retry context observation. */ }
            this.attachRepository(repository, false);
        }));
    }

    private refreshRepositories(emit = true): void {
        if (!this.api || this.disposed) { return; }
        const currentRoots = new Set(this.api.repositories.map(repository => repository.rootUri.fsPath));
        for (const root of [...this.repositories.keys()]) {
            if (!currentRoots.has(root)) { this.detachRepository(root, emit); }
        }
        for (const repository of this.api.repositories) { this.attachRepository(repository, emit); }
    }

    private attachRepository(repository: GitRepositoryLike, emit: boolean): void {
        if (this.disposed) { return; }
        const repoRoot = repository.rootUri.fsPath;
        const previous = this.repositories.get(repoRoot);
        if (previous !== repository) {
            this.detachRepository(repoRoot, false);
            this.repositories.set(repoRoot, repository);
            const subscriptions = [
                repository.state.onDidChange(() => this.emitRepository(repository))
            ];
            if (repository.onDidCheckout) {
                subscriptions.push(repository.onDidCheckout(() => this.emitRepository(repository)));
            }
            this.repositoryDisposables.set(repoRoot, subscriptions);
        }
        if (emit && this.ready) { this.emitRepository(repository); }
    }

    private emitRepository(repository: GitRepositoryLike): void {
        if (this.ready && !this.disposed && this.repositories.get(repository.rootUri.fsPath) === repository) {
            this.onContextEvent({ kind: 'changed', context: snapshotGitRepository(repository) });
        }
    }

    private detachRepository(repoRoot: string, emit: boolean): void {
        this.repositoryDisposables.get(repoRoot)?.forEach(disposable => disposable.dispose());
        this.repositoryDisposables.delete(repoRoot);
        const removed = this.repositories.delete(repoRoot);
        if (removed && emit && this.ready && !this.disposed) { this.onContextEvent({ kind: 'removed', repoRoot }); }
    }

    public getSnapshots(): GitContextSnapshot[] {
        return [...this.repositories.values()]
            .map(snapshotGitRepository)
            .sort((left, right) => left.repoRoot.localeCompare(right.repoRoot));
    }

    /** Fail closed until the extension's cached HEAD agrees with current on-disk Git metadata.
     * No async Git status/event can substitute for this synchronous final transaction guard.
     * Sample HEAD and operation markers twice to reject changes during metadata reads.
     * This is a bounded stability check, not an atomic lock against external Git processes.
     */
    public getVerifiedSnapshots(): GitContextSnapshot[] | undefined {
        if (!this.isReady()) { return undefined; }
        const snapshots: GitContextSnapshot[] = [];
        for (const repository of this.repositories.values()) {
            // Preserve even an unverifiable nested owner: dropping it could allow
            // the enclosing healthy repository to authorize Keep for its files.
            let snapshot: GitContextSnapshot = {
                repoRoot: repository.rootUri.fsPath, kind: repository.kind ?? 'repository',
                detached: false, inProgress: true
            };
            try {
                const before = readDiskHead(repository.rootUri.fsPath);
                snapshot = snapshotGitRepository(repository);
                const after = readDiskHead(repository.rootUri.fsPath);
                // An operation can start during the second HEAD read without changing
                // HEAD (e.g. merge --no-commit). Close that sampling gap at the same gitdir.
                const operationAfter = hasUnfinishedGitOperation(repository.rootUri.fsPath, after.identity);
                if (operationAfter || before.identity !== after.identity
                    || before.headName !== after.headName || before.headCommit !== after.headCommit
                    || snapshot.headName !== after.headName || snapshot.headCommit !== after.headCommit
                    || snapshot.detached !== !after.headName) { snapshot.inProgress = true; }
            } catch { snapshot.inProgress = true; }
            snapshots.push(snapshot);
        }
        return snapshots.sort((left, right) => left.repoRoot.localeCompare(right.repoRoot));
    }

    public getSnapshot(repoRoot: string): GitContextSnapshot | undefined {
        const repository = this.repositories.get(repoRoot);
        return repository ? snapshotGitRepository(repository) : undefined;
    }

    public isReady(): boolean {
        return !this.disposed && this.ready && this.api?.state === 'initialized';
    }

    public dispose(): void {
        this.readyWaiters.splice(0).forEach(resolve => resolve(false));
        if (this.disposed) { return; }
        this.disposed = true;
        this.disposables.forEach(disposable => disposable.dispose());
        this.disposables.length = 0;
        for (const root of [...this.repositories.keys()]) { this.detachRepository(root, false); }
        this.api = undefined;
        this.ready = false;
    }
}
