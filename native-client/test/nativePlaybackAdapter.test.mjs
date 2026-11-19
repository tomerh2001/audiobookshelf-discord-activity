import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createNativePlayer } from '../src/nativePlaybackAdapter.js';
const { JSDOM } = createRequire(new URL('../../apps/activity-web/package.json', import.meta.url))('jsdom');
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture({ getItem, finished = false } = {}) {
    const { window } = new JSDOM('<body></body>', { url: 'https://activity.example/' });
    const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
    globalThis.window = window; globalThis.document = window.document;
    let state = { epoch: 'party', revision: 0, queueRevision: 0, queue: [], index: -1, positionTicks: 0, paused: true, playbackRate: 1, repeatMode: 'RepeatNone', serverTimeMs: Date.now() };
    const events = [], commands = [], loads = [], errors = [], blocked = [];
    let listener;
    const handlers = { getCurrentTime: () => handlers.time, getDuration: () => 120, time: 0, playerState: 'PLAYING', playerPlaying: false, libraryItemId: null, episodeId: null,
        closePlayer() { handlers.libraryItemId = null; handlers.libraryItem = null; handlers.player = null; },
        load(item, episodeId, playing, rate, time) {
            loads.push({ item, episodeId, playing, rate, time });
            handlers.libraryItemId = item.id; handlers.libraryItem = item; handlers.episodeId = episodeId; handlers.time = time;
            const audio = window.document.createElement('audio'); window.document.body.append(audio);
            Object.defineProperty(audio, 'readyState', { value: 4 });
            audio.play = () => { events.push('element-play'); return Promise.resolve(); };
            handlers.player = { player: audio, currentTrack: { startOffset: 60 } }; handlers.playerPlaying = playing;
        },
        seek(time) { handlers.time = time; events.push(`seek:${time}`); },
        play() { events.push('play'); handlers.playerPlaying = true; },
        pause() { events.push('pause'); handlers.playerPlaying = false; },
        setPlaybackRate(rate) { handlers.rate = rate; events.push(`rate:${rate}`); }
    };
    const store = { state: { playerQueueItems: [] }, getters: { 'user/getUserMediaProgress': () => ({ currentTime: 20, isFinished: finished }), 'libraries/getBookCoverAspectRatio': 1 },
        commit(type, payload) { if (type === 'setMediaPlaying') store.state.playerQueueItems = payload?.queueItems || []; if (type === 'setPlayerQueueItems') store.state.playerQueueItems = payload; }, subscribe() { return () => {}; } };
    const socket = { isWebSocketOpen: () => true, subscribe(_types, callback) { listener = callback; return () => {}; }, _sdk: { webSocket: { onStatusChange: () => () => {}, sendMessage({ Data: command }) {
        events.push('send'); commands.push(command); state = { ...state, revision: state.revision + 1, command: { ...command, clientId: 'viewer' }, serverTimeMs: Date.now() };
        if (command.type === 'setQueue') { state.queue = command.queue; state.index = command.index; state.positionTicks = command.positionTicks; state.paused = command.paused; state.queueRevision++; }
        if (command.type === 'setPlayback') { state.paused = command.paused; state.positionTicks = command.positionTicks; }
        if (command.type === 'seek') { state.positionTicks = command.positionTicks; state.paused = command.paused; }
        if (command.type === 'setPlaybackRate') state.playbackRate = command.playbackRate;
        if (command.type === 'stop') { state.queue = []; state.index = -1; state.paused = true; state.positionTicks = 0; state.queueRevision++; }
        listener({ MessageType: 'ActivityPlaybackState', Data: { snapshot: state, clientId: 'viewer', sequence: command.sequence, ack: command.id } });
    } } } };
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ snapshot: state, clientId: 'viewer', sequence: 0 }) });
    const component = { playerHandler: handlers, $store: store, $refs: { audioPlayer: { checkUpdateChapterTrack() {} } }, $nextTick: callback => callback(), $axios: { $get: getItem || (async path => ({ id: path.split('/')[3].split('?')[0], media: { metadata: { title: 'Book' }, episodes: [{ id: 'ep-1' }] } })) } };
    const adapter = createNativePlayer({ component, socket, baseUrl: '/abs/fixture', onError: value => errors.push(value), onBlocked: value => blocked.push(value) });
    return { adapter, commands, events, loads, handlers, errors, blocked, window,
        close() { adapter.dispose(); window.close(); Object.assign(globalThis, previous); } };
}
test('native selection uses whole-book resume time and every viewer can immediately pause, seek and change speed', async () => {
    const f = fixture();
    try {
        await f.adapter.start(); await f.adapter.playSelection({ libraryItemId: 'book-one' }); await flush();
        assert.equal(f.loads[0].time, 20); assert.equal(f.loads[0].item.id, 'book-one');
        f.events.length = 0; await f.adapter.pause();
        assert.ok(f.events.indexOf('pause') < f.events.indexOf('send'));
        await f.adapter.seek(75); assert.equal(f.handlers.time, 75); assert.equal(f.commands.at(-1).positionTicks, 750000000);
        await f.adapter.rate(1.5); assert.equal(f.handlers.rate, 1.5); assert.equal(f.commands.at(-1).type, 'setPlaybackRate');
    } finally { f.close(); }
});
test('late item fetch cannot reopen audio after Stop or account disposal', async () => {
    let resolve;
    const f = fixture({ getItem: () => new Promise(done => { resolve = done; }) });
    try {
        await f.adapter.start(); await f.adapter.playSelection({ libraryItemId: 'book-one' });
        await f.adapter.stop(); resolve({ id: 'book-one', media: {} }); await flush();
        assert.equal(f.loads.length, 0);
    } finally { f.close(); }
});
test('podcast episode identity survives the shared queue and native player call', async () => {
    const f = fixture();
    try {
        await f.adapter.start(); await f.adapter.playSelection({ libraryItemId: 'podcast-one', episodeId: 'ep-1', startTime: 8 }); await flush();
        assert.equal(f.commands[0].queue[0].episodeId, 'ep-1'); assert.equal(f.loads[0].episodeId, 'ep-1'); assert.equal(f.loads[0].time, 8);
    } finally { f.close(); }
});
test('autoplay unlock acts on the exact media element and preserves a shared pause', async () => {
    const f = fixture();
    try {
        await f.adapter.start(); await f.adapter.playSelection({ libraryItemId: 'book-one' }); await flush(); await f.adapter.pause();
        f.handlers.player.player.dispatchEvent(new f.window.Event('audiobookshelf-activity-playback-blocked', { bubbles: true }));
        assert.equal(f.blocked.at(-1), true);
        const count = f.commands.length;
        f.adapter.unlock(); assert.equal(f.events.at(-1), 'element-play'); await flush();
        assert.equal(f.handlers.playerPlaying, false); assert.equal(f.commands.length, count);
    } finally { f.close(); }
});
test('a personal sleep timer pauses only the local player and does not broadcast a group pause', async () => {
    const f = fixture();
    try { await f.adapter.start(); await f.adapter.playSelection({ libraryItemId: 'book-one' }); await flush(); const count = f.commands.length; f.adapter.localPause(); assert.equal(f.handlers.playerPlaying, false); assert.equal(f.commands.length, count); }
    finally { f.close(); }
});

test('finished audiobooks restart at zero unless a deliberate start position is supplied', async () => {
    const f = fixture({ finished: true });
    try { await f.adapter.start(); await f.adapter.playSelection({ libraryItemId: 'finished-book' }); await flush(); assert.equal(f.loads[0].time, 0); }
    finally { f.close(); }
});
test('shared pause and seek received during native loading survive until media readiness', async () => {
    const f = fixture();
    try {
        await f.adapter.start(); await f.adapter.playSelection({ libraryItemId: 'book-one' }); await flush();
        f.handlers.playerState = 'LOADING';
        await f.adapter.pause(); await f.adapter.seek(70);
        assert.equal(f.handlers.playWhenReady, false); assert.equal(f.handlers.player.playWhenReady, false); assert.equal(f.handlers.startTimeOverride, 70);
        f.handlers.playerState = 'LOADED';
        f.handlers.player.player.dispatchEvent(new f.window.Event('loadedmetadata'));
        assert.equal(f.handlers.time, 70); assert.equal(f.handlers.playerPlaying, false);
    } finally { f.close(); }
});
