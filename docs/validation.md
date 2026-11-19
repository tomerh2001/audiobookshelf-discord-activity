# Validation — 19 November 2026

The Audiobookshelf adaptation is implemented in a separate checkout based on Jellyfin Watch `c8a0511`. The original Jellyfin checkout was unchanged. This report separates automated checks, simulated browser checks and limited live-service verification. It does not establish an end-to-end Discord or Authentik login.

## Listening experience follow-up

### Paused Discord status

A real listener confirmed the profile title after the compact-view/recovery release. Live diagnostics also showed playing updates acknowledged with a title and intervening paused updates rejected with RPC `4000`. The formatter now omits inactive timestamps instead of sending `null`, and diagnostics identify the timer state of each set request. The installed-SDK transport regression covers playing, paused, buffering and resumed playback at a changed speed. The documentation permits nullable fields, so this is a narrow response to the observed rejection, not proof that Discord universally rejects null timestamps. Real paused-state acceptance still needs separate verification.

### Compact views and interrupted sessions

The follow-up removes the extra controls row, puts the party button and Back in the native app bar, and places previous/next/repeat in the native queue dialog. Browsing and dialogs have bounded scroll areas, and the compact player uses the initial presentation state. Queue navigation is disabled when no neighboring item exists; fullscreen is offered only when the document supports it.

The final compiled native interface passed a headed-browser fixture check at 1100×600, 390×640, 800×450 and 320×180. Library content scrolls to its bottom above the player, the narrow app bar preserves the account button, and the compact view retains the title and playback controls. The queue stays inside the short viewport and scrolls to its last entry. Next and Previous switch between distinct book titles, Repeat All survives closing and reopening the queue, and the party dialog offers fullscreen in a supporting browser. Discord identity, media and the SDK receiver were synthetic; outer Discord popout borders and a real profile card remain unverified.

Account recovery now stops an expired native player before one replacement attempt. A verified Discord session renewal can reconnect the selected account after the backend loses its in-memory party. Failed recovery requires an explicit retry, late requests from an old account cannot reconnect a newer account, and temporary polling failures preserve valid playback. A reproduction using the pinned native PlayerHandler reduced repeated failed progress saves from six requests and a warning to one failed request followed by a stopped timer. This does not preserve the queue across a backend restart.

The follow-up passes 409 workspace tests (29 shared, 68 frontend, 312 API) and 97 native tests. The presence tests now also exercise the installed Discord SDK's message transport, including valid acknowledgements, a missing returned title, numeric rejection and an empty response that times out. Content-free, authenticated diagnostics distinguish player observation from status requests and responses. These checks do not establish that a real Discord profile displays the title; that remains a separate live verification.

The November 19 follow-up removes server entry from login and all server addresses from connection/party responses. The deployment selects the library and its enabled login methods. It also adds queue ordering, Play next, shuffle, Clear upcoming, account switching without forgetting credentials, accessible dialogs, authorized live library refresh, podcast command choices, and custom Activity artwork.

Rich Presence now recovers when its observer attaches after the native audio element has already begun playing, updates immediately on playback/buffering events, and distinguishes podcast shows and episode titles. The presence tests verify actual-media-state gating, paused/buffering state, and safe title payloads. They do not prove that Discord rendered a status on a real user's profile.

The follow-up passes 368 workspace tests (29 shared, 59 frontend, 280 API) and all 85 native integration tests, with production builds, TypeScript and lint passing. The native suite includes a regression ensuring that an observer which first sees stalled media waits for enough buffered data or a real playing event before publishing playback. The original checks below describe the earlier release.

The rebuilt interface also passed a headed-browser check using synthetic community login and generated audio. The login showed the custom brand and enabled sign-in choices without a server field. Real native playback produced `The Listening Room / Playing` through the compiled Rich Presence formatter into a synthetic SDK receiver. Pause changed the receiver to `A Second Chapter / Paused · 0:06 / 2:00`. Play next added an item and the queue exposed its new controls. The participant dialog focused Close, contained Tab and returned focus to its opener after Escape. No fixture error message appeared during these checks. The receiver makes no Discord call, so it proves the native playback-to-status path rather than Discord's profile rendering.

## Automated checks

| Check | Result |
| --- | --- |
| Workspace tests | 349 passed: 26 shared-protocol, 57 Discord/session frontend, 266 API/security tests |
| Native integration tests | 69 passed, none skipped |
| TypeScript, ESLint, whitespace checks | Passed |
| Production workspace and native builds | Passed; official Audiobookshelf 2.38.0 source archive verified against the pinned SHA-256 |
| Full Docker build | Passed, including the native build on Alpine and production dependency packaging |

