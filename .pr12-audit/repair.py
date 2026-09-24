from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT=Path('.')
INPUT=Path('/tmp/pr12-audit')
SOURCE=ROOT/'src/diffTracker.ts'

def once(s, old, new):
    if s.count(old)!=1:
        raise RuntimeError(f'Expected one patch anchor, got {s.count(old)}: {old[:140]!r}')
    return s.replace(old,new,1)

def section(s,start,end,edit):
    a=s.index(start); b=s.index(end,a+len(start))
    return s[:a]+edit(s[a:b])+s[b:]

if sys.argv[1]=='tests':
    shutil.copyfile(INPUT/'tests.mjs',ROOT/'test/pr12-bounded-invariants.mjs')
    p=ROOT/'test/tracker-safety.mjs';s=p.read_text()
    s="import { registerPR12BoundedInvariants } from './pr12-bounded-invariants.mjs';\n"+s
    registration="""registerPR12BoundedInvariants({
    test, vscode, Uri, DiffTracker, file, document,
    getTracker: () => tracker, setTracker: value => { tracker=value; },
    setListedIgnores: value => { listedIgnores=value; }
});

"""
    s=once(s,"registerStateSchemaCompatibility({",registration+"registerStateSchemaCompatibility({")
    # Preserve deterministic filesystem fault/barrier seams when configured
    # policy loading switches from VS Code search to bounded native I/O.
    marker='let automationOnly=false;'
    seam="""const policyNativeOpen=fs.promises.open;
fs.promises.open=async(target,...args)=>{
    const handle=await policyNativeOpen(target,...args);
    if(path.basename(String(target))==='.gitignore'||String(target).endsWith(path.join('.git','info','exclude'))){
        const read=handle.read.bind(handle);
        handle.read=async(...readArgs)=>{fault(String(target),'read');const result=await read(...readArgs);await boundary(String(target),'read');return result;};
    }
    return handle;
};
const policyNativeOpendir=fs.promises.opendir;
fs.promises.opendir=async(...args)=>{await boundary(root,'ignoreScan');return policyNativeOpendir(...args);};
"""
    s=once(s,marker,seam+marker);p.write_text(s)
    sys.exit(0)

assert sys.argv[1]=='source'
assert subprocess.check_output(['git','hash-object',str(SOURCE)],text=True).strip()=='9fa1e0d4bc8aeedafe7d52cf43ae62ff54cc2c03'
s=SOURCE.read_text()

classes="""/** Revision tracking avoids rescanning the unresolved ledger after each
 * scanner-owned write, while still detecting equal-size live replacements. */
class UnresolvedBaselineMap extends Map<string, string> {
    public revision = 0;
    public constructor(entries?: Iterable<readonly [string, string]>) {
        super();
        if (entries) { for (const [key, value] of entries) { super.set(key, value); } }
    }
    public set(key: string, value: string): this {
        if (!this.has(key) || this.get(key) !== value) { this.revision++; }
        return super.set(key, value);
    }
    public delete(key: string): boolean {
        const removed = super.delete(key);
        if (removed) { this.revision++; }
        return removed;
    }
    public clear(): void {
        if (this.size > 0) { this.revision++; }
        super.clear();
    }
}

class IgnoreDiscoveryError extends Error {
    public constructor(public readonly limit: 'entries' | 'bytes' | 'invalidated', message: string) {
        super(message);
    }
}

interface IgnoreDiscoveryBudget {
    remainingEntries: number;
    remainingBytes: number;
    seenEntries: Set<string>;
    policyBytes: Map<string, number>;
    stillCurrent: () => boolean;
    onUnreadableDirectory?: (directory: string, error: unknown) => void;
}

"""
s=once(s,'interface CandidatePersistenceBudget {',classes+'interface CandidatePersistenceBudget {')
s=once(s,'    failedReason?: string;\n}', '''    failedReason?: string;
    accountedUnresolvedBaselineFiles: Map<string, string>;
    observedUnresolvedBaselineFiles: Map<string, string>;
    observedUnresolvedMap: Map<string, string>;
    observedUnresolvedRevision?: number;
}''')
s,n=re.subn(r'private unresolvedBaselineFiles(?:\s*:\s*Map<string,\s*string>)?\s*=\s*new Map<string,\s*string>\(\);',
    'private unresolvedBaselineFiles: Map<string, string> = new UnresolvedBaselineMap();',s)
