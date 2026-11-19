import { once } from "node:events";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { Server as SocketIOServer } from "socket.io";
import WebSocket from "ws";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadEnv } from "../env.js";
import { websocketPlugin } from "../plugins/websocket.js";
import { nativePartyRoutes } from "../routes/nativeParty.js";
import { nativeAudiobookshelfRoutes } from "../routes/nativeAudiobookshelf.js";
import { discordAuthRoutes } from "../routes/discordAuth.js";
import { createAppSession } from "../services/appSession.js";
import { sessionStore, type AppSession } from "../services/sessionStore.js";
import { getNativePartyService, type NativePartyService } from "../services/nativeParty.js";
import { allowNativeRequest, rewriteNativePlaylist, sanitizeNativeJson } from "../services/nativeGateway.js";
import { HLS_BODY_IDLE_TIMEOUT_MS } from "../services/nativeMediaStream.js";
import { validateUpstream } from "../services/upstreamPolicy.js";

const ITEM = "11111111-1111-4111-8111-111111111111";
const DENIED = "22222222-2222-4222-8222-222222222222";
const NEXT = "33333333-3333-4333-8333-333333333333";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TOKEN = "fixture-upstream-token-never-browser";
type Call = { method: string; path: string; query: Record<string, string>; body: unknown; authorization: string; range?: string | undefined; ifRange?: string | undefined };
type Frame = { MessageType: string; Data: Record<string, unknown> };
let app: FastifyInstance;
let upstream: FastifyInstance;
let io: SocketIOServer;
let service: NativePartyService;
let appAddress: string;
let upstreamAddress: string;
let sessions: AppSession[];
let calls: Call[];
let tokens: Map<string, string>;
let deniedForUser: Set<string>;
let socketAcceptDelay: number;
let slowTransferClosed: boolean;
let imageContentType: string;
let community: boolean;
let itemDelay: number;

async function eventually(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  expect(check()).toBe(true);
}

beforeEach(async () => {
  sessions = []; calls = []; tokens = new Map(); deniedForUser = new Set(); socketAcceptDelay = 0;
  slowTransferClosed = false; imageContentType = "image/jpeg"; community = false; itemDelay = 0;
  upstream = Fastify({ logger: false });
  io = new SocketIOServer(upstream.server, { transports: ["websocket"] });
  io.on("connection", socket => {
    socket.on("auth", (token: string) => {
      if (!tokens.has(token)) { socket.emit("auth_failed", { message: "Invalid token" }); return; }
      setTimeout(() => socket.emit("init", { userId: tokens.get(token), username: "Fixture" }), socketAcceptDelay);
    });
  });
  upstream.route({ method: ["GET", "HEAD", "POST", "PATCH", "DELETE"], url: "/*", handler: async (request, reply) => {
    const url = new URL(request.url, "http://fixture");
    const authorization = request.headers.authorization ?? "";
    const userId = tokens.get(authorization.replace(/^Bearer /, ""));
    if (!authorization.startsWith("Bearer ") || !userId) return reply.code(401).send({ error: TOKEN });
    calls.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: request.body,
      authorization, range: request.headers.range, ifRange: request.headers["if-range"] as string | undefined });
    const item = /^\/api\/items\/([^/]+)$/.exec(url.pathname);
    if (item) {
      if (itemDelay) await new Promise(resolve => setTimeout(resolve, itemDelay));
      if (item[1] === DENIED || deniedForUser.has(userId)) return reply.code(403).send({ error: TOKEN });
      return { id: item[1], libraryId: "library-books", mediaType: "book", path: "/private/books",
        media: { metadata: { title: "Fixture book", authorName: "Fixture author" }, tracks: [{ ino: "track-one" }] } };
    }
    const play = /^\/api\/items\/([^/]+)\/play(?:\/([^/]+))?$/.exec(url.pathname);
    if (play) {
      const id = randomUUID();
      const forceTranscode = (request.body as { forceTranscode?: boolean })?.forceTranscode;
      return { id, userId, libraryItemId: play[1], episodeId: play[2] ?? null, currentTime: 25, duration: 3600,
        playMethod: forceTranscode ? 2 : 0, accessToken: TOKEN, deviceInfo: { ipAddress: "192.0.2.5" },
        audioTracks: [{ index: 1, startOffset: 0, duration: 3600, mimeType: forceTranscode ? "application/vnd.apple.mpegurl" : "audio/mpeg",
          contentUrl: forceTranscode ? `/hls/${id}/output.m3u8` : `/api/items/${play[1]}/file/track-one`, metadata: { path: "/private/books/book.mp3" } }] };
    }
    if (/^\/api\/session\/[^/]+\/(sync|close)$/.test(url.pathname)) return reply.code(200).send("OK");
    if (url.pathname.endsWith("/cover")) return reply.type(imageContentType).send(Buffer.from("fixture-cover"));
    if (url.pathname.endsWith(".m3u8")) return reply.type("application/vnd.apple.mpegurl").send(`#EXTM3U\n#EXTINF:6,\noutput-0.ts?token=${TOKEN}\n#EXT-X-ENDLIST\n`);
    if (url.pathname.endsWith("/output-99.ts")) {
      reply.hijack();
      reply.raw.writeHead(200, { "Content-Type": "video/mp2t", "Content-Length": "100", "Content-Range": "bytes 0-99/100", "Accept-Ranges": "bytes" });
      reply.raw.flushHeaders();
      if (url.searchParams.get("partial") === "true") reply.raw.write("first");
      reply.raw.once("close", () => { slowTransferClosed = true; });
      return;
    }
    if (url.pathname.endsWith(".ts")) return reply.type("video/mp2t").send(Buffer.from("fixture-segment"));
    if (url.pathname.startsWith("/public/session/") || url.pathname.includes("/file/")) {
      if (url.searchParams.get("slow") === "true") {
        reply.hijack(); reply.raw.writeHead(200, { "Content-Type": "audio/mpeg" }); reply.raw.write("first");
        const timer = setInterval(() => reply.raw.write("chunk"), 20);
        reply.raw.once("close", () => { clearInterval(timer); slowTransferClosed = true; });
        return;
      }
      if (request.headers.range === "bytes=99-100") return reply.code(416).header("Content-Range", "bytes */8").send(TOKEN);
      return reply.code(request.headers.range ? 206 : 200).headers({ "Content-Type": "audio/mpeg", "Accept-Ranges": "bytes",
        ...(request.headers.range ? { "Content-Range": "bytes 0-3/8" } : {}) }).send(Buffer.from(request.headers.range ? "book" : "bookdata"));
    }
    if (url.pathname === "/api/authorize") return { user: { id: userId, username: "Fixture", type: "admin", accessToken: TOKEN, refreshToken: TOKEN,
      permissions: { update: true, delete: true, upload: true, download: true, accessAllLibraries: true } }, serverSettings: { version: "2.38.0" } };
    if (url.pathname === "/api/me") return { id: userId, username: "Fixture", token: TOKEN };
    if (url.pathname === "/api/libraries") return { libraries: [{ id: "library-books", name: "Books" }] };
    return { success: true };
  } });
  upstreamAddress = await upstream.listen({ host: "127.0.0.1", port: 0 });
  const env = loadEnv({ NODE_ENV: "test", DEV_AUTH_MOCK: "true", AUDIOBOOKSHELF_DEFAULT_SERVER_URL: upstreamAddress });
  app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const { statusCode } = error as { statusCode?: number };
    const status = statusCode && statusCode >= 400 && statusCode < 500 ? statusCode : 500;
    return reply.code(status).send({ error: { code: status === 500 ? "internal_error" : "request_failed", message: "Request failed." } });
  });
  app.decorate("envConfig", env); app.decorateRequest("appSession");
  service = getNativePartyService(app);
  const target = await validateUpstream(env, upstreamAddress);
  service.dependencies.resolve = vi.fn(async (_env, userId, connectionId) => {
    const accessToken = `${TOKEN}-${userId}`;
    const audiobookshelfUserId = userId === "viewer-2" ? OTHER : USER;
    tokens.set(accessToken, audiobookshelfUserId);
    return { id: connectionId, serverId: connectionId === "other-server" ? "other" : "server", serverUrl: upstreamAddress,
      serverName: "Fixture Audiobookshelf", audiobookshelfUserId, audiobookshelfUsername: "Fixture", kind: community ? "community" as const : "personal" as const,
      createdAt: "2026-11-19", updatedAt: "2026-11-19", accessToken, target };
  });
  service.dependencies.current = vi.fn();
  await app.register(websocketPlugin);
  await app.register(nativePartyRoutes);
  await app.register(nativeAudiobookshelfRoutes);
  await app.register(discordAuthRoutes);
  appAddress = await app.listen({ host: "127.0.0.1", port: 0 });
});

