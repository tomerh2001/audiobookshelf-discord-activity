const ID = '[A-Za-z0-9_-]{1,100}';
const BROWSE = new RegExp(`^/(?:|account|(?:item|author|series|collection|playlist)/${ID}|library/${ID}(?:/(?:bookshelf(?:/(?:all|books|series|authors|collections|playlists))?|search|stats|podcast/latest|series/${ID}))?)$`);
const controls = (value: string) => [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const QUERY = new Set(['query', 'q', 'filter', 'sort', 'page', 'tab']);

/** A checkpoint contains a native browsing route, never a capability or command. */
export function normalizeNativeRoute(value: unknown, _serverId: string): string | null {
  if (typeof value !== 'string' || value.length > 1024 || (/[\\#]/u.test(value) || controls(value))) return null;
  const [path, query, extra] = value.split('?');
  if (extra !== undefined || !path || !BROWSE.test(path)) return null;
  const params = new URLSearchParams(query);
  const seen = new Set<string>();
  for (const [key, part] of params) {
    if (!QUERY.has(key) || seen.has(key) || part.length > 160 || (/[<>\\/#?&=:%]/u.test(part) || controls(part))) return null;
    if (key === 'page' && !/^\d{1,6}$/.test(part)) return null;
    seen.add(key);
  }
  const result = params.toString();
  return path + (result ? `?${result}` : '');
}
