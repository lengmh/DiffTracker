import { createHash } from 'crypto';

export type MonitoringScopeMode = 'rules' | 'wholeWorkspace';
export type MonitoringRuleScope = 'all' | 'folder';

export interface WorkspaceRootIdentity {
    name: string;
    uri: string;
}

export interface MonitoringIncludeRule {
    scope: MonitoringRuleScope;
    folder?: string;
    path: string;
}

export interface MonitoringExcludeRule {
    scope: MonitoringRuleScope;
    folder?: string;
    pattern: string;
}

export interface MonitoringScopeRequest {
    mode: MonitoringScopeMode;
    includes: MonitoringIncludeRule[];
    excludes: MonitoringExcludeRule[];
}

export interface CanonicalMonitoringScope extends MonitoringScopeRequest {
    roots: WorkspaceRootIdentity[];
    revision: string;
}

export interface ScopeValidationError {
    field: 'mode' | 'roots' | 'include' | 'exclude';
    index?: number;
    message: string;
}

export interface ScopeValidationResult {
    ok: boolean;
    scope?: CanonicalMonitoringScope;
    errors: ScopeValidationError[];
    warnings: string[];
}

export interface ScopeExpansionResult {
    expands: boolean;
    reasons: string[];
}

const SCOPE_REVISION_MODEL = 1;

function stableHash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeRoots(roots: readonly WorkspaceRootIdentity[], errors: ScopeValidationError[]): WorkspaceRootIdentity[] {
    const seenUris = new Set<string>();
    const normalized: WorkspaceRootIdentity[] = [];
    for (const root of roots) {
        if (!root || typeof root.name !== 'string' || root.name.length === 0 ||
            typeof root.uri !== 'string' || root.uri.length === 0) {
            errors.push({ field: 'roots', message: 'Workspace roots require non-empty name and URI values.' });
            continue;
        }
        if (seenUris.has(root.uri)) {
            errors.push({ field: 'roots', message: `Duplicate workspace root URI: ${root.uri}` });
            continue;
        }
        seenUris.add(root.uri);
        normalized.push({ name: root.name, uri: root.uri });
    }
    return normalized.sort((a, b) => compareText(a.uri, b.uri) || compareText(a.name, b.name));
}

function rootNameCounts(roots: readonly WorkspaceRootIdentity[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const root of roots) {
        counts.set(root.name, (counts.get(root.name) ?? 0) + 1);
    }
    return counts;
}

function validateRuleTarget(
    rule: { scope?: unknown; folder?: unknown },
    roots: readonly WorkspaceRootIdentity[],
    field: 'include' | 'exclude',
    index: number,
    errors: ScopeValidationError[]
): { scope: MonitoringRuleScope; folder?: string } | undefined {
    if (rule.scope !== 'all' && rule.scope !== 'folder') {
        errors.push({ field, index, message: 'Rule scope must be "all" or "folder".' });
        return undefined;
    }
    if (rule.scope === 'all') {
        if (rule.folder !== undefined && rule.folder !== '') {
            errors.push({ field, index, message: 'All-workspace rules must not name a folder.' });
            return undefined;
        }
        return { scope: 'all' };
    }
    if (typeof rule.folder !== 'string' || rule.folder.length === 0) {
        errors.push({ field, index, message: 'Folder-scoped rules require a workspace folder name.' });
        return undefined;
    }
    const count = rootNameCounts(roots).get(rule.folder) ?? 0;
    if (count !== 1) {
        errors.push({
            field,
            index,
            message: count === 0
                ? `Workspace folder "${rule.folder}" does not exist.`
                : `Workspace folder name "${rule.folder}" is ambiguous.`
        });
        return undefined;
    }
    return { scope: 'folder', folder: rule.folder };
}

function hasEnvironmentExpansion(value: string): boolean {
    return /\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*|%[^%]+%/.test(value);
}

export function canonicalizeIncludePath(value: unknown, platform: NodeJS.Platform = process.platform): string | undefined {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) { return undefined; }
    if (value === '.' || value.startsWith('./') || value.startsWith('/') || value.startsWith('//') ||
        /^[A-Za-z]:/.test(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) ||
        value === '~' || value.startsWith('~/') || hasEnvironmentExpansion(value)) {
        return undefined;
    }
    if (platform === 'win32' && value.includes('\\')) { return undefined; }
    const parts = value.split('/');
    if (parts.some(part => part.length === 0 || part === '.' || part === '..')) { return undefined; }
    return parts.join('/');
}

export function canonicalizeExcludePattern(value: unknown, platform: NodeJS.Platform = process.platform): string | undefined {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.startsWith('!')) {
        return undefined;
    }
    if (value.startsWith('//') || /^[A-Za-z]:/.test(value) ||
        /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || hasEnvironmentExpansion(value)) {
        return undefined;
    }
    if (platform === 'win32' && value.includes('\\')) { return undefined; }
    return value;
}

function canonicalRuleKey(rule: MonitoringIncludeRule | MonitoringExcludeRule): string {
    const target = rule.scope === 'folder' ? `folder:${rule.folder}` : 'all';
    const value = 'path' in rule ? rule.path : rule.pattern;
    return `${target}\0${value}`;
}

function dedupeAndSort<T extends MonitoringIncludeRule | MonitoringExcludeRule>(
    rules: T[],
    warnings: string[],
    label: string
): T[] {
    const byKey = new Map<string, T>();
    for (const rule of rules) {
        const key = canonicalRuleKey(rule);
        if (byKey.has(key)) {
            warnings.push(`Duplicate ${label} rule ignored for scope identity: ${'path' in rule ? rule.path : rule.pattern}`);
        } else {
            byKey.set(key, rule);
        }
    }
    return [...byKey.values()].sort((a, b) => compareText(canonicalRuleKey(a), canonicalRuleKey(b)));
}

