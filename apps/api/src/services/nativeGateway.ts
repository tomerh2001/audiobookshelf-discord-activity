import { Readable } from "node:stream";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { createHash } from "node:crypto";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { FastifyReply, FastifyRequest } from "fastify";
import WebSocket, { type RawData } from "ws";
import { io, type Socket } from "socket.io-client";
import { NativeError, nativeAuthorization, type NativePartyService, type NativeViewer } from "./nativeParty.js";
import { readUpstreamJson, upstreamUrl, upstreamWebSocketOptions } from "./upstreamPolicy.js";
import { nativeMediaChunks, nativeSegmentIdleTimeout } from "./nativeMediaStream.js";
import { sendNativeText } from "./nativeResponse.js";

const ID = "[a-zA-Z0-9_-]{1,64}";
const MAX_JSON = 16 * 1024 * 1024;
const MAX_SOCKET_BUFFER = 1024 * 1024;
const startingSessions = new WeakMap<NativeViewer, Promise<unknown>>();
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const matches = (path: string, pattern: string) => new RegExp(`^${pattern}$`).test(path);

export function publicSessionId(viewer: NativeViewer, id: string): string {
  return createHash("sha256").update(`${viewer.capability}\0${id}`).digest("hex");
}
function privateSessionId(viewer: NativeViewer, alias: string): string | undefined {
  return [...viewer.playbackSessions.keys()].find(id => publicSessionId(viewer, id) === alias);
}
function publicSessionPath(viewer: NativeViewer, path: string): string {
  return path.replace(/^\/(api\/session|public\/session|hls)\/([^/]+)/, (_all, prefix: string, id: string) => {
    if (!viewer.playbackSessions.has(id)) throw new NativeError("native_media_url_denied", 502);
    return `/${prefix}/${publicSessionId(viewer, id)}`;
  });
}
function privateSessionPath(viewer: NativeViewer, path: string): string {
  return path.replace(/^\/(api\/session|public\/session|hls)\/([^/]+)/, (_all, prefix: string, alias: string) => {
    const id = privateSessionId(viewer, alias);
    if (!id) throw new NativeError("native_path_denied");
    return `/${prefix}/${id}`;
  });
}

/** Explicit native browsing/player surface. No administrative or arbitrary file routes. */
export function allowNativeRequest(viewer: NativeViewer, method: string, path: string, query = new URLSearchParams()): boolean {
  if (!path.startsWith("/") || /[%\\]/.test(path) || [...path].some(character => character.charCodeAt(0) <= 32) || path.split("/").some(part => part === "." || part === "..")) return false;
  if ([...query].some(([key, value]) => /token|secret|password|cookie|authorization|redirect|url/i.test(key) || value.length > 4096)) return false;
  if ([...query.keys()].length > 40) return false;
  const read = method === "GET" || method === "HEAD";
  if (read) {
    // Express also routes HEAD to GET handlers. These native GET endpoints
    // change progress, so never treat them as harmless HEAD probes.
    if (matches(path, `/api/me/progress/${ID}/remove-from-continue-listening`)
      || matches(path, `/api/me/series/${ID}/(?:remove-from|readd-to)-continue-listening`)) return method === "GET";
    if (matches(path, `/api/libraries(?:/${ID}(?:/(?:items|series|collections|playlists|personalized|filterdata|search|stats|authors|narrators|recent-episodes|podcast-titles)(?:/${ID})?)?)?`)) return true;
    if (matches(path, `/api/items/${ID}(?:/cover)?`)) return true;
    if (matches(path, `/api/(?:authors|series|collections|playlists)(?:/${ID}(?:/(?:image|books))?)?`)) return true;
    if (matches(path, `/api/me(?:/(?:progress|bookmarks|items-in-progress|listening-sessions|listening-stats)(?:/${ID})?)?`)) return true;
    if (matches(path, `/api/me/progress/${ID}/${ID}`)) return true;
    if (matches(path, `/api/me/item/listening-sessions/${ID}(?:/${ID})?`)) return true;
    if (matches(path, `/api/me/stats/year/[0-9]{4}`)) return true;
    if (matches(path, `/api/items/${ID}/file/${ID}`)) return true;
    const session = new RegExp(`^/(?:api/session/(${ID})|public/session/(${ID})/track/[0-9]{1,6}|hls/(${ID})/(?:output(?:-[0-9]+)?\\.(?:m3u8|ts)))$`).exec(path);
    if (session) return !!privateSessionId(viewer, session[1] ?? session[2] ?? session[3]!);
  }
  if (method === "POST" && path === "/api/authorize") return true;
  if (method === "POST" && path === "/api/items/batch/get") return true;
  if (method === "POST" && matches(path, `/api/items/${ID}/play(?:/${ID})?`)) return true;
  const sessionWrite = new RegExp(`^/api/session/(${ID})/(sync|close)$`).exec(path);
  if (method === "POST" && sessionWrite) return !!privateSessionId(viewer, sessionWrite[1]!);
  if (["POST", "PATCH", "DELETE"].includes(method) && matches(path, `/api/me/item/${ID}/bookmark(?:/[0-9.]+)?`)) return true;
  if (["PATCH", "DELETE"].includes(method) && matches(path, `/api/me/progress/${ID}(?:/${ID})?`)) return true;
  // User settings use the current account only; never forward a user-selected ID.
  if (method === "PATCH" && path === `/api/users/${viewer.connection.audiobookshelfUserId}/settings`) return true;
  if (method === "POST" && matches(path, `/api/playlists/collection/${ID}`)) return true;
  if (["POST", "PATCH", "DELETE"].includes(method) && matches(path, `/api/playlists(?:/${ID}(?:/(?:item|batch/add|batch/remove)(?:/${ID}(?:/${ID})?)?)?)?`)) return true;
  return false;
}

