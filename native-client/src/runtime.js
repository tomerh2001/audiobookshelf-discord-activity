import { randomId } from './randomId.js';
import Vue from 'vue';
import { createActivityController, preferredAccount } from './controller';
import { createActivitySocket } from './activitySocket';
import { createNativePlayer } from './nativePlaybackAdapter';
import { onDocumentExit } from './lifecycle';
import { createLibraryRefresh } from './libraryRefresh';
import { refreshNativeBrowse } from './browseRefresh';

/** Nuxt owns the document. Discord and upstream credentials are separate. */
export default async function (context, inject) {
    const { app, store, $axios } = context;
    const broker = window.AudiobookshelfWatch;
    const state = Vue.observable({ error: '', accountRevision: 0, browseRevision: 0, rosterOpen: false, roster: { participants: [], loading: true }, ready: false, blocked: false, preview: false, snapshot: null });
    let socket, player, component, presence, roster, presentation, libraryRefresh, pendingRecovery, checkpoint = 0, closed = false;
    let history = [], routeStop, pollTimer, checkpointTimer;
    const activity = {
        state, baseUrl: '', controller: null,
        get player() { return player; },
        call: (...args) => controller.call(...args),
        async load() { await ensureStart(); controller.retryRecovery(); state.error = ''; return controller.load(); },
        async select(connection) { await controller.select(connection); if (store.state.user.user) await home(); },
        async openExternal(url) {
            const parsed = new URL(url, window.location.origin);
            if (parsed.protocol !== 'https:' && !(controller.session.discord.isMock && parsed.protocol === 'http:')) throw new Error('Sign-in requires a secure browser link.');
            if (controller.session.discord.sdk) return controller.session.discord.sdk.commands.openExternalLink({ url: parsed.href });
            window.open(parsed.href, '_blank', 'noopener,noreferrer');
        },
        async logout() { await controller.logoutAccount(); teardownAccount(); clearAccount(); history = []; await app.router.replace('/login'); },
        async switchAccounts() { controller.cancelSelection(); teardownAccount(); clearAccount(); history = []; await app.router.replace('/login'); },
        async leave() { await controller.leave(); teardownAccount(); clearAccount(); closed = true; state.error = 'You have left the listening party.'; await app.router.replace('/login'); },
        reconnect() {
            if (closed || pendingRecovery || !controller.selection) return pendingRecovery;
            const connection = controller.selection;
            pendingRecovery = controller.select(connection).catch(() => { state.error = 'Connection interrupted. Open your account and try connecting again.'; }).finally(() => { pendingRecovery = undefined; });
            return pendingRecovery;
        },
        async retry() { controller.retryRecovery(); state.error = ''; return activity.reconnect(); },
        attach(value) { component = value; startPlayer(); },
        detach(value) { if (component === value) { player?.dispose(); player = undefined; component = undefined; } },
        roster() { state.rosterOpen = true; roster?.refresh(); },
        back() { if (activity.modalBack?.()) return; if (history.length > 1) { history.pop(); app.router.replace(history.pop() || '/'); } else app.router.replace('/'); },
        async home() { return home(); },
        unlock() { player?.unlock(); },
        async fullscreen() { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch { app.$toast?.error('Fullscreen is unavailable in this Discord view.'); } }
    };
    inject('activity', activity);
    const fail = message => { state.error = message; app.$toast?.error(message); };
    const controller = createActivityController(broker, install, randomId());
    activity.controller = controller;
    let startup;
    function ensureStart() {
        return startup ||= controller.start().then(session => {
            roster?.dispose(); presentation?.();
            roster = broker.observeActivityParticipants(session.discord, value => { state.roster = value; });
            presentation = broker.observeActivityPresentation(session.discord, value => { state.preview = value.preview; });
            state.ready = true;
            return session;
        }).catch(() => { startup = undefined; throw new Error('Discord could not connect. Open this app from a Discord voice Activity, or try again.'); });
    }
    function clearAccount() {
        store.commit('user/setUser', null); store.commit('user/setAccessToken', null);
        store.commit('setMediaPlaying', null); store.commit('setSelectedLibraryItem', null);
        store.commit('libraries/set', []); store.commit('libraries/setCurrentLibrary', { id: null });
        store.commit('libraries/setLastLoad', 0); store.commit('libraries/setCollections', []); store.commit('libraries/setUserPlaylists', []);
        state.accountRevision++; activity.baseUrl = ''; state.snapshot = null; state.blocked = false;
    }
    function teardownAccount() {
        libraryRefresh?.dispose(); libraryRefresh = undefined;
        player?.dispose(); player = undefined; socket?.close(); socket = undefined;
        presence?.dispose(); presence = undefined;
    }
    async function install(launch, connection, current) {
        if (!current()) return;
        // Verify native account before touching the active account or its player.
        const response = await fetch(`${launch.baseUrl}/api/me`, { credentials: 'omit', cache: 'no-store' });
        if (!response.ok) throw new Error('Audiobookshelf could not verify this account.');
        const payload = await response.json();
        if (!current()) return;
        const user = payload.user || payload;
        if (user.id !== launch.userId) throw new Error('Audiobookshelf returned another account.');
        const oldRoute = activity.baseUrl && broker.normalizeNativeRoute(app.router.currentRoute.fullPath, launch.serverId);
        teardownAccount(); clearAccount();
        activity.baseUrl = launch.baseUrl;
        app.$config.routerBasePath = launch.baseUrl;
        store.commit('setRouterBasePath', launch.baseUrl);
        localStorage.setItem('absDeviceId', launch.deviceId);
        store.commit('user/setAccessToken', launch.accessToken);
        store.commit('user/setUser', user);
        store.commit('setServerSettings', payload.serverSettings || { language: 'en-us', chromecastEnabled: false });
        store.dispatch('user/loadUserSettings');
        const libraries = await $axios.$get('/api/libraries');
        if (!current()) return;
        store.commit('libraries/set', libraries.libraries || []);
        const first = (libraries.libraries || [])[0];
        if (first) { store.commit('libraries/setCurrentLibrary', { id: first.id }); await store.dispatch('libraries/fetch', first.id); }
        if (!current()) return;
        const accountCurrent = () => !closed && activity.baseUrl === launch.baseUrl && store.state.user.user?.id === launch.userId;
        libraryRefresh = createLibraryRefresh({ store, axios: $axios, router: app.router, eventBus: app.$eventBus, isCurrent: accountCurrent,
            async onRefresh(ids) {
                player?.invalidateItems(ids);
                await refreshNativeBrowse(context, { isCurrent: accountCurrent, set: Vue.set,
                    remount: async () => { state.browseRevision++; await Vue.nextTick(); } });
            }, onError: message => app.$toast?.error(message) });
        const refresh = libraryRefresh;
        socket = createActivitySocket(launch.baseUrl, {
            onExpired: () => activity.reconnect(),
            onNativeEvent(event, value) {
                if (refresh.notify(event, value)) return;
                if (event === 'user_updated' && value?.id === store.state.user.user?.id) { store.commit('user/setUser', value); return; }
                if (['playlist_added', 'playlist_updated'].includes(event) && value?.userId === store.state.user.user?.id) { if (value.libraryId === store.state.libraries.currentLibraryId) store.commit('libraries/addUpdateUserPlaylist', value); app.$eventBus.$emit(event, value); return; }
                if (event === 'playlist_removed' && value?.userId === store.state.user.user?.id) { if (value.libraryId === store.state.libraries.currentLibraryId) store.commit('libraries/removeUserPlaylist', value); app.$eventBus.$emit(event, value); return; }
                const method = { stream_open: 'streamOpen', stream_closed: 'streamClosed', stream_progress: 'streamProgress', stream_ready: 'streamReady', stream_reset: 'streamReset', stream_error: 'streamError' }[event];
                if (method && component && typeof component[method] === 'function') component[method](event === 'stream_error' ? value?.id : value);
                if (event === 'stream_error') fail('Audiobookshelf could not continue this audio stream. Try Play again.');
            }
        });
        presence = broker.createWatchPresence(controller.session.discord);
        socket.start(); startPlayer(); state.error = '';
        const restored = oldRoute || broker.normalizeNativeRoute(launch.restoreRoute, launch.serverId);
        if (restored) await app.router.replace(restored).catch(() => {});
    }
    function startPlayer() {
        if (!component || !socket || !activity.baseUrl || player) return;
        player = createNativePlayer({ component, socket, baseUrl: activity.baseUrl, presence,
            onSnapshot: value => { state.snapshot = value; }, onBlocked: value => { state.blocked = value; }, onError: fail });
        void player.start().catch(() => {});
    }
    async function home() {
        const id = store.state.libraries.currentLibraryId;
        return app.router.replace(id ? `/library/${id}` : '/').catch(() => {});
    }
    function saveRoute(keepalive = false) {
        const selected = controller.selection;
        if (!selected || !controller.session || closed) return;
        const route = broker.normalizeNativeRoute(app.router.currentRoute.fullPath, selected.serverId);
        if (route) void broker.saveNativeRestore(controller.session.exchange.appToken, selected.id, route, ++checkpoint, keepalive).catch(() => {});
    }
    routeStop = app.router.afterEach(route => {
        if (route.path !== history.at(-1)) history.push(route.fullPath);
        history = history.slice(-100); saveRoute();
    });
    const removeExit = onDocumentExit(window, () => {
        saveRoute(true); closed = true; clearInterval(pollTimer); clearInterval(checkpointTimer);
        teardownAccount(); roster?.dispose(); presentation?.(); routeStop?.(); controller.dispose(); removeExit();
    });
    try {
        await ensureStart();
        const { data, party } = await controller.load();
        const preferred = preferredAccount(data, party, broker.matchesPartyServer);
        if (preferred) await controller.select(preferred);
    } catch (error) { state.error = error.message; }
    if (!store.state.user.user) context.redirect('/login');
    pollTimer = setInterval(() => {
        if (closed || !state.ready || state.error) return;
        void controller.poll().then(changed => {
            if (changed) { teardownAccount(); clearAccount(); return app.router.replace('/login'); }
            if (controller.needsLaunch) return activity.reconnect();
        }).catch(() => { state.error = 'The party connection was interrupted. Try connecting again.'; });
    }, 15_000);
    checkpointTimer = setInterval(() => saveRoute(), 15_000);
}
