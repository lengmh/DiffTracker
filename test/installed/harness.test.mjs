// These are harness guard tests, not installed Host acceptance evidence.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CANDIDATE_VERSION, RELEASE, verifyReleaseMetadata } from './artifacts.mjs';

function metadata() {
    return {
        id: RELEASE.releaseId, tag_name: RELEASE.tag, target_commitish: RELEASE.commit,
        draft: false, prerelease: false, assets: [{
            id: RELEASE.assetId, name: RELEASE.assetName, size: RELEASE.size,
            state: 'uploaded', browser_download_url: RELEASE.url, digest: `sha256:${RELEASE.sha256}`
        }]
    };
}

test('accepts only the independently pinned official released asset', () => {
    assert.equal(verifyReleaseMetadata(metadata()).id, RELEASE.assetId);
});
for (const [label, mutate] of [
    ['different commit', value => { value.target_commitish = '0'.repeat(40); }],
    ['new release id', value => { value.id++; }],
    ['draft', value => { value.draft = true; }],
    ['prerelease', value => { value.prerelease = true; }],
    ['replacement asset', value => { value.assets[0].id++; }],
    ['renamed package', value => { value.assets[0].name = 'candidate.vsix'; }],
    ['different size', value => { value.assets[0].size++; }],
    ['unverified download URL', value => { value.assets[0].browser_download_url = 'https://example.invalid/file.vsix'; }],
    ['digest mismatch', value => { value.assets[0].digest = `sha256:${'0'.repeat(64)}`; }],
    ['missing digest', value => { delete value.assets[0].digest; }]
]) {
    test(`refuses ${label}`, () => {
        const value = metadata(); mutate(value);
        assert.throws(() => verifyReleaseMetadata(value));
    });
}
test('candidate has a higher install version without changing source metadata', () => {
    assert.equal(CANDIDATE_VERSION, '0.8.0');
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url)));
    const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url)));
    assert.equal(pkg.version, '0.7.2');
    assert.equal(lock.version, pkg.version);
    assert.equal(lock.packages[''].version, pkg.version);
});
test('only the unrelated driver is launched as a development extension', () => {
    const runner = readFileSync(new URL('./run.mjs', import.meta.url), 'utf8');
    assert.match(runner, /extensionDevelopmentPath: path.join\(ROOT, 'test\/installed\/driver'\)/);
    const suite = readFileSync(new URL('./suite.cjs', import.meta.url), 'utf8');
    assert.doesNotMatch(suite, /new DiffTracker|require\([^\n]*out\/|_testState/);
    assert.match(suite, /extension\.activate\(\)/);
    assert.match(suite, /driver\.storageUri/);
});
