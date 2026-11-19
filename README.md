# Audiobookshelf Listen

Listen to audiobooks together inside a Discord call using Audiobookshelf's native web interface. This project adapts [Jellyfin Watch](https://github.com/tomerh2001/jellyfin-discord-activity), retaining its Discord authentication, saved connections, community accounts and shared playback coordinator.

Each operator supplies their own Discord application, public Activity address and Audiobookshelf configuration. No particular Discord guild, Audiobookshelf server or Authentik instance is required.

## Listen together

1. Open **Audiobookshelf Listen** from a call's Activities menu, `/listen`, or **Apps → Listen to Audiobookshelf**.
2. Connect your Audiobookshelf account with a server URL and password, choose **Sign in with Authentik / OpenID Connect**, or explicitly choose the operator's community account.
3. Browse the native library and play a book. Other participants join the same Activity and connect an account on that server.
4. Play, pause, seek, change speed or manage the shared queue. Each participant keeps their own volume and stream.

The shared timeline supports late joins, local buffering, drift correction, duplicate queue entries, next/previous, repeat modes and reconnect recovery. Book positions cover all audio tracks. Chapters, bookmarks, playback sessions and personal listening progress use Audiobookshelf's native features. Podcast episodes can be selected through its native interface.

Audiobookshelf v2.38.0 has no native group-playback protocol. Its session `sync` endpoint saves progress. This Activity therefore uses the playback coordinator inherited from Jellyfin Watch, with Audiobookshelf's native player, sessions, direct audio and HLS transcoding. [Upstream evidence](docs/upstream-research.md) records the inspected version and routes.

## Accounts and access

Personal and community accounts remain separate choices. Saved connections belong to a Discord user, with a preferred connection per Discord server. Joining an existing Activity preserves its server; choosing another account cannot silently replace someone else's party. Signing out disconnects the selected account while leaving Discord connected.

Community users need no personal Audiobookshelf account. The operator creates one restricted Audiobookshelf user and supplies its credentials on the backend. Community viewers have separate playback devices and sessions, but share that account's history and bookmarks. One active viewer writes shared progress so other devices do not continually overwrite it.

`DISCORD_ACCESS_MODE=public` admits any verified participant in this Discord application's Activity. `restricted` uses configured guild/user allowlists. Community access has its own explicit `guilds` or `public` setting. Public mode still requires Discord authentication, current Activity membership and an authorized Audiobookshelf account.

Authentik login uses the selected Audiobookshelf server's native OpenID Connect integration. The identity provider opens in an external browser; the Activity waits for completion. Configure Authentik in Audiobookshelf and add the Activity callback URI as described in [Authentik setup](docs/authentik.md). The Activity does not need an Authentik administrator token or client secret.

## Discord controls

| Command | Behavior |
| --- | --- |
| `/listen` or Apps → Listen to Audiobookshelf | Open the Activity in the invoked channel |
| `/audiobookshelf play query:…` | Search accessible libraries and play a book |
| `/audiobookshelf pause`, `resume`, `seek` | Control the shared timeline |
| `/audiobookshelf next`, `previous`, `stop` | Move through or clear the queue |
| `/audiobookshelf now` | Show the current title and position |

Control commands verify the caller's current voice channel and active player. Replies are private to that caller. Launching never posts an invitation automatically; use Discord's own invitation controls. The participant panel and Rich Presence follow the running Activity.

## Self-host

Copy `.env.example` to `.env`, generate independent session/encryption secrets, and configure [Discord](docs/discord-setup.md), [Audiobookshelf](docs/audiobookshelf-setup.md) and [deployment](docs/deployment.md). Build and start with `docker compose up -d --build`. The optional Caddy profile supplies HTTPS once its domain and DNS are configured.

The included workflow tests pull requests and publishes `ghcr.io/<repository-owner>/<repository-name>:latest` from `main` after checks pass. Set `ACTIVITY_IMAGE` to your published image when using registry deployment. This source checkout does not imply an image or Discord application has already been published.

The backend protects media and saved tokens. Custom servers must use public HTTPS; the exact operator-configured default is the only private-network/HTTP exception. Tokens stay encrypted on the backend, browser capabilities remain in memory, upstream playback-session IDs are replaced with opaque aliases, and every media request passes the Activity gateway. See [security](docs/security.md).

## Development

Use Node 24 and the pinned pnpm version:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build:native
pnpm build
pnpm typecheck
pnpm lint
pnpm test
node --test native-client/test/*.test.mjs
cp -R apps/activity-web/dist/. native-client/dist/
```

The native build pins Audiobookshelf v2.38.0 and verifies its source archive digest. Development mock authentication requires both `DEV_AUTH_MOCK=true` and `VITE_DEV_DISCORD_MOCK=true`; production refuses mock authentication. See [native integration](native-client/README.md).

Physical iOS/Android playback, background audio and Discord's external-browser handoff require device testing. Browser tests cannot establish those behaviors. Each participant receives a separate stream, so server bandwidth and transcoding capacity must cover the party. Saved accounts persist across restarts; active timelines do not.

See the [feature mapping](docs/feature-parity.md) and [validation report](docs/validation.md) for the inherited features, completed checks and remaining live-deployment checks.

## Licensing

The original Activity backend and integration retain the [MIT license](LICENSE) and attribution to [camarokris/jellyfin-discord-activity](https://github.com/camarokris/jellyfin-discord-activity) and the Jellyfin Watch fork. Audiobookshelf and modifications to its native web client are GPL-3.0-only. The native build packages its license, source revision and modified source; redistributors must preserve the corresponding-source obligations.
