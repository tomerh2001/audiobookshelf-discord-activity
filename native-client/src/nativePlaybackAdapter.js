import { randomId } from './randomId.js';
import { createActivityPlaybackClient } from './activityPlaybackClient.js';
const TICKS = 10_000_000;
const seconds = ticks => Math.max(0, ticks / TICKS);
const identity = entry => entry ? `${entry.id}:${entry.itemId}:${entry.episodeId || ''}` : '';

/** Adapt the actual Audiobookshelf PlayerHandler and whole-book track timeline. */
export function createNativePlayer({ component: ctx, socket, baseUrl, presence, onSnapshot = () => {}, onBlocked = () => {}, onError = () => {}, now = () => Date.now() }) {
    const handler = ctx.playerHandler, store = ctx.$store;
    let closed = false, generation = 0, loadingIdentity = '', selectedIdentity = '', snapshot, suppressQueue = false;
    let pendingEffect, driftSeekAt = 0, stableSince = 0, sleeping = false, blocked = false, audio, played = false, buffering = false;
    const metadata = new Map(), itemCache = new Map(), itemPending = new Map();
    let queueHydration = 0, cacheRevision = 0;
    const engine = createActivityPlaybackClient({ baseUrl, apiClient: socket, apply, onError });
    const commit = (name, payload) => { suppressQueue = true; try { store.commit(name, payload); } finally { suppressQueue = false; } };
    const submit = (value, options) => { const promise = engine.submit(value, options); void promise.catch(() => {}); return promise; };
    function setBlocked(value) { blocked = value; onBlocked(value); }
    function currentAudio() { return handler.player?.player; }
    async function loadItem(id) {
        if (itemCache.has(id)) return itemCache.get(id);
        if (!itemPending.has(id)) {
            const revision = cacheRevision;
            const request = ctx.$axios.$get(`/api/items/${encodeURIComponent(id)}?expanded=1`).then(item => { if (!closed && revision === cacheRevision) itemCache.set(id, item); return item; }).finally(() => { if (itemPending.get(id) === request) itemPending.delete(id); });
            itemPending.set(id, request);
        }
        return itemPending.get(id);
    }
    function nativeMetadata(item, episodeId) {
        const episode = episodeId && item.media?.episodes?.find(value => value.id === episodeId);
        return { title: episode?.title || item.media?.metadata?.title || 'Audiobook', subtitle: episode ? item.media?.metadata?.title : item.media?.metadata?.authorName, caption: episode?.pubDate || '', duration: episode?.duration || item.media?.duration, coverPath: item.media?.coverPath };
    }
    async function hydrateQueue(queue) {
        const revision = ++queueHydration;
        const missing = [...new Set(queue.filter(entry => !metadata.get(`${entry.itemId}:${entry.episodeId || ''}`)?.duration).map(entry => entry.itemId))];
        let cursor = 0;
        await Promise.all(Array.from({ length: Math.min(4, missing.length) }, async () => {
            while (!closed && revision === queueHydration && cursor < missing.length) {
                const id = missing[cursor++];
                try { const item = await loadItem(id); if (closed || revision !== queueHydration) return; for (const entry of queue.filter(entry => entry.itemId === id)) metadata.set(`${id}:${entry.episodeId || ''}`, nativeMetadata(item, entry.episodeId)); } catch { /* Selected-item errors have actionable native feedback. */ }
            }
        }));
        if (!closed && revision === queueHydration && snapshot) commit('setPlayerQueueItems', queueForNative(snapshot.queue));
    }
    function queueForNative(queue) {
        return queue.map(entry => ({ ...(metadata.get(`${entry.itemId}:${entry.episodeId || ''}`) || {}),
            activityEntryId: entry.id, libraryItemId: entry.itemId, ...(entry.episodeId ? { episodeId: entry.episodeId } : {}) }));
    }
    function replaceQueue(queue) {
        const current = engine.getSnapshot();
        if (!current) return;
        if (!queue.length) return submit({ type: 'stop' });
        const active = current.queue[current.index];
        const selected = queue.findIndex(entry => entry.id === active?.id);
        return submit({ type: 'setQueue', queue, index: Math.max(0, selected),
            positionTicks: selected < 0 ? 0 : current.positionTicks, paused: current.paused });
    }
    function apply(next, effect = {}) {
        if (closed) return;
        snapshot = next; onSnapshot(next);
        const entry = next.queue[next.index];
        if (!entry) {
            generation++; loadingIdentity = ''; selectedIdentity = ''; sleeping = false; setBlocked(false);
            handler.closePlayer(); commit('setMediaPlaying', null); presence?.clear(); return;
        }
        commit('setPlayerQueueItems', queueForNative(next.queue));
        void hydrateQueue(next.queue);
        const key = identity(entry);
        if (key !== selectedIdentity || handler.libraryItemId !== entry.itemId || handler.episodeId !== (entry.episodeId || null)) {
            if (loadingIdentity !== key) void prepare(entry, next, key);
            return;
        }
        if (loadingIdentity) return;
        synchronize(next, effect);
    }
    async function prepare(entry, next, key) {
        const ownGeneration = ++generation;
        loadingIdentity = key; selectedIdentity = ''; sleeping = false; setBlocked(false); presence?.clear(); played = false;
        // Invalidates the previous native prepare before awaiting another item.
        handler.closePlayer();
        try {
            const item = await loadItem(entry.itemId);
            if (closed || generation !== ownGeneration || identity(snapshot?.queue[snapshot.index]) !== key) return;
            if (entry.episodeId && !item.media?.episodes?.some(episode => episode.id === entry.episodeId)) throw new Error('This podcast episode is unavailable.');
            metadata.set(`${entry.itemId}:${entry.episodeId || ''}`, nativeMetadata(item, entry.episodeId));
            commit('setMediaPlaying', { libraryItem: item, episodeId: entry.episodeId || null, queueItems: queueForNative(snapshot.queue) });
            ctx.coverAspectRatio = store.getters['libraries/getBookCoverAspectRatio'];
            ctx.currentPlaybackRate = snapshot.playbackRate || 1;
            ctx.$nextTick(() => ctx.$refs.audioPlayer?.checkUpdateChapterTrack());
            selectedIdentity = key; loadingIdentity = '';
            pendingEffect = { origin: "reconcile", type: "seek" };
            handler.load(item, entry.episodeId || null, !snapshot.paused, snapshot.playbackRate || 1, seconds(snapshot.positionTicks));
            observeAudio();
            stableSince = now();
        } catch {
            if (closed || generation !== ownGeneration) return;
            loadingIdentity = ''; selectedIdentity = ''; onError('The selected audiobook could not be loaded. Try Play again.');
        }
    }
    function synchronize(next, effect = {}) {
        if (!handler.player) return;
        if (handler.playerState === 'LOADING' || (currentAudio() && currentAudio().readyState < 1)) {
            pendingEffect = { ...effect, type: effect.type === 'seek' || pendingEffect?.type === 'seek' ? 'seek' : effect.type };
            handler.playWhenReady = !next.paused && !sleeping;
            handler.startTimeOverride = seconds(next.positionTicks);
            handler.initialPlaybackRate = next.playbackRate || 1;
            handler.player.playWhenReady = handler.playWhenReady;
            if (next.paused) handler.pause();
            return;
        }
        const target = seconds(next.positionTicks);
        const rate = next.playbackRate || 1;
        const actual = handler.getCurrentTime();
        const drift = target - actual;
        ctx.currentPlaybackRate = rate;
        if (ctx.$refs.audioPlayer) ctx.$refs.audioPlayer.playbackRate = rate;
        const explicit = ['seek', 'select', 'setQueue'].includes(effect.type) || effect.resumed;
        if (explicit || (next.paused && Math.abs(drift) > 0.25)) { handler.seek(target); stableSince = now(); }
        handler.setPlaybackRate(rate);
        if (next.paused || sleeping) {
            handler.pause(); handler.setPlaybackRate(rate); return;
        }
        if (effect.origin === 'local') { sleeping = false; setBlocked(false); }
        if (!handler.playerPlaying && !blocked) handler.play();
        if (effect.origin === 'local' || effect.resumed) stableSince = now();
    }
    function onPlaying() {
        played = true; buffering = false; stableSince = now(); setBlocked(false);
        const latest = engine.getSnapshot();
        if (latest?.paused || sleeping) handler.pause();
        if (pendingEffect && latest) { const effect = pendingEffect; pendingEffect = undefined; synchronize(latest, effect); }
        tick();
    }
    function onLoadedMetadata() {
        const latest = engine.getSnapshot();
        if (latest && pendingEffect) { const effect = pendingEffect; pendingEffect = undefined; synchronize(latest, effect); }
    }
    function onWaiting() { buffering = true; stableSince = now(); tick(); }
    function onBlockedEvent(event) { if (event.target === currentAudio()) setBlocked(true); }
    function observeAudio() {
        const next = currentAudio();
        if (next === audio) return;
        if (audio) { audio.removeEventListener('playing', onPlaying); audio.removeEventListener('waiting', onWaiting); audio.removeEventListener('loadedmetadata', onLoadedMetadata); }
        audio = next;
        // A native player may already be audible when its Activity observer attaches.
        // Recover from actual media state, never from a requested play or queue state.
        // ABS retains PLAYING during a stall; HAVE_CURRENT_DATA alone is not
        // enough when this observer also missed the element's waiting event.
        played = Boolean(audio && !audio.paused && !audio.ended && audio.readyState >= 3 && handler.playerPlaying);
        buffering = false;
        if (audio) { audio.addEventListener('playing', onPlaying); audio.addEventListener('waiting', onWaiting); audio.addEventListener('loadedmetadata', onLoadedMetadata); }
    }
    function tick() {
        if (closed) return;
        observeAudio();
        const value = engine.getSnapshot();
        if (!value) return;
        snapshot = value; onSnapshot(value);
        const entry = value.queue[value.index];
        if (!entry || loadingIdentity || selectedIdentity !== identity(entry)) return;
        if (pendingEffect && audio?.readyState >= 1 && handler.playerState !== 'LOADING') { const effect = pendingEffect; pendingEffect = undefined; synchronize(value, effect); }
        const rate = value.playbackRate || 1;
        const actual = handler.getCurrentTime(), target = seconds(value.positionTicks), drift = target - actual;
        if (audio && !audio.paused && audio.readyState >= 3 && !buffering && !value.paused && !sleeping && now() - stableSince > 3000) {
            const offset = handler.player.currentTrack?.startOffset || 0;
            let buffered = false;
            for (let index = 0; index < audio.buffered.length; index++) {
                if (target >= offset + audio.buffered.start(index) && target + Math.max(1, rate) < offset + audio.buffered.end(index)) buffered = true;
            }
            if (!buffered && Math.abs(drift) > 3 && now() - driftSeekAt > 15000 && now() - stableSince > 10000) { handler.seek(target, false); driftSeekAt = now(); stableSince = now(); }
            else if (buffered && Math.abs(drift) > 1.5 && now() - driftSeekAt > 3000) { handler.seek(target, false); driftSeekAt = now(); }
            else handler.setPlaybackRate(buffered && Math.abs(drift) > 0.25 ? rate * (drift > 0 ? 1.03 : 0.97) : rate);
        }
        if (played && audio && !audio.ended && handler.libraryItem) {
            const episode = entry.episodeId && handler.libraryItem.media?.episodes?.find(value => value.id === entry.episodeId);
            presence?.update({ kind: episode ? 'podcast' : 'audio',
                title: episode?.title || handler.displayTitle || handler.libraryItem.media?.metadata?.title || 'Audiobook',
                ...(episode ? { seriesName: handler.libraryItem.media?.metadata?.title } : {}),
                positionMs: actual * 1000, durationMs: handler.getDuration() * 1000, paused: audio.paused, buffering,
                playbackRate: rate });
        } else presence?.clear();
    }
    const timer = setInterval(tick, 1000);
    document.addEventListener('audiobookshelf-activity-playback-blocked', onBlockedEvent, true);
    const unsubscribe = store.subscribe(mutation => {
        if (closed || suppressQueue || !snapshot || !['setPlayerQueueItems', 'addItemToQueue', 'removeItemFromQueue'].includes(mutation.type)) return;
        const queue = (store.state.playerQueueItems || []).map(item => ({ id: item.activityEntryId || randomId(), itemId: item.libraryItemId, ...(item.episodeId ? { episodeId: item.episodeId } : {}) }));
        replaceQueue(queue);
    });
    return {
        start: () => engine.start(),
        getSnapshot: () => engine.getSnapshot(),
        invalidateItems(ids) {
            cacheRevision++; queueHydration++;
            if (!ids) { itemCache.clear(); itemPending.clear(); metadata.clear(); }
            else for (const id of ids) { itemCache.delete(id); itemPending.delete(id); for (const key of metadata.keys()) if (key.startsWith(`${id}:`)) metadata.delete(key); }
            if (snapshot) void hydrateQueue(snapshot.queue);
        },
        queueSelection(payload, mode = 'next') {
            if (!payload?.libraryItemId) return;
            const current = engine.getSnapshot();
            if (!current?.queue.length) return this.playSelection(payload);
            const values = payload.queueItems?.length ? payload.queueItems : [payload];
            const additions = values.map(item => {
                metadata.set(`${item.libraryItemId}:${item.episodeId || ''}`, item);
                return { id: randomId(), itemId: item.libraryItemId, ...(item.episodeId ? { episodeId: item.episodeId } : {}) };
            });
            const queue = [...current.queue];
            queue.splice(mode === 'next' ? current.index + 1 : queue.length, 0, ...additions);
            return replaceQueue(queue);
        },
        moveQueueItem(id, index) {
            const queue = [...engine.getSnapshot()?.queue || []];
            const from = queue.findIndex(entry => entry.id === id);
            if (from < 0 || !Number.isInteger(index) || index < 0 || index >= queue.length || from === index) return;
            queue.splice(index, 0, queue.splice(from, 1)[0]);
            return replaceQueue(queue);
        },
        playNext(id) {
            const current = engine.getSnapshot();
            const active = current?.queue[current.index];
            if (!active || active.id === id) return;
            const queue = current.queue.filter(entry => entry.id !== id), entry = current.queue.find(value => value.id === id);
            if (!entry) return;
            queue.splice(queue.findIndex(value => value.id === active.id) + 1, 0, entry);
            return replaceQueue(queue);
        },
        clearUpcoming() {
            const current = engine.getSnapshot(), entry = current?.queue[current.index];
            if (entry) return replaceQueue([entry]);
        },
        shuffleQueue() {
            const current = engine.getSnapshot(), active = current?.queue[current.index];
            if (!active) return;
            const queue = current.queue.filter(entry => entry.id !== active.id);
            for (let index = queue.length - 1; index > 0; index--) {
                const target = Math.floor(Math.random() * (index + 1));
                [queue[index], queue[target]] = [queue[target], queue[index]];
            }
            return replaceQueue([active, ...queue]);
        },
        playSelection(payload) {
            if (!payload?.libraryItemId) return;
            sleeping = false;
            const active = snapshot?.queue[snapshot.index];
            if (active?.itemId === payload.libraryItemId && active.episodeId === (payload.episodeId || undefined) && !payload.queueItems?.length) {
                if (Number.isFinite(payload.startTime)) return submit({ type: 'seek', positionTicks: payload.startTime * TICKS, paused: false });
                return this.play();
            }
            const items = payload.queueItems?.length ? payload.queueItems : [{ libraryItemId: payload.libraryItemId, episodeId: payload.episodeId }];
            const queue = items.map(item => {
                metadata.set(`${item.libraryItemId}:${item.episodeId || ''}`, item);
                return { id: randomId(), itemId: item.libraryItemId, ...(item.episodeId ? { episodeId: item.episodeId } : {}) };
            });
            let index = queue.findIndex(entry => entry.itemId === payload.libraryItemId && entry.episodeId === (payload.episodeId || undefined));
            if (index < 0) { queue.unshift({ id: randomId(), itemId: payload.libraryItemId, ...(payload.episodeId ? { episodeId: payload.episodeId } : {}) }); index = 0; }
            const progress = store.getters['user/getUserMediaProgress'](payload.libraryItemId, payload.episodeId);
            const position = Number.isFinite(payload.startTime) ? payload.startTime : (progress?.isFinished ? 0 : progress?.currentTime || 0);
            return submit({ type: 'setQueue', queue, index, positionTicks: position * TICKS, paused: false });
        },
        play() {
            sleeping = false; setBlocked(false);
            // Run play in the original user gesture, before any network work.
            if (handler.playerState === 'ERROR') { selectedIdentity = ''; void engine.refresh(true); return; }
            if (snapshot && !snapshot.paused && handler.player) handler.seek(seconds(engine.getSnapshot().positionTicks), false);
            handler.play();
            if (!snapshot) return;
            if (!snapshot.paused) { if (!handler.libraryItem) return engine.refresh(true); return; }
            return submit({ type: 'setPlayback', paused: false });
        },
        pause() { if (snapshot) return submit({ type: 'setPlayback', paused: true }); },
        playPause() { if (!snapshot) return; if (snapshot.paused || !handler.playerPlaying || sleeping || blocked) return this.play(); return this.pause(); },
        seek(time) { if (snapshot && Number.isFinite(time)) return submit({ type: 'seek', positionTicks: Math.max(0, time) * TICKS, paused: snapshot.paused }); },
        jump(delta) { return this.seek(handler.getCurrentTime() + delta); },
        rate(value) { if (Number.isFinite(value)) return submit({ type: 'setPlaybackRate', playbackRate: value }); },
        repeat(value) { return submit({ type: 'setRepeatMode', repeatMode: value }); },
        selectIndex(index, automatic = false) {
            const entry = snapshot?.queue[index];
            if (!entry) return;
            return submit({ type: 'select', queueItemId: entry.id, positionTicks: 0, paused: false }, { automatic });
        },
        next() { return this.selectIndex((snapshot?.index ?? -1) + 1); },
        previous() { return this.selectIndex((snapshot?.index ?? 0) - 1); },
        ended(itemId, episodeId) {
            const entry = snapshot?.queue[snapshot.index];
            if (!entry || entry.itemId !== itemId || (entry.episodeId || null) !== (episodeId || null)) return;
            if (snapshot.repeatMode === 'RepeatOne') { selectedIdentity = ''; return this.selectIndex(snapshot.index, true); }
            if (snapshot.index + 1 < snapshot.queue.length) return this.selectIndex(snapshot.index + 1, true);
            if (snapshot.repeatMode === 'RepeatAll') return this.selectIndex(0, true);
            return submit({ type: 'stop' }, { automatic: true });
        },
        stop() { return submit({ type: 'stop' }); },
        localPause() { sleeping = true; handler.pause(); },
        unlock() { sleeping = false; setBlocked(false); const element = currentAudio(); if (!element) return;
            // The exact existing element gets the synchronous user activation.
            const attempt = element.play();
            Promise.resolve(attempt).then(() => { if (snapshot?.paused) handler.pause(); else if (snapshot) handler.seek(seconds(engine.getSnapshot().positionTicks), false); }).catch(() => setBlocked(true));
        },
        dispose() { closed = true; generation++; clearInterval(timer); unsubscribe(); engine.dispose(); presence?.clear();
            document.removeEventListener('audiobookshelf-activity-playback-blocked', onBlockedEvent, true);
            if (audio) { audio.removeEventListener('playing', onPlaying); audio.removeEventListener('waiting', onWaiting); audio.removeEventListener('loadedmetadata', onLoadedMetadata); }
            handler.closePlayer(); onBlocked(false); }
    };
}
