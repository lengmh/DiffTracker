import * as fs from 'fs';
import * as path from 'path';

const maxIdentityDirectoryEntries = 10000;

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

function caseEquivalentEntries(parent: string, requested: string): string[] | undefined {
    try {
        const folded = asciiCaseFold(requested);
        return directoryEntries(parent).map(entry => entry.name).filter(name => asciiCaseFold(name) === folded);
    } catch {
        return undefined;
    }
}

function probeExistingPath(existingPath: string): boolean | undefined {
    const base = path.basename(existingPath);
    if (!base) { return undefined; }
    const parent = path.dirname(existingPath);
    const equivalentEntries = caseEquivalentEntries(parent, base);

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
        // When the parent listing proves that only the requested spelling exists,
        // a differently-cased lookup resolving to it is sufficient evidence for
        // an insensitive boundary. Without listing evidence, remain unverified.
        return equivalentEntries?.includes(base) ? false : undefined;
    }
    return undefined;
}

export function detectLocalPathCaseSensitivity(
    rootPath: string,
    _platform: NodeJS.Platform = process.platform
): boolean | undefined {
    // The parent directory's lookup of the workspace-root name is never proof
    // of lookup semantics *inside* that workspace. Per-directory case behavior,
    // symlink/junction targets and mount points can all differ without a device
    // boundary that is visible from the parent.
    try {
        const entries = directoryEntries(rootPath);
        for (const entry of entries.slice(0, 128)) {
            if (entry.isSymbolicLink()) { continue; }
            const probe = probeExistingPath(path.join(rootPath, entry.name));
            if (probe !== undefined) { return probe; }
        }
    } catch {
        // Fall through to the fail-closed result below.
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
const directoryEntriesCache = new Map<string, { signature: string; entries: fs.Dirent[] }>();
let cachedDirectoryEntryCount = 0;

function invalidateDirectoryEntries(directory: string): void {
    const cached = directoryEntriesCache.get(directory);
    if (!cached) { return; }
    directoryEntriesCache.delete(directory);
    cachedDirectoryEntryCount = Math.max(0, cachedDirectoryEntryCount - cached.entries.length);
}

function directoryEntries(directory: string): fs.Dirent[] {
    const signature = (): string => {
        const stat = fs.statSync(directory);
        return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.mtimeMs}:${stat.ctimeMs}`;
    };
    const before = signature();
    const cached = directoryEntriesCache.get(directory);
    if (cached?.signature === before) { return cached.entries; }
    const entries = readIdentityDirectoryEntries(directory);
    if (signature() === before) {
        const previousCount = cached?.entries.length ?? 0;
        if (directoryEntriesCache.size >= 4096 ||
            cachedDirectoryEntryCount - previousCount + entries.length > maxIdentityDirectoryEntries) {
            directoryEntriesCache.clear();
            cachedDirectoryEntryCount = 0;
        } else {
            cachedDirectoryEntryCount -= previousCount;
        }
        directoryEntriesCache.set(directory, { signature: before, entries });
        cachedDirectoryEntryCount += entries.length;
    }
    return entries;
}

function sameEntryLookup(left: string, right: string): boolean {
    const a = fs.lstatSync(left), b = fs.lstatSync(right);
    if (a.ino !== 0 && b.ino !== 0) { return a.dev === b.dev && a.ino === b.ino; }
    // Do not follow a symlink in order to prove entry identity.
    return !a.isSymbolicLink() && !b.isSymbolicLink() &&
        fs.realpathSync.native(left) === fs.realpathSync.native(right);
}

export function resolveRelativePathIdentity(
    rootPath: string,
    relativePath: string,
    _caseSensitive: boolean
): RelativePathIdentity {
    const parts = relativePath.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/$/, '')
        .split('/').filter(Boolean);
    const resolved: string[] = [];
    let current = path.resolve(rootPath);
    let physicalPrefixAvailable = true;
    let verifiedPrefixLength = 0;
    let unavailable = false;

    for (const requested of parts) {
        let actual: string | undefined;
        if (physicalPrefixAvailable) {
            try {
                let entries = directoryEntries(current);
                const requestedPath = path.join(current, requested);
                // Successful lookup is mandatory even for an ASCII candidate:
                // the current directory can differ from the workspace root.
                const requestedStat = fs.lstatSync(requestedPath);
                let exact = entries.find(entry => entry.name === requested);
                if (!exact) {
                    // Some filesystems (notably Windows runners) can preserve a
                    // directory mtime/ctime signature across a rapid child create.
                    // If the requested entry already exists but the cached listing
                    // does not contain its spelling, refresh the bounded listing
                    // once before treating the identity as unavailable/aliased.
                    invalidateDirectoryEntries(current);
                    entries = directoryEntries(current);
                    exact = entries.find(entry => entry.name === requested);
                }
                if (exact) {
                    actual = exact.name;
                } else {
                    const matches = entries.filter(entry => {
                        try { return sameEntryLookup(requestedPath, path.join(current, entry.name)); }
                        catch { return false; }
                    });
                    // Separately named hard links remain distinct entries. An
                    // ambiguous alias is not permission to merge their scopes.
                    if (matches.length === 1) { actual = matches[0].name; }
                    else { unavailable = true; }
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
