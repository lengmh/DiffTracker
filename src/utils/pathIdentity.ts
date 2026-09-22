import * as fs from 'fs';
import * as path from 'path';

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
        return fs.readdirSync(parent).filter(name => asciiCaseFold(name) === folded);
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
        const entries = fs.readdirSync(rootPath, { withFileTypes: true });
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
}

export function resolveRelativePathIdentity(
    rootPath: string,
    relativePath: string,
    caseSensitive: boolean
): RelativePathIdentity {
    const parts = relativePath.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/$/, '')
        .split('/').filter(Boolean);
    if (caseSensitive || parts.length === 0) {
        const value = parts.join('/');
        return { identity: value, resolvedRelativePath: value };
    }

    const identityParts: string[] = [];
    const resolvedParts: string[] = [];
    let current = path.resolve(rootPath);
    let physicalPrefixAvailable = true;

    for (let index = 0; index < parts.length; index++) {
        const requested = parts[index];
        let actual: string | undefined;

        if (physicalPrefixAvailable) {
            try {
                const entries = fs.readdirSync(current, { withFileTypes: true });
                const exact = entries.filter(entry => entry.name === requested);
                if (exact.length === 1) {
                    actual = exact[0].name;
                } else if (exact.length > 1) {
                    physicalPrefixAvailable = false;
                } else {
                    // ASCII case-insensitivity is the property established by
                    // detectLocalPathCaseSensitivity(). Never generalize that
                    // evidence to ECMAScript's full Unicode lowercasing table.
                    const asciiMatches = entries.filter(entry =>
                        asciiCaseFold(entry.name) === asciiCaseFold(requested)
                    );
                    if (asciiMatches.length === 1) {
                        actual = asciiMatches[0].name;
                    } else {
                        const requestedPath = path.join(current, requested);
                        if (fs.existsSync(requestedPath)) {
                            const resourceMatches = entries.filter(entry =>
                                sameExistingResource(requestedPath, path.join(current, entry.name)) === true
                            );
                            if (resourceMatches.length === 1) {
                                actual = resourceMatches[0].name;
                            } else if (resourceMatches.length > 1) {
                                physicalPrefixAvailable = false;
                            }
                        }
                    }
                }
            } catch {
                physicalPrefixAvailable = false;
            }
        }

        if (actual !== undefined) {
            identityParts.push(actual);
            resolvedParts.push(actual);
            current = path.join(current, actual);
            continue;
        }

        // No physical entry proves a broader Unicode equivalence. Preserve the
        // requested Unicode spelling and fold only ASCII for a missing suffix.
        identityParts.push(asciiCaseFold(requested));
        resolvedParts.push(requested);
        physicalPrefixAvailable = false;
    }

    return {
        identity: identityParts.join('/'),
        resolvedRelativePath: resolvedParts.join('/')
    };
}

export function pathIdentityText(value: string, caseSensitive: boolean): string {
    const normalized = path.resolve(value);
    return caseSensitive ? normalized : asciiCaseFold(normalized);
}
