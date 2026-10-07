import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withLookups } from './pr11-final-scope-regressions.mjs';

// Exercise registered production commands and content providers with the real
// tracker. Only the VS Code host boundary is replaced by this harness.
export function registerNativeReviewInvariants(h) {
    const { test, vscode, Uri, file, seed, scan, pending, createAdapter } = h;

    function host(quickDiff = false) {
        const old = { commands: vscode.commands, scm: vscode.scm, window: { ...vscode.window },
            register: vscode.workspace.registerTextDocumentContentProvider,
            configuration: vscode.workspace.getConfiguration,
            configEvent: vscode.workspace.onDidChangeConfiguration,
            uriWith: Uri.prototype.with, uriString: Uri.prototype.toString };
        const commands = new Map(), providers = new Map(), calls = [], sources = [], activeListeners = new Set();
        Uri.prototype.with = function(change) { return Object.assign(new Uri(this.fsPath), this, change); };
        Uri.prototype.toString = function() { return `${this.scheme}://${this.fsPath}${this.query ? `?${this.query}` : ''}`; };
        vscode.commands = {
            registerCommand(name, fn) { commands.set(name, fn); return { dispose() { commands.delete(name); } }; },
            getCommands: async () => ['vscode.diff', 'vscode.changes'],
            async executeCommand(name, ...args) {
                if (commands.has(name)) { return commands.get(name)(...args); }
                calls.push([name, ...args]);
            }
        };
        vscode.scm = { createSourceControl() {
            const source = { inputBox: {}, dispose() { this.disposed = true; } };
            sources.push(source); return source;
        } };
        vscode.window.showInformationMessage = async () => undefined;
        vscode.window.visibleTextEditors = [];
        vscode.window.onDidChangeActiveTextEditor = listener => {
            activeListeners.add(listener); return { dispose() { activeListeners.delete(listener); } };
        };
        vscode.window.showQuickPick = async items => items[0];
        vscode.workspace.registerTextDocumentContentProvider = (scheme, provider) => {
            providers.set(scheme, provider); return { dispose() { providers.delete(scheme); } };
        };
        vscode.workspace.onDidChangeConfiguration = () => ({ dispose() {} });
        vscode.workspace.getConfiguration = (...args) => {
            const config = old.configuration(...args);
            return { ...config, get: (key, fallback) => key === 'nativeQuickDiff' ? quickDiff : config.get(key, fallback) };
        };
        let adapter;
        try { adapter = createAdapter(); }
        catch (error) { restore(); throw error; }
        function restore() {
            adapter?.dispose();
            vscode.commands = old.commands; vscode.scm = old.scm;
            for (const key of Object.keys(vscode.window)) { delete vscode.window[key]; }
            Object.assign(vscode.window, old.window);
            vscode.workspace.registerTextDocumentContentProvider = old.register;
            vscode.workspace.onDidChangeConfiguration = old.configEvent;
            vscode.workspace.getConfiguration = old.configuration;
            Uri.prototype.with = old.uriWith; Uri.prototype.toString = old.uriString;
        }
        return { commands, providers, calls, sources, restore,
            activate(editor) { vscode.window.activeTextEditor = editor; for (const listener of activeListeners) { listener(editor); } },
            run: (command, ...args) => vscode.commands.executeCommand(`diffTracker.nativeReview.${command}`, ...args),
            read: uri => providers.get(uri.scheme).provideTextDocumentContent(uri),
            focus(uri, text = providers.get(uri.scheme).provideTextDocumentContent(uri)) {
                const document = { uri, getText: () => text, isDirty: false,
                    lineCount: text.split('\n').length,
                    lineAt: line => ({ text: text.split('\n')[line].replace(/\r$/, '') }) };
                vscode.window.activeTextEditor = { document, selections: [] };
                for (const listener of activeListeners) { listener(vscode.window.activeTextEditor); }
                return vscode.window.activeTextEditor;
            } };
    }

    test('NATIVE opens immutable backend-token snapshots without changing review or defaults', async () => {
        const p = file('native.txt'); seed(p, 'one\ntwo\nthree\n', 'one\nTWO\nthree\n'); await scan(p);
        const token = h.getTracker().getReviewToken(p);
        const ui = host();
        try {
            const result = await ui.run('openFile', p);
            assert.equal(result.mode, 'single-diff');
            const call = ui.calls.find(call => call[0] === 'vscode.diff');
            assert.ok(call, 'the production command opens the native Diff');
            assert.equal(call[1].scheme, 'diff-tracker-review-base');
            assert.equal(call[2].scheme, 'diff-tracker-review-current');
            assert.equal(ui.read(call[1]), 'one\ntwo\nthree\n');
            assert.equal(ui.read(call[2]), 'one\nTWO\nthree\n');
            assert.deepEqual(JSON.parse(call[1].query), token);
            assert.equal(call[1].query, call[2].query);
            assert.deepEqual(h.getTracker().getReviewToken(p), token);
            assert.ok(pending(p));
            assert.equal(ui.sources.length, 0, 'Quick Diff stays opt-in');
        } finally { ui.restore(); }
    });

    test('NATIVE reviewed-file Keep advances the real backend and refuses the old snapshot afterward', async () => {
        const p = file('native-keep.txt'); seed(p, 'old\n', 'new\n'); await scan(p);
        const ui = host();
        try {
            await ui.run('openFile', p);
            const [, base, current] = ui.calls.at(-1);
            ui.focus(current);
            assert.equal((await ui.run('keepFile', current))?.status, 'success');
            assert.equal(h.getTracker().getOriginalContent(p), 'new\n');
            assert.equal(pending(p), undefined);
            assert.equal((await ui.run('keepFile', current))?.status, 'conflict');
            assert.throws(() => ui.read(base), /stale|unavailable/);
        } finally { ui.restore(); }
    });

    test('NATIVE reviewed-file Revert preserves recovery and never rewrites its displayed snapshot', async () => {
        const p = file('native-revert.txt'); seed(p, 'old\r\n', 'new\r\n'); await scan(p);
        const ui = host();
        try {
            await ui.run('openFile', p);
            const current = ui.calls.at(-1)[2];
            const editor = ui.focus(current);
            assert.equal((await ui.run('revertFile', current))?.status, 'success');
            assert.equal(fs.readFileSync(p, 'utf8'), 'old\r\n');
            assert.equal(editor.document.getText(), 'new\r\n');
            assert.equal((await h.getTracker().undoLastRevert()).succeeded, 1);
            assert.equal(fs.readFileSync(p, 'utf8'), 'new\r\n');
        } finally { ui.restore(); }
    });

    test('NATIVE exact whole-block Keep uses backend identity and leaves the other block pending', async () => {
        const p = file('native-block.txt'); seed(p, 'one\ntwo\nthree\nfour\nfive\n', 'one\nTWO\nthree\nFOUR\nfive\n'); await scan(p);
        const ui = host();
        try {
            await ui.run('openFile', p);
            const current = ui.calls.at(-1)[2];
            const editor = ui.focus(current);
            editor.selections = [{ start: { line: 1, character: 0 }, end: { line: 1, character: 3 }, isEmpty: false }];
            assert.equal((await ui.run('keepSelectedBlock', current))?.status, 'success');
            assert.equal(h.getTracker().getOriginalContent(p), 'one\nTWO\nthree\nfour\nfive\n');
            assert.equal(pending(p).currentContent, 'one\nTWO\nthree\nFOUR\nfive\n');
            assert.equal((await ui.run('keepSelectedBlock', current))?.status, 'conflict');
        } finally { ui.restore(); }
    });

    test('NATIVE whole-block Revert accepts terminal-newline selection and preserves CRLF', async () => {
        const p = file('native-block-revert.txt'); seed(p, 'one\r\ntwo\r\n', 'one\r\nTWO\r\n'); await scan(p);
        const ui = host();
        try {
            await ui.run('openFile', p);
            const current = ui.calls.at(-1)[2];
            const editor = ui.focus(current);
            editor.selections = [{ start: { line: 1, character: 0 }, end: { line: 2, character: 0 }, isEmpty: false }];
            assert.equal((await ui.run('revertSelectedBlock', current))?.status, 'success');
            assert.equal(h.document(p).getText(), 'one\r\ntwo\r\n');
            assert.equal(h.document(p).isDirty, true, 'existing block Revert remains an unsaved editor edit');
            await h.document(p).save();
            assert.equal(fs.readFileSync(p, 'utf8'), 'one\r\ntwo\r\n');
        } finally { ui.restore(); }
    });

    test('NATIVE opens two immutable review pairs through the public Multi Diff command', async () => {
        const a = file('native-multi-a.txt'), b = file('native-multi-b.txt');
        seed(a, 'a\n', 'A\n'); await scan(a); seed(b, 'b\n', 'B\n'); await scan(b);
        const ui = host();
        try {
            assert.deepEqual(await ui.run('openChanges'), { mode: 'multi-diff', count: 2 });
            const call = ui.calls.find(call => call[0] === 'vscode.changes');
            assert.equal(call[2].length, 2);
            for (const [label, base, current] of call[2]) {
                assert.equal(label.scheme, 'file');
                assert.equal(base.query, current.query);
                assert.equal(base.fsPath, label.fsPath);
                assert.equal(current.scheme, 'diff-tracker-review-current');
            }
            assert.equal(h.getTracker().getReviewTokens().length, 2);
        } finally { ui.restore(); }
    });

    test('NATIVE minimum-host absence falls back to an explicit file choice without expanding the batch', async () => {
        const a = file('fallback-a.txt'), b = file('fallback-b.txt');
        seed(a, 'a', 'A'); await scan(a); seed(b, 'b', 'B'); await scan(b);
        const ui = host();
        try {
            vscode.commands.getCommands = async () => ['vscode.diff'];
            let choices;
            vscode.window.showQuickPick = async items => { choices = items; return items.find(item => item.token.filePath === a); };
            assert.deepEqual(await ui.run('openChanges'), { mode: 'single-diff-fallback', count: 2 });
            assert.equal(choices.length, 2);
            assert.equal(ui.calls.some(call => call[0] === 'vscode.changes'), false);
            assert.equal(ui.calls.at(-1)[2].fsPath, a);
            assert.equal(h.getTracker().getReviewTokens().length, 2);
        } finally { ui.restore(); }
    });

    test('NATIVE opt-in Quick Diff menu navigates to a fresh snapshot without applying old hunk coordinates', async () => {
        const p = file('native-quick.txt'); seed(p, 'a\nb\n', 'a\nB\n'); await scan(p);
        const token = h.getTracker().getReviewToken(p);
        const ui = host(true);
        try {
            assert.equal(ui.sources.length, 1);
            const provider = ui.sources[0].quickDiffProvider;
            assert.equal(provider.provideOriginalResource(Uri.file(p)).scheme, 'diff-tracker-original');
            assert.equal(provider.provideOriginalResource(Uri.file(p).with({ scheme: 'untitled' })), undefined);
            const result = await ui.run('openFromQuickDiff', Uri.file(p), [{ modifiedStartLineNumber: 999 }], 17);
            assert.equal(result?.mode, 'single-diff');
            const call = ui.calls.at(-1);
            assert.equal(call[0], 'vscode.diff');
            assert.equal(call[4].selection.start.line, 0);
            assert.equal(call[4].selection.end.line, 0);
            assert.equal(call[4].selection.start.character, 0);
            assert.equal(call[4].selection.end.character, 0);
            assert.deepEqual(h.getTracker().getReviewToken(p), token);
            assert.equal(fs.readFileSync(p, 'utf8'), 'a\nB\n');
        } finally { ui.restore(); }
    });

    test('NATIVE Quick Diff hides an opaque review reached through a filesystem case alias', async () => {
        const dir = file('native-alias'); fs.mkdirSync(dir);
        const p = path.join(dir, 'asset.bin');
        const alias = path.join(path.dirname(p), path.basename(p).toUpperCase());
        seed(p, 'text baseline');
        fs.writeFileSync(p, Buffer.from([0, 1, 2])); await scan(p);
        const ui = host(true);
        try {
            await withLookups([[alias, p]], [], async () => {
                assert.equal(pending(p)?.reviewKind, 'opaque');
                assert.equal(h.getTracker().getOriginalContent(alias), 'text baseline');
                assert.equal(h.getTracker().getReviewToken(alias), undefined);
                assert.equal(ui.sources[0].quickDiffProvider.provideOriginalResource(Uri.file(alias)), undefined);
                assert.deepEqual(await ui.run('openFile', alias), { mode: 'existing-review', count: 1 });
                assert.deepEqual(ui.calls.at(-1), ['diffTracker.showWebviewDiff', p]);
                assert.equal(h.getTracker().getOriginalContent(p), 'text baseline');
                assert.deepEqual(fs.readFileSync(p), Buffer.from([0, 1, 2]));
            });
        } finally { ui.restore(); }
    });

    test('NATIVE unknown case alias opens its canonical read-only WebView review', async () => {
        const dir = file('native-unknown-alias'); fs.mkdirSync(dir);
        const p = path.join(dir, 'asset.txt'), alias = path.join(dir, 'ASSET.TXT');
        seed(p, 'text baseline', 'unreadable current'); await scan(p);
        h.faults.set(p, { read: vscode.FileSystemError.NoPermissions() }); await scan(p);
        const ui = host(true);
        try {
            await withLookups([[alias, p]], [], async () => {
                assert.equal(pending(p)?.reviewKind, 'unknown');
                assert.equal(h.getTracker().getOriginalContent(alias), 'text baseline');
                assert.equal(h.getTracker().getReviewToken(alias), undefined);
                assert.equal(ui.sources[0].quickDiffProvider.provideOriginalResource(Uri.file(alias)), undefined);
                assert.deepEqual(await ui.run('openFile', Uri.file(alias)), { mode: 'existing-review', count: 1 });
                assert.deepEqual(ui.calls.at(-1), ['diffTracker.showWebviewDiff', p]);
                assert.equal(h.getTracker().getOriginalContent(p), 'text baseline');
                assert.equal(fs.readFileSync(p, 'utf8'), 'unreadable current');
            });
        } finally { ui.restore(); h.faults.delete(p); }
    });

    test('NATIVE text case aliases navigate to canonical snapshots but cannot alias a write context', async () => {
        const dir = file('native-text-alias'); fs.mkdirSync(dir);
        const p = path.join(dir, 'asset.txt'), alias = path.join(dir, 'ASSET.TXT');
        seed(p, 'old text', 'new text'); await scan(p);
        const token = h.getTracker().getReviewToken(p), ui = host(true);
        try {
            await withLookups([[alias, p]], [], async () => {
                const original = ui.sources[0].quickDiffProvider.provideOriginalResource(
                    Uri.file(alias).with({ query: 'ignored-query', fragment: 'ignored-fragment' }));
                assert.equal(original.scheme, 'diff-tracker-original');
                assert.equal(original.fsPath, p);
                assert.equal(original.query, ''); assert.equal(original.fragment, '');
                assert.equal((await ui.run('openFromQuickDiff', Uri.file(alias))).mode, 'single-diff');
                const [, base, current] = ui.calls.at(-1);
                assert.deepEqual(JSON.parse(current.query), token);
                assert.equal(current.fsPath, p);
                assert.equal(ui.read(base), 'old text'); assert.equal(ui.read(current), 'new text');
                ui.focus(current);
                const aliasedContext = current.with({ fsPath: alias });
                for (const command of ['keepFile', 'revertFile', 'keepSelectedBlock', 'revertSelectedBlock']) {
                    assert.equal((await ui.run(command, aliasedContext)).status, 'conflict');
                }
                assert.deepEqual(h.getTracker().getReviewToken(p), token);
                assert.equal(h.getTracker().getOriginalContent(p), 'old text');
                assert.equal(fs.readFileSync(p, 'utf8'), 'new text');
            });
        } finally { ui.restore(); }
    });

    for (const baseline of ['initial baseline', '']) {
        test(`NATIVE Quick Diff baseline URI receives incremental Keep refreshes after opening an unchanged case alias (empty=${baseline === ''})`, async () => {
            const dir = file('native-baseline-refresh'); fs.mkdirSync(dir);
            const p = path.join(dir, 'asset.txt'), alias = path.join(dir, 'ASSET.TXT');
            seed(p, baseline); await scan(p);
            const ui = host(true), original = h.createOriginalProvider();
            const refreshes = [], events = [];
            let cachedText, originalUri;
            const changed = original.onDidChange(uri => {
                refreshes.push(uri.toString());
                if (uri.toString() === originalUri?.toString()) { cachedText = original.provideTextDocumentContent(uri); }
            });
            const tracked = h.getTracker().onDidTrackChanges(event => events.push(event));
            try {
                await withLookups([[alias, p]], [], async () => {
                    assert.equal(h.getTracker().getReviewToken(alias), undefined, 'open before any pending review exists');
                    originalUri = ui.sources[0].quickDiffProvider.provideOriginalResource(Uri.file(alias));
                    cachedText = original.provideTextDocumentContent(originalUri);
                    assert.equal(cachedText, baseline);
                    for (const next of ['first accepted edit', 'second accepted edit']) {
                        fs.writeFileSync(p, next); await scan(p);
                        await ui.run('openFile', Uri.file(alias));
                        const current = ui.calls.at(-1)[2]; ui.focus(current);
                        refreshes.length = 0; events.length = 0;
                        assert.equal((await ui.run('keepFile', current)).status, 'success');
                        assert.equal(events.some(event => event.fullRefresh), false, 'exercise incremental invalidation only');
                        assert.ok(events.some(event => event.baselineChanged && event.removedFiles.includes(p)));
                        assert.ok(refreshes.includes(originalUri.toString()), 'the originally opened document must be invalidated');
                        assert.equal(cachedText, next, 'the open Quick Diff baseline updates without reopening');
                        assert.equal(ui.sources[0].quickDiffProvider.provideOriginalResource(Uri.file(alias)).toString(),
                            originalUri.toString(), 'unchanged and pending states retain one baseline document identity');
                        assert.equal(h.getTracker().getReviewToken(alias), undefined);
                    }
                });
            } finally { changed.dispose(); tracked.dispose(); original.dispose(); ui.restore(); }
        });
    }

    test('NATIVE missing case variant cannot inherit a distinct read-only review', async () => {
        const dir = file('native-missing-variant'); fs.mkdirSync(dir);
        const p = path.join(dir, 'asset.bin'), missing = path.join(dir, 'ASSET.BIN');
        seed(p, 'text baseline'); fs.writeFileSync(p, Buffer.from([0, 1, 2])); await scan(p);
        const ui = host(true);
        try {
            await withLookups([], [missing], async () => {
                assert.equal(h.getTracker().getOriginalContent(missing), undefined);
                assert.equal(ui.sources[0].quickDiffProvider.provideOriginalResource(Uri.file(missing)), undefined);
                assert.deepEqual(await ui.run('openFile', missing), { mode: 'unavailable', count: 0 });
                assert.equal(ui.calls.some(call => call[0] === 'diffTracker.showWebviewDiff'), false);
                assert.equal(pending(p)?.reviewKind, 'opaque');
            });
        } finally { ui.restore(); }
    });

    test('NATIVE case-sensitive sibling entries retain separate text and opaque reviews', async () => {
        const dir = file('native-distinct-cases'); fs.mkdirSync(dir);
        const opaque = path.join(dir, 'asset.txt'), text = path.join(dir, 'ASSET.TXT');
        seed(opaque, 'opaque baseline');
        if (fs.existsSync(text)) {
            console.log('SKIP real case-distinct entries require a case-sensitive directory; denied-alias coverage still runs');
            return;
        }
        fs.writeFileSync(opaque, Buffer.from([0, 1, 2])); await scan(opaque);
        seed(text, 'text baseline', 'text current'); await scan(text);
        const ui = host(true);
        try {
            const provider = ui.sources[0].quickDiffProvider;
            assert.equal(provider.provideOriginalResource(Uri.file(opaque)), undefined);
            const original = provider.provideOriginalResource(Uri.file(text));
            assert.equal(original.scheme, 'diff-tracker-original');
            assert.equal(original.fsPath, text);
            assert.equal((await ui.run('openFile', text)).mode, 'single-diff');
            const [, base, current] = ui.calls.at(-1);
            assert.equal(current.fsPath, text);
            assert.equal(ui.read(base), 'text baseline'); assert.equal(ui.read(current), 'text current');
            assert.equal((await ui.run('openFile', opaque)).mode, 'existing-review');
            assert.deepEqual(ui.calls.at(-1), ['diffTracker.showWebviewDiff', opaque]);
            assert.equal(h.getTracker().getTrackedChanges().length, 2);
            assert.equal(h.getTracker().getOriginalContent(opaque), 'opaque baseline');
            assert.equal(h.getTracker().getOriginalContent(text), 'text baseline');
        } finally { ui.restore(); }
    });

    test('NATIVE write commands require the clicked snapshot context even with an active review', async () => {
        const p = file('native-no-context.txt'); seed(p, 'old', 'new'); await scan(p);
        const ui = host();
        try {
            await ui.run('openFile', p);
            ui.focus(ui.calls.at(-1)[2]);
            assert.equal((await ui.run('keepFile'))?.status, 'conflict');
            assert.equal(h.getTracker().getOriginalContent(p), 'old');
            assert.ok(pending(p));
        } finally { ui.restore(); }
    });

    test('NATIVE duplicate visible snapshots refuse selection ambiguity while file review remains usable', async () => {
        const p = file('native-groups.txt'); seed(p, 'one\ntwo\n', 'one\nTWO\n'); await scan(p);
        const ui = host();
        try {
            await ui.run('openFile', p);
            const current = ui.calls.at(-1)[2];
            const editor = ui.focus(current);
            editor.selections = [{ start: { line: 1, character: 0 }, end: { line: 1, character: 3 }, isEmpty: false }];
            vscode.window.visibleTextEditors = [editor, { document: editor.document, selections: [] }];
            assert.equal((await ui.run('keepSelectedBlock', current))?.status, 'conflict');
            assert.equal(h.getTracker().getOriginalContent(p), 'one\ntwo\n');
            assert.equal((await ui.run('keepFile', current))?.status, 'success');
        } finally { ui.restore(); }
    });

    test('NATIVE more than fifty pending resources uses the bounded picker fallback', async () => {
        for (let i = 0; i < 51; i++) { const p = file(`bounded-${i}.txt`); seed(p, 'old', 'new'); await scan(p); }
        const ui = host();
        try {
            assert.deepEqual(await ui.run('openChanges'), { mode: 'single-diff-fallback', count: 51 });
            assert.equal(ui.calls.some(call => call[0] === 'vscode.changes'), false);
            assert.equal(ui.calls.filter(call => call[0] === 'vscode.diff').length, 1);
            assert.equal(h.getTracker().getReviewTokens().length, 51);
        } finally { ui.restore(); }
    });

    test('NATIVE tree entry opens a text snapshot and opaque resources keep their existing review', async () => {
        const p = file('native-tree.txt'); seed(p, 'old', 'new'); await scan(p);
        const opaque = file('native-opaque.bin'); seed(opaque, 'text before');
        fs.writeFileSync(opaque, Buffer.from([0, 1, 2])); await scan(opaque);
        const ui = host();
        try {
            assert.equal((await ui.run('openFile', { filePath: p }))?.mode, 'single-diff');
            assert.equal((await ui.run('openFile', opaque))?.mode, 'existing-review');
            assert.deepEqual(ui.calls.at(-1), ['diffTracker.showWebviewDiff', opaque]);
            assert.ok(pending(opaque));
            assert.equal(h.getTracker().getOriginalContent(opaque), 'text before');
        } finally { ui.restore(); }
    });

    test('NATIVE manifest exposes opt-in navigation and only context-bound write menus', async () => {
        const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
        const config = manifest.contributes.configuration.properties;
        assert.equal(config['diffTracker.nativeQuickDiff']?.default, false);
        assert.equal(config['diffTracker.defaultOpenMode'].default, 'webview');
        assert.equal(manifest.enabledApiProposals, undefined);
        const menus = manifest.contributes.menus;
        assert.ok(menus['scm/change/title'].some(item => item.command === 'diffTracker.nativeReview.openFromQuickDiff' &&
            item.when.includes('originalResourceScheme == diff-tracker-original')));
        for (const suffix of ['keepFile', 'revertFile', 'keepSelectedBlock', 'revertSelectedBlock']) {
            const command = `diffTracker.nativeReview.${suffix}`;
            assert.ok(manifest.contributes.commands.some(item => item.command === command));
            assert.ok(menus['editor/context'].some(item => item.command === command &&
                item.when === 'diffTracker.nativeReviewContext'));
            assert.ok(menus.commandPalette.some(item => item.command === command && item.when === 'false'));
            assert.equal(Object.entries(menus).some(([menu, items]) => !['editor/context', 'commandPalette'].includes(menu) &&
                items.some(item => item.command === command)), false, 'no ambiguous title/header write action');
        }
    });

    for (const [name, selection] of [
        ['partial characters', { start: { line: 1, character: 1 }, end: { line: 2, character: 3 }, isEmpty: false }],
        ['partial block', { start: { line: 1, character: 0 }, end: { line: 1, character: 3 }, isEmpty: false }],
        ['wider context', { start: { line: 0, character: 0 }, end: { line: 3, character: 3 }, isEmpty: false }],
        ['empty selection', { start: { line: 1, character: 0 }, end: { line: 1, character: 0 }, isEmpty: true }],
        ['two selections', null]
    ]) {
        test(`NATIVE ${name} cannot widen to a whole block`, async () => {
            const p = file('selection-boundary.txt'); seed(p, 'one\ntwo\nthree\nend\n', 'one\nTWO\nTHREE\nend\n'); await scan(p);
            const token = h.getTracker().getReviewToken(p), ui = host();
            try {
                await ui.run('openFile', p); const current = ui.calls.at(-1)[2]; const editor = ui.focus(current);
                editor.selections = selection ? [selection] : [
                    { start: { line: 1, character: 0 }, end: { line: 2, character: 5 }, isEmpty: false },
                    { start: { line: 3, character: 0 }, end: { line: 3, character: 3 }, isEmpty: false }
                ];
                for (const command of ['keepSelectedBlock', 'revertSelectedBlock']) {
                    assert.equal((await ui.run(command, current)).status, 'conflict');
                }
                assert.deepEqual(h.getTracker().getReviewToken(p), token);
                assert.equal(fs.readFileSync(p, 'utf8'), 'one\nTWO\nTHREE\nend\n');
            } finally { ui.restore(); }
        });
    }

    for (const change of ['external edit', 'dirty editor', 'other Keep', 'session stop', 'snapshot text', 'wrong resource', 'baseline side', 'malformed query']) {
        test(`NATIVE ${change} refuses file and block writes without recapturing a token`, async () => {
            const p = file('stale-snapshot.txt'); seed(p, 'one\ntwo\n', 'one\nTWO\n'); await scan(p);
            const ui = host();
            try {
                await ui.run('openFile', p); const [, base, current] = ui.calls.at(-1); const text = ui.read(current);
                let editor = ui.focus(current), context = current;
                if (change === 'external edit') { fs.writeFileSync(p, 'one\nNEW\n'); await scan(p); }
                if (change === 'dirty editor') { const doc = h.document(p); doc.text = 'one\nDIRTY\n'; doc.isDirty = true; }
                if (change === 'other Keep') { await h.getTracker().keepAllChangesInFile(p); }
                if (change === 'session stop') { h.getTracker().stopRecording(); }
                if (change === 'snapshot text') { editor = ui.focus(current, 'one\nforged\n'); }
                if (change === 'wrong resource') { context = current.with({ fsPath: file('different.txt') }); }
                if (change === 'baseline side') { editor = ui.focus(base); context = base; }
                if (change === 'malformed query') { context = current.with({ query: '{}' }); editor = ui.focus(context, text); }
                editor.selections = [{ start: { line: 1, character: 0 }, end: { line: 1, character: 3 }, isEmpty: false }];
                const baseline = h.getTracker().getOriginalContent(p), disk = fs.readFileSync(p, 'utf8');
                for (const command of ['keepFile', 'revertFile', 'keepSelectedBlock', 'revertSelectedBlock']) {
                    assert.equal((await ui.run(command, context)).status, 'conflict', command);
                }
                assert.equal(h.getTracker().getOriginalContent(p), baseline);
                assert.equal(fs.readFileSync(p, 'utf8'), disk);
                if (change === 'external edit' || change === 'other Keep' || change === 'session stop') {
                    assert.throws(() => ui.read(current), /stale|unavailable/);
                }
            } finally { ui.restore(); }
        });
    }

    for (const [name, before, after] of [['deleted lines', 'first\nremove\nlast\n', 'first\nlast\n']]) {
        test(`NATIVE ${name} rejects current-side block selection and retains reviewed-file fallback`, async () => {
            const p = file('native-ambiguous.txt'); seed(p, before, after); await scan(p);
            const ui = host();
            try {
                await ui.run('openFile', p); const current = ui.calls.at(-1)[2]; const editor = ui.focus(current);
                editor.selections = [{ start: { line: 0, character: 0 }, end: { line: 0, character: after.split('\n')[0].length }, isEmpty: false }];
                assert.equal((await ui.run('keepSelectedBlock', current)).status, 'conflict');
                assert.equal(h.getTracker().getOriginalContent(p), before);
                assert.equal((await ui.run('keepFile', current)).status, 'success');
                assert.equal(h.getTracker().getOriginalContent(p), after);
            } finally { ui.restore(); }
        });
    }

    test('NATIVE final-EOL-only content does not invent a review absent from the backend', async () => {
        const p = file('eol-only.txt'); seed(p, 'one\n', 'one'); await scan(p);
        const ui = host();
        try {
            assert.equal(h.getTracker().getReviewToken(p), undefined, 'existing backend does not expose an EOL-only text block');
            assert.equal((await ui.run('openFile', p)).mode, 'unavailable');
            assert.equal((await ui.run('keepSelectedBlock', Uri.file(p))).status, 'conflict');
            assert.equal(h.getTracker().getOriginalContent(p), 'one\n');
            assert.equal(fs.readFileSync(p, 'utf8'), 'one');
        } finally { ui.restore(); }
    });

    test('NATIVE virtual baseline sharing fsPath cannot impersonate the working document during Keep', async () => {
        const p = file('virtual-alias.txt'); seed(p, 'old\n', 'new\n'); await scan(p);
        const ui = host();
        try {
            await ui.run('openFile', p); const [, base, current] = ui.calls.at(-1);
            const editor = ui.focus(current);
            vscode.workspace.textDocuments.unshift({ uri: base, getText: () => 'old\n', isDirty: false }, editor.document);
            assert.equal((await ui.run('keepFile', current)).status, 'success');
            assert.equal(h.getTracker().getOriginalContent(p), 'new\n');
            assert.equal(fs.readFileSync(p, 'utf8'), 'new\n');
        } finally { ui.restore(); }
    });

    test('NATIVE immutable snapshots never receive current-state hover or decoration overlays', async () => {
        const p = file('snapshot-overlays.txt'); seed(p, 'one\ntwo\n', 'one\nTWO\n'); await scan(p);
        const ui = host();
        const old = { parse: Uri.parse, Hover: vscode.Hover, MarkdownString: vscode.MarkdownString,
            lane: vscode.OverviewRulerLane, tabType: vscode.TabInputTextDiff };
        let presentation;
        try {
            Uri.parse = value => ({ toString: () => value });
            vscode.Hover = class { constructor(value) { this.contents = value; } };
            vscode.MarkdownString = class { constructor(value) { this.value = value; } };
            vscode.OverviewRulerLane = { Left: 1 };
            vscode.TabInputTextDiff = class {};
            vscode.window.createTextEditorDecorationType = () => ({ dispose() {} });
            vscode.window.tabGroups = { all: [] }; // Multi Diff has no 1.80 stable tab-input class.
            presentation = h.createPresentation();
            await ui.run('openFile', p); const [, base, current] = ui.calls.at(-1);
            const snapshots = [[base, ui.read(base)], [current, ui.read(current)]];
            fs.writeFileSync(p, 'one\nNEW\n'); await scan(p);
            for (const [uri, text] of snapshots) {
                const editor = ui.focus(uri, text);
                const decorations = [];
                editor.setDecorations = (_type, ranges) => decorations.push(ranges);
                assert.equal(presentation.hover.provideHover(editor.document, { line: 1, character: 0 }, {}), null);
                presentation.decorations.updateDecorations(editor);
                assert.ok(decorations.every(ranges => ranges.length === 0));
            }
        } finally {
            presentation?.decorations.dispose();
            Uri.parse = old.parse; vscode.Hover = old.Hover; vscode.MarkdownString = old.MarkdownString;
            vscode.OverviewRulerLane = old.lane; vscode.TabInputTextDiff = old.tabType;
            ui.restore();
        }
    });

    test('NATIVE menu visibility follows active snapshot capability without authorizing a wrong resource', async () => {
        const p = file('native-menu-context.txt'); seed(p, 'old', 'new'); await scan(p);
        const ui = host();
        const visible = () => ui.calls.filter(call => call[0] === 'setContext' &&
            call[1] === 'diffTracker.nativeReviewContext').at(-1)?.[2];
        try {
            assert.equal(visible(), false);
            await ui.run('openFile', p); const [, base, current] = ui.calls.at(-1);
            ui.focus(current); assert.equal(visible(), true);
            assert.equal((await ui.run('keepFile', Uri.file(p))).status, 'conflict');
            assert.equal(h.getTracker().getOriginalContent(p), 'old');
            ui.focus(base); assert.equal(visible(), false);
            ui.focus(Uri.file(p), 'new'); assert.equal(visible(), false);
            ui.focus(current); assert.equal(visible(), true);
            ui.activate(undefined); assert.equal(visible(), false);
            ui.focus(current); assert.equal(visible(), true, 'dispose must clear a currently visible capability');
        } finally { ui.restore(); }
        assert.equal(visible(), false, 'disposing clears the capability projection');
    });
}
