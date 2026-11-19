import { randomBytes } from "node:crypto";
import { normalizeNativeRoute, type DiscordContext } from "@app/shared";
import type { FastifyInstance } from "fastify";
import type { AppEnv } from "../env.js";
import { renewActivityMembership } from "./appSession.js";
import { sessionStore, type AppSession } from "./sessionStore.js";
import { assertConnectionCurrent, onConnectionsRevoked, resolveConnection } from "./audiobookshelfConnections.js";
import { readUpstreamJson, upstreamFetch } from "./upstreamPolicy.js";
import { ActivityPlaybackCoordinator } from "./activityPlayback.js";

export type NativeConnection = Awaited<ReturnType<typeof resolveConnection>>;
export type NativeParty = {
  id: string;
  context: DiscordContext;
  instanceId: string;
  guildId?: string;
  channelId?: string;
  serverId: string;
  serverUrl: string;
  groupId: string;
  viewers: Set<string>;
  currentPlaylistItemId?: string;
  queueItemIds: string[];
  emptySince: number;
};
export type NativeIdentity = { connection: NativeConnection; deviceId: string };
export type NativeViewer = NativeIdentity & {
  capability: string;
  partyId: string;
  appSessionId: string;
  discordUserId: string;
  clientDeviceId: string;
  expiresAt: number;
  lastSeen: number;
  sockets: number;
  joined: boolean;
  revoked: boolean;
  aborters: Set<() => void>;
  lastSocketClose: number;
  itemAccess: Map<string, { until: number; sources: Set<string> }>;
  socketOpening: boolean;
  socketCleanup?: Promise<void>;
  playbackSessions: Map<string, { itemId: string; episodeId?: string }>;
  tokenCheckedAt: number;
};
export type NativePartyDependencies = {
  resolve: typeof resolveConnection;
  fetch: typeof upstreamFetch;
  membership: typeof renewActivityMembership;
  current: typeof assertConnectionCurrent;
};
type DisconnectedParty = { sessionId: string; discordUserId: string; connection: NativeConnection; at: number };
type NavigationCheckpoint = { sessionId: string; discordUserId: string; capability: string; route: string; until: number; sequence: number };
// Keep the native queue while a renderer/popout reconnects. Socket loss still
// detaches the viewer immediately; membership/session expiry still fail closed.
const EMPTY_GRACE_MS = 120_000;
const LAUNCH_GRACE_MS = 120_000;
const ITEM_CHECK_CONCURRENCY = 8;
const services = new WeakMap<object, NativePartyService>();

export class NativeError extends Error {
  constructor(readonly code: string, readonly statusCode = 403) { super(code); }
}

/** Real Audiobookshelf credentials never leave the backend. */
export function nativeAuthorization(identity: NativeIdentity): string {
  return `Bearer ${identity.connection.accessToken}`;
}

export function publicNativeParty(party: NativeParty | undefined) {
  if (!party) return null;
  return {
    id: party.id, instanceId: party.instanceId,
    ...(party.guildId ? { guildId: party.guildId } : {}),
    ...(party.channelId ? { channelId: party.channelId } : {}),
    serverId: party.serverId, serverUrl: party.serverUrl, groupId: party.groupId
  };
}

export function getNativePartyService(app: FastifyInstance): NativePartyService {
  let service = services.get(app.server);
  if (!service) {
    service = new NativePartyService(app.envConfig);
    services.set(app.server, service);
    const created = service;
    app.addHook("onClose", async () => { await created.close(); services.delete(app.server); });
  }
  return service;
}

