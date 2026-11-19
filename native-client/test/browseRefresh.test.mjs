import assert from 'node:assert/strict';
import test from 'node:test';
import { refreshNativeBrowse } from '../src/browseRefresh.js';
function fixture() {
    const page = { $data: { libraryItem: { id: 'book', title: 'Old title' } }, $options: {
        async asyncData({ app }) { return { libraryItem: await app.$axios.$get('/api/items/book') }; }
    } };
    const route = { path: '/item/book', params: { id: 'book' }, query: {}, matched: [{ instances: { default: page } }] };
    const redirects = [], calls = [];
    let current = true;
    const context = { app: { router: { currentRoute: route, replace: async path => redirects.push(path) } }, store: { state: {}, getters: {}, commit() {}, dispatch() {} }, $axios: { $get: async path => { calls.push(path); return { id: 'book', title: 'Fresh title' }; } } };
    const options = { isCurrent: () => current, remount: async () => {}, set: (data, key, value) => { data[key] = value; } };
    return { context, options, page, calls, redirects, stale() { current = false; } };
}
test('browse remount explicitly reruns Nuxt asyncData and applies fresh detail data', async () => {
    const f = fixture(); await refreshNativeBrowse(f.context, f.options);
    assert.equal(f.page.$data.libraryItem.title, 'Fresh title'); assert.deepEqual(f.calls, ['/api/items/book']);
});
test('navigation or account change prevents stale data and error redirects after refresh', async () => {
    for (const kind of ['account', 'route']) {
        const f = fixture(); let resolve;
        f.context.$axios.$get = () => new Promise(done => { resolve = done; });
        f.page.$options.asyncData = async ({ app, redirect }) => {
            try { return { libraryItem: await app.$axios.$get('/api/items/book') }; }
            catch { redirect('/'); }
        };
        const pending = refreshNativeBrowse(f.context, f.options); await new Promise(done => setImmediate(done));
        if (kind === 'account') f.stale(); else f.context.app.router.currentRoute = { path: '/author/another' };
        resolve({ id: 'private-book', title: 'Should not apply' }); await pending;
        assert.equal(f.page.$data.libraryItem.title, 'Old title'); assert.deepEqual(f.redirects, []);
    }
});
