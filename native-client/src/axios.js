/** Native requests never leave the selected server's capability gateway. */
export default function ({ $axios, app }) {
    $axios.onRequest(config => {
        const activity = app.$activity;
        if (!activity?.baseUrl) throw new Error('Sign in to Audiobookshelf first.');
        const path = config.url || '';
        if (!path.startsWith('/') || path.startsWith('//') || /[\\\u0000-\u001f]/.test(path)) throw new Error('Invalid media request.');
        config.baseURL = activity.baseUrl;
        config.activityRevision = activity.state.accountRevision;
        config.withCredentials = false;
        delete config.headers.common?.Authorization;
        delete config.headers.Authorization;
        return config;
    });
    $axios.onResponse(response => {
        if (response.config.activityRevision !== app.$activity?.state.accountRevision) throw Object.assign(new Error('This account changed.'), { activityStale: true });
        return response;
    });
    $axios.onError(error => {
        if (error.activityStale) return Promise.reject(error);
        const status = Number.isInteger(error.response?.status) ? error.response.status : undefined;
        if (status === 401) app.$activity?.reconnect();
        // Do not print upstream errors or capability-bearing request configs.
        return Promise.reject(Object.assign(new Error(status === 403 ? 'This account cannot access that item.' : 'Audiobookshelf could not complete this request.'), { status }));
    });
}
