import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createActivityDialogs } from '../src/activityDialogs.js';
const { JSDOM } = createRequire(new URL('../../apps/activity-web/package.json', import.meta.url))('jsdom');

function fixture(dismissible = true) {
    const { window } = new JSDOM('<button id="opener">Party</button><section tabindex="-1"><button id="first">First</button><button disabled>Disabled</button><button id="last">Close</button></section>');
    const document = window.document;
    let dialog = { element: document.querySelector('section'), dismissible }, dismissed = 0;
    document.querySelector('#opener').focus();
    const manager = createActivityDialogs(window, () => dialog, () => { dismissed++; dialog = null; manager.update(); });
    manager.update();
    return { window, document, manager, get dismissed() { return dismissed; }, close() { manager.dispose(); window.close(); } };
}
test('opening focuses dialog, Tab wraps, outside focus is contained, close restores opener', () => {
    const f = fixture();
    try {
        assert.equal(f.document.activeElement.id, 'first');
        f.window.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true }));
        assert.equal(f.document.activeElement.id, 'last');
        f.window.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Tab', cancelable: true }));
        assert.equal(f.document.activeElement.id, 'first');
        f.document.querySelector('#opener').focus();
        assert.equal(f.document.activeElement.id, 'first');
        const event = new f.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
        f.window.dispatchEvent(event);
        assert.equal(event.defaultPrevented, true);
        assert.equal(f.dismissed, 1);
        assert.equal(f.document.activeElement.id, 'opener');
    } finally { f.close(); }
});
test('native Back dismisses roster and cannot escape an autoplay permission dialog', () => {
    for (const dismissible of [true, false]) {
        const f = fixture(dismissible);
        try {
            const event = new f.window.CustomEvent('command', { detail: { command: 'back' }, cancelable: true });
            f.window.dispatchEvent(event);
            assert.equal(event.defaultPrevented, true);
            assert.equal(f.dismissed, dismissible ? 1 : 0);
            if (!dismissible) assert.equal(f.manager.back(), true);
        } finally { f.close(); }
    }
});
