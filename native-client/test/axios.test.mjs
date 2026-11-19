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
