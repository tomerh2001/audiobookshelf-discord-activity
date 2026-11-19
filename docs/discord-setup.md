# Discord setup

Create a separate Discord application for Audiobookshelf Listen in the Discord Developer Portal. Supply its application ID, client secret, public key and bot token through `.env` or Docker secrets. Do not reuse a Jellyfin application ID: its URL mapping and commands belong to a different Activity.

Enable Activities and configure the root URL mapping to your public Activity origin. Enable Web, iOS and Android if you plan to test all three platforms. The backend and native media must remain on the mapped Activity origin. Configure the interaction endpoint as `https://listen.example.com/api/discord/interactions`, replacing the example with your deployment.

Install the application in your intended Discord server with its application commands. Register commands using `pnpm discord:register` in a configured environment. Registration changes Discord app configuration; it does not send an invitation or chat message. The registration tool sets the Activity entry point to the app handler so launching does not automatically post a public follow-up.

The app registers `/listen`, the user/message context command **Listen to Audiobookshelf**, and `/audiobookshelf` playback controls. Controls resolve the caller's current voice channel, require their connected Activity player and return ephemeral replies. Starting from another text channel does not move a party into a voice channel automatically.

For reuse beyond one server, choose `DISCORD_ACCESS_MODE=public` and distribute your configured application installation link. Alternatively keep `restricted` and list allowed guilds/users. Community account access is an independent operator setting; public Discord access does not automatically grant it.

Use Discord's built-in Invite or Join Activity controls. Verify launches, participant changes, Rich Presence, popout recovery, mobile layouts and the external Authentik handoff from real Discord clients before considering a deployment live.
