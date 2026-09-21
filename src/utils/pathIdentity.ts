import * as fs from 'fs';
import * as path from 'path';

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
        const folded = requested.toLowerCase();
        return fs.readdirSync(parent).filter(name => name.toLowerCase() === folded);
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

function rootRequiresInternalCaseProbe(rootPath: string): boolean {
    const normalized = path.resolve(rootPath);
    const parent = path.dirname(normalized);
    try {
        if (fs.lstatSync(normalized).isSymbolicLink()) { return true; }
        // Filesystem/volume roots and mount points do not inherit lookup
        // semantics from the parent path that names the mount.
        if (parent === normalized) { return true; }
        const rootStat = fs.statSync(normalized);
        const parentStat = fs.statSync(parent);
        if (rootStat.dev !== parentStat.dev) { return true; }
    } catch {
        // If the boundary itself cannot be verified, do not use parent lookup
        // semantics as a substitute for descendant identity.
        return true;
    }
    return false;
}

export function detectLocalPathCaseSensitivity(
    rootPath: string,
    _platform: NodeJS.Platform = process.platform
): boolean | undefined {
    const internalOnly = rootRequiresInternalCaseProbe(rootPath);

    // Ordinary directory roots can use their own name as evidence. Symlinks,
    // junctions, filesystem roots and mount points must be probed only from
    // descendants inside the workspace filesystem.
    if (!internalOnly) {
        const rootProbe = probeExistingPath(rootPath);
        if (rootProbe !== undefined) { return rootProbe; }
    }

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

    return undefined;
}

export function pathIdentityText(value: string, caseSensitive: boolean): string {
    const normalized = path.resolve(value);
    return caseSensitive ? normalized : normalized.toLowerCase();
}
