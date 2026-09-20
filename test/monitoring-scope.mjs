import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    canonicalizeExcludePattern,
    canonicalizeIncludePath,
    createLegacyEffectiveScope,
    createScopeConsentRecord,
    createScopeMigrationRecord,
    parseEffectiveMonitoringScope,
    previewLegacyWatchExcludeMigration,
    scopeConsentMatches,
    scopeMigrationMatches,
    detectScopeExpansion,
    evaluateConfiguredScope,
    validateAndCanonicalizeScope
} from '../out/monitoringScope.js';

const roots = [
    { name: 'backend', uri: 'file:///workspace/backend', caseSensitive: true },
    { name: 'frontend', uri: 'file:///workspace/frontend', caseSensitive: true }
];

function valid(overrides = {}) {
    return {
        mode: 'rules',
        includes: [],
        excludes: [],
        ...overrides
    };
}

{
    const result = validateAndCanonicalizeScope(valid({
        includes: [
            { scope: 'folder', folder: 'frontend', path: 'private-data' },
            { scope: 'all', path: 'shared/assets' },
            { scope: 'all', path: 'shared/assets' }
        ],
        excludes: [
            { scope: 'all', pattern: '**/*.pem' },
            { scope: 'folder', folder: 'backend', pattern: 'generated/' }
        ]
    }), roots, 'linux');
    assert.equal(result.ok, true);
    assert.equal(result.scope.includes.length, 2);
    assert.equal(result.warnings.length, 1);
}

{
    const malformed = [
        { mode: 'invalid', includes: [], excludes: [] },
        { mode: 'rules', includes: {}, excludes: [] },
        { mode: 'rules', includes: [], excludes: 'secret/**' }
    ];
    for (const request of malformed) {
        const result = validateAndCanonicalizeScope(request, roots, 'linux');
        assert.equal(result.ok, false, 'malformed scope requests must remain invalid');
        assert.equal(result.scope, undefined);
    }
}

{
    const a = validateAndCanonicalizeScope(valid({
        includes: [
            { scope: 'all', path: 'z' },
            { scope: 'folder', folder: 'backend', path: 'a/b' }
        ],
        excludes: [
            { scope: 'all', pattern: '**/*.pem' },
            { scope: 'all', pattern: '/tmp/' }
        ]
    }), roots, 'linux');
    const b = validateAndCanonicalizeScope(valid({
        excludes: [
            { scope: 'all', pattern: '/tmp/' },
            { scope: 'all', pattern: '**/*.pem' }
        ],
        includes: [
            { scope: 'folder', folder: 'backend', path: 'a/b' },
            { scope: 'all', path: 'z' }
        ]
    }), [...roots].reverse(), 'linux');
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(a.scope.scopeRevision, b.scope.scopeRevision, 'scope identity must be order-independent');
}

for (const value of ['', '.', './foo', '../foo', 'foo/../bar', '/absolute', 'C:/drive', 'file:///tmp/a', '~/secret', '$HOME/a', 'foo//bar']) {
    assert.equal(canonicalizeIncludePath(value, 'linux'), undefined, `invalid include accepted: ${value}`);
}
assert.equal(canonicalizeIncludePath('private-data/model.bin', 'linux'), 'private-data/model.bin');
assert.equal(canonicalizeIncludePath('literal\\name', 'linux'), 'literal\\name');
assert.equal(canonicalizeIncludePath('literal\\name', 'win32'), undefined);

for (const value of ['', '!secret/**', 'C:/secret/**', 'file:///tmp/**', '$HOME/**']) {
    assert.equal(canonicalizeExcludePattern(value, 'linux'), undefined, `invalid exclude accepted: ${value}`);
}
assert.equal(canonicalizeExcludePattern('/generated/**', 'linux'), '/generated/**');
assert.equal(canonicalizeExcludePattern('#literal-name', 'linux'), '#literal-name');
assert.equal(canonicalizeExcludePattern('name   ', 'linux'), 'name   ', 'trailing spaces are semantic input');

{
    const ambiguousRoots = [
        { name: 'app', uri: 'file:///a', caseSensitive: true },
        { name: 'app', uri: 'file:///b', caseSensitive: true }
    ];
    const result = validateAndCanonicalizeScope(valid({
        includes: [{ scope: 'folder', folder: 'app', path: 'private' }]
    }), ambiguousRoots, 'linux');
    assert.equal(result.ok, false);
    assert.match(result.errors[0].message, /ambiguous/i);
}

