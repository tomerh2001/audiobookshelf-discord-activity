import { randomUUID } from "node:crypto";
import { brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadEnv } from "../env.js";
import { websocketPlugin } from "../plugins/websocket.js";
import { nativeAudiobookshelfRoutes } from "../routes/nativeAudiobookshelf.js";
import { nativePartyRoutes } from "../routes/nativeParty.js";
import { createAppSession } from "../services/appSession.js";
import { getNativePartyService, type NativePartyService } from "../services/nativeParty.js";
import { sessionStore } from "../services/sessionStore.js";
import { publicSessionId } from "../services/nativeGateway.js";
import { validateUpstream } from "../services/upstreamPolicy.js";

const USER = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ITEM = "11111111111111111111111111111111";
const NATIVE_SESSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN = "fixture-upstream-secret-never-browser";
const library = { results: Array.from({ length: 500 }, (_, i) => ({
  id: `book-${i}`, mediaType: "book", media: { metadata: { title: `Library title ${i}`,
    description: `A fictional book ${i} with a synopsis and author biography. `.repeat(5) } },
  userMediaProgress: { isFinished: i % 3 === 0, currentTime: i },
  path: "/private/library/book.mp3", accessToken: TOKEN
})), total: 500 };
const playlist = "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n" + Array.from({ length: 2200 }, (_, i) =>
  `#EXTINF:6,\noutput-${i}.ts?codec=${"codec-profile-and-channel-layout-".repeat(10)}&token=${TOKEN}\n`
).join("") + "#EXT-X-ENDLIST\n";
let app: FastifyInstance;
let service: NativePartyService;
let baseUrl: string;
let sessionId: string;
let playbackSessionId: string;
let upstreamStatus: number;
let upstreamCalls: number;

function decoded(response: { headers: Record<string, unknown>; rawPayload: Buffer }): string {
  return response.headers["content-encoding"] === "br" ? brotliDecompressSync(response.rawPayload).toString()
    : response.headers["content-encoding"] === "gzip" ? gunzipSync(response.rawPayload).toString() : response.rawPayload.toString();
}

beforeEach(async () => {
  upstreamStatus = 200; upstreamCalls = 0;
  const env = loadEnv({ NODE_ENV: "test", DEV_AUTH_MOCK: "true", AUDIOBOOKSHELF_DEFAULT_SERVER_URL: "http://127.0.0.1:8096", DATABASE_URL: `file:/tmp/unused-compression-${randomUUID()}.db` });
  app = Fastify({ logger: false }); app.decorate("envConfig", env); app.decorateRequest("appSession");
  service = getNativePartyService(app);
  const target = await validateUpstream(env, env.AUDIOBOOKSHELF_DEFAULT_SERVER_URL!);
  service.dependencies.resolve = vi.fn(async (_env, _user, id) => ({ id, serverId: "fixture-server", serverUrl: env.AUDIOBOOKSHELF_DEFAULT_SERVER_URL!,
    serverName: "Fixture", audiobookshelfUserId: USER, audiobookshelfUsername: "fixture", kind: "personal" as const,
    createdAt: "2026-01-01", updatedAt: "2026-01-01", accessToken: TOKEN, target }));
  service.dependencies.current = vi.fn();
  service.dependencies.fetch = vi.fn(async (_target, path, init) => {
    upstreamCalls++;
    const pathname = new URL(path, "http://fixture").pathname;
    if (pathname === `/api/items/${ITEM}`) return Response.json({ id: ITEM, media: { tracks: [{ ino: "track" }] } });
    if (upstreamStatus !== 200) return new Response(upstreamStatus === 204 ? null : "private upstream error", { status: upstreamStatus });
    if (pathname.endsWith(".m3u8")) return new Response(playlist, { headers: { "Content-Type": "application/vnd.apple.mpegurl" } });
    if (pathname.includes("/track/")) {
      const range = new Headers(init?.headers).has("range");
      return new Response(Buffer.alloc(4096, 7), { status: range ? 206 : 200, headers: {
        "Content-Type": "audio/mpeg", "Content-Length": "4096", "Accept-Ranges": "bytes", ...(range ? { "Content-Range": "bytes 0-4095/8192" } : {})
      } });
    }
    return Response.json(pathname === "/api/me" ? { id: USER, accessToken: TOKEN } : library);
  });
  await app.register(websocketPlugin);
  await app.register(nativePartyRoutes);
  await app.register(nativeAudiobookshelfRoutes);
  // This sibling represents broker credentials, deliberately outside compression.
  app.get("/broker-fixture", () => ({ accessToken: "x".repeat(2048) }));
  await app.ready();
  const actor = await createAppSession({ env, user: { id: "compression-viewer", username: "Fixture" }, discordContext: { instanceId: randomUUID(), guildId: "fixture-guild", channelId: "fixture-channel" } });
  sessionId = actor.session.id;
  await service.bind(actor.session, "fixture-connection");
  const launched = await service.launch(actor.session, "fixture-connection", randomUUID());
  baseUrl = launched.baseUrl;
  const viewer = service.viewers.get(launched.accessToken)!;
  viewer.playbackSessions.set(NATIVE_SESSION, { itemId: ITEM });
  playbackSessionId = publicSessionId(viewer, NATIVE_SESSION);
});

afterEach(async () => { await app?.close(); if (sessionId) sessionStore.deleteSession(sessionId); vi.restoreAllMocks(); });

