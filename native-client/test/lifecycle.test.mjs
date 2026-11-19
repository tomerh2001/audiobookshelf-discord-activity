import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { onDocumentExit } from '../src/lifecycle.js';
const { JSDOM } = createRequire(new URL('../../apps/activity-web/package.json', import.meta.url))('jsdom');

test('SPA navigation and bfcache preserve the session; real document exit disposes once', () => {
    const { window } = new JSDOM('<body><div></div></body>');
    try {
        let cleanup = 0;
        onDocumentExit(window, () => cleanup++);
        window.document.querySelector('div').dispatchEvent(new window.CustomEvent('pagehide', { bubbles: true }));
        window.dispatchEvent(new window.CustomEvent('pagehide'));
        window.dispatchEvent(new window.PageTransitionEvent('pagehide', { persisted: true }));
        assert.equal(cleanup, 0);
        window.dispatchEvent(new window.PageTransitionEvent('pagehide', { persisted: false }));
        window.dispatchEvent(new window.PageTransitionEvent('pagehide', { persisted: false }));
        assert.equal(cleanup, 1);
    } finally { window.close(); }
});
