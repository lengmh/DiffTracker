// Verify the exact final VSIX. This module never builds, packages, or rewrites it.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { ROOT, ID, RELEASE, hash } from './artifact-common.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseFinalArtifactArgs(args) {
    assert.ok(Array.isArray(args) && args.length === 6,
        'required arguments: <file> <version> <sha256> <sourceCommit> <runId> <runAttempt>');
    assert.ok(args.every(value => typeof value === 'string' && value.length > 0), 'every identity argument is mandatory');
    const [file, version, sha256, sourceCommit, runId, runAttempt] = args;
    assert.ok(file.trim() === file && !/[\x00-\x1f\x7f]/.test(file), 'invalid artifact path');
    const semver = SEMVER.exec(version);
    assert.ok(semver, 'version must be canonical SemVer');
    const [major, minor, patch] = semver.slice(1, 4).map(BigInt);
    assert.ok(major > 0n || minor > 7n || (minor === 7n && patch > 2n),
        'final version must be newer than official 0.7.2');
    assert.match(sha256, SHA256, 'sha256 must be 64 lowercase hexadecimal digits');
    assert.match(sourceCommit, COMMIT, 'sourceCommit must be a full lowercase Git SHA');
    assert.match(runId, POSITIVE_INTEGER, 'runId must be a positive canonical integer');
    assert.match(runAttempt, POSITIVE_INTEGER, 'runAttempt must be a positive canonical integer');
    return { file: path.resolve(file), version, sha256, sourceCommit, runId, runAttempt };
}

