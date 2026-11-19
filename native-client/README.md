# Native Audiobookshelf client

Audiobookshelf Listen builds the official Audiobookshelf **2.38.0** web client from the exact commit and SHA-256 archive recorded in `upstream.json`. The upstream Nuxt 2 / Vue 2 application owns the document, bookshelf, item pages, search, chapters, bookmarks and audio player. The integration changes are applied to a clean source extraction before compilation. Changed patch anchors stop the build.

Build with Node 24 and npm:

```sh
node native-client/build.mjs
```

Use `--prepare-only` to extract and patch without installing dependencies or compiling. The complete client is written to `native-client/dist`. Build the workspace session library separately and copy `apps/activity-web/dist/activity-session.js` into that directory before serving it. `npm ci` retains optional platform packages because Tailwind's native compiler requires them. Lifecycle scripts and the Cypress binary download remain disabled.

## Discord, accounts and login

The native login screen uses Audiobookshelf form components and offers explicit community login, saved accounts and **Sign in with Authentik**. The backend chooses the configured server; its address never appears in the login form or account metadata. Username/password fields appear only when the library enables local login. SSO opens the configured Audiobookshelf identity-provider flow in the external browser and polls the session-bound broker result. It supports Authentik through Audiobookshelf's native OIDC integration. Passwords are cleared after use; the real upstream credentials remain on the backend.

The session library performs Discord authentication once. Its retained in-memory authorization can recover an expired broker session after independent backend verification. Signing out removes the selected saved account and returns to native login while Discord and other listeners remain connected. Account replacement invalidates pending native media preparation, rejects old HTTP responses and remounts account-owned views.

Native requests use a temporary `/abs/<capability>` gateway. The original upstream token is never installed in the client. Separate in-memory localStorage and sessionStorage work even when Discord refuses persistent storage. Service-worker/PWA caching is disabled. The native router uses the hash inside the same document; route checkpoints contain only allowlisted browsing paths.

Packaging moves Nuxt's generated inline executable bootstraps into same-origin script files, in their original order. The native document can therefore run under `script-src 'self'` without `unsafe-inline` or `unsafe-eval`. JSON script data remains unchanged.

## Listening together

Audiobookshelf's server does not currently provide a native listening-party protocol. The Activity coordinator owns the shared queue, position, pause state, repeat mode and playback speed. `nativePlaybackAdapter.js` connects that coordinator to the real upstream `PlayerHandler` and `MediaPlayerContainer`; it does not create a replacement audio player.

All connected authorized listeners can control the party. Queue entries have individual identities, including repeated media and podcast episodes. The adapter translates Audiobookshelf's whole-book seconds, including track offsets, to the coordinator's ticks. Shared playback uses the current queue rather than a personal Auto Play preference. Volume and sleep timers remain local; a sleep timer cannot pause everyone. Bookmarks and progress belong to the selected upstream account, so community users share them.

Controls apply locally before acknowledgement. Ordered command IDs, revisions and recovery snapshots prevent replaying stale clicks after reconnection. A delayed native session load reconciles the latest pause, seek and speed before playback. The player follows new books and podcast episodes after mobile visibility/online recovery. Steady playback uses buffered drift correction; resume and persistent large drift can seek across tracks. Completed books restart at zero unless an explicit start time was chosen.

The existing native player negotiates direct audio or HLS and reports listening progress through its authorized upstream session. Filtered Audiobookshelf stream events share the Activity WebSocket. Player preparation and transcode retries are bounded, and obsolete responses cannot reopen a stopped or replaced player. Autoplay failures offer a button that calls `play()` on the actual audio element inside the user's gesture.

The lockfile-pinned HLS dependency supplies its unchanged standalone worker at `/hls.worker.js`, with its Apache license and source map. `workerPath` selects that same-origin asset. It avoids both a webpack-rewritten stringified worker and a dependency on allowing blob workers in the iframe's security policy.

The listening-party panel shows the Discord roster and live membership changes. Rich Presence uses actual local audio playback and public Discord application artwork. Protected media addresses, gateway credentials and server identities are excluded. Discord focused, PiP and grid changes preserve the session and player. Fullscreen follows browser permissions.

## Verification

`node --test native-client/test/*.test.mjs` covers ordered playback, account/session recovery, cancelled preparation, whole-book and podcast identity, autoplay unlocking, local sleep timers, storage bootstrap and document lifecycle. The workspace tests separately cover Discord, API authorization and upstream isolation.

`scripts/native-browser-fixture.ts` serves the compiled native application with synthetic books, generated audio and the real coordinator on a private test address. Use an explicitly development-built session library for this fixture. Restore the production session bundle before packaging. This fixture does not connect to Discord, Audiobookshelf or Authentik accounts and cannot establish their live integration or physical mobile-device compatibility.

## Licensing and corresponding source

Audiobookshelf's root package declares `GPL-3.0`, and its root license is GNU GPL version 3. This build identifies that license as **GPL-3.0-only**. The upstream license and notices remain intact. The combined native client includes its license, source revision and `corresponding-source.tar.gz`, containing the patched upstream source and lockfiles while excluding installed dependencies and build output. `activity-source.tar.gz` includes the build recipe, native adapter, session library, shared protocol, broker source, manifests and lockfile from an explicit allowlist. It excludes environment files, private runtime data, installed dependencies and repository history. Extract that archive, run the build commands in the root README, and copy the built session library into the native output.

The independent broker and session components retain their existing MIT license. That does not change the GPL terms for the combined native client. Public application artwork uses the bundled upstream Audiobookshelf icon; the copied Jellyfin artwork is removed.
