import { createHash } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { AppEnv } from "../env.js";
import { decryptString, encryptString, generateId } from "./crypto.js";
import { sessionStore, type AppSession } from "./sessionStore.js";
import { deniedDiscordActor } from "./discord.js";
import { normalizeUpstreamUrl, readUpstreamJson, upstreamFetch, validateUpstream, type ValidatedUpstream } from "./upstreamPolicy.js";

export type ConnectionDto = Readonly<{
  id: string;
  serverUrl: string;
  serverId: string;
  serverName: string;
  audiobookshelfUserId: string;
  audiobookshelfUsername: string;
  kind: "personal" | "community";
  createdAt: string;
  updatedAt: string;
}>;
type ConnectionRecord = ConnectionDto & { discordUserId: string; encryptedAccessToken: string; encryptedRefreshToken: string; loginDeviceId: string; communityGuildId: string };
export type ResolvedConnection = ConnectionDto & { accessToken: string; target: ValidatedUpstream };
export type ConnectionRevocation = { connectionId: string; discordUserId: string };
const revocationListeners = new Set<(event: ConnectionRevocation) => void>();

export function onConnectionsRevoked(listener: (event: ConnectionRevocation) => void): () => void {
  revocationListeners.add(listener);
  return () => { revocationListeners.delete(listener); };
}

function revoked(record: ConnectionRecord): void {
  for (const listener of revocationListeners) listener({ connectionId: record.id, discordUserId: record.discordUserId });
}

export class ConnectionError extends Error {
  constructor(readonly code: string, readonly publicMessage: string, readonly statusCode = 400) { super(code); }
}

/** Each short transaction uses its own connection. No asynchronous read/modify/write race. */
export class AudiobookshelfConnectionStore {
  constructor(private readonly env: AppEnv) {}

  list(discordUserId: string, guildId?: string): ConnectionDto[] {
    return this.withDb((db) => db.prepare("SELECT * FROM connections WHERE discord_user_id = ? ORDER BY created_at, id")
      .all(discordUserId).map(fromRow).filter((record) => record.kind === "personal" || record.communityGuildId === (guildId ?? ""))
      .map(publicConnection));
  }

  get(discordUserId: string, connectionId: string): ConnectionRecord | undefined {
    return this.withDb((db) => {
      const row = db.prepare("SELECT * FROM connections WHERE discord_user_id = ? AND id = ?").get(discordUserId, connectionId);
      return row ? fromRow(row) : undefined;
    });
  }

