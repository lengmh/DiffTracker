// Test-only UI driver. Run with the launcher's Node 22+, not VS Code 1.80's
// embedded Node. CDP is confined to the disposable Host's loopback renderer.
// No workbench internals, extension commands, review tokens, or ranges are
// injected: the actions below use the rendered controls and real mouse input.
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PROVIDER = 'Code Diff Tracker Review';
const ACTION = 'Open Native Review Snapshot';
const TIMEOUT = 20_000;
const OPERATIONS = new Set([
    'quick-diff-state', 'click-quick-diff', 'multi-diff-state', 'focus-multi-diff', 'pick-native-file',
    'click-native-action'
]);
const NATIVE_ACTIONS = new Set([
    'Keep Selected Whole Block', 'Revert Selected Whole Block', 'Keep Reviewed File', 'Revert Reviewed File'
]);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

// Observation only: no event cancellation, focus, selection or application
// command changes. Bounded evidence distinguishes delivered input from a
// renderer acknowledgement when an actual native acceptance assertion fails.
function installInputProbe() {
    globalThis.__diffTrackerNativeInputProbe?.dispose();
    const events = [], disposables = [];
    const describe = element => element?.nodeType === 1 ? {
        tag: element.tagName, className: String(element.className).slice(0, 180),
        role: element.getAttribute('role'), aria: element.getAttribute('aria-label')?.slice(0, 160)
    } : { node: element?.nodeName };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click',
        'keydown', 'keyup', 'contextmenu', 'focusin', 'focusout']) {
        for (const capture of [true, false]) {
            const listener = event => {
                if (events.length >= 60) { return; }
                const entry = {
                    type, phase: capture ? 'capture' : 'bubble', trusted: event.isTrusted,
                    target: describe(event.target), path: event.composedPath().slice(0, 6).map(describe),
                    button: event.button, buttons: event.buttons, pointerType: event.pointerType,
                    key: event.key, code: event.code, keyCode: event.keyCode,
                    shift: event.shiftKey, ctrl: event.ctrlKey, alt: event.altKey, meta: event.metaKey,
                    defaultPrevented: event.defaultPrevented
                };
                events.push(entry);
                queueMicrotask(() => {
                    entry.finalDefaultPrevented = event.defaultPrevented;
                    entry.activeAfter = describe(document.activeElement);
                });
            };
            window.addEventListener(type, listener, { capture, passive: true });
            disposables.push(() => window.removeEventListener(type, listener, capture));
        }
    }
    globalThis.__diffTrackerNativeInputProbe = { events, dispose() { disposables.forEach(dispose => dispose()); } };
    return true;
}

