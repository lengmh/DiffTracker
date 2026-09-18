import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const source = fs.readFileSync(path.join(root, 'src', 'nativeReviewPoc.ts'), 'utf8');

const commands = new Set(pkg.contributes.commands.map(command => command.command));
for (const command of [
    'diffTracker.nativeReviewPoc.openChanges',
    'diffTracker.nativeReviewPoc.keepChange',
    'diffTracker.nativeReviewPoc.revertChange',
    'diffTracker.nativeReviewPoc.keepSelectedBlock',
    'diffTracker.nativeReviewPoc.revertSelectedBlock',
    'diffTracker.nativeReviewPoc.probeSelection'
]) {
    assert.ok(commands.has(command), `missing native-review PoC command: ${command}`);
}

const quickDiffMenus = pkg.contributes.menus['scm/change/title'] ?? [];
assert.ok(quickDiffMenus.some(item =>
    item.command === 'diffTracker.nativeReviewPoc.keepChange' &&
    item.when === 'originalResourceScheme == diff-tracker-original'
));
assert.ok(quickDiffMenus.some(item =>
    item.command === 'diffTracker.nativeReviewPoc.revertChange' &&
    item.when === 'originalResourceScheme == diff-tracker-original'
));

const editorMenus = pkg.contributes.menus['editor/context'] ?? [];
assert.ok(editorMenus.some(item =>
    item.command === 'diffTracker.nativeReviewPoc.keepSelectedBlock' &&
    item.when.includes('isInDiffEditor') &&
    item.when.includes('editorHasSelection') &&
    item.when.includes('resourceScheme == file')
));

assert.equal(pkg.enabledApiProposals, undefined, 'PoC must remain Marketplace-compatible and avoid proposed APIs');
assert.equal(pkg.contributes.menus['diffEditor/gutter/hunk'], undefined);
assert.equal(pkg.contributes.menus['diffEditor/gutter/selection'], undefined);

for (const marker of [
    "vscode.scm.createSourceControl(",
    "this.sourceControl.quickDiffProvider = this",
    "'vscode.changes'",
    "'vscode.diff'",
    "vscode.window.activeTextEditor",
    "line-granular Keep/Revert requires a backend line-action API"
]) {
    assert.ok(source.includes(marker), `native-review PoC source is missing marker: ${marker}`);
}

console.log('PASS native-review PoC uses stable SCM/Quick Diff/editor selection APIs only');