assert n==1,('unresolved declaration',n)
s=re.sub(r'this\.unresolvedBaselineFiles = new Map(?:<string,\s*string>)?\(', 'this.unresolvedBaselineFiles = new UnresolvedBaselineMap(',s)

# Capture immutable accounting provenance, independent of live event evidence.
s=section(s,'    private createCandidatePersistenceBudget(','    private planScannedBaseline(',lambda r: once(r,
    '            opaqueBaselineFiles: this.opaqueBaselineFiles.size\n',
    '''            opaqueBaselineFiles: this.opaqueBaselineFiles.size,
            accountedUnresolvedBaselineFiles: new Map(this.unresolvedBaselineFiles),
            observedUnresolvedBaselineFiles: new Map(this.unresolvedBaselineFiles),
            observedUnresolvedMap: this.unresolvedBaselineFiles,
            observedUnresolvedRevision: this.unresolvedBaselineFiles instanceof UnresolvedBaselineMap
                ? this.unresolvedBaselineFiles.revision : undefined
'''))
s=section(s,'    private planScannedBaseline(','    private serializedArrayAppendBytes(',lambda r: once(r,
    "        if (this.isStableUnsupportedState(state)) {\n            return { kind: 'opaque', state };\n        }",
    """        if (this.isStableUnsupportedState(state)) {
            if (this.hasDirtyDocument(filePath)) {
                return {
                    kind: 'unresolved',
                    reason: 'Unsupported file has unsaved editor changes; save or discard them before clearing the baseline'
                };
            }
            return { kind: 'opaque', state };
        }"""))

sync="""    private synchronizeCandidateUnresolvedBudget(budget: CandidatePersistenceBudget): void {
        if (budget.failedReason) { throw new Error(budget.failedReason); }
        const source = this.unresolvedBaselineFiles;
        const revision = source instanceof UnresolvedBaselineMap ? source.revision : undefined;
        if (source === budget.observedUnresolvedMap && revision !== undefined &&
            revision === budget.observedUnresolvedRevision) { return; }
        const fail = (message: string): never => {
            budget.failedReason = message;
            throw new Error(message);
        };
        let count = budget.unresolvedBaselineFiles;
        let delta = 0;
        const updates = new Map<string, string | undefined>();
        for (const [filePath, previous] of budget.observedUnresolvedBaselineFiles) {
            const next = source.get(filePath);
            if (next === previous) { continue; }
            if (budget.accountedUnresolvedBaselineFiles.get(filePath) !== previous) {
                fail('Unresolved evidence changed while a replacement baseline was reserved; retry preparation');
            }
            if (next === undefined) {
                delta -= this.serializedArrayRemovalBytes(count, [filePath, previous]);
                count--;
            } else {
                delta += Buffer.byteLength(JSON.stringify([filePath, next]), 'utf8') -
                    Buffer.byteLength(JSON.stringify([filePath, previous]), 'utf8');
            }
            updates.set(filePath, next);
        }
        for (const [filePath, reason] of source) {
            if (budget.observedUnresolvedBaselineFiles.has(filePath)) { continue; }
            if (budget.accountedUnresolvedBaselineFiles.has(filePath)) {
                fail('New unresolved evidence conflicts with a reserved baseline; retry preparation');
            }
            delta += this.serializedArrayAppendBytes(count, [filePath, reason]);
            count++;
            updates.set(filePath, reason);
        }
        if (count > this.maxPersistedSnapshots) {
            fail('Monitoring scope unresolved snapshot capacity exceeded by concurrent evidence; narrow the scope before retrying');
        }
        if (delta > budget.remainingBytes) {
            fail('Monitoring scope persisted byte capacity exceeded by concurrent evidence; narrow the scope before retrying');
        }
        budget.remainingBytes -= delta;
        budget.unresolvedBaselineFiles = count;
        for (const [filePath, reason] of updates) {
            if (reason === undefined) { budget.accountedUnresolvedBaselineFiles.delete(filePath); }
            else { budget.accountedUnresolvedBaselineFiles.set(filePath, reason); }
        }
        budget.observedUnresolvedBaselineFiles = new Map(source);
        budget.observedUnresolvedMap = source;
        budget.observedUnresolvedRevision = revision;
    }

    private noteCandidateBudgetPublication(
        filePath: string,
        budget: CandidatePersistenceBudget,
        beforeReason: string | undefined,
        beforeRevision: number | undefined
    ): void {
        const actual = this.unresolvedBaselineFiles.get(filePath);
        if (actual !== budget.accountedUnresolvedBaselineFiles.get(filePath)) {
            budget.failedReason = 'Baseline classification changed during synchronous publication; retry preparation';
            throw new Error(budget.failedReason);
        }
        if (actual === undefined) { budget.observedUnresolvedBaselineFiles.delete(filePath); }
        else { budget.observedUnresolvedBaselineFiles.set(filePath, actual); }
        const source = this.unresolvedBaselineFiles;
        const revision = source instanceof UnresolvedBaselineMap ? source.revision : undefined;
        // Synchronous event subscribers may mutate another path. A revision
        // other than this publication's own change forces reconciliation next time.
        const ownChanges = actual === beforeReason ? 0 : 1;
        budget.observedUnresolvedMap = source;
        budget.observedUnresolvedRevision = beforeRevision !== undefined &&
            revision === beforeRevision + ownChanges ? revision : undefined;
    }

"""
s=once(s,'    private consumeCandidatePersistenceBudget(',sync+'    private consumeCandidatePersistenceBudget(')
def patch_consume(r):
    r=once(r,'        filePath = this.canonicalTrackingPath(filePath);\n        const existingUnresolvedReason = this.unresolvedBaselineFiles.get(filePath);',
        '        this.synchronizeCandidateUnresolvedBudget(budget);\n        filePath = this.canonicalTrackingPath(filePath);\n        const existingUnresolvedReason = budget.accountedUnresolvedBaselineFiles.get(filePath);')
    return once(r,'''        } else if (!replacingUnresolved) {
            budget.unresolvedBaselineFiles++;
        }
    }
''','''        } else if (!replacingUnresolved) {
            budget.unresolvedBaselineFiles++;
        }
        if (plan.kind === 'unresolved') {
            budget.accountedUnresolvedBaselineFiles.set(filePath, plan.reason);
        } else {
            budget.accountedUnresolvedBaselineFiles.delete(filePath);
        }
    }
''')
s=section(s,'    private consumeCandidatePersistenceBudget(','    private async captureConfiguredExpansionBaselines(',patch_consume)

