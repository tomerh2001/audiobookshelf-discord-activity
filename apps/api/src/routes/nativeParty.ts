import { ConnectionError } from "../services/audiobookshelfConnections.js";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { AuthError, requireAppSession, sendAuthError } from "../plugins/auth.js";
import { getNativePartyService, NativeError, publicNativeParty } from "../services/nativeParty.js";

const binding = z.object({ connectionId: z.string().min(1).max(128) }).strict();
const launch = binding.extend({ deviceId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/) });
const navigation = binding.extend({ route: z.string().max(1024), sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });

export const nativePartyRoutes: FastifyPluginAsync = async (app) => {
  const service = getNativePartyService(app);
  app.get("/api/party", async (request, reply) => {
    try { return { party: publicNativeParty(service.get(await requireAppSession(request))) }; }
    catch (error) { return nativeRouteError(error, reply); }
  });
  app.post("/api/party", async (request, reply) => {
    try {
      const session = await requireAppSession(request);
      const parsed = binding.safeParse(request.body);
      if (!parsed.success) throw new NativeError("invalid_request", 400);
      return { party: publicNativeParty(await service.bind(session, parsed.data.connectionId)) };
    } catch (error) { return nativeRouteError(error, reply); }
  });
  app.post("/api/native/launch", async (request, reply) => {
    try {
      const session = await requireAppSession(request);
      const parsed = launch.safeParse(request.body);
      if (!parsed.success) throw new NativeError("invalid_request", 400);
      return await service.launch(session, parsed.data.connectionId, parsed.data.deviceId);
    } catch (error) { return nativeRouteError(error, reply); }
  });
  app.get("/api/native/restore", async (request, reply) => {
    try {
      const session = await requireAppSession(request);
      const parsed = binding.safeParse(request.query);
      if (!parsed.success) throw new NativeError("invalid_request", 400);
      return { route: await service.navigationCheckpoint(session, parsed.data.connectionId) };
    } catch (error) { return nativeRouteError(error, reply); }
  });
  app.put("/api/native/restore", async (request, reply) => {
    try {
      const session = await requireAppSession(request);
      const parsed = navigation.safeParse(request.body);
      if (!parsed.success) throw new NativeError("invalid_request", 400);
      await service.navigationCheckpoint(session, parsed.data.connectionId, parsed.data);
      return { ok: true };
    } catch (error) { return nativeRouteError(error, reply); }
  });
};

export function nativeRouteError(error: unknown, reply: import("fastify").FastifyReply) {
  if (error instanceof AuthError) return reply.code(error.statusCode).send(sendAuthError(error));
  if (error instanceof ConnectionError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.publicMessage } });
  if (error instanceof NativeError) {
    // The native API client's requestfail event exposes this header, not the
    // response body. Only fixed local queue codes are presented as native toasts.
    if (["native_invalid_queue", "native_queue_empty", "native_queue_too_large"].includes(error.code)) {
      reply.header("X-Application-Error-Code", error.code);
    }
    const messages: Record<string, string> = {
      party_server_mismatch: "This Activity already uses another Audiobookshelf server. Join with an account on that server or start a new Activity.",
      native_shared_progress_read_only: "Another active listener is saving progress for this shared account.",
      native_playback_denied: "Your Audiobookshelf account does not have permission to play media.",
      activity_queue_changed: "Someone changed the queue. Follow the current book and try again.",
      activity_stale_command: "This playback action arrived too late. Follow the current party and try again.",
      activity_invalid_command: "This playback action is invalid. Reopen the selection and try again.",
      activity_invalid_queue: "This selection has an invalid queue. Choose an book or podcast episode.",
      native_invalid_queue: "Audiobookshelf sent an invalid playback queue. Open a book or podcast episode and try again.",
      native_queue_empty: "Audiobookshelf returned no playable items for this selection. Open an book or podcast episode and try again.",
      native_queue_too_large: "This selection has more than 500 items. Choose a smaller selection."
    };
    return reply.code(error.statusCode).send({ error: { code: error.code, message: messages[error.code] ?? "The native Audiobookshelf request could not be completed." } });
  }
  // Never log an upstream exception whose request options may contain credentials.
  return reply.code(502).send({ error: { code: "native_upstream_failed", message: "Audiobookshelf is unavailable or this connection is no longer valid." } });
}
