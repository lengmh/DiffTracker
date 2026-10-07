import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import test from 'node:test';
import { parseFinalArtifactArgs, verifyFinalArtifact, verifyFinalEvidence } from './final-artifact.mjs';

const DIGEST = '1'.repeat(64);
const COMMIT = '2'.repeat(40);
const args = (file = 'candidate.vsix') => [file, '0.8.0', DIGEST, COMMIT, '123456', '2'];

test('external verification requires a complete explicit artifact identity', () => {
    assert.deepEqual(parseFinalArtifactArgs(args()), {
        file: path.resolve('candidate.vsix'), version: '0.8.0', sha256: DIGEST,
        sourceCommit: COMMIT, runId: '123456', runAttempt: '2'
    });
    for (let length = 0; length < 6; length++) {
        assert.throws(() => parseFinalArtifactArgs(args().slice(0, length)));
    }
    assert.throws(() => parseFinalArtifactArgs([...args(), 'extra']));
    const invalid = [
        [0, ''], [1, '0.7.2'], [1, '0.7.2-rc.1'], [1, 'v0.8.0'], [1, '0.8.0-01'],
        [1, '0.8'], [1, '01.8.0'], [2, 'A'.repeat(64)], [2, 'abc'],
        [3, 'A'.repeat(40)], [3, 'HEAD'], [4, '0'], [4, '-1'], [4, '1.5'],
        [4, '01'], [5, '0'], [5, '2e1'], [5, '']
    ];
    for (const [index, value] of invalid) {
        const input = args(); input[index] = value;
        assert.throws(() => parseFinalArtifactArgs(input), `reject argument ${index}: ${value}`);
    }
    assert.equal(parseFinalArtifactArgs(args().map((value, index) => index === 1 ? '0.8.0-rc.1' : value)).version, '0.8.0-rc.1');
});

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const ENTRY = Buffer.from('module.exports.activate = () => undefined;\n');
const manifest = { name: 'code-diff-tracker', publisher: 'lengmh', version: '0.8.0', main: './out/extension.js' };
const xml = (version = '0.8.0', id = 'code-diff-tracker', publisher = 'lengmh') =>
    `<?xml version="1.0" encoding="utf-8"?><PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Language="en-US" Id="${id}" Version="${version}" Publisher="${publisher}" /></Metadata></PackageManifest>`;
const content = () => [
    ['extension/package.json', JSON.stringify(manifest)], ['extension.vsixmanifest', xml()],
    ['extension/out/extension.js', ENTRY], ['extension/out/nested/worker.js', 'exports.ready = true;\n'],
    ['extension/webview/panel.js', 'window.ready = true;\n'], ['extension/resources/icon.svg', '<svg />\n']
];

// Real small ZIP archives, including intentionally duplicate names. Avoid mocks
// of archive reads so validation is tested at its external-file boundary.
function zip(entries) {
    const locals = [], directory = [];
    let offset = 0;
    for (const [name, source, options = {}] of entries) {
        const bytes = Buffer.from(source), filename = Buffer.from(name);
        const method = options.deflate ? 8 : 0;
        const compressed = method === 8 ? deflateRawSync(bytes) : bytes;
        const centralExtra = options.centralExtra ?? Buffer.alloc(0);
        const localExtra = options.localExtra ?? Buffer.alloc(0);
        const flags = options.flags ?? 0;
        let crc = 0xffffffff;
        for (const byte of bytes) {
            crc ^= byte;
            for (let bit = 0; bit < 8; bit++) { crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
        }
        crc = (crc ^ 0xffffffff) >>> 0;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
        local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26); local.writeUInt16LE(localExtra.length, 28);
        locals.push(local, filename, localExtra, compressed);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
        central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20);
        central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt16LE(centralExtra.length, 30);
        central.writeUInt32LE(((options.mode ?? 0) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
        directory.push(central, filename, centralExtra); offset += local.length + filename.length + localExtra.length + compressed.length;
    }
    const centralBytes = Buffer.concat(directory), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, centralBytes, end]);
}