{
    const effective = validateAndCanonicalizeScope(valid({
        includes: [{ scope: 'folder', folder: 'frontend', path: 'private' }],
        excludes: [{ scope: 'all', pattern: '**/*.pem' }]
    }), roots, 'linux').scope;
    const equivalent = validateAndCanonicalizeScope(valid({
        includes: [{ scope: 'folder', folder: 'frontend', path: 'private/deeper' }],
        excludes: [{ scope: 'all', pattern: '**/*.pem' }, { scope: 'all', pattern: '**/*.tmp' }]
    }), roots, 'linux').scope;
    assert.equal(detectScopeExpansion(effective, equivalent).expands, false);

    const whole = validateAndCanonicalizeScope(valid({
        mode: 'wholeWorkspace',
        includes: [{ scope: 'folder', folder: 'frontend', path: 'private' }],
        excludes: [{ scope: 'all', pattern: '**/*.pem' }]
    }), roots, 'linux').scope;
    assert.equal(detectScopeExpansion(effective, whole).expands, true);

    const removedExclude = validateAndCanonicalizeScope(valid({
        includes: [{ scope: 'folder', folder: 'frontend', path: 'private' }],
        excludes: []
    }), roots, 'linux').scope;
    assert.equal(detectScopeExpansion(effective, removedExclude).expands, true);

    const broaderInclude = validateAndCanonicalizeScope(valid({
        includes: [{ scope: 'folder', folder: 'frontend', path: 'private' }, { scope: 'all', path: 'secrets' }],
        excludes: [{ scope: 'all', pattern: '**/*.pem' }]
    }), roots, 'linux').scope;
    assert.equal(detectScopeExpansion(effective, broaderInclude).expands, true);
}

console.log('monitoring scope canonicalization and expansion tests passed');

{
    const here = path.dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
    assert.equal(manifest.capabilities.untrustedWorkspaces.supported, false);
    assert.equal(manifest.contributes.configuration.properties['diffTracker.monitoringScope'].scope, 'window');
    assert.deepEqual(manifest.contributes.configuration.properties['diffTracker.monitoringScope'].enum, ['rules', 'wholeWorkspace']);
    assert.equal(manifest.contributes.configuration.properties['diffTracker.watchInclude'].scope, 'window');
    const excludeItems = manifest.contributes.configuration.properties['diffTracker.watchExclude'].items.oneOf;
    assert.ok(excludeItems.some(item => item.type === 'string'), 'legacy Global string rules must remain schema-readable during migration');
    assert.ok(excludeItems.some(item => item.type === 'object'), 'structured Workspace exclusions must be expressible');
}

{
    const legacy = createLegacyEffectiveScope(roots, ['node_modules/', ' !keep-me ', '', 42]);
    assert.equal(legacy.kind, 'legacyV3');
    assert.deepEqual(legacy.legacyWatchExclude, ['node_modules/', '!keep-me']);
    assert.deepEqual(parseEffectiveMonitoringScope(legacy), legacy);
    assert.equal(parseEffectiveMonitoringScope({ ...legacy, scopeRevision: '0'.repeat(64) }), undefined);
}
{
    const configured = validateAndCanonicalizeScope(valid({
        includes: [{ scope: 'all', path: 'private' }],
        excludes: [{ scope: 'all', pattern: '**/*.pem' }]
    }), roots, 'linux').scope;
    const persisted = { kind: 'configured', ...configured };
    assert.deepEqual(parseEffectiveMonitoringScope(persisted), persisted);
}

{
    const requested = validateAndCanonicalizeScope(valid({
        includes: [{ scope: 'folder', folder: 'frontend', path: 'private' }]
    }), roots, 'linux').scope;
    const consent = createScopeConsentRecord(requested);
    assert.equal(scopeConsentMatches(consent, requested), true);
    assert.equal(scopeConsentMatches({ ...consent, scopeRevision: '0'.repeat(64) }, requested), false);
    assert.equal(scopeConsentMatches({ ...consent, roots: [{ name: 'renamed', uri: roots[0].uri }, roots[1]] }, requested), false);
}
{
    const migration = createScopeMigrationRecord(roots);
    assert.equal(scopeMigrationMatches(migration, roots), true);
    assert.equal(scopeMigrationMatches(migration, [{ ...roots[0], name: 'renamed' }, roots[1]]), false);
}

{
    const preview = previewLegacyWatchExcludeMigration([
        'secret/**',
        '!secret/keep.txt',
        'node_modules/',
        '!private-data/'
    ], 'linux');
    assert.ok(preview.manual.includes('!secret/keep.txt'),
        'overlapping legacy negation must require manual migration');
    assert.ok(!preview.includes.some(rule => rule.path === 'secret/keep.txt'));
    assert.ok(preview.includes.some(rule => rule.path === 'private-data'),
        'non-overlapping simple negation can still migrate to explicit include');
}

{
    const preview = previewLegacyWatchExcludeMigration([
        'node_modules/',
        '!private-data/',
        '!src/**/generated',
        '# old comment',
        '',
        'node_modules/'
    ], 'linux');
    assert.deepEqual(preview.excludes, [{ scope: 'all', pattern: 'node_modules/' }]);
    assert.deepEqual(preview.includes, [{ scope: 'all', path: 'private-data' }]);
    assert.deepEqual(preview.manual, ['!src/**/generated']);
    assert.deepEqual(preview.ignoredNoops, ['# old comment']);
}