/** Bind native library credentials and viewer lifecycle to the Activity playback coordinator. */
export class NativePartyService {
  readonly playback = new ActivityPlaybackCoordinator(this);
  private readonly itemChecks = new WeakMap<NativeViewer, Map<string, Promise<{ until: number; sources: Set<string> }>>>();
  private readonly tokenChecks = new WeakMap<NativeViewer, Promise<void>>();
  readonly parties = new Map<string, NativeParty>();
  readonly viewers = new Map<string, NativeViewer>();
  private readonly bindings = new Map<string, string>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly disconnected = new Map<string, Map<string, DisconnectedParty>>();
  private readonly navigation = new Map<string, Map<string, NavigationCheckpoint>>();
  private readonly latestViewers = new Map<string, Map<string, { capability: string; sessionId: string; discordUserId: string }>>();
  private readonly disconnectWaiters = new Map<string, Set<() => void>>();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeConnections: () => void;
  private readonly timer: ReturnType<typeof setInterval>;
  private sweeping = false;
  private closed = false;
  readonly dependencies: NativePartyDependencies;

  constructor(readonly env: AppEnv, dependencies?: Partial<NativePartyDependencies>) {
    this.dependencies = { resolve: resolveConnection, fetch: upstreamFetch, membership: renewActivityMembership, current: assertConnectionCurrent, ...dependencies };
    this.unsubscribe = sessionStore.onRevoke((id) => { void this.revokeSession(id); });
    this.unsubscribeConnections = onConnectionsRevoked(({ discordUserId, connectionId }) => { void this.revokeConnection(discordUserId, connectionId); });
    this.timer = setInterval(() => { void this.sweep(); }, 5_000);
    this.timer.unref();
  }

  private key(session: AppSession): string {
    const c = session.discordContext;
    if (!c) throw new NativeError("activity_context_required");
    return JSON.stringify([c.guildId ?? "", c.channelId ?? "", c.instanceId]);
  }

  private lockKey(session: AppSession): string {
    const c = session.discordContext;
    if (!c) throw new NativeError("activity_context_required");
    // Cross-instance popout handoff and ordinary bind/launch must serialize.
    return JSON.stringify([c.guildId ?? "", c.channelId ?? "", c.channelId ? "" : c.instanceId]);
  }

  private actorConnection(userId: string, connectionId: string): string { return JSON.stringify([userId, connectionId]); }

  private async waitForRendererExit(session: AppSession, connection: NativeConnection): Promise<void> {
    const context = session.discordContext!;
    if (!context.guildId || !context.channelId) return;
    const candidates = [...this.parties.values()].filter((party) => {
      const viewers = [...party.viewers].map((cap) => this.viewers.get(cap)).filter((viewer): viewer is NativeViewer => !!viewer && !viewer.revoked);
      return party.instanceId !== context.instanceId && party.guildId === context.guildId && party.channelId === context.channelId
        && party.serverId === connection.serverId && party.serverUrl === connection.serverUrl
        && viewers.length > 0 && viewers.every((viewer) => viewer.discordUserId === session.discordUserId
          && viewer.connection.id === connection.id && viewer.connection.audiobookshelfUserId === connection.audiobookshelfUserId)
        && viewers.some((viewer) => viewer.sockets > 0 || viewer.socketOpening);
    });
    if (candidates.length !== 1) return;
    const party = candidates[0]!;
    await new Promise<void>((resolve) => {
      const waiters = this.disconnectWaiters.get(party.id) ?? new Set<() => void>();
      const finish = () => {
        clearTimeout(timer);
        waiters.delete(changed);
        if (!waiters.size) this.disconnectWaiters.delete(party.id);
        resolve();
      };
      const changed = () => {
        if (!this.parties.has(party.id) || [...party.viewers].every((cap) => {
          const viewer = this.viewers.get(cap);
          return !viewer || viewer.revoked || (!viewer.sockets && !viewer.socketOpening);
        })) finish();
      };
      // The renderer can be created just before Discord closes the old socket.
      // Wait briefly for its normal close; never disconnect an active player.
      const timer = setTimeout(finish, 1_500);
      waiters.add(changed);
      this.disconnectWaiters.set(party.id, waiters);
      changed();
    });
  }

  private notifyDisconnect(partyId: string): void {
    for (const notify of this.disconnectWaiters.get(partyId) ?? []) notify();
  }

