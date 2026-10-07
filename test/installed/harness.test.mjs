// These are harness guard tests, not installed Host acceptance evidence.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
test('candidate matches consistent 0.8.1 source metadata and upgrades official 0.7.2', () => {
    assert.equal(CANDIDATE_VERSION, '0.8.1');
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url)));
    const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url)));
    assert.equal(pkg.version, '0.8.1');
    assert.equal(CANDIDATE_VERSION, pkg.version);
    assert.equal(RELEASE.tag, 'v0.7.2');
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
test('installed job resolves its temporary path after runner assignment', () => {
    const workflow = readFileSync(new URL('../../.github/workflows/verification.yml', import.meta.url), 'utf8');
    const installed = workflow.split('  installed-extension-host:\n')[1].split('\n  downgrade-compatibility:')[0];
    const jobSettings = installed.split('    steps:')[0];
    // GitHub does not provide runner at jobs.<job_id>.env. It is available
    // only after assignment, in steps and their process environment.
    assert.doesNotMatch(jobSettings, /\$\{\{\s*runner[.[]/);
    assert.match(installed, /RC_ARTIFACTS=\$RUNNER_TEMP\/difftracker-installed-rc-evidence/);
});
test('Stable fixture uses the current auto-update enum without weakening settings preservation', () => {
    const runner = readFileSync(new URL('./run.mjs', import.meta.url), 'utf8');
    assert.match(runner, /'extensions\.autoUpdate': 'off'/);
    assert.match(runner, /assert\.deepEqual\(readFileSync\(fixture\.settingsPath\), beforeSettings/);
});

test('release gates the one final VSIX before upload and validates producer evidence before publication', () => {
    const workflow = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
    const [build, publish] = workflow.split('\n  publish:');
    assert.equal((build.match(/npm run package --/g) || []).length, 1);
    assert.ok(build.indexOf('xvfb-run -a node test/installed/run.mjs') > build.indexOf('npm run package --'));
    assert.ok(build.indexOf('node test/installed/final-artifact.mjs') < build.indexOf('uses: actions/upload-artifact'));
    assert.match(build, /run\.mjs "\$RC_ARTIFACTS" --final/);
    assert.match(build, /sha256: \$\{\{ steps\.identity\.outputs\.sha256 \}\}/);
    assert.match(publish, /FINAL_VSIX_SHA256: \$\{\{ needs\.build\.outputs\.sha256 \}\}/);
    assert.ok(publish.indexOf('node test/installed/final-artifact.mjs') < publish.indexOf('name: Check tag and release state'));
    assert.doesNotMatch(workflow, /continue-on-error|npm run package[^\n]*DO-NOT-PUBLISH/);
});

test('PR verification exercises the external final VSIX path without dispatching Release', () => {
    const workflow = readFileSync(new URL('../../.github/workflows/verification.yml', import.meta.url), 'utf8');
    const installed = workflow.split('  installed-extension-host:\n')[1].split('\n  downgrade-compatibility:')[0];
    assert.match(installed, /npm run package -- --out "\$FINAL_VSIX"/);
    assert.match(installed, /artifacts\.mjs --final/);
    assert.match(installed, /run\.mjs "\$RC_ARTIFACTS" --final/);
    assert.doesNotMatch(installed, /workflow_dispatch|gh workflow run/);
});

for (const [script, args] of [
    ['artifacts.mjs', ['--final', '/tmp/missing-final-inputs']],
    ['artifacts.mjs', ['--unknown']],
    ['run.mjs', ['/tmp/missing-final-inputs', '--final']],
    ['run.mjs', ['/tmp/missing-final-inputs', '--unknown']]
]) {
    test(`${script} rejects incomplete or unknown external mode before side effects: ${args.at(-1)}`, () => {
        const result = spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), ...args],
            { encoding: 'utf8', timeout: 5000 });
        assert.equal(result.error, undefined, 'invalid input must fail promptly, not start a download or Host');
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /required arguments|unknown|incomplete/);
        assert.doesNotMatch(result.stdout, /Executing prepublish|Downloading|Installing extensions/);
    });
}