afterEach(async () => {
  await app?.close(); io?.disconnectSockets(true); io?.close(); await upstream?.close();
  for (const session of sessions) sessionStore.deleteSession(session.id);
  vi.restoreAllMocks();
});

async function actor(id = "viewer-1", instanceId = "test-instance", context = { guildId: "guild", channelId: "channel" }) {
  const created = await createAppSession({ env: app.envConfig, user: { id, username: id }, discordContext: { instanceId, ...context } });
  sessions.push(created.session);
  return { ...created, headers: { authorization: `Bearer ${created.appToken}` } };
}
async function launch(who?: Awaited<ReturnType<typeof actor>>) {
  const owner = who ?? await actor();
  expect((await app.inject({ method: "POST", url: "/api/party", headers: owner.headers, payload: { connectionId: "connection" } })).statusCode).toBe(200);
  const launched = await app.inject({ method: "POST", url: "/api/native/launch", headers: owner.headers, payload: { connectionId: "connection", deviceId: randomUUID() } });
  expect(launched.statusCode).toBe(200);
  const data = launched.json<{ baseUrl: string; accessToken: string; userId: string; serverId: string; deviceId: string; groupId: string; restoreRoute: string | null }>();
  return { owner, data, viewer: service.viewers.get(data.accessToken)! };
}
async function connect(data: Awaited<ReturnType<typeof launch>>["data"]) {
  const socket = new WebSocket(`${appAddress.replace("http:", "ws:")}${data.baseUrl}/socket`);
  await once(socket, "open"); await eventually(() => service.viewers.get(data.accessToken)?.joined === true);
  return socket;
}
async function start(current: Awaited<ReturnType<typeof launch>>, transcode = false) {
  const result = await app.inject({ method: "POST", url: `${current.data.baseUrl}/api/items/${ITEM}/play`,
    payload: { deviceInfo: { deviceId: "borrowed-device" }, mediaPlayer: "untrusted", supportedMimeTypes: ["audio/mpeg"], forceTranscode: transcode } });
  expect(result.statusCode).toBe(200);
  return result.json<{ id: string; audioTracks: Array<{ contentUrl: string }> }>();
}
async function setPlaybackQueue(current: Awaited<ReturnType<typeof launch>>, ids = [ITEM], paused = true) {
  const { snapshot } = await service.playback.get(current.viewer);
  return service.playback.submit(current.viewer, { type: "setQueue", epoch: snapshot.epoch,
    id: randomUUID(), sequence: snapshot.revision + 1, expectedQueueRevision: snapshot.queueRevision,
    issuedAt: Date.now(), queue: ids.map(itemId => ({ id: randomUUID(), itemId })), index: ids.length ? 0 : -1, positionTicks: 0, paused });
}
async function disconnectRenderer(current: Awaited<ReturnType<typeof launch>>) {
  const socket = await connect(current.data); await setPlaybackQueue(current);
  expect((await app.inject({ method: "PUT", url: "/api/native/restore", headers: current.owner.headers,
    payload: { connectionId: "connection", route: `/item/${ITEM}`, sequence: 1 } })).statusCode).toBe(200);
  socket.terminate(); await eventually(() => current.viewer.lastSocketClose > 0); await current.viewer.socketCleanup;
}

