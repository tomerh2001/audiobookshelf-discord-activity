# Audiobookshelf setup

The native client is pinned to Audiobookshelf v2.38.0. Use a server with that API and native OpenID Connect support when enabling Authentik. See [upstream evidence](upstream-research.md) for the inspected source.

Set `AUDIOBOOKSHELF_DEFAULT_SERVER_URL` to the server reachable by the backend. It may be a private HTTP URL such as `http://audiobookshelf:80`. An optional `AUDIOBOOKSHELF_PUBLIC_SERVER_URL` names that exact same server for users; it is an alias, not another upstream. Custom user-entered servers require public HTTPS and must pass DNS/IP validation. Set `AUDIOBOOKSHELF_ALLOW_CUSTOM_SERVERS=false` to limit a deployment to its default.

Create a non-administrator user with access only to the intended libraries for the community account. Set `AUDIOBOOKSHELF_AUTH_MODE=shared`, `AUDIOBOOKSHELF_SHARED_USERNAME` and `AUDIOBOOKSHELF_SHARED_PASSWORD`. The community button is explicit; personal login remains available. Choose `AUDIOBOOKSHELF_COMMUNITY_ACCESS=guilds` and provide `AUDIOBOOKSHELF_COMMUNITY_GUILD_IDS`, or opt into `public` community access. An empty community guild list falls back to the Discord allowlist.

Every community participant gets an independent device ID, login token and playback session. Native Audiobookshelf progress and bookmarks still belong to one shared upstream account. One active participant writes listening progress, while other viewers only maintain their own streams. Use personal accounts for private progress and bookmarks.

Password login calls native `/login` with the JSON token response. Access and refresh tokens are encrypted server-side; native `/auth/refresh` rotates them. The native gateway never forwards arbitrary login, user administration, sharing or filesystem requests. If login fails, confirm the server URL, account status and library permissions.

For Authentik, configure Audiobookshelf's native OpenID Connect provider and follow [Authentik setup](authentik.md). Do not substitute an Authentik access token for an Audiobookshelf access token. The native OIDC flow must return an authorized Audiobookshelf user.