  /** Explicit sign-out must not leave an otherwise reusable renderer checkpoint. */
  forgetRestoration(sessionId: string, userId: string): void {
    for (const [partyId, latest] of this.latestViewers) {
      for (const [key, value] of latest) {
        if (value.sessionId === sessionId && value.discordUserId === userId) {
          this.navigation.get(partyId)?.delete(key);
          this.disconnected.get(partyId)?.delete(key);
        }
      }
    }
    for (const records of [...this.navigation.values(), ...this.disconnected.values()]) {
      for (const [key, value] of records) {
        if (value.sessionId === sessionId && value.discordUserId === userId) records.delete(key);
      }
    }
  }

  private async restoreParty(session: AppSession, connection: NativeConnection): Promise<NativeParty | undefined> {
    const context = session.discordContext!;
    if (!context.guildId || !context.channelId) return undefined;
    const actorKey = this.actorConnection(session.discordUserId, connection.id);
    const candidates = [...this.parties.values()].filter((party) => {
      const prior = this.disconnected.get(party.id)?.get(actorKey);
      return party.instanceId !== context.instanceId && party.guildId === context.guildId && party.channelId === context.channelId
        && party.serverId === connection.serverId && party.serverUrl === connection.serverUrl
        && prior && Date.now() - prior.at <= EMPTY_GRACE_MS
        && prior.connection.audiobookshelfUserId === connection.audiobookshelfUserId
        && [...party.viewers].every((cap) => {
          const viewer = this.viewers.get(cap);
          return !viewer || viewer.revoked || (!viewer.sockets && !viewer.socketOpening && viewer.lastSocketClose > 0);
        });
    });
    // Never guess between multiple previous parties, or take an active group.
    if (candidates.length !== 1) return undefined;
    const party = candidates[0]!;
    const prior = this.disconnected.get(party.id)!.get(actorKey)!;
    this.dependencies.current(this.env, session.discordUserId, prior.connection, context.guildId);
    // Mark every old capability revoked before yielding during cleanup.
    // A second idle renderer cannot open a socket during the first cleanup.
    await Promise.all([...party.viewers].map((cap) => this.viewers.get(cap))
      .filter((viewer): viewer is NativeViewer => !!viewer).map((viewer) => this.revoke(viewer)));
    this.dependencies.current(this.env, session.discordUserId, connection, context.guildId);
    if (this.closed || !sessionStore.getSession(session.id) || this.parties.get(party.id) !== party
      || this.disconnected.get(party.id)?.get(actorKey) !== prior || Date.now() - prior.at > EMPTY_GRACE_MS) {
      throw new NativeError("native_session_expired", 401);
    }
    for (const [key, id] of this.bindings) if (id === party.id) this.bindings.delete(key);
    party.context = context;
    party.instanceId = context.instanceId;
    party.emptySince = Date.now() + LAUNCH_GRACE_MS;
    this.bindings.set(this.key(session), party.id);
    this.disconnected.delete(party.id);
    const routes = this.navigation.get(party.id);
    if (routes) for (const key of routes.keys()) if (key !== actorKey) routes.delete(key);
    return party;
  }

  get(session: AppSession): NativeParty | undefined {
    const id = this.bindings.get(this.key(session));
    return id ? this.parties.get(id) : undefined;
  }

  getPartyForChannel(guildId: string, channelId: string): NativeParty | undefined {
    return [...this.parties.values()].find((party) => party.guildId === guildId && party.channelId === channelId);
  }

  getViewerForDiscordUser(partyId: string, userId: string): NativeViewer | undefined {
    return [...this.viewers.values()].find((viewer) => viewer.partyId === partyId && viewer.discordUserId === userId
      && viewer.sockets > 0 && viewer.joined && this.active(viewer));
  }