function fixture(t) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'dt-final-artifact-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const put = (name, bytes) => {
        mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
        writeFileSync(path.join(root, name), bytes);
    };
    put('.gitignore', 'out/\n*.vsix\nsummary.json\n');
    put('package.json', JSON.stringify(manifest));
    put('package-lock.json', JSON.stringify({ name: manifest.name, version: manifest.version,
        lockfileVersion: 3, packages: { '': { name: manifest.name, version: manifest.version } } }));
    for (const [name, bytes] of content().filter(([name]) => name.startsWith('extension/') && !name.endsWith('package.json'))) {
        put(name.slice('extension/'.length), bytes);
    }
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q'); git('config', 'user.name', 'Artifact fixture'); git('config', 'user.email', 'fixture@example.invalid');
    git('add', '.'); git('commit', '-qm', 'Final release source fixture');
    const expected = { file: path.join(root, 'candidate.vsix'), version: '0.8.0', sourceCommit: git('rev-parse', 'HEAD'), runId: '123456', runAttempt: '2' };
    const pack = (entries = content()) => {
        const bytes = zip(entries); writeFileSync(expected.file, bytes); expected.sha256 = sha256(bytes);
        return { ...expected };
    };
    pack();
    return { root, put, git, expected, pack };
}

test('external verification binds real VSIX bytes to the clean source and complete runtime', t => {
    const f = fixture(t);
    const identity = verifyFinalArtifact(f.expected, { root: f.root });
    assert.deepEqual(identity, {
        fileName: 'candidate.vsix', version: '0.8.0', sha256: f.expected.sha256,
        size: readFileSync(f.expected.file).length, sourceCommit: f.expected.sourceCommit,
        runId: '123456', runAttempt: '2', entryHash: sha256(ENTRY)
    });
    assert.throws(() => verifyFinalArtifact({ ...f.expected, sha256: DIGEST }, { root: f.root }), /sha256|digest/i);
    assert.throws(() => verifyFinalArtifact({ ...f.expected, sourceCommit: COMMIT }, { root: f.root }), /commit|HEAD/i);
    assert.throws(() => verifyFinalArtifact({ ...f.expected, version: '0.8.1' }, { root: f.root }), /version/i);
    f.put('resources/icon.svg', '<svg>dirty</svg>');
    assert.throws(() => verifyFinalArtifact(f.expected, { root: f.root }), /clean|dirty|tracked/i);
});

test('final artifacts require matching JSON and VSIX XML identities even with a fresh-checkout verifier', t => {
    const f = fixture(t);
    const verify = () => verifyFinalArtifact(f.expected, { root: f.root, bindSource: false });
    assert.equal(verify().entryHash, sha256(ENTRY));
    const replacements = [
        ['extension/package.json', JSON.stringify({ ...manifest, publisher: 'other' })],
        ['extension/package.json', JSON.stringify({ ...manifest, name: 'other' })],
        ['extension/package.json', JSON.stringify({ ...manifest, main: './out/other.js' })],
        ['extension.vsixmanifest', xml('0.8.1')],
        ['extension.vsixmanifest', xml('0.8.0', 'other')],
        ['extension.vsixmanifest', xml('0.8.0', 'code-diff-tracker', 'other')],
        ['extension.vsixmanifest', '<!-- ' + xml() + ' -->'],
        ['extension.vsixmanifest', xml().replace('</Metadata>', '<Identity Id="other" Version="0.8.0" Publisher="lengmh" /></Metadata>')],
        ['extension.vsixmanifest', xml().replace('</Metadata>', '')]
    ];
    for (const [name, replacement] of replacements) {
        f.pack(content().map(([entry, bytes]) => [entry, entry === name ? replacement : bytes]));
        assert.throws(verify, `reject inconsistent ${name}: ${replacement}`);
    }
    f.pack(content().filter(([name]) => name !== 'extension.vsixmanifest'));
    assert.throws(verify, /manifest/i);
    f.pack();
    const internal = path.join(f.root, 'DO-NOT-PUBLISH-candidate.vsix');
    writeFileSync(internal, readFileSync(f.expected.file));
    assert.throws(() => verifyFinalArtifact({ ...f.expected, file: internal }, { bindSource: false }), /DO-NOT-PUBLISH/);
});

