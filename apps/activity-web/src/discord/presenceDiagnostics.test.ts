import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPresenceDiagnostics, type PresenceDiagnostic } from "./presenceDiagnostics.js";
import { onSessionRejected } from "../api/sessionRecovery.js";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const settle = () => vi.advanceTimersByTimeAsync(0);

it("uses the current app session without sending content or starting recovery on diagnostics failure", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ error: { code: "invalid_app_token" } }, { status: 401 }));
  vi.stubGlobal("fetch", fetcher);
  const recovered = vi.fn(); const stop = onSessionRejected(recovered);
  let token = "first-token";
  const reporter = createPresenceDiagnostics(() => token);
  try {
    reporter.report({ event: "observer", reason: "ready", playing: true, titlePresent: true, audioReadyState: 4 });
    await settle();
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe("/api/diagnostics/presence");
    expect(options.headers).toEqual({ Authorization: "Bearer first-token", "Content-Type": "application/json" });
    expect(JSON.parse(options.body)).toEqual({ event: "observer", reason: "ready", playing: true, titlePresent: true, audioReadyState: 4 });
    token = "renewed-token";
    reporter.report({ event: "error", errorKind: "rpc", code: 4006 }); await settle();
    expect(fetcher.mock.calls[1]![1].headers.Authorization).toBe("Bearer renewed-token");
    expect(recovered).not.toHaveBeenCalled();
  } finally { reporter.dispose(); stop(); }
});

it("rejects unexpected properties and unbounded error values before any network request", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const reporter = createPresenceDiagnostics(() => "token");
  for (const value of [
    { event: "error", message: "private exception" }, { event: "observer", title: "private title" },
    { event: "attempt", url: "https://private.test/abs/capability" }, { event: "error", code: -1 },
    { event: "observer", audioReadyState: 5 }, { event: "error", errorKind: "private error" }
  ]) reporter.report(value as PresenceDiagnostic);
  await settle(); expect(fetcher).not.toHaveBeenCalled(); reporter.dispose();
});

it("deduplicates steady observations and caps a rapidly changing client independently of the server", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 })); vi.stubGlobal("fetch", fetcher);
  const reporter = createPresenceDiagnostics(() => "token");
  for (let count = 0; count < 100; count++) { reporter.report({ event: "observer", reason: "ready" }); await settle(); }
  expect(fetcher).toHaveBeenCalledTimes(1);
  for (let count = 0; count < 30; count++) { reporter.report({ event: "error", code: count }); await settle(); }
  expect(fetcher).toHaveBeenCalledTimes(18);
  await vi.advanceTimersByTimeAsync(60_000);
  reporter.report({ event: "observer", reason: "ready" }); await settle();
  expect(fetcher).toHaveBeenCalledTimes(19); reporter.dispose();
});

it("bounds hung requests, cancels on disposal and never throws a failed telemetry request", async () => {
  const fetcher = vi.fn().mockImplementation((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("private failure")))));
  vi.stubGlobal("fetch", fetcher);
  const reporter = createPresenceDiagnostics(() => "token");
  for (let code = 0; code < 30; code++) reporter.report({ event: "error", code });
  await settle();
  expect(fetcher).toHaveBeenCalledTimes(18);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(fetcher.mock.calls.every(call => call[1].signal.aborted)).toBe(true);
  await vi.advanceTimersByTimeAsync(55_000);
  reporter.report({ event: "error", errorKind: "timeout" }); await settle();
  reporter.dispose(); await settle();
  expect(fetcher.mock.calls[18]![1].signal.aborted).toBe(true);
  reporter.report({ event: "success" }); await settle(); expect(fetcher).toHaveBeenCalledTimes(19);
});
