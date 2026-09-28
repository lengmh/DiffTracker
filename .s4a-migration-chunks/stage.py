import base64
import gzip
import hashlib
import os
from pathlib import Path
import subprocess

BASE = '83b9c862e4c22c440647b25dd54b903d78dad23d'
PATCH_SHA256 = 'c086a21645d3ed3279f6e3f23210420a00de8bea47f13952364aaca369c9a78e'
EXPECTED = {
    'docs/pr12-migration-boundary-postmortem-2026-09-28.md': '8aeb2e4d951592953c213a4b2c25e1aa3e655622',
    'src/diffTracker.ts': 'cd503accb048ee0d4895cab4b336ffed0fb44937',
    'test/pr12-bounded-invariants.mjs': '55ce375c6d907fbb06007ab7e85b4a0c4591d983',
}

def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()

encoded = ''.join(Path('.s4a-migration-chunks', f'part-{i}').read_text() for i in range(1, 5))
patch = gzip.decompress(base64.b64decode(encoded, validate=True))
assert hashlib.sha256(patch).hexdigest() == PATCH_SHA256, 'Authored patch checksum differs'
patch_file = Path(os.environ['RUNNER_TEMP']) / 'migration-repair.patch'
patch_file.write_bytes(patch)
git('config', 'core.autocrlf', 'false')
git('fetch', '--no-tags', '--depth=1', 'origin', BASE)
git('checkout', '--detach', BASE)
assert git('rev-parse', 'HEAD') == BASE
Path(os.environ['RUNNER_TEMP'], 'migration-original.ts').write_bytes(Path('src/diffTracker.ts').read_bytes())
git('apply', '--check', str(patch_file))
git('apply', str(patch_file))
git('diff', '--check')
for path, expected in EXPECTED.items():
    actual = git('hash-object', path)
    assert actual == expected, f'{path}: {actual} != {expected}'
git('add', *EXPECTED.keys())
assert git('diff', '--cached', '--name-only').splitlines() == sorted(EXPECTED)
print(git('diff', '--cached', '--stat'))
print('Verified source tree:', git('write-tree'))