# One authoritative synchronous eligibility -> plan -> charge -> publication.
record="""    private recordScannedBaseline(
        filePath: string,
        state: CurrentFileState,
        scope: 'workspace' | 'repository',
        budget?: CandidatePersistenceBudget
    ): boolean {
        filePath = this.canonicalTrackingPath(filePath);
        const uri = vscode.Uri.file(filePath);
        if (this.pendingScopeExplicitlyExcludes(uri) || this.hasCapturedBaseline(filePath) ||
            this.isPathIgnored(uri)) { return false; }
        const plan = this.planScannedBaseline(filePath, state, scope);
        if (budget) { this.consumeCandidatePersistenceBudget(filePath, plan, budget); }
        const beforeReason = this.unresolvedBaselineFiles.get(filePath);
        const beforeRevision = this.unresolvedBaselineFiles instanceof UnresolvedBaselineMap
            ? this.unresolvedBaselineFiles.revision : undefined;
        if (plan.kind === 'text') {
            this.unresolvedBaselineFiles.delete(filePath);
            this.fileSnapshots.set(filePath, plan.content);
            if (plan.mode !== undefined) { this.fileModes.set(filePath, plan.mode); }
            this.baselineExistingFiles.add(filePath);
        } else if (plan.kind === 'opaque') {
            this.recordOpaqueBaseline(filePath, plan.state);
        } else {
            this.recordUnresolvedBaseline(filePath, plan.reason);
        }
        if (budget) { this.noteCandidateBudgetPublication(filePath, budget, beforeReason, beforeRevision); }
        return true;
    }

"""
s=section(s,'    private recordScannedBaseline(','    private recordOpaqueBaseline(',lambda _:record)
s=once(s,"""            const plan = this.planScannedBaseline(filePath, state, 'workspace');
            this.consumeCandidatePersistenceBudget(filePath, plan, persistenceBudget);
            this.recordScannedBaseline(filePath, state, 'workspace');
            captured++;
""","""            if (this.recordScannedBaseline(filePath, state, 'workspace', persistenceBudget)) { captured++; }
""")
s=once(s,"""                    if (wholeWorkspacePersistenceBudget) {
                        const plan = this.planScannedBaseline(filePath, state, 'workspace');
                        this.consumeCandidatePersistenceBudget(filePath, plan, wholeWorkspacePersistenceBudget);
                    }
                    this.recordScannedBaseline(filePath, state, 'workspace');
""","""                    this.recordScannedBaseline(filePath, state, 'workspace', wholeWorkspacePersistenceBudget);
""")
s=once(s,"""                const plan = this.planScannedBaseline(uri.fsPath, state, 'repository');
                this.consumeCandidatePersistenceBudget(uri.fsPath, plan, repositoryPersistenceBudget);
                this.recordScannedBaseline(uri.fsPath, state, 'repository');
""","""                this.recordScannedBaseline(uri.fsPath, state, 'repository', repositoryPersistenceBudget);
""")

