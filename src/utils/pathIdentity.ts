import * as fs from 'fs';
import * as path from 'path';

const maxIdentityDirectoryEntries = 10000;
const maxCaseSensitivityProbeWorkEntries = maxIdentityDirectoryEntries;
const maxRuntimeIdentityFallbackWorkEntries = maxIdentityDirectoryEntries * 2;

export interface PathIdentityWorkBudget {
    remainingEntries: number;
    exhausted?: boolean;
    // Sparse operation-local cache for exact physical spellings. Unlike the
    // global prefix cache, this stores only entries the current preparation
    // actually proved and therefore does not consume extra discovery work.
    exactEntries?: Map<string, { signature: string; actual: string }>;
    physicalPaths?: Set<string>;
}

interface DirectoryEntryListing {
    entries: fs.Dirent[];
    byName: Map<string, fs.Dirent>;
    complete: boolean;
}

function identityWorkAvailable(budget?: PathIdentityWorkBudget): boolean {
    if (!budget) { return true; }
    if (budget.remainingEntries > 0) { return true; }
    budget.exhausted = true;
    return false;
}

function consumeIdentityEntry(budget?: PathIdentityWorkBudget): void {
    if (budget) { budget.remainingEntries--; }
}

function directoryIdentitySignature(directory: string): string {
    const stat = fs.statSync(directory);
    return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function readIdentityDirectoryEntries(directory: string): DirectoryEntryListing {
    const handle = fs.opendirSync(directory);
    try {
        const entries: fs.Dirent[] = [];
        const byName = new Map<string, fs.Dirent>();
        while (true) {
            const entry = handle.readSync();
            if (!entry) { return { entries, byName, complete: true }; }
            if (entries.length >= maxIdentityDirectoryEntries) {
                return { entries, byName, complete: false };
            }
            entries.push(entry);
            byName.set(entry.name, entry);
        }
    } finally { handle.closeSync(); }
}

export function asciiCaseFold(value: string): string {
    return value.replace(/[A-Z]/g, character => character.toLowerCase());
}

function toggleAsciiCase(value: string): string | undefined {
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code >= 65 && code <= 90) {
            return value.slice(0, index) + value[index].toLowerCase() + value.slice(index + 1);
        }
        if (code >= 97 && code <= 122) {
            return value.slice(0, index) + value[index].toUpperCase() + value.slice(index + 1);
        }
    }
    return undefined;
}

function sameExistingResource(left: string, right: string): boolean | undefined {
    try {
        const leftStat = fs.statSync(left);
        const rightStat = fs.statSync(right);
        if ((leftStat.ino !== 0 || rightStat.ino !== 0) &&
            leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino) {
            return true;
        }
        const leftReal = fs.realpathSync.native(left);
        const rightReal = fs.realpathSync.native(right);
        return leftReal === rightReal;
    } catch {
        return undefined;
    }
}

function caseEquivalentEntries(
    parent: string,
    requested: string,
    knownEntries?: readonly fs.Dirent[]
): string[] | undefined {
    try {
        const folded = asciiCaseFold(requested);
        const entries = knownEntries ?? directoryEntries(parent).entries;
        return entries.map(entry => entry.name).filter(name => asciiCaseFold(name) === folded);
    } catch {
        return undefined;
    }
}

