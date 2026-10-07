// Installed acceptance inputs. Internal candidate packages must never be published.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROOT, ID, RELEASE, hash, zipRead, verifyVsix } from './artifact-common.mjs';
import { parseFinalArtifactArgs, verifyFinalArtifact } from './final-artifact.mjs';
export { ROOT, ID, RELEASE, hash, zipRead, verifyVsix };
export const CANDIDATE_VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'))).version;

export function verifyReleaseMetadata(metadata) {
    assert.equal(metadata.id, RELEASE.releaseId);
    assert.equal(metadata.tag_name, RELEASE.tag);
    assert.equal(metadata.target_commitish, RELEASE.commit);
    assert.equal(metadata.draft, false);
    assert.equal(metadata.prerelease, false);
    const asset = metadata.assets.find(item => item.id === RELEASE.assetId);
    assert.ok(asset, 'the exact official released asset must still exist');
    assert.equal(asset.name, RELEASE.assetName);
    assert.equal(asset.size, RELEASE.size);
    assert.equal(asset.state, 'uploaded');
    assert.equal(asset.browser_download_url, RELEASE.url);
    assert.equal(asset.digest, `sha256:${RELEASE.sha256}`);
    return asset;
}

export async function prepareReleasedArtifact(destination) {
    mkdirSync(destination, { recursive: true });
    const metadataUrl = `https://api.github.com/repos/${RELEASE.repository}/releases/tags/${RELEASE.tag}`;
    const fetchChecked = async url => {
        const response = await fetch(url, { signal: AbortSignal.timeout(60_000), headers: { 'User-Agent': 'DiffTracker-installed-RC-verification' } });
        assert.equal(response.ok, true, `${url}: HTTP ${response.status}`);
        return response;
    };
    const metadata = await (await fetchChecked(metadataUrl)).json();
    verifyReleaseMetadata(metadata);
    const released = path.join(destination, RELEASE.assetName);
    const bytes = Buffer.from(await (await fetchChecked(RELEASE.url)).arrayBuffer());
    assert.equal(bytes.length, RELEASE.size);
    assert.equal(hash(bytes), RELEASE.sha256, 'refuse replaced/unverified release bytes');
    writeFileSync(released, bytes);
    verifyVsix(released, '0.7.2');
    writeFileSync(path.join(destination, 'official-release.json'), JSON.stringify(metadata, null, 2));

    return released;
}

export async function prepareArtifacts(destination) {
    const released = await prepareReleasedArtifact(destination);
    // vsce overrides only its package stream. Guard both repository manifests
    // byte-for-byte rather than temporarily bumping and attempting to undo them.
    const manifests = ['package.json', 'package-lock.json'].map(name => [name, readFileSync(path.join(ROOT, name))]);
    const candidate = path.join(destination, `DO-NOT-PUBLISH-code-diff-tracker-${CANDIDATE_VERSION}-internal.vsix`);
    try {
        execFileSync(process.execPath, [path.join(ROOT, 'node_modules/@vscode/vsce/vsce'), 'package',
            CANDIDATE_VERSION, '--no-update-package-json', '--no-git-tag-version', '--out', candidate],
        { cwd: ROOT, stdio: 'inherit', timeout: 180_000 });
    } finally {
        for (const [name, before] of manifests) {
            assert.deepEqual(readFileSync(path.join(ROOT, name)), before, `${name} must not change`);
        }
    }
    const packaged = verifyVsix(candidate, CANDIDATE_VERSION);
    // Every compiled production file must be the current build, not a second
    // product build pretending to be the released version.
    const entries = execFileSync('unzip', ['-Z1', candidate], { encoding: 'utf8' }).trim().split('\n');
    for (const entry of entries.filter(entry => entry.startsWith('extension/out/') && !entry.endsWith('/'))) {
        assert.deepEqual(zipRead(candidate, entry), readFileSync(path.join(ROOT, entry.slice('extension/'.length))));
    }
    const evidence = {
        warning: 'INTERNAL INSTALLED RC VERIFICATION ONLY. DO NOT PUBLISH.',
        sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
        sourceDirty: execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim().length > 0,
        sourceVersion: JSON.parse(manifests[0][1]).version,
        candidateVersion: CANDIDATE_VERSION,
        candidateSha256: hash(readFileSync(candidate)), candidateEntryHash: packaged.entryHash,
        release: RELEASE
    };
    writeFileSync(path.join(destination, 'DO-NOT-PUBLISH-evidence.json'), JSON.stringify(evidence, null, 2));
    return { released, candidate, evidence };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv[2] === '--final') {
        assert.ok(process.argv[3], 'final artifact directory is required');
        const expected = parseFinalArtifactArgs(process.argv.slice(4));
        // Fail before network/download activity; never fall back to packaging.
        verifyFinalArtifact(expected);
        await prepareReleasedArtifact(path.resolve(process.argv[3]));
        verifyFinalArtifact(expected);
    } else {
        assert.equal(process.argv.length, 3, 'usage: node test/installed/artifacts.mjs <artifact-directory> OR --final <directory> <file> <version> <sha256> <source-commit> <run-id> <run-attempt>');
        assert.ok(!process.argv[2].startsWith('--'), 'unknown artifact mode');
        await prepareArtifacts(path.resolve(process.argv[2]));
    }
}
