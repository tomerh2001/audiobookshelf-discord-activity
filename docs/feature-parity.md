# Feature mapping from Jellyfin Watch

This fork starts from Jellyfin Watch commit `c8a0511`, including its native-client and ordered-playback work through PR #28. The table maps the features present in that implementation to Audiobookshelf Listen. Implementation coverage is separate from live-service verification; see [validation](validation.md) for the tested scope.

## Accounts, Discord and shared listening

| Existing feature | Audiobookshelf equivalent | Main implementation |
| --- | --- | --- |
| Official responsive media client in the Activity document | Pinned official Audiobookshelf 2.38.0 Nuxt/Vue client; native bookshelf, search, item details, chapters, bookmarks and audio player | `native-client/build.mjs`, `integration.mjs` |
| Native login and configurable server | The deployment chooses its Audiobookshelf server. Listeners see only enabled sign-in methods and saved accounts, without entering or viewing a server address | `native-client/src/ActivityLogin.vue`, `apps/api/src/services/audiobookshelfConnections.ts` |
| Explicit community account | Separate opt-in community button when configured; community listeners share the upstream account's history, bookmarks and permissions | Login component, connection service |
| Saved personal accounts and per-guild preference | Broker-saved connections and preferred selection; only an explicitly selected preference restores automatically | `native-client/src/controller.js`, `apps/activity-web/src/api/native.ts` |
| Account switching and sign-out without disconnecting Discord | Switch account returns to saved choices without deleting credentials. Removing an account revokes its connection and capabilities. Both stop local audio, clear account caches and reject stale responses | `native-client/src/runtime.js`, `axios.js`, `integration.mjs` |
| Existing-party server restriction | Login uses the configured library; a saved preference cannot replace another listener's party | Controller and backend party services |
| One Discord authorization flow and verified session recovery | Retained in-memory Discord authorization is checked by the broker before recovering an expired session; bounded retry with visible failure | `apps/activity-web/src/discord/sdk.ts`, native controller |
| Voice Activity entry point, slash and context commands | `/listen`, context launch and `/audiobookshelf` playback commands; caller-scoped replies and verified channel/party ownership | `apps/api/src/routes/discordInteractions.ts`, [Discord setup](discord-setup.md) |
| Native invite/Join Activity behavior | Discord owns invitations; launch does not post unsolicited channel invitations | Discord command handlers and setup |
| Live participants, avatars and self label | Listening-party panel observes SDK snapshot/events; newer pushes beat stale snapshots; refresh does not repeat OAuth | `apps/activity-web/src/discord/participants.ts`, `ActivityControls.vue` |
| Shared ordered timeline, immediate local controls | The existing Activity coordinator owns play/pause, seek, queue, selection and repeat; local effects precede acknowledgement, command IDs/revisions prevent stale replay | `apps/api/src/services/activityPlayback.ts`, `native-client/src/activityPlaybackClient.js` |
| Native SyncPlay preference | Pinned Audiobookshelf has no native group-listening protocol. The Activity coordinator supplies synchronization, matching the final Jellyfin implementation, which also used this coordinator | [Upstream research](upstream-research.md), playback services |
| Late join and reconnect follow current playback | Recovery snapshots restore queue, position, speed and pause state; whole-book seconds include multi-file track offsets | `native-client/src/nativePlaybackAdapter.js` |
| Independent buffering and drift correction | Buffering never pauses the party. Buffered drift gets a small speed adjustment or seek; persistent larger drift and resume can seek across tracks | Native playback adapter |
| Shared queue, duplicates, previous/next and repeat | Stable entry IDs preserve repeated books/episodes; reorder, Play next, shared shuffle, Clear upcoming, repeat none/one/all and coordinated auto-advance preserve the active playback position | Native adapter and upstream queue patches |
| Native library updates during a session | Access-checked item notifications and content-free invalidations refresh the visible library, item metadata and Nuxt page data without restarting playback; removed access cannot expose stale responses | `nativeGateway.ts`, `libraryRefresh.js`, `browseRefresh.js` |
| Keyboard and Back behavior in Activity dialogs | Participants, options and error dialogs trap focus, close with Escape/Back and restore focus to the opener | `ActivityControls.vue`, `activityDialogs.js` |
| Search-to-play commands | Book and podcast search, scoped expiring choices and podcast episode selection; `/now` distinguishes show and episode titles | `discordInteractions.ts`, `nativeParty.ts` |
| App description and artwork | Custom application/bot icon, profile banner, invite/Activity cover and Activity background; matching login and player artwork | [Branding](branding.md), `native-client/branding` |
| Personal controls remain personal | Volume and sleep timers are local. Bookmarks and listening history belong to the selected Audiobookshelf account. Playback speed is explicitly shared | Native player and adapter |
| Mobile autoplay recovery | Tap-to-play invokes the actual audio element inside the gesture, preserves a shared pause and offers retry after refusal | Native adapter and LocalAudioPlayer patch |
| Native direct/transcoded streaming and progress reporting | Audiobookshelf prepares per-viewer direct/HLS playback sessions, accepts session-scoped progress reports and supplies filtered stream events | Native PlayerHandler, `nativeParty.ts`, `nativeGateway.ts` |
| Bounded playback failure recovery | Canceled loads cannot reopen audio; native prepare/transcode retries are bounded; error state offers explicit retry | Native integration and adapter |
| Back navigation inside the Activity | Document-owned route history returns to an Activity route or Home without navigating Discord's parent history | Native runtime |
| Pop-out/reopen restoration | Allowlisted native route checkpoint plus retained server queue/timeline; verified identity/account/channel rules control disconnected-party handoff | `packages/shared/src/nativeNavigation.ts`, native controller/runtime, backend party service |
| Focused, picture-in-picture and grid layouts | SDK presentation events resize the existing native interface and hide browsing chrome in preview; document fullscreen reports refusal without changing the party | `apps/activity-web/src/discord/presentation.ts`, native controls/runtime |
| Rich Presence from real local playback | Listening presence follows actual audio state, title, duration, position and shared speed; pause/buffer removes moving timestamps; updates coalesce and exclude server/token/media URLs | `apps/activity-web/src/discord/richPresence.ts`, native adapter |
| Authentik sign-in, new in this fork | External Audiobookshelf OIDC/PKCE flow with session-bound polling and clear unavailable/failed states; any compatible provider configured on the selected server can work | [Authentik setup](authentik.md), login component and backend OIDC service |