// Read one immutable byte snapshot, so the digest and inspected entries cannot
// accidentally describe two files. ZIP64, encryption, and links are unnecessary
// for this extension and fail closed. Both central and local names must agree.
function readZip(bytes) {
    let end = -1;
    for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65557); index--) {
        if (bytes.readUInt32LE(index) === 0x06054b50 && index + 22 + bytes.readUInt16LE(index + 20) === bytes.length) {
            end = index; break;
        }
    }
    assert.ok(end >= 0, 'ZIP end record is missing');
    assert.equal(bytes.readUInt16LE(end + 4), 0, 'multi-disk ZIP is unsupported');
    assert.equal(bytes.readUInt16LE(end + 6), 0, 'multi-disk ZIP is unsupported');
    const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12);
    const start = bytes.readUInt32LE(end + 16);
    assert.equal(bytes.readUInt16LE(end + 8), count, 'ZIP entry counts must agree');
    assert.ok(count < 65535 && start + size === end, 'invalid or ZIP64 central directory');
    const entries = new Map(), localOffsets = new Set();
    let cursor = start, total = 0;
    for (let index = 0; index < count; index++) {
        assert.ok(cursor + 46 <= end && bytes.readUInt32LE(cursor) === 0x02014b50, 'invalid ZIP directory entry');
        const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10);
        const crc = bytes.readUInt32LE(cursor + 16), compressed = bytes.readUInt32LE(cursor + 20);
        const length = bytes.readUInt32LE(cursor + 24), nameLength = bytes.readUInt16LE(cursor + 28);
        const extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32);
        const offset = bytes.readUInt32LE(cursor + 42), mode = bytes.readUInt32LE(cursor + 38) >>> 16;
        assert.ok(cursor + 46 + nameLength + extraLength + commentLength <= end, 'truncated ZIP directory entry');
        // Final vsce packages have no extra fields. Refuse alternate filename
        // or size interpretations (Unicode Path, ZIP64, and unknown variants).
        assert.equal(extraLength, 0, 'ZIP central extra fields are unsupported');
        assert.equal(bytes.readUInt16LE(cursor + 34), 0, 'multi-disk ZIP entry is unsupported');
        assert.equal(flags & ~0x080e, 0, 'unsupported ZIP flags or encryption');
        assert.ok(method === 0 || method === 8, 'unsupported ZIP compression');
        const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
        assert.ok((flags & 0x0800) || rawName.every(byte => byte < 0x80),
            'non-ASCII ZIP filenames require the UTF-8 flag');
        // Preserve a leading BOM as part of the filename, as the installer
        // does; text decoding must not manufacture a different package path.
        const name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(rawName);
        const parts = name.replace(/\/$/, '').split('/');
        assert.ok(name && !/[\\\x00-\x1f\x7f:]/.test(name) &&
            parts.every(part => part && part !== '.' && part !== '..'), `unsafe ZIP entry: ${JSON.stringify(name)}`);
        assert.ok(!entries.has(name), `duplicate ZIP entry: ${name}`);
        assert.ok(!localOffsets.has(offset), 'duplicate ZIP local record');
        localOffsets.add(offset);
        const kind = mode & 0o170000;
        assert.ok(kind === 0 || kind === (name.endsWith('/') ? 0o040000 : 0o100000), `unsafe ZIP file type: ${name}`);
        assert.ok(offset + 30 <= start && bytes.readUInt32LE(offset) === 0x04034b50, 'invalid ZIP local record');
        assert.equal(bytes.readUInt16LE(offset + 6), flags, 'ZIP local flags disagree');
        assert.equal(bytes.readUInt16LE(offset + 8), method, 'ZIP local compression disagrees');
        const localNameLength = bytes.readUInt16LE(offset + 26), localExtraLength = bytes.readUInt16LE(offset + 28);
        assert.equal(localExtraLength, 0, 'ZIP local extra fields are unsupported');
        assert.deepEqual(bytes.subarray(offset + 30, offset + 30 + localNameLength), rawName, 'ZIP local filename disagrees');
        const dataOffset = offset + 30 + localNameLength + localExtraLength;
        assert.ok(dataOffset + compressed <= start, 'ZIP data overlaps central directory');
        total += length;
        assert.ok(length <= 64 * 1024 * 1024 && total <= 256 * 1024 * 1024, 'ZIP runtime exceeds verification size limit');
        const data = bytes.subarray(dataOffset, dataOffset + compressed);
        const contents = method === 0 ? data : inflateRawSync(data, { maxOutputLength: 64 * 1024 * 1024 });
        assert.equal(contents.length, length, 'ZIP uncompressed size mismatch');
        assert.equal(crc32(contents), crc, 'ZIP content checksum mismatch');
        entries.set(name, contents);
        cursor += 46 + nameLength + extraLength + commentLength;
    }
    assert.equal(cursor, end, 'ZIP directory length mismatch');
    for (const name of entries.keys()) {
        const parts = name.replace(/\/$/, '').split('/');
        for (let index = 1; index < parts.length; index++) {
            assert.ok(!entries.has(parts.slice(0, index).join('/')), `ZIP file/directory conflict: ${name}`);
        }
        if (name.endsWith('/')) { assert.ok(!entries.has(name.slice(0, -1)), `ZIP file/directory conflict: ${name}`); }
    }
    return entries;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
    for (let bit = 0; bit < 8; bit++) { value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); }
    return value >>> 0;
});
function crc32(bytes) {
    let value = 0xffffffff;
    for (const byte of bytes) { value = CRC_TABLE[(value ^ byte) & 255] ^ (value >>> 8); }
    return (value ^ 0xffffffff) >>> 0;
}