# Do not allow siblings to outlive a failed concurrent scan and its rollback.
s=section(s,'    private async runWithConcurrency<T>(', '    private async yieldToEventLoop(',lambda _:"""    private async runWithConcurrency<T>(
        items: T[],
        limit: number,
        worker: (item: T) => Promise<void>
    ): Promise<void> {
        let index = 0;
        let failed = false;
        let failure: unknown;
        const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (!failed && index < items.length) {
                const current = items[index++];
                try { await worker(current); }
                catch (error) {
                    if (!failed) { failure = error; }
                    failed = true;
                }
            }
        });
        await Promise.all(workers);
        if (failed) { throw failure; }
    }

""")

# A workspace slice can start INSIDE a nested repository, not only at its root.
s=once(s,'                    skipTraversalPath: targetPath => nestedRepositoryRootSet.has(path.resolve(targetPath))',"""                    skipTraversalPath: targetPath => {
                        for (let current = path.resolve(targetPath); ; current = path.dirname(current)) {
                            if (nestedRepositoryRootSet.has(current)) { return true; }
                            if (current === normalizedRepoRoot || path.dirname(current) === current) { return false; }
                        }
                    }""")

# Shared bounded configured ignore-policy loader. Legacy V3 remains on its
# compatibility discovery path; every configured builder uses this path.
policy_helpers="""    private createIgnoreDiscoveryBudget(stillCurrent: () => boolean): IgnoreDiscoveryBudget {
        return {
            remainingEntries: this.maxScopePreflightEntries,
            remainingBytes: this.maxPersistedBytes,
            seenEntries: new Set<string>(),
            policyBytes: new Map<string, number>(),
            stillCurrent
        };
    }

    private checkIgnoreDiscovery(budget: IgnoreDiscoveryBudget): void {
        if (!budget.stillCurrent()) {
            throw new IgnoreDiscoveryError('invalidated', 'Monitoring scope ignore-policy preparation was invalidated');
        }
    }

    private consumeIgnoreDiscoveryEntry(budget: IgnoreDiscoveryBudget, targetPath: string): void {
        this.checkIgnoreDiscovery(budget);
        const key = path.resolve(targetPath);
        if (budget.seenEntries.has(key)) { return; }
        if (budget.remainingEntries <= 0) {
            throw new IgnoreDiscoveryError('entries',
                'Monitoring scope preparation work budget would exceed ' +
                this.maxScopePreflightEntries + ' inspected directory entries during ignore-policy discovery');
        }
        budget.remainingEntries--;
        budget.seenEntries.add(key);
    }

    private async readBudgetedIgnoreFile(
        uri: vscode.Uri,
        rootPath: string,
        budget: IgnoreDiscoveryBudget
    ): Promise<string> {
        this.checkIgnoreDiscovery(budget);
        // Local file scope only. Do not follow an internal metadata symlink.
        for (let current = uri.fsPath; path.resolve(current) !== path.resolve(rootPath); current = path.dirname(current)) {
            if (fs.lstatSync(current).isSymbolicLink()) { throw new Error('Symbolic link ignore policy cannot establish scope coverage'); }
            if (path.dirname(current) === current) { throw new Error('Ignore policy escaped its workspace root'); }
        }
        const key = path.resolve(uri.fsPath);
        const previousBytes = budget.policyBytes.get(key) ?? 0;
        const allowance = Math.min(5 * 1024 * 1024, budget.remainingBytes + previousBytes);
        const handle = await fs.promises.open(uri.fsPath, 'r');
        try {
            this.checkIgnoreDiscovery(budget);
            const before = await handle.stat();
            if (!before.isFile() || before.size > allowance) {
                throw new IgnoreDiscoveryError('bytes', 'Monitoring scope ignore-policy byte budget exceeded before reading ' + uri.fsPath);
            }
            const chunks: Buffer[] = [];
            let length = 0;
            while (true) {
                this.checkIgnoreDiscovery(budget);
                const chunk = Buffer.alloc(Math.min(64 * 1024, allowance - length + 1));
                const read = await handle.read(chunk, 0, chunk.length, null);
                this.checkIgnoreDiscovery(budget);
                if (read.bytesRead === 0) { break; }
                length += read.bytesRead;
                if (length > allowance) {
                    throw new IgnoreDiscoveryError('bytes', 'Monitoring scope ignore-policy byte budget exceeded while reading ' + uri.fsPath);
                }
                chunks.push(chunk.subarray(0, read.bytesRead));
            }
            const after = await handle.stat();
            const current = fs.lstatSync(uri.fsPath);
            if (before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
                current.isSymbolicLink() || current.ino !== after.ino || current.dev !== after.dev ||
                current.size !== after.size || current.mtimeMs !== after.mtimeMs) {
                throw new Error('Ignore policy changed during bounded read; retry discovery');
            }
            budget.remainingBytes += previousBytes - length;
            budget.policyBytes.set(key, length);
            return new TextDecoder('utf-8').decode(Buffer.concat(chunks, length));
        } finally { await handle.close(); }
    }

    private async readConfiguredIgnoreMatcher(
        folder: vscode.WorkspaceFolder,
        matcher: Ignore,
        evidence: string[],
        scope: CanonicalMonitoringScope,
        budget: IgnoreDiscoveryBudget
    ): Promise<Ignore> {
        const rootPath = path.resolve(folder.uri.fsPath);
        const identity = this.workspaceRootIdentityForFolder(folder);
        this.checkIgnoreDiscovery(budget);
        if (configuredScopeExplicitlyExcludesSubtree(scope, identity, '')) { return matcher; }
        const info = path.join(rootPath, '.git', 'info', 'exclude');
        if (fs.existsSync(info)) {
            const text = await this.readBudgetedIgnoreFile(vscode.Uri.file(info), rootPath, budget);
            this.addGitignorePatterns(matcher, text, '');
            evidence.push('.git/info/exclude', text);
        }
        const policies: Array<[string, string]> = [];
        const pending = [rootPath];
        while (pending.length > 0) {
            this.checkIgnoreDiscovery(budget);
            const directory = pending.pop()!;
            if (!this.workspaceFolderOwnsTraversalPath(folder, directory)) { continue; }
            const relative = this.toPosixPath(path.relative(rootPath, directory));
            if (configuredScopeExplicitlyExcludesSubtree(scope, identity, relative) ||
                relative && isHardUnmonitorableRelativePath(relative, identity, true)) { continue; }
            if (relative && !evaluateConfiguredScope(scope, identity, relative,
                matcher.ignores(relative + '/'), true).monitored) { continue; }

            const policyPath = path.join(directory, '.gitignore');
            let policyStat: fs.Stats | undefined;
            try { policyStat = fs.lstatSync(policyPath); }
            catch (error) { if (!this.isFileNotFound(error)) { throw error; } }
            if (policyStat?.isFile() || policyStat?.isSymbolicLink()) {
                const uri = vscode.Uri.file(policyPath);
                const disposition = this.excludedIgnoreFileDisposition(uri, scope);
                if (disposition === 'block') {
                    throw new Error('Explicitly excluded .gitignore cannot be ignored while its parent subtree remains monitored; nested ignore policy is unavailable');
                }
                if (disposition === 'read') {
                    this.consumeIgnoreDiscoveryEntry(budget, policyPath);
                    const text = await this.readBudgetedIgnoreFile(uri, rootPath, budget);
                    this.addGitignorePatterns(matcher, text, relative ? relative + '/' : '');
                    policies.push([this.toPosixPath(path.relative(rootPath, policyPath)), text]);
                }
            }
            let handle: fs.Dir | undefined;
            try {
                handle = await fs.promises.opendir(directory);
                this.checkIgnoreDiscovery(budget);
                while (true) {
                    const entry = handle.readSync();
                    if (!entry) { break; }
                    const child = path.join(directory, entry.name);
                    this.consumeIgnoreDiscoveryEntry(budget, child);
                    const kind = this.classifyDirectoryEntry(directory, entry);
                    if (kind !== 'directory' || !this.workspaceFolderOwnsTraversalPath(folder, child)) { continue; }
                    const childRelative = this.toPosixPath(path.relative(rootPath, child));
                    if (isHardUnmonitorableRelativePath(childRelative, identity, true) ||
                        configuredScopeExplicitlyExcludesSubtree(scope, identity, childRelative)) { continue; }
                    if (evaluateConfiguredScope(scope, identity, childRelative,
                        matcher.ignores(childRelative + '/'), true).monitored) { pending.push(child); }
                }
            } catch (error) {
                if (error instanceof IgnoreDiscoveryError) { throw error; }
                if (this.isFileNotFound(error)) { continue; }
                if (!budget.onUnreadableDirectory) { throw error; }
                budget.onUnreadableDirectory(directory, error);
            } finally { if (handle) { handle.closeSync(); } }
        }
        policies.sort(([left], [right]) => left.localeCompare(right));
        for (const [relative, text] of policies) { evidence.push(relative, text); }
        return matcher;
    }

"""
s=once(s,'    private async getGitignoreFiles(',policy_helpers+'    private async getGitignoreFiles(')

