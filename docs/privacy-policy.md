# Deployment privacy notice

This project does not designate a single service operator. The operator of each deployment must publish their identity, contact details and applicable retention policy before offering the Activity to other people.

The Activity processes your Discord identity and Activity membership, saved Audiobookshelf server/account identities, encrypted access and refresh tokens, preferred connections, and transient playback/queue state. Passwords entered for login are sent to the chosen Audiobookshelf server and are not stored by the Activity.

Discord processes Activity authentication and embedded traffic. Your chosen Audiobookshelf server processes library access, streams, playback sessions, progress and bookmarks. If you use Authentik or another OpenID Connect provider, that provider handles the external sign-in. Hosting and ingress providers may process network traffic and operational logs according to the operator's deployment.

To diagnose missing Discord listening status, the Activity records bounded technical events: whether audio and title metadata are available, whether a status request succeeded, and a numeric error code when available. These records use a shortened hash of the Discord user ID to correlate events. They contain no book titles, media addresses, credentials or raw error messages, and follow the operator's operational-log retention policy.

Personal listening progress belongs to your Audiobookshelf account. A community account intentionally shares its history and bookmarks with other users of that account. Saved connections are owned by your Discord account and remain until disconnected or removed by the operator. Live sessions and queues are kept in memory and cleared on restart.

Disconnecting an account removes the saved connection, stops its Activity viewers and attempts upstream logout. You can also revoke the application's Discord authorization. Contact your deployment operator for data requests; contact Discord, Audiobookshelf or your identity provider for records they control independently.