function probeExistingPath(existingPath: string, knownParentEntries?: readonly fs.Dirent[]): boolean | undefined {
    const base = path.basename(existingPath);
    if (!base) { return undefined; }
    const parent = path.dirname(existingPath);
    const equivalentEntries = caseEquivalentEntries(parent, base, knownParentEntries);

    if (equivalentEntries) {
        // Two separately named directory entries that differ only by case prove
        // that this lookup boundary is case-sensitive. This remains true even if
        // they are hard links or symlinks to the same target.
        if (equivalentEntries.length > 1) { return true; }

        const [actualBase] = equivalentEntries;
        if (actualBase && actualBase !== base) {
            // The requested spelling is not an actual directory entry, but it
            // resolves. Verify that it reaches the unique real entry before using
            // that fact as positive evidence for case-insensitive lookup.
            const same = sameExistingResource(existingPath, path.join(parent, actualBase));
            if (same === true) { return false; }
            return undefined;
        }
    }

    const alternateBase = toggleAsciiCase(base);
    if (!alternateBase || alternateBase === base) { return undefined; }
    const alternate = path.join(parent, alternateBase);

    if (equivalentEntries?.includes(alternateBase)) {
        return true;
    }
    if (!fs.existsSync(alternate)) {
        return true;
    }
    const same = sameExistingResource(existingPath, alternate);
    if (same === false) { return true; }
    if (same === true) {
        // A case-sensitive directory can still contain a differently-cased
        // hard link or symlink to the same resource. The bounded parent prefix
        // may not contain that second spelling, so distinguish a real second
        // directory entry before accepting insensitive lookup semantics.
        try {
            const existing = fs.lstatSync(existingPath);
            const alternateEntry = fs.lstatSync(alternate);
            if (existing.isSymbolicLink() !== alternateEntry.isSymbolicLink() ||
                fs.realpathSync.native(existingPath) !== fs.realpathSync.native(alternate)) {
                return true;
            }
        } catch {
            return undefined;
        }
        // When the bounded parent prefix proves the requested spelling exists,
        // a differently-cased lookup resolving to that same canonical entry is
        // sufficient evidence for an insensitive boundary.
        return equivalentEntries?.includes(base) ? false : undefined;
    }
    return undefined;
}

export function detectLocalPathCaseSensitivity(
    rootPath: string,
    _platform: NodeJS.Platform = process.platform,
    workBudget?: PathIdentityWorkBudget
): boolean | undefined {
    // The parent directory's lookup of the workspace-root name is never proof
    // of lookup semantics *inside* that workspace. Per-directory case behavior,
    // symlink/junction targets and mount points can all differ without a device
    // boundary that is visible from the parent.
    const budget = workBudget ?? { remainingEntries: maxCaseSensitivityProbeWorkEntries };
    let handle: fs.Dir | undefined;
    try {
        handle = fs.opendirSync(rootPath);
        while (identityWorkAvailable(budget)) {
            const entry = handle.readSync();
            if (!entry) { break; }
            consumeIdentityEntry(budget);
            if (entry.isSymbolicLink() || !toggleAsciiCase(entry.name)) { continue; }
            const probe = probeExistingPath(path.join(rootPath, entry.name), [entry]);
            if (probe !== undefined) { return probe; }
        }
    } catch {
        // Fall through to the fail-closed result below.
    } finally {
        if (handle) {
            try { handle.closeSync(); } catch { /* Preserve the probe result/failure. */ }
        }
    }

    // Empty roots, unreadable roots, or roots without an internally probeable
    // entry remain unresolved. Callers may retry after workspace contents change.
    return undefined;
}

export interface RelativePathIdentity {
    identity: string;
    resolvedRelativePath: string;
    verifiedPrefixLength: number;
    unavailable: boolean;
}

// Cache listings, not case semantics or lookup results. Every reuse verifies the
// parent identity/metadata; each selected entry is still lstat'ed. In particular,
// a failed or ambiguous lookup is never cached as an equivalent spelling.
const directoryEntriesCache = new Map<string, {
    signature: string;
    entries: fs.Dirent[];
    byName: Map<string, fs.Dirent>;
    complete: boolean;
}>();
let cachedDirectoryEntryCount = 0;

function invalidateDirectoryEntries(directory: string): void {
    const cached = directoryEntriesCache.get(directory);
    if (!cached) { return; }
    directoryEntriesCache.delete(directory);
    cachedDirectoryEntryCount = Math.max(0, cachedDirectoryEntryCount - cached.entries.length);
}

