/** Keep keyboard and native Back inside the active Activity dialog. */
export function createActivityDialogs(host, getDialog, dismiss) {
    const document = host.document;
    let current, restore;
    const buttons = element => [...element.querySelectorAll('button, [href], input, select, textarea, [tabindex]')]
        .filter(value => !value.disabled && value.tabIndex >= 0 && !value.closest('[hidden], [inert], [aria-hidden="true"]'));
    const focus = element => (buttons(element)[0] || element).focus();
    function update() {
        const next = getDialog();
        if (next?.element === current?.element) return;
        if (next?.element) {
            if (!current) restore = document.activeElement;
            current = next;
            focus(current.element);
        } else {
            current = undefined;
            if (restore?.isConnected) restore.focus();
            restore = undefined;
        }
    }
    function back(event) {
        if (!current) return false;
        event?.preventDefault(); event?.stopImmediatePropagation();
        if (current.dismissible) dismiss();
        return true;
    }
    const keydown = event => {
        if (!current) return;
        if (['Escape', 'BrowserBack', 'GoBack'].includes(event.key)) { back(event); return; }
        if (event.key !== 'Tab') return;
        const available = buttons(current.element);
        const index = available.indexOf(document.activeElement);
        if (!available.length) { event.preventDefault(); current.element.focus(); }
        else if (index < 0 || (event.shiftKey && index === 0) || (!event.shiftKey && index === available.length - 1)) {
            event.preventDefault(); available[event.shiftKey ? available.length - 1 : 0].focus();
        }
        event.stopImmediatePropagation();
    };
    const command = event => { if (event.detail?.command === 'back') back(event); };
    const focusin = event => { if (current && !current.element.contains(event.target)) focus(current.element); };
    host.addEventListener('keydown', keydown, true);
    host.addEventListener('command', command, true);
    document.addEventListener('focusin', focusin, true);
    return { update, back, dispose() {
        host.removeEventListener('keydown', keydown, true);
        host.removeEventListener('command', command, true);
        document.removeEventListener('focusin', focusin, true);
        current = undefined;
        if (restore?.isConnected) restore.focus();
        restore = undefined;
    } };
}