// The generated VSIX manifest uses a deliberately small XML vocabulary. Parse
// structure rather than matching an Identity hidden in comments or broken XML;
// declarations, external entities, and namespace rebinding are not accepted.
function verifyXmlIdentity(bytes, version) {
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const stack = [];
    let cursor = 0, roots = 0, identity;
    while (cursor < xml.length) {
        if (xml[cursor] !== '<') {
            const end = xml.indexOf('<', cursor);
            const text = xml.slice(cursor, end < 0 ? xml.length : end);
            assert.ok(stack.length || !text.trim(), 'VSIX manifest text outside root');
            cursor += text.length;
            continue;
        }
        if (xml.startsWith('<!--', cursor)) {
            const end = xml.indexOf('-->', cursor + 4);
            assert.ok(end >= 0 && !xml.slice(cursor + 4, end).includes('--'), 'invalid XML comment');
            cursor = end + 3; continue;
        }
        if (xml.startsWith('<?xml ', cursor)) {
            const end = xml.indexOf('?>', cursor);
            assert.ok(cursor === 0 && end > 0, 'invalid XML declaration');
            cursor = end + 2; continue;
        }
        const tag = /^<(\/?)([A-Za-z_][A-Za-z0-9_.:-]*)((?:[^<>"']|"[^"<]*"|'[^'<]*')*)>/.exec(xml.slice(cursor));
        assert.ok(tag, 'invalid or unsupported VSIX manifest XML');
        const [, closing, name, tail] = tag;
        cursor += tag[0].length;
        if (closing) {
            assert.ok(!tail.trim() && stack.pop() === name, 'unbalanced VSIX manifest XML');
            continue;
        }
        const selfClosing = /\/\s*$/.test(tail);
        let rest = selfClosing ? tail.replace(/\/\s*$/, '') : tail;
        const attributes = {};
        while (rest.trim()) {
            const attribute = /^\s+([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/.exec(rest);
            assert.ok(attribute && !Object.hasOwn(attributes, attribute[1]), 'invalid or duplicate XML attribute');
            attributes[attribute[1]] = attribute[2] ?? attribute[3];
            rest = rest.slice(attribute[0].length);
        }
        assert.ok(!name.includes(':'), 'prefixed VSIX elements are not supported');
        if (stack.length === 0) {
            assert.equal(++roots, 1, 'VSIX manifest must have one root');
            assert.equal(name, 'PackageManifest', 'VSIX manifest root');
            assert.equal(attributes.xmlns, 'http://schemas.microsoft.com/developer/vsx-schema/2011', 'VSIX manifest namespace');
        } else {
            assert.ok(!Object.keys(attributes).some(key => key === 'xmlns' || key.startsWith('xmlns:')),
                'VSIX manifest must not rebind namespaces');
        }
        if (name === 'Identity') {
            assert.equal(identity, undefined, 'VSIX manifest must have exactly one Identity');
            assert.deepEqual(stack, ['PackageManifest', 'Metadata'], 'VSIX Identity must be in Metadata');
            identity = attributes;
        }
        if (!selfClosing) { stack.push(name); }
    }
    assert.equal(stack.length, 0, 'unclosed VSIX manifest XML');
    assert.ok(identity, 'VSIX manifest Identity is required');
    assert.equal(`${identity.Publisher}.${identity.Id}`, ID, 'VSIX XML extension identity');
    assert.equal(identity.Version, version, 'VSIX XML version');
}

function verifyCheckout(expected, root) {
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    assert.equal(git('rev-parse', 'HEAD'), expected.sourceCommit, 'checkout HEAD must match sourceCommit');
    assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'tracked source must be clean');
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    assert.equal(manifest.version, expected.version, 'source package version');
    assert.equal(lock.version, expected.version, 'root lock version');
    assert.equal(lock.packages?.['']?.version, expected.version, 'root lock package version');
    return manifest;
}

function runtimeFiles(root, directory, javascriptOnly = false) {
    const files = new Map();
    const visit = relative => {
        for (const item of readdirSync(path.join(root, relative), { withFileTypes: true })) {
            const name = `${relative}/${item.name}`;
            assert.ok(!item.isSymbolicLink(), `runtime symlinks are not allowed: ${name}`);
            if (item.isDirectory()) { visit(name); }
            else if (!name.endsWith('.map') && (!javascriptOnly || name.endsWith('.js'))) {
                assert.ok(item.isFile(), `runtime entry must be a regular file: ${name}`);
                files.set(`extension/${name}`, readFileSync(path.join(root, name)));
            }
        }
    };
    visit(directory);
    return files;
}

export function verifyFinalArtifact(input, { root = ROOT, bindSource = true } = {}) {
    const expected = parseFinalArtifactArgs(['file', 'version', 'sha256', 'sourceCommit', 'runId', 'runAttempt'].map(key => input[key]));
    assert.ok(!/DO-NOT-PUBLISH/i.test(expected.file), 'internal DO-NOT-PUBLISH paths are not final artifacts');
    const bytes = readFileSync(expected.file);
    assert.equal(hash(bytes), expected.sha256, 'VSIX sha256 must match the independently supplied digest');
    const archive = readZip(bytes);
    const required = name => {
        assert.ok(archive.has(name), `required VSIX entry is missing: ${name}`);
        return archive.get(name);
    };
    const packageJson = JSON.parse(required('extension/package.json'));
    assert.equal(packageJson.version, expected.version, 'packaged version must match final version');
    assert.equal(`${packageJson.publisher}.${packageJson.name}`, ID, 'packaged extension identity');
    assert.equal(packageJson.main, './out/extension.js', 'packaged main must be the production entry');
    verifyXmlIdentity(required('extension.vsixmanifest'), expected.version);
    const entryHash = hash(required('extension/out/extension.js'));
    const entries = [...archive.keys()];
    assert.ok(!entries.some(name => name.startsWith('extension/test/')), 'test driver must never ship');
    assert.ok(!entries.some(name => name.startsWith('extension/src/')), 'runtime must use compiled package');
    if (bindSource) {
        const source = verifyCheckout(expected, root);
        assert.deepEqual(packageJson, source, 'packaged package.json must match source semantically');
        for (const [directory, javascriptOnly] of [['out', true], ['webview', false], ['resources', false]]) {
            const files = runtimeFiles(root, directory, javascriptOnly);
            const shipped = entries.filter(name => name.startsWith(`extension/${directory}/`) && !name.endsWith('/') &&
                !name.endsWith('.map') && (!javascriptOnly || name.endsWith('.js'))).sort();
            assert.deepEqual(shipped, [...files.keys()].sort(), `complete ${directory} file set must match source`);
            for (const [name, contents] of files) {
                assert.deepEqual(archive.get(name), contents, `packaged runtime bytes differ: ${name}`);
            }
        }
    }
    return { fileName: path.basename(expected.file), version: expected.version, sha256: expected.sha256,
        size: bytes.length, sourceCommit: expected.sourceCommit, runId: expected.runId,
        runAttempt: expected.runAttempt, entryHash };
}
export function verifyFinalEvidence(summary, expected) {
    assert.ok(expected && typeof expected === 'object', 'independent artifact identity is required');
    parseFinalArtifactArgs([expected.fileName, expected.version, expected.sha256, expected.sourceCommit,
        expected.runId, expected.runAttempt]);
    assert.equal(path.basename(expected.fileName), expected.fileName, 'artifact fileName must be a basename');
    assert.ok(!/DO-NOT-PUBLISH/i.test(expected.fileName), 'internal artifacts cannot authorize publishing');
    assert.ok(Number.isSafeInteger(expected.size) && expected.size > 0, 'artifact size must be a positive integer');
    assert.match(expected.entryHash, SHA256, 'artifact entryHash must be a SHA256');
    assert.equal(summary?.mode, 'final-release-vsix', 'only final-release-vsix evidence can authorize publishing');
    assert.equal(summary.status, 'passed', 'installed verification must pass');
    assert.deepEqual(summary.artifact, expected, 'evidence must match the independently verified artifact identity');
    assert.ok(summary.release && typeof summary.release === 'object', 'official release pin is required');
    assert.match(summary.release.entryHash, SHA256, 'released entryHash must be a SHA256');
    assert.deepEqual(summary.release, { ...RELEASE, entryHash: summary.release.entryHash }, 'official 0.7.2 release pin must match');
    const phases = ['candidate-first-install', 'candidate-recording-reload', 'candidate-stopped-reload',
        'released-prepare', 'candidate-upgrade'];
    assert.ok(Array.isArray(summary.results), 'installed phase results are required');
    assert.deepEqual(summary.results.map(result => result.phase), phases, 'exactly five ordered installed phases are required');
    for (const result of summary.results) {
        const released = result.phase === 'released-prepare';
        assert.equal(result.status, 'passed', `${result.phase} must pass`);
        assert.equal(result.productionActivation, true, `${result.phase} must activate the installed production extension`);
        assert.equal(result.version, released ? '0.7.2' : expected.version, `${result.phase} installed version`);
        assert.equal(result.entryHash, released ? summary.release.entryHash : expected.entryHash,
            `${result.phase} installed entry hash`);
    }
    return expected;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    assert.equal(process.argv.length, 9,
        'usage: node test/installed/final-artifact.mjs <summary> <file> <version> <sha256> <sourceCommit> <runId> <runAttempt>');
    const expected = parseFinalArtifactArgs(process.argv.slice(3));
    // Publish jobs have a fresh checkout, not the candidate job's node_modules
    // or compiled output. Validate its immutable source identity independently.
    verifyCheckout(expected, ROOT);
    const artifact = verifyFinalArtifact(expected, { bindSource: false });
    const summary = JSON.parse(readFileSync(path.resolve(process.argv[2]), 'utf8'));
    verifyFinalEvidence(summary, artifact);
    console.log(`PASS final artifact: ${artifact.fileName} sha256:${artifact.sha256}`);
}
