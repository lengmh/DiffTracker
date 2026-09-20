import { createHash } from 'crypto';
import ignore from 'ignore';

export type MonitoringScopeMode = 'rules' | 'wholeWorkspace';
export type MonitoringRuleScope = 'all' | 'folder';

export interface WorkspaceRootIdentity {
    name: string;
    uri: string;
    caseSensitive: boolean;
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
    scopeRevision: string;
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

export interface ScopeConsentRecord {
    model: 1;
    scopeRevision: string;
    roots: WorkspaceRootIdentity[];
}

export interface ScopeMigrationRecord {
    model: 1;
    roots: WorkspaceRootIdentity[];
}

export interface LegacyRuleMigrationPreview {
    excludes: MonitoringExcludeRule[];
    includes: MonitoringIncludeRule[];
    manual: string[];
    ignoredNoops: string[];
}

export interface ConfiguredScopeDecision {
    monitored: boolean;
    source: 'hardBoundary' | 'explicitExclude' | 'explicitInclude' | 'wholeWorkspace' | 'ordinaryPolicy';
}

export interface LegacyEffectiveMonitoringScope {
    kind: 'legacyV3';
    roots: WorkspaceRootIdentity[];
    legacyWatchExclude: string[];
    scopeRevision: string;
}

export interface ConfiguredEffectiveMonitoringScope extends CanonicalMonitoringScope {
    kind: 'configured';
}

export type EffectiveMonitoringScope = LegacyEffectiveMonitoringScope | ConfiguredEffectiveMonitoringScope;

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
            typeof root.uri !== 'string' || root.uri.length === 0 ||
            typeof root.caseSensitive !== 'boolean') {
            errors.push({ field: 'roots', message: 'Workspace roots require non-empty name/URI values and explicit case-sensitivity identity.' });
            continue;
        }
        if (seenUris.has(root.uri)) {
            errors.push({ field: 'roots', message: `Duplicate workspace root URI: ${root.uri}` });
            continue;
        }
        seenUris.add(root.uri);
        normalized.push({ name: root.name, uri: root.uri, caseSensitive: root.caseSensitive });
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
            const targetRoots = target
                ? target.scope === 'all'
                    ? roots
                    : roots.filter(root => root.name === target.folder)
                : [];
            const hardBoundary = !!includePath && targetRoots.some(root =>
                isHardUnmonitorableRelativePath(includePath, root.caseSensitive)
            );
            if (hardBoundary) {
                errors.push({ field: 'include', index, message: 'Include path targets a DiffTracker hard monitoring boundary.' });
            }
            if (target && includePath && !hardBoundary) {
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
            scopeRevision: stableHash(identity)
        }
    };
}

function sameRule(left: MonitoringExcludeRule, right: MonitoringExcludeRule): boolean {
    return canonicalRuleKey(left) === canonicalRuleKey(right);
}

function includeCovers(
    effective: MonitoringIncludeRule,
    requested: MonitoringIncludeRule,
    roots: readonly WorkspaceRootIdentity[]
): boolean {
    if (effective.scope === 'folder') {
        if (requested.scope !== 'folder' || effective.folder !== requested.folder) { return false; }
    }
    const affectedRoots = requested.scope === 'folder'
        ? roots.filter(root => root.name === requested.folder)
        : roots;
    return affectedRoots.length > 0 && affectedRoots.every(root =>
        includeCoversRelativePath(effective.path, requested.path, false, root.caseSensitive)
    );
}

export function createScopeConsentRecord(scope: CanonicalMonitoringScope): ScopeConsentRecord {
    return {
        model: 1,
        scopeRevision: scope.scopeRevision,
        roots: scope.roots.map(root => ({ ...root }))
    };
}

export function scopeConsentMatches(raw: unknown, scope: CanonicalMonitoringScope): boolean {
    if (!raw || typeof raw !== 'object') { return false; }
    const value = raw as Partial<ScopeConsentRecord>;
    if (value.model !== 1 || value.scopeRevision !== scope.scopeRevision || !Array.isArray(value.roots)) { return false; }
    if (value.roots.length !== scope.roots.length) { return false; }
    const key = (root: WorkspaceRootIdentity) => `${root.name}\0${root.uri}\0${root.caseSensitive ? 'cs' : 'ci'}`;
    const left = value.roots
        .filter((root): root is WorkspaceRootIdentity => !!root && typeof root.name === 'string' &&
            typeof root.uri === 'string' && typeof root.caseSensitive === 'boolean')
        .map(key).sort(compareText);
    const right = scope.roots.map(key).sort(compareText);
    return left.length === value.roots.length && left.every((item, index) => item === right[index]);
}

