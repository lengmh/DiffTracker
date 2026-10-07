// Shared package primitives for internal and final-artifact acceptance.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const ID = 'lengmh.code-diff-tracker';
export const RELEASE = JSON.parse(readFileSync(new URL('./released-0.7.2.json', import.meta.url), 'utf8'));
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const zipRead = (file, entry) => execFileSync('unzip', ['-p', file, entry], { maxBuffer: 32 * 1024 * 1024 });

export function verifyVsix(file, version) {
    const manifest = JSON.parse(zipRead(file, 'extension/package.json'));
    assert.equal(`${manifest.publisher}.${manifest.name}`, ID);
    assert.equal(manifest.version, version);
    const listing = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }).trim().split('\n');
    assert.ok(listing.includes('extension/out/extension.js'));
    assert.ok(!listing.some(item => item.startsWith('extension/test/')), 'test driver must never ship');
    assert.ok(!listing.some(item => item.startsWith('extension/src/')), 'runtime must use compiled package');
    return { manifest, entryHash: hash(zipRead(file, 'extension/out/extension.js')) };
}
