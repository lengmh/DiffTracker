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

function hasUnfinishedGitOperation(repoRoot: string): boolean {
    try {
        let gitDir = path.join(repoRoot, '.git');
        const stat = fs.statSync(gitDir);
        if (stat.isFile()) {
            if (stat.size > 65536) { return true; }
            const match = /^gitdir: (.+?)(?:\r?\n)?$/.exec(fs.readFileSync(gitDir, 'utf8'));
            if (!match) { return true; }
            gitDir = path.resolve(repoRoot, match[1]);
        } else if (!stat.isDirectory()) { return true; }
        if (!fs.statSync(gitDir).isDirectory()) { return true; }
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

export class GitContextMonitor implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];
    private readonly repositoryDisposables = new Map<string, vscode.Disposable[]>();
    private readonly repositories = new Map<string, GitRepositoryLike>();
    private api: GitApiLike | undefined;
    private disposed = false;
    private ready = false;

    constructor(
        private readonly onContextEvent: (event: GitContextEvent) => void,
        private readonly extensionProvider: () => vscode.Extension<GitExtensionExportsLike> | undefined =
            () => vscode.extensions.getExtension<GitExtensionExportsLike>('vscode.git')
    ) { }

    public async start(): Promise<boolean> {
        if (this.disposed) { return false; }
        const extension = this.extensionProvider();
        if (!extension) { return false; }
        try {
            const exports = extension.isActive ? extension.exports : await extension.activate();
            if (!exports?.enabled) { return false; }
            this.api = exports.getAPI(1);
            await this.discoverInitialRepositories();
            this.disposables.push(
                this.api.onDidOpenRepository(repository => this.attachRepository(repository, true)),
                this.api.onDidCloseRepository(repository => this.detachRepository(repository.rootUri.fsPath, true)),
                this.api.onDidChangeState(state => {
                    this.refreshRepositories();
                    if (state === 'initialized' && !this.ready) {
                        this.ready = true;
                        this.onContextEvent({ kind: 'ready', contexts: this.getSnapshots() });
                    }
                })
            );
            this.refreshRepositories(false);
            this.ready = this.api.state === 'initialized';
            return true;
        } catch {
            this.api = undefined;
            return false;
        }
    }

    private async discoverInitialRepositories(): Promise<void> {
        if (!this.api) { return; }
        const initialRepositories = new Map(this.api.repositories.map(repository => [repository.rootUri.fsPath, repository]));
        if (this.api.getRepositoryRoot && this.api.openRepository) {
            for (const folder of vscode.workspace.workspaceFolders ?? []) {
                if (folder.uri.scheme !== 'file') { continue; }
                try {
                    const root = await this.api.getRepositoryRoot(folder.uri);
                    if (root && !initialRepositories.has(root.fsPath)) {
                        const repository = await this.api.openRepository(root);
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
        if (emit) { this.emitRepository(repository); }
    }

    private emitRepository(repository: GitRepositoryLike): void {
        if (!this.disposed && this.repositories.get(repository.rootUri.fsPath) === repository) {
            this.onContextEvent({ kind: 'changed', context: snapshotGitRepository(repository) });
        }
    }

    private detachRepository(repoRoot: string, emit: boolean): void {
        this.repositoryDisposables.get(repoRoot)?.forEach(disposable => disposable.dispose());
        this.repositoryDisposables.delete(repoRoot);
        const removed = this.repositories.delete(repoRoot);
        if (removed && emit && !this.disposed) { this.onContextEvent({ kind: 'removed', repoRoot }); }
    }

    public getSnapshots(): GitContextSnapshot[] {
        return [...this.repositories.values()]
            .map(snapshotGitRepository)
            .sort((left, right) => left.repoRoot.localeCompare(right.repoRoot));
    }

    public getSnapshot(repoRoot: string): GitContextSnapshot | undefined {
        const repository = this.repositories.get(repoRoot);
        return repository ? snapshotGitRepository(repository) : undefined;
    }

    public isReady(): boolean {
        return this.ready;
    }

    public dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true;
        this.disposables.forEach(disposable => disposable.dispose());
        this.disposables.length = 0;
        for (const root of [...this.repositories.keys()]) { this.detachRepository(root, false); }
        this.api = undefined;
        this.ready = false;
    }
}