  save(input: Omit<ConnectionRecord, "id" | "createdAt" | "updatedAt" | "communityGuildId">, guildId?: string): ConnectionDto {
    let previous: ConnectionRecord | undefined;
    const result = this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const scope = input.kind === "community" ? guildId ?? "" : "";
        const row = db.prepare("SELECT * FROM connections WHERE discord_user_id = ? AND server_url = ? AND kind = ? AND community_guild_id = ?")
          .get(input.discordUserId, input.serverUrl, input.kind, scope);
        previous = row ? fromRow(row) : undefined;
        const count = db.prepare("SELECT COUNT(*) AS count FROM connections WHERE discord_user_id = ?").get(input.discordUserId);
        if (!previous && Number(count?.count) >= 20) throw new ConnectionError("connection_limit", "Disconnect an unused server before adding another.", 409);
        const now = new Date(Math.max(Date.now(), previous ? Date.parse(previous.updatedAt) + 1 : 0)).toISOString();
        const record: ConnectionRecord = { ...input, id: previous?.id ?? generateId(), createdAt: previous?.createdAt ?? now,
          updatedAt: now, communityGuildId: scope };
        db.prepare(`INSERT INTO connections VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(discord_user_id, server_url, kind, community_guild_id) DO UPDATE SET
            server_id=excluded.server_id, server_name=excluded.server_name, audiobookshelf_user_id=excluded.audiobookshelf_user_id,
            audiobookshelf_username=excluded.audiobookshelf_username, encrypted_access_token=excluded.encrypted_access_token, encrypted_refresh_token=excluded.encrypted_refresh_token,
            login_device_id=excluded.login_device_id, updated_at=excluded.updated_at, community_guild_id=excluded.community_guild_id`)
          .run(record.id, record.discordUserId, record.serverUrl, record.serverId, record.serverName,
            record.audiobookshelfUserId, record.audiobookshelfUsername, record.encryptedAccessToken, record.loginDeviceId,
            record.kind, record.createdAt, record.updatedAt, record.communityGuildId, record.encryptedRefreshToken);
        putPreference(db, input.discordUserId, guildId ?? "", record.id);
        db.exec("COMMIT");
        return publicConnection(record);
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    });
    if (previous) revoked(previous);
    return result;
  }

  remove(discordUserId: string, connectionId: string): ConnectionRecord | undefined {
    const result = this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db.prepare("SELECT * FROM connections WHERE discord_user_id = ? AND id = ?").get(discordUserId, connectionId);
        db.prepare("DELETE FROM connections WHERE discord_user_id = ? AND id = ?").run(discordUserId, connectionId);
        db.exec("COMMIT");
        return row ? fromRow(row) : undefined;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    });
    if (result) revoked(result);
    return result;
  }

  preferred(discordUserId: string, guildId?: string): string | null {
    return this.withDb((db) => {
      const row = db.prepare("SELECT connection_id FROM preferences WHERE discord_user_id = ? AND guild_id = ?")
        .get(discordUserId, guildId ?? "");
      return typeof row?.connection_id === "string" ? row.connection_id : null;
    });
  }

  setPreferred(discordUserId: string, guildId: string | undefined, connectionId: string): void {
    this.withDb((db) => {
      const owned = db.prepare("SELECT id, kind, community_guild_id FROM connections WHERE discord_user_id = ? AND id = ?").get(discordUserId, connectionId);
      if (!owned) throw notFound();
      if (owned.kind === "community" && owned.community_guild_id !== (guildId ?? "")) throw notFound();
      putPreference(db, discordUserId, guildId ?? "", connectionId);
    });
  }

  replaceTokens(record: ConnectionRecord, accessToken: string, refreshToken: string): ConnectionRecord | undefined {
    return this.withDb((db) => {
      const changed = db.prepare(`UPDATE connections SET encrypted_access_token=?, encrypted_refresh_token=?
        WHERE id=? AND discord_user_id=? AND encrypted_access_token=? AND encrypted_refresh_token=?`)
        .run(encryptString(this.env, accessToken), encryptString(this.env, refreshToken), record.id,
          record.discordUserId, record.encryptedAccessToken, record.encryptedRefreshToken);
      if (!changed.changes) return undefined;
      const row = db.prepare("SELECT * FROM connections WHERE id=?").get(record.id);
      return row ? fromRow(row) : undefined;
    });
  }

  private withDb<T>(operation: (db: DatabaseSync) => T): T {
    const databasePath = this.env.DATABASE_URL.startsWith("file:") ? this.env.DATABASE_URL.slice(5) : this.env.DATABASE_URL;
    const filename = path.join(path.dirname(databasePath), "audiobookshelf-connections.sqlite");
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(filename, { timeout: 5000 });
    try {
      chmodSync(filename, 0o600);
      db.exec(`PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS connections (
          id TEXT PRIMARY KEY, discord_user_id TEXT NOT NULL, server_url TEXT NOT NULL,
          server_id TEXT NOT NULL, server_name TEXT NOT NULL, audiobookshelf_user_id TEXT NOT NULL,
          audiobookshelf_username TEXT NOT NULL, encrypted_access_token TEXT NOT NULL, login_device_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('personal','community')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          community_guild_id TEXT NOT NULL, encrypted_refresh_token TEXT NOT NULL,
          UNIQUE(discord_user_id, server_url, kind, community_guild_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS preferences (
          discord_user_id TEXT NOT NULL, guild_id TEXT NOT NULL, connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
          PRIMARY KEY(discord_user_id, guild_id)
        ) STRICT;`);
      return operation(db);
    } finally { db.close(); }
  }
}

function putPreference(db: DatabaseSync, userId: string, guildId: string, connectionId: string): void {
  db.prepare(`INSERT INTO preferences VALUES (?, ?, ?) ON CONFLICT(discord_user_id, guild_id)
    DO UPDATE SET connection_id=excluded.connection_id`).run(userId, guildId, connectionId);
}

