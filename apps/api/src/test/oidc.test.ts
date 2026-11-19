import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnv, type AppEnv } from "../env.js";
import { connectionRoutes } from "../routes/connections.js";
import { createAppSession } from "../services/appSession.js";
import { AudiobookshelfConnectionStore } from "../services/audiobookshelfConnections.js";
import { sessionStore } from "../services/sessionStore.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("native Audiobookshelf Authentik / OIDC handoff", () => {
  it("binds external browser state, PKCE and private upstream cookies, then saves only encrypted ABS tokens", async () => {
    const f = await fixture({ AUDIOBOOKSHELF_PUBLIC_SERVER_URL: "https://books.example/abs" });
    const alice = await actor(f.env);
    const started = await f.app.inject({ method: "POST", url: "/api/connections/oidc", headers: alice.headers,
      payload: { serverUrl: "https://books.example/abs" } });
    expect(started.statusCode).toBe(201);
    const pending = started.json<{ id: string; url: string; expiresAt: string }>();
    expect(pending.url).toMatch(/^https:\/\/listen.example\/api\/connections\/oidc\/start\//);
    expect(started.body).not.toMatch(/verifier|connect.sid|upstream-secret|refreshToken/);
    const begin = await f.app.inject({ url: localUrl(pending.url) });
    expect(begin.statusCode).toBe(302);
    expect(begin.headers.location).toMatch(/^https:\/\/id.example\/application\/o\/authorize\?/);
    const browserCookie = String(begin.headers["set-cookie"]).split(";", 1)[0]!;
    expect(begin.headers["set-cookie"]).toContain("HttpOnly; SameSite=Lax");
    expect(begin.headers["set-cookie"]).toContain("Secure");
    expect(begin.headers["set-cookie"]).not.toContain("upstream-secret");
    const authorize = f.requests.find((request) => request.url.pathname === "/auth/openid")!;
    expect(authorize.headers.host).toBe("books.example");
    expect(authorize.headers["x-forwarded-proto"]).toBe("https");
    expect(authorize.url.searchParams.get("redirect_uri")).toBe("https://listen.example/api/connections/oidc/callback");
    expect((await f.app.inject({ url: localUrl(pending.url) })).statusCode).toBe(400);
    const callbackUrl = `/api/connections/oidc/callback?state=${encodeURIComponent(f.state.oauthState)}&code=private-auth-code`;
    const wrongBrowser = await f.app.inject({ url: callbackUrl });
    expect(wrongBrowser.statusCode).toBe(400);
    expect(f.state.exchangeCount).toBe(0);
    const completed = await f.app.inject({ url: callbackUrl, headers: { cookie: browserCookie } });
    expect(completed.statusCode).toBe(200);
    expect(completed.body).toContain("Audiobookshelf connected");
    expect(completed.body).not.toMatch(/private-auth-code|fixture-access|fixture-refresh|upstream-secret/);
    expect(completed.headers["referrer-policy"]).toBe("no-referrer");
    expect(completed.headers["cache-control"]).toBe("no-store");
    const poll = await f.app.inject({ method: "POST", url: `/api/connections/oidc/${pending.id}/poll`, headers: alice.headers });
    expect(poll.json()).toMatchObject({ status: "connected", connection: { audiobookshelfUsername: "sso-reader", kind: "personal" } });
    expect(poll.body).not.toMatch(/fixture-access|fixture-refresh|upstream-secret|verifier/);
    const exchange = f.requests.find((request) => request.url.pathname === "/auth/openid/callback")!;
    expect(exchange.headers.cookie).toBe("connect.sid=upstream-secret; auth_method=openid-mobile");
    expect(createHash("sha256").update(exchange.url.searchParams.get("code_verifier")!).digest("base64url")).toBe(f.state.challenge);
    expect((await f.app.inject({ url: callbackUrl, headers: { cookie: browserCookie } })).statusCode).toBe(400);
    expect(f.state.exchangeCount).toBe(1);
  });

  it("does not allow another Activity session to poll or steal an external start ticket", async () => {
    const f = await fixture();
    const alice = await actor(f.env);
    const other = await actor(f.env);
    const pending = (await f.app.inject({ method: "POST", url: "/api/connections/oidc", headers: alice.headers, payload: { serverUrl: f.url } })).json<{ id: string; url: string }>();
    expect((await f.app.inject({ method: "POST", url: `/api/connections/oidc/${pending.id}/poll`, headers: other.headers })).statusCode).toBe(404);
    const forged = new URL(pending.url); forged.searchParams.set("ticket", "wrong-ticket");
    expect((await f.app.inject({ url: localUrl(forged.toString()) })).statusCode).toBe(400);
    expect(f.requests.filter((request) => request.url.pathname === "/auth/openid")).toHaveLength(0);
    expect((await f.app.inject({ url: localUrl(pending.url) })).statusCode).toBe(302);
    sessionStore.deleteSession(alice.session.id);
    expect((await f.app.inject({ method: "POST", url: `/api/connections/oidc/${pending.id}/poll`, headers: alice.headers })).statusCode).toBe(401);
  });

  it("rejects insecure or unbound provider redirects without following them", async () => {
    for (const mode of ["http", "wrong-state", "no-pkce"] as const) {
      const f = await fixture();
      f.state.redirectMode = mode;
      const alice = await actor(f.env);
      const pending = (await f.app.inject({ method: "POST", url: "/api/connections/oidc", headers: alice.headers, payload: { serverUrl: f.url } })).json<{ id: string; url: string }>();
      const begin = await f.app.inject({ url: localUrl(pending.url) });
      expect(begin.statusCode).toBe(400);
      expect(begin.headers.location).toBeUndefined();
      const result = await f.app.inject({ method: "POST", url: `/api/connections/oidc/${pending.id}/poll`, headers: alice.headers });
      expect(result.json()).toMatchObject({ status: "failed" });
      expect(f.state.exchangeCount).toBe(0);
    }
  });

  it("does not save an in-flight login after the Discord session is revoked", async () => {
    const f = await fixture();
    const alice = await actor(f.env);
    const pending = (await f.app.inject({ method: "POST", url: "/api/connections/oidc", headers: alice.headers, payload: { serverUrl: f.url } })).json<{ url: string }>();
    const begin = await f.app.inject({ url: localUrl(pending.url) });
    f.state.beforeExchange = () => sessionStore.deleteSession(alice.session.id);
    const complete = await f.app.inject({ url: `/api/connections/oidc/callback?state=${encodeURIComponent(f.state.oauthState)}&code=private-code`,
      headers: { cookie: String(begin.headers["set-cookie"]).split(";", 1)[0]! } });
    expect(complete.statusCode).toBe(400);
    expect(new AudiobookshelfConnectionStore(f.env).list("alice")).toEqual([]);
    expect(f.state.logoutCount).toBe(1);
  });

  it("reports unavailable OIDC and disabled deployment settings before starting provider work", async () => {
    const f = await fixture();
    const alice = await actor(f.env);
    f.state.authMethods = ["local"];
    const result = await f.app.inject({ method: "POST", url: "/api/connections/oidc", headers: alice.headers, payload: { serverUrl: f.url } });
    expect(result.statusCode).toBe(409);
    f.env.AUDIOBOOKSHELF_OIDC_ENABLED = false;
    const disabled = await f.app.inject({ method: "POST", url: "/api/connections/oidc", headers: alice.headers, payload: { serverUrl: f.url } });
    expect(disabled.statusCode).toBe(403);
    expect(f.requests).toHaveLength(1);
  });
});

