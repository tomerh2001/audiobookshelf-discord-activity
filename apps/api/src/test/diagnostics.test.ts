import { createHash } from "node:crypto";
import Fastify from "fastify";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEnv, type AppEnv } from "../env.js";
import { securityPlugin } from "../plugins/security.js";
import { diagnosticRoutes } from "../routes/diagnostics.js";
import { createAppSession } from "../services/appSession.js";
import * as discord from "../services/discord.js";
import { sessionStore } from "../services/sessionStore.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("content-free presence diagnostics", () => {
  it("requires a current authorized app session and exposes no read endpoint", async () => {
    const f = await fixture();
    const actor = await session(f.env);
    for (const headers of [{}, { authorization: "Bearer private-invalid-token" }]) {
      expect((await f.app.inject({ method: "POST", url: f.url, headers, payload: { event: "attempt" } })).statusCode).toBe(401);
    }
    sessionStore.deleteSession(actor.session.id);
    expect((await f.app.inject({ method: "POST", url: f.url, headers: actor.headers, payload: { event: "attempt" } })).statusCode).toBe(401);
    const denied = await session(f.env, "denied-listener");
    f.env.DISCORD_DENIED_USER_IDS = denied.session.discordUserId;
    expect((await f.app.inject({ method: "POST", url: f.url, headers: denied.headers, payload: { event: "attempt" } })).statusCode).toBe(401);
    expect(f.logs).toEqual([]);
    expect((await f.app.inject({ method: "GET", url: f.url, headers: actor.headers })).statusCode).toBe(404);
  });

  it("revalidates Activity membership before accepting a report", async () => {
    const f = await fixture();
    const actor = await session(f.env);
    f.env.DEV_AUTH_MOCK = false;
    actor.session.createdAt = new Date(Date.now() - 61_000);
    const verify = vi.spyOn(discord, "verifyDiscordActivityContext").mockRejectedValue(new Error("private-membership-response"));
    const response = await f.app.inject({ method: "POST", url: f.url, headers: actor.headers, payload: { event: "attempt" } });
    expect(response.statusCode).toBe(401);
    expect(verify).toHaveBeenCalledOnce();
    expect(sessionStore.getSession(actor.session.id)).toBeUndefined();
    expect(f.logs).toEqual([]);
    expect(response.body).not.toContain("private-membership-response");
  });

  it("logs only parsed status fields, a hashed actor and the client-reported marker", async () => {
    const f = await fixture();
    const actor = await session(f.env, "private-discord-user");
    const payload = { event: "error", reason: "ready", operation: "set", audioReadyState: 4,
      playing: true, titlePresent: false, activityType: 2, errorKind: "response_validation", code: 65535 };
    const response = await f.app.inject({ method: "POST", url: `${f.url}?title=private-title&url=https://private.invalid`,
      headers: { ...actor.headers, cookie: "private-cookie", "x-debug": "private-header" }, payload });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(f.logs).toHaveLength(1);
    const log = JSON.parse(f.logs[0]!);
    const { level, time, pid, hostname, ...fields } = log;
    expect([level, time, pid, hostname]).not.toContain(undefined);
    expect(fields).toEqual({ ...payload, actorHash: createHash("sha256").update(actor.session.discordUserId).digest("hex").slice(0, 12),
      clientReported: true, msg: "activity_presence_diagnostic" });
    expect(f.logs.join("")).not.toMatch(/private-|Bearer|https:|authorization|cookie/);
    expect(f.logs.join("")).not.toContain(actor.appToken);
  });

  it.each([
    {}, { event: "private-title" }, { event: "observer", reason: "private-reason" },
    { event: "attempt", operation: "private-operation" }, { event: "error", errorKind: "private-error" },
    { event: "attempt", audioReadyState: -1 }, { event: "attempt", audioReadyState: 5 },
    { event: "attempt", audioReadyState: 2.5 }, { event: "attempt", audioReadyState: "2" },
    { event: "attempt", playing: 1 }, { event: "attempt", titlePresent: "true" },
    { event: "attempt", activityType: 1 }, { event: "attempt", activityType: "2" },
    { event: "error", code: -1 }, { event: "error", code: 65536 }, { event: "error", code: 1.5 },
    { event: "error", code: "1" }, { event: "attempt", title: "private-title" },
    { event: "error", message: "private-error" }, { event: "success", token: "private-token" },
    { event: "success", url: "https://private.invalid" }, { event: "success", actorHash: "forged" },
    { event: "success", clientReported: false }, null, ["attempt"]
  ])("rejects invalid or extra fields without logging their contents: %j", async (payload) => {
    const f = await fixture();
    const actor = await session(f.env);
    const response = await f.app.inject({ method: "POST", url: f.url,
      headers: { ...actor.headers, "content-type": "application/json" }, payload: JSON.stringify(payload) });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: { code: "invalid_request", message: "Invalid presence diagnostic." } });
    expect(f.logs).toEqual([]);
  });

  it("accepts all event categories and bounded numeric values", async () => {
    const f = await fixture();
    const actor = await session(f.env);
    for (const event of ["disabled", "observer", "attempt", "success", "error"]) {
      expect((await f.app.inject({ method: "POST", url: f.url, headers: actor.headers,
        payload: { event, audioReadyState: 0, code: 0, activityType: 3, playing: false, titlePresent: true, operation: "clear" } })).statusCode).toBe(200);
    }
    expect(f.logs).toHaveLength(5);
  });

  it("limits reports to 20 per session per minute, independently of actor or IP", async () => {
    const f = await fixture();
    const first = await session(f.env);
    const second = await session(f.env);
    const post = (headers: { authorization: string }) => f.app.inject({ method: "POST", url: f.url, headers, payload: { event: "observer" } });
    for (let index = 0; index < 20; index++) expect((await post(first.headers)).statusCode).toBe(200);
    const limited = await post(first.headers);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("rate_limit_exceeded");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect((await post(second.headers)).statusCode).toBe(200);
    expect(f.logs).toHaveLength(21);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 60_001);
    expect((await post(first.headers)).statusCode).toBe(200);
    expect(f.logs).toHaveLength(22);
  });

  it("retains the global limit for unauthenticated requests", async () => {
    const f = await fixture({ RATE_LIMIT_MAX: "2" });
    for (let index = 0; index < 2; index++) expect((await f.app.inject({ method: "POST", url: f.url, payload: { event: "attempt" } })).statusCode).toBe(401);
    expect((await f.app.inject({ method: "POST", url: f.url, payload: { event: "attempt" } })).statusCode).toBe(429);
    expect(f.logs).toEqual([]);
  });

  it("bounds body size and counts invalid reports against the session budget", async () => {
    const f = await fixture();
    const actor = await session(f.env);
    const oversized = await f.app.inject({ method: "POST", url: f.url, headers: actor.headers,
      payload: { event: "error", title: "private-title".repeat(100) } });
    expect(oversized.statusCode).toBe(413);
    for (let index = 0; index < 19; index++) {
      expect((await f.app.inject({ method: "POST", url: f.url, headers: actor.headers, payload: { event: "private-title" } })).statusCode).toBe(400);
    }
    expect((await f.app.inject({ method: "POST", url: f.url, headers: actor.headers, payload: { event: "attempt" } })).statusCode).toBe(429);
    expect(f.logs).toEqual([]);
  });
});

