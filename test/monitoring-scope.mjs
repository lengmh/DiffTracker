import assert from 'node:assert/strict';
import fs from 'node:fs';
import ignore from 'ignore';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withLookups } from './pr11-final-scope-regressions.mjs';
import {
    canonicalizeExcludePattern,
    canonicalizeIncludePath,
    createLegacyEffectiveScope,
    createLegacySourceFingerprint,
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
import { detectLocalPathCaseSensitivity } from '../out/utils/pathIdentity.js';

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

for (const value of [
    '', '!secret/**', 'C:/secret/**', 'file:///tmp/**', '$HOME/**',
    '.', './secrets/**', '../secrets/**', 'a/../secrets/**', 'secrets//key', '/'
]) {
    assert.equal(canonicalizeExcludePattern(value, 'linux'), undefined, `invalid exclude accepted: ${value}`);
}
{
    const result = validateAndCanonicalizeScope(valid({
        excludes: [{ scope: 'all', pattern: './secrets/**' }]
    }), roots, 'linux');
    assert.equal(result.ok, false, 'non-canonical explicit excludes must reject the whole scope request');
    assert.equal(result.scope, undefined);
}
for (const value of [
    'a/***', '/a/***', 'a/****', 'a/***/b',
    '**/**', '/**/**', '**/**/', 'a/**/**', 'a/**/**/b', '**/**/*.txt', 'a/**/**/*.txt'
]) {
    assert.equal(canonicalizeExcludePattern(value, 'linux'), undefined,
        `unsupported glob structure accepted: ${value}`);
}
{
    const result = validateAndCanonicalizeScope(valid({
        includes: [{ scope: 'all', path: 'a' }],
        excludes: [{ scope: 'all', pattern: 'a/***' }]
    }), roots, 'linux');
    assert.equal(result.ok, false,
        'scope must reject exclusion syntax whose semantics diverge from the installed ignore engine');
    assert.equal(result.scope, undefined);
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

    const removedRootEffective = validateAndCanonicalizeScope(valid({
        excludes: [{ scope: 'folder', folder: 'frontend', pattern: 'private/**' }]
    }), roots, 'linux').scope;
    const reducedRoots = [roots[0]];
    const removedRootRequested = validateAndCanonicalizeScope(valid(), reducedRoots, 'linux').scope;
    assert.equal(
        detectScopeExpansion(removedRootEffective, removedRootRequested).expands,
        false,
        'dropping rules that only applied to a removed root is a contraction'
    );
}

{
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-exclude-case-cache-'));
    const rootPath = path.join(parent, 'workspace');
    const flat = path.join(rootPath, 'flat');
    fs.mkdirSync(flat, { recursive: true });
    fs.writeFileSync(path.join(flat, 'ProbeName'), 'probe');
    for (let index = 0; index < 32; index++) {
        fs.writeFileSync(path.join(flat, `file-${index}.ts`), 'x');
    }

    try {
        const rootCaseSensitive = detectLocalPathCaseSensitivity(rootPath);
        assert.equal(typeof rootCaseSensitive, 'boolean', 'fixture must establish workspace-root case semantics');
        const rootIdentity = {
            name: 'workspace',
            uri: pathToFileURL(rootPath).toString(),
            caseSensitive: rootCaseSensitive
        };
        const checked = validateAndCanonicalizeScope(valid({
            excludes: [{ scope: 'all', pattern: 'flat/*.log' }]
        }), [rootIdentity], process.platform);
        assert.equal(checked.ok, true, JSON.stringify(checked.errors));

        let flatEnumerations = 0;
        const originalReaddirSync = fs.readdirSync;
        fs.readdirSync = (value, ...args) => {
            if (typeof value === 'string' && path.resolve(value) === path.resolve(flat)) {
                flatEnumerations++;
            }
            return originalReaddirSync(value, ...args);
        };
        try {
            for (let index = 0; index < 32; index++) {
                const decision = evaluateConfiguredScope(
                    checked.scope, rootIdentity, `flat/file-${index}.ts`, false
                );
                assert.deepEqual(decision, { monitored: true, source: 'ordinaryPolicy' });
            }
            const afterBatch = flatEnumerations;
            assert.ok(afterBatch <= 6,
                `verified per-directory case semantics must be cached during exclusion scans; got ${afterBatch} enumerations`);

            const beforeMutation = fs.statSync(flat);
            fs.writeFileSync(path.join(flat, 'cache-invalidation.tmp'), 'mutation');
            const forced = new Date(Math.max(Date.now(), beforeMutation.mtimeMs + 5000));
            fs.utimesSync(flat, forced, forced);
            evaluateConfiguredScope(checked.scope, rootIdentity, 'flat/file-0.ts', false);
            assert.ok(flatEnumerations > afterBatch,
                'directory metadata changes must invalidate the verified case-semantics cache');
        } finally {
            fs.readdirSync = originalReaddirSync;
        }
    } finally {
        fs.rmSync(parent, { recursive: true, force: true });
    }
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
    const orderedSource = createLegacySourceFingerprint({
        global: { kind: 'value', value: ['secret/**', '!secret/keep.txt'] },
        workspace: { kind: 'unset' }
    });
    const reorderedSource = createLegacySourceFingerprint({
        workspace: { kind: 'unset' },
        global: { kind: 'value', value: ['!secret/keep.txt', 'secret/**'] }
    });
    const sameObjectOrderIndependent = createLegacySourceFingerprint({
        workspace: { kind: 'unset' },
        global: { kind: 'value', value: ['secret/**', '!secret/keep.txt'] }
    });
    assert.notEqual(orderedSource, reorderedSource, 'ordered legacy arrays are semantic evidence');
    assert.equal(orderedSource, sameObjectOrderIndependent, 'object key order is not semantic evidence');

    const targetRevision = '1'.repeat(64);
    const migration = createScopeMigrationRecord(roots, orderedSource, orderedSource, targetRevision, 'manual');
    assert.equal(scopeMigrationMatches(migration, roots, orderedSource, targetRevision), true);
    assert.equal(scopeMigrationMatches(migration, roots, reorderedSource, targetRevision), false);
    assert.equal(scopeMigrationMatches(migration, roots, orderedSource, '2'.repeat(64)), false);
    assert.equal(scopeMigrationMatches(migration, [{ ...roots[0], name: 'renamed' }, roots[1]], orderedSource, targetRevision), false);
    assert.equal(scopeMigrationMatches({ model: 1, roots }, roots, orderedSource, targetRevision), false,
        'legacy roots-only migration records cannot authorize the new evidence model');
}

{
    const preview = previewLegacyWatchExcludeMigration([
        'secret/**',
        '!secret/keep.txt',
        'node_modules/',
        '!private-data/'
    ], 'linux');
    assert.ok(preview.manual.includes('secret/**'),
        'positive legacy exclusion requires manual confirmation because later ordinary negations may override it');
    assert.ok(preview.manual.includes('node_modules/'),
        'each positive legacy exclusion remains a manual migration item');
    assert.ok(preview.manual.includes('!secret/keep.txt'),
        'overlapping legacy negation must require manual migration');
    assert.ok(preview.includes.some(rule => rule.path === 'secret/keep.txt'),
        'manual legacy negations remain available as explicit-include suggestions');
    assert.ok(preview.includes.some(rule => rule.path === 'private-data'),
        'simple negation remains available as an explicit-include suggestion');
    assert.ok(preview.manual.includes('!private-data/'),
        'simple negations require manual confirmation because ordinary policy can override legacy ordering');
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
    assert.deepEqual(preview.manual, ['node_modules/', '!src/**/generated', '!private-data/']);
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
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-verified-insensitive-'));
    const actual = path.join(workspace, 'node_modules', 'private');
    fs.mkdirSync(actual, { recursive: true });
    fs.writeFileSync(path.join(actual, 'file.txt'), 'data');
    const insensitiveRoots = [
        { name: 'workspace', uri: pathToFileURL(workspace).href, caseSensitive: false }
    ];
    try {
        const hard = validateAndCanonicalizeScope(valid({
            includes: [{ scope: 'all', path: '.GIT/objects' }]
        }), insensitiveRoots, 'win32');
        assert.equal(hard.ok, false, 'case-equivalent .GIT must remain a hard boundary');
        await withLookups([
            [path.join(workspace, 'Node_Modules'), path.join(workspace, 'node_modules')],
            [path.join(workspace, 'node_modules', 'PRIVATE'), actual]
        ], [], async () => {
            const configured = validateAndCanonicalizeScope(valid({
                includes: [{ scope: 'all', path: 'node_modules/private' }]
            }), insensitiveRoots, 'win32').scope;
            assert.deepEqual(
                evaluateConfiguredScope(configured, 'workspace', 'Node_Modules/PRIVATE/file.txt', true),
                { monitored: true, source: 'explicitInclude' },
                'include matching must follow verified lookup at each boundary'
            );
        });
    } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
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
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-duplicate-root-identity-'));
    const sensitive = path.join(workspace, 'sensitive'), insensitive = path.join(workspace, 'insensitive');
    for (const root of [sensitive, insensitive]) {
        fs.mkdirSync(path.join(root, 'private', 'data'), { recursive: true });
        fs.writeFileSync(path.join(root, 'private', 'data', 'file.txt'), 'data');
    }
    const duplicateRoots = [
        { name: 'app', uri: pathToFileURL(sensitive).href, caseSensitive: true },
        { name: 'app', uri: pathToFileURL(insensitive).href, caseSensitive: false }
    ];
    try {
        await withLookups([
            [path.join(insensitive, 'Private'), path.join(insensitive, 'private')],
            [path.join(insensitive, 'private', 'Data'), path.join(insensitive, 'private', 'data')]
        ], [path.join(sensitive, 'Private')], async () => {
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
        });
    } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
}


{
    const effective = validateAndCanonicalizeScope(valid({
        excludes: [{ scope: 'all', pattern: 'secret/a.txt' }]
    }), roots, 'linux').scope;
    const requested = validateAndCanonicalizeScope(valid({
        excludes: [{ scope: 'all', pattern: 'secret/**' }]
    }), roots, 'linux').scope;
    assert.equal(detectScopeExpansion(effective, requested).expands, false,
        'broader requested exclusion is a pure contraction, not an expansion');

    const redundantEffective = validateAndCanonicalizeScope(valid({
        excludes: [
            { scope: 'all', pattern: 'secret/**' },
            { scope: 'all', pattern: 'secret/a.txt' }
        ]
    }), roots, 'linux').scope;
    assert.equal(detectScopeExpansion(redundantEffective, requested).expands, false,
        'removing a redundant narrow exclusion after a broader one remains a contraction');
}


{
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-path-identity-'));
    const numericRoot = path.join(parent, '1234567890');
    fs.mkdirSync(numericRoot);
    try {
        assert.equal(
            detectLocalPathCaseSensitivity(numericRoot, 'win32'),
            undefined,
            'path identity detection must return unknown when no existing component can prove case semantics'
        );
        const unresolvedRoot = [{
            name: 'workspace',
            uri: 'file:///workspace',
            caseSensitive: undefined
        }];
        const result = validateAndCanonicalizeScope(valid(), unresolvedRoot, 'win32');
        assert.equal(result.ok, false,
            'configured scope must fail closed when root case semantics are unverified');
        assert.match(result.errors.map(error => error.message).join(' '), /case-sensitivity/i);
    } finally {
        fs.rmSync(parent, { recursive: true, force: true });
    }
}


{
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-path-distinct-case-'));
    const root = path.join(parent, 'CaseProofRoot');
    const first = path.join(root, 'CaseProof');
    const alternate = path.join(root, 'caseProof');
    fs.mkdirSync(root);
    fs.mkdirSync(first);
    let distinctVariants = false;
    try {
        fs.mkdirSync(alternate);
        distinctVariants = fs.realpathSync.native(first) !== fs.realpathSync.native(alternate);
    } catch {
        // Case-insensitive hosts cannot create two distinct variants.
    }
    try {
        if (distinctVariants) {
            assert.equal(
                detectLocalPathCaseSensitivity(root),
                true,
                'two distinct resources inside the workspace at toggled casing prove case-sensitive lookup'
            );
        }
    } finally {
        fs.rmSync(parent, { recursive: true, force: true });
    }
}


{
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-path-case-alias-'));
    const original = path.join(parent, 'CaseAlias');
    const alias = path.join(parent, 'caseAlias');
    fs.mkdirSync(original);
    let aliasCreated = false;
    try {
        fs.symlinkSync(original, alias, process.platform === 'win32' ? 'junction' : 'dir');
        aliasCreated = fs.existsSync(alias) && fs.readdirSync(parent).includes('CaseAlias') &&
            fs.readdirSync(parent).includes('caseAlias');
    } catch {
        // Hosts without symlink/junction permission cannot exercise this case.
    }
    try {
        if (aliasCreated) {
            assert.equal(
                detectLocalPathCaseSensitivity(original),
                undefined,
                'a case-variant alias outside an empty workspace proves neither internal sensitive nor insensitive lookup'
            );
        }
    } finally {
        fs.rmSync(parent, { recursive: true, force: true });
    }
}

for (const [before,after,expands] of [
    ['secret','/secret',true], ['secret/','/secret/',true], ['secret','**/secret',false],
    ['secret/','secret',false], ['secret','secret/',true],
    ['secret/a.txt','secret/**',false], ['/secret/a.txt','/secret',false],
    ['secret/a.txt','secret/a.txt/**',true]
]) {
    const effective=validateAndCanonicalizeScope(valid({excludes:[{scope:'all',pattern:before}]}),roots).scope;
    const requested=validateAndCanonicalizeScope(valid({excludes:[{scope:'all',pattern:after}]}),roots).scope;
    assert.equal(detectScopeExpansion(effective,requested).expands,expands,`PR11 containment ${before} -> ${after}`);
}

// Validate every claimed contraction over a bounded exhaustive witness set.
// This is a regression oracle, not the production containment proof.
{
    const patterns=['secret','secret/','/secret','/secret/','**/secret','**/secret/','secret/a','secret/**','/secret/a',
        'a','a/','/a','a/secret','a/secret/**','**/a','**','**/*','*.txt','**/secret/*','secret/a/**'];
    let paths=['secret','a','other','a.txt'];
    const components=[...paths];
    for(let depth=1,level=[...paths];depth<4;depth++){
        level=level.flatMap(prefix=>components.map(component=>`${prefix}/${component}`));paths.push(...level);
    }
    const testRoots=[{name:'proof',uri:'file:///proof',caseSensitive:true}];
    const make=pattern=>validateAndCanonicalizeScope(valid({excludes:[{scope:'all',pattern}]}),testRoots).scope;
    let proofs=0;
    for(const before of patterns)for(const after of patterns){
        const effective=make(before),requested=make(after);
        if(detectScopeExpansion(effective,requested).expands)continue;
        proofs++;
        for(const target of paths)for(const directory of [false,true]){
            if(evaluateConfiguredScope(effective,testRoots[0],target,false,directory).source==='explicitExclude'){
                assert.equal(evaluateConfiguredScope(requested,testRoots[0],target,false,directory).source,'explicitExclude',
                    `unsound contraction ${before} -> ${after} at ${target} directory=${directory}`);
            }
        }
    }
    console.log(`PR11 checked ${proofs} structural contractions against ${paths.length*2} file/directory witnesses each`);
}

// Verify segment-aware exclusions against the installed ignore engine.
{
const root=fs.mkdtempSync(path.join(os.tmpdir(),'dt-glob-oracle-'));
const identity={name:'oracle',uri:pathToFileURL(root).href,caseSensitive:true};
const names=['a','b','aa','ab','secret','a.txt','b.txt','a.log','.hidden','#note','café','file[1]'];
const paths=[...names,...names.flatMap(a=>names.map(b=>`${a}/${b}`)),...['a','b'].flatMap(a=>['a','b','secret'].flatMap(b=>names.map(c=>`${a}/${b}/${c}`)))];
for(const rel of paths)fs.mkdirSync(path.join(root,rel),{recursive:true});
const patterns=['*','**','**/','a','/a','a/','/a/','a/**','a/**/','**/a','**/a/','a/**/b','a/**/b/','**/a/**/b','a/*','a/*/','*/a','*/a/','*/a/**','*.txt','**/*.txt','a/*.txt','[ab]','[!a]','[a-z]*','a?','a**','**a','a/**b','a**/b','**/*/**','file\\[1]','#note','café','a\\.txt','a\\*',' a','name   ','a[bc]','a/??','a/ab/**','a/**/','**/a/**'];
const rejectedPatterns=['***','a/***/b','**/**','**/**/','**/**/*.txt','a/**/**/b'];
for(const pattern of rejectedPatterns){
 assert.equal(canonicalizeExcludePattern(pattern,'linux'),undefined,
   `oracle unsupported pattern must be rejected before matching: ${pattern}`);
}
let checked=0,failed=[];
const convert=p=>{if(p.startsWith('#'))p='\\'+p; const m=p.match(/ +$/)?.[0].length??0;return m?p.slice(0,-m)+'\\ '.repeat(m):p};
for(const pattern of patterns.filter(p=>p!=='/'))for(const rel of paths)for(const directory of [false,true]){
 const expected=ignore({ignorecase:false}).add(convert(pattern)).ignores(rel+(directory?'/':''));
 const got=evaluateConfiguredScope({roots:[identity],mode:'rules',includes:[],excludes:[{scope:'all',pattern}]},identity,rel,false,directory).source==='explicitExclude';
 checked++;if(expected!==got&&failed.length<30)failed.push({pattern,rel,directory,expected,got});
}
fs.rmSync(root,{recursive:true,force:true});
assert.deepEqual(failed, [], 'filesystem-aware matching must preserve ordinary gitignore glob semantics');
console.log(`PR11 checked ${checked} exclusion decisions against the installed ignore engine`);
}