function mediaUrl(viewer: NativeViewer, value: string): string {
  const url = upstreamUrl(viewer.connection.target, value);
  const basePath = new URL(viewer.connection.serverUrl).pathname.replace(/\/$/, "");
  const path = publicSessionPath(viewer, url.pathname.slice(basePath.length));
  for (const key of [...url.searchParams.keys()]) if (/token|secret|api.?key/i.test(key)) url.searchParams.delete(key);
  if (!allowNativeRequest(viewer, "GET", path, url.searchParams)) throw new NativeError("native_media_url_denied", 502);
  return `/abs/${viewer.capability}${path}${url.search}`;
}

/** Sanitize all upstream objects, including admin users and embedded library items. */
export function sanitizeNativeJson(viewer: NativeViewer, value: unknown): unknown {
  const clean = (input: unknown, sessionRecord = false): unknown => {
    if (typeof input === "string") return input.replaceAll(viewer.connection.accessToken, "[redacted]");
    if (Array.isArray(input)) return input.map((entry) => clean(entry, sessionRecord));
    if (input === null || typeof input !== "object") return input;
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(input)) {
      // History contains live native session UUIDs, including other viewers of a
      // shared account. Those UUIDs can unlock ABS public stream routes directly.
      // Keep library/item IDs intact; only these contextual records lose IDs.
      if (sessionRecord && ["id", "sessionId", "streamId"].includes(key)) continue;
      if (["sessions", "recentSessions"].includes(key) && Array.isArray(entry)) { result[key] = clean(entry, true); continue; }
      if (["sessionId", "streamId"].includes(key) && typeof entry === "string" && !viewer.playbackSessions.has(entry)) continue;
      // Native cover components test presence, then construct their own scoped
      // /cover or /image URL. Preserve that signal without server filesystem paths.
      if (["coverPath", "imagePath"].includes(key)) { result[key] = entry ? "available" : null; continue; }
      if (/token|secret|password|authorization|cookie|openid|apikey/i.test(key)
        || ["path", "fullPath", "relPath", "folders", "usersOnline", "deviceInfo", "ipAddress", "userAgent"].includes(key)) continue;
      if (["id", "sessionId", "streamId", "stream"].includes(key) && typeof entry === "string" && viewer.playbackSessions.has(entry)) result[key] = publicSessionId(viewer, entry);
      else if (key === "contentUrl" && typeof entry === "string") result[key] = mediaUrl(viewer, entry);
      else if (key === "permissions") result[key] = { ...record(clean(entry)), update: false, delete: false, upload: false, download: false };
      else if (key === "type" && ["root", "admin"].includes(String(entry))) result[key] = "user";
      else result[key] = clean(entry);
    }
    return result;
  };
  return clean(value);
}

export function rewriteNativePlaylist(viewer: NativeViewer, text: string, sourceUrl: string): string {
  if (text.length > 2 * 1024 * 1024) throw new NativeError("native_playlist_too_large", 502);
  const rewrite = (value: string) => mediaUrl(viewer, new URL(value, sourceUrl).href);
  return text.split("\n").map(line => {
    if (!line.trim()) return line;
    if (line.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (_match, value: string) => `URI="${rewrite(value)}"`);
    return rewrite(line.trim());
  }).join("\n");
}

