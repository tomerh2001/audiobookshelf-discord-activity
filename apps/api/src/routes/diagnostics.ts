import { apiError } from "@app/shared";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import { AuthError, requireAppSession, sendAuthError } from "../plugins/auth.js";

const presenceDiagnostic = z.object({
  event: z.enum(["disabled", "observer", "attempt", "success", "error"]),
  reason: z.enum(["mock", "standalone", "missing_sdk", "missing_scope", "no_snapshot", "no_entry", "loading",
    "identity_mismatch", "not_started", "ended", "no_item", "ready"]).optional(),
  operation: z.enum(["set", "clear"]).optional(),
  audioReadyState: z.number().int().min(0).max(4).optional(),
  playing: z.boolean().optional(),
  titlePresent: z.boolean().optional(),
  activityType: z.union([z.literal(2), z.literal(3)]).optional(),
  errorKind: z.enum(["rpc", "response_validation", "timeout", "unknown"]).optional(),
  code: z.number().int().min(0).max(65535).optional()
}).strict();

export const diagnosticRoutes: FastifyPluginAsync = async (app) => {
  // The plugin's LRU caps retained counters; expired windows reset on access.
  // Keep the ordinary global limiter in addition to this authenticated budget.
  const sessionLimitOptions = {
    max: 20, timeWindow: 60_000, cache: 1000, allowList: [],
    keyGenerator: (request: FastifyRequest) => request.appSession!.id
  };
  const limitSession = app.createRateLimit(sessionLimitOptions);

  app.post("/api/diagnostics/presence", {
    bodyLimit: 1024,
    // Only the explicit content-free app log below may record this request.
    logLevel: "silent",
    preParsing: async (request, reply) => {
      try { await requireAppSession(request); }
      catch (error) {
        if (error instanceof AuthError) return reply.code(error.statusCode).send(sendAuthError(error));
        throw error;
      }
      const rate = await limitSession(request);
      if (!rate.isAllowed && rate.isExceeded) {
        return reply.header("Retry-After", rate.ttlInSeconds).code(429)
          .send(apiError("rate_limit_exceeded", "Too many requests. Try again shortly."));
      }
    }
  }, async (request, reply) => {
    const parsed = presenceDiagnostic.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(apiError("invalid_request", "Invalid presence diagnostic."));
    const actorHash = createHash("sha256").update(request.appSession!.discordUserId).digest("hex").slice(0, 12);
    app.log.info({ ...parsed.data, actorHash, clientReported: true }, "activity_presence_diagnostic");
    return { ok: true };
  });
};