// Kept self-contained because this function executes in the real workbench DOM.
// Coordinates are accepted only when hit testing confirms the visible element.
function inspectWorkbench(request) {
    const searchRootCache = new Map();
    const searchRoots = root => {
        if (searchRootCache.has(root)) { return searchRootCache.get(root); }
        const roots = [root];
        if (root.shadowRoot) { roots.push(...searchRoots(root.shadowRoot)); }
        for (const element of root.querySelectorAll('*')) {
            if (element.shadowRoot) { roots.push(...searchRoots(element.shadowRoot)); }
        }
        searchRootCache.set(root, roots);
        return roots;
    };
    const composedClosest = (element, selector) => {
        for (let current = element; current;) {
            const found = current.closest?.(selector);
            if (found) { return found; }
            current = current.getRootNode?.().host;
        }
        return undefined;
    };
    const ancestry = element => {
        const result = [];
        for (let current = element; current && result.length < 8;) {
            result.push(`${current.tagName}.${String(current.className).slice(0, 160)}`);
            current = current.parentElement || current.getRootNode?.().host;
        }
        return result;
    };
    let activeElement = document.activeElement;
    while (activeElement?.shadowRoot?.activeElement) { activeElement = activeElement.shadowRoot.activeElement; }
    const visible = element => {
        const bounds = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return bounds.width > 0 && bounds.height > 0 && style.visibility !== 'hidden' &&
            style.display !== 'none' && bounds.right > 0 && bounds.bottom > 0 &&
            bounds.left < innerWidth && bounds.top < innerHeight;
    };
    const all = (selector, root = document) => [...new Set(searchRoots(root)
        .flatMap(searchRoot => [...searchRoot.querySelectorAll(selector)]))];
    const point = element => {
        if (!element || !visible(element)) { return undefined; }
        const box = element.getBoundingClientRect();
        const left = Math.max(0, box.left), right = Math.min(innerWidth, box.right);
        const top = Math.max(0, box.top), bottom = Math.min(innerHeight, box.bottom);
        const x = (left + right) / 2, y = (top + bottom) / 2;
        let hit = document.elementFromPoint(x, y);
        for (let depth = 0; hit?.shadowRoot && depth < 8; depth++) {
            const inner = hit.shadowRoot.elementFromPoint(x, y);
            if (!inner || inner === hit) { break; }
            hit = inner;
        }
        return hit && (hit === element || element.contains(hit)) ? { x, y } : undefined;
    };
    const text = element => (element?.textContent || '').replace(/\s+/g, ' ').trim();
    const label = element => element.getAttribute('aria-label') || element.getAttribute('title') || text(element);
    const enabled = element => element.getAttribute('aria-disabled') !== 'true' &&
        !element.classList.contains('disabled') && !element.closest('.action-item.disabled');
    const actionMatches = element => {
        const value = label(element);
        return value === request.action || value.startsWith(`${request.action} (`) ||
            value === `Code Diff Tracker: ${request.action}`;
    };
    const widgets = all('.dirty-diff').filter(visible);
    const quickDiff = widgets.map(widget => {
        const select = widget.querySelector('select[aria-label="Switch quick diff base"]');
        const actions = all('.peekview-actions .action-label, .head .actions .action-label', widget)
            .filter(visible);
        return {
            title: text(widget.querySelector('.head') || widget).slice(0, 800),
            provider: select && visible(select) ? select.selectedOptions[0]?.textContent?.trim() : undefined,
            providers: select ? [...select.options].map(option => option.textContent.trim()) : [],
            actions: actions.map(element => ({ label: label(element), enabled: !!enabled(element) }))
        };
    });
    const roots = all('.multiDiffEditor').filter(visible);
    const entries = roots.flatMap(root => all('.multiDiffEntry', root)).filter(visible);
    const multiDiff = entries.map(entry => ({
        header: text(entry.querySelector('.header')).slice(0, 800),
        names: all('.header .label-name', entry).map(text),
        modifiedEditors: all('.editor.modified .monaco-editor, .monaco-editor.modified', entry)
            .filter(visible).length
    }));
    const pickers = all('.quick-input-widget').filter(visible);
    const quickPick = pickers.map(picker => ({
        placeholder: picker.querySelector('.quick-input-box input')?.getAttribute('placeholder'),
        value: picker.querySelector('.quick-input-box input')?.value,
        labels: all('.quick-input-list .monaco-list-row', picker).filter(visible)
            .map(row => text(row.querySelector('.label-name')) || text(row))
    }));
    const result = {
        quickDiff, multiDiff, multiDiffRoots: roots.length, quickPick,
        documentHasFocus: document.hasFocus(), visibilityState: document.visibilityState,
        activeElement: activeElement ? {
            tag: activeElement.tagName,
            className: String(activeElement.className),
            label: label(activeElement).slice(0, 200),
            ancestry: ancestry(activeElement),
            inMultiDiff: !!composedClosest(activeElement, '.multiDiffEditor'),
            inEditor: !!composedClosest(activeElement, '.monaco-editor')
        } : undefined
    };
    if (globalThis.__diffTrackerNativeInputProbe) {
        result.inputEvents = globalThis.__diffTrackerNativeInputProbe.events;
        result.editorInputs = all('.monaco-editor textarea, .monaco-editor [contenteditable], ' +
            '.monaco-editor .native-edit-context, .monaco-editor [role="textbox"]')
            .slice(0, 12).map(element => ({
                tag: element.tagName, className: String(element.className), role: element.getAttribute('role'),
                contentEditable: element.getAttribute('contenteditable'), readOnly: element.getAttribute('readonly'),
                tabIndex: element.tabIndex, focused: element === activeElement,
                aria: element.getAttribute('aria-label')?.slice(0, 160),
                editorClass: element.closest('.monaco-editor')?.className,
                rect: { x: element.getBoundingClientRect().x, y: element.getBoundingClientRect().y,
                    width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height }
            }));
    }
    const contextMenus = all('.monaco-menu').filter(visible);
    result.contextMenus = contextMenus.map(menu => all('.action-label', menu).filter(visible)
        .map(element => ({ label: label(element), enabled: !!enabled(element) })));
    if (request.kind === 'context') {
        const matches = contextMenus.flatMap(menu => all('.action-label', menu))
            .filter(element => visible(element) && enabled(element) && actionMatches(element));
        if (matches.length === 1) { result.contextActionPoint = point(matches[0]); }
    }
    if (request.kind === 'provider' || request.kind === 'action') {
        if (widgets.length !== 1) { return result; }
        const widget = widgets[0];
        const select = widget.querySelector('select[aria-label="Switch quick diff base"]');
        if (request.kind === 'provider') {
            result.providerPoint = select && visible(select) ? point(select) : undefined;
        } else {
            const actions = all('.peekview-actions .action-label, .head .actions .action-label', widget)
                .filter(element => visible(element) && enabled(element) && actionMatches(element));
            result.actionMatches = actions.length;
            if (actions.length === 1) { result.actionPoint = point(actions[0]); }
        }
    }
    if (request.kind === 'provider-option') {
        const rows = all('.monaco-select-box-dropdown-container .monaco-list-row')
            .filter(element => visible(element) && text(element) === request.provider);
        result.providerOptions = all('.monaco-select-box-dropdown-container .monaco-list-row')
            .filter(visible).map(text);
        if (rows.length === 1) { result.optionPoint = point(rows[0]); }
    }
    if (request.kind === 'focus') {
        const matches = entries.filter(entry => all('.header .label-name', entry)
            .some(element => text(element) === request.filename));
        result.entryMatches = matches.length;
        if (matches.length === 1) {
            const editors = all('.editor.modified .monaco-editor, .monaco-editor.modified', matches[0])
                .filter(visible);
            if (editors.length === 1) {
                // A physical click on rendered text activates that child editor.
                // The Host then verifies its actual URI and uses the stable
                // TextEditor.selection API, never an injected Monaco model.
                // Monaco's line wrapper may span far beyond its visible text.
                // Inline diff also renders decorative ORIGINAL text in a view
                // zone inside the modified editor. That is not its text input.
                const mainLines = all('.view-lines', editors[0]).filter(element =>
                    composedClosest(element, '.monaco-editor') === editors[0] &&
                    !composedClosest(element, '.view-zones'));
                const isMainText = element => mainLines.includes(composedClosest(element, '.view-lines')) &&
                    composedClosest(element, '.monaco-editor') === editors[0] &&
                    !composedClosest(element, '.view-zones');
                const allLeaves = all('.view-lines .view-line span', editors[0])
                    .filter(element => !element.childElementCount && text(element) && visible(element));
                const leaves = allLeaves.filter(isMainText);
                result.mainTextCandidates = leaves.length;
                result.excludedTextCandidates = allLeaves.filter(element => !isMainText(element)).slice(0, 3)
                    .map(element => ({ text: text(element), ancestry: ancestry(element) }));
                const target = leaves.find(element => point(element));
                result.focusPoint = target ? point(target) : undefined;
                result.focusTarget = target ? {
                    text: text(target).slice(0, 160), tag: target.tagName, className: target.className,
                    lineText: text(composedClosest(target, '.view-line')).slice(0, 200), ancestry: ancestry(target)
                } : undefined;
                result.modifiedFocused = composedClosest(activeElement, '.monaco-editor') === editors[0];
            }
        }
    }
    if (request.kind === 'picker') {
        const matches = pickers.filter(picker => picker.querySelector('.quick-input-box input')?.getAttribute('placeholder') ===
            'Choose a text change for Native Review');
        if (matches.length === 1) {
            const picker = matches[0];
            result.pickerInputPoint = point(picker.querySelector('.quick-input-box input'));
            const rows = all('.quick-input-list .monaco-list-row', picker).filter(visible)
                .filter(row => {
                    const name = text(row.querySelector('.label-name')) || text(row);
                    return !request.filename || name === request.filename ||
                        name.endsWith(`/${request.filename}`) || name.endsWith(`\\${request.filename}`);
                });
            result.pickerMatches = rows.length;
            if (rows.length === 1) {
                result.pickerRowPoint = point(rows[0]);
                result.pickerLabel = text(rows[0].querySelector('.label-name')) || text(rows[0]);
            }
        }
    }
    return result;
}