describe("scoped native response compression", () => {
  it.each(["br", "gzip"])("compresses sanitized library JSON and rewritten long VOD playlists with %s", async (encoding) => {
    for (const path of ["/api/libraries/library-books/items", `/hls/${playbackSessionId}/output.m3u8`]) {
      const plain = await app.inject({ url: baseUrl + path });
      const compressed = await app.inject({ url: baseUrl + path, headers: { "accept-encoding": encoding } });
      expect(compressed.statusCode).toBe(200);
      expect(compressed.headers["content-encoding"]).toBe(encoding);
      expect(compressed.headers.vary).toContain("accept-encoding");
      expect(compressed.headers["cache-control"]).toBe("no-store");
      expect(compressed.headers["content-length"]).toBeUndefined();
      const body = decoded(compressed);
      expect(body === plain.body).toBe(true);
      expect(body.includes(TOKEN)).toBe(false);
      expect(body.includes("/private/library")).toBe(false);
      expect(body.includes(path.endsWith(".m3u8") ? baseUrl + "/hls/" : "Library title")).toBe(true);
      expect(compressed.rawPayload.length).toBeLessThan(plain.rawPayload.length / 5);
    }
  });

  it("honors encoding negotiation and leaves small native JSON and broker credentials unchanged", async () => {
    for (const [accept, encoding] of [["br;q=0,gzip;q=1", "gzip"], ["br;q=0.5,gzip;q=0.2", "br"], ["identity", undefined], ["unsupported", undefined]] as const) {
      const response = await app.inject({ url: `${baseUrl}/api/libraries/library-books/items`, headers: { "accept-encoding": accept } });
      expect(response.statusCode).toBe(200); expect(response.headers["content-encoding"]).toBe(encoding);
      expect(JSON.parse(decoded(response)).results).toHaveLength(500);
    }
    const small = await app.inject({ url: `${baseUrl}/api/me`, headers: { "accept-encoding": "br,gzip" } });
    expect(small.headers["content-encoding"]).toBeUndefined(); expect(small.json()).toEqual({ id: USER });
    const broker = await app.inject({ url: "/broker-fixture", headers: { "accept-encoding": "br,gzip" } });
    expect(broker.headers["content-encoding"]).toBeUndefined(); expect(broker.json().accessToken).toHaveLength(2048);
  });

  it("preserves HEAD, Range, binary media, empty and upstream error responses", async () => {
    const head = await app.inject({ method: "HEAD", url: `${baseUrl}/api/libraries/library-books/items`, headers: { "accept-encoding": "br" } });
    expect(head.statusCode).toBe(200); expect(head.body).toBe(""); expect(head.headers["content-encoding"]).toBeUndefined();
    const rangedJson = await app.inject({ url: `${baseUrl}/api/libraries/library-books/items`, headers: { range: "bytes=0-4095", "accept-encoding": "br" } });
    expect(rangedJson.headers["content-encoding"]).toBeUndefined();
    for (const range of [undefined, "bytes=0-4095"]) {
      const response = await app.inject({ url: `${baseUrl}/public/session/${playbackSessionId}/track/1`, headers: { "accept-encoding": "br", ...(range ? { range } : {}) } });
      expect(response.statusCode).toBe(range ? 206 : 200); expect(response.headers["content-encoding"]).toBeUndefined();
      expect(response.headers["content-length"]).toBe("4096"); expect(response.headers["accept-ranges"]).toBe("bytes");
      expect(response.headers["content-range"]).toBe(range ? "bytes 0-4095/8192" : undefined);
      expect(response.rawPayload).toEqual(Buffer.alloc(4096, 7)); expect(response.headers["cache-control"]).toBe("no-store");
    }
    for (const status of [204, 403, 500]) {
      upstreamStatus = status;
      const response = await app.inject({ url: `${baseUrl}/api/libraries/library-books/items`, headers: { "accept-encoding": "br" } });
      expect(response.statusCode).toBe(status); expect(response.headers["content-encoding"]).toBeUndefined();
      expect(response.headers["cache-control"]).toBe("no-store"); expect(response.body).not.toContain("private upstream error");
    }
  });

  it("does not decompress incoming bodies or bypass capability validation", async () => {
    const before = upstreamCalls;
    const denied = await app.inject({ url: "/abs/invalid/api/me", headers: { "accept-encoding": "br" } });
    expect(denied.statusCode).toBe(401); expect(denied.headers["content-encoding"]).toBeUndefined();
    const zipped = await app.inject({ method: "POST", url: `${baseUrl}/Activity/Playback`,
      headers: { "content-encoding": "gzip", "content-type": "application/json" }, payload: gzipSync(JSON.stringify({ PlayingQueue: [ITEM] })) });
    expect(zipped.statusCode).toBe(400); expect(upstreamCalls).toBe(before);
  });

  it("serves compressed native text that fetch transparently decodes over a real socket", async () => {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    for (const path of ["/api/libraries/library-books/items", `/hls/${playbackSessionId}/output.m3u8`]) {
      const response = await fetch(address + baseUrl + path, { headers: { "accept-encoding": "br" } });
      expect(response.status).toBe(200); expect(response.headers.get("content-encoding")).toBe("br");
      expect(await response.text() === (await app.inject({ url: baseUrl + path })).body).toBe(true);
    }
  });
});
