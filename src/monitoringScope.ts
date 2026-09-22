import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import ignore from 'ignore';
import { asciiCaseFold, resolveRelativePathIdentity } from './utils/pathIdentity';

export type MonitoringScopeMode = 'rules' | 'wholeWorkspace';
export type MonitoringRuleScope = 'all' | 'folder';

export interface WorkspaceRootIdentity {
    name: string;
    uri: string;
    caseSensitive?: boolean;
}

export interface CanonicalWorkspaceRootIdentity extends WorkspaceRootIdentity {
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
    roots: CanonicalWorkspaceRootIdentity[];
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
    roots: CanonicalWorkspaceRootIdentity[];
}

export interface ScopeMigrationRecord {
    model: 2;
    roots: CanonicalWorkspaceRootIdentity[];
    approvedLegacySourceFingerprint: string;
    currentLegacySourceFingerprint: string;
    targetScopeRevision: string;
    decision: 'automatic' | 'manual';
}

export interface LegacyRuleMigrationPreview {
    excludes: MonitoringExcludeRule[];
    includes: MonitoringIncludeRule[];
    manual: string[];
    ignoredNoops: string[];
}

export interface ConfiguredScopeDecision {
    monitored: boolean;
    source: 'identityUnknown' | 'hardBoundary' | 'explicitExclude' | 'explicitInclude' | 'wholeWorkspace' | 'ordinaryPolicy';
}

export interface LegacyEffectiveMonitoringScope {
    kind: 'legacyV3';
    roots: CanonicalWorkspaceRootIdentity[];
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

function canonicalEvidenceValue(value: unknown): unknown {
    if (value === undefined) { return { __type: 'undefined' }; }
    if (value === null || typeof value === 'string' || typeof value === 'boolean') { return value; }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : { __type: 'number', value: String(value) };
    }
    if (Array.isArray(value)) { return value.map(canonicalEvidenceValue); }
    if (typeof value === 'object') {
        const source = value as Record<string, unknown>;
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(source).sort(compareText)) {
            result[key] = canonicalEvidenceValue(source[key]);
        }
        return result;
    }
    return { __type: typeof value, value: String(value) };
}

