import { describe, expect, it } from "vitest";
import { parseOpenAiPricingHtml, parseOpenRouterModels } from "@/shared/services/pricingSync.js";

describe("automatic pricing sync", () => {
  it("parses OpenAI pricing cards", () => {
    const html = "GPT-6.2 Sol Input:\\n$2.00 / 1M tokens\\n\\nCached input:\\n$0.10 / 1M tokens\\n\\nOutput:\\n$10.00 / 1M tokens";
    expect(parseOpenAiPricingHtml(html, ["gpt-6.2-sol"])["gpt-6.2-sol"]).toMatchObject({ input: 2, cached: 0.1, output: 10 });
  });

  it("converts OpenRouter per-token prices to per-million rates", () => {
    const pricing = parseOpenRouterModels({ data: [{ id: "openai/gpt-6.2-sol", pricing: { prompt: "0.000002", completion: "0.00001", input_cache_read: "0.0000001" } }] });
    expect(pricing["openai/gpt-6.2-sol"]).toMatchObject({ input: 2, output: 10, cached: 0.1, source: "openrouter" });
  });
});
