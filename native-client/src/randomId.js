/** CSPRNG IDs also work on local HTTP development origins without randomUUID. */
export function randomId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
}
