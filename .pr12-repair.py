from pathlib import Path
import hashlib, json
root=Path('.')
def replace(file,old,new):
    p=root/file
    data=p.read_text(encoding='utf-8')
    count=data.count(old)
    if count!=1: raise RuntimeError(f'{file}: expected unique patch anchor, got {count}')
    p.write_text(data.replace(old,new),encoding='utf-8',newline='\n')
helper='''/** Prove one directory entry, not merely a shared hard-link inode.
 * Missing entries are distinct; inaccessible identity remains unknown.
 * Native canonical paths preserve distinct hard-link names without enumeration.
 */
export function sameExistingDirectoryEntry(left: string, right: string): boolean | undefined {
    try {
        const a = fs.lstatSync(left);
        const b = fs.lstatSync(right);
        if (a.isSymbolicLink() || b.isSymbolicLink()) { return false; }
        if (a.ino !== 0 && b.ino !== 0 && (a.dev !== b.dev || a.ino !== b.ino)) {
            return false;
        }
        return fs.realpathSync.native(left) === fs.realpathSync.native(right);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return code === 'ENOENT' || code === 'ENOTDIR' ? false : undefined;
    }
}

'''
replace('src/utils/pathIdentity.ts','export function pathIdentityText(',helper+'export function pathIdentityText(')
replace('src/diffTracker.ts',
"import { asciiCaseFold, detectLocalPathCaseSensitivity, PathIdentityWorkBudget, resolveRelativePathIdentity } from './utils/pathIdentity';",
"import { asciiCaseFold, detectLocalPathCaseSensitivity, PathIdentityWorkBudget, resolveRelativePathIdentity, sameExistingDirectoryEntry } from './utils/pathIdentity';")
replace('src/diffTracker.ts', '''    private sameExistingFilesystemEntry(left: string, right: string): boolean {
        try {
            const a = fs.lstatSync(left);
            const b = fs.lstatSync(right);
            if (a.isSymbolicLink() || b.isSymbolicLink()) { return false; }
            if (a.ino !== 0 && b.ino !== 0) {
                return a.dev === b.dev && a.ino === b.ino;
            }
            return fs.realpathSync.native(left) === fs.realpathSync.native(right);
        } catch {
            return false;
        }
    }''','''    private sameExistingFilesystemEntry(left: string, right: string): boolean {
        // An equal inode proves shared content, not the same directory entry.
        // Unknown identity must not merge a new name into an established key.
        return sameExistingDirectoryEntry(left, right) === true;
    }''')
replace('src/diffTracker.ts',"            const alternatives = match[1].split(',').map(value => value.trim()).filter(Boolean);",'''            // Glob alternatives are literal text: whitespace and empty branches
            // affect the watched resource set and must not be normalized away.
            const alternatives = match[1].split(',');''')
replace('src/monitoringScope.ts','    RelativePathIdentity,\n    resolveRelativePathIdentity','    RelativePathIdentity,\n    sameExistingDirectoryEntry,\n    resolveRelativePathIdentity')
replace('src/monitoringScope.ts', '''            return identityUnavailableForSafety(requested, requestedComponentCount) ||
                identityUnavailableForSafety(resolved, targetComponentCount) ||
                requested.identity === target.slice(0, index + 1).join('/');''','''            if (identityUnavailableForSafety(requested, requestedComponentCount) ||
                identityUnavailableForSafety(resolved, targetComponentCount)) { return true; }
            if (requested.identity === target.slice(0, index + 1).join('/')) { return true; }
            // Runtime spelling recovery may be bounded while both lookups still
            // exist. Preserve genuine aliases, but never equate hard-link names
            // by inode or grant permission after an inaccessible proof.
            if (!workBudget &&
                (runtimeBoundedExistingIdentity(requested, requestedComponentCount) ||
                    runtimeBoundedExistingIdentity(resolved, targetComponentCount)) &&
                requested.lookupVerifiedPrefixLength >= requestedComponentCount &&
                (resolved?.lookupVerifiedPrefixLength ?? 0) >= requestedComponentCount) {
                return sameExistingDirectoryEntry(
                    path.join(rootPath, ...target.slice(0, index), literal),
                    path.join(rootPath, ...target.slice(0, index + 1))
                ) !== false;
            }
            return false;''')
replace('test/pr12-bounded-invariants.mjs', '''                    // Case-equivalent positive matches are covered by the
                    // filesystem-alias exclusion regressions. This case is
                    // intentionally about the reviewer counterexample: bounded
                    // spelling uncertainty must not make an unrelated literal
                    // exclusion match.
''','''                    const aliasExclude={...scopeFor(tracker,'rules',[
                        {scope:'all',pattern:'/big/**'}
                    ]),roots:[identity]};
                    const excluded=evaluateConfiguredScope(
                        aliasExclude,identity,'Big/late.txt',false,false
                    );
                    assert.equal(excluded.monitored,false,
                        'a filesystem-proven case-insensitive alias exclusion must still match at the runtime cap');
                    assert.equal(excluded.source,'explicitExclude');
''')
replace('test/pr12-bounded-invariants.mjs',"import assert from 'node:assert/strict';", "import { registerPR12LiteralEntryRegressions } from './pr12-literal-entry-regressions.mjs';\nimport assert from 'node:assert/strict';")
replace('test/pr12-bounded-invariants.mjs',"    const serialized=tracker=>", "    registerPR12LiteralEntryRegressions(h, fixture, scopeFor);\n    const serialized=tracker=>")
files=['src/diffTracker.ts','src/monitoringScope.ts','src/utils/pathIdentity.ts','test/pr12-bounded-invariants.mjs','test/pr12-literal-entry-regressions.mjs']
manifest={f:hashlib.sha256(Path(f).read_bytes().replace(b'\r\n',b'\n')).hexdigest() for f in files}
Path('literal-manifest.json').write_text(json.dumps(manifest,sort_keys=True,indent=2)+'\n',encoding='utf-8',newline='\n')
print('Applied unique-anchor repair',manifest)
