/** Refresh Nuxt 2 asyncData explicitly: changing its component key alone uses cached data. */
export async function refreshNativeBrowse(context, { isCurrent, remount, set }) {
    const { app, store, $axios } = context;
    const route = app.router.currentRoute;
    const active = () => isCurrent() && app.router.currentRoute === route;
    const check = () => { if (!active()) throw Object.assign(new Error('This page changed.'), { activityStale: true }); };
    const get = async (...args) => { check(); const result = await $axios.$get(...args); check(); return result; };
    const guardedStore = { ...store, state: store.state, getters: store.getters,
        async dispatch(action, value, options) {
            check();
            if (action !== 'libraries/fetch') return store.dispatch(action, value, options);
            const details = await get(`/api/libraries/${encodeURIComponent(value)}?include=filterdata`);
            if (details.library?.id !== value) throw new Error('The library could not refresh.');
            store.commit('libraries/addUpdate', details.library);
            store.commit('libraries/setLibraryFilterData', details.filterdata);
            store.commit('libraries/setLibraryIssues', details.issues || 0);
            store.commit('libraries/setNumUserPlaylists', details.numUserPlaylists || 0);
            store.commit('libraries/setCurrentLibrary', { id: value });
            return details;
        }
    };
    try {
        check(); await remount(); check();
        const pages = [...new Set(route.matched.map(record => record.instances?.default).filter(Boolean))];
        const freshContext = { ...context, route, params: route.params, query: route.query, store: guardedStore,
            app: { ...app, $axios: { ...$axios, $get: get } }, $axios: { ...$axios, $get: get },
            redirect(path) { if (active()) return app.router.replace(path).catch(() => {}); }
        };
        await Promise.all(pages.map(async page => {
            if (typeof page.$options.asyncData !== 'function') return;
            const data = await page.$options.asyncData(freshContext);
            check();
            if (!page._isDestroyed) for (const [key, value] of Object.entries(data || {})) set(page.$data, key, value);
        }));
    } catch (error) { if (!error.activityStale && active()) throw error; }
}
