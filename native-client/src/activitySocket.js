/** Capability scoped socket; it carries both Activity state and filtered native events. */
export function createActivitySocket(baseUrl, { host = window, onNativeEvent = () => {}, onExpired = () => {} } = {}) {
    let socket, timer, closed = false, attempts = 0;
    const listeners = new Set(), statuses = new Set();
    const emitStatus = value => { for (const listener of statuses) listener(value); };
    const connect = () => {
        if (closed) return;
        const url = new URL(`${baseUrl}/socket`, host.location.href);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        socket = new host.WebSocket(url.href);
        const current = socket;
        current.onopen = () => { if (closed || socket !== current) return; attempts = 0; emitStatus(1); };
        current.onmessage = event => {
            if (closed || socket !== current) return;
            let message;
            try { message = JSON.parse(event.data); } catch { return; }
            if (message?.MessageType === 'AudiobookshelfEvent') {
                onNativeEvent(message.Data?.event, message.Data?.payload);
            } else for (const { types, callback } of listeners) if (types.includes(message?.MessageType)) callback(message);
        };
        current.onerror = () => {};
        current.onclose = () => {
            if (closed || socket !== current) return;
            emitStatus(0);
            if (++attempts > 6) { onExpired(); return; }
            timer = host.setTimeout(connect, Math.min(500 * 2 ** attempts, 10_000));
        };
    };
    const api = {
        isWebSocketOpen: () => socket?.readyState === 1,
        subscribe(types, callback) { const entry = { types, callback }; listeners.add(entry); return () => listeners.delete(entry); },
        _sdk: { webSocket: {
            onStatusChange(listener) { statuses.add(listener); return () => statuses.delete(listener); },
            sendMessage(message) { if (socket?.readyState !== 1) throw new Error('The listening party is reconnecting.'); socket.send(JSON.stringify(message)); }
        } },
        close() { closed = true; host.clearTimeout(timer); socket?.close(); listeners.clear(); statuses.clear(); },
        start: connect
    };
    return api;
}
