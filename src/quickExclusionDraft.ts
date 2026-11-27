import type { QuickExclusionProposal } from './monitoringScopeController';
import { CanonicalMonitoringScope, configuredScopeExplicitlyExcludesPath, MonitoringScopeRequest, validateAndCanonicalizeScope } from './monitoringScope';

export interface QuickExclusionDraftSnapshot {
    mode: string;
    includes: string;
    excludes: string;
    base: unknown;
    baseRoots?: unknown;
    baseVersion?: string;
}

export type QuickExclusionDraftPlan =
    | { request: MonitoringScopeRequest; dirty: boolean }
    | { conflict: string };

function mergeRules<T>(base: T[], draft: T[], saved: T[]): T[] | undefined {
    const a = JSON.stringify(base), b = JSON.stringify(draft), c = JSON.stringify(saved);
    if (a === b) { return saved; }
    if (a === c || b === c) { return draft; }
    // Concurrent additive edits are independent. Replacements/removals in
    // both copies may express conflicting intent, even for different rules.
    const draftKeys = new Set(draft.map(rule => JSON.stringify(rule)));
    const savedKeys = new Set(saved.map(rule => JSON.stringify(rule)));
    if (base.some(rule => !draftKeys.has(JSON.stringify(rule)) || !savedKeys.has(JSON.stringify(rule)))) {
        return undefined;
    }
    return [...saved, ...draft.filter(rule => !savedKeys.has(JSON.stringify(rule)))];
}

export function planQuickExclusionDraft(
    snapshot: QuickExclusionDraftSnapshot, proposal: QuickExclusionProposal, requestVersion: string
): QuickExclusionDraftPlan {
    const { current, scope, owner, relative, directory, rule } = proposal;
    const request = { mode: scope.mode, includes: scope.includes, excludes: scope.excludes };
    let edited;
    try {
        edited = validateAndCanonicalizeScope({
            mode: snapshot.mode,
            includes: JSON.parse(snapshot.includes || '[]'),
            excludes: JSON.parse(snapshot.excludes || '[]')
        }, current.roots).scope;
    } catch {
        // Preserve invalid in-progress JSON verbatim.
    }
    if (!edited) {
        return { conflict: 'The editor draft contains invalid or incomplete rules and cannot be updated safely.' };
    }
    if (edited.scopeRevision === current.scopeRevision || edited.scopeRevision === scope.scopeRevision) {
        return { request, dirty: false };
    }
    const stale = snapshot.baseVersion !== requestVersion;
    if (stale && JSON.stringify(snapshot.baseRoots) !== JSON.stringify(current.roots)) {
        return { conflict: 'The workspace roots of the editor draft cannot be verified against the current workspace.' };
    }
    const base = stale ? validateAndCanonicalizeScope(snapshot.base, current.roots).scope : current;
    if (!base) {
        return { conflict: 'The original base of the editor draft is unavailable.' };
    }
    const mode = edited.mode === base.mode ? current.mode : edited.mode;
    const includes = mergeRules(base.includes, edited.includes, current.includes);
    const excludes = mergeRules(base.excludes, edited.excludes, current.excludes);
    if (!includes || !excludes) {
        const fields = [!includes && 'includes', !excludes && 'excludes'].filter(Boolean).join(' and ');
        return { conflict: `The editor draft and saved settings both changed explicit ${fields}; their intent cannot be merged safely.` };
    }

    // An authored include intersecting the target subtree is a real intent
    // conflict: explicit excludes take priority over explicit includes.
    const asComparable = (value: string) => owner.caseSensitive ? value : value.toLowerCase();
    const target = asComparable(relative);
    const baseIncludes = new Set(base.includes.map(include => JSON.stringify(include)));
    const overlaps = edited.includes.some(include => {
        if ((include.scope === 'folder' && include.folder !== owner.name) || baseIncludes.has(JSON.stringify(include))) { return false; }
        const path = asComparable(include.path);
        return path === target || target.startsWith(path + '/') || (directory && path.startsWith(target + '/'));
    });
    if (overlaps) {
        return { conflict: 'The editor draft explicitly includes this target or an overlapping path; the new exclusion would take priority.' };
    }

    if (stale) {
        const combined = { ...current, excludes };
        const newlyShadowed = (side: CanonicalMonitoringScope) => side.includes.some(include =>
            !baseIncludes.has(JSON.stringify(include)) && side.roots.some(root =>
                (include.scope === 'all' || include.folder === root.name) &&
                [false, true].some(directory =>
                    !configuredScopeExplicitlyExcludesPath(side, root, include.path, directory) &&
                    configuredScopeExplicitlyExcludesPath(combined, root, include.path, directory)
                )
            )
        );
        if (newlyShadowed(edited) || newlyShadowed(current)) {
            return { conflict: 'An unsaved or externally added include is blocked by the other copy’s explicit exclusions.' };
        }
    }
    const checked = validateAndCanonicalizeScope({ mode, includes, excludes: [...excludes, rule] }, current.roots).scope;
    if (!checked) {
        return { conflict: 'The editor draft cannot be combined safely with the new exclusion.' };
    }
    return { request: { mode: checked.mode, includes: checked.includes, excludes: checked.excludes },
        dirty: checked.scopeRevision !== scope.scopeRevision };
}
