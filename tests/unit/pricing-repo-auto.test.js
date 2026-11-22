// Automatically synced (OpenRouter) pricing is external data: negative sentinel rates must never
// surface as model prices, even when they were stored before the sync started filtering them.
import { describe, expect, it, vi } from "vitest";

const kv = vi.hoisted(() => ({
  pricing: {},
  pricingAuto: {
    openrouter: { "openai/gpt-6.2-sol": { input: 2, output: 10, cached: 0.1 } },
    typesafe: { "jev-router": { input: -1000000, output: -1000000, cached: -1000000 } },
    _meta: { openrouter: { syncedAt: "2026-11-22T00:00:00.000Z", modelCount: 1 } },
  },
}));

vi.mock("../../src/lib/db/driver.js", () => ({ getAdapter: async () => ({}) }));
vi.mock("../../src/lib/db/helpers/kvStore.js", () => ({
  makeKv: (scope) => ({
    getAll: async () => kv[scope] || {},
    get: async (key, fallback = null) => kv[scope]?.[key] ?? fallback,
    set: async () => {},
  }),
}));

const { getPricingForModel } = await import("../../src/lib/db/repos/pricingRepo.js");

describe("pricingRepo automatic pricing", () => {
  it("ignores stored negative rates from the OpenRouter sentinel", async () => {
    expect(await getPricingForModel("typesafe", "jev-router")).toBeFalsy();
  });

  it("still serves valid synced rates", async () => {
    expect(await getPricingForModel("codex", "gpt-6.2-sol")).toMatchObject({ input: 2, output: 10 });
  });
});
