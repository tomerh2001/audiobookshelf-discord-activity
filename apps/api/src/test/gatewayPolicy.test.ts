import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEnv } from "../env.js";
import { websocketPlugin } from "../plugins/websocket.js";
import { nativeAudiobookshelfRoutes } from "../routes/nativeAudiobookshelf.js";
import { getNativePartyService } from "../services/nativeParty.js";
import { sessionStore } from "../services/sessionStore.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("native shared-account gateway policy", () => {
  it("rejects a participant's attempt to replace the party server without revoking existing viewers", async () => {
    const f = await fixture("personal");
    const session = sessionStore.getSession(f.follower.viewer.appSessionId)!;
    const party = f.service.get(session)!;
    expect(await f.service.bind(session, f.follower.viewer.connection.id)).toBe(party);
    vi.spyOn(f.service.dependencies, "resolve").mockResolvedValue({ ...f.follower.viewer.connection,
      id: "foreign-connection", serverUrl: "https://other.example", serverId: "another-server" });
    await expect(f.service.bind(session, "foreign-connection")).rejects.toMatchObject({ code: "party_server_mismatch", statusCode: 409 });
    expect(f.service.get(session)).toBe(party);
    expect(party.viewers.size).toBe(2);
    expect(f.service.active(f.writer.viewer)).toBe(true);
    expect(f.service.active(f.follower.viewer)).toBe(true);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("prevents followers from bypassing the progress writer with direct PATCH or DELETE", async () => {
    const f = await fixture("community");
    for (const method of ["PATCH", "DELETE"] as const) {
      const denied = await f.app.inject({ method, url: `${f.follower.baseUrl}/api/me/progress/book-one`,
        ...(method === "PATCH" ? { payload: { isFinished: true } } : {}) });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ error: { code: "native_shared_progress_read_only" } });
    }
    expect(f.fetch).not.toHaveBeenCalled();
    const accepted = await f.app.inject({ method: "PATCH", url: `${f.writer.baseUrl}/api/me/progress/book-one`, payload: { isFinished: true } });
    expect(accepted.statusCode).toBe(200);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.fetch.mock.calls[0]?.[1]).toBe("/api/me/progress/book-one");
  });

  it("lets the next active viewer save shared progress after the current writer disconnects", async () => {
    const f = await fixture("community");
    f.writer.viewer.sockets = 0;
    const accepted = await f.app.inject({ method: "DELETE", url: `${f.follower.baseUrl}/api/me/progress/book-one/episode-one` });
    expect(accepted.statusCode).toBe(200);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not impose shared-account progress restrictions on personal accounts", async () => {
    const f = await fixture("personal");
    const accepted = await f.app.inject({ method: "PATCH", url: `${f.follower.baseUrl}/api/me/progress/book-one`, payload: { currentTime: 15 } });
    expect(accepted.statusCode).toBe(200);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves library history and statistics while removing raw native session IDs", async () => {
    const f = await fixture("community");
    f.response.value = { total: 2, sessions: [
      { id: "other-viewer-session", sessionId: "other-viewer-session", streamId: "other-viewer-session", libraryItemId: "book-one", currentTime: 25,
        mediaMetadata: { title: "Book one" }, libraryItem: { id: "book-one", media: { id: "media-one" } } },
      { id: "own-viewer-session", libraryItemId: "book-two", timeListening: 8 }
    ], recentSessions: [{ id: "other-viewer-session", libraryItemId: "book-one", timeListening: 12 }],
      items: { "book-one": { id: "book-one", timeListening: 12 } }, longestAudiobookFinished: { id: "media-one" } };
    f.follower.viewer.playbackSessions.set("own-viewer-session", { itemId: "book-two" });
    for (const endpoint of ["/api/me/listening-sessions", "/api/me/item/listening-sessions/book-one", "/api/me/listening-stats"]) {
      const history = await f.app.inject({ url: f.follower.baseUrl + endpoint });
      expect(history.statusCode).toBe(200);
      expect(history.body).not.toMatch(/other-viewer-session|own-viewer-session|sessionId|streamId/);
      expect(history.json()).toMatchObject({ total: 2, sessions: [
        { libraryItemId: "book-one", currentTime: 25, mediaMetadata: { title: "Book one" }, libraryItem: { id: "book-one", media: { id: "media-one" } } },
        { libraryItemId: "book-two", timeListening: 8 }
      ], items: { "book-one": { id: "book-one", timeListening: 12 } }, longestAudiobookFinished: { id: "media-one" } });
    }
  });
});

async function fixture(kind: "personal" | "community") {
  const app = Fastify({ logger: false });
  const env = loadEnv({ NODE_ENV: "test", DEV_AUTH_MOCK: "true", AUDIOBOOKSHELF_DEFAULT_SERVER_URL: "http://127.0.0.1:13378" });
  app.decorate("envConfig", env); app.decorateRequest("appSession");
  const service = getNativePartyService(app);
  const response = { value: { ok: true } as unknown };
  const fetch = vi.fn(async (_target: unknown, _path: unknown, _init: unknown) => new Response(JSON.stringify(response.value), { headers: { "Content-Type": "application/json" } }));
  service.dependencies.fetch = fetch;
  service.dependencies.current = vi.fn();
  service.dependencies.membership = vi.fn(async () => undefined);
  service.dependencies.resolve = vi.fn(async (_env, _userId, connectionId) => ({
    id: connectionId, serverUrl: "http://127.0.0.1:13378", serverId: "server", serverName: "Fixture", audiobookshelfUserId: "shared-user",
    audiobookshelfUsername: "reader", kind, createdAt: "2026-11-19", updatedAt: "2026-11-19", accessToken: "private-token",
    target: { serverUrl: "http://127.0.0.1:13378", hostname: "127.0.0.1", address: "127.0.0.1", family: 4 as const, operatorApproved: true }
  }));
  await app.register(websocketPlugin); await app.register(nativeAudiobookshelfRoutes); await app.ready();
  cleanups.push(() => app.close());
  const viewers = [];
  for (const user of ["alice", "bob"]) {
    const session = sessionStore.createSession({ id: randomUUID(), discordUserId: user, expiresAt: new Date(Date.now() + 60_000),
      discordContext: { instanceId: "instance", guildId: "guild", channelId: "channel" } });
    cleanups.push(() => sessionStore.deleteSession(session.id));
    await service.bind(session, `connection-${user}`);
    const launched = await service.launch(session, `connection-${user}`, randomUUID());
    const viewer = service.viewers.get(launched.accessToken)!;
    viewer.sockets = 1; viewer.joined = true;
    viewers.push({ ...launched, viewer });
  }
  viewers.sort((left, right) => left.viewer.deviceId.localeCompare(right.viewer.deviceId));
  return { app, service, fetch, response, writer: viewers[0]!, follower: viewers[1]! };
}
