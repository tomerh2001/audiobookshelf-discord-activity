/** Socket messages invalidate data; authorized HTTP responses supply its content. */
export function createLibraryRefresh({ store, axios, router, eventBus, isCurrent, onRefresh, onError, host = window }) {
    let timer, running = false, closed = false, all = false;
    const items = new Set();
    const active = () => !closed && isCurrent();
    const schedule = () => { if (!closed && !timer && !running) timer = host.setTimeout(() => { timer = undefined; void flush(); }, 150); };
    async function flush() {
        if (running || !active() || (!all && !items.size)) return;
        host.clearTimeout(timer); timer = undefined;
        const ids = all ? null : [...items]; all = false; items.clear(); running = true;
        try {
            const libraryId = store.state.libraries.currentLibraryId;
            const wanted = new Set([store.state.selectedLibraryItem?.id, store.state.streamLibraryItem?.id,
                router.currentRoute.path.startsWith('/item/') ? router.currentRoute.params.id : null]
                .filter(id => id && (!ids || ids.includes(id))));
            const [listing, updated] = await Promise.all([
                axios.$get('/api/libraries'),
                Promise.all([...wanted].map(async id => {
                    try { const item = await axios.$get(`/api/items/${encodeURIComponent(id)}?expanded=1`); return { id, item: item?.id === id ? item : null }; }
                    catch (error) { if ([403, 404].includes(error.status)) return { id, item: null }; throw error; }
                }))
            ]);
            if (!active()) return;
            const libraries = Array.isArray(listing.libraries) ? listing.libraries : [];
            store.commit('libraries/set', libraries); store.commit('libraries/setLastLoad', Date.now());
            const current = libraries.find(library => library.id === libraryId);
            if (libraryId === store.state.libraries.currentLibraryId && !current) {
                const next = libraries[0]?.id || null;
                store.commit('libraries/setCurrentLibrary', { id: next });
                store.commit('libraries/setCollections', []); store.commit('libraries/setUserPlaylists', []);
                store.commit('libraries/setLibraryFilterData', null);
                await router.replace(next ? `/library/${next}` : '/').catch(() => {});
            } else if (current) {
                const details = await axios.$get(`/api/libraries/${encodeURIComponent(libraryId)}?include=filterdata`);
                if (!active()) return;
                if (store.state.libraries.currentLibraryId === libraryId && details.library?.id === libraryId) {
                    store.commit('libraries/addUpdate', details.library);
                    store.commit('libraries/setLibraryFilterData', details.filterdata);
                    store.commit('libraries/setLibraryIssues', details.issues || 0);
                    store.commit('libraries/setNumUserPlaylists', details.numUserPlaylists || 0);
                }
            }
            if (!active()) return;
            for (const { id, item } of updated) {
                if (!item) {
                    if (store.state.selectedLibraryItem?.id === id) store.commit('setSelectedLibraryItem', null);
                    if (router.currentRoute.path === `/item/${id}`) await router.replace(store.state.libraries.currentLibraryId ? `/library/${store.state.libraries.currentLibraryId}` : '/').catch(() => {});
                    if (!active()) return;
                    continue;
                }
                if (store.state.selectedLibraryItem?.id === item.id) store.commit('setSelectedLibraryItem', item);
                if (store.state.streamLibraryItem?.id === item.id) store.commit('updateStreamLibraryItem', item);
                eventBus.$emit(`${item.id}_updated`, item);
            }
            if (active()) await onRefresh(ids);
        } catch { if (active()) onError('The library could not refresh. Try opening it again.'); }
        finally { running = false; if (active() && (all || items.size)) schedule(); }
    }
    return {
        notify(event, payload) {
            if (closed) return false;
            if (event === 'library_changed') all = true;
            else if (event === 'items_changed') {
                for (const id of Array.isArray(payload?.itemIds) ? payload.itemIds : []) {
                    if (typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id)) items.add(id);
                    if (items.size > 500) { all = true; items.clear(); break; }
                }
            } else return false;
            schedule(); return true;
        },
        flush,
        dispose() { closed = true; host.clearTimeout(timer); items.clear(); }
    };
}
