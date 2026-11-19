import { DiscordSDK } from "@discord/embedded-app-sdk";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createWatchPresence, type WatchSnapshot } from "./richPresence.js";
import type { ActivityDiscordContext } from "./sdk.js";

const book: WatchSnapshot = { kind: "audio", title: "Fixture book", positionMs: 50_000, durationMs: 600_000, paused: false, buffering: false, playbackRate: 1 };
const originalLocation = window.location.href;
let sdk: DiscordSDK;
beforeEach(() => {
  vi.useFakeTimers();
  window.history.replaceState(null, "", "/?frame_id=fixture&instance_id=fixture&platform=desktop");
});
afterEach(() => { sdk?.close(1000, "Fixture complete"); window.history.replaceState(null, "", originalLocation); vi.restoreAllMocks(); vi.useRealTimers(); });

function setup(reply: (activity: unknown) => unknown, error = false) {
  const outgoing = vi.fn();
  vi.spyOn(window, "postMessage").mockImplementation((value: unknown) => {
    const [opcode, frame] = value as [number, { cmd: string; nonce: string; args: { activity: unknown } }];
    if (opcode !== 1 || frame.cmd !== "SET_ACTIVITY") return;
    outgoing(frame.args);
    Promise.resolve().then(() => window.dispatchEvent(new MessageEvent("message", {
      origin: "https://discord.com", data: [1, { cmd: frame.cmd, nonce: frame.nonce, evt: error ? "ERROR" : null, data: reply(frame.args.activity) }]
    })));
  });
  sdk = new DiscordSDK("1234567890", { disableConsoleLogOverride: true });
  const diagnostics = vi.fn();
  const context: ActivityDiscordContext = { instanceId: "fixture", isMock: false, grantedScopes: ["identify", "rpc.activities.write"], sdk };
  const publisher = createWatchPresence(context, diagnostics);
  return { publisher, outgoing, diagnostics };
}

it("receives a valid title acknowledgement through the installed SDK message transport", async () => {
  const f = setup(activity => ({ name: "Fixture Activity", type: 0, ...(activity as object) }));
  f.publisher.update(book); await vi.advanceTimersByTimeAsync(0);
  expect(f.outgoing).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ activity: expect.objectContaining({ type: 2, details: "Fixture book" }) }));
  expect(f.diagnostics).toHaveBeenLastCalledWith({ event: "success", operation: "set", activityType: 2, titlePresent: true, playing: true });
  f.publisher.clear(); await vi.advanceTimersByTimeAsync(5_000);
  expect(f.diagnostics).toHaveBeenLastCalledWith({ event: "success", operation: "clear" });
});

it("omits paused and buffering timestamps on the SDK wire and rebuilds them when listening resumes", async () => {
  vi.setSystemTime(1_800_000_000_000);
  // This fixture acknowledges the SDK command; it does not model Discord's
  // server-side validation or establish which field caused a live rejection.
  const f = setup(activity => ({ name: "Fixture Activity", type: 0, ...(activity as object) }));
  f.publisher.update(book); await vi.advanceTimersByTimeAsync(0);
  expect(f.outgoing.mock.lastCall?.[0].activity.timestamps).toEqual({ start: 1_799_999_950, end: 1_800_000_550 });
  await vi.advanceTimersByTimeAsync(5_000);
  f.publisher.update({ ...book, positionMs: 55_000, paused: true }); await vi.advanceTimersByTimeAsync(0);
  const paused = f.outgoing.mock.lastCall?.[0].activity;
  expect(paused).toMatchObject({ type: 2, details: "Fixture book", state: "Paused · 0:55 / 10:00" });
  expect(paused).not.toHaveProperty("timestamps");
  expect(f.diagnostics).toHaveBeenLastCalledWith({ event: "success", operation: "set", activityType: 2, titlePresent: true, playing: false });
  await vi.advanceTimersByTimeAsync(5_000);
  f.publisher.update({ ...book, positionMs: 55_000, buffering: true }); await vi.advanceTimersByTimeAsync(0);
  const buffering = f.outgoing.mock.lastCall?.[0].activity;
  expect(buffering).toMatchObject({ type: 2, details: "Fixture book", state: "Buffering · 0:55 / 10:00" });
  expect(buffering).not.toHaveProperty("timestamps");
  expect(f.diagnostics).toHaveBeenLastCalledWith({ event: "success", operation: "set", activityType: 2, titlePresent: true, playing: false });
  await vi.advanceTimersByTimeAsync(5_000);
  const resumedAt = Date.now();
  f.publisher.update({ ...book, positionMs: 55_000, playbackRate: 2 }); await vi.advanceTimersByTimeAsync(0);
  expect(f.outgoing).toHaveBeenCalledTimes(4);
  expect(f.outgoing.mock.lastCall?.[0].activity).toMatchObject({ type: 2, details: "Fixture book", state: "Playing",
    timestamps: { start: Math.floor((resumedAt - 55_000 / 2) / 1000), end: Math.floor((resumedAt + (600_000 - 55_000) / 2) / 1000) } });
  expect(f.diagnostics).toHaveBeenLastCalledWith({ event: "success", operation: "set", activityType: 2, titlePresent: true, playing: true });
});

it("distinguishes an accepted activity with no returned title from a numeric Discord rejection", async () => {
  let result: unknown = { name: "Fixture Activity", type: 2 };
  const f = setup(() => result);
  f.publisher.update(book); await vi.advanceTimersByTimeAsync(0);
  expect(f.diagnostics).toHaveBeenLastCalledWith({ event: "success", operation: "set", activityType: 2, titlePresent: false, playing: true });
  // A second SDK instance exercises the real error-frame parser.
  sdk.close(1000, "Next fixture"); vi.restoreAllMocks();
  result = { code: 4006, message: "Private rejection detail" };
  const denied = setup(() => result, true);
  denied.publisher.update(book); await vi.advanceTimersByTimeAsync(0);
  expect(denied.diagnostics).toHaveBeenLastCalledWith({ event: "error", operation: "set", activityType: 2, titlePresent: true, playing: true, errorKind: "rpc", code: 4006 });
  expect(JSON.stringify(denied.diagnostics.mock.calls)).not.toContain("Private rejection");
});

it("does not count an empty synthetic response as a successful real SDK acknowledgement", async () => {
  const output = vi.spyOn(console, "error").mockImplementation(() => {});
  const f = setup(() => ({}));
  f.publisher.update(book); await vi.advanceTimersByTimeAsync(10_000);
  expect(f.diagnostics).not.toHaveBeenCalledWith(expect.objectContaining({ event: "success" }));
  expect(f.diagnostics).toHaveBeenLastCalledWith(expect.objectContaining({ event: "error", errorKind: "timeout" }));
  expect(output).toHaveBeenCalled();
});
