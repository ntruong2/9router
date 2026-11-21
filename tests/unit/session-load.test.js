import { beforeEach, describe, expect, it } from "vitest";
import {
  createSessionLoadState,
  getConnectionLoad,
  reserveConnectionLoad,
  releaseConnectionLoad,
  recordConnectionOutcome,
  snapshotSessionLoad,
  selectLeastLoadedConnections,
} from "@/shared/services/sessionLoad.js";

describe("session load balancing", () => {
  let state;

  beforeEach(() => { state = createSessionLoadState(); });

  it("selects accounts with the lowest active load", () => {
    reserveConnectionLoad(state, "a", { maxConcurrent: 2, now: 100 });
    reserveConnectionLoad(state, "a", { maxConcurrent: 2, now: 100 });
    reserveConnectionLoad(state, "b", { maxConcurrent: 2, now: 100 });

    expect(selectLeastLoadedConnections(state, ["a", "b", "c"], { now: 100 }))
      .toEqual(["c"]);
  });

  it("reports capacity exhaustion and releases reservations", () => {
    const first = reserveConnectionLoad(state, "a", { maxConcurrent: 1, now: 100 });
    expect(reserveConnectionLoad(state, "a", { maxConcurrent: 1, now: 100 })).toBeNull();
    expect(getConnectionLoad(state, "a", 100)).toMatchObject({ activeRequests: 1, overloaded: true });
    releaseConnectionLoad(state, first.id, 200);
    expect(getConnectionLoad(state, "a", 200)).toMatchObject({ activeRequests: 0, overloaded: false });
  });

  it("tracks latency and recent errors without making one error permanent", () => {
    recordConnectionOutcome(state, "a", { latencyMs: 1000, error: true, now: 100 });
    recordConnectionOutcome(state, "a", { latencyMs: 200, error: false, now: 200 });
    expect(getConnectionLoad(state, "a", 200)).toMatchObject({ ewmaLatencyMs: 600, recentErrors: 1 });
    expect(getConnectionLoad(state, "a", 70_201).recentErrors).toBe(0);
  });

  it("exposes quality signals in the load snapshot", () => {
    recordConnectionOutcome(state, "a", { latencyMs: 800, error: true, now: 100 });
    expect(snapshotSessionLoad(state, [{ id: "a", provider: "codex" }], { codex: 2 }, 100)).toEqual([
      expect.objectContaining({
        connectionId: "a",
        ewmaLatencyMs: 800,
        recentErrors: 1,
        maxConcurrent: 2,
      }),
    ]);
  });
});
