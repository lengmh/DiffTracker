from pathlib import Path

p = Path('.github/scripts/apply-opaque-baseline-v2.py')
s = p.read_text(encoding='utf-8')
old = '''once(
    "        if (state.kind === 'unavailable') {\\n            this.markFileUnavailable(filePath, state.reason);",
    "        if (this.reconcileOpaqueBaseline(filePath, state)) {\\n            return;\\n        }\\n        if (state.kind === 'unavailable') {\\n            this.markFileUnavailable(filePath, state.reason);",
    'read update opaque reconciliation',
)'''
new = '''read_sig = '    private async readFileAndUpdate(filePath: string, uri: vscode.Uri): Promise<void> '
starts = [i for i in range(len(s)) if s.startswith(read_sig, i)]
assert len(starts) == 1, 'readFileAndUpdate signature'
rstart = starts[0]
rend = s.index('    private updateTrackedDiff(', rstart)
rblock = s[rstart:rend]
old_read = "        if (state.kind === 'unavailable') {\\n            this.markFileUnavailable(filePath, state.reason);"
new_read = "        if (this.reconcileOpaqueBaseline(filePath, state)) {\\n            return;\\n        }\\n        if (state.kind === 'unavailable') {\\n            this.markFileUnavailable(filePath, state.reason);"
assert rblock.count(old_read) == 1, f'read update target count={rblock.count(old_read)}'
rblock = rblock.replace(old_read, new_read, 1)
s = s[:rstart] + rblock + s[rend:]'''
assert s.count(old) == 1, f'meta target count={s.count(old)}'
p.write_text(s.replace(old, new, 1), encoding='utf-8')
