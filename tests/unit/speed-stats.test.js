import { describe, expect, it } from "vitest";
import { buildSpeedStats, percentile, rateSpeed, toSpeedSample } from "../../src/shared/services/speedStats.js";

const row = (ttftMs, totalMs, input, extra = {}) => ({
  timestamp: extra.timestamp || "2026-11-23T06:00:00.000Z",
  provider: extra.provider || "codex",
  model: extra.model || "gpt-6.2-sol",
  connectionId: extra.connectionId || "conn-a",
  tokens: { prompt_tokens: input, completion_tokens: extra.out ?? 200, cached_tokens: extra.cached ?? 0 },
  meta: ttftMs === undefined ? { totalMs } : { ttftMs, totalMs },
});

describe("speed stats", () => {
  it("uses nearest-rank percentiles", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([], 50)).toBeNull();
  });

  it("rates by time to first token", () => {
    expect(rateSpeed(1500, 4000)).toBe("smooth");
    expect(rateSpeed(1500, 12000)).toBe("normal");
    expect(rateSpeed(6000, 9000)).toBe("normal");
    expect(rateSpeed(9000, 15000)).toBe("slow");
    expect(rateSpeed(null, null)).toBe("unknown");
  });

  it("ignores rows without latency and computes output speed after the first token", () => {
    expect(toSpeedSample({ tokens: {}, meta: {} })).toBeNull();
    const sample = toSpeedSample(row(1000, 3000, 1000, { out: 400 }));
    expect(sample.outputTps).toBe(200);
    // Non-streamed rows have a total but no TTFT
    expect(toSpeedSample(row(undefined, 3000, 1000)).ttftMs).toBeNull();
  });

  it("groups by model, context size and account", () => {
    const stats = buildSpeedStats([
      row(1000, 2000, 10_000, { cached: 5_000 }),
      row(1200, 2500, 20_000),
      row(9000, 9500, 250_000, { connectionId: "conn-b", timestamp: "2026-11-23T06:05:00.000Z" }),
      row(500, 900, 1_000, { provider: "claude", model: "opus", connectionId: "conn-c" }),
      { timestamp: "x", provider: "codex", model: "gpt-6.2-sol", tokens: {}, meta: {} },
    ], { accountNames: { "conn-a": "Account A" } });

    expect(stats.overall.requests).toBe(4);
    const codex = stats.byModel.find((m) => m.key === "codex/gpt-6.2-sol");
    expect(codex).toMatchObject({ provider: "codex", model: "gpt-6.2-sol", requests: 3, p50TtftMs: 1200 });
    expect(codex.byContext.map((b) => [b.bucket, b.requests])).toEqual([["<32K", 2], [">200K", 1]]);
    expect(codex.byContext.find((b) => b.bucket === ">200K").rating).toBe("slow");
    expect(codex.recent).toHaveLength(3);
    expect(stats.byAccount.find((a) => a.connectionId === "conn-a")).toMatchObject({ name: "Account A", requests: 2, rating: "smooth" });
    expect(stats.byAccount.find((a) => a.connectionId === "conn-b").name).toBe("conn-b");
  });
});