function localUrl(value: string): string { const url = new URL(value); return `${url.pathname}${url.search}`; }
async function actor(env: AppEnv) {
  const result = await createAppSession({ env, user: { id: "alice", username: "alice", avatar: null }, discordContext: { instanceId: "test-instance" } });
  cleanups.push(() => sessionStore.deleteSession(result.session.id));
  return { ...result, headers: { authorization: `Bearer ${result.appToken}` } };
}
async function fixture(overrides: NodeJS.ProcessEnv = {}) {
  const state = { oauthState: "", challenge: "", exchangeCount: 0, logoutCount: 0, authMethods: ["local", "openid"],
    redirectMode: "valid" as "valid" | "http" | "wrong-state" | "no-pkce", beforeExchange: undefined as (() => void) | undefined };
  const requests: { url: URL; headers: IncomingHttpHeaders }[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://fixture");
    requests.push({ url, headers: request.headers });
    response.setHeader("Content-Type", "application/json");
    const send = (body: unknown, status = 200) => { response.statusCode = status; response.end(JSON.stringify(body)); };
    if (url.pathname === "/status") return send({ app: "audiobookshelf", serverVersion: "2.38.0", isInit: true, authMethods: state.authMethods });
    if (url.pathname === "/auth/openid") {
      state.oauthState = url.searchParams.get("state")!;
      state.challenge = url.searchParams.get("code_challenge")!;
      const redirect = new URL("https://id.example/application/o/authorize");
      redirect.searchParams.set("state", state.redirectMode === "wrong-state" ? "forged-state" : state.oauthState);
      if (state.redirectMode !== "no-pkce") {
        redirect.searchParams.set("code_challenge", state.challenge);
        redirect.searchParams.set("code_challenge_method", "S256");
      }
      if (state.redirectMode === "http") redirect.protocol = "http:";
      response.setHeader("Set-Cookie", ["connect.sid=upstream-secret; HttpOnly; Path=/", "auth_method=openid-mobile; Path=/"]);
      response.setHeader("Location", redirect.toString());
      return send({}, 302);
    }
    if (url.pathname === "/auth/openid/callback") {
      state.exchangeCount++;
      if (request.headers.cookie !== "connect.sid=upstream-secret; auth_method=openid-mobile") return send({}, 401);
      if (createHash("sha256").update(url.searchParams.get("code_verifier") ?? "").digest("base64url") !== state.challenge) return send({}, 401);
      state.beforeExchange?.();
      return send({ user: { id: "sso-user", username: "sso-reader", accessToken: "fixture-access-token", refreshToken: "fixture-refresh-token" } });
    }
    if (url.pathname === "/logout") { state.logoutCount++; return send({ redirect_url: null }); }
    return send({}, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture_failed");
  const url = `http://127.0.0.1:${address.port}`;
  const dir = await mkdtemp(path.join(tmpdir(), "abs-oidc-test-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const env = loadEnv({ NODE_ENV: "test", DEV_AUTH_MOCK: "true", PUBLIC_BASE_URL: "https://listen.example", DATABASE_URL: `file:${dir}/app.db`,
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 13).toString("base64"), AUDIOBOOKSHELF_DEFAULT_SERVER_URL: url, ...overrides });
  const app = Fastify({ logger: false }); app.decorate("envConfig", env); app.decorateRequest("appSession");
  await app.register(connectionRoutes); await app.ready(); cleanups.push(() => app.close());
  return { app, env, url, state, requests };
}