  async bind(session: AppSession, connectionId: string): Promise<NativeParty> {
    const key = this.key(session);
    return this.serial(this.lockKey(session), async () => {
      await this.verifySession(session);
      const connection = await this.dependencies.resolve(this.env, session.discordUserId, connectionId, session.discordContext?.guildId);
      this.dependencies.current(this.env, session.discordUserId, connection, session.discordContext?.guildId);
      const existing = this.get(session);
      if (existing) {
        if (existing.serverUrl === connection.serverUrl && existing.serverId === connection.serverId) return existing;
        // A joining account cannot replace the server for everyone in the
        // verified Discord instance. A different server needs a new Activity.
        throw new NativeError("party_server_mismatch", 409);
      }
      if (!existing) {
        await this.waitForRendererExit(session, connection);
        await this.verifySession(session);
        this.dependencies.current(this.env, session.discordUserId, connection, session.discordContext?.guildId);
        const restored = await this.restoreParty(session, connection);
        if (restored) return restored;
      }
      if (!sessionStore.getSession(session.id) || this.closed) throw new NativeError("native_session_expired", 401);
      this.dependencies.current(this.env, session.discordUserId, connection, session.discordContext?.guildId);
      if (!sessionStore.getSession(session.id) || this.closed) throw new NativeError("native_session_expired", 401);
      const context = session.discordContext!;
      const party: NativeParty = {
        id: randomBytes(16).toString("hex"), context, instanceId: context.instanceId,
        ...(context.guildId ? { guildId: context.guildId } : {}),
        ...(context.channelId ? { channelId: context.channelId } : {}),
        serverId: connection.serverId, serverUrl: connection.serverUrl, groupId: randomBytes(16).toString("hex"),
        viewers: new Set(), emptySince: Date.now() + LAUNCH_GRACE_MS, queueItemIds: []
      };
      this.parties.set(party.id, party);
      this.bindings.set(key, party.id);
      return party;
    });
  }

  async launch(session: AppSession, connectionId: string, clientDeviceId: string) {
    // Binding changes and launches for every viewer share the same party lock.
    return this.serial(this.lockKey(session), async () => {
      await this.verifySession(session);
      const party = this.get(session);
      if (!party) throw new NativeError("party_not_bound", 409);
      const connection = await this.dependencies.resolve(this.env, session.discordUserId, connectionId, session.discordContext?.guildId);
      this.dependencies.current(this.env, session.discordUserId, connection, session.discordContext?.guildId);
      if (party.serverId !== connection.serverId || party.serverUrl !== connection.serverUrl) throw new NativeError("party_server_mismatch", 409);
      const replaced = [...this.viewers.values()].filter((viewer) => viewer.partyId === party.id
        && ((viewer.appSessionId === session.id && viewer.clientDeviceId === clientDeviceId)
          || (viewer.discordUserId === session.discordUserId && viewer.connection.id === connectionId
            && !viewer.sockets && !viewer.socketOpening && viewer.lastSocketClose > 0)));
      if (party.viewers.size - replaced.length >= this.env.ROOM_MAX_PARTICIPANTS) throw new NativeError("party_full", 409);
      for (const viewer of replaced) await this.revoke(viewer);
      if (this.get(session)?.id !== party.id || !sessionStore.getSession(session.id)) throw new NativeError("party_binding_changed", 409);
      this.dependencies.current(this.env, session.discordUserId, connection, session.discordContext?.guildId);
      const capability = randomBytes(32).toString("base64url");
      const deviceId = `activity-viewer-${randomBytes(16).toString("hex")}`;
      const viewer: NativeViewer = {
        connection, deviceId, capability, partyId: party.id, appSessionId: session.id,
        discordUserId: session.discordUserId, clientDeviceId, expiresAt: session.expiresAt.getTime(),
        lastSeen: Date.now(), sockets: 0, joined: false, revoked: false, aborters: new Set(), lastSocketClose: 0, itemAccess: new Map(), socketOpening: false, playbackSessions: new Map(), tokenCheckedAt: Date.now()
      };
      this.viewers.set(capability, viewer);
      party.viewers.add(capability);
      party.emptySince = 0;
      const actorKey = this.actorConnection(session.discordUserId, connectionId);
      const latest = this.latestViewers.get(party.id) ?? new Map();
      latest.set(actorKey, { capability, sessionId: session.id, discordUserId: session.discordUserId });
      this.latestViewers.set(party.id, latest);
      const checkpoint = this.navigation.get(party.id)?.get(actorKey);
      const restoreRoute = checkpoint && checkpoint.until > Date.now() ? checkpoint.route : null;
      if (checkpoint && restoreRoute) {
        checkpoint.sessionId = session.id;
        checkpoint.capability = capability;
        checkpoint.sequence = 0;
      }
      return { baseUrl: `/abs/${capability}`, accessToken: capability, userId: connection.audiobookshelfUserId,
        serverId: connection.serverId, deviceId, groupId: party.groupId, restoreRoute };
    });
  }