test('external verification rejects ambiguous and unsafe ZIP entries before trusting package contents', t => {
    const f = fixture(t);
    for (const name of [
        'extension/resources/icon.svg', '../escape', '/absolute', 'C:/absolute',
        'extension/../escape', 'extension/./alias', 'extension//alias',
        'extension\\escape', 'extension/resources/line\nbreak', 'extension/resources/null\0byte'
    ]) {
        f.pack([...content(), [name, 'untrusted']]);
        assert.throws(() => verifyFinalArtifact(f.expected, { bindSource: false }), `reject ZIP path ${JSON.stringify(name)}`);
    }
    f.pack([...content(), ['extension/out/extension.js', ENTRY]]);
    assert.throws(() => verifyFinalArtifact(f.expected, { bindSource: false }), /duplicate/i);
});

test('source binding rejects omitted, replaced, and extra runtime files, and inconsistent lock versions', t => {
    const f = fixture(t);
    for (const target of ['extension/out/nested/worker.js', 'extension/webview/panel.js', 'extension/resources/icon.svg']) {
        f.pack(content().filter(([name]) => name !== target));
        assert.throws(() => verifyFinalArtifact(f.expected, { root: f.root }), /file set/);
        f.pack(content().map(([name, bytes]) => [name, name === target ? 'replacement' : bytes]));
        assert.throws(() => verifyFinalArtifact(f.expected, { root: f.root }), /runtime bytes/);
    }
    for (const target of ['extension/out/unexpected.js', 'extension/webview/unexpected.js', 'extension/resources/unexpected.svg']) {
        f.pack([...content(), [target, 'unexpected']]);
        assert.throws(() => verifyFinalArtifact(f.expected, { root: f.root }), /file set/);
    }
    f.pack();
    f.put('out/extension.js.map', 'unshipped source map');
    assert.equal(verifyFinalArtifact(f.expected, { root: f.root }).entryHash, sha256(ENTRY));
    f.put('out/nested/worker.js', 'stale build');
    assert.throws(() => verifyFinalArtifact(f.expected, { root: f.root }), /runtime bytes/);
    f.put('out/nested/worker.js', 'exports.ready = true;\n');
    for (const name of ['package.json', 'package-lock.json']) {
        const original = readFileSync(path.join(f.root, name), 'utf8');
        const value = JSON.parse(original); value.version = '0.7.2';
        f.put(name, JSON.stringify(value)); f.git('add', name); f.git('commit', '-qm', 'Inconsistent source version');
        const expected = { ...f.expected, sourceCommit: f.git('rev-parse', 'HEAD') };
        assert.throws(() => verifyFinalArtifact(expected, { root: f.root }), /version/);
        f.put(name, original); f.git('add', name); f.git('commit', '-qm', 'Restore source version');
    }
    const lock = JSON.parse(readFileSync(path.join(f.root, 'package-lock.json'), 'utf8'));
    lock.packages[''].version = '0.7.2';
    f.put('package-lock.json', JSON.stringify(lock)); f.git('add', 'package-lock.json'); f.git('commit', '-qm', 'Stale lock root package');
    assert.throws(() => verifyFinalArtifact({ ...f.expected, sourceCommit: f.git('rev-parse', 'HEAD') }, { root: f.root }), /version/);
});

const RELEASE = JSON.parse(readFileSync(new URL('./released-0.7.2.json', import.meta.url), 'utf8'));
const PHASES = ['candidate-first-install', 'candidate-recording-reload', 'candidate-stopped-reload', 'released-prepare', 'candidate-upgrade'];
function finalSummary(identity) {
    const releasedEntryHash = '3'.repeat(64);
    return {
        mode: 'final-release-vsix', status: 'passed', artifact: { ...identity },
        release: { ...RELEASE, entryHash: releasedEntryHash },
        results: PHASES.map(phase => ({ phase, status: 'passed', productionActivation: true,
            version: phase === 'released-prepare' ? '0.7.2' : identity.version,
            entryHash: phase === 'released-prepare' ? releasedEntryHash : identity.entryHash }))
    };
}

