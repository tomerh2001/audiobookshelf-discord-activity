# Audiobookshelf Listen branding

Audiobookshelf Listen uses an amber open book with an audio waveform, cyan earcups and violet headphones on midnight navy. It shares Jellyfin Watch's glossy violet/cyan style while keeping its own audiobook identity.

The title is **Audiobookshelf Listen**. The tagline is **Stories sound better together.** The artwork contains no deployment hostname or server identity, so other hosts can reuse it.

## Assets

All source images live in [`native-client/branding`](../native-client/branding). They were generated and visually reviewed on November 19, 2026.

| File | Dimensions | Use |
| --- | --- | --- |
| `audiobookshelf-listen-icon.png` | 1254 × 1254 | Discord application icon, bot avatar, app identity |
| `audiobookshelf-listen-banner.png` | 1672 × 941 | Bot banner and Activity Shelf cover |
| `audiobookshelf-listen-cover.png` | 1254 × 1254 | Square application invite cover |
| `audiobookshelf-listen-background.png` | 1672 × 941 | Activity Grid background, with an open center for Discord's interface |

Keep the square cover separate from the wide banner: Discord's application cover can be cropped square. The wide banner keeps the title and emblem near the center for shorter profile crops. The background deliberately places decoration at the edges.

## Discord metadata

Description, within Discord's 400-character limit:

> Listen to audiobooks and podcasts together in Discord. Connect your Audiobookshelf server, share synchronized playback, and keep the familiar library, chapters, bookmarks and listening progress. Invite friends through an optional community account or sign in with Authentik. Available on desktop and mobile.

Tags: `audiobooks`, `podcasts`, `listening`, `media`, `social`.

## Publishing and verification

Use the normal bot-token API for the bot avatar/banner and application icon/invite cover. Publish the separate Activity art through the owner's Developer Portal under **Activities → Art Assets**: the banner is `embedded_cover`, and the ambient background is `embedded_background`. An application `cover_image` alone does not populate the Activity Shelf.

After saving, reload the portal, read the saved metadata and asset list, and visually inspect the public CDN images. The November 19 publication retained the OAuth redirects, interaction endpoint, installation scopes, permissions and proxy authentication. The participant limit was set to 20 to match the backend. All four image fields, the description and five tags were read back successfully. Both named Activity assets were present after saving.

Discord may resize images and cache old artwork. The verified derivatives were 1024-square for the bot avatar and invite cover, 1024 × 576 for the banner, 256-square for the application icon, and 511 × 287 for the Activity cover. These are observed outputs, not required source sizes. Refresh the Activity Shelf before repeating an upload that already saved successfully.
