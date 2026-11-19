import { z } from "zod";
import { env } from "../env.js";

// This is deliberately a closed, content-free vocabulary. No RPC payload,
// exception text, media metadata, address or credential belongs in diagnostics.
const diagnosticSchema = z.object({
  event: z.enum(["disabled", "observer", "attempt", "success", "error"]),
  reason: z.enum(["mock", "standalone", "missing_sdk", "missing_scope", "no_snapshot", "no_entry", "loading", "identity_mismatch", "not_started", "ended", "no_item", "ready"]).optional(),
  operation: z.enum(["set", "clear"]).optional(),
  audioReadyState: z.number().int().min(0).max(4).optional(),
  playing: z.boolean().optional(),
  titlePresent: z.boolean().optional(),
  activityType: z.union([z.literal(2), z.literal(3)]).optional(),
  errorKind: z.enum(["rpc", "response_validation", "timeout", "unknown"]).optional(),
  code: z.number().int().min(0).max(65535).optional()
}).strict();
export type PresenceDiagnostic = z.infer<typeof diagnosticSchema>;
export type PresenceDiagnosticListener = (value: PresenceDiagnostic) => void;

/** Best effort only: diagnostics cannot renew a session or interrupt playback. */
export function createPresenceDiagnostics(getToken: () => string | undefined) {
  let closed = false;
  let windowStart = Date.now();
  let count = 0;
  const recent = new Map<string, number>();
  const pending = new Set<AbortController>();
  return {
    report(value: PresenceDiagnostic) {
      if (closed) return;
      const parsed = diagnosticSchema.safeParse(value);
      if (!parsed.success) return;
      const token = getToken();
      if (!token) return;
      const now = Date.now();
      if (now - windowStart >= 60_000) { windowStart = now; count = 0; }
      for (const [key, expires] of recent) if (expires <= now) recent.delete(key);
      const body = JSON.stringify(parsed.data);
      if (count >= 18 || recent.has(body)) return;
      recent.set(body, now + 30_000);
      count++;
      const controller = new AbortController();
      pending.add(controller);
      const timeout = setTimeout(() => controller.abort(), 5_000);
      void Promise.resolve().then(() => fetch(`${env.apiBaseUrl}/api/diagnostics/presence`, {
        method: "POST", credentials: "omit", cache: "no-store", signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body
      })).catch(() => {}).finally(() => { clearTimeout(timeout); pending.delete(controller); });
    },
    dispose() { closed = true; for (const controller of pending) controller.abort(); pending.clear(); recent.clear(); }
  };
}