test('release evidence proves this artifact and all five ordered installed-extension phases', t => {
    const f = fixture(t), identity = verifyFinalArtifact(f.expected, { root: f.root });
    const summary = finalSummary(identity);
    assert.doesNotThrow(() => verifyFinalEvidence(summary, identity));
    const mutate = edit => { const copy = structuredClone(summary); edit(copy); assert.throws(() => verifyFinalEvidence(copy, identity)); };
    mutate(value => { value.mode = 'internal-rc'; });
    mutate(value => { value.status = 'failed'; });
    mutate(value => { delete value.artifact; });
    for (const field of ['fileName', 'version', 'sha256', 'sourceCommit', 'runId', 'runAttempt', 'entryHash', 'size']) {
        mutate(value => { value.artifact[field] = typeof value.artifact[field] === 'number' ? 999 : 'wrong'; });
        mutate(value => { delete value.artifact[field]; });
    }
    mutate(value => { value.results.pop(); });
    mutate(value => { value.results.push(value.results[0]); });
    mutate(value => { value.results[1] = value.results[0]; });
    mutate(value => { [value.results[0], value.results[1]] = [value.results[1], value.results[0]]; });
    for (let index = 0; index < PHASES.length; index++) {
        mutate(value => { value.results[index].status = 'failed'; });
        mutate(value => { value.results[index].version = '0.7.1'; });
        mutate(value => { value.results[index].entryHash = '4'.repeat(64); });
        mutate(value => { value.results[index].productionActivation = false; });
    }
    mutate(value => { delete value.release; });
    mutate(value => { value.release.sha256 = '4'.repeat(64); });
    mutate(value => { value.release.commit = COMMIT; });
    mutate(value => { value.release.assetId++; });
    // Replacing bytes and recomputing a report's own checksum cannot change the
    // independently supplied artifact identity that authorizes publication.
    f.pack(content().map(([name, bytes]) => [name, name.endsWith('out/extension.js') ? 'replacement runtime' : bytes]));
    const replacement = verifyFinalArtifact(f.expected, { bindSource: false });
    assert.throws(() => verifyFinalEvidence(finalSummary(replacement), identity));
});

