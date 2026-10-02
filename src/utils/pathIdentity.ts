import * as fs from 'fs';
import * as path from 'path';

const maxIdentityDirectoryEntries = 10000;
const maxCaseSensitivityProbeWorkEntries = maxIdentityDirectoryEntries;
const maxRuntimeIdentityFallbackWorkEntries = maxIdentityDirectoryEntries * 2;

export interface PathIdentityWorkBudget {
    remainingEntries: number;
    exhausted?: boolean;
    // Sparse operation-local cache for exact/alias physical spellings.
    exactEntries?: Map<string, { signature: string; actual: string }>;
    physicalPaths?: Set<string>;
    // Bounded directory evidence acquired by this preparation. Entries stored
    // here have already consumed the operation work allowance, so later identity
    // queries for the same parent must reuse them instead of reopening/scanning.
    directoryEvidence?: Map<string, {
        signature: string;
        entries: fs.Dirent[];
        byName: Map<string, fs.Dirent>;
        complete: boolean;
    }>;
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
    // Components for which the requested lookup itself was proven to exist,
    // even when bounded runtime enumeration could not recover physical spelling.
    lookupVerifiedPrefixLength: number;
    // True only when the remaining uncertainty is caused solely by the runtime
    // fallback cap. Preparation budgets never set this escape hatch.
    runtimeFallbackExhausted?: boolean;
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
): { actual?: string; unavailable: boolean; runtimeFallbackExhausted?: boolean } {
    const budget = workBudget ?? { remainingEntries: maxRuntimeIdentityFallbackWorkEntries };
    const directoryKey = path.resolve(directory);
    const exactKey = directoryKey + '\0' + requested;
    const beforeSignature = directoryIdentitySignature(directory);
    const cachedExact = workBudget?.exactEntries?.get(exactKey);
    if (cachedExact?.signature === beforeSignature) {
        return { actual: cachedExact.actual, unavailable: false };
    }

    let evidence = workBudget?.directoryEvidence?.get(directoryKey);
    if (evidence?.signature !== beforeSignature) {
        workBudget?.directoryEvidence?.delete(directoryKey);
        evidence = undefined;
    }

    if (!evidence) {
        const entries: fs.Dirent[] = [];
        const byName = new Map<string, fs.Dirent>();
        let complete = false;
        const handle = fs.opendirSync(directory);
        try {
            while (true) {
                // Reading EOF is not identity work. Probe first so a directory
                // with exactly N entries can prove completeness with an N-entry
                // allowance; a non-null N+1 lookahead still exhausts the bound.
                const entry = handle.readSync();
                if (!entry) { complete = true; break; }
                if (!identityWorkAvailable(budget)) { break; }
                consumeIdentityEntry(budget);
                entries.push(entry);
                byName.set(entry.name, entry);
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

        evidence = { signature: beforeSignature, entries, byName, complete };
        if (workBudget && directoryIdentitySignature(directory) === beforeSignature) {
            (workBudget.directoryEvidence ??= new Map()).set(directoryKey, evidence);
        }
        if (!complete) {
            return {
                unavailable: true,
                runtimeFallbackExhausted: !workBudget && budget.exhausted === true
            };
        }
    }

    const exact = evidence.byName.get(requested);
    if (exact) {
        if (workBudget) {
            (workBudget.exactEntries ??= new Map()).set(exactKey, {
                signature: evidence.signature,
                actual: exact.name
            });
        }
        return { actual: exact.name, unavailable: false };
    }
    if (!evidence.complete) {
        return {
            unavailable: true,
            runtimeFallbackExhausted: !workBudget && budget.exhausted === true
        };
    }

    // An exact spelling is absent. A successful lookup can only be accepted as
    // an alias when the bounded directory evidence contains a unique ASCII-case
    // equivalent physical spelling that resolves to the same entry. Do not scan
    // every unrelated entry with lstat/realpath and do not use Unicode JS folding.
    const folded = asciiCaseFold(requested);
    const candidates = evidence.entries.filter(entry => asciiCaseFold(entry.name) === folded);
    if (candidates.length !== 1) { return { unavailable: true }; }
    const candidate = candidates[0];
    try {
        if (!sameEntryLookup(requestedPath, path.join(directory, candidate.name))) {
            return { unavailable: true };
        }
    } catch {
        return { unavailable: true };
    }
    if (workBudget) {
        (workBudget.exactEntries ??= new Map()).set(exactKey, {
            signature: evidence.signature,
            actual: candidate.name
        });
    }
    return { actual: candidate.name, unavailable: false };
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
                unavailable: false,
                lookupVerifiedPrefixLength: parts.length
            };
        }
    }

    const resolved: string[] = [];
    let current = path.resolve(rootPath);
    let physicalPrefixAvailable = true;
    let lookupPrefixAvailable = true;
    let verifiedPrefixLength = 0;
    let lookupVerifiedPrefixLength = 0;
    let unavailable = false;
    let runtimeFallbackExhausted = false;
    let nonRuntimeUnavailable = false;

    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
        const requested = parts[partIndex];
        let actual: string | undefined;
        if (lookupPrefixAvailable) {
            try {
                const requestedPath = path.join(current, requested);
                // Existence is checked before any directory enumeration. A
                // successful lookup remains useful coverage evidence even when
                // the bounded runtime spelling scan later exhausts its cap.
                const requestedStat = fs.lstatSync(requestedPath);
                lookupVerifiedPrefixLength++;

                if (requestedStat.isSymbolicLink()) {
                    unavailable = true;
                    nonRuntimeUnavailable = true;
                    physicalPrefixAvailable = false;
                } else if (physicalPrefixAvailable) {
                    // A verified case-sensitive workspace root makes successful
                    // lookup of an exact first component sufficient physical
                    // evidence. Descendant components still require filesystem
                    // spelling proof because per-directory semantics may differ.
                    if (partIndex === 0 && _caseSensitive === true) {
                        actual = requested;
                    }

                    let listing = actual === undefined
                        ? directoryEntries(current, workBudget)
                        : { entries: [], byName: new Map<string, fs.Dirent>(), complete: false };
                    let exact = actual === undefined ? listing.byName.get(requested) : undefined;
                    if (!exact && listing.complete) {
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
                            if (streamed.unavailable) {
                                unavailable = true;
                                if (streamed.runtimeFallbackExhausted) {
                                    runtimeFallbackExhausted = true;
                                } else {
                                    nonRuntimeUnavailable = true;
                                }
                            }
                        }
                    }
                    if (actual !== undefined) {
                        verifiedPrefixLength++;
                    }
                }
            } catch (error) {
                lookupPrefixAvailable = false;
                physicalPrefixAvailable = false;
                const code = (error as NodeJS.ErrnoException).code;
                if (code !== 'ENOENT' && code !== 'ENOTDIR') {
                    unavailable = true;
                    nonRuntimeUnavailable = true;
                }
            }
        }
        if (actual === undefined) { physicalPrefixAvailable = false; }
        // Once physical spelling is unresolved, continue existence checks through
        // the requested alias path. This preserves coverage for a deep existing
        // path without pretending that its canonical spelling was established.
        resolved.push(actual ?? requested);
        current = path.join(current, actual ?? requested);
    }
    const value = resolved.join('/');
    const runtimeOnly = runtimeFallbackExhausted && !nonRuntimeUnavailable &&
        lookupVerifiedPrefixLength === parts.length;
    return {
        identity: value,
        resolvedRelativePath: value,
        verifiedPrefixLength,
        unavailable,
        lookupVerifiedPrefixLength,
        runtimeFallbackExhausted: runtimeOnly || undefined
    };
}

export function pathIdentityText(value: string, caseSensitive: boolean): string {
    const normalized = path.resolve(value);
    return caseSensitive ? normalized : asciiCaseFold(normalized);
}
