import { apiError } from "@app/shared";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { AuthError, requireAppSession, sendAuthError } from "../plugins/auth.js";
import { communityAvailable, connectCommunity, ConnectionError, connectWithPassword, disconnectConnection,
  AudiobookshelfConnectionStore, suggestedServerUrl } from "../services/audiobookshelfConnections.js";
import { AudiobookshelfOidcManager } from "../services/audiobookshelfOidc.js";
import { normalizeUpstreamUrl, UpstreamPolicyError } from "../services/upstreamPolicy.js";

const loginSchema = z.object({ serverUrl: z.string().min(1).max(2048), username: z.string().trim().min(1).max(200),
  password: z.string().max(4096) }).strict();
const serverSchema = z.object({ serverUrl: z.string().min(1).max(2048) }).strict();
const preferenceSchema = z.object({ connectionId: z.string().regex(/^[a-f0-9]{32}$/) }).strict();

export const connectionRoutes: FastifyPluginAsync = async (app) => {
  const store = new AudiobookshelfConnectionStore(app.envConfig);
  const oidc = new AudiobookshelfOidcManager(app.envConfig);
  app.addHook("onClose", async () => { oidc.dispose(); });

  app.get("/api/connections", async (request, reply) => {
    try {
      const session = await requireAppSession(request);
      return reply.send({ connections: store.list(session.discordUserId, session.discordContext?.guildId), defaultServerUrl: suggestedServerUrl(app.envConfig),
        canonicalDefaultServerUrl: normalizeUpstreamUrl(app.envConfig.AUDIOBOOKSHELF_DEFAULT_SERVER_URL),
        communityAvailable: communityAvailable(app.envConfig, session), oidcEnabled: app.envConfig.AUDIOBOOKSHELF_OIDC_ENABLED,
        preferredConnectionId: store.preferred(session.discordUserId, session.discordContext?.guildId) });
    } catch (error) { return sendError(reply, error); }
  });

  app.post("/api/connections", async (request, reply) => {
    try {
      const session = await requireAppSession(request);
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) return invalidInput(reply);
      const connection = await connectWithPassword(app.envConfig, session, parsed.data);
      return reply.code(201).send({ connection });
    } catch (error) { return sendError(reply, error); }
  });

  app.post("/api/connections/community", async (request, reply) => {
    try {
      const session = await requireAppSession(request);
      return reply.code(201).send({ connection: await connectCommunity(app.envConfig, session) });
    } catch (error) { return sendError(reply, error); }
  });

  app.put("/api/connections/preference", async (request, reply) => {
    try {
      const session = await requireAppSession(request);
      const parsed = preferenceSchema.safeParse(request.body);
      if (!parsed.success) return invalidInput(reply);
      store.setPreferred(session.discordUserId, session.discordContext?.guildId, parsed.data.connectionId);
      return reply.send({ ok: true });
    } catch (error) { return sendError(reply, error); }
  });

  app.delete<{ Params: { id: string } }>("/api/connections/:id", async (request, reply) => {
    try {
      const session = await requireAppSession(request);
      return reply.send(await disconnectConnection(app.envConfig, session.discordUserId, request.params.id));
    } catch (error) { return sendError(reply, error); }
  });

  app.post("/api/connections/oidc", async (request, reply) => {
    try {
      const session = await requireAppSession(request);
      const parsed = serverSchema.safeParse(request.body);
      if (!parsed.success) return invalidInput(reply);
      return reply.code(201).send(await oidc.start(session, parsed.data.serverUrl));
    } catch (error) { return sendError(reply, error); }
  });

  app.post<{ Params: { id: string } }>("/api/connections/oidc/:id/poll", async (request, reply) => {
    try { return reply.send(oidc.poll(await requireAppSession(request), request.params.id)); }
    catch (error) { return sendError(reply, error); }
  });

  // These two exact GET routes are reachable in the external browser. The start
  // ticket, OAuth state, same-browser nonce and PKCE authorize their limited work.
  app.get<{ Params: { id: string }; Querystring: { ticket?: string } }>("/api/connections/oidc/start/:id", async (request, reply) => {
    externalHeaders(reply);
    try {
      if (!/^[a-f0-9]{32}$/.test(request.params.id) || typeof request.query.ticket !== "string" || request.query.ticket.length > 200) throw new Error("invalid_ticket");
      const started = await oidc.begin(request.params.id, request.query.ticket);
      return reply.header("Set-Cookie", started.cookie).redirect(started.url);
    } catch { return reply.code(400).type("text/html").send(resultPage(false)); }
  });

  app.get<{ Querystring: { state?: string; code?: string; error?: string } }>("/api/connections/oidc/callback", async (request, reply) => {
    externalHeaders(reply);
    try {
      const query = z.object({ state: z.string().min(20).max(200), code: z.string().min(1).max(8192).optional(), error: z.string().max(200).optional() }).parse(request.query);
      const completed = await oidc.callback(query.state, query.code, request.headers.cookie ?? "", query.error);
      return reply.header("Set-Cookie", completed.cookie).type("text/html").send(resultPage(true));
    } catch { return reply.code(400).type("text/html").send(resultPage(false)); }
  });
};

function externalHeaders(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer")
    .header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
    .header("X-Content-Type-Options", "nosniff");
}
function resultPage(success: boolean): string {
  const title = success ? "Audiobookshelf connected" : "Sign-in did not complete";
  const message = success ? "Return to your Discord Activity. Your saved account is ready." : "Return to your Discord Activity and start single sign-on again.";
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body><h1>${title}</h1><p>${message}</p></body></html>`;
}

function invalidInput(reply: FastifyReply) {
  return reply.code(400).send(apiError("invalid_connection_request", "Check the server address and login fields."));
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthError) return reply.code(error.statusCode).send(sendAuthError(error));
  if (error instanceof ConnectionError || error instanceof UpstreamPolicyError) {
    return reply.code(error.statusCode).send(apiError(error.code, error.publicMessage));
  }
  return reply.code(500).send(apiError("connection_failed", "Could not complete the Audiobookshelf connection request."));
}