def patch_build(r):
    r=once(r,'        includeLegacyWatchExclude = true\n','        includeLegacyWatchExclude = true,\n        discoveryBudget?: IgnoreDiscoveryBudget\n')
    r=once(r,'                    includeLegacyWatchExclude\n','                    includeLegacyWatchExclude,\n                    discoveryBudget\n')
    return once(r,'            } catch (error) {\n','            } catch (error) {\n                if (error instanceof IgnoreDiscoveryError) { throw error; }\n')
s=section(s,'    private async buildIgnoreMatcher(','    private async readIgnoreMatcher(',patch_build)
def patch_read(r):
    r=once(r,'        includeLegacyWatchExclude = true\n','        includeLegacyWatchExclude = true,\n        discoveryBudget?: IgnoreDiscoveryBudget\n')
    return once(r,'        // Repository-local excludes have lower priority than .gitignore files.',"""        const configured = scopeOverride ?? (this.effectiveMonitoringScope.kind === 'configured'
            ? this.effectiveMonitoringScope as CanonicalMonitoringScope : undefined);
        if (configured) {
            const epoch = this.sessionEpoch;
            return this.readConfiguredIgnoreMatcher(folder, ig, evidence, configured,
                discoveryBudget ?? this.createIgnoreDiscoveryBudget(() => this.isCurrentEpoch(epoch)));
        }

        // Repository-local excludes have lower priority than .gitignore files.""")