function directoryEntries(
    directory: string,
    workBudget?: PathIdentityWorkBudget
): DirectoryEntryListing {
    const before = directoryIdentitySignature(directory);
    const cached = directoryEntriesCache.get(directory);
    if (cached?.signature === before) {
        return {
            entries: cached.entries,
            byName: cached.byName,
            complete: cached.complete
        };
    }
    if (cached) { invalidateDirectoryEntries(directory); }
    if (workBudget) {
        // Preparation must pay only for identity work it actually needs. Do not
        // spend the shared allowance materializing a reusable 10k prefix cache;
        // the caller will stream the requested entry below.
        return { entries: [], byName: new Map(), complete: false };
    }
    const listing = readIdentityDirectoryEntries(directory);
    if (directoryIdentitySignature(directory) === before) {
        if (directoryEntriesCache.size >= 4096 ||
            cachedDirectoryEntryCount + listing.entries.length > maxIdentityDirectoryEntries) {
            directoryEntriesCache.clear();
            cachedDirectoryEntryCount = 0;
        }
        directoryEntriesCache.set(directory, {
            signature: before,
            entries: listing.entries,
            byName: listing.byName,
            complete: listing.complete
        });
        cachedDirectoryEntryCount += listing.entries.length;
    }
    return listing;
}

function sameEntryLookup(left: string, right: string): boolean {
    const a = fs.lstatSync(left), b = fs.lstatSync(right);
    if (a.ino !== 0 && b.ino !== 0) { return a.dev === b.dev && a.ino === b.ino; }
    // Do not follow a symlink in order to prove entry identity.
    return !a.isSymbolicLink() && !b.isSymbolicLink() &&
        fs.realpathSync.native(left) === fs.realpathSync.native(right);
}

function streamDirectoryEntryIdentity(
    directory: string,
    requested: string,
    requestedPath: string,
    workBudget?: PathIdentityWorkBudget
): { actual?: string; unavailable: boolean } {
    // Runtime lookup has its own hard allowance. Preparation passes the shared
    // S4-A work budget instead, so identity proof cannot escape that contract.
    const budget = workBudget ?? { remainingEntries: maxRuntimeIdentityFallbackWorkEntries };
    const exactKey = path.resolve(directory) + '\0' + requested;
    const beforeSignature = directoryIdentitySignature(directory);
    const cachedExact = workBudget?.exactEntries?.get(exactKey);
    if (cachedExact?.signature === beforeSignature) {
        return { actual: cachedExact.actual, unavailable: false };
    }

    const scannedEntries: fs.Dirent[] = [];
    const handle = fs.opendirSync(directory);
    let exactScanCompleted = false;
    try {
        while (identityWorkAvailable(budget)) {
            const entry = handle.readSync();
            if (!entry) { exactScanCompleted = true; break; }
            consumeIdentityEntry(budget);
            scannedEntries.push(entry);
            if (entry.name === requested) {
                if (workBudget && directoryIdentitySignature(directory) === beforeSignature) {
                    (workBudget.exactEntries ??= new Map()).set(exactKey, {
                        signature: beforeSignature,
                        actual: entry.name
                    });
                }
                return { actual: entry.name, unavailable: false };
            }
        }
    } finally { handle.closeSync(); }
    if (!exactScanCompleted) { return { unavailable: true }; }

    // Exact spelling was absent. Reuse the bounded evidence already read above
    // rather than reopening the directory for an identity pass. This keeps
    // directory enumeration at O(n) per new literal proof; the lstat checks are
    // bounded by the same n entries that already consumed the work allowance.
    let match: string | undefined;
    for (const entry of scannedEntries) {
        try {
            if (!sameEntryLookup(requestedPath, path.join(directory, entry.name))) { continue; }
        } catch {
            continue;
        }
        if (match !== undefined) { return { unavailable: true }; }
        match = entry.name;
    }
    if (match === undefined) { return { unavailable: true }; }
    if (workBudget && directoryIdentitySignature(directory) === beforeSignature) {
        (workBudget.exactEntries ??= new Map()).set(exactKey, {
            signature: beforeSignature,
            actual: match
        });
    }
    return { actual: match, unavailable: false };
}