function ruleAppliesToRoot(rule: { scope: MonitoringRuleScope; folder?: string }, rootName: string): boolean {
    return rule.scope === 'all' || (rule.scope === 'folder' && rule.folder === rootName);
}

function identityPart(value: string, caseSensitive: boolean): string {
    return caseSensitive ? value : value.toLowerCase();
}

function includeCoversRelativePath(
    includePath: string,
    relativePath: string,
    directory: boolean,
    caseSensitive: boolean
): boolean {
    const includeParts = includePath.split('/').map(part => identityPart(part, caseSensitive));
    const targetParts = relativePath.replace(/\/$/, '').split('/').filter(Boolean)
        .map(part => identityPart(part, caseSensitive));
    if (targetParts.length >= includeParts.length &&
        includeParts.every((part, index) => targetParts[index] === part)) {
        return true;
    }
    return directory && targetParts.length < includeParts.length &&
        targetParts.every((part, index) => includeParts[index] === part);
}

function explicitPatternForIgnore(pattern: string): string {
    let value = pattern;
    if (value.startsWith('#')) { value = `\\${value}`; }
    const trailing = value.match(/ +$/)?.[0].length ?? 0;
    if (trailing > 0) {
        value = value.slice(0, -trailing) + '\\ '.repeat(trailing);
    }
    return value;
}

export function isHardUnmonitorableRelativePath(relativePath: string, caseSensitive = true): boolean {
    const parts = relativePath.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/$/, '').split('/').filter(Boolean)
        .map(part => identityPart(part, caseSensitive));
    return parts.some(part => part === '.git' || part.startsWith('.difftracker-restore-'));
}