async function session(env: AppEnv, userId = "fixture-listener") {
  const result = await createAppSession({ env, user: { id: userId, username: "listener", avatar: null },
    discordContext: { instanceId: "fixture-instance" } });
  cleanups.push(() => sessionStore.deleteSession(result.session.id));
  return { ...result, headers: { authorization: `Bearer ${result.appToken}` } };
}

async function fixture(overrides: NodeJS.ProcessEnv = {}) {
  const env = loadEnv({ NODE_ENV: "test", DEV_AUTH_MOCK: "true", ...overrides });
  const logs: string[] = [];
  const logger = pino({ level: "info" }, { write: (line) => { logs.push(line); } });
  const app = Fastify({ loggerInstance: logger });
  app.decorate("envConfig", env);
  app.decorateRequest("appSession");
  app.setErrorHandler((error, _request, reply) => {
    const shaped = error as { statusCode?: number; error?: { code?: string } };
    const status = shaped.error?.code === "rate_limit_exceeded" ? 429 : shaped.statusCode ?? 500;
    return reply.code(status).send({ error: { code: shaped.error?.code ?? "request_failed" } });
  });
  await app.register(securityPlugin(env));
  await app.register(diagnosticRoutes);
  await app.ready();
  cleanups.push(() => app.close());
  return { app, env, logs, url: "/api/diagnostics/presence" };
}
