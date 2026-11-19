# Troubleshooting

- **Open this Activity inside Discord:** production ingress did not receive valid Discord proof. Verify the selected signature/edge mode. Do not disable the gate or use a browser Origin header as proof.
- **Login fails:** verify the Audiobookshelf base URL, account status and library permissions. Custom URLs must use public HTTPS. Only the exact configured default may use private HTTP; the optional public alias must identify that same server.
- **Authentik does not return:** check the exact Activity callback URI in Authentik, Audiobookshelf's OpenID Connect configuration and support for the native mobile PKCE flow. Keep the Activity open while finishing the external browser flow. A used/expired ticket or callback opened in a different browser must be restarted.
- **Audio cannot start:** tap the native player to satisfy autoplay rules. Check codec support, Audiobookshelf transcoding and the gateway WebSocket. Each viewer uses an independent stream. Physical-device background playback depends on Discord and the OS.
- **A party is out of date:** reconnect to obtain the current snapshot. Old commands are deliberately rejected. A changed server/account requires a fresh authorized connection; a restarted backend requires reopening the Activity.

Community listeners share upstream history and bookmarks. Only one active viewer writes shared progress; cross-device Audiobookshelf progress messages do not seek the group. Use personal accounts for independent histories.

A rejected queue can mean an item is unavailable to one of the participants. Give the intended account access to the book, or choose a book everyone can access. Native settings and administrative operations that are outside the Activity gateway are unavailable by design.

Run `pnpm smoke` against a locally reachable app for health/authorization checks. It does not prove playback or Authentik provider configuration. Use the tests and a real two-participant Activity run for those behaviors.
