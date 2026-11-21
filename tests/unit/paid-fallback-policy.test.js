import { describe, expect, it } from "vitest";
import { getPaidFallbackDecision, isPaidProvider } from "@/shared/services/fallbackPolicy.js";

describe("paid fallback policy", () => {
  it("treats known paid pricing as paid and free pricing as safe", () => {
    expect(isPaidProvider("openai", "gpt-5")).toBe(true);
    expect(isPaidProvider("cline-free", "cline-free/deepseek-v4.1-flash")).toBe(false);
  });

  it("denies an unapproved paid fallback with a reason", () => {
    const decision = getPaidFallbackDecision({
      settings: { paidFallback: { enabled: true } },
      provider: "openai",
      model: "gpt-5",
      comboName: "safe-combo",
      isFallback: true,
    });
    expect(decision).toMatchObject({ allowed: false, reason: "paid-fallback-disabled" });
  });

  it("allows an explicitly approved provider or combo", () => {
    expect(getPaidFallbackDecision({
      settings: { paidFallback: { enabled: true, providers: ["openai"] } },
      provider: "openai", model: "gpt-5", isFallback: true,
    }).allowed).toBe(true);
    expect(getPaidFallbackDecision({
      settings: { paidFallback: { enabled: true, combos: ["safe-combo"] } },
      provider: "openai", model: "gpt-5", comboName: "safe-combo", isFallback: true,
    }).allowed).toBe(true);
  });

  it("permits direct requests and treats unknown fallback pricing conservatively", () => {
    expect(getPaidFallbackDecision({ settings: { paidFallback: { enabled: true } }, provider: "unknown", model: "m", isFallback: false }).allowed).toBe(true);
    expect(getPaidFallbackDecision({ settings: { paidFallback: { enabled: true } }, provider: "unknown", model: "m", isFallback: true }).allowed).toBe(false);
  });
});