## Isolation and operation

| Existing protection or operational feature | Audiobookshelf equivalent |
| --- | --- |
| Real upstream tokens stay on backend | Encrypted saved Audiobookshelf credentials; browser receives an opaque, expiring gateway capability. Native DTOs and stream paths are sanitized. |
| Narrow authorized gateway | Read, personal-progress, bookmark, playlist and owned-playback-session routes only; item authorization, server binding, session ownership and community boundaries remain server-side. |
| Same mapped origin | Native API, images, audio, HLS and socket use the Activity origin, including servers with a configured subpath. |
| Trusted ingress, Discord access lists and SSRF defense | Existing deployment controls retained; clients cannot select upstream targets; the exact operator default is eligible for private HTTP/LAN access. |
| Storage restrictions and account isolation | Classic memory-storage bootstrap precedes native code; PWA/service-worker caching disabled; stale account responses rejected before Vuex mutations. |
| Narrow filtered WebSocket | One browser Activity socket carries coordinator state and account/session-scoped native events. Community users do not receive another device's progress-seek events. |
| Session revocation and recovery | Sign-out/account removal revoke capabilities and restoration. Discord-wide revocation remains available. Existing lifecycle and authorization regression tests are retained. |
| Reproducible native build | Exact upstream commit and archive checksum, upstream lockfile, failing patch anchors, precompressed static files, Docker build and workspace checks. |
| Source licensing and notices | Original MIT broker/session source retained; combined native output follows upstream GPL-3.0-only. Both corresponding-source archives and upstream notices ship with native assets. |
| Diagnostics without credential disclosure | Fixed user-facing errors; raw upstream tokens, media URLs and capability paths excluded from client debug logs and Rich Presence. |

## Media-specific differences

Jellyfin's movie/TV expansion, intro/credits skip prompts, subtitle selection, alternate video audio tracks, video quality selection, trickplay thumbnail sheets and video-element Safari fullscreen are video-specific. Audiobookshelf supplies its native audio tracks, chapters, cover art, listening progress and podcast episodes instead. The same whole-book timeline controls seeking across files; no separate custom player is introduced.

The Activity is for audiobooks and podcasts. Ebook reading controls are hidden, and ebook reader/download, library administration, uploads, editing server metadata, Chromecast/remote-player control and arbitrary native group selection are not exposed. Device codec support, physical mobile autoplay/background behavior, outer Discord fullscreen and real provider sign-in still require their respective environments to verify.