export function validateAndCanonicalizeScope(
    request: unknown,
    rootsInput: readonly WorkspaceRootIdentity[],
    platform: NodeJS.Platform = process.platform
): ScopeValidationResult {
    const errors: ScopeValidationError[] = [];
    const warnings: string[] = [];
    const roots = normalizeRoots(rootsInput, errors);
    if (!request || typeof request !== 'object') {
        return { ok: false, errors: [{ field: 'mode', message: 'Monitoring scope request must be an object.' }, ...errors], warnings };
    }
    const raw = request as { mode?: unknown; includes?: unknown; excludes?: unknown };
    if (raw.mode !== 'rules' && raw.mode !== 'wholeWorkspace') {
        errors.push({ field: 'mode', message: 'Monitoring scope mode must be "rules" or "wholeWorkspace".' });
    }
    if (!Array.isArray(raw.includes)) {
        errors.push({ field: 'include', message: 'Monitoring includes must be an array.' });
    }
    if (!Array.isArray(raw.excludes)) {
        errors.push({ field: 'exclude', message: 'Monitoring excludes must be an array.' });
    }

    const includes: MonitoringIncludeRule[] = [];
    if (Array.isArray(raw.includes)) {
        raw.includes.forEach((entry, index) => {
            if (!entry || typeof entry !== 'object') {
                errors.push({ field: 'include', index, message: 'Include rule must be an object.' });
                return;
            }
            const value = entry as { scope?: unknown; folder?: unknown; path?: unknown };
            const target = validateRuleTarget(value, roots, 'include', index, errors);
            const includePath = canonicalizeIncludePath(value.path, platform);
            if (!includePath) {
                errors.push({ field: 'include', index, message: 'Include path must be a non-root workspace-relative literal path using "/" separators.' });
            }
            if (target && includePath) {
                includes.push({ ...target, path: includePath });
            }
        });
    }

    const excludes: MonitoringExcludeRule[] = [];
    if (Array.isArray(raw.excludes)) {
        raw.excludes.forEach((entry, index) => {
            if (!entry || typeof entry !== 'object') {
                errors.push({ field: 'exclude', index, message: 'Exclude rule must be an object.' });
                return;
            }
            const value = entry as { scope?: unknown; folder?: unknown; pattern?: unknown };
            const target = validateRuleTarget(value, roots, 'exclude', index, errors);
            const pattern = canonicalizeExcludePattern(value.pattern, platform);
            if (pattern === undefined) {
                errors.push({ field: 'exclude', index, message: 'Exclude pattern must be non-empty, workspace-relative, and must not use "!" negation.' });
            }
            if (target && pattern !== undefined) {
                excludes.push({ ...target, pattern });
            }
        });
    }

    if (errors.length > 0 || (raw.mode !== 'rules' && raw.mode !== 'wholeWorkspace')) {
        return { ok: false, errors, warnings };
    }

    const canonicalIncludes = dedupeAndSort(includes, warnings, 'include');
    const canonicalExcludes = dedupeAndSort(excludes, warnings, 'exclude');
    const identity = {
        model: SCOPE_REVISION_MODEL,
        mode: raw.mode,
        roots,
        includes: canonicalIncludes,
        excludes: canonicalExcludes
    };
    return {
        ok: true,
        errors,
        warnings,
        scope: {
            mode: raw.mode,
            roots,
            includes: canonicalIncludes,
            excludes: canonicalExcludes,
            revision: stableHash(identity)
        }
    };
}

function sameRule(left: MonitoringExcludeRule, right: MonitoringExcludeRule): boolean {
    return canonicalRuleKey(left) === canonicalRuleKey(right);
}

function includeCovers(effective: MonitoringIncludeRule, requested: MonitoringIncludeRule): boolean {
    if (effective.scope === 'folder') {
        if (requested.scope !== 'folder' || effective.folder !== requested.folder) { return false; }
    }
    const base = effective.path.split('/');
    const target = requested.path.split('/');
    return base.length <= target.length && base.every((part, index) => part === target[index]);
}

function rootKey(root: WorkspaceRootIdentity): string {
    return `${root.name}\0${root.uri}`;
}

export function detectScopeExpansion(
    effective: CanonicalMonitoringScope,
    requested: CanonicalMonitoringScope
): ScopeExpansionResult {
    const reasons: string[] = [];
    const effectiveRoots = new Set(effective.roots.map(rootKey));
    for (const root of requested.roots) {
        if (!effectiveRoots.has(rootKey(root))) {
            reasons.push(`New workspace root: ${root.name}`);
        }
    }

    if (effective.mode === 'rules' && requested.mode === 'wholeWorkspace') {
        reasons.push('Whole Workspace mode expands beyond ordinary ignore rules.');
    }

    if (effective.mode !== 'wholeWorkspace') {
        for (const include of requested.includes) {
            if (!effective.includes.some(existing => includeCovers(existing, include))) {
                reasons.push(`New or broader explicit include: ${include.scope === 'folder' ? include.folder + ':' : ''}${include.path}`);
            }
        }
    }

    for (const exclude of effective.excludes) {
        if (!requested.excludes.some(candidate => sameRule(exclude, candidate))) {
            reasons.push(`Explicit exclude removed or changed: ${exclude.scope === 'folder' ? exclude.folder + ':' : ''}${exclude.pattern}`);
        }
    }

    return { expands: reasons.length > 0, reasons };
}
