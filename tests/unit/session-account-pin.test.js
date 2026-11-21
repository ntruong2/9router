import { beforeEach, describe, expect, it } from "vitest";
import {
  createSessionPinState,
  getPinnedConnectionId,
  pinConnection,
  clearSessionPin,
} from "@/shared/services/sessionAccountPin.js";

describe("session account pin", () => {
  let state;

  beforeEach(() => { state = createSessionPinState(); });

  it("returns the pinned account while it is still valid", () => {
    pinConnection(state, "codex", "session-a", "account-a", 1_000, 1_000);
    expect(getPinnedConnectionId(state, "codex", "session-a", 1_500)).toBe("account-a");
  });

  it("expires a pin and clears it after failover", () => {
    pinConnection(state, "codex", "session-a", "account-a", 1_000, 1_000);
    expect(getPinnedConnectionId(state, "codex", "session-a", 2_001)).toBeNull();
    pinConnection(state, "codex", "session-a", "account-b", 2_001);
    clearSessionPin(state, "codex", "session-a", "account-b");
    expect(getPinnedConnectionId(state, "codex", "session-a", 2_002)).toBeNull();
  });

  it("keeps provider sessions isolated", () => {
    pinConnection(state, "codex", "session-a", "account-a", 1_000);
    pinConnection(state, "claude", "session-a", "account-b", 1_000);
    expect(getPinnedConnectionId(state, "codex", "session-a", 1_001)).toBe("account-a");
    expect(getPinnedConnectionId(state, "claude", "session-a", 1_001)).toBe("account-b");
  });
});
