import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { allowedDiscordActor, verifyDiscordActivityContext } from "../services/discord.js";
import { verifyInteractionSignature } from "../services/interactionSignature.js";
import { getNativePartyService, type NativePartyService, type NativeViewer } from "../services/nativeParty.js";

const optionSchema = z.object({ name: z.string(), value: z.union([z.string(), z.number(), z.boolean()]).optional() });
const interactionSchema = z.object({
  id: z.string().min(1), application_id: z.string(), type: z.number(), token: z.string().optional(),
  guild_id: z.string().optional(), channel_id: z.string().optional(),
  member: z.object({ user: z.object({ id: z.string() }) }).optional(),
  data: z.object({ name: z.string().optional(), type: z.number().int().optional(), custom_id: z.string().optional(), values: z.array(z.string()).optional(),
    options: z.array(z.object({ name: z.string(), options: z.array(optionSchema).optional() })).optional()
  }).optional()
});
type Interaction = z.infer<typeof interactionSchema>;
type Message = { content: string; components?: unknown[] };
const ephemeral = (content: string) => ({ type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } });

export const discordInteractionRoutes: FastifyPluginAsync = async (app) => {
  // Encapsulated parser preserves the exact signed bytes without changing other API routes.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 65536 }, (_request, body, done) => done(null, body));
  const handled = new Map<string, { expiresAt: number; response: unknown }>();
  app.post("/api/discord/interactions", async (request, reply) => {
    const signature = request.headers["x-signature-ed25519"];
    const timestamp = request.headers["x-signature-timestamp"];
    if (!Buffer.isBuffer(request.body) || typeof signature !== "string" || typeof timestamp !== "string"
      || !verifyInteractionSignature(app.envConfig.DISCORD_PUBLIC_KEY, signature, timestamp, request.body)) {
      return reply.code(401).send({ error: "Invalid Discord signature" });
    }
    let json: unknown;
    try { json = JSON.parse(request.body.toString("utf8")); } catch { return reply.code(400).send({ error: "Invalid JSON" }); }
    const parsed = interactionSchema.safeParse(json);
    if (!parsed.success || parsed.data.application_id !== app.envConfig.DISCORD_CLIENT_ID) {
      return reply.code(400).send({ error: "Invalid interaction" });
    }
    const interaction = parsed.data;
    if (interaction.type === 1) return { type: 1 };
    const userId = interaction.member?.user.id;
    if (!interaction.guild_id || !userId || !allowedDiscordActor(app.envConfig, userId, interaction.guild_id)) {
      return ephemeral("This listening party is limited to the configured server and users.");
    }
    const now = Date.now();
    for (const [id, cached] of handled) if (cached.expiresAt < now) handled.delete(id);
    const cached = handled.get(interaction.id);
    if (cached) return cached.response;
    if (handled.size >= 10000) return reply.code(429).send({ error: "Too many interactions" });
    const launch = interaction.type === 2 && (interaction.data?.type === 4
      || ["listen", "Listen to Audiobookshelf"].includes(interaction.data?.name ?? ""));
    if (launch) {
      // The user invoked an entry point, slash command or context menu in this
      // channel. Launch only: never create a public invitation/follow-up here.
      const response = { type: 12 };
      handled.set(interaction.id, { expiresAt: now + 300_000, response });
      return response;
    }
    const control = interaction.type === 2 && interaction.data?.name === "audiobookshelf";
    const select = interaction.type === 3 && interaction.data?.custom_id?.startsWith("audiobookshelf:select:");
    if ((!control && !select) || !interaction.token) return ephemeral("Unknown command. Use /listen or /audiobookshelf.");
    const response = { type: 5, data: { flags: 64 } };
    handled.set(interaction.id, { expiresAt: now + 300_000, response });
    void runControl(app, interaction, userId)
      .catch((error: unknown): Message => ({ content: error instanceof CommandError
        ? error.message : "The command could not complete. Check the Activity connection and try again." }))
      .then(async (message) => {
        const result = await fetch(`https://discord.com/api/v10/webhooks/${app.envConfig.DISCORD_CLIENT_ID}/${encodeURIComponent(interaction.token!)}/messages/@original`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...message, allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(10_000)
        });
        if (!result.ok) app.log.warn({ status: result.status }, "Discord command response failed");
      }).catch(() => app.log.warn("Discord command response unavailable"));
    return response;
  });
};

class CommandError extends Error {}

const mediaSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  mediaType: z.enum(["book", "podcast"]).optional(),
  media: z.object({ metadata: z.object({ title: z.string().min(1), authorName: z.string().optional(), author: z.string().optional() }) }),
  recentEpisode: z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), title: z.string().min(1) }).optional()
});
type Media = z.infer<typeof mediaSchema>;
// Discord option values have a 100-character ceiling. Keep opaque choices
// scoped to this renderer/account instead of squeezing two upstream IDs into it.
const choices = new WeakMap<NativeViewer, Map<string, { media: Media; expiresAt: number }>>();
function parseMedia(result: unknown): Media[] {
  return z.object({ items: z.array(z.unknown()) }).parse(result).items.flatMap(item => {
    const parsed = mediaSchema.safeParse(item); return parsed.success ? [parsed.data] : [];
  }).slice(0, 25);
}
function mediaTitle(item: Media): string {
  return item.recentEpisode ? `${item.media.metadata.title} — ${item.recentEpisode.title}` : item.media.metadata.title;
}
async function selectMedia(parties: NativePartyService, viewer: NativeViewer, item: Media): Promise<Message> {
  if (item.mediaType === "podcast" && !item.recentEpisode) {
    const result = await parties.command(viewer, "episodes", { itemIds: [item.id] });
    const episodes = parseMedia(result).filter(entry => !!entry.recentEpisode);
    if (!episodes.length) return { content: "This podcast has no available episodes. Browse Audiobookshelf in the Activity." };
    return mediaChoices(parties, viewer, episodes, "Choose an episode (up to 25 newest; browse the Activity for more):");
  }
  await parties.command(viewer, "select", { items: [{ itemId: item.id, ...(item.recentEpisode ? { episodeId: item.recentEpisode.id } : {}) }] });
  return { content: `Selected ${mediaTitle(item)} for everyone.` };
}
async function mediaChoices(parties: NativePartyService, viewer: NativeViewer, items: Media[], prompt: string): Promise<Message> {
  if (items.length === 1) return selectMedia(parties, viewer, items[0]!);
  let records = choices.get(viewer);
  if (!records) { records = new Map(); choices.set(viewer, records); }
  for (const [id, value] of records) if (value.expiresAt <= Date.now()) records.delete(id);
  if (records.size + items.length > 100) records.clear();
  const options = items.map(item => {
    const id = randomBytes(16).toString("hex"); records!.set(id, { media: item, expiresAt: Date.now() + 300_000 });
    return { label: (item.recentEpisode?.title ?? item.media.metadata.title).slice(0, 100), value: id,
      description: (item.recentEpisode ? item.media.metadata.title
        : item.media.metadata.authorName || item.media.metadata.author || (item.mediaType === "podcast" ? "Podcast — choose an episode" : "Audiobook")).slice(0, 100) };
  });
  return { content: prompt, components: [{ type: 1, components: [{ type: 3,
    custom_id: `audiobookshelf:select:${viewer.partyId}`, placeholder: "Select an audiobook or episode", options }] }] };
}

export async function runControl(app: FastifyInstance, interaction: Interaction, userId: string): Promise<Message> {
  const env = app.envConfig;
  const guildId = interaction.guild_id!;
  const voice = await fetch(`https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/voice-states/${encodeURIComponent(userId)}`, {
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` }, signal: AbortSignal.timeout(10_000)
  });
  if (!voice.ok) throw new CommandError("Join a voice channel and open /listen first.");
  const state = z.object({ channel_id: z.string().nullable() }).parse(await voice.json());
  if (!state.channel_id) throw new CommandError("Join a voice channel first.");
  const parties = getNativePartyService(app);
  const party = parties.getPartyForChannel(guildId, state.channel_id);
  if (!party) throw new CommandError("Open /listen in your voice channel and connect to Audiobookshelf first.");
  await verifyDiscordActivityContext(env, party.context, userId);
  const viewer = parties.getViewerForDiscordUser(party.id, userId);
  if (!viewer) throw new CommandError("Join the Activity and connect its Audiobookshelf player first.");
  const subcommand = interaction.data?.options?.[0];
  const action = interaction.type === 3 ? "select" : subcommand?.name;
  if (action === "now") {
    const current = z.object({ title: z.string().optional(), positionSeconds: z.number(), isPaused: z.boolean() })
      .parse(await parties.command(viewer, "now"));
    return { content: current.title
      ? `${current.title}: ${current.isPaused ? "paused" : "playing"} at ${Math.floor(current.positionSeconds)} seconds.`
      : "Nothing is playing yet. Pick an audiobook or podcast in Audiobookshelf." };
  }
  if (action === "select") {
    if (interaction.data?.custom_id !== `audiobookshelf:select:${party.id}`) {
      throw new CommandError("That selection belongs to an earlier listening party. Search again with /audiobookshelf play.");
    }
    const id = interaction.data.values?.[0];
    const choice = id && /^[a-f0-9]{32}$/.test(id) ? choices.get(viewer)?.get(id) : undefined;
    if (!choice || choice.expiresAt <= Date.now()) throw new CommandError("That selection expired. Search again with /audiobookshelf play.");
    return selectMedia(parties, viewer, choice.media);
  }
  if (action === "play") {
    const query = subcommand?.options?.find((option) => option.name === "query")?.value;
    if (typeof query !== "string" || !query.trim() || query.length > 200) throw new CommandError("Enter an audiobook, podcast or episode title.");
    const items = parseMedia(await parties.command(viewer, "search", { query }));
    if (!items.length) return { content: "No matching audiobooks or podcasts. Try another title or browse Audiobookshelf in the Activity." };
    return mediaChoices(parties, viewer, items, "Choose an audiobook, podcast or episode:");
  }
  if (action === "seek") {
    const seconds = subcommand?.options?.find((option) => option.name === "seconds")?.value;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0 || seconds > 31536000) {
      throw new CommandError("Choose a position between 0 and 31536000 seconds.");
    }
    await parties.command(viewer, "seek", { seconds });
    return { content: `Seeking the party to ${Math.floor(seconds)} seconds.` };
  }
  const commands = { pause: "pause", resume: "play", stop: "stop", next: "next", previous: "previous" } as const;
  if (!action || !(action in commands)) throw new CommandError("Unknown playback command.");
  await parties.command(viewer, commands[action as keyof typeof commands]);
  const messages = { pause: "Party paused.", resume: "Party resumed.", stop: "Playback stopped.", next: "Moving to the next item.", previous: "Moving to the previous item." };
  return { content: messages[action as keyof typeof messages] };
}