function ownsCommunityProgress(service: NativePartyService, viewer: NativeViewer): boolean {
  if (viewer.connection.kind !== "community") return true;
  // One active writer for this shared account across the Activity process. Followers retain their own stream sessions.
  const owners = [...service.viewers.values()].filter(candidate => candidate.connection.serverUrl === viewer.connection.serverUrl && service.active(candidate)
    && candidate.sockets > 0 && candidate.connection.audiobookshelfUserId === viewer.connection.audiobookshelfUserId)
    .sort((left, right) => left.deviceId.localeCompare(right.deviceId));
  return !owners.length || owners[0] === viewer;
}

export async function proxyNativeRequest(service: NativePartyService, viewer: NativeViewer, request: FastifyRequest,
  reply: FastifyReply, path: string, query: URLSearchParams): Promise<unknown> {
  if (request.method !== "POST" || !matches(path, `/api/items/${ID}/play(?:/${ID})?`)) {
    return proxyRequest(service, viewer, request, reply, path, query);
  }
  // ABS replaces the previous session for a device. Serialize starts so a slower
  // response cannot publish a capability for a session already closed upstream.
  const task = (startingSessions.get(viewer)?.catch(() => undefined) ?? Promise.resolve())
    .then(() => proxyRequest(service, viewer, request, reply, path, query));
  startingSessions.set(viewer, task);
  try { return await task; }
  finally { if (startingSessions.get(viewer) === task) startingSessions.delete(viewer); }
}

