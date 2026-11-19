import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AppEnv } from "../env.js";
import { ConnectionError, identifyServer, saveAuthentication, type ConnectionDto, type ServerIdentity } from "./audiobookshelfConnections.js";
import { renewActivityMembership } from "./appSession.js";
import { generateId } from "./crypto.js";
import { deniedDiscordActor } from "./discord.js";
import { sessionStore, type AppSession } from "./sessionStore.js";
import { normalizeUpstreamUrl, upstreamFetch, validateUpstream, type ValidatedUpstream } from "./upstreamPolicy.js";

export type OidcResult = { status: "pending" } | { status: "connected"; connection: ConnectionDto } | { status: "failed"; message: string };
type Attempt = { id: string; appSessionId: string; discordUserId: string; target: ValidatedUpstream; server: ServerIdentity;
  publicOrigin: string; expiresAt: number; ticket: string; state: string; verifier: string; nonceHash?: Buffer; cookieJar?: string;
  beginning?: boolean; completing?: boolean; result?: OidcResult };
const randomSecret = () => randomBytes(32).toString("base64url");
const digest = (value: string) => createHash("sha256").update(value).digest();
const matches = (value: string, expected: string) => timingSafeEqual(digest(value), digest(expected));

/** Native ABS mobile OIDC. ABS owns provider discovery, token exchange and account
 * mapping; the Activity never interprets an identity-provider token as ABS access.
 */
export class AudiobookshelfOidcManager {
  private readonly attempts = new Map<string, Attempt>();
  private readonly unsubscribe: () => void;
  constructor(private readonly env: AppEnv) {
    this.unsubscribe = sessionStore.onRevoke((id) => {
      for (const [key, attempt] of this.attempts) if (attempt.appSessionId === id) this.attempts.delete(key);
    });
  }
  dispose(): void { this.unsubscribe(); this.attempts.clear(); }

  async start(session: AppSession, serverUrl: string): Promise<{ id: string; url: string; expiresAt: string }> {
    this.prune();
    if (!this.env.AUDIOBOOKSHELF_OIDC_ENABLED) throw new ConnectionError("oidc_disabled", "Single sign-on is disabled for this Activity.", 403);
    this.requireSession(session);
    if (this.attempts.size >= 1000) throw new ConnectionError("oidc_busy", "Try signing in again shortly.", 429);
    const target = await validateUpstream(this.env, serverUrl);
    const server = await identifyServer(target);
    if (!server.authMethods.includes("openid")) throw new ConnectionError("oidc_unavailable", "Enable OpenID Connect in this Audiobookshelf server before using Authentik / SSO.", 409);
    this.requireSession(session);
    for (const [id, attempt] of this.attempts) if (attempt.appSessionId === session.id) this.attempts.delete(id);
    const publicUrl = target.operatorApproved && this.env.AUDIOBOOKSHELF_PUBLIC_SERVER_URL
      ? normalizeUpstreamUrl(this.env.AUDIOBOOKSHELF_PUBLIC_SERVER_URL) : target.serverUrl;
    if (this.env.NODE_ENV === "production" && !publicUrl.startsWith("https://")) {
      throw new ConnectionError("oidc_public_url_required", "Configure the public HTTPS Audiobookshelf URL for single sign-on.", 409);
    }
    const id = generateId();
    const attempt: Attempt = { id, appSessionId: session.id, discordUserId: session.discordUserId, target, server,
      publicOrigin: new URL(publicUrl).origin, ticket: randomSecret(), state: randomSecret(), verifier: randomSecret(),
      expiresAt: Math.min(Date.now() + 10 * 60_000, session.expiresAt.getTime()) };
    this.attempts.set(id, attempt);
    const url = new URL(`/api/connections/oidc/start/${id}`, this.env.PUBLIC_BASE_URL);
    url.searchParams.set("ticket", attempt.ticket);
    return { id, url: url.toString(), expiresAt: new Date(attempt.expiresAt).toISOString() };
  }

  async begin(id: string, ticket: string): Promise<{ url: string; cookie: string }> {
    this.prune();
    const attempt = this.attempts.get(id);
    if (!attempt || !attempt.ticket || !matches(ticket, attempt.ticket) || attempt.beginning) throw invalidAttempt();
    const session = this.current(attempt);
    attempt.beginning = true;
    attempt.ticket = ""; // External handoff URL is single use.
    const nonce = randomSecret();
    attempt.nonceHash = digest(nonce);
    const query = new URLSearchParams({ response_type: "code", redirect_uri: this.callbackUrl(), state: attempt.state,
      code_challenge: digest(attempt.verifier).toString("base64url"), code_challenge_method: "S256" });
    try {
      await renewActivityMembership(this.env, session);
      this.current(attempt);
      const target = await validateUpstream(this.env, attempt.target.serverUrl);
      const response = await upstreamFetch(target, `/auth/openid?${query}`, { signal: AbortSignal.timeout(15_000) },
        { allowOidcRedirect: true, includeCookies: true, oidcPublicOrigin: attempt.publicOrigin });
      const location = response.headers.get("location");
      const cookies = response.headers.getSetCookie();
      await response.body?.cancel();
      this.current(attempt);
      if (response.status !== 302 || !location || !cookies.length) throw invalidProvider();
      const destination = new URL(location);
      if (destination.protocol !== "https:" || destination.username || destination.password || destination.hash
        || destination.searchParams.get("state") !== attempt.state
        || destination.searchParams.get("code_challenge") !== query.get("code_challenge")
        || destination.searchParams.get("code_challenge_method") !== "S256") throw invalidProvider();
      attempt.cookieJar = privateCookies(cookies);
      return { url: destination.toString(), cookie: this.cookie(attempt.id, nonce, 600) };
    } catch (error) {
      attempt.result = { status: "failed", message: "Could not start single sign-on. Check the Audiobookshelf OIDC settings." };
      this.clearSecrets(attempt);
      throw error;
    }
  }