function fromRow(row: Record<string, unknown>): ConnectionRecord {
  return { id: String(row.id), discordUserId: String(row.discord_user_id), serverUrl: String(row.server_url),
    serverId: String(row.server_id), serverName: String(row.server_name), audiobookshelfUserId: String(row.audiobookshelf_user_id),
    audiobookshelfUsername: String(row.audiobookshelf_username), encryptedAccessToken: String(row.encrypted_access_token),
    loginDeviceId: String(row.login_device_id), kind: row.kind as "personal" | "community",
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    communityGuildId: String(row.community_guild_id), encryptedRefreshToken: String(row.encrypted_refresh_token) };
}

function publicConnection(record: ConnectionRecord): ConnectionDto {
  const { discordUserId: _owner, encryptedAccessToken: _token, encryptedRefreshToken: _refresh, loginDeviceId: _device, communityGuildId: _guild, ...dto } = record;
  return dto;
}

export function setPreferredConnection(env: AppEnv, userId: string, guildId: string | undefined, connectionId: string): void {
  new AudiobookshelfConnectionStore(env).setPreferred(userId, guildId, connectionId);
}

const serverInfoSchema = z.object({ app: z.literal("audiobookshelf"), serverVersion: z.string().min(1).max(100),
  isInit: z.literal(true), authMethods: z.array(z.string()).default([]) });
export type ServerIdentity = { Id: string; ServerName: string; authMethods: string[] };
const userSchema = z.object({ id: z.string().min(1).max(128), username: z.string().min(1).max(200),
  accessToken: z.string().min(1).max(16384), refreshToken: z.string().min(1).max(16384) });
const authSchema = z.object({ user: userSchema });

export async function identifyServer(target: ValidatedUpstream): Promise<ServerIdentity> {
  const response = await upstreamFetch(target, "/status", { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) { await response.body?.cancel(); throw new ConnectionError("not_audiobookshelf_server", "This address did not return an initialized Audiobookshelf server.", 502); }
  const parsed = serverInfoSchema.safeParse(await readUpstreamJson(response));
  if (!parsed.success) throw new ConnectionError("not_audiobookshelf_server", "This address did not return an initialized Audiobookshelf server.", 502);
  // ABS does not expose an installation ID. This is a canonical destination key,
  // not a claim that /status can authenticate an installation replacement.
  return { Id: createHash("sha256").update(target.serverUrl).digest("hex"),
    ServerName: new URL(target.serverUrl).host, authMethods: parsed.data.authMethods };
}

export function audiobookshelfClientHeader(_deviceId: string, accessToken?: string): string {
  return accessToken ? `Bearer ${accessToken}` : "";
}

export async function connectWithPassword(env: AppEnv, session: AppSession,
  input: { serverUrl: string; username: string; password: string }, kind: "personal" | "community" = "personal"): Promise<ConnectionDto> {
  if (deniedDiscordActor(env, session.discordUserId)) throw new ConnectionError("discord_actor_forbidden", "This account cannot access this server.", 403);
  if (!sessionStore.getSession(session.id)) throw new ConnectionError("invalid_app_session", "Open the Activity again before connecting.", 401);
  const target = await validateUpstream(env, input.serverUrl);
  const server = await identifyServer(target);
  const response = await upstreamFetch(target, "/login", {
    method: "POST", headers: { "Content-Type": "application/json", "x-return-tokens": "true" },
    body: JSON.stringify({ username: input.username, password: input.password }), signal: AbortSignal.timeout(15_000)
  });
  return saveAuthentication(env, session, target, server, response, kind);
}

export async function saveAuthentication(env: AppEnv, session: AppSession, target: ValidatedUpstream, server: ServerIdentity,
  response: Response, kind: "personal" | "community", beforeSave?: () => void): Promise<ConnectionDto> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new ConnectionError("audiobookshelf_login_failed", response.status === 401 ? "Audiobookshelf rejected those credentials." : "Could not sign in to Audiobookshelf.", response.status === 401 ? 401 : 502);
  }
  const parsed = authSchema.safeParse(await readUpstreamJson(response));
  if (!parsed.success) throw new ConnectionError("unsupported_audiobookshelf_auth", "The server did not return access and refresh tokens. Use Audiobookshelf 2.38 or later.", 502);
  const auth = parsed.data.user;
  let connection: ConnectionDto;
  let previous: ConnectionRecord | undefined;
  try {
    if (!sessionStore.getSession(session.id) || deniedDiscordActor(env, session.discordUserId)) throw new ConnectionError("invalid_app_session", "Open the Activity again before connecting.", 401);
    beforeSave?.();
    const store = new AudiobookshelfConnectionStore(env);
    const existing = store.list(session.discordUserId, session.discordContext?.guildId)
      .find((candidate) => candidate.serverUrl === target.serverUrl && candidate.kind === kind);
    previous = existing ? store.get(session.discordUserId, existing.id) : undefined;
    connection = store.save({ discordUserId: session.discordUserId,
      serverUrl: target.serverUrl, serverId: server.Id, serverName: server.ServerName,
      audiobookshelfUserId: auth.id, audiobookshelfUsername: auth.username,
      encryptedAccessToken: encryptString(env, auth.accessToken), encryptedRefreshToken: encryptString(env, auth.refreshToken),
      loginDeviceId: `audiobookshelf-listen-${generateId()}`, kind }, session.discordContext?.guildId);
  } catch (error) {
    await logoutToken(target, auth.refreshToken);
    throw error;
  }
  if (previous) {
    const oldRefresh = decryptString(env, previous.encryptedRefreshToken);
    if (oldRefresh !== auth.refreshToken) await logoutToken(target, oldRefresh);
  }
  return connection;
}

