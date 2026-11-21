import { describe, expect, it } from "vitest";
import { deriveUsageInsights } from "@/shared/services/usageInsights.js";

describe("usage insights", () => {
  it("summarizes cache usage and top dimensions", () => {
    const result = deriveUsageInsights({
      totalRequests: 25,
      totalPromptTokens: 1000,
      totalCompletionTokens: 500,
      totalCachedTokens: 200,
      byProvider: { codex: { requests: 20 }, claude: { requests: 5 } },
      byModel: { "gpt (codex)": { rawModel: "gpt", requests: 20 } },
    });
    expect(result).toMatchObject({ totalTokens: 1500, cacheHitRate: 20, topProvider: { name: "codex" } });
  });
});
