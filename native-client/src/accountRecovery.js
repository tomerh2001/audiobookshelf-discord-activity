/** Stop an expired native session before one bounded replacement attempt. */
export function createAccountRecovery({ getSelection, stop, recover, onRecovered = () => {}, onError = () => {} }) {
    let pending, blocked = false, closed = false, revision = 0;
    function run() {
        if (closed || blocked || pending) return pending;
        const connection = getSelection();
        if (!connection) return;
        const generation = ++revision;
        const current = () => !closed && generation === revision;
        let stopError;
        const operation = Promise.resolve().then(() => {
            if (!current()) return;
            if (stopError) throw stopError;
            return recover(connection);
        }).then(() => { if (current()) onRecovered(); }).catch(() => {
            if (current()) { blocked = true; onError(); }
        }).finally(() => { if (pending === operation) pending = undefined; });
        // Publish the in-flight operation before stopping the old player; its
        // final close request may itself report the same expired capability.
        pending = operation;
        try { stop(); } catch (error) { stopError = error; }
        return operation;
    }
    return {
        get busy() { return Boolean(pending); },
        get blocked() { return blocked; },
        run,
        retry() { blocked = false; return run(); },
        // The caller also invalidates the controller's pending selection when
        // switching accounts, signing out or leaving the document.
        cancel() { revision++; pending = undefined; blocked = false; },
        dispose() { closed = true; revision++; pending = undefined; }
    };
}