export function validateWebSocketUrl(value, port) {
    const url = new URL(value);
    if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        Number(url.port) !== port || url.username || url.password ||
        !url.pathname.startsWith('/devtools/page/')) {
        throw new Error(`Refusing non-local/non-renderer CDP endpoint: ${url.origin}${url.pathname}`);
    }
    return url.href;
}

async function connect(url, deadline) {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 0;
    const failPending = error => {
        for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
        pending.clear();
    };
    socket.addEventListener('message', event => {
        let message;
        try { message = JSON.parse(event.data); }
        catch { failPending(new Error('CDP returned invalid JSON')); return; }
        const promise = pending.get(message.id);
        if (!promise) { return; }
        pending.delete(message.id);
        clearTimeout(promise.timer);
        if (message.error) { promise.reject(new Error(`CDP: ${JSON.stringify(message.error)}`)); }
        else { promise.resolve(message.result); }
    });
    socket.addEventListener('close', () => failPending(new Error('CDP renderer connection closed')));
    socket.addEventListener('error', () => failPending(new Error('CDP renderer connection failed')));
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.close(); reject(new Error('CDP connection timed out')); },
            Math.max(1, Math.min(4_000, deadline - Date.now())));
        socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
        socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')); },
            { once: true });
    });
    return {
        send(method, params = {}) {
            if (Date.now() >= deadline) { return Promise.reject(new Error('Native UI deadline exceeded')); }
            return new Promise((resolve, reject) => {
                const id = ++nextId;
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error(`CDP ${method} timed out`));
                }, Math.max(1, Math.min(4_000, deadline - Date.now())));
                pending.set(id, { resolve, reject, timer });
                socket.send(JSON.stringify({ id, method, params }));
            });
        },
        close() { failPending(new Error('CDP driver closed')); socket.close(); }
    };
}

