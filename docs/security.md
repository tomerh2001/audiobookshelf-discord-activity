# Security model

Discord identity and current membership in this application's Activity are required. Production also requires a trusted Activity ingress proof. Public deployment mode removes the guild/user allowlist requirement, but does not remove identity, membership, denylist, account or media checks.

## Ingress

`DISCORD_PROXY_AUTH_MODE=signature` verifies the Discord proxy payload and its expiry using the application's public key. `cloudflare-worker` instead requires a strong operator-configured secret in `x-audiobookshelf-discord-edge`. The trusted edge must overwrite that header only after verifying the actual Worker provenance; it must strip client attempts to supply it. Origin, Referer, CF-Worker and forwarded IP headers alone are insufficient.

The signed `/api/discord/interactions` callback verifies its own exact-body signature. Direct loopback `/health` is only for container health checks. External OIDC start and callback GETs are the other narrow ingress exceptions. They cannot browse a library or mint a viewer capability on their own.

## Accounts and SSO

Saved access/refresh tokens use authenticated encryption with an operator-owned 32-byte key. Passwords are used only for login and are not stored. Personal connections belong to a Discord user; community connections additionally bind to the current guild/no-guild context and configured policy. Disconnect revokes local viewers before attempting upstream logout.

Authentik login uses Audiobookshelf's native OpenID Connect mobile flow. The backend binds a short-lived request to the initiating Discord session, uses a one-time external-start ticket, sets a same-browser HttpOnly nonce cookie, and verifies state/PKCE through Audiobookshelf. The provider's client secret stays in Audiobookshelf. Redirect responses and OIDC cookies are handled only by the narrowly scoped authentication code. Polling requires the initiating app session.

## Gateway

Login uses only the operator-configured server. Password and OIDC endpoints reject a client-supplied server address; saved accounts from a previous server configuration cannot launch. Browser connection and party metadata omit upstream URLs and host-derived server names. The configured server can target a private network or HTTP. The selected address is pinned for HTTP and Socket.IO. Socket.IO receives a dedicated Node agent carrying that pin: engine.io-client drops direct `lookup` and `servername` options. A real Socket.IO regression uses a deliberately unresolvable hostname to verify that the validated address is used. Arbitrary redirects are rejected. A configured public alias resolves to the same default before validation, not to a new private-network exception.

The gateway allows selected native browse/player/account-progress endpoints. It denies administration, password changes, arbitrary filesystem access and server sharing. Every active viewer must be authorized to read a newly queued item. Media routes authenticate the viewer and enforce playback-session ownership even when two viewers share the same upstream account. Opaque session aliases hide Audiobookshelf's unauthenticated public stream identifiers. Listening history and recent-session statistics omit raw session IDs while retaining book metadata. One active viewer per shared account can save progress; followers cannot bypass that rule through direct progress updates.

Upstream JWTs, refresh tokens, physical paths and sensitive account fields are removed from JSON. Executable upstream content is rejected. Media URLs and HLS playlists must remain within the validated server base and allowed routes. Range requests stream without buffering whole books. Revocation aborts transfers and closes the viewer's native sessions.

## Boundaries

The browser keeps capabilities and Discord authorization in document memory. Persistent token storage and service-worker caching are disabled by the native integration. Logs redact capability paths, login codes, state, tickets and token fields. Keep infrastructure/access logs private too; a reverse proxy must not log callback query strings or authentication headers.

Operators remain responsible for permitted media access, library permissions and capacity. Community accounts intentionally share history and bookmarks. Run one backend instance; process-local timelines are not replicated. Do not expose development mock authentication publicly.
