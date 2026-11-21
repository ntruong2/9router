import { describe, expect, it } from "vitest";
import {
  SMART_QUOTA_STALE_MS,
  appendQuotaHistory,
  forecastQuota,
  getConnectionQuotaHealth,
  getRecommendedConnection,
  matchQuotaRows,
  rankConnectionsByQuotaHealth,
} from "@/shared/services/smartQuota.js";

const NOW = new Date("2026-11-21T10:00:00.000Z").getTime();

function connection(id, quota, overrides = {}) {
  return {
    id,
    provider: "codex",
    priority: overrides.priority ?? 1,
    isActive: overrides.isActive ?? true,
    smartQuotaSnapshot: {
      fetchedAt: new Date(NOW - (overrides.ageMs ?? 60_000)).toISOString(),
      quotas: [quota],
    },
    ...overrides,
  };
}

describe("smart quota scoring", () => {
  it("prefers a fresh account with more remaining quota", () => {
    const ranked = rankConnectionsByQuotaHealth([
      connection("low", { remainingPercentage: 25 }, { priority: 1 }),
      connection("high", { remainingPercentage: 80 }, { priority: 2 }),
    ], NOW);

    expect(ranked.map((item) => item.connection.id)).toEqual(["high", "low"]);
    expect(getRecommendedConnection(ranked.map((item) => item.connection), NOW).id).toBe("high");
  });

  it("keeps exhausted and inactive accounts out of recommendations", () => {
    const exhausted = connection("empty", { remainingPercentage: 0, resetAt: "2026-11-21T12:00:00Z" });
    const inactive = connection("off", { remainingPercentage: 95 }, { isActive: false });
    expect(getConnectionQuotaHealth(exhausted, NOW).eligible).toBe(false);
    expect(getConnectionQuotaHealth(inactive, NOW).eligible).toBe(false);
    expect(getRecommendedConnection([exhausted, inactive], NOW)).toBeNull();
  });

  it("does not use snapshots older than the stale window", () => {
    const stale = connection("old", { remainingPercentage: 100 }, { ageMs: SMART_QUOTA_STALE_MS + 1 });
    const health = getConnectionQuotaHealth(stale, NOW);
    expect(health.stale).toBe(true);
    expect(health.eligible).toBe(false);
  });

  it("preserves priority order for equal scores", () => {
    const ranked = rankConnectionsByQuotaHealth([
      connection("second", { remainingPercentage: 50 }, { priority: 2 }),
      connection("first", { remainingPercentage: 50 }, { priority: 1 }),
    ], NOW);
    expect(ranked.map((item) => item.connection.id)).toEqual(["first", "second"]);
  });

  it("caps history and forecasts a decreasing matching bucket", () => {
    const history = appendQuotaHistory([], {
      fetchedAt: "2026-11-21T09:00:00.000Z",
      quotas: [{ key: "claude-opus", remainingPercentage: 80 }],
    });
    const next = appendQuotaHistory(history, {
      fetchedAt: "2026-11-21T10:00:00.000Z",
      quotas: [{ key: "claude-opus", remainingPercentage: 60 }],
    });
    expect(matchQuotaRows(next[1], "anthropic/claude-opus")).toHaveLength(1);
    expect(forecastQuota(next, "claude-opus", NOW)).toMatchObject({
      ratePerHour: 20,
      hoursUntilEmpty: 3,
    });
  });

  it("scores only the requested Codex pool and its windows", () => {
    const spark = (id, standard, short, weekly) => connection(id, {}, {
      smartQuotaSnapshot: {
        fetchedAt: "2026-11-21T09:59:00Z",
        quotas: [
          { key: "session", remainingPercentage: standard },
          { key: "spark_session", remainingPercentage: short },
          { key: "spark_weekly", remainingPercentage: weekly },
        ],
      },
    });
    const accounts = [spark("a", 0, 80, 75), spark("b", 90, 95, 5)];
    expect(getRecommendedConnection(accounts, NOW, "gpt-5.3-codex-spark")?.id).toBe("a");
    expect(getRecommendedConnection(accounts, NOW, "gpt-5.3-codex")?.id).toBe("b");
  });

  it("does not extrapolate depletion beyond a known reset", () => {
    const resetAt = "2026-11-21T11:00:00Z";
    const history = [80, 60].map((remainingPercentage, index) => ({
      fetchedAt: new Date(NOW - (1 - index) * 3_600_000).toISOString(),
      quotas: [{ key: "weekly", remainingPercentage, resetAt }],
    }));
    expect(forecastQuota(history, null, NOW)).toBeNull();
  });
});
