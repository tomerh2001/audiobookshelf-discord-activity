# Deployment

The application serves the native client, API, WebSocket and media gateway on port 3000. Deploy one instance with persistent `/data`; live sessions and room state are process-local, so a load-balanced multi-instance deployment is unsupported.

## Build and configure

1. Copy `.env.example` to `.env`. Set `PUBLIC_BASE_URL` to your public HTTPS Activity origin and provide your own Discord application credentials.
2. Generate a random `APP_SESSION_SECRET` and an independent base64-encoded 32-byte `TOKEN_ENCRYPTION_KEY`. Keep the encryption key with encrypted backups; losing it makes saved connections unreadable.
3. Choose restricted or public Discord access. Configure Audiobookshelf and optional community credentials. Add Authentik's callback if using SSO.
4. Run `docker compose up -d --build`. Confirm the container health check succeeds, then configure the Activity URL mapping and test from Discord.

The Compose file builds locally by default. For a registry release, set `ACTIVITY_IMAGE` and use `docker compose pull app` followed by `docker compose up -d --no-build app`. The provided GitHub workflow publishes a moving `latest` image on successful `main` builds; it does not contain an operator's repository name. Enroll that image in your normal updater if automatic updates are wanted.

## Reverse proxy and Discord

Forward ordinary HTTP and WebSocket upgrades to the application. Do not cache authenticated responses or buffer whole audio streams. Preserve Range and If-Range requests. The backend sends no-store for API/media and private revalidation for packaged assets.

Production ingress requires Discord's signed proxy headers, or a separately verified edge that supplies `x-audiobookshelf-discord-edge`. An arbitrary client-supplied `CF-Worker`, Origin or Referer is not ingress proof. See [security](security.md). Your ingress must allow the exact OIDC external-start and callback routes; these routes enforce their own ticket, browser cookie, state and PKCE checks. Do not place a generic Authentik forward-auth login page in front of the entire Activity.

The Caddy profile is optional. Copy `Caddyfile.example` to `Caddyfile`, replace its example hostname, point DNS to your ingress and run `docker compose --profile proxy up -d`. Configure ingress proof at the actual trusted edge before production traffic.

The Caddy example disables access logging because request URLs contain credentials. If you enable logs at any proxy, redact the capability segment in `/abs/<capability>/...`, remove OIDC callback and handoff query strings, and omit Authorization, Cookie, Set-Cookie and refresh-token headers before writing the record. API log redaction does not protect separate proxy or hosting-platform logs. Keep any retained logs private and bounded.

## Secrets and persistence

Sensitive variables support a matching `_FILE` path for Docker secrets; do not configure both the plain variable and its file. Keep local secret files outside the build context or in an excluded `secrets/` directory. The Docker ignore file excludes local environment files and common private-key containers; arbitrary `_FILE` paths are not automatically excluded. Persist `/data`, including the encrypted connections database. Application logs may be directed to `LOG_DIR`. Keep logs private and bounded. No media files are stored by the Activity; Audiobookshelf owns its media, transcodes and progress.

The image runs as the unprivileged Node user. Its health check uses the direct loopback-only `/health` endpoint. Remote `/health` and protected routes cannot bypass ingress by presenting a forwarded loopback address.

## Upgrade checks

Run the full CI suite and native build before release. Verify login, two-user synchronization, account switching, token refresh, range seeking and OIDC with your configured provider. Restarting the app requires users to reopen their Activity; saved connections survive. Keep a database backup before changing the encryption key or database format.