export function resolveRelativePathIdentity(
    rootPath: string,
    relativePath: string,
    _caseSensitive: boolean,
    workBudget?: PathIdentityWorkBudget
): RelativePathIdentity {
    const parts = relativePath.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/$/, '')
        .split('/').filter(Boolean);

    if (parts.length > 0 && workBudget?.physicalPaths) {
        let observed = path.resolve(rootPath);
        let allObserved = true;
        for (const part of parts) {
            observed = path.join(observed, part);
            if (!workBudget.physicalPaths.has(path.resolve(observed))) {
                allObserved = false;
                break;
            }
            try {
                if (fs.lstatSync(observed).isSymbolicLink()) {
                    allObserved = false;
                    break;
                }
            } catch {
                allObserved = false;
                break;
            }
        }
        if (allObserved) {
            const value = parts.join('/');
            return {
                identity: value,
                resolvedRelativePath: value,
                verifiedPrefixLength: parts.length,
                unavailable: false
            };
        }
    }

    const resolved: string[] = [];
    let current = path.resolve(rootPath);
    let physicalPrefixAvailable = true;
    let verifiedPrefixLength = 0;
    let unavailable = false;

    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
        const requested = parts[partIndex];
        let actual: string | undefined;
        if (physicalPrefixAvailable) {
            try {
                const requestedPath = path.join(current, requested);
                // Existence is checked before any directory enumeration. Missing
                // explicit targets therefore do not burn the identity allowance.
                const requestedStat = fs.lstatSync(requestedPath);

                // A verified case-sensitive workspace root makes successful
                // lookup of an exact first component sufficient physical
                // evidence. This optimization is safe only because forced alias
                // checks now pass the root's real lookup policy rather than a
                // synthetic `true`. Descendant components still require
                // filesystem-aware identity proof.
                if (partIndex === 0 && _caseSensitive === true) {
                    actual = requested;
                }

                let listing = actual === undefined
                    ? directoryEntries(current, workBudget)
                    : { entries: [], byName: new Map<string, fs.Dirent>(), complete: false };
                // Successful lookup is mandatory even for an ASCII candidate:
                // descendant directories can differ from the workspace root.
                let exact = actual === undefined ? listing.byName.get(requested) : undefined;
                if (!exact && listing.complete) {
                    // Some filesystems (notably Windows runners) can preserve a
                    // directory mtime/ctime signature across a rapid child create.
                    // Refresh a complete cache once. An incomplete cached prefix
                    // is already reusable evidence and falls through directly to
                    // the streaming target lookup below.
                    invalidateDirectoryEntries(current);
                    listing = directoryEntries(current, workBudget);
                    exact = listing.byName.get(requested);
                }
                if (actual === undefined) {
                    if (exact) {
                        actual = exact.name;
                    } else {
                        const streamed = streamDirectoryEntryIdentity(
                            current,
                            requested,
                            requestedPath,
                            workBudget
                        );
                        actual = streamed.actual;
                        unavailable ||= streamed.unavailable;
                    }
                }
                if (actual !== undefined) {
                    verifiedPrefixLength++;
                    if (requestedStat.isSymbolicLink()) {
                        physicalPrefixAvailable = false;
                        unavailable = true;
                    }
                }
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code !== 'ENOENT' && code !== 'ENOTDIR') { unavailable = true; }
            }
        }
        if (actual === undefined) { physicalPrefixAvailable = false; }
        // Missing descendants have no proven case mode. Never inherit a root
        // boolean or apply Unicode/ASCII folding to these unproved components.
        resolved.push(actual ?? requested);
        current = path.join(current, actual ?? requested);
    }
    const value = resolved.join('/');
    return { identity: value, resolvedRelativePath: value, verifiedPrefixLength, unavailable };
}

export function pathIdentityText(value: string, caseSensitive: boolean): string {
    const normalized = path.resolve(value);
    return caseSensitive ? normalized : asciiCaseFold(normalized);
}
