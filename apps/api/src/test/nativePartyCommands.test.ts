import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativePartyService, type NativeConnection } from "../services/nativeParty.js";
import { createAppSession } from "../services/appSession.js";
import { sessionStore, type AppSession } from "../services/sessionStore.js";
import { loadEnv } from "../env.js";

const BOOK = "book-one";
const PODCAST = "podcast-one";
const book = { id: BOOK, mediaType: "book", media: { metadata: { title: "A book" } } };
const episode = (index: number) => ({ id: `episode-${index}`, title: `Episode ${index}`, publishedAt: index * 1000 });
const podcast = { id: PODCAST, mediaType: "podcast", media: { metadata: { title: "A podcast" }, episodes: Array.from({ length: 30 }, (_, index) => episode(index)) } };
let service: NativePartyService;
let sessions: AppSession[];
let denied: Set<string>;

beforeEach(() => {
  sessions = []; denied = new Set();
  service = new NativePartyService(loadEnv({ NODE_ENV: "test", DEV_AUTH_MOCK: "true" }), {
    resolve: vi.fn(async (_env, userId, connectionId) => ({ id: connectionId, serverId: "server", serverUrl: "https://fixture.invalid",
      serverName: "Fixture", audiobookshelfUserId: userId, audiobookshelfUsername: userId, kind: "personal", createdAt: "", updatedAt: "",
      accessToken: userId, target: {} } as NativeConnection)),
    current: vi.fn(), membership: vi.fn(async () => undefined),
    fetch: vi.fn(async (_target, path, options) => {
      const user = String((options?.headers as Record<string, string>).Authorization).replace(/^Bearer /, "");
      if (path === "/api/me") return Response.json({ isActive: true });
      if (path === "/api/libraries") return Response.json({ libraries: [{ id: "books" }, { id: "podcasts" }] });
      if (path.startsWith("/api/libraries/books/search?")) return Response.json({ book: [{ libraryItem: book }] });
      if (path.startsWith("/api/libraries/podcasts/search?")) return Response.json({
        podcast: [{ libraryItem: { ...podcast, media: { ...podcast.media, episodes: [] } } }],
        episodes: [{ libraryItem: { ...podcast, recentEpisode: episode(4) } }]
      });
      if (path.startsWith(`/api/items/${PODCAST}`)) return denied.has(user) ? Response.json({}, { status: 403 }) : Response.json(podcast);
      if (path.startsWith(`/api/items/${BOOK}`)) return Response.json(book);
      throw new Error(`Unexpected fixture path ${path}`);
    })
  });
});
afterEach(async () => { await service.close(); for (const session of sessions) sessionStore.deleteSession(session.id); });

async function viewer(id = "first") {
  const { session } = await createAppSession({ env: service.env, user: { id, username: id },
    discordContext: { instanceId: "party", guildId: "guild", channelId: "channel" } });
  sessions.push(session);
  await service.bind(session, `connection-${id}`);
  const launch = await service.launch(session, `connection-${id}`, randomUUID());
  const actor = service.viewers.get(launch.accessToken)!;
  actor.sockets = 1; await service.playback.connect(actor, () => undefined);
  return actor;
}

describe("native Discord media commands", () => {
  it("combines native book, podcast and episode search matches", async () => {
    const actor = await viewer();
    const result = await service.command(actor, "search", { query: "a title" }) as { items: unknown[] };
    expect(result.items).toHaveLength(3);
    expect(result.items[0]).toEqual(book);
    expect(result.items[1]).toMatchObject({ id: PODCAST, recentEpisode: episode(4) });
    expect(result.items[2]).toMatchObject({ id: PODCAST, mediaType: "podcast" });
    expect(service.dependencies.fetch).toHaveBeenCalledWith(expect.anything(), "/api/libraries/podcasts/search?q=a+title&limit=20", expect.anything());
  });

  it("offers only the newest 25 episodes from the caller's accessible podcast", async () => {
    const actor = await viewer();
    const result = await service.command(actor, "episodes", { itemIds: [PODCAST] }) as { items: Array<{ recentEpisode: { id: string } }>; total: number };
    expect(result.total).toBe(30); expect(result.items).toHaveLength(25);
    expect(result.items[0]!.recentEpisode.id).toBe("episode-29");
    expect(result.items.at(-1)!.recentEpisode.id).toBe("episode-5");
    denied.add("first");
    await expect(service.command(actor, "episodes", { itemIds: [PODCAST] })).rejects.toMatchObject({ code: "audiobookshelf_request_failed" });
    await expect(service.command(actor, "episodes", { itemIds: ["../private"] })).rejects.toMatchObject({ code: "native_item_denied" });
    await expect(service.command(actor, "episodes", { itemIds: [BOOK] })).rejects.toMatchObject({ code: "native_item_denied" });
  });

  it("preserves episode identity through the shared queue and reports the playing episode", async () => {
    const actor = await viewer();
    await service.command(actor, "select", { items: [{ itemId: PODCAST, episodeId: "episode-4" }, { itemId: PODCAST, episodeId: "episode-5" }] });
    expect((await service.playback.get(actor)).snapshot.queue).toMatchObject([
      { itemId: PODCAST, episodeId: "episode-4" }, { itemId: PODCAST, episodeId: "episode-5" }
    ]);
    expect(await service.command(actor, "now")).toMatchObject({ itemId: PODCAST, episodeId: "episode-4", title: "A podcast — Episode 4" });
    await service.command(actor, "next");
    expect(await service.command(actor, "now")).toMatchObject({ episodeId: "episode-5", title: "A podcast — Episode 5" });
    await service.command(actor, "previous");
    expect(await service.command(actor, "now")).toMatchObject({ episodeId: "episode-4", title: "A podcast — Episode 4" });
  });

  it("still rejects a selection when any connected participant cannot access that podcast", async () => {
    const actor = await viewer(); await viewer("second"); denied.add("second");
    await expect(service.command(actor, "select", { items: [{ itemId: PODCAST, episodeId: "episode-4" }] }))
      .rejects.toMatchObject({ code: "native_item_denied" });
    expect((await service.playback.get(actor)).snapshot.queue).toEqual([]);
  });
});
