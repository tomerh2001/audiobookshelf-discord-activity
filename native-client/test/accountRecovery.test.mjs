import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountRecovery } from '../src/accountRecovery.js';
import installAxios from '../src/axios.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('a current sync 401 stops the native session immediately and coalesces its replacement', async () => {
    const replacement = deferred();
    const account = { id: 'saved-account' };
    const calls = [];
    const activity = { baseUrl: '/abs/current', state: { accountRevision: 1 } };
    const recovery = createAccountRecovery({ getSelection: () => account,
        stop() { calls.push('stop'); activity.baseUrl = ''; activity.state.accountRevision++; },
        recover: connection => { assert.equal(connection, account); calls.push('replace'); return replacement.promise; },
        onRecovered: () => calls.push('recovered'), onError: () => calls.push('failed') });
    activity.reconnect = recovery.run;
    let onRequest, onError;
    installAxios({ app: { $activity: activity }, $axios: {
        onRequest(callback) { onRequest = callback; }, onResponse() {}, onError(callback) { onError = callback; }
    } });
    const request = onRequest({ url: '/api/session/native/sync', headers: {} });
    const rejection = onError({ config: request, response: { status: 401 } });
    assert.deepEqual(calls, ['stop'], 'the expired progress timer is stopped before awaiting any network response');
    const pending = recovery.run();
    assert.equal(recovery.run(), pending);
    await assert.rejects(rejection, { status: 401 });
    await assert.rejects(onError({ config: request, response: { status: 401 } }), { activityStale: true });
    assert.deepEqual(calls, ['stop', 'replace']);
    replacement.resolve(); await pending;
    assert.deepEqual(calls, ['stop', 'replace', 'recovered']);
    assert.equal(recovery.busy, false);
    assert.equal(recovery.blocked, false);
});

test('a failed replacement stops background retries until explicit retry', async () => {
    const calls = [];
    let fails = true;
    const recovery = createAccountRecovery({ getSelection: () => ({ id: 'saved-account' }),
        stop: () => calls.push('stop'), recover: async () => { calls.push('replace'); if (fails) throw new Error('Membership unavailable'); },
        onRecovered: () => calls.push('recovered'), onError: () => calls.push('failed') });
    await recovery.run();
    assert.equal(recovery.blocked, true);
    for (let attempt = 0; attempt < 10; attempt++) await recovery.run();
    assert.deepEqual(calls, ['stop', 'replace', 'failed']);
    fails = false;
    await recovery.retry();
    assert.equal(recovery.blocked, false);
    assert.deepEqual(calls, ['stop', 'replace', 'failed', 'stop', 'replace', 'recovered']);
});

test('stale recovery completion cannot clear or replace a newer account error', async () => {
    const old = deferred(), current = deferred();
    let selection = { id: 'first' };
    const messages = [];
    const recovery = createAccountRecovery({ getSelection: () => selection, stop() {},
        recover: account => account.id === 'first' ? old.promise : current.promise,
        onRecovered: () => messages.push('recovered'), onError: () => messages.push('failed') });
    const first = recovery.run(); await Promise.resolve();
    recovery.cancel(); selection = { id: 'second' };
    const second = recovery.run(); await Promise.resolve();
    old.reject(new Error('revoked old account')); await first;
    assert.equal(recovery.busy, true);
    assert.equal(recovery.blocked, false);
    assert.deepEqual(messages, []);
    current.resolve(); await second;
    assert.deepEqual(messages, ['recovered']);
});

test('leave cancels scheduled recovery and ignores in-flight results', async () => {
    const pending = deferred();
    const calls = [];
    const create = () => createAccountRecovery({ getSelection: () => ({ id: 'account' }), stop() {},
        recover() { calls.push('replace'); return pending.promise; },
        onRecovered: () => calls.push('recovered'), onError: () => calls.push('failed') });
    const before = create();
    const scheduled = before.run(); before.dispose(); await scheduled;
    assert.deepEqual(calls, []);
    const during = create();
    const started = during.run(); await Promise.resolve(); during.dispose();
    pending.reject(new Error('closed')); await started;
    assert.deepEqual(calls, ['replace']);
    assert.equal(during.retry(), undefined);
});

test('a late old-player close cannot recursively start a replacement while stopping', async () => {
    let stops = 0, replacements = 0;
    const recovery = createAccountRecovery({ getSelection: () => ({ id: 'account' }),
        stop() { stops++; recovery.run(); }, recover: async () => { replacements++; } });
    await recovery.run();
    assert.equal(stops, 1); assert.equal(replacements, 1);
});
