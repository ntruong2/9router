import { describe, expect, it } from "vitest";
import { buildOpenAiAliases, buildProviderAliases, parseOpenAiPricingHtml, parseOpenRouterModels } from "@/shared/services/pricingSync.js";

describe("automatic pricing sync", () => {
  it("parses OpenAI pricing cards", () => {
    const html = "GPT-6.2 Sol Input:\\n$2.00 / 1M tokens\\n\\nCached input:\\n$0.10 / 1M tokens\\n\\nOutput:\\n$10.00 / 1M tokens";
    expect(parseOpenAiPricingHtml(html, ["gpt-6.2-sol"])["gpt-6.2-sol"]).toMatchObject({ input: 2, cached: 0.1, output: 10 });
  });

  it("converts OpenRouter per-token prices to per-million rates", () => {
    const pricing = parseOpenRouterModels({ data: [{ id: "openai/gpt-6.2-sol", pricing: { prompt: "0.000002", completion: "0.00001", input_cache_read: "0.0000001" } }] });
    expect(pricing["openai/gpt-6.2-sol"]).toMatchObject({ input: 2, output: 10, cached: 0.1, source: "openrouter" });
  });

  it("creates short OpenAI and Codex aliases for OpenRouter models", () => {
    const aliases = buildOpenAiAliases({
      "openai/gpt-6.2-sol": { input: 2, output: 10 },
      "openai/gpt-6.2-sol:batch": { input: 1, output: 5 },
    });
    expect(aliases["gpt-6.2-sol"]).toMatchObject({ input: 2, output: 10, source: "openrouter-alias" });
    expect(aliases["gpt-6.2-sol:batch"]).toBeUndefined();
  });

  it("maps provider namespaces to internal provider aliases", () => {
    const aliases = buildProviderAliases({
      "anthropic/claude-sonnet-5": { input: 2, output: 10 },
      "google/gemini-3.8-flash": { input: 1, output: 5 },
    });
    expect(aliases.claude["claude-sonnet-5"]).toMatchObject({ input: 2, output: 10 });
    expect(aliases.gemini["gemini-3.8-flash"]).toMatchObject({ input: 1, output: 5 });
  });
});