  async callback(state: string, code: string | undefined, browserCookies: string, providerError?: string): Promise<{ cookie: string }> {
    this.prune();
    const attempt = [...this.attempts.values()].find((item) => matches(state, item.state));
    if (!attempt || attempt.completing || attempt.result || !attempt.cookieJar || !attempt.nonceHash) throw invalidAttempt();
    const nonce = parseCookies(browserCookies).get(this.cookieName(attempt.id));
    if (!nonce || !timingSafeEqual(digest(nonce), attempt.nonceHash)) throw invalidAttempt();
    const session = this.current(attempt);
    attempt.completing = true;
    const cookie = this.cookie(attempt.id, "", 0);
    try {
      if (providerError || !code) throw new ConnectionError("oidc_cancelled", "Single sign-on was cancelled. Start again from Discord.", 400);
      await renewActivityMembership(this.env, session);
      this.current(attempt);
      const target = await validateUpstream(this.env, attempt.target.serverUrl);
      await identifyServer(target);
      this.current(attempt);
      const query = new URLSearchParams({ code, state, code_verifier: attempt.verifier });
      const response = await upstreamFetch(target, `/auth/openid/callback?${query}`, {
        headers: { Cookie: attempt.cookieJar }, signal: AbortSignal.timeout(20_000)
      }, { oidcPublicOrigin: attempt.publicOrigin });
      const connection = await saveAuthentication(this.env, session, target, attempt.server, response, "personal", () => { this.current(attempt); });
      attempt.result = { status: "connected", connection };
      return { cookie };
    } catch {
      attempt.result = { status: "failed", message: "Single sign-on did not complete. Return to Discord and start again." };
      throw new ConnectionError("oidc_failed", attempt.result.message, 400);
    } finally { this.clearSecrets(attempt); }
  }

  poll(session: AppSession, id: string): OidcResult {
    this.prune();
    this.requireSession(session);
    const attempt = this.attempts.get(id);
    if (!attempt || attempt.appSessionId !== session.id || attempt.discordUserId !== session.discordUserId) throw invalidAttempt();
    return attempt.result ?? { status: "pending" };
  }

  private callbackUrl(): string { return new URL("/api/connections/oidc/callback", this.env.PUBLIC_BASE_URL).toString(); }
  private cookieName(id: string): string { return `abs_oidc_${id}`; }
  private cookie(id: string, value: string, maxAge: number): string {
    const secure = new URL(this.env.PUBLIC_BASE_URL).protocol === "https:" ? "; Secure" : "";
    return `${this.cookieName(id)}=${value}; HttpOnly; SameSite=Lax; Path=/api/connections/oidc; Max-Age=${maxAge}${secure}`;
  }
  private requireSession(session: AppSession): void {
    if (!sessionStore.getSession(session.id) || deniedDiscordActor(this.env, session.discordUserId)) throw invalidAttempt();
  }
  private current(attempt: Attempt): AppSession {
    const session = sessionStore.getSession(attempt.appSessionId);
    if (this.attempts.get(attempt.id) !== attempt || attempt.expiresAt <= Date.now() || !session
      || deniedDiscordActor(this.env, attempt.discordUserId)) throw invalidAttempt();
    return session;
  }
  private clearSecrets(attempt: Attempt): void { attempt.ticket = ""; attempt.verifier = ""; delete attempt.cookieJar; delete attempt.nonceHash; }
  private prune(): void {
    for (const [id, attempt] of this.attempts) if (attempt.expiresAt <= Date.now() || !sessionStore.getSession(attempt.appSessionId)) this.attempts.delete(id);
  }
}

function privateCookies(headers: string[]): string {
  if (headers.length > 20) throw invalidProvider();
  const pairs = headers.map((value) => value.split(";", 1)[0] ?? "");
  if (pairs.some((value) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+=[^\r\n;]*$/.test(value))) throw invalidProvider();
  const joined = pairs.join("; ");
  if (joined.length > 16_384) throw invalidProvider();
  return joined;
}
function parseCookies(header: string): Map<string, string> {
  return new Map(header.split(";").map((part) => { const at = part.indexOf("="); return [part.slice(0, at).trim(), part.slice(at + 1)]; }));
}
function invalidAttempt(): ConnectionError { return new ConnectionError("oidc_attempt_invalid", "This sign-in link expired or belongs to another session. Start again from Discord.", 404); }
function invalidProvider(): ConnectionError { return new ConnectionError("oidc_provider_invalid", "Audiobookshelf did not return a secure OIDC authorization request.", 502); }
