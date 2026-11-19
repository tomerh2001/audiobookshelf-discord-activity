import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createActivityController, preferredAccount } from '../src/controller.js';
import { createAccountRecovery } from '../src/accountRecovery.js';

// Execute the shipped runtime with only browser/Nuxt dependencies substituted.
// The account controller and recovery state machines are the production code.
const source = (await readFile(new URL('../src/runtime.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gm, '').replace('export default async function', 'return async function');
const flush = () => new Promise(resolve => setImmediate(resolve));
async function fixture() {
    const timers = [], routes = [], counters = { disposed: 0, resume: 0, launch: 0 };
    const connection = { id: 'saved', serverId: 'server' };
    const party = { id: 'party', groupId: 'group', serverId: 'server' };
    const session = token => ({ discord: {}, exchange: { appToken: token, expiresAt: new Date(Date.now() + 3600000).toISOString() } });
    let rejected, activity;
    const broker = {
        onSessionRejected: listener => { rejected = listener; return () => {}; },
        startActivitySession: async () => session('initial'),
        resumeActivitySession: async () => { counters.resume++; return session('renewed'); },
        getConnections: async () => ({ connections: [connection], preferredConnectionId: connection.id }),
        getParty: async () => party,
        matchesPartyServer: () => true,
        savePreference: async () => {},
        launchNative: async () => { counters.launch++; return { baseUrl: '/abs/viewer', userId: 'reader', serverId: 'server', deviceId: 'device', accessToken: 'native' }; },
        createPresenceDiagnostics: () => ({ report() {}, dispose() {} }),
        observeActivityParticipants: () => ({ dispose() {} }), observeActivityPresentation: () => () => {},
        createWatchPresence: () => ({ dispose() {} }),
        normalizeNativeRoute: route => route?.startsWith('/library/') ? route : undefined,
        saveNativeRestore: async () => {}
    };
    const store = { state: { user: { user: null }, libraries: { currentLibraryId: null } },
        commit(name, value) {
            if (name === 'user/setUser') this.state.user.user = value;
            if (name === 'libraries/setCurrentLibrary') this.state.libraries.currentLibraryId = value.id;
        }, dispatch: async () => {} };
    const app = { $config: {}, router: { currentRoute: { path: '/library/books', fullPath: '/library/books' },
        replace: async route => { routes.push(route); }, afterEach: () => () => {} }, $toast: { error() {} }, $eventBus: {} };
    const dependencies = {
        randomId: () => 'device', Vue: { observable: value => value }, createActivityController, preferredAccount, createAccountRecovery,
        createActivitySocket: () => ({ start() {}, close() {} }),
        createNativePlayer: () => ({ start: async () => {}, dispose() { counters.disposed++; } }),
        onDocumentExit: () => () => {}, createLibraryRefresh: () => ({ dispose() {} }), refreshNativeBrowse() {},
        window: { AudiobookshelfWatch: broker }, localStorage: { setItem() {} },
        fetch: async () => ({ ok: true, json: async () => ({ user: { id: 'reader' } }) }),
        setInterval: callback => { timers.push(callback); return timers.length; }, clearInterval() {}
    };
    const runtime = new Function(...Object.keys(dependencies), source)(...Object.values(dependencies));
    await runtime({ app, store, $axios: { $get: async () => ({ libraries: [{ id: 'books' }] }) }, redirect: route => routes.push(route) },
        (_name, value) => { activity = value; app.$activity = value; });
    activity.attach({});
    return { activity, broker, store, counters, routes, connection, reject: token => rejected(token),
        poll: async () => { timers[0](); await flush(); await flush(); } };
}

test('a transient party GET failure preserves native playback and clears after the next healthy poll', async () => {
    const f = await fixture();
    const healthy = f.broker.getParty;
    f.broker.getParty = async () => { throw new Error('temporary network error'); };
    await f.poll();
    assert.match(f.activity.state.error, /connection was interrupted/);
    assert.equal(f.counters.disposed, 0);
    assert.equal(f.store.state.user.user.id, 'reader');
    assert.equal(f.counters.resume, 0);
    f.broker.getParty = healthy;
    await f.poll();
    assert.equal(f.activity.state.error, '');
    assert.equal(f.counters.disposed, 0);
});

test('failed recovery stops playback, opens login and cannot resume again from initial login load or polling', async () => {
    const f = await fixture();
    f.broker.resumeActivitySession = async () => { f.counters.resume++; throw new Error('Membership unavailable'); };
    f.reject('initial');
    const pending = f.activity.reconnect();
    assert.equal(f.counters.disposed, 1);
    assert.equal(f.activity.baseUrl, '');
    await pending;
    assert.equal(f.store.state.user.user, null);
    assert.equal(f.routes.at(-1), '/login');
    assert.equal(f.counters.resume, 1);
    await assert.rejects(f.activity.load(false), { recoveryRequired: true });
    await f.poll(); await f.activity.reconnect();
    assert.equal(f.counters.resume, 1);
    await assert.rejects(f.activity.load(true), { recoveryRequired: true });
    assert.equal(f.counters.resume, 2, 'only the explicit login retry permits another resume');
});

test('explicit saved-account selection after failed recovery resets both retry guards', async () => {
    const f = await fixture();
    const healthy = f.broker.resumeActivitySession;
    f.broker.resumeActivitySession = async () => { f.counters.resume++; throw new Error('temporary membership failure'); };
    f.reject('initial'); await f.activity.reconnect();
    f.broker.resumeActivitySession = healthy;
    await f.activity.select(f.connection);
    assert.equal(f.counters.resume, 2);
    assert.equal(f.counters.launch, 2);
    assert.equal(f.store.state.user.user.id, 'reader');
    assert.equal(f.activity.state.error, '');
});
