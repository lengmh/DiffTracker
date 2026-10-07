// Read-only renderer observation. No private workbench services, injected
// commands, synthetic watcher events, or product monkeypatches.
import assert from 'node:assert/strict';
import { validateWebSocketUrl } from '../host/native-ui-driver.mjs';

function renderedChanges() {
    const visible = element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
    };
    const normalize = element => (element?.textContent || '').replace(/\s+/g, ' ').trim();
    const named = document.querySelector('[id="diffTracker.changesView"]');
    const pane = named || [...document.querySelectorAll('.pane')].find(element =>
        normalize(element.querySelector('.pane-header .title')).toLowerCase() === 'change recording');
    const tree = pane || document.querySelector('[role="tree"][aria-label="Change Recording"]');
    return {
        found: !!tree,
        rows: tree ? [...tree.querySelectorAll('.monaco-list-row')].filter(visible).map(row => ({
            label: normalize(row.querySelector('.label-name')),
            description: normalize(row.querySelector('.label-description')),
            text: normalize(row), aria: row.getAttribute('aria-label')
        })) : [],
        // Useful failure evidence only; it cannot make an assertion pass.
        titles: [...document.querySelectorAll('.pane-header .title')].map(normalize)
    };
}

const port = Number(process.argv[2]);
assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
const watchdog = setTimeout(() => { console.error('Installed tree observer timed out'); process.exit(1); }, 10_000);
let socket;
try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(4000) });
    assert.ok(response.ok);
    const targets = (await response.json()).filter(target => target.type === 'page' && /workbench/i.test(target.url));
    assert.equal(targets.length, 1, 'exactly one disposable workbench renderer is required');
    socket = new WebSocket(validateWebSocketUrl(targets[0].webSocketDebuggerUrl, port));
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', () => reject(new Error('Renderer connection failed')), { once: true });
    });
    const result = await new Promise((resolve, reject) => {
        socket.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            if (message.id !== 1) { return; }
            if (message.error || message.result.exceptionDetails) { reject(new Error(JSON.stringify(message))); }
            else { resolve(message.result.result.value); }
        });
        socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
            expression: `(${renderedChanges.toString()})()`, returnByValue: true
        } }));
    });
    await new Promise(resolve => process.stdout.write(`${JSON.stringify(result)}\n`, resolve));
    clearTimeout(watchdog);
    socket.close();
    process.exit(0);
} catch (error) {
    console.error(error);
    socket?.close();
    process.exit(1);
}
