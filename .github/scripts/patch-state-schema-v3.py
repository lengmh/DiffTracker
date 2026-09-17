from pathlib import Path
import subprocess

source = Path('src/diffTracker.ts')
assert subprocess.check_output(['git', 'hash-object', str(source)], text=True).strip() == '7a8d47798a46cc56e64bd04e1891d5d94968571f', 'Production source moved; re-review required'
s = source.read_text(encoding='utf-8')
assert s.count('version: 2') == 3, 'Expected interface, writer and normalized parser version'
s = s.replace('version: 2', 'version: 3')
old = '(candidate.version !== 1 && candidate.version !== 2)'
assert s.count(old) == 1
s = s.replace(old, '(candidate.version !== 1 && candidate.version !== 2 && candidate.version !== 3)', 1)
old = 'const rawOpaque = candidate.version === 1 ? [] : (candidate.opaqueBaselineFiles ?? []);'
new = '''// V1/V2 sessions remain readable, including development V2 states that
        // already contain opaque entries. V3 requires the field so corruption
        // cannot silently erase the only before-image for unsupported files.
        const rawOpaque = candidate.version === 1 ? [] : candidate.version === 2
            ? (candidate.opaqueBaselineFiles ?? []) : candidate.opaqueBaselineFiles;'''
assert s.count(old) == 1
s = s.replace(old, new, 1)
old = 'scanCoverage: candidate.version === 2 ? candidate.scanCoverage as string | undefined : undefined,'
assert s.count(old) == 1
s = s.replace(old, 'scanCoverage: candidate.version !== 1 ? candidate.scanCoverage as string | undefined : undefined,', 1)
source.write_text(s, encoding='utf-8')

harness = Path('test/tracker-safety.mjs')
t = harness.read_text(encoding='utf-8')
# Change only output-schema assertions. All V1/V2 input fixtures remain intact.
for old, new in [
    ('assert.equal(saved.version,2)', 'assert.equal(saved.version,3)'),
    ('assert.equal(valid.version,2)', 'assert.equal(valid.version,3)'),
    ("assert.equal(JSON.parse(fs.readFileSync(path.join(storage,'session-state.json'),'utf8')).version,2)",
     "assert.equal(JSON.parse(fs.readFileSync(path.join(storage,'session-state.json'),'utf8')).version,3)"),
    ('the next durable write is strict V2', 'the next durable write is strict V3')
]:
    assert t.count(old) == 1, f'Expected one output assertion: {old}'
    t = t.replace(old, new, 1)
anchor = "import assert from 'node:assert/strict';"
assert t.count(anchor) == 1
t = t.replace(anchor, "import { registerStateSchemaCompatibility } from './state-schema-compatibility.mjs';\n" + anchor, 1)
anchor = 'if(process.env.DT_TEST_FILTER)'
assert t.count(anchor) == 1
t = t.replace(anchor, '''registerStateSchemaCompatibility({
    test, root, Uri, DiffTracker, faults, file, pending,
    getTracker: () => tracker,
    setTracker: value => { tracker = value; },
    setListedFiles: value => { listedFiles = value; }
});

''' + anchor, 1)
harness.write_text(t, encoding='utf-8')

changelog = Path('CHANGELOG.md')
c = changelog.read_text(encoding='utf-8')
c = c.replace('## 0.7.2\n', '''## 0.7.2

- Write session schema V3 for opaque baselines while migrating V1/V2 sessions. Older releases reject V3 rather than silently drop unsupported-file identities during downgrade.
''', 1)
changelog.write_text(c, encoding='utf-8')
