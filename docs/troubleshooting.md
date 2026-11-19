# Troubleshooting

- **Open this Activity inside Discord:** production ingress did not receive valid Discord proof. Verify the selected signature/edge mode. Do not disable the gate or use a browser Origin header as proof.
- **Login fails:** verify the Audiobookshelf base URL, account status and library permissions. Custom URLs must use public HTTPS. Only the exact configured default may use private HTTP; the optional public alias must identify that same server.
- **Authentik does not return:** check the exact Activity callback URI in Authentik, Audiobookshelf's OpenID Connect configuration and support for the native mobile PKCE flow. Keep the Activity open while finishing the external browser flow. A used/expired ticket or callback opened in a different browser must be restarted.
- **Audio cannot start:** tap the native player to satisfy autoplay rules. Check codec support, Audiobookshelf transcoding and the gateway WebSocket. Each viewer uses an independent stream. Physical-device background playback depends on Discord and the OS.
- **A party is out of date:** reconnect to obtain the current snapshot. Old commands are deliberately rejected. A changed server/account requires a fresh authorized connection. After a backend restart, the Activity can renew its verified Discord session and reconnect the selected account once. The old queue is not retained. If recovery fails, choose a saved account or use Try again.

Community listeners share upstream history and bookmarks. Only one active viewer writes shared progress; cross-device Audiobookshelf progress messages do not seek the group. Use personal accounts for independent histories.

A rejected queue can mean an item is unavailable to one of the participants. Give the intended account access to the book, or choose a book everyone can access. Native settings and administrative operations that are outside the Activity gateway are unavailable by design.

Run `pnpm smoke` against a locally reachable app for health/authorization checks. It does not prove playback or Authentik provider configuration. Use the tests and a real two-participant Activity run for those behaviors.

## Missing Discord profile title

The title comes from the actual native player and is submitted through the authenticated Embedded App SDK. A saved OAuth grant alone does not prove that the current document received its scope or published a status.

After reproducing in the Activity, inspect `activity_presence_diagnostic` in the operator's application logs. These authenticated, client-reported events contain no titles or media addresses:

- `disabled` identifies a missing SDK/scope or a mock/standalone launch.
- `observer` identifies the queue/player gate; `ready` means the observer reached its publish path.
- `attempt` records a set/clear request. `success` means the SDK accepted a response; its `titlePresent` describes the returned response, not just the request.
- `error` distinguishes a numeric Discord error, a validation failure, a timeout or an unknown failure.

No diagnostic event proves that Discord rendered a profile card. The installed SDK validates responses: an empty synthetic response is not a valid success and may be discarded until the command times out. Use a response with the SDK-required fields in fixtures, then verify the real card separately. Do not log raw SDK traffic; authentication frames can contain credentials.
