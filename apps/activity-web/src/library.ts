/** Loaded once as a classic script by the native Audiobookshelf document. No UI mount. */
import { startActivitySession } from "./discord/session.js";
export { startActivitySession, resumeActivitySession, clearActivitySession, StartupTimeout } from "./discord/session.js";
export { logout } from "./api/client.js";
export {
  getConnections, getParty, joinParty, launchNative, matchesPartyServer,
  savePreference, connectAccount, connectCommunity, deleteConnection,
  startOidcLogin, pollOidcLogin, saveNativeRestore
} from "./api/native.js";
export { normalizeNativeRoute } from "@app/shared";
export { onSessionRejected } from "./api/sessionRecovery.js";
export { closeDiscordActivity, getConnectedParticipants } from "./discord/sdk.js";
export { observeActivityPresentation } from "./discord/presentation.js";
export { observeActivityParticipants } from "./discord/participants.js";
export { createWatchPresence } from "./discord/richPresence.js";

export type { ActivitySession } from "./discord/session.js";
export type { ActivityDiscordContext } from "./discord/sdk.js";
export type { ActivityParticipant, ActivityParticipantsSnapshot } from "./discord/participants.js";
export type { ActivityLayout, ActivityPresentation } from "./discord/presentation.js";
export type { Connection, Connections, Party, NativeLaunch, OidcLogin } from "./api/native.js";

declare global {
  interface Window { AudiobookshelfWatch: typeof import("./library.js"); }
}

// Begin the existing, deduplicated handshake while the browser downloads and
// initializes native Audiobookshelf. No account/party action depends on this preload;
// the native controller still awaits verified authentication before proceeding.
// A later native start shares this operation (or retries a failed preload), so
// no promise rejection escapes before the native error dialog is available.
if (new URLSearchParams(window.location.search).has("frame_id")) {
  void startActivitySession().catch(() => {});
}
