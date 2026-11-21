import { describe, expect, it, vi } from "vitest";
import {
  runSmartQuotaRefreshTick,
  createSmartQuotaRefreshState,
} from "@/shared/services/smartQuotaRefresh.js";

function connection(id, fetchedAt = null) {
  return {
    id,
    provider: "codex",
    authType: "oauth",
    isActive: true,
    smartQuotaSnapshot: fetchedAt ? { fetchedAt, quotas: [{ key: "session", remainingPercentage: 80 }] } : null,
  };
}

describe("smart quota background refresh", () => {
  it("refreshes only stale active connections and respects concurrency", async () => {
    const started = [];
    let active = 0;
    let peak = 0;
    const deps = {
      now: () => Date.parse("2026-11-21T10:00:00Z"),
      getSettings: vi.fn().mockResolvedValue({ smartQuotaBackgroundRefresh: true, smartQuotaRefreshConcurrency: 2 }),
      getProviderConnections: vi.fn().mockResolvedValue([
        connection("stale"),
        connection("fresh", "2026-11-21T09:55:00Z"),
        { ...connection("inactive"), isActive: false },
      ]),
      readConnectionQuota: vi.fn(async (conn) => {
        started.push(conn.id);
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return new Response(JSON.stringify({ quotas: {} }), { headers: { "x-9router-quota-fetched-at": new Date(deps.now()).toISOString() } });
      }),
    };

    const result = await runSmartQuotaRefreshTick(deps, createSmartQuotaRefreshState());

    expect(result.refreshed).toBe(1);
    expect(started).toEqual(["stale"]);
    expect(peak).toBe(1);
  });

  it("backs off a failed connection without blocking other accounts", async () => {
    const state = createSmartQuotaRefreshState();
    const deps = {
      now: () => Date.parse("2026-11-21T10:00:00Z"),
      getSettings: vi.fn().mockResolvedValue({ smartQuotaBackgroundRefresh: true, smartQuotaRefreshConcurrency: 2, smartQuotaRefreshJitterMs: 0 }),
      getProviderConnections: vi.fn().mockResolvedValue([connection("bad"), connection("good")]),
      readConnectionQuota: vi.fn(async (conn) => {
        if (conn.id === "bad") throw new Error("upstream down");
        return new Response("{}", { status: 200, headers: { "x-9router-quota-fetched-at": new Date(deps.now()).toISOString() } });
      }),
    };

    const result = await runSmartQuotaRefreshTick(deps, state);

    expect(result.failed).toBe(1);
    expect(result.refreshed).toBe(1);
    expect(state.backoff.get("bad").attempts).toBe(1);
    expect(state.backoff.get("bad").nextAt).toBeGreaterThan(deps.now());
  });

  it("collapses concurrent ticks into one run", async () => {
    let resolveRead;
    const read = vi.fn(() => new Promise((resolve) => { resolveRead = resolve; }));
    const deps = {
      now: () => Date.parse("2026-11-21T10:00:00Z"),
      getSettings: vi.fn().mockResolvedValue({ smartQuotaBackgroundRefresh: true, smartQuotaRefreshConcurrency: 1 }),
      getProviderConnections: vi.fn().mockResolvedValue([connection("one")]),
      readConnectionQuota: read,
    };
    const state = createSmartQuotaRefreshState();
    const first = runSmartQuotaRefreshTick(deps, state);
    await Promise.resolve();
    await Promise.resolve();
    const second = runSmartQuotaRefreshTick(deps, state);
    expect((await second).skipped).toBe(true);
    resolveRead(new Response("{}", { headers: { "x-9router-quota-fetched-at": new Date(deps.now()).toISOString() } }));
    await first;
    expect(read).toHaveBeenCalledTimes(1);
  });
});
