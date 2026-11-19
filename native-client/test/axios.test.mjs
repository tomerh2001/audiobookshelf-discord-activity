import assert from 'node:assert/strict';
import test from 'node:test';
import install from '../src/axios.js';
test('request errors preserve only safe status for invalidation and never raw upstream details', async () => {
    let onError;
    install({ $axios: { onRequest() {}, onResponse() {}, onError(callback) { onError = callback; } }, app: {} });
    await assert.rejects(onError({ message: 'private server URL', response: { status: 404, data: 'secret body' }, config: { url: '/abs/private-capability' } }), error => {
        assert.equal(error.status, 404);
        assert.equal(error.message, 'Audiobookshelf could not complete this request.');
        assert.equal(error.response, undefined); assert.equal(error.config, undefined);
        assert.deepEqual(Object.keys(error), ['status']); return true;
    });
});

test('late failures from a replaced account cannot reconnect or expose errors in the current account', async () => {
    let onRequest, onError, reconnects = 0;
    const app = { $activity: { baseUrl: '/abs/old-viewer', state: { accountRevision: 1 }, reconnect() { reconnects++; } } };
    install({ $axios: { onRequest(callback) { onRequest = callback; }, onResponse() {}, onError(callback) { onError = callback; } }, app });
    const oldRequest = onRequest({ url: '/api/session/old-session/sync', headers: {} });
    app.$activity.baseUrl = '/abs/new-viewer';
    app.$activity.state.accountRevision++;
    for (const status of [401, 403, 404, 502]) {
        await assert.rejects(onError({ message: 'private error', response: { status, data: 'private body' }, config: oldRequest }), error => {
            assert.equal(error.message, 'This account changed.');
            assert.deepEqual(Object.keys(error), ['activityStale']);
            assert.equal(error.activityStale, true);
            return true;
        });
    }
    assert.equal(reconnects, 0);
    const currentRequest = onRequest({ url: '/api/session/current-session/sync', headers: {} });
    await assert.rejects(onError({ response: { status: 401 }, config: currentRequest }), { status: 401 });
    assert.equal(reconnects, 1);
});