The full GitHub check job also passed on API-key support commit `cbe2931`, including all 349 workspace tests, 69 native tests, builds, type checks and lint checks. See [the check run](https://github.com/tomerh2001/audiobookshelf-discord-activity/actions/runs/44434118949).

Coverage includes password login, encrypted rotating tokens, account isolation, OIDC state/PKCE/browser binding, rejected replay and logout races, public/community policy, ordered playback, shared speed, duplicate queue entries, multi-track position, late joins, account switching, HTTP Range streaming, HLS cancellation, private-session aliases and Socket.IO address pinning. OIDC-only community-account tests verify server-side API-key authentication, encrypted storage, mounted secret-file loading, rejection of administrator keys, removal of one participant without revoking the shared key, rejection of expired keys without a password/refresh fallback, and invalidation after key rotation. See the tests and [feature mapping](feature-parity.md) for implementation boundaries.

## Native browser checks

The official compiled interface ran in headed Chromium under a strict `script-src 'self'` policy, without `unsafe-inline` or `unsafe-eval`. The local fixture supplied synthetic accounts, two books and generated two-track audio. It used the real Activity playback coordinator; Discord identity and Audiobookshelf account/media endpoints were simulated.

| Interaction | Observed result |
| --- | --- |
| Password login, library and book details | Native screens rendered and a book played through the actual audio element |
| Community listener joining mid-book | Separate audio session joined the existing timeline; one observed position difference was approximately 0.02 seconds |
| Pause and chapter jump | Both players paused; a chapter jump crossed into the second audio file and both reported exactly 90 seconds of whole-book time |
| Shared speed and repeat | Both audio elements played at 1.5×; Repeat All returned to the beginning after the book finished |
| Full-page reload and autoplay recovery | Saved account and party restored; the browser displayed its tap-to-play fallback. After the tap, both clients played at 1.5× with a sampled difference of 0.048 seconds across a track boundary |

These timing samples are functional checks on a local fixture, not a network-latency guarantee. The browser run preceded only the final ebook-button hiding, 3× speed-control ceiling and standalone HLS-worker packaging changes; those changes passed patch-anchor checks, the native test suite and the final production build. HLS gateway tests use synthetic streams; a real Audiobookshelf transcode was not played in this browser run.

## Live account integration

The actual `connectCommunity`, `resolveConnection` and `disconnectConnection` functions at `cbe2931` passed against an Audiobookshelf 2.38.0 server configured for OIDC-only login. The probe used a dedicated non-administrator API key supplied through `_FILE`, a read-only container and an isolated private temporary database. It verified the approved public-to-internal server mapping, the account's current libraries and restricted permissions, encryption of the saved key, independent connections for two listeners, and removal of one connection while preserving the other connection and shared key. The temporary database and copied key were removed afterward. The probe did not play media or change listening progress.

The same server accepted the native OIDC start request and returned a redirect using the configured Activity callback, preserving the state and S256 PKCE challenge. This establishes upstream request compatibility. It does not establish the provider's complete browser return, Discord authorization or Activity launch.

## Production container

Image `audiobookshelf-discord-activity:local` built as `sha256:837d07a34f25ac218a2d5db7ad8a89f0f1e0a6b70a1e490c63495dcc84a8efc7`.

An isolated container, with no external network and synthetic configuration, passed its health check as the unprivileged Node user. Requests without ingress proof were rejected, account/media routes required authentication, the native page and production session bundle loaded, and executable inline bootstrap scripts were absent. Both corresponding-source archives and the upstream license were served. The connection store created its private SQLite database in the writable data directory. The temporary container and browser fixture were stopped after verification; the built image remains available locally.

The separate [public repository](https://github.com/tomerh2001/audiobookshelf-discord-activity) publishes `ghcr.io/tomerh2001/audiobookshelf-discord-activity:latest` and immutable commit tags through GitHub Actions after checks pass. The image for `cbe2931` was pulled anonymously from the registry; its OCI metadata identified the expected repository and exact source revision. The original Jellyfin repository and image were not modified.

## Deployment checks still required

Real Discord authorization, Activity launch/commands, participant events, outer-frame CSP and pop-out behavior need the separately registered Discord application. Authentik needs the target Audiobookshelf server's native OIDC settings and allowed callback before a real end-to-end login can be verified. Follow [Discord setup](discord-setup.md), [Authentik setup](authentik.md) and [deployment](deployment.md).

Physical iOS/Android autoplay, background audio and codecs require device testing. Audiobookshelf has no native group-listening protocol in the inspected version; the Activity coordinator supplies that feature. Active timelines are process-local and do not survive a backend restart. Ebooks and server administration are outside this listening Activity.
