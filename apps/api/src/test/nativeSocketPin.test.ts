import { createServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { afterEach, describe, expect, it } from "vitest";
import { prepareNativeSocket } from "../services/nativeGateway.js";
import type { NativeViewer } from "../services/nativeParty.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("Socket.IO upstream DNS pin", () => {
  it("connects to the validated address even when the original hostname cannot resolve", async () => {
    const http = createServer();
    const io = new SocketIOServer(http, { transports: ["websocket"] });
    let receivedHost: string | undefined;
    let receivedToken: unknown;
    io.on("connection", socket => {
      receivedHost = socket.handshake.headers.host;
      socket.on("auth", token => { receivedToken = token; socket.emit("init", { userId: "reader" }); });
    });
    await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>(resolve => io.close(() => resolve())));
    const address = http.address(); if (!address || typeof address === "string") throw new Error("fixture_failed");
    const hostname = "abs-dns-must-not-resolve.invalid";
    const serverUrl = `http://${hostname}:${address.port}`;
    const viewer: NativeViewer = {
      connection: { id: "connection", serverUrl, serverId: "fixture", serverName: "Fixture", audiobookshelfUserId: "reader", audiobookshelfUsername: "reader",
        kind: "personal", createdAt: "2026-11-19", updatedAt: "2026-11-19", accessToken: "private-abs-token",
        target: { serverUrl, hostname, address: "127.0.0.1", family: 4, operatorApproved: true } },
      deviceId: "fixture-device", capability: "fixture-capability", partyId: "fixture-party", appSessionId: "fixture-app", discordUserId: "discord-reader",
      clientDeviceId: "fixture-client", expiresAt: Date.now() + 60_000, lastSeen: Date.now(), sockets: 0, joined: false, revoked: false,
      aborters: new Set(), lastSocketClose: 0, itemAccess: new Map(), socketOpening: true, playbackSessions: new Map(), tokenCheckedAt: Date.now()
    };
    const prepared = await prepareNativeSocket(viewer);
    cleanups.push(() => { prepared.socket.disconnect(); });
    expect(prepared.socket.connected).toBe(true);
    expect(receivedHost).toBe(`${hostname}:${address.port}`);
    expect(receivedToken).toBe("private-abs-token");
    prepared.socket.disconnect();
    expect(viewer.aborters.size).toBe(0);
  }, 20_000);
});
