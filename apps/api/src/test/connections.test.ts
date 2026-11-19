import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEnv, type AppEnv } from "../env.js";
import { connectionRoutes } from "../routes/connections.js";
import { createAppSession } from "../services/appSession.js";
import { assertConnectionCurrent, connectCommunity, connectWithPassword, disconnectConnection, AudiobookshelfConnectionStore,
  onConnectionsRevoked, resolveConnection, type ConnectionDto } from "../services/audiobookshelfConnections.js";
import { sessionStore } from "../services/sessionStore.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("saved Audiobookshelf connections", () => {
  it("blocks revoked accounts from personal and shared credential access before contacting Audiobookshelf", async () => {
    const f = await fixture({ AUDIOBOOKSHELF_AUTH_MODE: "shared", AUDIOBOOKSHELF_SHARED_USERNAME: "community", AUDIOBOOKSHELF_SHARED_PASSWORD: "private-community-password", DISCORD_ALLOWED_GUILD_IDS: "guild-one" });
    const user = await actor(f.env, "revoked-user", "guild-one");
    f.env.DISCORD_DENIED_USER_IDS = "revoked-user";
    await expect(connectCommunity(f.env, user.session)).rejects.toThrow("discord_actor_forbidden");
    await expect(connectWithPassword(f.env, user.session, { serverUrl: f.url, username: "demo", password: "private-password" })).rejects.toThrow("discord_actor_forbidden");
    const response = await f.app.inject({ method: "POST", url: "/api/connections/community", headers: user.headers });
    expect(response.statusCode).toBe(401);
    expect(f.requests).toHaveLength(0);
  });

  it("requires a live app session before any connection operation", async () => {
    const f = await fixture();
    for (const [method, url] of [["GET", "/api/connections"], ["POST", "/api/connections"],
      ["POST", "/api/connections/community"], ["PUT", "/api/connections/preference"],
      ["DELETE", "/api/connections/unknown"], ["POST", "/api/connections/oidc"],
      ["POST", "/api/connections/oidc/unknown/poll"]] as const) {
      expect((await f.app.inject({ method, url })).statusCode).toBe(401);
    }
    expect(f.requests).toHaveLength(0);
  });

  it("validates public server identity before sending a password and sanitizes upstream errors", async () => {
    const f = await fixture();
    const user = await actor(f.env);
    f.state.publicInfo = { unexpected: "not Audiobookshelf" };
    const invalid = await f.app.inject({ method: "POST", url: "/api/connections", headers: user.headers,
      payload: { serverUrl: f.url, username: "demo", password: "private-password" } });
    expect(invalid.statusCode).toBe(502);
    expect(f.requests.map((request) => request.path)).toEqual(["/status"]);
    expect(f.requests[0]?.headers.authorization).toBeUndefined();
    expect(invalid.body).not.toContain("private-password");
    f.state.publicInfo = { app: "audiobookshelf", isInit: true, serverVersion: "2.38.0", authMethods: ["local", "openid"] };
    f.state.authStatus = 401;
    const rejected = await f.app.inject({ method: "POST", url: "/api/connections", headers: user.headers,
      payload: { serverUrl: f.url, username: "demo", password: "private-password" } });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.body).not.toContain("upstream-debug-private-password");
    expect(new AudiobookshelfConnectionStore(f.env).list(user.session.discordUserId)).toEqual([]);
  });

  it("preserves password whitespace, encrypts only the token, and restores it for the same Discord account", async () => {
    const f = await fixture();
    const user = await actor(f.env, "alice", "guild-one");
    const result = await f.app.inject({ method: "POST", url: "/api/connections", headers: user.headers,
      payload: { serverUrl: `${f.url}/`, username: " demo ", password: "  fixture password  " } });
    expect(result.statusCode).toBe(201);
    const connection = result.json<{ connection: ConnectionDto }>().connection;
    expect(connection).toMatchObject({ serverUrl: f.url, audiobookshelfUsername: "demo", kind: "personal" });
    const login = f.requests.find((request) => request.path === "/login")!;
    expect(login.body).toEqual({ username: "demo", password: "  fixture password  " });
    expect(login.headers.authorization).toBeUndefined();
    expect(login.headers["x-return-tokens"]).toBe("true");
    expect(login.headers["x-emby-authorization"]).toBeUndefined();
    expect(result.body).not.toMatch(/fixture-access-token|encryptedAccessToken|loginDeviceId|fixture password/);
    const filename = path.join(f.dataDir, "audiobookshelf-connections.sqlite");
    const stored = await readFile(filename);
    expect(stored.includes(Buffer.from("fixture-access-token"))).toBe(false);
    expect(stored.includes(Buffer.from("fixture password"))).toBe(false);
    expect(stored.includes(Buffer.from("v1."))).toBe(true);
    expect((await stat(filename)).mode & 0o777).toBe(0o600);
    sessionStore.deleteSession(user.session.id);
    const reopened = await actor(f.env, "alice", "guild-one");
    const list = await f.app.inject({ method: "GET", url: "/api/connections", headers: reopened.headers });
    expect(list.json()).toMatchObject({ connections: [connection], preferredConnectionId: connection.id, defaultServerUrl: f.url });
    expect((await resolveConnection(f.env, "alice", connection.id)).accessToken).toBe("fixture-access-token-1");
    expect(f.state.authCount).toBe(1);
  });

  it("accepts the public alias while keeping saved account and preference identity canonical", async () => {
    // .invalid cannot be contacted: every successful request must use the
    // approved loopback fixture, without ever sending credentials to the alias.
    const publicUrl = "https://media.invalid/audiobookshelf";
    const f = await fixture({ AUDIOBOOKSHELF_PUBLIC_SERVER_URL: publicUrl, AUDIOBOOKSHELF_ALLOW_CUSTOM_SERVERS: "false" });
    const alice = await actor(f.env, "alice", "guild-one");
    const before = await f.app.inject({ method: "GET", url: "/api/connections", headers: alice.headers });
    expect(before.json()).toMatchObject({ connections: [], defaultServerUrl: publicUrl, canonicalDefaultServerUrl: f.url });
    expect(f.requests).toHaveLength(0);
    const original = await connectWithPassword(f.env, alice.session, { serverUrl: f.url, username: "alice", password: "fixture" });
    const result = await f.app.inject({ method: "POST", url: "/api/connections", headers: alice.headers,
      payload: { serverUrl: `${publicUrl}/`, username: "alice", password: "fixture" } });
    expect(result.statusCode).toBe(201);
    expect(result.json()).toMatchObject({ connection: { id: original.id, serverUrl: f.url } });
    const store = new AudiobookshelfConnectionStore(f.env);
    expect(store.list("alice", "guild-one")).toHaveLength(1);
    expect(store.preferred("alice", "guild-one")).toBe(original.id);
    expect((await resolveConnection(f.env, "alice", original.id, "guild-one")).target.serverUrl).toBe(f.url);
    expect(f.state.logoutCount).toBe(1);
    expect(f.requests.every((request) => request.headers.host === new URL(f.url).host)).toBe(true);
  });

  it("isolates ownership and guild preferences, and clears preferences and capabilities on disconnect", async () => {
    const f = await fixture();
    const alice = await actor(f.env, "alice", "guild-one");
    const bob = await actor(f.env, "bob", "guild-one");
    const connection = await connectWithPassword(f.env, alice.session, { serverUrl: f.url, username: "alice", password: "fixture" });
    const store = new AudiobookshelfConnectionStore(f.env);
    expect(store.list("bob")).toEqual([]);
    expect(store.preferred("alice", "guild-two")).toBeNull();
    await expect(resolveConnection(f.env, "bob", connection.id)).rejects.toMatchObject({ statusCode: 404 });
    const forbiddenPreference = await f.app.inject({ method: "PUT", url: "/api/connections/preference", headers: bob.headers,
      payload: { connectionId: connection.id } });
    expect(forbiddenPreference.statusCode).toBe(404);
    const forbiddenDelete = await f.app.inject({ method: "DELETE", url: `/api/connections/${connection.id}`, headers: bob.headers });
    expect(forbiddenDelete.statusCode).toBe(404);
    expect(f.state.logoutCount).toBe(0);
    const secondGuild = await actor(f.env, "alice", "guild-two");
    const preferred = await f.app.inject({ method: "PUT", url: "/api/connections/preference", headers: secondGuild.headers,
      payload: { connectionId: connection.id } });
    expect(preferred.statusCode).toBe(200);
    expect(store.preferred("alice", "guild-two")).toBe(connection.id);
    const revoked = vi.fn(); cleanups.push(onConnectionsRevoked(revoked));
    const removed = await f.app.inject({ method: "DELETE", url: `/api/connections/${connection.id}`, headers: alice.headers });
    expect(removed.json()).toEqual({ ok: true, upstreamRevoked: true });
    expect(revoked).toHaveBeenCalledExactlyOnceWith({ connectionId: connection.id, discordUserId: "alice" });
    expect(f.requests.find((request) => request.path === "/logout")?.headers["x-refresh-token"]).toBe("fixture-refresh-token-1");
    expect(store.preferred("alice", "guild-one")).toBeNull();
    expect(store.preferred("alice", "guild-two")).toBeNull();
    await expect(resolveConnection(f.env, "alice", connection.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("relinking replaces the token atomically and revokes existing native capabilities", async () => {
    const f = await fixture();
    const alice = await actor(f.env, "alice", "guild-one");
    const first = await connectWithPassword(f.env, alice.session, { serverUrl: f.url, username: "old-user", password: "fixture" });
    const oldCredential = await resolveConnection(f.env, "alice", first.id);
    expect(() => assertConnectionCurrent(f.env, "alice", oldCredential)).not.toThrow();
    const revoked = vi.fn(); cleanups.push(onConnectionsRevoked(revoked));
    const second = await connectWithPassword(f.env, alice.session, { serverUrl: f.url, username: "new-user", password: "fixture" });
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.audiobookshelfUsername).toBe("new-user");
    expect(new AudiobookshelfConnectionStore(f.env).list("alice")).toHaveLength(1);
    expect(revoked).toHaveBeenCalledExactlyOnceWith({ connectionId: first.id, discordUserId: "alice" });
    expect(() => assertConnectionCurrent(f.env, "alice", oldCredential)).toThrow();
    expect((await resolveConnection(f.env, "alice", second.id)).accessToken).toBe("fixture-access-token-2");
    expect(f.state.logoutCount).toBe(1);
    expect(f.requests.find((request) => request.path === "/logout")?.headers["x-refresh-token"]).toBe("fixture-refresh-token-1");
  });

  it("refuses saved-token use for a different account and still permits local disconnect", async () => {
    const f = await fixture();
    const alice = await actor(f.env, "alice");
    const connection = await connectWithPassword(f.env, alice.session, { serverUrl: f.url, username: "alice", password: "fixture" });
    f.state.authorizeUserId = "different-user";
    await expect(resolveConnection(f.env, "alice", connection.id)).rejects.toMatchObject({ code: "audiobookshelf_identity_changed" });
    expect(await disconnectConnection(f.env, "alice", connection.id)).toEqual({ ok: true, upstreamRevoked: true });
    expect(new AudiobookshelfConnectionStore(f.env).list("alice")).toEqual([]);
  });

  it("rotates expired credentials once for concurrent resolves without revoking playback", async () => {
    const f = await fixture();
    const alice = await actor(f.env, "alice");
    const connection = await connectWithPassword(f.env, alice.session, { serverUrl: f.url, username: "alice", password: "fixture" });
    const oldCredential = await resolveConnection(f.env, "alice", connection.id);
    const revoked = vi.fn(); cleanups.push(onConnectionsRevoked(revoked));
    f.state.expiredToken = oldCredential.accessToken;
    const [first, second] = await Promise.all([resolveConnection(f.env, "alice", connection.id), resolveConnection(f.env, "alice", connection.id)]);
    expect(first.accessToken).toBe("fixture-refreshed-access-token");
    expect(second.accessToken).toBe(first.accessToken);
    expect(f.state.refreshCount).toBe(1);
    expect(revoked).not.toHaveBeenCalled();
    expect(() => assertConnectionCurrent(f.env, "alice", oldCredential)).not.toThrow();
    await disconnectConnection(f.env, "alice", connection.id);
    expect(f.requests.find((request) => request.path === "/logout")?.headers["x-refresh-token"]).toBe("fixture-rotated-refresh-token");
  });

  it("refreshes a JWT before expiry so the player cache cannot outlive it", async () => {
    const f = await fixture();
    f.state.accessToken = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 20 })).toString("base64url")}.signature`;
    const alice = await actor(f.env, "alice");
    const connection = await connectWithPassword(f.env, alice.session, { serverUrl: f.url, username: "alice", password: "fixture" });
    const resolved = await resolveConnection(f.env, "alice", connection.id);
    expect(resolved.accessToken).toBe("fixture-refreshed-access-token");
    expect(f.state.refreshCount).toBe(1);
    expect(f.requests.find((request) => request.path === "/api/authorize")?.headers.authorization).toBe("Bearer fixture-refreshed-access-token");
  });

  it("allows explicit public community access while preserving each user's ownership and guild scope", async () => {
    const f = await fixture({ DISCORD_ACCESS_MODE: "public", AUDIOBOOKSHELF_AUTH_MODE: "shared", AUDIOBOOKSHELF_COMMUNITY_ACCESS: "public",
      AUDIOBOOKSHELF_SHARED_USERNAME: "community", AUDIOBOOKSHELF_SHARED_PASSWORD: "fixture" });
    const alice = await actor(f.env, "alice");
    const connection = await connectCommunity(f.env, alice.session);
    expect(new AudiobookshelfConnectionStore(f.env).list("alice")).toEqual([connection]);
    await expect(resolveConnection(f.env, "alice", connection.id)).resolves.toMatchObject({ kind: "community" });
    await expect(resolveConnection(f.env, "bob", connection.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(resolveConnection(f.env, "alice", connection.id, "other-guild")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("requires explicit community opt-in and binds community tokens to the approved guild", async () => {
    const f = await fixture({ AUDIOBOOKSHELF_AUTH_MODE: "shared", AUDIOBOOKSHELF_SHARED_USERNAME: "community",
      AUDIOBOOKSHELF_SHARED_PASSWORD: "community-fixture", DISCORD_ALLOWED_GUILD_IDS: "guild-one,guild-two" });
    const alice = await actor(f.env, "alice", "guild-one");
    const initial = await f.app.inject({ method: "GET", url: "/api/connections", headers: alice.headers });
    expect(initial.json()).toMatchObject({ connections: [], communityAvailable: true });
    expect(f.state.authCount).toBe(0);
    const chosen = await f.app.inject({ method: "POST", url: "/api/connections/community", headers: alice.headers });
    expect(chosen.statusCode).toBe(201);
    const community = chosen.json<{ connection: ConnectionDto }>().connection;
    expect(community.kind).toBe("community");
    await expect(resolveConnection(f.env, "alice", community.id, "guild-one")).resolves.toMatchObject({ kind: "community" });
    await expect(resolveConnection(f.env, "alice", community.id, "guild-two")).rejects.toMatchObject({ statusCode: 404 });
    const store = new AudiobookshelfConnectionStore(f.env);
    expect(store.list("alice", "guild-two")).toEqual([]);
    expect(() => store.setPreferred("alice", "guild-two", community.id)).toThrow();
    const secondGuild = await actor(f.env, "alice", "guild-two");
    const second = await connectCommunity(f.env, secondGuild.session);
    expect(second.id).not.toBe(community.id);
    expect(store.list("alice", "guild-one").map((connection) => connection.id)).toEqual([community.id]);
    const otherGuild = await actor(f.env, "alice", "guild-outside");
    await expect(connectCommunity(f.env, otherGuild.session)).rejects.toMatchObject({ statusCode: 403 });
    expect(f.requests.filter((request) => request.path === "/login").every((request) =>
      (request.body as { username: string }).username === "community")).toBe(true);
  });

  it("does not save a new token if the app session is revoked during authentication", async () => {
    const f = await fixture();
    const alice = await actor(f.env, "alice");
    f.state.beforeAuthResponse = () => sessionStore.deleteSession(alice.session.id);
    await expect(connectWithPassword(f.env, alice.session, { serverUrl: f.url, username: "alice", password: "fixture" }))
      .rejects.toMatchObject({ code: "invalid_app_session" });
    expect(new AudiobookshelfConnectionStore(f.env).list("alice")).toEqual([]);
    expect(f.state.logoutCount).toBe(1);
  });
});

async function actor(env: AppEnv, userId = "alice", guildId?: string) {
  const result = await createAppSession({ env, user: { id: userId, username: userId, avatar: null },
    discordContext: { instanceId: `instance-${guildId ?? "private"}`, ...(guildId ? { guildId } : {}) } });
  cleanups.push(() => sessionStore.deleteSession(result.session.id));
  return { ...result, headers: { authorization: `Bearer ${result.appToken}` } };
}

async function fixture(overrides: NodeJS.ProcessEnv = {}) {
  const requests: { method: string; path: string; headers: IncomingHttpHeaders; body: unknown }[] = [];
  const state = { publicInfo: { app: "audiobookshelf", isInit: true, serverVersion: "2.38.0", authMethods: ["local", "openid"] } as unknown,
    authStatus: 200, authCount: 0, logoutCount: 0, refreshCount: 0, authorizeUserId: "", expiredToken: "", accessToken: "",
    beforeAuthResponse: undefined as (() => void) | undefined };
  const users = new Map<string, string>();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
    const text = Buffer.concat(chunks).toString();
    const body: unknown = text ? JSON.parse(text) : null;
    const url = new URL(request.url!, "http://fixture");
    requests.push({ method: request.method!, path: url.pathname, headers: request.headers, body });
    response.setHeader("Content-Type", "application/json");
    const send = (value: unknown, status = 200) => { response.statusCode = status; response.end(JSON.stringify(value)); };
    if (url.pathname === "/status") return send(state.publicInfo);
    if (url.pathname === "/login") {
      if (request.headers["x-return-tokens"] !== "true") return send({}, 400);
      state.authCount++;
      state.beforeAuthResponse?.();
      if (state.authStatus !== 200) return send({ debug: "upstream-debug-private-password" }, state.authStatus);
      const username = (body as { username: string }).username;
      const accessToken = state.accessToken || `fixture-access-token-${state.authCount}`;
      users.set(accessToken, `user-${username}`);
      return send({ user: { id: `user-${username}`, username, accessToken, refreshToken: `fixture-refresh-token-${state.authCount}` } });
    }
    if (url.pathname === "/api/authorize") {
      const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
      if (token === state.expiredToken || !users.has(token)) return send({}, 401);
      return send({ user: { id: state.authorizeUserId || users.get(token) } });
    }
    if (url.pathname === "/auth/refresh") {
      state.refreshCount++;
      if (request.headers["x-refresh-token"] !== "fixture-refresh-token-1") return send({}, 401);
      users.set("fixture-refreshed-access-token", "user-alice");
      return send({ user: { id: "user-alice", username: "alice", accessToken: "fixture-refreshed-access-token", refreshToken: "fixture-rotated-refresh-token" } });
    }
    if (url.pathname === "/logout") { state.logoutCount++; return send({ redirect_url: null }); }
    send({}, 404);
  });
  const port = await listen(server);
  const url = `http://127.0.0.1:${port}`;
  const dataDir = await mkdtemp(path.join(tmpdir(), "audiobookshelf-connections-test-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const env = loadEnv({ NODE_ENV: "test", DEV_AUTH_MOCK: "true", TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 13).toString("base64"),
    DATABASE_URL: `file:${path.join(dataDir, "app.db")}`, AUDIOBOOKSHELF_DEFAULT_SERVER_URL: url, ...overrides });
  const app: FastifyInstance = Fastify({ logger: false });
  app.decorate("envConfig", env);
  app.decorateRequest("appSession");
  await app.register(connectionRoutes);
  await app.ready();
  cleanups.push(() => app.close());
  return { app, env, dataDir, url, requests, state };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_listener_failed");
  return address.port;
}
