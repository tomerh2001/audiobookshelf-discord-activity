export const discordCommands = [
  { name: "listen", description: "Open the Audiobookshelf listening party in this channel", type: 1 },
  { name: "Listen to Audiobookshelf", type: 2 },
  { name: "Listen to Audiobookshelf", type: 3 },
  {
    name: "audiobookshelf", description: "Control your voice channel's Audiobookshelf listening party", type: 1,
    options: [
      { name: "play", description: "Find an audiobook to listen to", type: 1, options: [
        { name: "query", description: "Audiobook title", type: 3, required: true, min_length: 1, max_length: 200 }
      ] },
      { name: "pause", description: "Pause the listening party", type: 1 },
      { name: "resume", description: "Resume the listening party", type: 1 },
      { name: "seek", description: "Seek the party to a position", type: 1, options: [
        { name: "seconds", description: "Position in seconds", type: 10, required: true, min_value: 0, max_value: 31536000 }
      ] },
      { name: "stop", description: "Stop party playback", type: 1 },
      { name: "next", description: "Play the next book or episode", type: 1 },
      { name: "previous", description: "Play the previous book or episode", type: 1 },
      { name: "now", description: "Show the current book or episode", type: 1 }
    ]
  }
].map((command) => ({ ...command, contexts: [0], integration_types: [0] }));
