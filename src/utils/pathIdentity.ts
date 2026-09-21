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

function probeExistingPath(existingPath: string): boolean | undefined {
    const base = path.basename(existingPath);
    const alternateBase = toggleAsciiCase(base);
    if (!alternateBase || alternateBase === base) { return undefined; }
    const parent = path.dirname(existingPath);
    const alternate = path.join(parent, alternateBase);

    // Two separately named directory entries prove case-sensitive lookup even
    // when one is a symlink/hard-link alias of the other. Resource identity
    // alone cannot distinguish such aliases from an insensitive lookup.
    let exactBase = false;
    let exactAlternate = false;
    try {
        const names = fs.readdirSync(parent);
        exactBase = names.includes(base);
        exactAlternate = names.includes(alternateBase);
        if (exactBase && exactAlternate) { return true; }
    } catch {
        // Without parent-entry evidence, never infer insensitivity from an
        // alias that merely resolves to the same underlying resource.
    }

    if (!fs.existsSync(alternate)) {
        return true;
    }
    const same = sameExistingResource(existingPath, alternate);
    if (same === false) { return true; }
    if (same === true) {
        // On an insensitive filesystem one directory entry is reachable through
        // both spellings. If parent enumeration proves exactly one spelling is
        // present, the alternate is a lookup alias rather than a second entry.
        if (exactBase !== exactAlternate) { return false; }
        return undefined;
    }
    return undefined;
}

/**
 * Determine the local root's path-case semantics without writing probe files.
 * If existing resource identity cannot prove the answer, return undefined.
 * Callers must fail closed rather than guessing from the operating system.
 */
export function detectLocalPathCaseSensitivity(
    rootPath: string,
    _platform: NodeJS.Platform = process.platform
): boolean | undefined {
    const rootProbe = probeExistingPath(rootPath);
    if (rootProbe !== undefined) { return rootProbe; }
    try {
        const entries = fs.readdirSync(rootPath, { withFileTypes: true });
        for (const entry of entries.slice(0, 128)) {
            if (entry.isSymbolicLink()) { continue; }
            const probe = probeExistingPath(path.join(rootPath, entry.name));
            if (probe !== undefined) { return probe; }
        }
    } catch {
        // The caller separately validates root accessibility. Identity detection
        // must never broaden a hard boundary because a probe could not run.
    }
    return undefined;
}

export function pathIdentityText(value: string, caseSensitive: boolean): string {
    return caseSensitive ? value : value.toLowerCase();
}

export function pathIdentityEquals(left: string, right: string, caseSensitive: boolean): boolean {
    return pathIdentityText(left, caseSensitive) === pathIdentityText(right, caseSensitive);
}