async function proxyRequest(service: NativePartyService, viewer: NativeViewer, request: FastifyRequest,
  reply: FastifyReply, path: string, query: URLSearchParams): Promise<unknown> {
  if (!service.active(viewer)) throw new NativeError("native_session_expired", 401);
  if (!allowNativeRequest(viewer, request.method, path, query)) throw new NativeError("native_path_denied");
  const itemMatch = new RegExp(`^/api/items/(${ID})(?:/|$)`).exec(path);
  if (itemMatch && path !== "/api/items/batch/get") await service.requireItem(viewer, itemMatch[1]!);
  const play = new RegExp(`^/api/items/(${ID})/play(?:/(${ID}))?$`).exec(path);
  const session = new RegExp(`^/api/session/(${ID})/(sync|close)$`).exec(path);
  const directProgressWrite = ["PATCH", "DELETE"].includes(request.method) && matches(path, `/api/me/progress/${ID}(?:/${ID})?`);
  const continueListeningWrite = request.method === "GET" && (matches(path, `/api/me/progress/${ID}/remove-from-continue-listening`)
    || matches(path, `/api/me/series/${ID}/(?:remove-from|readd-to)-continue-listening`));
  if ((directProgressWrite || continueListeningWrite)
    && !ownsCommunityProgress(service, viewer)) throw new NativeError("native_shared_progress_read_only");
  let body = request.body;
  if (request.method === "POST" && path === "/api/items/batch/get") {
    const ids = record(body).libraryItemIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 500 || !ids.every(id => typeof id === "string" && matches(id, ID))) {
      throw new NativeError("native_invalid_items", 400);
    }
    body = { libraryItemIds: [...new Set(ids)] };
  }
  if (play) {
    const input = record(body);
    // A client cannot close another community viewer's session by borrowing their device ID.
    body = { deviceInfo: { deviceId: viewer.deviceId, clientName: "Audiobookshelf Discord Activity", clientVersion: "0.1.0" },
      supportedMimeTypes: Array.isArray(input.supportedMimeTypes) ? input.supportedMimeTypes.filter(value => typeof value === "string" && /^audio\/[\w.+-]{1,80}$/.test(value)).slice(0, 30) : [],
      mediaPlayer: "html5", forceTranscode: input.forceTranscode === true, forceDirectPlay: input.forceDirectPlay === true };
  }
  if (session && !ownsCommunityProgress(service, viewer)) {
    if (session[2] === "sync") return reply.send({ success: true });
    body = {}; // Close a follower's stream without writing its stale progress.
  }
  if (session && (session[2] === "sync" || Object.keys(record(body)).length)) {
    const input = record(body);
    if (![input.currentTime, input.timeListened].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)
      || Number(input.timeListened) > 86400 || Number(input.currentTime) > 365 * 86400) throw new NativeError("native_invalid_progress", 400);
    body = { currentTime: input.currentTime, timeListened: input.timeListened,
      ...(typeof input.duration === "number" && Number.isFinite(input.duration) && input.duration > 0 ? { duration: input.duration } : {}) };
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  viewer.aborters.add(abort);
  request.raw.once("aborted", abort);
  reply.raw.once("close", abort);
  const timeout = setTimeout(abort, 20_000);
  let streaming = false;
  const dispose = () => { clearTimeout(timeout); viewer.aborters.delete(abort); request.raw.off("aborted", abort); reply.raw.off("close", abort); };
  try {
    const headers: Record<string, string> = { Authorization: nativeAuthorization(viewer) };
    if (request.headers.range) headers.Range = request.headers.range;
    if (typeof request.headers["if-range"] === "string") headers["If-Range"] = request.headers["if-range"];
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const target = `${privateSessionPath(viewer, path)}${query.size ? `?${query}` : ""}`;
    const response = await service.dependencies.fetch(viewer.connection.target, target, { method: request.method, headers, signal: controller.signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    clearTimeout(timeout);
    if (!service.active(viewer)) { await response.body?.cancel(); throw new NativeError("native_session_expired", 401); }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) await service.revoke(viewer);
      if (response.status === 416 && response.headers.get("content-range")) reply.header("Content-Range", response.headers.get("content-range"));
      return reply.code(response.status >= 400 && response.status < 600 ? response.status : 502).send({ error: { code: "audiobookshelf_request_failed", message: "Audiobookshelf could not complete this request." } });
    }
    if (session?.[2] === "close") {
      const id = privateSessionId(viewer, session[1]!); if (id) viewer.playbackSessions.delete(id);
    }
    reply.code(response.status).header("Cache-Control", "no-store");
    if (request.method === "HEAD" || response.status === 204) { await response.body?.cancel(); return reply.send(); }
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    if (contentType.includes("json")) {
      const value = await readUpstreamJson(response, MAX_JSON);
      if (play) {
        const id = record(value).id;
        if (typeof id !== "string" || !matches(id, ID)) throw new NativeError("native_invalid_session", 502);
        viewer.playbackSessions.clear();
        viewer.playbackSessions.set(id, { itemId: play[1]!, ...(play[2] ? { episodeId: play[2] } : {}) });
      }
      return sendNativeText(reply.type("application/json"), sanitizeNativeJson(viewer, value));
    }
    if (/mpegurl/i.test(contentType) || path.endsWith(".m3u8")) {
      const text = await boundedText(response, 2 * 1024 * 1024);
      return sendNativeText(reply.type("application/vnd.apple.mpegurl"), rewriteNativePlaylist(viewer, text, upstreamUrl(viewer.connection.target, target).href));
    }
    if (/(?:html|xml|svg|javascript|ecmascript)/i.test(contentType)) { await response.body?.cancel(); throw new NativeError("native_content_denied", 502); }
    for (const header of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const value = response.headers.get(header); if (value) reply.header(header, value);
    }
    if (!response.body) return reply.send();
    const source = Readable.fromWeb(response.body as unknown as NodeReadableStream, { signal: controller.signal });
    const stream = Readable.from((async function* () {
      try { for await (const chunk of nativeMediaChunks(source, nativeSegmentIdleTimeout(path))) { if (!service.active(viewer)) break; yield chunk; } }
      finally { source.destroy(); dispose(); }
    })());
    stream.once("close", () => { source.destroy(); dispose(); });
    stream.once("error", () => {
      if (!reply.raw.headersSent) {
        for (const header of ["content-length", "content-range", "accept-ranges"]) { reply.removeHeader(header); reply.raw.removeHeader(header); }
        reply.type("application/json"); reply.raw.setHeader("content-type", "application/json");
      }
    });
    // Keep abort hooks for the lifetime of the stream.
    streaming = true;
    return reply.send(stream);
  } catch (error) {
    if (error instanceof NativeError) throw error;
    throw new NativeError("audiobookshelf_unavailable", 502);
  } finally {
    if (!streaming) dispose();
  }
}

async function boundedText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader(); if (!reader) return "";
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.length;
      if (bytes > limit) throw new NativeError("native_playlist_too_large", 502); chunks.push(next.value); }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
}

