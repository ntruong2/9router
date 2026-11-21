import { describe, expect, it } from "vitest";
import { explainSmartQuotaDecision } from "@/shared/services/smartQuotaDecision.js";

describe("Smart Use dry-run", () => {
  it("explains the matching bucket and selected connection", () => {
    const result = explainSmartQuotaDecision({
      provider: "codex",
      model: "gpt-5.3-codex-spark",
      settings: { smartQuotaUse: true },
      connections: [
        { id: "a", provider: "codex", priority: 1, isActive: true, smartQuotaSnapshot: { fetchedAt: "2026-11-21T09:59:00Z", quotas: [{ key: "spark_session", remainingPercentage: 10 }] } },
        { id: "b", provider: "codex", priority: 2, isActive: true, smartQuotaSnapshot: { fetchedAt: "2026-11-21T09:59:00Z", quotas: [{ key: "spark_session", remainingPercentage: 80 }] } },
      ],
      now: Date.parse("2026-11-21T10:00:00Z"),
    });
    expect(result).toMatchObject({ selectedConnectionId: "b", matchedBucket: "spark_session", reason: "model-bucket" });
    expect(result.sideEffects).toBe(false);
  });

  it("reports a stale snapshot and falls back to priority", () => {
    const result = explainSmartQuotaDecision({
      provider: "codex", model: "gpt-5.3-codex", settings: { smartQuotaUse: true },
      connections: [{ id: "old", provider: "codex", priority: 1, isActive: true, smartQuotaSnapshot: { fetchedAt: "2026-11-21T08:00:00Z", quotas: [{ key: "session", remainingPercentage: 80 }] } }],
      now: Date.parse("2026-11-21T10:00:00Z"),
    });
    expect(result).toMatchObject({ selectedConnectionId: "old", reason: "priority", quotaStatus: "stale" });
  });
});