async function logoutToken(target: ValidatedUpstream, refreshToken: string): Promise<boolean> {
  try {
    const response = await upstreamFetch(target, "/logout", { method: "POST", signal: AbortSignal.timeout(5000),
      headers: { "x-refresh-token": refreshToken } });
    await response.body?.cancel();
    return response.ok || response.status === 401;
  } catch { return false; }
}

function communityAllowedInGuild(env: AppEnv, guildId?: string): boolean {
  if (env.AUDIOBOOKSHELF_COMMUNITY_ACCESS === "public") return true;
  const ids = env.AUDIOBOOKSHELF_COMMUNITY_GUILD_IDS || env.DISCORD_ALLOWED_GUILD_IDS;
  return Boolean(guildId && ids.split(",").map((id) => id.trim()).includes(guildId));
}

export function communityAvailable(env: AppEnv, session: AppSession): boolean {
  return env.AUDIOBOOKSHELF_AUTH_MODE === "shared" && Boolean(env.AUDIOBOOKSHELF_SHARED_USERNAME && env.AUDIOBOOKSHELF_SHARED_PASSWORD)
    && communityAllowedInGuild(env, session.discordContext?.guildId);
}

export async function connectCommunity(env: AppEnv, session: AppSession): Promise<ConnectionDto> {
  if (deniedDiscordActor(env, session.discordUserId)) throw new ConnectionError("discord_actor_forbidden", "This account cannot access this server.", 403);
  if (!communityAvailable(env, session)) throw new ConnectionError("community_account_unavailable", "This community has no shared Audiobookshelf account.", 403);
  return connectWithPassword(env, session, { serverUrl: env.AUDIOBOOKSHELF_DEFAULT_SERVER_URL,
    username: env.AUDIOBOOKSHELF_SHARED_USERNAME, password: env.AUDIOBOOKSHELF_SHARED_PASSWORD }, "community");
}

function ownedConnection(env: AppEnv, discordUserId: string, connectionId: string, guildId?: string): ConnectionRecord {
  if (deniedDiscordActor(env, discordUserId)) throw notFound();
  const record = new AudiobookshelfConnectionStore(env).get(discordUserId, connectionId);
  if (!record) throw notFound();
  if (record.kind === "community" && (record.communityGuildId !== (guildId ?? "")
    || env.AUDIOBOOKSHELF_AUTH_MODE !== "shared" || !communityAllowedInGuild(env, guildId))) throw notFound();
  return record;
}

export function assertConnectionCurrent(env: AppEnv, discordUserId: string, connection: ResolvedConnection, guildId?: string): void {
  const record = ownedConnection(env, discordUserId, connection.id, guildId);
  // Token rotation preserves the account and issued playback capabilities. Relink
  // changes updatedAt and emits revocation before it can publish a new capability.
  if (record.serverUrl !== connection.serverUrl || record.serverId !== connection.serverId
    || record.audiobookshelfUserId !== connection.audiobookshelfUserId || record.updatedAt !== connection.updatedAt) throw notFound();
}