export function createLegacySourceFingerprint(source: unknown): string {
    return createHash('sha256')
        .update(JSON.stringify({ model: 1, source: canonicalEvidenceValue(source) }))
        .digest('hex');
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeRoots(
    roots: readonly WorkspaceRootIdentity[],
    errors: ScopeValidationError[]
): CanonicalWorkspaceRootIdentity[] {
    const seenUris = new Set<string>();
    const normalized: CanonicalWorkspaceRootIdentity[] = [];
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

function includeRulesCollectivelyCover(
    effectiveRules: readonly MonitoringIncludeRule[],
    requested: MonitoringIncludeRule,
    roots: readonly CanonicalWorkspaceRootIdentity[]
): boolean {
    const affectedRoots = roots.filter(root => ruleAppliesToRoot(requested, root.name));
    return affectedRoots.length > 0 && affectedRoots.every(root =>
        effectiveRules.some(existing =>
            ruleAppliesToRoot(existing, root.name) &&
            includeCoversRelativePath(existing.path, requested.path, false, root)
        )
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
    const key = (root: CanonicalWorkspaceRootIdentity) =>
        `${root.name}\0${root.uri}\0${root.caseSensitive ? 'cs' : 'ci'}`;
    const left = value.roots
        .filter((root): root is CanonicalWorkspaceRootIdentity => !!root && typeof root.name === 'string' &&
            typeof root.uri === 'string' && typeof root.caseSensitive === 'boolean')
        .map(key).sort(compareText);
    const right = scope.roots.map(key).sort(compareText);
    return left.length === value.roots.length && left.every((item, index) => item === right[index]);
}

function ruleAppliesToRoot(rule: { scope: MonitoringRuleScope; folder?: string }, rootName: string): boolean {
    return rule.scope === 'all' || (rule.scope === 'folder' && rule.folder === rootName);
}

function identityPart(value: string, caseSensitive: boolean): string {
    return caseSensitive ? value : asciiCaseFold(value);
}

function localRootPath(root: WorkspaceRootIdentity): string | undefined {
    try {
        const url = new URL(root.uri);
        return url.protocol === 'file:' ? fileURLToPath(url) : undefined;
    } catch {
        return undefined;
    }
}

function relativeIdentity(root: WorkspaceRootIdentity, value: string): string {
    if (root.caseSensitive !== false) { return value; }
    const rootPath = localRootPath(root);
    return rootPath
        ? resolveRelativePathIdentity(rootPath, value, false).identity
        : value.split('/').map(asciiCaseFold).join('/');
}

function includeCoversRelativePath(
    includePath: string,
    relativePath: string,
    directory: boolean,
    root: WorkspaceRootIdentity
): boolean {
    const caseSensitive = root.caseSensitive !== false;
    const includeParts = relativeIdentity(root, includePath).split('/').filter(Boolean);
    const targetParts = relativeIdentity(root, relativePath.replace(/\/$/, '')).split('/').filter(Boolean);
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

export function isHardUnmonitorableRelativePath(
    relativePath: string,
    caseSensitive = true,
    leafIsDirectory = false
): boolean {
    const parts = relativePath.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/$/, '').split('/').filter(Boolean)
        .map(part => identityPart(part, caseSensitive));
    return parts.some((part, index) => {
        if (part === '.git') { return true; }
        if (!part.startsWith('.difftracker-restore-')) { return false; }
        return index < parts.length - 1 || leafIsDirectory;
    });
}

export function evaluateConfiguredScope(
    scope: CanonicalMonitoringScope,
    rootIdentity: string | WorkspaceRootIdentity,
    relativePath: string,
    ordinaryIgnored: boolean,
    directory = false
): ConfiguredScopeDecision {
    const rel = relativePath.replace(/^\.\//, '').replace(/^\/+/, '');
    const root = typeof rootIdentity === 'string'
        ? scope.roots.find(candidate => candidate.name === rootIdentity)
        : rootIdentity;
    const rootName = typeof rootIdentity === 'string' ? rootIdentity : rootIdentity.name;
    if (!root || typeof root.caseSensitive !== 'boolean') {
        return { monitored: false, source: 'identityUnknown' };
    }
    const caseSensitive = root.caseSensitive;
    if (isHardUnmonitorableRelativePath(rel, caseSensitive, directory)) {
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
        if (includeCoversRelativePath(rule.path, rel, directory, root)) {
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
    const simpleNegations: Array<{ raw: string; includePath: string }> = [];

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
                // Later ordinary policy (.gitignore, Git exclude, VS Code policy)
                // can negate a legacy Global exclusion. A configured explicit
                // exclude would outrank that downstream negation, so this
                // conversion is a suggestion only and requires manual review.
                manual.push(line);
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
        simpleNegations.push({ raw: line, includePath });
    }

    // Configured scope gives explicit excludes higher priority than includes,
    // unlike ordered gitignore rules. Any simple negation that intersects a
    // migrated positive exclusion is therefore not semantics-preserving and
    // must be reviewed manually.
    const positivePatterns = excludes.map(rule => explicitPatternForIgnore(rule.pattern));
    const positiveCaseSensitive = ignore({ ignorecase: false }).add(positivePatterns);
    const positiveCaseInsensitive = ignore({ ignorecase: true }).add(positivePatterns);
    for (const candidate of simpleNegations) {
        const overlapsExclude = positivePatterns.length > 0 &&
            (positiveCaseSensitive.ignores(candidate.includePath) ||
                positiveCaseInsensitive.ignores(candidate.includePath));
        // Even without a Global overlap, later ordinary policy (.gitignore,
        // Git exclude, files/search excludes) can override a legacy negation.
        // Keep the explicit-include conversion as a UI suggestion, but require
        // manual migration rather than claiming semantics are preserved.
        manual.push(candidate.raw);
        const key = `all\0${candidate.includePath}`;
        if (!seenInclude.has(key)) {
            seenInclude.add(key);
            includes.push({ scope: 'all', path: candidate.includePath });
        }
        void overlapsExclude;
    }

    return { excludes, includes, manual, ignoredNoops };
}

export function createScopeMigrationRecord(
    roots: readonly CanonicalWorkspaceRootIdentity[],
    approvedLegacySourceFingerprint: string,
    currentLegacySourceFingerprint: string,
    targetScopeRevision: string,
    decision: 'automatic' | 'manual'
): ScopeMigrationRecord {
    return {
        model: 2,
        roots: roots.map(root => ({ ...root })).sort((a, b) => compareText(a.uri, b.uri) || compareText(a.name, b.name)),
        approvedLegacySourceFingerprint,
        currentLegacySourceFingerprint,
        targetScopeRevision,
        decision
    };
}

export function scopeMigrationMatches(
    raw: unknown,
    roots: readonly WorkspaceRootIdentity[],
    currentLegacySourceFingerprint: string,
    targetScopeRevision: string
): boolean {
    if (!raw || typeof raw !== 'object') { return false; }
    const value = raw as Partial<ScopeMigrationRecord>;
    if (value.model !== 2 || !Array.isArray(value.roots) ||
        typeof value.approvedLegacySourceFingerprint !== 'string' ||
        typeof value.currentLegacySourceFingerprint !== 'string' ||
        typeof value.targetScopeRevision !== 'string' ||
        (value.decision !== 'automatic' && value.decision !== 'manual')) {
        return false;
    }
    const fingerprint = /^[0-9a-f]{64}$/;
    if (!fingerprint.test(value.approvedLegacySourceFingerprint) ||
        !fingerprint.test(value.currentLegacySourceFingerprint) ||
        !fingerprint.test(currentLegacySourceFingerprint) ||
        !fingerprint.test(value.targetScopeRevision) ||
        !fingerprint.test(targetScopeRevision)) {
        return false;
    }
    const errors: ScopeValidationError[] = [];
    const canonicalRoots = normalizeRoots(roots, errors);
    if (errors.length > 0) { return false; }
    const expectedRoots = canonicalRoots.map(root => ({ ...root }))
        .sort((a, b) => compareText(a.uri, b.uri) || compareText(a.name, b.name));
    return JSON.stringify(value.roots) === JSON.stringify(expectedRoots) &&
        value.currentLegacySourceFingerprint === currentLegacySourceFingerprint &&
        value.targetScopeRevision === targetScopeRevision;
}

function rootKey(root: WorkspaceRootIdentity): string {
    const caseKey = root.caseSensitive === true ? 'cs' : root.caseSensitive === false ? 'ci' : 'unknown';
    return `${root.name}\0${root.uri}\0${caseKey}`;
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
    const roots: CanonicalWorkspaceRootIdentity[] = [];
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

function excludeRuleCoversOnRoot(
    candidate: MonitoringExcludeRule,
    effectiveRule: MonitoringExcludeRule,
    root: WorkspaceRootIdentity
): boolean {
    if (!ruleAppliesToRoot(candidate, root.name) || !ruleAppliesToRoot(effectiveRule, root.name)) {
        return false;
    }
    if (candidate.pattern === effectiveRule.pattern) { return true; }

    // Containment is structural, not inferred from finite path probes. In
    // particular, a slashless rule matches at arbitrary depths whereas /name
    // matches only at the root. Unproved glob relationships remain expansions.
    const literal = (pattern: string): { parts: string[]; anchored: boolean; directory: boolean } | undefined => {
        const body = pattern.replace(/^\//, '').replace(/\/$/, '');
        if (!body || /[\\*?\[\]{}\s]/.test(body)) { return undefined; }
        return { parts: body.split('/'), anchored: pattern.startsWith('/') || body.includes('/'),
            directory: pattern.endsWith('/') };
    };
    const effective = literal(effectiveRule.pattern);
    if (!effective || typeof root.caseSensitive !== 'boolean') { return false; }
    const raw = candidate.pattern;
    const recursive = raw.startsWith('**/') ? literal(raw.slice(3)) : undefined;
    const ordinary = literal(raw);
    const subtree = raw.endsWith('/**') ? literal(raw.slice(0, -3)) : undefined;
    const equal = (left: string, right: string) => {
        if (left === right) { return true; }
        if (root.caseSensitive) { return false; }
        // The root probe establishes ASCII case-insensitive lookup only. Do
        // not use ECMAScript's broader Unicode case table to prove exclusion
        // containment; an unproved non-ASCII spelling change is an expansion.
        return /^[\x00-\x7F]+$/.test(left) && /^[\x00-\x7F]+$/.test(right) &&
            asciiCaseFold(left) === asciiCaseFold(right);
    };

    if (!effective.anchored) {
        const name = ordinary && !ordinary.anchored ? ordinary :
            recursive && !recursive.anchored ? recursive : undefined;
        return !!name && equal(name.parts[0], effective.parts[0]) &&
            (!name.directory || effective.directory);
    }
    if (ordinary) {
        if (!ordinary.anchored) {
            return effective.parts.some((part, index) => equal(part, ordinary.parts[0]) &&
                (index < effective.parts.length - 1 || !ordinary.directory || effective.directory));
        }
        return ordinary.parts.length <= effective.parts.length &&
            ordinary.parts.every((part, index) => equal(part, effective.parts[index])) &&
            (ordinary.parts.length < effective.parts.length || !ordinary.directory || effective.directory);
    }
    if (recursive && !recursive.anchored) {
        return effective.parts.some((part, index) => equal(part, recursive.parts[0]) &&
            (index < effective.parts.length - 1 || !recursive.directory || effective.directory));
    }
    // prefix/** covers every resource strictly below a literal prefix,
    // but cannot cover a file at that prefix itself.
    return !!subtree && subtree.parts.length < effective.parts.length &&
        subtree.parts.every((part, index) => equal(part, effective.parts[index]));
}

function excludeRulesCollectivelyCover(
    candidates: readonly MonitoringExcludeRule[],
    effectiveRule: MonitoringExcludeRule,
    roots: readonly WorkspaceRootIdentity[]
): boolean {
    const affectedRoots = roots.filter(root => ruleAppliesToRoot(effectiveRule, root.name));
    if (affectedRoots.length === 0) { return true; }
    return affectedRoots.every(root =>
        candidates.some(candidate => excludeRuleCoversOnRoot(candidate, effectiveRule, root))
    );
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
            if (!includeRulesCollectivelyCover(effective.includes, include, requested.roots)) {
                reasons.push(`New or broader explicit include: ${include.scope === 'folder' ? include.folder + ':' : ''}${include.path}`);
            }
        }
    }

    for (const exclude of effective.excludes) {
        const affectsRemainingRoot = requested.roots.some(root => ruleAppliesToRoot(exclude, root.name));
        if (!affectsRemainingRoot) {
            // The exclusion applied only to roots that no longer exist in the
            // requested workspace, so removing it cannot broaden remaining scope.
            continue;
        }
        if (!excludeRulesCollectivelyCover(requested.excludes, exclude, requested.roots)) {
            reasons.push(`Explicit exclude removed or changed: ${exclude.scope === 'folder' ? exclude.folder + ':' : ''}${exclude.pattern}`);
        }
    }

    return { expands: reasons.length > 0, reasons };
}
