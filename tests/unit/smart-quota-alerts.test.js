import { describe, expect, it } from "vitest";
import { buildQuotaAlerts, dedupeQuotaAlerts } from "@/shared/services/smartQuotaAlerts.js";

describe("smart quota alerts", () => {
  it("alerts when a bucket crosses depleted and when it resets", () => {
    const previous = { quotas: [{ key: "session", remainingPercentage: 4, resetAt: "2026-11-21T12:00:00Z" }] };
    const depleted = { quotas: [{ key: "session", remainingPercentage: 0, resetAt: "2026-11-21T12:00:00Z" }] };
    const reset = { quotas: [{ key: "session", remainingPercentage: 90, resetAt: "2026-11-21T17:00:00Z" }] };
    expect(buildQuotaAlerts(previous, depleted, null, Date.parse("2026-11-21T10:00:00Z"))).toEqual([
      expect.objectContaining({ type: "depleted", key: "session" }),
    ]);
    expect(buildQuotaAlerts(depleted, reset, null, Date.parse("2026-11-21T13:00:00Z"))).toEqual([
      expect.objectContaining({ type: "reset", key: "session" }),
    ]);
  });

  it("deduplicates the same alert within its cooldown window", () => {
    const alert = { type: "depleted", key: "session", at: "2026-11-21T10:00:00Z" };
    const state = new Map();
    expect(dedupeQuotaAlerts([alert], state, Date.parse("2026-11-21T10:01:00Z"))).toHaveLength(1);
    expect(dedupeQuotaAlerts([alert], state, Date.parse("2026-11-21T10:02:00Z"))).toHaveLength(0);
    expect(dedupeQuotaAlerts([alert], state, Date.parse("2026-11-21T16:01:00Z"))).toHaveLength(1);
  });
});
