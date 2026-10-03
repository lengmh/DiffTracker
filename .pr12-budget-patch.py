from pathlib import Path
import sys, hashlib, json
mode=sys.argv[1]
if mode=='register':
    p=Path('test/pr12-bounded-invariants.mjs'); s=p.read_text()
    anchor='    registerPR12LiteralEntryRegressions(h, fixture, scopeFor);'
    assert s.count(anchor)==1
    s="import { registerPR12RuntimeBudgetRegressions } from './pr12-runtime-identity-budget.mjs';\n"+s
    s=s.replace(anchor,anchor+'\n    registerPR12RuntimeBudgetRegressions(h, fixture, scopeFor);')
    p.write_text(s,encoding='utf-8',newline='\n')
    sys.exit()
if mode=='manifest':
    expected={'src/utils/pathIdentity.ts':'e76202b9b9859e87b3eb8f21c1849513fb7703a5d58e3f617cdfb3b92e6f1fdd','test/pr12-bounded-invariants.mjs':'6922a9497289e14450854be8b2bf2f90de60a92a84459ee36647acdd5ad4ee1c','test/pr12-runtime-identity-budget.mjs':'6629feabb13d78dad5731c5be2dfa4f48361dbced5598093380e2b3d28e66502'}
    actual={k:hashlib.sha256(Path(k).read_text(encoding='utf-8').encode()).hexdigest() for k in expected}
    assert actual==expected,(actual,expected)
    Path('budget-manifest.json').write_text(json.dumps(actual,sort_keys=True),encoding='utf-8',newline='\n')
    print(actual)
    sys.exit()
assert mode=='fix'
p=Path('src/utils/pathIdentity.ts'); s=p.read_text()
def one(a,b):
    global s
    assert s.count(a)==1,(a[:100],s.count(a))
    s=s.replace(a,b)
one('interface DirectoryEntryListing {', '''// Internal phase is explicit: a runtime allowance must never be mistaken for
// the caller-owned preparation budget merely because a budget object exists.
type IdentityLookupContext =
    | { kind: 'preparation'; budget: PathIdentityWorkBudget }
    | { kind: 'runtime'; budget: PathIdentityWorkBudget; prefixBudget: PathIdentityWorkBudget };

interface DirectoryEntryListing {''')
one('function readIdentityDirectoryEntries(directory: string): DirectoryEntryListing {', '''function readIdentityDirectoryEntries(
    directory: string,
    prefixBudget?: PathIdentityWorkBudget
): DirectoryEntryListing {''')
one('''            if (entries.length >= maxIdentityDirectoryEntries) {
                return { entries, byName, complete: false };
            }
            entries.push(entry);''','''            if (entries.length >= maxIdentityDirectoryEntries || !identityWorkAvailable(prefixBudget)) {
                return { entries, byName, complete: false };
            }
            consumeIdentityEntry(prefixBudget);
            entries.push(entry);''')
one('''function directoryEntries(
    directory: string,
    workBudget?: PathIdentityWorkBudget
): DirectoryEntryListing {''','''function directoryEntries(
    directory: string,
    workBudget?: PathIdentityWorkBudget,
    runtimePrefixBudget?: PathIdentityWorkBudget
): DirectoryEntryListing {''')
one('''    const listing = readIdentityDirectoryEntries(directory);
''','''    // Cache hits above cost no new directory reads. Cold/invalidated cache
    // construction shares one prefix allowance across the entire runtime path,
    // independently of the spelling-recovery allowance. Do not cache a fabricated
    // empty listing when an earlier component used the remaining prefix budget.
    if (runtimePrefixBudget && runtimePrefixBudget.remainingEntries <= 0) {
        return { entries: [], byName: new Map(), complete: false };
    }
    const listing = readIdentityDirectoryEntries(directory, runtimePrefixBudget);
''')
one('''    requestedPath: string,
    workBudget?: PathIdentityWorkBudget
): { actual?: string; unavailable: boolean; runtimeFallbackExhausted?: boolean } {
    const budget = workBudget ?? { remainingEntries: maxRuntimeIdentityFallbackWorkEntries };''','''    requestedPath: string,
    context: IdentityLookupContext
): { actual?: string; unavailable: boolean; runtimeFallbackExhausted?: boolean } {
    const budget = context.budget;
    const workBudget = context.kind === 'preparation' ? context.budget : undefined;''')
one('''    if (!evidence) {
        const entries: fs.Dirent[] = [];''','''    if (!evidence) {
        if (context.kind === 'runtime' && !identityWorkAvailable(budget)) {
            return { unavailable: true, runtimeFallbackExhausted: true };
        }
        const entries: fs.Dirent[] = [];''')
assert s.count('runtimeFallbackExhausted: !workBudget && budget.exhausted === true')==2
s=s.replace('runtimeFallbackExhausted: !workBudget && budget.exhausted === true',"runtimeFallbackExhausted: context.kind === 'runtime' && budget.exhausted === true")
one('''    const resolved: string[] = [];
    let current = path.resolve(rootPath);''','''    // Allocate once per path lookup, never once per component. Retain the
    // existing 10k cache-prefix and 20k fallback allowances, but bound their
    // totals even across several oversized directories and cache invalidations.
    // Preparation keeps its original shared budget and fail-closed semantics.
    const context: IdentityLookupContext = workBudget
        ? { kind: 'preparation', budget: workBudget }
        : { kind: 'runtime', budget: { remainingEntries: maxRuntimeIdentityFallbackWorkEntries },
            prefixBudget: { remainingEntries: maxIdentityDirectoryEntries } };
    const prefixBudget = context.kind === 'runtime' ? context.prefixBudget : undefined;
    const resolved: string[] = [];
    let current = path.resolve(rootPath);''')
assert s.count('directoryEntries(current, workBudget)')==2
s=s.replace('directoryEntries(current, workBudget)','directoryEntries(current, workBudget, prefixBudget)')
one('''                                requestedPath,
                                workBudget
''','''                                requestedPath,
                                context
''')
p.write_text(s,encoding='utf-8',newline='\n')
