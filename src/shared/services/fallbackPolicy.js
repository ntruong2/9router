import { getPricingForModel } from "open-sse/providers/pricing.js";
import { PROVIDERS } from "open-sse/providers/index.js";

const INCLUDED_OAUTH_PROVIDERS = new Set(["codex", "claude", "antigravity", "gemini-cli", "kiro"]);

function includesValue(values, value) {
  return Array.isArray(values) && values.some((entry) => String(entry).toLowerCase() === String(value).toLowerCase());
}

export function isPaidProvider(provider, model, connection) {
  if (connection?.id === "noauth" || PROVIDERS[provider]?.noAuth === true) return false;
  if (connection?.authType === "oauth" && INCLUDED_OAUTH_PROVIDERS.has(provider)) return false;
  const pricing = getPricingForModel(provider, model);
  if (!pricing) return true;
  return Object.values(pricing).some((value) => Number(value) > 0);
}

export function getPaidFallbackDecision({ settings = {}, provider, model, comboName = null, isFallback = false, connection } = {}) {
  if (!isFallback || settings.paidFallback?.enabled !== true || !isPaidProvider(provider, model, connection)) {
    return { allowed: true, reason: "allowed" };
  }
  const policy = settings.paidFallback || {};
  if (includesValue(policy.providers, provider) || includesValue(policy.combos, comboName)) {
    return { allowed: true, reason: "explicitly-allowed" };
  }
  return {
    allowed: false,
    reason: "paid-fallback-disabled",
    provider,
    model,
    comboName,
    message: `Paid fallback to ${provider}/${model} is disabled by Smart Quota policy`,
  };
}
