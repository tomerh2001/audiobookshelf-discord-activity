import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createNativePlayer } from '../src/nativePlaybackAdapter.js';
const { JSDOM } = createRequire(new URL('../../apps/activity-web/package.json', import.meta.url))('jsdom');
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture({ getItem, finished = false, initialPlaying = false, initialReadyState = 4, onDiagnostic } = {}) {
    const { window } = new JSDOM('<body></body>', { url: 'https://activity.example/' });
    const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
    globalThis.window = window; globalThis.document = window.document;
    let state = { epoch: 'party', revision: 0, queueRevision: 0, queue: [], index: -1, positionTicks: 0, paused: true, playbackRate: 1, repeatMode: 'RepeatNone', serverTimeMs: Date.now() };
    const events = [], commands = [], loads = [], errors = [], blocked = [], presences = [];
    let presenceClears = 0;
    let listener;
    const handlers = { getCurrentTime: () => handlers.time, getDuration: () => 120, time: 0, playerState: 'PLAYING', playerPlaying: false, libraryItemId: null, episodeId: null,
        closePlayer() { handlers.libraryItemId = null; handlers.libraryItem = null; handlers.player = null; },
        load(item, episodeId, playing, rate, time) {
            loads.push({ item, episodeId, playing, rate, time });
            handlers.libraryItemId = item.id; handlers.libraryItem = item; handlers.episodeId = episodeId; handlers.time = time;
            const audio = window.document.createElement('audio'); window.document.body.append(audio);
            handlers.audioReadyState = initialReadyState;
            Object.defineProperty(audio, 'readyState', { get: () => handlers.audioReadyState });
            handlers.audioPaused = !initialPlaying;
            Object.defineProperty(audio, 'paused', { get: () => handlers.audioPaused });
            audio.play = () => { events.push('element-play'); handlers.audioPaused = false; return Promise.resolve(); };
            handlers.player = { player: audio, currentTrack: { startOffset: 60 } }; handlers.playerPlaying = playing;
        },
        seek(time) { handlers.time = time; events.push(`seek:${time}`); },
        play() { events.push('play'); handlers.playerPlaying = true; handlers.audioPaused = false; },
        pause() { events.push('pause'); handlers.playerPlaying = false; handlers.audioPaused = true; },
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
        if (command.type === 'select') { state.index = state.queue.findIndex(entry => entry.id === command.queueItemId); state.positionTicks = command.positionTicks; state.paused = command.paused; }
        if (command.type === 'stop') { state.queue = []; state.index = -1; state.paused = true; state.positionTicks = 0; state.queueRevision++; }
        listener({ MessageType: 'ActivityPlaybackState', Data: { snapshot: state, clientId: 'viewer', sequence: command.sequence, ack: command.id } });
    } } } };
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ snapshot: state, clientId: 'viewer', sequence: 0 }) });
    const component = { playerHandler: handlers, $store: store, $refs: { audioPlayer: { checkUpdateChapterTrack() {} } }, $nextTick: callback => callback(), $axios: { $get: getItem || (async path => ({ id: path.split('/')[3].split('?')[0], media: { metadata: { title: 'Book' }, episodes: [{ id: 'ep-1', title: 'Episode One' }] } })) } };
    const adapter = createNativePlayer({ component, socket, baseUrl: '/abs/fixture', presence: { update: value => presences.push(value), clear: () => presenceClears++ }, onError: value => errors.push(value), onBlocked: value => blocked.push(value), onDiagnostic });
    return { adapter, commands, events, loads, handlers, errors, blocked, window, presences, get presenceClears() { return presenceClears; },
        playing() { handlers.audioPaused = false; handlers.playerPlaying = true; handlers.player.player.dispatchEvent(new window.Event('playing')); },
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

test('Play next and reorder retain duplicate identities, active position and pause state', async () => {
    const f = fixture();
    try {
        await f.adapter.start(); await f.adapter.playSelection({ libraryItemId: 'book-one', queueItems: [{ libraryItemId: 'book-one' }, { libraryItemId: 'book-two' }, { libraryItemId: 'book-one' }] }); await flush();
        await f.adapter.pause(); await f.adapter.seek(51);
        const original = f.adapter.getSnapshot().queue, active = original[0].id, duplicate = original[2].id;
        assert.notEqual(active, duplicate);
        await f.adapter.moveQueueItem(duplicate, 0);
        let state = f.adapter.getSnapshot();
        assert.equal(state.queue[state.index].id, active); assert.equal(state.positionTicks, 510000000); assert.equal(state.paused, true);
        await f.adapter.playNext(duplicate);
        state = f.adapter.getSnapshot();
        assert.equal(state.queue[state.index + 1].id, duplicate);
        await f.adapter.queueSelection({ libraryItemId: 'book-three' });
        state = f.adapter.getSnapshot();
        assert.equal(state.queue[state.index + 1].itemId, 'book-three'); assert.equal(state.queue[state.index + 2].id, duplicate);
        assert.equal(state.positionTicks, 510000000); assert.equal(state.paused, true);
        const commands = f.commands.length;
        f.adapter.moveQueueItem('missing', 0); f.adapter.moveQueueItem(active, -1); f.adapter.playNext(active);
        assert.equal(f.commands.length, commands);
    } finally { f.close(); }
});
test('queueing with an empty party starts the requested episode', async () => {
    const f = fixture();
    try { await f.adapter.start(); await f.adapter.queueSelection({ libraryItemId: 'podcast', episodeId: 'ep-1' }); await flush(); assert.equal(f.loads[0].episodeId, 'ep-1'); }
    finally { f.close(); }
});
test('shuffle retains all queue identities and clear upcoming preserves the current book and position', async () => {
    const f = fixture();
    try {
        await f.adapter.start(); await f.adapter.playSelection({ libraryItemId: 'book-two', queueItems: [{ libraryItemId: 'book-one' }, { libraryItemId: 'book-two' }, { libraryItemId: 'book-one' }] }); await flush();
        await f.adapter.pause(); await f.adapter.seek(37);
        const before = f.adapter.getSnapshot(), active = before.queue[before.index];
        await f.adapter.shuffleQueue();
        const shuffled = f.adapter.getSnapshot();
        assert.deepEqual(shuffled.queue.map(item => item.id).sort(), before.queue.map(item => item.id).sort());
        assert.equal(shuffled.index, 0); assert.equal(shuffled.queue[0].id, active.id);
        await f.adapter.clearUpcoming();
        const cleared = f.adapter.getSnapshot();
        assert.deepEqual(cleared.queue, [active]); assert.equal(cleared.paused, true); assert.equal(cleared.positionTicks, 370000000);
        assert.equal(f.loads.length, 1);
    } finally { f.close(); }
});
test('audible playback publishes a title and duration, paused state follows, and stop clears', async () => {
    const f = fixture();
    try {
        await f.adapter.start(); await f.adapter.playSelection({ libraryItemId: 'book-one' }); await flush();
        f.playing();
        assert.equal(f.presences.at(-1)?.title, 'Book'); assert.equal(f.presences.at(-1)?.durationMs, 120000); assert.equal(f.presences.at(-1)?.kind, 'audio');
        await f.adapter.pause(); await new Promise(resolve => setTimeout(resolve, 1050));
        assert.equal(f.presences.at(-1)?.paused, true);
        const cleared = f.presenceClears; await f.adapter.stop(); assert.ok(f.presenceClears > cleared);
    } finally { f.close(); }
});
test('podcast presence includes episode and show titles', async () => {
    const f = fixture();
    try {
        await f.adapter.start(); await f.adapter.playSelection({ libraryItemId: 'podcast-one', episodeId: 'ep-1' }); await flush(); f.playing();
        assert.equal(f.presences.at(-1)?.kind, 'podcast'); assert.equal(f.presences.at(-1)?.title, 'Episode One'); assert.equal(f.presences.at(-1)?.seriesName, 'Book');
    } finally { f.close(); }
});
test('diagnostics distinguish idle from observed playback without exposing metadata and cannot interrupt audio', async () => {
    const diagnostics = [];
    const f = fixture({ onDiagnostic: value => { diagnostics.push(value); throw new Error('Diagnostic observer unavailable'); } });
    try {
        await f.adapter.start(); await new Promise(resolve => setTimeout(resolve, 1050));
        assert.deepEqual(diagnostics.at(-1), { event: 'observer', reason: 'no_entry', playing: false, titlePresent: false });
        await f.adapter.playSelection({ libraryItemId: 'book-one' }); await flush(); f.playing();
        assert.deepEqual(diagnostics.at(-1), { event: 'observer', reason: 'ready', playing: true, titlePresent: true, audioReadyState: 4 });
        assert.equal(f.presences.at(-1)?.title, 'Book');
        assert.doesNotMatch(JSON.stringify(diagnostics), /Book|book-one|fixture/);
        assert.deepEqual(f.errors, []);
    } finally { f.close(); }
});
test('a missed playing event recovers actual audible playback; blocked autoplay never claims playback', async () => {
    for (const initialPlaying of [false, true]) {
        const f = fixture({ initialPlaying });
        try {
            await f.adapter.start(); await f.adapter.playSelection({ libraryItemId: 'book-one' }); await flush();
            if (!initialPlaying) f.handlers.player.player.dispatchEvent(new f.window.Event('audiobookshelf-activity-playback-blocked', { bubbles: true }));
            await new Promise(resolve => setTimeout(resolve, 1050));
            assert.equal(f.presences.length > 0, initialPlaying);
        } finally { f.close(); }
    }
});
test('late observation after a missed waiting event does not report a stalled element as playing', async () => {
    const f = fixture({ initialPlaying: true, initialReadyState: 2 });
    try {
        await f.adapter.start(); await f.adapter.playSelection({ libraryItemId: 'book-one' }); await flush();
        // The pinned ABS handler keeps PLAYING while the HTML element waits.
        assert.equal(f.handlers.playerPlaying, true);
        assert.equal(f.handlers.player.player.paused, false);
        await new Promise(resolve => setTimeout(resolve, 1050));
        assert.equal(f.presences.length, 0);
        f.handlers.audioReadyState = 3; f.playing();
        assert.equal(f.presences.at(-1)?.title, 'Book');
        assert.equal(f.presences.at(-1)?.buffering, false);
        assert.equal(f.presences.at(-1)?.paused, false);
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
