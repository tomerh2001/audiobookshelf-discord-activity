import { describe, expect, it } from 'vitest';
import { normalizeNativeRoute } from './nativeNavigation.js';

describe('native Audiobookshelf browsing checkpoints', () => {
  it.each(['/', '/account', '/library/lib_123', '/library/9abc-def/bookshelf/series', '/library/library-id/podcast/latest', '/item/item-uuid', '/author/author-id', '/series/series-id', '/library/lib_123/series/series-id', '/collection/col_123', '/playlist/pl_123', '/library/lib_123/search?query=The+Hobbit'])('restores browsing route %s', route => {
    expect(normalizeNativeRoute(route, 'selected-server')).toBe(route);
  });
  it.each(['/api/me', '/abs/capability/api/me', '/login', '/config', '/item/id/play', '/library/lib_123/series/../config', '/library/lib_123/series/id/play', '/item/../config', '/item/id?token=secret', '/item/id?query=secret&query=second', '/library/lib_123/search?query=https%3A%2F%2Fevil.example', '/item/id#x', '//evil.example', 'https://evil.example/item/id', '/item/%2fapi', '/library/id/search?page=-1'])('rejects a credential, command, or external route %s', route => {
    expect(normalizeNativeRoute(route, 'selected-server')).toBeNull();
  });
});
