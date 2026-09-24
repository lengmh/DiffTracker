from pathlib import Path
import subprocess
import sys

def once(s,old,new):
    assert s.count(old)==1,(s.count(old),old[:120])
    return s.replace(old,new,1)

if sys.argv[1]=='tests':
    p=Path('test/pr12-bounded-invariants.mjs');s=p.read_text()
    at=s.rfind('\n}')
    assert at>0
    s=s[:at]+'\n'+Path('/tmp/pr12-audit/additional-tests.mjs').read_text()+s[at:]
    p.write_text(s)
    sys.exit(0)

assert sys.argv[1]=='source'
p=Path('src/diffTracker.ts');s=p.read_text()
old="if (!relativeDirectory && configuredScopeExplicitlyExcludesSubtree(scope, rootIdentity, ''))"
assert s.count(old)==2
s=s.replace(old,"if (configuredScopeExplicitlyExcludesSubtree(scope, rootIdentity, relativeDirectory))")
s=once(s,"        if (!this.isRecording || (!changed && this.pendingImportedDirectoryReconciliation.size === 0) || previousMatchers.size === 0 ||", """        // A scope/baseline transaction owns discovery and durable publication.
        // Recursive restore discovery here can await the enclosing transaction's
        // persistence barrier and deadlock Apply before its capture phase.
        if (this.baselineTransaction || !this.isRecording || (!changed && this.pendingImportedDirectoryReconciliation.size === 0) || previousMatchers.size === 0 ||""")
p.write_text(s)

# Fail explicitly if a future regression completes Apply before a required
# interleaving, rather than ending the entire test suite on an unsettled await.
p=Path('test/pr11-review-regressions.mjs');s=p.read_text()
s=once(s,'            const op=t.applyConfiguredMonitoringScope(candidate); await gate.entered;',"""            const op=t.applyConfiguredMonitoringScope(candidate);
            await Promise.race([
                gate.entered,
                op.then(result=>{throw new Error('Scope Apply completed before the coverage barrier: '+JSON.stringify(result));})
            ]);""")
p.write_text(s)

# Shared path-identity helpers are reached before/within scope preparation too.
# Cap allocations and return unverified on incomplete proof, never infer case
# semantics from a truncated listing. Cache a bounded number of directory entries.
p=Path('src/utils/pathIdentity.ts');s=p.read_text()
helper="""const maxIdentityDirectoryEntries = 10000;

function readIdentityDirectoryEntries(directory: string): fs.Dirent[] {
    const handle = fs.opendirSync(directory);
    try {
        const entries: fs.Dirent[] = [];
        while (true) {
            const entry = handle.readSync();
            if (!entry) { return entries; }
            if (entries.length >= maxIdentityDirectoryEntries) {
                throw new Error('Directory identity discovery exceeded its bounded entry limit');
            }
            entries.push(entry);
        }
    } finally { handle.closeSync(); }
}

"""
s=once(s,'export function asciiCaseFold',helper+'export function asciiCaseFold')
s=once(s,'        return fs.readdirSync(parent).filter(name => asciiCaseFold(name) === folded);',
    '        return directoryEntries(parent).map(entry => entry.name).filter(name => asciiCaseFold(name) === folded);')
s=once(s,'        const entries = fs.readdirSync(rootPath, { withFileTypes: true });',
    '        const entries = directoryEntries(rootPath);')
s=once(s,'const directoryEntriesCache = new Map<string, { signature: string; entries: fs.Dirent[] }>();',
    'const directoryEntriesCache = new Map<string, { signature: string; entries: fs.Dirent[] }>();\nlet cachedDirectoryEntryCount = 0;')
s=once(s,'    const entries = fs.readdirSync(directory, { withFileTypes: true });',
    '    const entries = readIdentityDirectoryEntries(directory);')
s=once(s,"""        if (directoryEntriesCache.size >= 4096) { directoryEntriesCache.clear(); }
        directoryEntriesCache.set(directory, { signature: before, entries });""","""        const previousCount = cached?.entries.length ?? 0;
        if (directoryEntriesCache.size >= 4096 ||
            cachedDirectoryEntryCount - previousCount + entries.length > maxIdentityDirectoryEntries) {
            directoryEntriesCache.clear();
            cachedDirectoryEntryCount = 0;
        } else {
            cachedDirectoryEntryCount -= previousCount;
        }
        directoryEntriesCache.set(directory, { signature: before, entries });
        cachedDirectoryEntryCount += entries.length;""")
p.write_text(s)
p=Path('test/pr11-final-scope-regressions.mjs');s=p.read_text()
s=once(s,"['existsSync', 'statSync', 'lstatSync', 'readdirSync', 'realpathSync']", "['existsSync', 'statSync', 'lstatSync', 'readdirSync', 'opendirSync', 'realpathSync']")
p.write_text(s)
# Keep original cache reuse/invalidation assertions; count the new filesystem seam.
p=Path('test/monitoring-scope.mjs');s=p.read_text()
a=s.index('        let flatEnumerations = 0;');b=s.index('\n    } finally {',a)
r=s[a:b].replace('originalReaddirSync','originalOpendirSync').replace('fs.readdirSync','fs.opendirSync')
s=s[:a]+r+s[b:];p.write_text(s)
subprocess.run(['git','add',str(p)],check=True)
p=Path('docs/pr12-systematic-audit-2026-09-25.md')
with p.open('a') as f:
    f.write('''\n## 7. 交叉回归发现并纳入本批的追加边界\n\n元数据发现跳过显式排除子树后，普通 preflight / candidate traversal 也必须在打开目录前使用同一 subtree 判定，不能只排除根目录。文件前缀节点是否可监控与是否需要枚举其子树仍然分开处理。\n\n全量旧回归定位了候选 matcher 变化触发的事务内重入：loadIgnoreMatchers 在 active baseline transaction 内调用 discoverRestoredFiles，后者的持久化等待同一事务完成，可能令 Apply 自等待。修复保留 matcher 构建，但把 discovery / publication 留给外层事务。\n\n共享 pathIdentity 工具也会在预算前读取目录。已将整目录 readdirSync 换为有上限的流式读取，限制缓存总条目数；不能完成身份验证时仍返回 unverified，不使用截断数据推测大小写。既有 case/Unicode/mount/symlink 测试及缓存复用/失效断言保留，文件系统模拟和调用计数同步支持 opendirSync。\n''')
print('Applied subtree, transaction-discovery and bounded path-identity closure.')
