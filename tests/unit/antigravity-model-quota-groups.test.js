import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn() }));
vi.mock("open-sse/services/usage/google.js", () => ({ getAntigravityUsage: vi.fn() }));

import { getAntigravityModelQuota } from "../../src/sse/services/antigravityQuota.js";

const quotas = {
  gemini_weekly: { remainingPercentage: 100, resetAt: "2026-11-05T11:01:06.000Z" },
  gemini_session: { remainingPercentage: 100, resetAt: "2026-10-29T16:01:06.000Z" },
  claude_gpt_weekly: { remainingPercentage: 0, resetAt: "2026-11-04T11:06:13.000Z" },
  claude_gpt_session: { remainingPercentage: 94.9, resetAt: "2026-10-29T15:38:57.000Z" },
  "group:gemini-4-argon:weekly": { remainingPercentage: 0, resetAt: "2026-11-04T09:06:47.000Z" },
};

describe("getAntigravityModelQuota — model groups", () => {
  it("blocks a model whose own group is spent", () => {
    const quota = getAntigravityModelQuota(quotas, "ag/gemini-4-argon-high");
    expect(quota.remainingPercentage).toBe(0);
    expect(quota.resetAt).toBe("2026-11-04T09:06:47.000Z");
  });

  it("does not apply a model group to other Gemini models", () => {
    expect(getAntigravityModelQuota(quotas, "gemini-3.8-flash-high").remainingPercentage).toBe(100);
  });

  it("still blocks a family until its spent weekly limit resets", () => {
    const quota = getAntigravityModelQuota(quotas, "claude-sonnet-5-5-high");
    expect(quota.remainingPercentage).toBe(0);
    expect(quota.resetAt).toBe("2026-11-04T11:06:13.000Z");
  });
});