test('publish CLI validates evidence, checkout HEAD and versions without rebuilding or needing out', t => {
    const f = fixture(t);
    for (const name of ['final-artifact.mjs', 'artifact-common.mjs', 'released-0.7.2.json']) {
        f.put(`test/installed/${name}`, readFileSync(new URL(name, import.meta.url)));
    }
    f.git('add', 'test'); f.git('commit', '-qm', 'Install verifier fixture');
    f.expected.sourceCommit = f.git('rev-parse', 'HEAD');
    const identity = verifyFinalArtifact(f.expected, { root: f.root });
    f.put('summary.json', JSON.stringify(finalSummary(identity)));
    rmSync(path.join(f.root, 'out'), { recursive: true });
    const cliArgs = () => [path.join(f.root, 'test/installed/final-artifact.mjs'), path.join(f.root, 'summary.json'),
        f.expected.file, f.expected.version, f.expected.sha256, f.expected.sourceCommit, f.expected.runId, f.expected.runAttempt];
    const run = (input = cliArgs()) => execFileSync(process.execPath, input,
        { cwd: f.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.match(run(), /PASS.*final.*artifact/i);
    assert.throws(() => run(cliArgs().slice(0, -1)));
    const wrongCommit = cliArgs(); wrongCommit[5] = COMMIT;
    assert.throws(() => run(wrongCommit), /HEAD|commit/i);
    const wrongRun = cliArgs(); wrongRun[6] = '987654';
    assert.throws(() => run(wrongRun), /identity/i);
    const badSummary = finalSummary(identity); badSummary.results[2].status = 'failed';
    f.put('summary.json', JSON.stringify(badSummary));
    assert.throws(() => run(), /must pass/);
    f.put('summary.json', JSON.stringify(finalSummary(identity)));
    f.put('package-lock.json', '{}');
    assert.throws(() => run(), /clean|tracked/);
    f.git('add', 'package-lock.json'); f.git('commit', '-qm', 'Corrupt root lock');
    f.expected.sourceCommit = f.git('rev-parse', 'HEAD');
    assert.throws(() => run(), /version/);
});


test('real deflated ZIP entries verify while symlinks and file/directory aliases cannot ship', t => {
    const f = fixture(t);
    f.pack(content().map(([name, bytes]) => [name, bytes, { deflate: true }]));
    assert.equal(verifyFinalArtifact(f.expected, { root: f.root }).entryHash, sha256(ENTRY));
    f.pack([...content(), ['extension/resources/link', '../out/extension.js', { mode: 0o120777 }]]);
    assert.throws(() => verifyFinalArtifact(f.expected, { bindSource: false }), /file type/);
    f.pack([...content(), ['extension/resources', 'a file over an existing directory']]);
    assert.throws(() => verifyFinalArtifact(f.expected, { bindSource: false }), /conflict/);
    const corrupt = zip(content());
    corrupt[30] ^= 1; // The local name no longer matches its central-directory name.
    writeFileSync(f.expected.file, corrupt); f.expected.sha256 = sha256(corrupt);
    assert.throws(() => verifyFinalArtifact(f.expected, { bindSource: false }), /filename disagrees/);
});


function extraField(id, data) {
    const header = Buffer.alloc(4);
    header.writeUInt16LE(id); header.writeUInt16LE(data.length, 2);
    return Buffer.concat([header, data]);
}

function unicodePathExtra(originalName, decodedName) {
    const name = Buffer.from(originalName), payload = Buffer.alloc(5);
    let crc = 0xffffffff;
    for (const byte of name) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) { crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    }
    payload[0] = 1; payload.writeUInt32LE((crc ^ 0xffffffff) >>> 0, 1);
    return extraField(0x7075, Buffer.concat([payload, Buffer.from(decodedName)]));
}

test('source-bound verification rejects Unicode-path aliases that replace a validated webview at installation', t => {
    const f = fixture(t), alias = 'extension/innocent.txt';
    // Info-ZIP Unicode Path is an installation-time filename override. Yauzl
    // decodes this as a second panel.js despite the harmless central name.
    f.pack([...content(), [alias, 'window.injected = true;\n', {
        centralExtra: unicodePathExtra(alias, 'extension/webview/panel.js')
    }]]);
    assert.throws(() => verifyFinalArtifact(f.expected, { root: f.root }), /extra field/);
});

test('both ZIP headers reject Unicode Path, ZIP64 and unknown extra fields', t => {
    const f = fixture(t), name = 'extension/innocent.txt';
    const extras = [
        unicodePathExtra(name, 'extension/webview/panel.js'),
        extraField(0x0001, Buffer.alloc(16)),
        extraField(0xffff, Buffer.from('unknown'))
    ];
    for (const field of ['localExtra', 'centralExtra']) {
        for (const extra of extras) {
            f.pack([...content(), [name, 'untrusted', { [field]: extra }]]);
            assert.throws(() => verifyFinalArtifact(f.expected, { bindSource: false }), /extra field/,
                `${field} must fail closed for id ${extra.readUInt16LE(0).toString(16)}`);
        }
    }
});

test('non-ASCII ZIP names require explicit UTF-8 encoding and retain valid UTF-8 source names', t => {
    const f = fixture(t), name = 'extension/resources/图.svg';
    f.put('resources/图.svg', '<svg>UTF-8</svg>');
    f.git('add', 'resources'); f.git('commit', '-qm', 'UTF-8 resource');
    f.expected.sourceCommit = f.git('rev-parse', 'HEAD');
    f.pack([...content(), [name, '<svg>UTF-8</svg>', { flags: 0x0800 }]]);
    assert.equal(verifyFinalArtifact(f.expected, { root: f.root }).entryHash, sha256(ENTRY));
    // These same bytes are CP437 to the installer when the UTF-8 flag is clear.
    f.pack([...content(), [name, '<svg>UTF-8</svg>']]);
    assert.throws(() => verifyFinalArtifact(f.expected, { root: f.root }), /UTF-8/);
});

test('UTF-8 filename decoding cannot strip a BOM and invent the required extension entry', t => {
    const f = fixture(t);
    f.pack(content().map(([name, bytes]) => [name === 'extension/out/extension.js' ? `\ufeff${name}` : name,
        bytes, { flags: 0x0800 }]));
    assert.throws(() => verifyFinalArtifact(f.expected, { root: f.root }), /required VSIX entry is missing/);
});
