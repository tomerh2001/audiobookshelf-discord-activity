import { describe, expect, it } from "vitest";
import { redactUrl } from "../logger.js";

describe("logger redaction", () => {
  it("redacts sensitive query parameters", () => {
    expect(redactUrl("/api/connections/oidc/callback?state=private-state&code=private-code")).toBe("/api/connections/oidc/callback?state=%5Bredacted%5D&code=%5Bredacted%5D");
    expect(redactUrl("/ws?token=secret-token&instanceId=room-1")).toBe("/ws?token=%5Bredacted%5D&instanceId=room-1");
    expect(redactUrl("/api/discord/callback?code=oauth-code")).toBe("/api/discord/callback?code=%5Bredacted%5D");
  });
  it("redacts media bearer tickets and Audiobookshelf credentials", () => {
    expect(redactUrl("/media/hls/secret/master.m3u8?api_key=audiobookshelf")).toBe("/media/hls/[redacted]/master.m3u8?api_key=%5Bredacted%5D");
    expect(redactUrl("/media/direct/secret/stream.mp4")).toBe("/media/direct/[redacted]/stream.mp4");
    expect(redactUrl("/abs/viewer-secret/Videos/movie/master.m3u8?api_key=opaque&startTimeTicks=0"))
      .toBe("/abs/[redacted]/Videos/movie/master.m3u8?api_key=%5Bredacted%5D&startTimeTicks=0");
    expect(redactUrl("/abs/viewer-secret/socket?api_key=opaque"))
      .toBe("/abs/[redacted]/socket?api_key=%5Bredacted%5D");
  });
});
