from pathlib import Path
import subprocess

harness = Path('test/tracker-safety.mjs')
matrix = Path('test/state-schema-compatibility.mjs')
for target, expected in [(harness, '1f0e90291aad14edbc97c4d0bde762a8e74cc6dc'), (matrix, '8bb2ee892b835c18983f4f7fe3bd24c5784cf5b1')]:
    actual = subprocess.check_output(['git', 'rev-parse', f'HEAD:{target.as_posix()}'], text=True).strip()
    assert actual == expected, f'{target}: tests changed; re-review required'

h = harness.read_text(encoding='utf-8')
old = "size:fault(uri.fsPath,'size')??stat.size,mtime:stat.mtimeMs"
new = "size:fault(uri.fsPath,'size')??stat.size,mtime:fault(uri.fsPath,'mtime')??stat.mtimeMs"
assert h.count(old) == 1
harness.write_text(h.replace(old, new, 1), encoding='utf-8')

t = matrix.read_text(encoding='utf-8')
start = t.index("            assert.ok(fs.statSync(target).mtimeMs < 0);")
end = t.index("        });\n    }\n\n    for (const failAt", start)
body = t[start:end]
old = "            assert.ok(fs.statSync(target).mtimeMs < 0);\n"
assert body.count(old) == 1
body = body.replace(old, "            assert.ok((await tracker.readFileSnapshot(Uri.file(target))).mtime < 0,\n                'the production reader must observe a valid negative provider timestamp');\n", 1)
replacement = '''            // Some hosts do not expose a pre-epoch mtime through Node's local
            // filesystem boundary. Keep the production scan/persistence/restore
            // assertions: supply that valid metadata at the already-mocked VS Code
            // provider boundary instead of skipping the test or changing bytes.
            if (!(fs.statSync(target).mtimeMs < 0)) {
                faults.set(target, { mtime: stamp.getTime() });
            }
            try {
''' + ''.join('    ' + line if line.strip() else line for line in body.splitlines(keepends=True)) + '''            } finally {
                faults.delete(target);
            }
'''
matrix.write_text(t[:start] + replacement + t[end:], encoding='utf-8')

doc = Path('docs/opaque-baseline-invariants.md')
d = doc.read_text(encoding='utf-8')
old = '''adds nine cases for valid pre-epoch timestamps, invalid metadata, and actual
pre-1970 files through workspace/repository scanning and restore.'''
new = '''adds nine cases for valid pre-epoch timestamps, invalid metadata, and
pre-1970 timestamps through workspace/repository scanning and restore. The fixture
uses actual filesystem timestamps when the host exposes them; otherwise it
supplies negative mtime metadata at the existing mocked VS Code provider boundary.
Both paths exercise the production reader, scanner, persistence and restore with
real file bytes; neither path skips or weakens the negative-timestamp assertions.'''
assert d.count(old) == 1
doc.write_text(d.replace(old, new, 1), encoding='utf-8')
