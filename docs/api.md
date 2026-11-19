# API and playback

All ordinary routes require production ingress proof. App routes additionally require a verified Discord app-session bearer. Viewer routes require an unexpired capability bound to that session, account and Activity. OIDC external-start/callback routes have independent one-time authorization.

| Route | Purpose |
| --- | --- |
| `/api/discord/exchange`, `/api/discord/resume` | Discord authentication and verified session recovery |
| `/api/connections` | List/create saved Audiobookshelf accounts |
| `/api/connections/community`, `/preference`, `/:id` | Explicit community connection, preference and disconnect |
| `/api/connections/oidc` and its start/callback/poll routes | Native Audiobookshelf OpenID Connect handoff |
| `/api/party`, `/api/native/launch`, `/api/native/restore` | Party binding, viewer capability and browsing restoration |

`/abs/:capability/*` admits a defined set of Audiobookshelf browsing, progress, bookmark, playlist and playback endpoints. It authenticates upstream requests, rewrites media URLs and sanitizes responses. Native playback sessions use `/api/items/:id/play`, progress/close use `/api/session/:id/...`, direct audio uses `/public/session/:id/track/:index`, and transcoding uses `/hls/:id/...`. Browser session IDs are per-viewer aliases; real public stream IDs and JWTs stay on the backend.

The custom WebSocket `/abs/:capability/socket` emits `ActivityPlaybackState` and accepts `ActivityPlaybackCommand`. The HTTP `/abs/:capability/Activity/Playback` endpoint supplies the same state and command fallback. Commands include epoch, unique ID, actor sequence, expected queue revision and issued-at time. The server serializes commands, deduplicates exact retries and rejects stale or conflicting actions.

The snapshot includes a queue with distinct entry IDs, current index, whole-book position in 10,000,000 ticks per second, pause state, shared playback rate, repeat mode and server timestamp. Commands replace/append queues, select an entry, seek, play/pause, set rate/repeat or stop. Podcast queue entries can include an episode ID. Every active member's item permission is checked before a queue change.

Audiobookshelf Socket.IO remains server-side. Only owned stream reset/progress/error events cross the Activity socket as `AudiobookshelfEvent`; administrative/user-online events and other users' stream IDs do not. Native cross-device progress events do not override the Activity timeline. Local buffering never pauses the whole group.

Tokens and room state remain in memory in the browser. Saved encrypted connections persist server-side. A short renderer disconnect grace preserves the running timeline and a validated native route; an app restart clears live state.
