import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { externalizeScripts } from '../externalizeScripts.mjs';

test('packaged Nuxt bootstraps execute as same-origin files in their original order under strict script CSP', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'activity-csp-'));
    try {
        await writeFile(path.join(directory, 'index.html'), '<script src="/activity-storage.js"></script><script>window.__NUXT__={config:{}}</script><script type="application/json">{"kept":true}</script><script data-key="loading">window.ready=true</script><script src="/_nuxt/app.js"></script>');
        await externalizeScripts(directory);
        const html = await readFile(path.join(directory, 'index.html'), 'utf8');
        const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"[^>]*><\/script>/g)].map(match => match[1]);
        assert.equal(scripts.length, 4);
        assert.equal(scripts[0], '/activity-storage.js');
        assert.equal(scripts[3], '/_nuxt/app.js');
        assert.equal(await readFile(path.join(directory, scripts[1]), 'utf8'), 'window.__NUXT__={config:{}}\n');
        assert.equal(await readFile(path.join(directory, scripts[2]), 'utf8'), 'window.ready=true\n');
        assert.ok(html.includes('<script type="application/json">{"kept":true}</script>'));
    } finally { await rm(directory, { recursive: true, force: true }); }
});
