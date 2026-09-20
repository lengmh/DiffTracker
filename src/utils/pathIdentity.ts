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
    const alternate = path.join(path.dirname(existingPath), alternateBase);
    if (!fs.existsSync(alternate)) {
        return true;
    }
    const same = sameExistingResource(existingPath, alternate);
    return same === true ? false : undefined;
}

/**
 * Determine the local root's path-case semantics without writing probe files.
 * If an existing component cannot prove the answer, fall back conservatively:
 * Windows/macOS are treated case-insensitive; other platforms case-sensitive.
 */
export function detectLocalPathCaseSensitivity(
    rootPath: string,
    platform: NodeJS.Platform = process.platform
): boolean {
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
    return platform !== 'win32' && platform !== 'darwin';
}

export function pathIdentityText(value: string, caseSensitive: boolean): string {
    return caseSensitive ? value : value.toLowerCase();
}

export function pathIdentityEquals(left: string, right: string, caseSensitive: boolean): boolean {
    return pathIdentityText(left, caseSensitive) === pathIdentityText(right, caseSensitive);
}