  async navigationCheckpoint(session: AppSession, connectionId: string, update?: { route: string; sequence: number }): Promise<string | null> {
    return this.serial(this.lockKey(session), async () => {
      await this.verifySession(session);
      const party = this.get(session);
      if (!party) throw new NativeError("party_not_bound", 409);
      const viewers = [...party.viewers].map((cap) => this.viewers.get(cap)).filter((viewer): viewer is NativeViewer =>
        !!viewer && viewer.appSessionId === session.id && viewer.discordUserId === session.discordUserId
        && viewer.connection.id === connectionId && this.active(viewer));
      if (viewers.length !== 1) throw new NativeError("native_player_not_connected", 409);
      const viewer = viewers[0]!;
      this.dependencies.current(this.env, session.discordUserId, viewer.connection, session.discordContext?.guildId);
      const key = this.actorConnection(session.discordUserId, connectionId);
      if (this.latestViewers.get(party.id)?.get(key)?.capability !== viewer.capability) throw new NativeError("native_renderer_replaced", 409);
      const records = this.navigation.get(party.id) ?? new Map<string, NavigationCheckpoint>();
      const previous = records.get(key);
      if (update) {
        const route = normalizeNativeRoute(update.route, party.serverId);
        if (!route || !Number.isSafeInteger(update.sequence) || update.sequence < 1) throw new NativeError("invalid_native_route", 400);
        if (!previous || previous.capability !== viewer.capability || update.sequence > previous.sequence) {
          records.set(key, { sessionId: session.id, discordUserId: session.discordUserId, capability: viewer.capability,
            route, until: Date.now() + EMPTY_GRACE_MS, sequence: update.sequence });
          this.navigation.set(party.id, records);
        }
      }
      const checkpoint = records.get(key);
      return checkpoint && checkpoint.until > Date.now() ? checkpoint.route : null;
    });
  }

  async authorize(capability: string, touch = true): Promise<NativeViewer> {
    const viewer = this.viewers.get(capability);
    if (!viewer || !this.active(viewer)) throw new NativeError("native_session_expired", 401);
    const session = sessionStore.getSession(viewer.appSessionId)!;
    try { await this.dependencies.membership(this.env, session); }
    catch { await this.revoke(viewer); throw new NativeError("native_session_expired", 401); }
    if (!this.active(viewer)) throw new NativeError("native_session_expired", 401);
    if (Date.now() - viewer.tokenCheckedAt >= 30_000) {
      let check = this.tokenChecks.get(viewer);
      if (!check) {
        check = (async () => {
          const current = await this.dependencies.resolve(this.env, viewer.discordUserId, viewer.connection.id, session.discordContext?.guildId);
          this.dependencies.current(this.env, viewer.discordUserId, current, session.discordContext?.guildId);
          if (!this.active(viewer) || current.audiobookshelfUserId !== viewer.connection.audiobookshelfUserId
            || current.serverUrl !== viewer.connection.serverUrl) throw new NativeError("native_session_expired", 401);
          viewer.connection = current;
          viewer.tokenCheckedAt = Date.now();
        })().finally(() => { this.tokenChecks.delete(viewer); });
        this.tokenChecks.set(viewer, check);
      }
      try { await check; } catch { await this.revoke(viewer); throw new NativeError("native_session_expired", 401); }
    }
    if (touch) viewer.lastSeen = Date.now();
    return viewer;
  }

