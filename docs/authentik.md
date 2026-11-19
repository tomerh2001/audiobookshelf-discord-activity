# Authentik sign-in

The Activity uses Audiobookshelf's native OpenID Connect login. Authentik authenticates the reader, Audiobookshelf maps that identity to an Audiobookshelf account, and the Activity stores the resulting Audiobookshelf access and refresh tokens encrypted on the server. Other OIDC providers supported by Audiobookshelf can use the same flow.

Use Audiobookshelf 2.38 or later. This implementation is verified against the 2.38.0 server source. The Authentik page opens in the external browser because identity-provider login pages generally cannot run inside Discord's iframe. The Activity polls for the completed connection.

## Configure Authentik

1. Create an OAuth2/OpenID provider and application for Audiobookshelf. Record its client ID, client secret and issuer URL.
2. Register these **strict** redirect URIs, using your Audiobookshelf public address: `https://books.example/auth/openid/callback` and `https://books.example/auth/openid/mobile-redirect`. Include your Audiobookshelf path prefix when it runs under a subfolder.
3. Assign the users or groups allowed to use Audiobookshelf. Ensure the provider supplies the username claim you intend Audiobookshelf to match, normally `preferred_username`.

Authentik returns to **Audiobookshelf**, which performs the provider token exchange. Do not register the Activity as a separate OAuth client or put the Authentik client secret in the Activity environment.

## Configure Audiobookshelf

In **Settings → Authentication → OpenID Connect Authentication**:

1. Enter the Authentik issuer URL, such as `https://identity.example/application/o/audiobookshelf/`. Use **Auto-populate** to load the provider endpoints and signing settings.
2. Enter the client ID and secret. Configure **Match existing users by** to match your account policy. Enable **Auto Register** only if you intend to create accounts for allowed provider users automatically.
3. Add `https://listen.example/api/connections/oidc/callback` to **Allowed Mobile Redirect URIs**. This must exactly match the Activity's `PUBLIC_BASE_URL` origin followed by that path.
4. Set **Subfolder for Redirect URLs** when Audiobookshelf has a public path prefix. Save the settings and restart Audiobookshelf.

The normal Audiobookshelf web login should work with Authentik before testing the Activity. Use a non-administrator Audiobookshelf account with the intended libraries and playback permissions.

## Configure the Activity

```dotenv
PUBLIC_BASE_URL=https://listen.example
AUDIOBOOKSHELF_DEFAULT_SERVER_URL=http://audiobookshelf:80
AUDIOBOOKSHELF_PUBLIC_SERVER_URL=https://books.example
AUDIOBOOKSHELF_OIDC_ENABLED=true
```

`PUBLIC_BASE_URL` is the externally reachable Activity origin. Expose only the existing Activity application through your configured ingress. The exact external handoff and callback routes must be reachable outside Discord:

- `GET /api/connections/oidc/start/<attempt-id>`
- `GET /api/connections/oidc/callback`

All other Activity operations retain Discord ingress and session checks. The included ingress middleware permits these two limited routes; an additional reverse proxy or access policy must also allow them. Do not exempt the whole `/api/connections` prefix.

`AUDIOBOOKSHELF_DEFAULT_SERVER_URL` is the address reached by the backend. Its optional public alias is an exact mapping to that approved destination. During OIDC only, the backend supplies the public Host and protocol so Audiobookshelf creates its provider callback with the correct external origin. The connection stays pinned to the validated backend address; it never follows an upstream redirect itself. Custom servers require public HTTPS and must separately allow this Activity callback in their mobile redirect settings.

For public community access, the operator can separately configure:

```dotenv
DISCORD_ACCESS_MODE=public
AUDIOBOOKSHELF_AUTH_MODE=shared
AUDIOBOOKSHELF_COMMUNITY_ACCESS=public
AUDIOBOOKSHELF_SHARED_API_KEY_FILE=/run/secrets/audiobookshelf-community-key
```

