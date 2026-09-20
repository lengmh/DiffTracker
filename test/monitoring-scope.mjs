import assert from 'node:assert/strict';
import {
    canonicalizeExcludePattern,
    canonicalizeIncludePath,
    detectScopeExpansion,
    validateAndCanonicalizeScope
} from '../out/monitoringScope.js';

const roots = [
    { name: 'backend', uri: 'file:///workspace/backend' },
    { name: 'frontend', uri: 'file:///workspace/frontend' }
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
    assert.equal(a.scope.revision, b.scope.revision, 'scope identity must be order-independent');
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
        { name: 'app', uri: 'file:///a' },
        { name: 'app', uri: 'file:///b' }
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