  active(viewer: NativeViewer): boolean {
    return !viewer.revoked && viewer.expiresAt > Date.now() && !!sessionStore.getSession(viewer.appSessionId)
      && this.parties.get(viewer.partyId)?.viewers.has(viewer.capability) === true;
  }

  async verifySession(session: AppSession): Promise<void> {
    if (!sessionStore.getSession(session.id)) throw new NativeError("native_session_expired", 401);
    await this.dependencies.membership(this.env, session);
    if (!sessionStore.getSession(session.id)) throw new NativeError("native_session_expired", 401);
  }

  /** Abort sockets and transfers synchronously without disrupting the shared timeline. */
  async revoke(viewer: NativeViewer): Promise<void> {
    if (viewer.revoked) return;
    viewer.revoked = true;
    this.viewers.delete(viewer.capability);
    const party = this.parties.get(viewer.partyId);
    party?.viewers.delete(viewer.capability);
    this.notifyDisconnect(viewer.partyId);
    if (party && !party.viewers.size) party.emptySince = Date.now();
    for (const abort of [...viewer.aborters]) abort();
    viewer.aborters.clear();
    this.playback.forgetViewer(viewer);
    // Native sessions/transcodes belong to this viewer even for a shared account.
    const sessions = [...viewer.playbackSessions.keys()];
    viewer.playbackSessions.clear();
    await Promise.allSettled(sessions.map((id) => this.json(viewer, "POST", `/api/session/${id}/close`, {})));
    viewer.joined = false;
  }

  async revokeSession(sessionId: string): Promise<void> {
    await Promise.all([...this.viewers.values()].filter((v) => v.appSessionId === sessionId).map((v) => this.revoke(v)));
  }

  async revokeConnection(discordUserId: string, connectionId: string): Promise<void> {
    const key = this.actorConnection(discordUserId, connectionId);
    for (const records of [...this.navigation.values(), ...this.disconnected.values()]) records.delete(key);
    const viewers = [...this.viewers.values()].filter((v) => v.discordUserId === discordUserId && v.connection.id === connectionId);
    await Promise.all(viewers.map((v) => this.revoke(v)));
  }

  async socketDisconnected(viewer: NativeViewer): Promise<void> {
    viewer.sockets = Math.max(0, viewer.sockets - 1);
    if (viewer.sockets || viewer.revoked) return;
    // A disconnected viewer never pauses the party timeline.
    viewer.lastSeen = Date.now();
    viewer.lastSocketClose = Date.now();
    const actorKey = this.actorConnection(viewer.discordUserId, viewer.connection.id);
    if (this.latestViewers.get(viewer.partyId)?.get(actorKey)?.capability === viewer.capability) {
      const records = this.disconnected.get(viewer.partyId) ?? new Map<string, DisconnectedParty>();
      records.set(actorKey, { sessionId: viewer.appSessionId, discordUserId: viewer.discordUserId,
        connection: viewer.connection, at: viewer.lastSocketClose });
      this.disconnected.set(viewer.partyId, records);
    }
    this.notifyDisconnect(viewer.partyId);
    viewer.joined = false;
  }