export async function runNativeUiDriver(portText, operation, argument) {
    const port = Number(portText);
    if (!/^\d+$/.test(String(portText)) || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('A numeric loopback CDP port (1–65535) is required');
    }
    if (!OPERATIONS.has(operation)) { throw new Error(`Unknown native UI operation: ${operation}`); }
    if (operation === 'focus-multi-diff' && (!argument || /[/\\]/.test(argument))) {
        throw new Error('focus-multi-diff requires a unique fixture basename');
    }
    if (operation === 'pick-native-file' && argument && /[/\\]/.test(argument)) {
        throw new Error('pick-native-file accepts only a unique fixture basename');
    }
    if (operation === 'click-native-action' && !NATIVE_ACTIONS.has(argument)) {
        throw new Error('click-native-action requires an exact Native Review action title');
    }
    if (typeof WebSocket !== 'function' || Number(process.versions.node.split('.')[0]) < 22) {
        throw new Error('Run native-ui-driver.mjs with DIFF_TRACKER_HOST_NODE (Node 22+)');
    }
    const deadline = Date.now() + TIMEOUT;
    let cdp, lastState, lastDiscovery;
    const until = async (description, predicate) => {
        while (Date.now() < deadline) {
            const value = await predicate();
            if (value) { return value; }
            await delay(100);
        }
        throw new Error(`Timed out waiting for ${description}`);
    };
    try {
        const target = await until('one VS Code workbench renderer', async () => {
            let targets;
            try {
                const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
                    signal: AbortSignal.timeout(Math.max(1, Math.min(2_000, deadline - Date.now()))),
                    redirect: 'error'
                });
                if (!response.ok) { throw new Error(`CDP discovery HTTP ${response.status}`); }
                targets = await response.json();
            } catch (error) { lastDiscovery = error.message; return undefined; }
            if (!Array.isArray(targets)) { throw new Error('CDP target list is not an array'); }
            lastDiscovery = targets.map(({ type, url, title }) => ({ type, url, title }));
            const matches = targets.filter(item => item.type === 'page' &&
                /^(file|vscode-file):/.test(item.url) && /\/workbench(?:-dev)?\.html(?:$|[?#])/.test(item.url));
            if (matches.length > 1) { throw new Error('More than one workbench renderer; refusing an ambiguous click'); }
            return matches[0];
        });
        cdp = await connect(validateWebSocketUrl(target.webSocketDebuggerUrl, port), deadline);
        if (operation === 'focus-multi-diff' || operation === 'click-native-action') {
            await cdp.send('Runtime.evaluate', { expression: `(${installInputProbe.toString()})()`, returnByValue: true });
        }
        const inspect = async kind => {
            const response = await cdp.send('Runtime.evaluate', {
                expression: `(${inspectWorkbench.toString()})(${JSON.stringify({
                    kind, provider: PROVIDER,
                    action: operation === 'click-native-action' ? argument : ACTION, filename: argument
                })})`,
                returnByValue: true
            });
            if (response.exceptionDetails) {
                throw new Error(`Workbench DOM probe failed: ${JSON.stringify(response.exceptionDetails)}`);
            }
            lastState = response.result.value;
            return lastState;
        };
        const click = async point => {
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
            await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point,
                button: 'left', buttons: 1, clickCount: 1 });
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point,
                button: 'left', buttons: 0, clickCount: 1 });
        };
        if (operation === 'quick-diff-state' || operation === 'multi-diff-state') {
            return { operation, state: await inspect('state') };
        }
        if (operation === 'click-native-action') {
            const focused = await inspect('state');
            if (!focused.activeElement?.inEditor) {
                throw new Error('The actual snapshot editor must retain keyboard focus before its context menu');
            }
            // Shift+F10 opens the real editor/context menu without repositioning
            // the selected text. VS Code itself supplies the model URI argument.
            for (const type of ['keyDown', 'keyUp']) {
                await cdp.send('Input.dispatchKeyEvent', { type, modifiers: 8,
                    key: 'F10', code: 'F10', windowsVirtualKeyCode: 121 });
            }
            const before = await until('the real Native Review editor context action', async () => {
                const state = await inspect('context');
                return state.contextActionPoint ? state : undefined;
            });
            await click(before.contextActionPoint);
            const after = await until('the actual editor context menu to close', async () => {
                const state = await inspect('state');
                return state.contextMenus.length === 0 ? state : undefined;
            });
            return { operation, clicked: true, action: argument, before, after };
        }
        if (operation === 'pick-native-file') {
            const picker = await until('the Native Review file picker', async () => {
                const state = await inspect('picker');
                return state.pickerInputPoint ? state : undefined;
            });
            if (argument) {
                await click(picker.pickerInputPoint);
                // The CI matrix is Linux/Windows. Use real select-all and text
                // input, rather than replacing a DOM value behind VS Code.
                for (const type of ['keyDown', 'keyUp']) {
                    await cdp.send('Input.dispatchKeyEvent', { type, modifiers: 2,
                        key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
                }
                await cdp.send('Input.insertText', { text: argument });
            }
            const before = await until('one matching Native Review picker item', async () => {
                const state = await inspect('picker');
                return state.pickerMatches === 1 && state.pickerRowPoint ? state : undefined;
            });
            await click(before.pickerRowPoint);
            const after = await until('the Native Review file picker to close', async () => {
                const state = await inspect('state');
                return state.quickPick.length === 0 ? state : undefined;
            });
            return { operation, clicked: true, filename: argument, selectedLabel: before.pickerLabel, before, after };
        }
        if (operation === 'click-quick-diff') {
            const initial = await until('the real Quick Diff widget', async () => {
                const state = await inspect('provider');
                return state.quickDiff.length === 1 ? state : undefined;
            });
            const widget = initial.quickDiff[0];
            if (initial.providerPoint && widget.provider !== PROVIDER) {
                if (!widget.providers.includes(PROVIDER)) {
                    throw new Error(`Quick Diff has no ${PROVIDER} provider`);
                }
                await click(initial.providerPoint);
                const option = await until('the real Quick Diff provider dropdown option', async () => {
                    const state = await inspect('provider-option');
                    return state.optionPoint;
                });
                await click(option);
            }
            const before = await until('the enabled tracker Quick Diff title action', async () => {
                const state = await inspect('action');
                const current = state.quickDiff[0];
                // With one changed provider VS Code hides the picker and puts
                // its name in the title instead. Do not mistake Git's view for it.
                const correctProvider = current && (current.provider === PROVIDER ||
                    (!current.provider && current.title.includes(PROVIDER)));
                return correctProvider && state.actionPoint ? state : undefined;
            });
            await click(before.actionPoint);
            // The native action runner closes Quick Diff after the command
            // resolves. Never repeat the click on an uncertain result.
            const after = await until('Quick Diff to close after its real menu action', async () => {
                const state = await inspect('state');
                return state.quickDiff.length === 0 ? state : undefined;
            });
            return { operation, clicked: true, provider: PROVIDER, action: ACTION, before, after };
        }
        const before = await until(`the rendered modified child for ${argument}`, async () => {
            const state = await inspect('focus');
            return state.entryMatches === 1 && state.focusPoint ? state : undefined;
        });
        await click(before.focusPoint);
        const after = await inspect('focus');
        // A delivered mouse click is not proof of editor focus. Return its
        // evidence promptly; the Host must still observe the exact current
        // snapshot URI/token through vscode.window.activeTextEditor. Keep DOM
        // focus as diagnostic evidence rather than a second, private contract.
        return { operation, clicked: true, filename: argument,
            domFocusObserved: !!after.modifiedFocused, before, after };
    } catch (error) {
        console.error('Native UI diagnostics:', JSON.stringify({ operation, lastDiscovery, lastState }));
        throw error;
    } finally {
        if (cdp) {
            try {
                await cdp.send('Runtime.evaluate', { expression:
                    'globalThis.__diffTrackerNativeInputProbe?.dispose(); delete globalThis.__diffTrackerNativeInputProbe;' });
            } catch { /* A closed or timed-out target must not mask the original failure. */ }
            cdp.close();
        }
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const watchdog = setTimeout(() => {
        console.error('Native UI driver exceeded its hard process deadline');
        process.exit(1);
    }, TIMEOUT + 2_000);
    try {
        const result = await runNativeUiDriver(...process.argv.slice(2));
        // Flush before exiting so a stalled WebSocket close handshake cannot
        // outlive the driver's bound or truncate its one JSON result.
        await new Promise(resolve => process.stdout.write(`${JSON.stringify(result)}\n`, resolve));
        clearTimeout(watchdog);
        process.exit(0);
    } catch (error) {
        await new Promise(resolve => process.stderr.write(`${error.stack || error.message}\n`, resolve));
        clearTimeout(watchdog);
        process.exit(1);
    }
}