export type PreparedNativeSocket = { socket: Socket };
export async function prepareNativeSocket(viewer: NativeViewer, signal?: AbortSignal): Promise<PreparedNativeSocket> {
  const base = new URL(viewer.connection.serverUrl);
  // engine.io-client filters WebSocket options and silently drops lookup and
  // servername. Its allowed `agent` option carries both through Node's transport.
  // Each native socket owns its agent; credentials never live in agent options.
  const Agent = base.protocol === "https:" ? HttpsAgent : HttpAgent;
  const agent = new Agent({ ...upstreamWebSocketOptions(viewer.connection.target), keepAlive: false });
  const upstream = io(base.origin, { path: `${base.pathname.replace(/\/$/, "")}/socket.io`, transports: ["websocket"],
    forceNew: true, reconnection: false, autoConnect: false, timeout: 15_000,
    transportOptions: { websocket: { agent, maxPayload: MAX_JSON } } });
  const abort = () => { upstream.disconnect(); agent.destroy(); };
  viewer.aborters.add(abort); signal?.addEventListener("abort", abort, { once: true });
  upstream.once("disconnect", () => { agent.destroy(); viewer.aborters.delete(abort); signal?.removeEventListener("abort", abort); });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new NativeError("native_socket_unavailable", 502)), 15_000);
      const success = () => { clearTimeout(timeout); resolve(); };
      const failure = () => { clearTimeout(timeout); reject(new NativeError("native_socket_unavailable", 502)); };
      upstream.once("connect", () => upstream.emit("auth", viewer.connection.accessToken));
      upstream.once("init", success); upstream.once("auth_failed", failure); upstream.once("connect_error", failure);
      upstream.connect();
    });
    if (signal?.aborted || viewer.revoked) throw new NativeError("native_session_expired", 401);
    return { socket: upstream };
  } catch (error) { abort(); viewer.aborters.delete(abort); signal?.removeEventListener("abort", abort); throw error; }
}

export function bridgeNativeSocket(service: NativePartyService, viewer: NativeViewer, socket: WebSocket, prepared: PreparedNativeSocket): void {
  viewer.sockets++; viewer.lastSocketClose = 0;
  let ended = false; let alive = true; let pending = 0; let unsubscribe: (() => void) | undefined;
  const stop = () => {
    if (ended) return; ended = true; clearInterval(heartbeat); unsubscribe?.(); viewer.aborters.delete(stop);
    prepared.socket.disconnect(); socket.terminate(); void service.socketDisconnected(viewer);
  };
  viewer.aborters.add(stop);
  const send = (MessageType: string, Data: unknown) => {
    if (ended || !service.active(viewer) || socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > MAX_SOCKET_BUFFER) { stop(); return; }
    socket.send(JSON.stringify({ MessageType, Data }));
  };
  const heartbeat = setInterval(() => {
    if (!alive || !service.active(viewer)) { stop(); return; } alive = false; socket.ping();
    void service.authorize(viewer.capability).catch(stop);
  }, 15_000); heartbeat.unref();
  socket.on("pong", () => { alive = true; });
  socket.on("close", stop); socket.on("error", stop);
  prepared.socket.on("disconnect", stop);
  prepared.socket.onAny((event: string, payload: unknown) => {
    if (event === "user_updated" && record(payload).id === viewer.connection.audiobookshelfUserId) {
      send("AudiobookshelfEvent", { event, payload: sanitizeNativeJson(viewer, payload) }); return;
    }
    if (["playlist_added", "playlist_updated", "playlist_removed"].includes(event) && record(payload).userId === viewer.connection.audiobookshelfUserId) {
      send("AudiobookshelfEvent", { event, payload: sanitizeNativeJson(viewer, payload) }); return;
    }
    if (!["stream_reset", "stream_progress", "stream_error", "stream_ready"].includes(event)) return;
    const id = record(payload).streamId ?? record(payload).id ?? record(payload).stream;
    if (typeof id !== "string" || !viewer.playbackSessions.has(id)) return;
    send("AudiobookshelfEvent", { event, payload: sanitizeNativeJson(viewer,
      event === "stream_error" ? { id, error: "Audiobookshelf could not prepare this audio stream." } : payload) });
  });
  socket.on("message", (raw: RawData, binary: boolean) => {
    if (binary || Buffer.byteLength(raw.toString()) > 65_536) { stop(); return; }
    let message: Record<string, unknown>; try { message = record(JSON.parse(raw.toString())); } catch { stop(); return; }
    if (message.MessageType !== "ActivityPlaybackCommand") return;
    if (++pending > 64) { stop(); return; }
    void service.playback.submit(viewer, message.Data).then(state => { if (state.ack?.duplicate) send("ActivityPlaybackState", state); })
      .catch(async (error: unknown) => {
        let state; try { state = await service.playback.get(viewer); } catch { /* Revoked/denied viewers receive no state. */ }
        const id = record(message.Data).id;
        send("ActivityPlaybackError", { ...(typeof id === "string" && matches(id, ID) ? { id } : {}),
          code: error instanceof NativeError ? error.code : "activity_command_failed", ...(state ?? { clientId: viewer.deviceId }) });
        if (!service.active(viewer)) stop();
      }).finally(() => { pending--; });
  });
  void service.playback.connect(viewer, state => send("ActivityPlaybackState", state)).then(cleanup => {
    if (ended) cleanup(); else unsubscribe = cleanup;
  }).catch(() => stop());
}