  async json(identity: NativeIdentity, method: string, path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.dependencies.fetch(identity.connection.target, path, {
        method, headers: { Authorization: nativeAuthorization(identity), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000)
      });
    } catch { throw new NativeError("audiobookshelf_unavailable", 502); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new NativeError("audiobookshelf_request_failed", response.status === 401 ? 401 : 502);
    }
    if (response.status === 204 || response.headers.get("content-length") === "0") return null;
    try { return await readUpstreamJson(response, 16 * 1024 * 1024); }
    catch { throw new NativeError("audiobookshelf_invalid_response", 502); }
  }

  async execute(viewer: NativeViewer, method: string, path: string, body?: unknown): Promise<unknown> {
    await this.authorize(viewer.capability);
    return this.json(viewer, method, path, body);
  }

  async requireItem(viewer: NativeViewer, itemId: string, mediaSourceId?: string): Promise<void> {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(itemId)) throw new NativeError("native_item_denied");
    let access = viewer.itemAccess.get(itemId);
    if (!access || access.until < Date.now()) {
      let checks = this.itemChecks.get(viewer);
      if (!checks) { checks = new Map(); this.itemChecks.set(viewer, checks); }
      let pending = checks.get(itemId);
      if (!pending) {
        const ownChecks = checks;
        pending = (async () => {
          try {
            let item: { id?: string; media?: { tracks?: Array<{ ino?: string }> } };
            try {
              item = await this.json(viewer, "GET", `/api/items/${itemId}?expanded=1`) as typeof item;
            } catch { throw new NativeError("native_item_denied"); }
            if (!item?.id || item.id !== itemId) throw new NativeError("native_item_denied");
            const verified = { until: Date.now() + 30_000, sources: new Set([item.id, ...(item.media?.tracks ?? []).flatMap((source) => source.ino ? [String(source.ino)] : [])]) };
            if (viewer.itemAccess.size >= 500) viewer.itemAccess.clear();
            viewer.itemAccess.set(itemId, verified);
            return verified;
          } finally { ownChecks.delete(itemId); }
        })();
        checks.set(itemId, pending);
      }
      access = await pending;
    }
    if (mediaSourceId && !access.sources.has(mediaSourceId)) throw new NativeError("native_media_source_denied");
  }

  async requirePartyItems(viewer: NativeViewer, itemIds: string[]): Promise<void> {
    if (!itemIds.length) throw new NativeError("native_queue_empty", 400);
    if (itemIds.length > 500) throw new NativeError("native_queue_too_large", 400);
    const party = this.parties.get(viewer.partyId);
    if (!party) throw new NativeError("native_session_expired", 401);
    const members = [...party.viewers].map((cap) => this.viewers.get(cap)).filter((v): v is NativeViewer => !!v && this.active(v));
    // Validate before committing the shared queue, so a denied member cannot
    // be silently dropped from a party when another participant selects media.
    await this.checkItems(members, itemIds);
  }

  async requireViewerItems(viewer: NativeViewer, itemIds: string[]): Promise<void> {
    if (itemIds.length > 500) throw new NativeError("native_queue_too_large", 400);
    await this.checkItems([viewer], itemIds);
  }

  private async checkItems(members: NativeViewer[], itemIds: string[]): Promise<void> {
    const ids = [...new Set(itemIds)];
    const total = ids.length * members.length;
    let cursor = 0;
    let failure: unknown;
    await Promise.all(Array.from({ length: Math.min(ITEM_CHECK_CONCURRENCY, total) }, async () => {
      while (!failure && cursor < total) {
        const index = cursor++;
        try { await this.requireItem(members[index % members.length]!, ids[Math.floor(index / members.length)]!); }
        catch (error) { failure ??= error; }
      }
    }));
    if (failure) throw failure;
  }

  async command(viewer: NativeViewer, action: "pause" | "play" | "seek" | "next" | "previous" | "stop" | "queue" | "select" | "search" | "now", payload?: { query?: string; seconds?: number; itemIds?: string[] }): Promise<unknown> {
    await this.authorize(viewer.capability);
    const party = this.parties.get(viewer.partyId)!;
    if (!viewer.joined || !viewer.sockets) throw new NativeError("native_player_not_connected", 409);
    if (action === "search") {
      const response = await this.json(viewer, "GET", "/api/libraries") as { libraries?: Array<{ id: string }> };
      const books: unknown[] = [];
      for (const library of (response.libraries ?? []).slice(0, 50)) {
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(library.id)) continue;
        const query = new URLSearchParams({ q: payload?.query ?? "", limit: "20" });
        const result = await this.json(viewer, "GET", `/api/libraries/${library.id}/search?${query}`) as { book?: Array<{ libraryItem?: unknown }> };
        books.push(...(result.book ?? []).flatMap((entry) => entry.libraryItem ? [entry.libraryItem] : []));
        if (books.length >= 25) break;
      }
      return { items: books.slice(0, 25) };
    }
    if (action === "now") {
      const { snapshot } = await this.playback.get(viewer);
      const itemId = snapshot.queue[snapshot.index]?.itemId;
      const item = itemId ? await this.json(viewer, "GET", `/api/items/${itemId}`) as { media?: { metadata?: { title?: string } } } : undefined;
      return { itemId, title: item?.media?.metadata?.title, positionSeconds: snapshot.positionTicks / 10_000_000,
        isPaused: snapshot.paused, playbackRate: snapshot.playbackRate, groupId: party.groupId };
    }
    if (action === "seek") {
      if (!Number.isFinite(payload?.seconds) || payload!.seconds! < 0) throw new NativeError("invalid_position", 400);
      return this.playback.control(viewer, (snapshot) => ({ type: "seek", positionTicks: Math.round(payload!.seconds! * 10_000_000), paused: snapshot.paused }));
    }
    if (action === "queue" || action === "select") {
      const ids = payload?.itemIds ?? [];
      if (!ids.length) throw new NativeError("native_queue_empty", 400);
      const queue = ids.map((itemId) => ({ id: randomBytes(16).toString("hex"), itemId }));
      return this.playback.control(viewer, () => action === "queue" ? { type: "enqueue", queue }
        : { type: "setQueue", queue, index: 0, positionTicks: 0, paused: false });
    }
    if (action === "next" || action === "previous") {
      return this.playback.control(viewer, (snapshot) => {
        const entry = snapshot.queue[snapshot.index + (action === "next" ? 1 : -1)];
        if (!entry) throw new NativeError("no_playing_item", 409);
        return { type: "select", queueItemId: entry.id, positionTicks: 0, paused: false };
      });
    }
    return this.playback.control(viewer, () => action === "stop" ? { type: "stop" } : { type: "setPlayback", paused: action === "pause" });
  }

  async sweep(): Promise<void> {
    if (this.sweeping || this.closed) return;
    this.sweeping = true;
    try {
      for (const records of this.navigation.values()) {
        for (const [key, checkpoint] of records) if (checkpoint.until <= Date.now()) records.delete(key);
      }
      for (const records of this.disconnected.values()) {
        for (const [key, checkpoint] of records) if (Date.now() - checkpoint.at > EMPTY_GRACE_MS) records.delete(key);
      }
      await Promise.all([...this.viewers.values()].map(async (viewer) => {
        if (!this.active(viewer) || (!viewer.sockets && ((viewer.lastSocketClose && Date.now() - viewer.lastSocketClose > EMPTY_GRACE_MS)
          || Date.now() - viewer.lastSeen > LAUNCH_GRACE_MS))) await this.revoke(viewer);
        else { try { await this.authorize(viewer.capability, false); } catch { await this.revoke(viewer); } }
      }));
      for (const party of [...this.parties.values()]) {
        if (!party.viewers.size && party.emptySince && Date.now() - party.emptySince > EMPTY_GRACE_MS) await this.destroyParty(party);

      }
    } finally { this.sweeping = false; }
  }

  async destroyParty(party: NativeParty): Promise<void> {
    this.parties.delete(party.id);
    this.disconnected.delete(party.id);
    this.navigation.delete(party.id);
    this.latestViewers.delete(party.id);
    this.notifyDisconnect(party.id);
    for (const [key, id] of this.bindings) if (id === party.id) this.bindings.delete(key);
    await Promise.all([...party.viewers].map((cap) => this.viewers.get(cap)).filter((v): v is NativeViewer => !!v).map((v) => this.revoke(v)));
    this.playback.destroy(party.id);
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    this.unsubscribe();
    this.unsubscribeConnections();
    await Promise.all([...this.parties.values()].map((party) => this.destroyParty(party)));
  }

  private async serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(key);
    const next = (previous?.catch(() => undefined) ?? Promise.resolve()).then(work);
    this.pending.set(key, next);
    try { return await next; }
    finally { if (this.pending.get(key) === next) this.pending.delete(key); }
  }
}