{
    const configured = validateAndCanonicalizeScope(valid({
        includes: [{ scope: 'folder', folder: 'frontend', path: 'private-data' }],
        excludes: [{ scope: 'all', pattern: '**/*.pem' }]
    }), roots, 'linux').scope;
    assert.deepEqual(
        evaluateConfiguredScope(configured, 'frontend', 'private-data/model.bin', true),
        { monitored: true, source: 'explicitInclude' }
    );
    assert.deepEqual(
        evaluateConfiguredScope(configured, 'frontend', 'private-data', true, true),
        { monitored: true, source: 'explicitInclude' }
    );
    assert.deepEqual(
        evaluateConfiguredScope(configured, 'frontend', 'private-data/nested', true, true),
        { monitored: true, source: 'explicitInclude' }
    );
    assert.deepEqual(
        evaluateConfiguredScope(configured, 'frontend', 'keys/server.pem', false),
        { monitored: false, source: 'explicitExclude' }
    );
    assert.deepEqual(
        evaluateConfiguredScope(configured, 'backend', 'private-data/model.bin', true),
        { monitored: false, source: 'ordinaryPolicy' }
    );
}
{
    const whole = validateAndCanonicalizeScope(valid({
        mode: 'wholeWorkspace',
        excludes: [{ scope: 'all', pattern: 'secret/**' }]
    }), roots, 'linux').scope;
    assert.equal(evaluateConfiguredScope(whole, 'frontend', 'node_modules/a.js', true).monitored, true);
    assert.equal(evaluateConfiguredScope(whole, 'frontend', 'secret/a.txt', false).monitored, false);
}


{
    const rejected = validateAndCanonicalizeScope(valid({
        includes: [
            { scope: 'all', path: '.git/objects' },
            { scope: 'all', path: '.difftracker-restore-probe/child' }
        ]
    }), roots, 'linux');
    assert.equal(rejected.ok, false, 'hard monitoring boundaries must be rejected as include requests');

    const base = validateAndCanonicalizeScope(valid(), roots, 'linux').scope;
    const defensive = {
        ...base,
        includes: [{ scope: 'all', path: '.git/objects' }]
    };
    assert.deepEqual(
        evaluateConfiguredScope(defensive, 'frontend', '.git/objects/pack.bin', true),
        { monitored: false, source: 'hardBoundary' },
        'hard monitoring boundaries cannot be overridden even by a malformed pre-canonicalized scope'
    );
}


{
    const insensitiveRoots = [
        { name: 'workspace', uri: 'file:///workspace', caseSensitive: false }
    ];
    const hard = validateAndCanonicalizeScope(valid({
        includes: [{ scope: 'all', path: '.GIT/objects' }]
    }), insensitiveRoots, 'win32');
    assert.equal(hard.ok, false, 'case-equivalent .GIT must remain a hard boundary');

    const configured = validateAndCanonicalizeScope(valid({
        includes: [{ scope: 'all', path: 'node_modules/private' }]
    }), insensitiveRoots, 'win32').scope;
    assert.deepEqual(
        evaluateConfiguredScope(configured, 'workspace', 'Node_Modules/PRIVATE/file.txt', true),
        { monitored: true, source: 'explicitInclude' },
        'include matching must follow case-insensitive root identity'
    );
}


{
    const configured = validateAndCanonicalizeScope(valid({
        includes: [{ scope: 'all', path: '.difftracker-restore-note.txt' }]
    }), roots, 'linux').scope;
    assert.deepEqual(
        evaluateConfiguredScope(configured, 'frontend', '.difftracker-restore-note.txt', true, false),
        { monitored: true, source: 'explicitInclude' },
        'restore-prefixed ordinary file leaf must remain monitorable'
    );
    assert.deepEqual(
        evaluateConfiguredScope(configured, 'frontend', '.difftracker-restore-note.txt', true, true),
        { monitored: false, source: 'hardBoundary' },
        'restore-prefixed directory leaf must remain a hard boundary'
    );
    assert.deepEqual(
        evaluateConfiguredScope(configured, 'frontend', '.difftracker-restore-note.txt/child', true, false),
        { monitored: false, source: 'hardBoundary' },
        'descendants of a restore-prefixed directory component remain hard-boundary resources'
    );
}


{
    const duplicateRoots = [
        { name: 'app', uri: 'file:///case-sensitive/app', caseSensitive: true },
        { name: 'app', uri: 'file:///case-insensitive/app', caseSensitive: false }
    ];
    const configured = validateAndCanonicalizeScope(valid({
        includes: [{ scope: 'all', path: 'Private/Data' }]
    }), duplicateRoots, 'linux').scope;
    assert.equal(configured !== undefined, true,
        'scope-all rules remain valid when display names are duplicated');
    assert.deepEqual(
        evaluateConfiguredScope(configured, duplicateRoots[0], 'private/data/file.txt', true),
        { monitored: false, source: 'ordinaryPolicy' },
        'case-sensitive duplicate-name root must keep its own path identity'
    );
    assert.deepEqual(
        evaluateConfiguredScope(configured, duplicateRoots[1], 'private/data/file.txt', true),
        { monitored: true, source: 'explicitInclude' },
        'all-root evaluation must use the actual root identity, not the first matching display name'
    );
}