describe("native Audiobookshelf HTTP gateway", () => {
  it("uses the selected account bearer and exposes only a scoped capability", async () => {
    const current = await launch();
    expect(JSON.stringify(current.data)).not.toContain(TOKEN);
    const response = await app.inject({ method: "POST", url: `${current.data.baseUrl}/api/authorize`, payload: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json().user).toMatchObject({ id: USER, type: "user", permissions: { update: false, delete: false, download: false } });
    expect(response.body).not.toContain(TOKEN);
    expect(calls.at(-1)?.authorization).toBe(`Bearer ${current.viewer.connection.accessToken}`);
    expect((await app.inject({ url: `${current.data.baseUrl}/api/me?token=stolen` })).statusCode).toBe(403);
  });

  it("opens separate playback sessions and overrides borrowed device identities", async () => {
    const first = await launch(); const second = await launch(await actor("viewer-3"));
    const one = await start(first); const two = await start(second);
    expect(one.id).not.toBe(two.id); expect(first.data.userId).toBe(second.data.userId);
    expect(first.data.deviceId).not.toBe(second.data.deviceId);
    const starts = calls.filter(call => call.path.endsWith("/play"));
    expect(starts.map(call => (call.body as { deviceInfo: { deviceId: string } }).deviceInfo.deviceId)).toEqual([first.data.deviceId, second.data.deviceId]);
    expect(JSON.stringify(one)).not.toContain(TOKEN); expect(JSON.stringify(one)).not.toContain("/private/");
    expect(first.viewer.playbackSessions.size).toBe(1);
    const realSessionId = [...first.viewer.playbackSessions.keys()][0]!;
    expect(JSON.stringify(one)).not.toContain(realSessionId);
    for (const path of [`/api/session/${realSessionId}`, `/public/session/${realSessionId}/track/1`, `/hls/${realSessionId}/output.m3u8`]) {
      expect((await app.inject({ url: first.data.baseUrl + path })).statusCode).toBe(403);
    }
    for (const path of [`/api/session/${one.id}`, `/public/session/${one.id}/track/1`, `/hls/${one.id}/output.m3u8`]) {
      expect((await app.inject({ url: second.data.baseUrl + path })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: "POST", url: `${second.data.baseUrl}/api/session/${one.id}/close`, payload: {} })).statusCode).toBe(403);
  });

  it("can advance through more than eight items without retaining replaced native sessions", async () => {
    const current = await launch(); let previous = "";
    for (let index = 0; index < 10; index++) {
      const session = await start(current);
      if (previous) expect((await app.inject({ url: `${current.data.baseUrl}/public/session/${previous}/track/1` })).statusCode).toBe(403);
      previous = session.id;
      expect(current.viewer.playbackSessions.size).toBe(1);
    }
  });

  it("rejects invalid listening progress before it reaches Audiobookshelf", async () => {
    const current = await launch(); const session = await start(current);
    const before = calls.length;
    for (const payload of [{}, null, { currentTime: "1", timeListened: 1 }, { currentTime: -1, timeListened: 1 }, { currentTime: 10, timeListened: 86401 }]) {
      const response = await app.inject({ method: "POST", url: `${current.data.baseUrl}/api/session/${session.id}/sync`,
        headers: { "content-type": "application/json" }, payload: JSON.stringify(payload) });
      expect(response.statusCode).toBe(400);
    }
    expect(calls.length).toBe(before);
    expect((await app.inject({ method: "POST", url: `${current.data.baseUrl}/api/session/${session.id}/close`, payload: {} })).statusCode).toBe(200);
  });

  it("preserves byte ranges, If-Range, and safe 416 responses", async () => {
    const current = await launch(); const session = await start(current);
    const path = `${current.data.baseUrl}/public/session/${session.id}/track/1`;
    const response = await app.inject({ url: path, headers: { range: "bytes=0-3", "if-range": '"fixture-etag"' } });
    expect(response.statusCode).toBe(206); expect(response.body).toBe("book");
    expect(response.headers["content-range"]).toBe("bytes 0-3/8"); expect(response.headers["accept-ranges"]).toBe("bytes");
    expect(calls.at(-1)).toMatchObject({ range: "bytes=0-3", ifRange: '"fixture-etag"' });
    const invalid = await app.inject({ url: path, headers: { range: "bytes=99-100" } });
    expect(invalid.statusCode).toBe(416); expect(invalid.headers["content-range"]).toBe("bytes */8"); expect(invalid.body).not.toContain(TOKEN);
  });

  it("rewrites native HLS to its own stream capability and rejects foreign targets", async () => {
    const current = await launch(); const session = await start(current, true);
    expect(session.audioTracks[0]?.contentUrl).toBe(`${current.data.baseUrl}/hls/${session.id}/output.m3u8`);
    const response = await app.inject({ url: session.audioTracks[0]!.contentUrl });
    expect(response.statusCode).toBe(200); expect(response.body).toContain(`${current.data.baseUrl}/hls/${session.id}/output-0.ts`);
    expect(response.body).not.toContain(TOKEN); expect(response.body).not.toContain("?token=");
    expect((await app.inject({ url: `${current.data.baseUrl}/hls/${session.id}/output-0.ts` })).body).toBe("fixture-segment");
    for (const reference of ["https://foreign.invalid/secret.ts", "//foreign.invalid/secret.ts", "../../api/settings"]) {
      expect(() => rewriteNativePlaylist(current.viewer, `#EXTM3U\n${reference}\n`, `${upstreamAddress}/hls/${session.id}/output.m3u8`)).toThrow();
    }
  });

  it.each(["/api/users", "/api/settings", "/api/auth-settings", "/api/sessions", `/api/users/${OTHER}/settings`,
    `/api/items/${ITEM}/download`, "/api/items/../settings", "/api/items/%2e%2e/settings", "/api/items/%252e%252e/settings", "/api/items/%2fsettings", "/api/items/\\settings"])("rejects an administrative or ambiguous path: %s", async path => {
    const current = await launch(); expect(allowNativeRequest(current.viewer, "GET", path)).toBe(false);
    expect((await app.inject({ url: current.data.baseUrl + path })).statusCode).toBeGreaterThanOrEqual(400);
  });

  it("checks library visibility before serving public-capable artwork and media", async () => {
    const current = await launch();
    for (const path of [`/api/items/${DENIED}/cover`, `/api/items/${DENIED}/file/track-one`]) {
      expect((await app.inject({ url: current.data.baseUrl + path })).statusCode).toBe(403);
      expect(calls.some(call => call.path === path)).toBe(false);
    }
  });

  it("does not share item-access cache between participants", async () => {
    const first = await launch(); const second = await launch(await actor("viewer-2")); itemDelay = 20;
    const responses = await Promise.all([first, second].flatMap(current => Array.from({ length: 4 }, () => app.inject({ url: `${current.data.baseUrl}/api/items/${ITEM}/cover` }))));
    expect(responses.map(response => response.statusCode)).toEqual(Array(8).fill(200));
    expect(calls.filter(call => call.path === `/api/items/${ITEM}`)).toHaveLength(2);
    deniedForUser.add(second.data.userId); second.viewer.itemAccess.clear();
    expect((await app.inject({ url: `${second.data.baseUrl}/api/items/${ITEM}/cover` })).statusCode).toBe(403);
    expect((await app.inject({ url: `${first.data.baseUrl}/api/items/${ITEM}/cover` })).statusCode).toBe(200);
  });

  it("allows one community progress writer and closes follower sessions without stale progress", async () => {
    community = true;
    const first = await launch(); const second = await launch(await actor("viewer-3"));
    const one = await connect(first.data); const two = await connect(second.data);
    const peers = [first, second].sort((a, b) => a.viewer.deviceId.localeCompare(b.viewer.deviceId));
    const leader = peers[0]!; const follower = peers[1]!;
    const leaderSession = await start(leader); const followerSession = await start(follower);
    const progress = { currentTime: 100, timeListened: 30 };
    for (const [current, session] of [[leader, leaderSession], [follower, followerSession]] as const) {
      expect((await app.inject({ method: "POST", url: `${current.data.baseUrl}/api/session/${session.id}/sync`, payload: progress })).statusCode).toBe(200);
    }
    expect(calls.filter(call => call.path.endsWith("/sync"))).toHaveLength(1);
    expect((await app.inject({ method: "POST", url: `${follower.data.baseUrl}/api/session/${followerSession.id}/close`, payload: progress })).statusCode).toBe(200);
    expect(calls.at(-1)?.body).toEqual({}); expect(follower.viewer.playbackSessions.size).toBe(0);
    one.terminate(); two.terminate();
  });

  it.each(["image/svg+xml", "application/xhtml+xml", "text/html", "application/javascript"])("rejects executable upstream media (%s)", async contentType => {
    const current = await launch(); imageContentType = contentType;
    const result = await app.inject({ url: `${current.data.baseUrl}/api/items/${ITEM}/cover` });
    expect(result.statusCode).toBe(502); expect(result.body).not.toContain("fixture-cover");
    expect(result.headers["content-security-policy"]).toContain("sandbox");
    expect(current.viewer.aborters.size).toBe(0);
  });

  it("sanitizes nested credentials and token-bearing strings", async () => {
    const { viewer } = await launch();
    const result = sanitizeNativeJson(viewer, { user: { accessToken: viewer.connection.accessToken },
      nested: [viewer.connection.accessToken], description: `value ${viewer.connection.accessToken}`, metadata: { path: "/private/book.mp3" } });
    expect(JSON.stringify(result)).not.toContain(TOKEN); expect(JSON.stringify(result)).not.toContain("/private/");
  });

  it("preserves native read permissions and artwork presence without exposing filesystem paths", async () => {
    const { viewer } = await launch();
    const result = sanitizeNativeJson(viewer, { user: { type: "admin", librariesAccessible: [],
      permissions: { accessAllLibraries: true, accessExplicitContent: true, update: true, delete: true } },
      libraryItem: { id: ITEM, media: { coverPath: "/private/books/cover.jpg", chapters: [{ id: 1, start: 0, end: 90, title: "One" }] } },
      author: { id: "author-one", imagePath: "/private/metadata/authors/one.jpg" }, missingCover: { coverPath: null } });
    expect(result).toMatchObject({ user: { type: "user", librariesAccessible: [], permissions: { accessAllLibraries: true, accessExplicitContent: true, update: false, delete: false } },
      libraryItem: { id: ITEM, media: { coverPath: "available", chapters: [{ id: 1, start: 0, end: 90, title: "One" }] } },
      author: { imagePath: "available" }, missingCover: { coverPath: null } });
    expect(JSON.stringify(result)).not.toContain("/private/");
    expect(sanitizeNativeJson(viewer, { permissions: { accessAllLibraries: false }, librariesAccessible: ["library-books"] }))
      .toMatchObject({ permissions: { accessAllLibraries: false }, librariesAccessible: ["library-books"] });
  });

  it("allows the native library, playlist, bookmark and podcast browsing routes", async () => {
    const { viewer } = await launch();
    for (const path of ["/api/libraries/library-books/personalized", "/api/libraries/library-books/items", "/api/libraries/library-books/search",
      "/api/libraries/library-books/series/series-one", "/api/authors/author-one", "/api/collections/collection-one", "/api/playlists/playlist-one",
      `/api/items/${ITEM}/cover`, `/api/me/bookmarks/${ITEM}`, `/api/me/progress/${ITEM}/episode-one`,
      "/api/libraries/library-podcasts/recent-episodes", `/api/me/progress/${ITEM}/remove-from-continue-listening`,
      "/api/me/series/series-one/readd-to-continue-listening"]) expect(allowNativeRequest(viewer, "GET", path), path).toBe(true);
    expect(allowNativeRequest(viewer, "HEAD", `/api/me/progress/${ITEM}/remove-from-continue-listening`)).toBe(false);
    expect(allowNativeRequest(viewer, "HEAD", "/api/me/series/series-one/readd-to-continue-listening")).toBe(false);
    expect(allowNativeRequest(viewer, "POST", "/api/playlists/collection/collection-one")).toBe(true);
    expect(allowNativeRequest(viewer, "POST", `/api/me/item/${ITEM}/bookmark`)).toBe(true);
    expect(allowNativeRequest(viewer, "POST", `/api/items/${ITEM}/play/episode-one`)).toBe(true);
    expect(allowNativeRequest(viewer, "POST", "/api/items/batch/delete")).toBe(false);
    expect(allowNativeRequest(viewer, "PATCH", `/api/items/${ITEM}/chapters`)).toBe(false);
  });

  it("supports bounded native multi-selection reads without looking up a fake batch item", async () => {
    const current = await launch();
    const response = await app.inject({ method: "POST", url: `${current.data.baseUrl}/api/items/batch/get`,
      payload: { libraryItemIds: [ITEM, NEXT, ITEM], ignored: "not-forwarded" } });
    expect(response.statusCode).toBe(200);
    expect(calls.at(-1)).toMatchObject({ path: "/api/items/batch/get", body: { libraryItemIds: [ITEM, NEXT] } });
    expect(calls.some(call => call.path === "/api/items/batch")).toBe(false);
    const before = calls.length;
    for (const libraryItemIds of [[], ["../private"], [42], Array(501).fill(ITEM)]) {
      expect((await app.inject({ method: "POST", url: `${current.data.baseUrl}/api/items/batch/get`, payload: { libraryItemIds } })).statusCode).toBe(400);
    }
    expect(calls.length).toBe(before);
  });

  it("applies shared progress ownership to native continue-listening mutations", async () => {
    community = true;
    const first = await launch(); const second = await launch(await actor("viewer-3"));
    first.viewer.sockets = 1; second.viewer.sockets = 1;
    const [writer, follower] = [first, second].sort((left, right) => left.viewer.deviceId.localeCompare(right.viewer.deviceId));
    const before = calls.length;
    for (const path of [`/api/me/progress/${ITEM}/remove-from-continue-listening`, "/api/me/series/series-one/remove-from-continue-listening",
      "/api/me/series/series-one/readd-to-continue-listening"]) {
      expect((await app.inject({ url: follower!.data.baseUrl + path })).statusCode).toBe(403);
    }
    expect(calls.length).toBe(before);
    expect((await app.inject({ url: `${writer!.data.baseUrl}/api/me/series/series-one/remove-from-continue-listening` })).statusCode).toBe(200);
  });
});