s=section(s,'    private async readIgnoreMatcher(','    private excludedIgnoreFileDisposition(',patch_read)

def patch_load(r):
    r=once(r,'        const matchers = new Map<string, Ignore>();',"""        const matchers = new Map<string, Ignore>();
        const transaction = this.baselineTransaction;
        const discoveryBudget = this.effectiveMonitoringScope.kind === 'configured'
            ? this.createIgnoreDiscoveryBudget(() => this.isCurrentEpoch(epoch) &&
                version === this.ignoreRefreshVersion && this.baselineTransaction === transaction &&
                (!transaction?.valid || transaction.valid()))
            : undefined;""")
    return once(r,'            const matcher = await this.buildIgnoreMatcher(folder, evidence, nextLegacyPolicy);',"""            let matcher: Ignore;
            try {
                matcher = await this.buildIgnoreMatcher(folder, evidence, nextLegacyPolicy,
                    undefined, true, discoveryBudget);
            } catch (error) {
                if (!this.isCurrentEpoch(epoch) || version !== this.ignoreRefreshVersion) { return; }
                throw error;
            }""")
s=section(s,'    private async loadIgnoreMatchers(','    private getDefaultExcludePatterns(',patch_load)

def patch_preflight(r):
    r=once(r,'        const epoch = this.sessionEpoch;\n','        const epoch = this.sessionEpoch;\n        const ignoreVersion = this.ignoreRefreshVersion;\n')
    r=once(r,'            this.isCurrentEpoch(epoch) && requestStillCurrent() &&\n','            this.isCurrentEpoch(epoch) && requestStillCurrent() &&\n            ignoreVersion === this.ignoreRefreshVersion && !this.baselineTransaction &&\n')
    r=once(r,'        const preflightIgnoreMatchers = new Map<string, Ignore>();',"""        const ignoreBudget = this.createIgnoreDiscoveryBudget(contextStillCurrent);
        const unreadablePolicyDirectories = new Set<string>();
        ignoreBudget.onUnreadableDirectory = (directory, error) => {
            const key = path.resolve(directory);
            if (unreadablePolicyDirectories.has(key)) { return; }
            unreadablePolicyDirectories.add(key);
            result.unreadableDirectoryCount++;
            if (result.unreadableDirectories.length >= this.maxScopePreflightDiagnostics) { return; }
            const owner = this.owningWorkspaceFolderForTraversal(directory);
            result.unreadableDirectories.push({
                root: owner?.name ?? '',
                path: owner ? this.toPosixPath(path.relative(owner.uri.fsPath, directory)) || '.' : directory,
                reason: error instanceof Error ? error.message : String(error)
            });
        };
        const preflightIgnoreMatchers = new Map<string, Ignore>();""")
    r=once(r,'        for (const folder of this.getSupportedWorkspaceFolders()) {\n            try {',"""        for (const folder of this.getSupportedWorkspaceFolders()) {
            if (configuredScopeExplicitlyExcludesSubtree(scope, this.workspaceRootIdentityForFolder(folder), '')) { continue; }
            try {""")
    r=once(r,'                    scope,\n                    false\n','                    scope,\n                    false,\n                    ignoreBudget\n')
    r=once(r,'            } catch (error) {\n                return failed(',"""            } catch (error) {
                if (error instanceof IgnoreDiscoveryError && error.limit === 'invalidated') {
                    return conflict(error.message);
                }
                if (error instanceof IgnoreDiscoveryError && error.limit === 'entries') {
                    result.inspectedEntries = this.maxScopePreflightEntries - ignoreBudget.remainingEntries;
                    result.truncated = true;
                    result.reason = error.message;
                    return result;
                }
                return failed(""")
    r=once(r,'        const pending = this.getSupportedWorkspaceFolders().map(folder => ({',
        '        result.inspectedEntries = this.maxScopePreflightEntries - ignoreBudget.remainingEntries;\n        const pending = this.getSupportedWorkspaceFolders().map(folder => ({')
    r=once(r,'            const { folder, directory } = pending.pop()!;\n',
        '            const { folder, directory } = pending.pop()!;\n            if (unreadablePolicyDirectories.has(path.resolve(directory))) { continue; }\n')
    r=once(r,"""                    if (result.inspectedEntries >= this.maxScopePreflightEntries) {
                        result.truncated = true;
                        break;
                    }
                    result.inspectedEntries++;
                    directoryEntries++;

                    const child = path.join(directory, entry.name);""","""                    const child = path.join(directory, entry.name);
                    if (!ignoreBudget.seenEntries.has(path.resolve(child)) && ignoreBudget.remainingEntries <= 0) {
                        result.truncated = true;
                        break;
                    }
                    this.consumeIgnoreDiscoveryEntry(ignoreBudget, child);
                    result.inspectedEntries = this.maxScopePreflightEntries - ignoreBudget.remainingEntries;
                    directoryEntries++;""")
    return r
s=section(s,'    public async preflightConfiguredMonitoringScope(','    private async enumerateExplicitIncludeFiles(',patch_preflight)

SOURCE.write_text(s)
shutil.copyfile(INPUT/'audit.md',ROOT/'docs/pr12-systematic-audit-2026-09-25.md')
print('Applied systematic repair; no publication/CI configuration changes are part of the source commit.')