This is an explicit opt-in to sharing that account with authenticated Discord Activity participants. Personal Authentik sign-in remains available. A safer limited deployment uses `DISCORD_ACCESS_MODE=restricted` and `AUDIOBOOKSHELF_COMMUNITY_ACCESS=guilds`, with `AUDIOBOOKSHELF_COMMUNITY_GUILD_IDS` listing the permitted Discord guilds. If that list is empty, community access uses `DISCORD_ALLOWED_GUILD_IDS`.

Create a dedicated non-administrator user in Audiobookshelf, restrict its libraries and permissions, then create an API key for that user under Settings → API Keys. The API key works while local password login remains disabled. Save it as a mounted secret; `AUDIOBOOKSHELF_SHARED_API_KEY` is also supported and takes precedence over shared username/password. The Activity encrypts saved copies and authenticates the key with Audiobookshelf before use. Disconnect removes only that Discord participant's connection; revoke the key in Audiobookshelf to revoke all community access. Key rotation requires participants to reconnect. For servers that allow local login, `AUDIOBOOKSHELF_SHARED_USERNAME` and `AUDIOBOOKSHELF_SHARED_PASSWORD` remain available instead.

## Security and behavior

The browser handoff has a single-use ticket. The callback checks a random state bound to the initiating Discord session and a same-browser HttpOnly nonce cookie. PKCE uses a fresh S256 verifier; only the backend holds that verifier and Audiobookshelf's temporary session cookies. This nonce binds the external browser; it is not an OIDC ID-token nonce, because Audiobookshelf validates the provider response.

The backend exchanges the authorization code with Audiobookshelf's `/auth/openid/callback`, not the Authentik token endpoint. Provider cookies and tokens never enter Activity browser storage or API responses. Failed, expired, replayed, superseded or logged-out attempts cannot save a connection. A successful callback displays a static return-to-Discord page; the original Activity session receives the result by polling.

Access and rotating refresh tokens are encrypted in the connections database. Concurrent refreshes for one connection share one request. Refresh preserves playback capabilities, while relinking or disconnecting revokes them. Disconnect revokes the Activity's Audiobookshelf refresh session when it has one; it does not revoke an operator's shared API key, sign the reader out of every Authentik application or revoke every device.

Audiobookshelf `/status` identifies the application but provides no stable installation ID. The Activity's server ID is a hash of the canonical destination URL, and authenticated checks verify the saved Audiobookshelf user ID. Do not interpret that local server ID as independent proof of an unchanged server installation.

## Troubleshooting

| Result | Check |
| --- | --- |
| “Enable OpenID Connect” | Audiobookshelf `/status` must list `openid` in its active authentication methods. |
| Start opens an error page | Confirm the issuer is HTTPS, the public Audiobookshelf alias is correct, and the provider accepts S256 PKCE. |
| Provider refuses the redirect | Register Audiobookshelf's `/auth/openid/mobile-redirect` URI in Authentik, including any public path prefix. |
| Return from Authentik fails | Whitelist the Activity callback under **Allowed Mobile Redirect URIs**; finish in the same browser, within ten minutes. |
| Activity stays waiting | Confirm both external GET routes bypass proxy-only Activity authentication and that the original Discord session remains open. |

The fixture tests exercise token rotation, account ownership, cookie retention, PKCE binding, browser nonce checks, callback replay rejection and session-revocation races. A live Discord + Audiobookshelf + Authentik sign-in still requires validation on the deployment being installed.

## Sources

- [Audiobookshelf 2.38.0 OIDC implementation](https://github.com/advplyr/audiobookshelf/blob/1430c9fc642d586ff91c8d4cbed20aab2c47e473/server/auth/OidcAuthStrategy.js)
- [Audiobookshelf 2.38.0 authentication and token handling](https://github.com/advplyr/audiobookshelf/blob/1430c9fc642d586ff91c8d4cbed20aab2c47e473/server/Auth.js)
- [Authentik's Audiobookshelf integration guide](https://github.com/goauthentik/authentik/blob/324af8563ef785f6801b6fdec98f2e5607dfaa8e/website/integrations/media/audiobookshelf/index.mdx)