const resolutions = new Map<string, Promise<ResolvedConnection>>();
export async function resolveConnection(env: AppEnv, discordUserId: string, connectionId: string, guildId?: string): Promise<ResolvedConnection> {
  const record = ownedConnection(env, discordUserId, connectionId, guildId);
  const key = JSON.stringify([env.DATABASE_URL, discordUserId, connectionId, record.updatedAt, record.encryptedAccessToken]);
  const existing = resolutions.get(key);
  if (existing) return existing;
  const operation = resolveCredential(env, record, guildId).finally(() => resolutions.delete(key));
  resolutions.set(key, operation);
  return operation;
}

async function resolveCredential(env: AppEnv, initial: ConnectionRecord, guildId?: string): Promise<ResolvedConnection> {
  let record = initial;
  const target = await validateUpstream(env, record.serverUrl);
  await identifyServer(target);
  let token = decryptString(env, record.encryptedAccessToken);
  let response = accessTokenExpiresSoon(token) ? undefined
    : await upstreamFetch(target, "/api/authorize", { method: "POST", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
  if (!response || response.status === 401) {
    await response?.body?.cancel();
    const refreshed = await upstreamFetch(target, "/auth/refresh", { method: "POST", headers: { "x-refresh-token": decryptString(env, record.encryptedRefreshToken) }, signal: AbortSignal.timeout(10_000) });
    if (!refreshed.ok) { await refreshed.body?.cancel(); throw new ConnectionError("audiobookshelf_login_expired", "Sign in to Audiobookshelf again.", 401); }
    const parsed = authSchema.safeParse(await readUpstreamJson(refreshed));
    if (!parsed.success || parsed.data.user.id !== record.audiobookshelfUserId) throw new ConnectionError("audiobookshelf_login_expired", "Sign in to Audiobookshelf again.", 401);
    const updated = new AudiobookshelfConnectionStore(env).replaceTokens(record, parsed.data.user.accessToken, parsed.data.user.refreshToken);
    if (!updated) { await logoutToken(target, parsed.data.user.refreshToken); throw notFound(); }
    record = updated;
    token = parsed.data.user.accessToken;
    response = await upstreamFetch(target, "/api/authorize", { method: "POST", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
  }
  if (!response.ok) { await response.body?.cancel(); throw new ConnectionError("audiobookshelf_login_expired", "Sign in to Audiobookshelf again.", 401); }
  const authorized = z.object({ user: z.object({ id: z.string() }) }).safeParse(await readUpstreamJson(response));
  if (!authorized.success || authorized.data.user.id !== record.audiobookshelfUserId) throw new ConnectionError("audiobookshelf_identity_changed", "The saved account is no longer available. Sign in again.", 409);
  const resolved = { ...publicConnection(record), accessToken: token, target };
  assertConnectionCurrent(env, record.discordUserId, resolved, guildId);
  return resolved;
}

/** An expiry hint only: every returned token is still authenticated by ABS.
 * Refresh ahead of the native gateway's 30-second account-check cache so an
 * otherwise healthy audio session does not fail at the token expiry boundary. */
function accessTokenExpiresSoon(token: string): boolean {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) && payload.exp * 1000 <= Date.now() + 60_000;
  } catch { return false; }
}

export async function disconnectConnection(env: AppEnv, discordUserId: string, connectionId: string): Promise<{ ok: true; upstreamRevoked: boolean }> {
  const record = new AudiobookshelfConnectionStore(env).remove(discordUserId, connectionId);
  if (!record) throw notFound();
  let upstreamRevoked = false;
  try {
    const target = await validateUpstream(env, record.serverUrl);
    await identifyServer(target);
    upstreamRevoked = await logoutToken(target, decryptString(env, record.encryptedRefreshToken));
  } catch { /* Local capabilities are already revoked if the server is unavailable. */ }
  return { ok: true, upstreamRevoked };
}

export function suggestedServerUrl(env: AppEnv): string {
  return normalizeUpstreamUrl(env.AUDIOBOOKSHELF_PUBLIC_SERVER_URL || env.AUDIOBOOKSHELF_DEFAULT_SERVER_URL);
}
function notFound(): ConnectionError { return new ConnectionError("connection_not_found", "This saved connection was not found.", 404); }