describe("native sockets and room lifecycle", () => {
  it("forwards only current-account bookmark and playlist updates and hides transcoder details", async () => {
    const current = await launch(); const socket = await connect(current.data); const session = await start(current, true);
    const frames: Frame[] = [];
    socket.on("message", value => frames.push(JSON.parse(value.toString())));
    io.emit("user_updated", { id: OTHER, username: "private-other-user" });
    io.emit("playlist_updated", { id: "private-playlist", userId: OTHER });
    io.emit("user_updated", { id: USER, token: TOKEN, bookmarks: [{ libraryItemId: ITEM, time: 25, title: "Return here" }] });
    io.emit("playlist_added", { id: "playlist-one", userId: USER, libraryId: "library-books", items: [] });
    io.emit("stream_error", { id: [...current.viewer.playbackSessions.keys()][0], error: "/private/books/book.mp3: ffmpeg failed" });
    await eventually(() => frames.filter(frame => frame.MessageType === "AudiobookshelfEvent").length === 3);
    const native = frames.filter(frame => frame.MessageType === "AudiobookshelfEvent").map(frame => frame.Data);
    expect(native).toContainEqual({ event: "user_updated", payload: { id: USER, bookmarks: [{ libraryItemId: ITEM, time: 25, title: "Return here" }] } });
    expect(native).toContainEqual({ event: "stream_error", payload: { id: session.id, error: "Audiobookshelf could not prepare this audio stream." } });
    expect(JSON.stringify(native)).not.toMatch(/private-other-user|private-playlist|\/private\/|ffmpeg/);
    expect(JSON.stringify(native)).not.toContain(TOKEN);
    socket.terminate();
  });

  it("authenticates before upgrading and reconnects without rebuilding the timeline", async () => {
    const current = await launch();
    const denied = await new Promise<number>(resolve => {
      const socket = new WebSocket(`${appAddress.replace("http:", "ws:")}/abs/invalid/socket`);
      socket.on("unexpected-response", (_request, response) => { resolve(response.statusCode!); response.resume(); socket.terminate(); });
      socket.on("error", () => undefined);
    });
    expect(denied).toBe(401);
    const socket = await connect(current.data); await setPlaybackQueue(current, [ITEM, NEXT]); await service.command(current.viewer, "next");
    const before = await service.playback.get(current.viewer);
    expect(before.snapshot.index).toBe(1); expect(await service.command(current.viewer, "now")).toMatchObject({ itemId: NEXT, isPaused: false });
    socket.terminate(); await eventually(() => !current.viewer.joined && current.viewer.sockets === 0);
    const resumed = await connect(current.data);
    expect((await service.playback.get(current.viewer)).snapshot.revision).toBe(before.snapshot.revision); resumed.terminate();
  });

  it("broadcasts ordered commands, acknowledges retries once, and filters upstream events by stream owner", async () => {
    const first = await launch(); const second = await launch(await actor("viewer-2"));
    const one = await connect(first.data); const two = await connect(second.data); const session = await start(first, true);
    const oneFrames: Frame[] = []; const twoFrames: Frame[] = [];
    one.on("message", value => oneFrames.push(JSON.parse(value.toString()))); two.on("message", value => twoFrames.push(JSON.parse(value.toString())));
    const { snapshot } = await service.playback.get(first.viewer);
    const command = { type: "setQueue", epoch: snapshot.epoch, id: randomUUID(), sequence: 1, expectedQueueRevision: 0,
      issuedAt: Date.now(), queue: [{ id: randomUUID(), itemId: ITEM }], index: 0, positionTicks: 10_000_000, paused: true };
    one.send(JSON.stringify({ MessageType: "ActivityPlaybackCommand", Data: command }));
    await eventually(() => oneFrames.some(frame => Boolean(frame.Data.ack)) && twoFrames.some(frame => frame.MessageType === "ActivityPlaybackState"));
    expect((await service.playback.get(first.viewer)).snapshot.revision).toBe(1);
    expect(oneFrames.find(frame => frame.Data.ack)?.Data).toMatchObject({ ack: { id: command.id, duplicate: false } });
    one.send(JSON.stringify({ MessageType: "ActivityPlaybackCommand", Data: command }));
    await eventually(() => oneFrames.some(frame => (frame.Data.ack as { duplicate?: boolean } | undefined)?.duplicate));
    expect((await service.playback.get(first.viewer)).snapshot.revision).toBe(1);
    io.emit("stream_reset", { streamId: [...first.viewer.playbackSessions.keys()][0], startTime: 42, accessToken: TOKEN });
    io.emit("stream_progress", { stream: [...first.viewer.playbackSessions.keys()][0], chunks: [0, 1], numSegments: 600, percent: "1%" });
    io.emit("user_item_progress_updated", { sessionId: session.id, data: { currentTime: 900 } });
    io.emit("admin_message", TOKEN);
    await eventually(() => oneFrames.filter(frame => frame.MessageType === "AudiobookshelfEvent").length === 2);
    expect(twoFrames.some(frame => frame.MessageType === "AudiobookshelfEvent")).toBe(false);
    expect(JSON.stringify([...oneFrames, ...twoFrames])).not.toContain(TOKEN);
    expect(oneFrames.filter(frame => frame.MessageType === "AudiobookshelfEvent")).toHaveLength(2);
    expect(JSON.stringify(oneFrames)).not.toContain([...first.viewer.playbackSessions.keys()][0]);
    one.terminate(); two.terminate();
  });

  it("rejects inaccessible queue commands without leaking item data", async () => {
    const current = await launch(); const socket = await connect(current.data); const frames: Frame[] = [];
    socket.on("message", value => frames.push(JSON.parse(value.toString())));
    const { snapshot } = await service.playback.get(current.viewer);
    socket.send(JSON.stringify({ MessageType: "ActivityPlaybackCommand", Data: { type: "setQueue", epoch: snapshot.epoch,
      id: randomUUID(), sequence: 1, expectedQueueRevision: 0, issuedAt: Date.now(), queue: [{ id: randomUUID(), itemId: DENIED }], index: 0, positionTicks: 0, paused: false } }));
    await eventually(() => frames.some(frame => frame.MessageType === "ActivityPlaybackError"));
    expect(frames.find(frame => frame.MessageType === "ActivityPlaybackError")?.Data).toMatchObject({ code: "native_item_denied", snapshot: { queue: [] } });
    expect(JSON.stringify(frames)).not.toContain(TOKEN); expect(JSON.stringify(frames)).not.toContain(DENIED); socket.terminate();
  });

  it("revokes HTTP, sockets, media and owned playback sessions on sign-out", async () => {
    const current = await launch(); const socket = await connect(current.data); const session = await start(current);
    const upstreamSessionId = [...current.viewer.playbackSessions.keys()][0];
    const transfer = await fetch(`${appAddress}${current.data.baseUrl}/public/session/${session.id}/track/1?slow=true`);
    const reader = transfer.body!.getReader(); await reader.read(); const closed = once(socket, "close");
    sessionStore.deleteSession(current.owner.session.id); await closed; await eventually(() => slowTransferClosed);
    await reader.cancel().catch(() => undefined);
    expect((await app.inject({ url: `${current.data.baseUrl}/api/me` })).statusCode).toBe(401);
    await eventually(() => calls.some(call => call.path === `/api/session/${upstreamSessionId}/close`));
    expect(current.viewer.playbackSessions.size).toBe(0);
  });

  it("fails closed when membership renewal fails", async () => {
    const current = await launch(); service.dependencies.membership = vi.fn(async () => { throw new Error("not a participant"); });
    expect((await app.inject({ url: `${current.data.baseUrl}/api/me` })).statusCode).toBe(401);
    expect(service.viewers.has(current.data.accessToken)).toBe(false);
  });

  it("allows only one concurrent upstream socket per viewer", async () => {
    const current = await launch(); socketAcceptDelay = 50;
    const connectOne = () => new Promise<{ status: number; socket: WebSocket }>(resolve => {
      const socket = new WebSocket(`${appAddress.replace("http:", "ws:")}${current.data.baseUrl}/socket`);
      socket.on("open", () => resolve({ status: 101, socket }));
      socket.on("unexpected-response", (_request, response) => { response.resume(); resolve({ status: response.statusCode!, socket }); socket.terminate(); });
      socket.on("error", () => undefined);
    });
    const results = await Promise.all([connectOne(), connectOne(), connectOne()]);
    expect(results.map(result => result.status).sort()).toEqual([101, 409, 409]);
    for (const result of results) result.socket.terminate();
  });
  it("hands a disconnected solo native group to a newly verified instance without rebuilding its queue", async () => {
    const previous = await launch();
    await disconnectRenderer(previous);
    const replacement = await launch(await actor("viewer-1", "popped-out-instance"));
    expect(replacement.viewer.partyId).toBe(previous.viewer.partyId);
    expect(replacement.data.restoreRoute).toBe(`/item/${ITEM}`);
    expect(service.get(replacement.owner.session)?.context.instanceId).toBe("popped-out-instance");
    expect(service.get(previous.owner.session)).toBeUndefined();
    expect(service.parties.get(replacement.viewer.partyId)?.queueItemIds).toEqual([ITEM]);
    expect(calls.filter(call => call.path.startsWith("/SyncPlay/"))).toHaveLength(0);
    expect(calls.filter(call => ["/SyncPlay/SetNewQueue", "/SyncPlay/Stop", "/SyncPlay/Unpause"].includes(call.path))).toHaveLength(0);
    expect((await app.inject({ url: `${previous.data.baseUrl}/api/me` })).statusCode).toBe(401);
    expect((await app.inject({ method: "PUT", url: "/api/native/restore", headers: previous.owner.headers,
      payload: { connectionId: "connection", route: "/", sequence: 100 } })).statusCode).toBe(409);
    expect((await app.inject({ url: "/api/native/restore?connectionId=connection", headers: replacement.owner.headers })).json().route).toBe(replacement.data.restoreRoute);
  });

  it("waits briefly for the prior renderer's natural socket close when the replacement arrives first", async () => {
    const previous = await launch();
    const socket = await connect(previous.data);
    await eventually(() => previous.viewer.joined);
    const next = await actor("viewer-1", "popout-arrived-first");
    const binding = service.bind(next.session, "connection");
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(previous.viewer.revoked).toBe(false);
    expect(previous.viewer.sockets).toBe(1);
    socket.terminate();
    expect((await binding).id).toBe(previous.viewer.partyId);
    expect(previous.viewer.revoked).toBe(true);
    expect(calls.filter(call => call.path.startsWith("/SyncPlay/"))).toHaveLength(0);
  });

  it("replaces a disconnected renderer within the same instance and ignores out-of-order route saves", async () => {
    const previous = await launch();
    await disconnectRenderer(previous);
    const replacement = await launch(await actor());
    expect(replacement.viewer.partyId).toBe(previous.viewer.partyId);
    expect(previous.viewer.revoked).toBe(true);
    expect(replacement.data.restoreRoute).toContain("/item/");
    for (const [sequence, route] of [[2, "/library/library-books"], [1, "/"]] as const) {
      expect((await app.inject({ method: "PUT", url: "/api/native/restore", headers: replacement.owner.headers,
        payload: { connectionId: "connection", route, sequence } })).statusCode).toBe(200);
    }
    expect((await app.inject({ url: "/api/native/restore?connectionId=connection", headers: replacement.owner.headers })).json().route).toBe("/library/library-books");
    expect((await app.inject({ method: "PUT", url: "/api/native/restore", headers: previous.owner.headers,
      payload: { connectionId: "connection", route: "/", sequence: 500 } })).statusCode).toBe(409);
  });

  it.each(["another-user", "another-guild", "another-channel", "another-connection", "another-server", "expired", "opening", "active", "explicit-logout", "revoked-connection"])("does not transfer a previous group for %s", async reason => {
    const previous = await launch();
    await disconnectRenderer(previous);
    let socket: WebSocket | undefined;
    if (reason === "expired") vi.spyOn(Date, "now").mockReturnValue(Date.now() + 121_000);
    if (reason === "opening") previous.viewer.socketOpening = true;
    if (reason === "active") socket = await connect(previous.data);
    if (reason === "explicit-logout") {
      // Its membership may already have disappeared; signed logout still clears
      // the old renderer checkpoint without granting any replacement access.
      sessionStore.deleteSession(previous.owner.session.id);
      expect((await app.inject({ method: "POST", url: "/api/logout", headers: previous.owner.headers })).statusCode).toBe(200);
    }
    if (reason === "revoked-connection") await service.revokeConnection(previous.viewer.discordUserId, "connection");
    const current = await actor(reason === "another-user" ? "viewer-2" : "viewer-1", "replacement-instance", {
      guildId: reason === "another-guild" ? "other-guild" : "guild", channelId: reason === "another-channel" ? "other-channel" : "channel"
    });
    const connectionId = reason === "another-connection" ? "other-connection" : reason === "another-server" ? "other-server" : "connection";
    expect((await app.inject({ method: "POST", url: "/api/party", headers: current.headers, payload: { connectionId } })).statusCode).toBe(200);
    expect(service.get(current.session)?.id).not.toBe(previous.viewer.partyId);
    const response = await app.inject({ method: "POST", url: "/api/native/launch", headers: current.headers, payload: { connectionId, deviceId: randomUUID() } });
    expect(response.statusCode).toBe(200);
    expect(response.json().restoreRoute).toBeNull();
    socket?.terminate();
  });

  it("does not select between ambiguous disconnected groups", async () => {
    const first = await launch();
    const active = await connect(first.data);
    const second = await launch(await actor("viewer-1", "second-instance"));
    active.terminate();
    await eventually(() => first.viewer.lastSocketClose > 0);
    await disconnectRenderer(second);
    const third = await launch(await actor("viewer-1", "third-instance"));
    expect(third.viewer.partyId).not.toBe(first.viewer.partyId);
    expect(third.viewer.partyId).not.toBe(second.viewer.partyId);
    expect(service.parties.size).toBe(3);
  });

  it("allows only the newest renderer to save navigation while an older document still has an open socket", async () => {
    const previous = await launch();
    const socket = await connect(previous.data);
    const replacement = await launch(await actor());
    expect(previous.viewer.sockets).toBe(1);
    expect((await app.inject({ method: "PUT", url: "/api/native/restore", headers: replacement.owner.headers,
      payload: { connectionId: "connection", route: "/library/library-books", sequence: 1 } })).statusCode).toBe(200);
    expect((await app.inject({ method: "PUT", url: "/api/native/restore", headers: previous.owner.headers,
      payload: { connectionId: "connection", route: "/", sequence: 200 } })).statusCode).toBe(409);
    expect((await app.inject({ url: "/api/native/restore?connectionId=connection", headers: replacement.owner.headers })).json().route).toBe("/library/library-books");
    socket.terminate();
  });

  it("does not let a predecessor socket close make the latest renderer's explicit Leave restorable", async () => {
    const previous = await launch();
    const oldSocket = await connect(previous.data);
    const replacement = await launch(await actor());
    const socket = await connect(replacement.data);
    oldSocket.terminate();
    await eventually(() => previous.viewer.lastSocketClose > 0);
    expect((await app.inject({ method: "POST", url: "/api/logout", headers: replacement.owner.headers })).statusCode).toBe(200);
    await eventually(() => replacement.viewer.revoked);
    socket.terminate();
    const third = await launch(await actor("viewer-1", "another-instance"));
    expect(third.viewer.partyId).not.toBe(previous.viewer.partyId);
    expect(third.data.restoreRoute).toBeNull();
  });

  it("revokes every old capability before asynchronous handoff cleanup can let another socket reopen", async () => {
    const first = await launch();
    const firstSocket = await connect(first.data);
    const second = await launch(await actor());
    firstSocket.terminate();
    await eventually(() => first.viewer.lastSocketClose > 0);
    await first.viewer.socketCleanup;
    await disconnectRenderer(second);
    const next = await actor("viewer-1", "popped-out-instance");
    const originalRevoke = service.revoke.bind(service);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(service, "revoke").mockImplementation(async viewer => { await originalRevoke(viewer); await blocked; });
    const handoff = service.bind(next.session, "connection");
    try {
      await eventually(() => first.viewer.revoked);
      expect(second.viewer.revoked).toBe(true);
      expect((await app.inject({ url: `${second.data.baseUrl}/api/me` })).statusCode).toBe(401);
    } finally { release(); }
    expect((await handoff).id).toBe(first.viewer.partyId);
  });

  it("requires current membership and a launched owned viewer before reading or writing a checkpoint", async () => {
    const previous = await launch();
    await disconnectRenderer(previous);
    const denied = await actor("viewer-1", "replacement-instance");
    service.dependencies.membership = vi.fn(async () => { throw new Error("not a participant"); });
    expect((await app.inject({ method: "POST", url: "/api/party", headers: denied.headers, payload: { connectionId: "connection" } })).statusCode).toBe(502);
    expect(service.get(previous.owner.session)?.id).toBe(previous.viewer.partyId);
    expect((await app.inject({ url: "/api/native/restore?connectionId=connection" })).statusCode).toBe(401);
    expect(calls.filter(call => call.path.startsWith("/SyncPlay/"))).toHaveLength(0);
  });

  it("rejects credential-bearing routes and unverified logout without clearing a valid checkpoint", async () => {
    const previous = await launch();
    await disconnectRenderer(previous);
    for (const route of ["https://evil.example", `#/abs/${previous.data.accessToken}`, "#/login", "#/video", "/item/id=invalid", "/?api_key=secret", "/?serverId=other", "#/search?query=https%3A%2F%2Fevil.example", "/?tab=0&tab=1"]) {
      expect((await app.inject({ method: "PUT", url: "/api/native/restore", headers: previous.owner.headers,
        payload: { connectionId: "connection", route, sequence: 2 } })).statusCode).toBe(400);
    }
    const invalidToken = previous.owner.appToken.slice(0, -5) + "wrong";
    expect((await app.inject({ method: "POST", url: "/api/logout", headers: { authorization: `Bearer ${invalidToken}` } })).statusCode).toBe(200);
    const replacement = await launch(await actor("viewer-1", "replacement-instance"));
    expect(replacement.viewer.partyId).toBe(previous.viewer.partyId);
    expect(replacement.data.restoreRoute).toContain("/item/");
    expect((await app.inject({ url: "/api/native/restore?connectionId=someone-elses", headers: replacement.owner.headers })).statusCode).toBe(409);
  });

  it("lets an expired correctly signed token revoke restoration while still denying every read", async () => {
    const previous = await launch();
    await disconnectRenderer(previous);
    const token = await new SignJWT({ sid: previous.owner.session.id }).setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(previous.owner.session.discordUserId).setExpirationTime(Math.floor(Date.now() / 1000) - 1)
      .sign(new TextEncoder().encode(app.envConfig.APP_SESSION_SECRET));
    const headers = { authorization: `Bearer ${token}` };
    expect((await app.inject({ url: "/api/native/restore?connectionId=connection", headers })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/logout", headers })).statusCode).toBe(200);
    expect(sessionStore.getSession(previous.owner.session.id)).toBeUndefined();
    const next = await launch(await actor("viewer-1", "replacement-instance"));
    expect(next.viewer.partyId).not.toBe(previous.viewer.partyId);
    expect(next.data.restoreRoute).toBeNull();
  });


});


describe("native segment inactivity recovery over HTTP", () => {
  function shortWatchdog() {
    const realTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
      realTimeout(callback, delay === HLS_BODY_IDLE_TIMEOUT_MS ? 50 : delay, ...args)) as typeof setTimeout);
  }

  it("returns a retryable safe error if a segment body never starts", async () => {
    const current = await launch(); const session = await start(current, true);
    const aborters = current.viewer.aborters.size;
    shortWatchdog();
    const response = await fetch(`${appAddress}${current.data.baseUrl}/hls/${session.id}/output-99.ts`);
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-length")).not.toBe("100");
    expect(response.headers.get("content-range")).toBeNull();
    expect(response.headers.get("accept-ranges")).toBeNull();
    expect(await response.json()).toEqual({ error: { code: "internal_error", message: "Request failed." } });
    await eventually(() => slowTransferClosed);
    expect(current.viewer.aborters.size).toBe(aborters);
    expect(calls.filter(call => call.path.endsWith("/output-99.ts"))).toHaveLength(1);
  });

  it("breaks a partial segment without appending an error body or silently retrying", async () => {
    const current = await launch(); const session = await start(current, true);
    const aborters = current.viewer.aborters.size;
    shortWatchdog();
    const response = await fetch(`${appAddress}${current.data.baseUrl}/hls/${session.id}/output-99.ts?partial=true`);
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toContain("video/mp2t");
    expect(response.headers.get("content-length")).toBe("100");
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
    await expect(reader.read()).rejects.toThrow();
    await eventually(() => slowTransferClosed);
    expect(current.viewer.aborters.size).toBe(aborters);
    expect(calls.filter(call => call.path.endsWith("/output-99.ts"))).toHaveLength(1);
  });
});
