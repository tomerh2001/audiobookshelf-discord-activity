import assert from 'node:assert/strict';
import test from 'node:test';
import { createLibraryRefresh } from '../src/libraryRefresh.js';
function fixture(get) {
    const commits = [], calls = [], events = [], refreshes = [], routes = [], errors = [];
    let current = true;
    const store = { state: { libraries: { currentLibraryId: 'library-one' }, selectedLibraryItem: { id: 'book-one' }, streamLibraryItem: { id: 'book-one' } }, commit(type, value) { commits.push([type, value]); if (type === 'libraries/setCurrentLibrary') store.state.libraries.currentLibraryId = value.id; } };
    const router = { currentRoute: { path: '/item/book-one', params: { id: 'book-one' } }, replace: async path => { routes.push(path); router.currentRoute = { path, params: {} }; } };
    const defaults = path => path === '/api/libraries' ? { libraries: [{ id: 'library-one' }] } : path.startsWith('/api/items/') ? { id: 'book-one', media: { metadata: { title: 'Updated book' } } } : { library: { id: 'library-one' }, filterdata: { tags: ['new'] } };
    const refresh = createLibraryRefresh({ store, router, axios: { $get: path => { calls.push(path); return Promise.resolve(get ? get(path) : defaults(path)); } }, eventBus: { $emit: (...args) => events.push(args) }, isCurrent: () => current,
        onRefresh: ids => refreshes.push(ids), onError: value => errors.push(value), host: { setTimeout: () => 1, clearTimeout() {} } });
    return { refresh, commits, calls, events, refreshes, routes, errors, stale() { current = false; } };
}
test('coalesced invalidations reload permitted metadata and refresh browsing without touching playback', async () => {
    const f = fixture();
    f.refresh.notify('items_changed', { itemIds: ['book-one', '../private', 'book-one'] });
    f.refresh.notify('items_changed', { itemIds: ['book-two'] });
    await f.refresh.flush();
    assert.equal(f.calls.filter(path => path === '/api/libraries').length, 1);
    assert.deepEqual(f.refreshes, [['book-one', 'book-two']]);
    assert.equal(f.events[0][0], 'book-one_updated');
    assert.ok(f.commits.some(([type]) => type === 'updateStreamLibraryItem'));
    assert.equal(f.commits.some(([type]) => type === 'setMediaPlaying'), false);
    f.refresh.dispose();
});
test('a late response after account replacement cannot update the new account', async () => {
    let resolve;
    const f = fixture(() => new Promise(done => { resolve = done; }));
    // No selected item request: only the library response is pending.
    f.refresh.notify('items_changed', { itemIds: ['other-book'] });
    const pending = f.refresh.flush(); f.stale(); resolve({ libraries: [{ id: 'private-library' }] }); await pending;
    assert.deepEqual(f.commits, []); assert.deepEqual(f.refreshes, []);
    f.refresh.dispose();
});
test('removed library switches to an allowed library and generic events expose no removed IDs', async () => {
    const f = fixture(path => path === '/api/libraries' ? { libraries: [{ id: 'library-two' }] } : { id: 'book-one', media: {} });
    f.refresh.notify('library_changed', {}); await f.refresh.flush();
    assert.deepEqual(f.routes, ['/library/library-two']);
    assert.deepEqual(f.refreshes, [null]);
    assert.deepEqual(f.errors, []); f.refresh.dispose();
});
test('a deleted detail item leaves the stale page while a network failure preserves it', async () => {
    for (const status of [404, 503]) {
        const f = fixture(path => {
            if (path.startsWith('/api/items/')) return Promise.reject(Object.assign(new Error('Request failed'), { status }));
            return path === '/api/libraries' ? { libraries: [{ id: 'library-one' }] } : { library: { id: 'library-one' } };
        });
        f.refresh.notify('library_changed', {}); await f.refresh.flush();
        assert.deepEqual(f.routes, status === 404 ? ['/library/library-one'] : []);
        assert.equal(f.errors.length, status === 503 ? 1 : 0);
        f.refresh.dispose();
    }
});