export function evaluateConfiguredScope(
    scope: CanonicalMonitoringScope,
    rootName: string,
    relativePath: string,
    ordinaryIgnored: boolean,
    directory = false
): ConfiguredScopeDecision {
    const rel = relativePath.replace(/^\.\//, '').replace(/^\/+/, '');
    const root = scope.roots.find(candidate => candidate.name === rootName);
    const caseSensitive = root?.caseSensitive ?? true;
    if (isHardUnmonitorableRelativePath(rel, caseSensitive)) {
        return { monitored: false, source: 'hardBoundary' };
    }
    for (const rule of scope.excludes) {
        if (!ruleAppliesToRoot(rule, rootName)) { continue; }
        const matcher = ignore({ ignorecase: !caseSensitive }).add(explicitPatternForIgnore(rule.pattern));
        if (matcher.ignores(rel + (directory && rel && !rel.endsWith('/') ? '/' : ''))) {
            return { monitored: false, source: 'explicitExclude' };
        }
    }
    for (const rule of scope.includes) {
        if (!ruleAppliesToRoot(rule, rootName)) { continue; }
        if (includeCoversRelativePath(rule.path, rel, directory, caseSensitive)) {
            return { monitored: true, source: 'explicitInclude' };
        }
    }
    if (scope.mode === 'wholeWorkspace') {
        return { monitored: true, source: 'wholeWorkspace' };
    }
    return { monitored: !ordinaryIgnored, source: 'ordinaryPolicy' };
}

export function previewLegacyWatchExcludeMigration(
    input: readonly unknown[],
    platform: NodeJS.Platform = process.platform
): LegacyRuleMigrationPreview {
    const excludes: MonitoringExcludeRule[] = [];
    const includes: MonitoringIncludeRule[] = [];
    const manual: string[] = [];
    const ignoredNoops: string[] = [];
    const seenExclude = new Set<string>();
    const seenInclude = new Set<string>();

    for (const raw of input) {
        if (typeof raw !== 'string') { continue; }
        const line = raw.trim();
        if (!line || line.startsWith('#')) {
            if (line) { ignoredNoops.push(line); }
            continue;
        }
        if (!line.startsWith('!')) {
            const pattern = canonicalizeExcludePattern(line, platform);
            if (pattern === undefined) {
                manual.push(line);
                continue;
            }
            const key = `all\0${pattern}`;
            if (!seenExclude.has(key)) {
                seenExclude.add(key);
                excludes.push({ scope: 'all', pattern });
            }
            continue;
        }

        let literal = line.slice(1);
        if (!literal || /[*?[]/.test(literal)) {
            manual.push(line);
            continue;
        }
        literal = literal.replace(/^\/+/, '').replace(/\/+$/, '');
        const includePath = canonicalizeIncludePath(literal, platform);
        if (!includePath) {
            manual.push(line);
            continue;
        }
        const key = `all\0${includePath}`;
        if (!seenInclude.has(key)) {
            seenInclude.add(key);
            includes.push({ scope: 'all', path: includePath });
        }
    }

    return { excludes, includes, manual, ignoredNoops };
}

export function createScopeMigrationRecord(roots: readonly WorkspaceRootIdentity[]): ScopeMigrationRecord {
    return {
        model: 1,
        roots: roots.map(root => ({ ...root })).sort((a, b) => compareText(a.uri, b.uri) || compareText(a.name, b.name))
    };
}

export function scopeMigrationMatches(raw: unknown, roots: readonly WorkspaceRootIdentity[]): boolean {
    if (!raw || typeof raw !== 'object') { return false; }
    const value = raw as Partial<ScopeMigrationRecord>;
    if (value.model !== 1 || !Array.isArray(value.roots)) { return false; }
    const expected = createScopeMigrationRecord(roots);
    return JSON.stringify(value.roots) === JSON.stringify(expected.roots);
}

function rootKey(root: WorkspaceRootIdentity): string {
    return `${root.name}\0${root.uri}\0${root.caseSensitive ? 'cs' : 'ci'}`;
}

function normalizeLegacyPatterns(patterns: readonly unknown[]): string[] {
    const result: string[] = [];
    for (const pattern of patterns) {
        if (typeof pattern !== 'string') { continue; }
        const trimmed = pattern.trim();
        if (trimmed) { result.push(trimmed); }
    }
    return result;
}

export function createLegacyEffectiveScope(
    rootsInput: readonly WorkspaceRootIdentity[],
    legacyWatchExcludeInput: readonly unknown[]
): LegacyEffectiveMonitoringScope {
    const errors: ScopeValidationError[] = [];
    const roots = normalizeRoots(rootsInput, errors);
    const legacyWatchExclude = normalizeLegacyPatterns(legacyWatchExcludeInput);
    const identity = {
        model: 'legacy-v3',
        roots,
        legacyWatchExclude
    };
    return {
        kind: 'legacyV3',
        roots,
        legacyWatchExclude,
        scopeRevision: stableHash(identity)
    };
}

export function parseEffectiveMonitoringScope(raw: unknown): EffectiveMonitoringScope | undefined {
    if (!raw || typeof raw !== 'object') { return undefined; }
    const candidate = raw as {
        kind?: unknown;
        roots?: unknown;
        legacyWatchExclude?: unknown;
        scopeRevision?: unknown;
        mode?: unknown;
        includes?: unknown;
        excludes?: unknown;
    };
    if (!Array.isArray(candidate.roots) || typeof candidate.scopeRevision !== 'string' ||
        !/^[a-f0-9]{64}$/.test(candidate.scopeRevision)) {
        return undefined;
    }
    const roots: WorkspaceRootIdentity[] = [];
    for (const root of candidate.roots) {
        if (!root || typeof root !== 'object') { return undefined; }
        const value = root as { name?: unknown; uri?: unknown; caseSensitive?: unknown };
        if (typeof value.name !== 'string' || value.name.length === 0 ||
            typeof value.uri !== 'string' || value.uri.length === 0 ||
            typeof value.caseSensitive !== 'boolean') { return undefined; }
        roots.push({ name: value.name, uri: value.uri, caseSensitive: value.caseSensitive });
    }

    if (candidate.kind === 'legacyV3') {
        if (!Array.isArray(candidate.legacyWatchExclude)) { return undefined; }
        const parsed = createLegacyEffectiveScope(roots, candidate.legacyWatchExclude);
        return parsed.scopeRevision === candidate.scopeRevision ? parsed : undefined;
    }
    if (candidate.kind !== 'configured') { return undefined; }
    const validated = validateAndCanonicalizeScope({
        mode: candidate.mode,
        includes: candidate.includes,
        excludes: candidate.excludes
    }, roots);
    if (!validated.ok || !validated.scope || validated.scope.scopeRevision !== candidate.scopeRevision) {
        return undefined;
    }
    return { kind: 'configured', ...validated.scope };
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
            if (!effective.includes.some(existing => includeCovers(existing, include, requested.roots))) {
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
