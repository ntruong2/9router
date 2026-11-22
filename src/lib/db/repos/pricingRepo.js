import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";

const pricingKv = makeKv("pricing");
const pricingAutoKv = makeKv("pricingAuto");
const CACHE_TTL_MS = 5000;

let cache = { value: null, expiresAt: 0 };

function withOpenRouterAliases(automaticPricing) {
  const openRouter = automaticPricing.openrouter || {};
  if (!Object.keys(openRouter).length) return automaticPricing;

  const namespaceMap = { openai: ["openai", "codex"], anthropic: ["anthropic", "claude"], google: ["google", "gemini"] };
  const aliases = {};
  for (const [modelId, pricing] of Object.entries(openRouter)) {
    const separator = modelId.indexOf("/");
    if (separator <= 0 || modelId.includes(":")) continue;
    const namespace = modelId.slice(0, separator);
    if (namespace === "openrouter" || namespace === "_meta") continue;
    const model = modelId.slice(separator + 1);
    for (const provider of namespaceMap[namespace] || [namespace]) {
      (aliases[provider] ||= {})[model] = { ...pricing, source: "openrouter-alias" };
    }
  }
  return Object.fromEntries(Object.entries(aliases).map(([provider, models]) => [
    provider,
    { ...models, ...(automaticPricing[provider] || {}) },
  ]).concat(Object.entries(automaticPricing).filter(([provider]) => !aliases[provider])));
}

function invalidate() {
  cache = { value: null, expiresAt: 0 };
}

async function getUserPricing() {
  return await pricingKv.getAll();
}

export async function getPricing() {
  const now = Date.now();
  if (cache.value && cache.expiresAt > now) return cache.value;

  const userPricing = await getUserPricing();
  const automaticPricing = withOpenRouterAliases(await pricingAutoKv.getAll());
  const { PROVIDER_PRICING } = await import("open-sse/providers/pricing.js");
  const merged = {};

  for (const [provider, models] of Object.entries(PROVIDER_PRICING)) {
    merged[provider] = { ...(automaticPricing[provider] || {}), ...models };
    if (userPricing[provider]) {
      for (const [model, pricing] of Object.entries(userPricing[provider])) {
        merged[provider][model] = merged[provider][model]
          ? { ...merged[provider][model], ...pricing }
          : pricing;
      }
    }
  }

  for (const [provider, models] of Object.entries(userPricing)) {
    if (!merged[provider]) {
      merged[provider] = { ...(automaticPricing[provider] || {}), ...models };
    } else {
      for (const [model, pricing] of Object.entries(models)) {
        if (!merged[provider][model]) merged[provider][model] = pricing;
      }
    }
  }

  // Include automatically synced providers that are not part of the built-in catalog.
  for (const [provider, models] of Object.entries(automaticPricing)) {
    if (provider === "_meta") continue;
    if (!merged[provider]) merged[provider] = { ...models };
  }

  cache = { value: merged, expiresAt: now + CACHE_TTL_MS };
  return merged;
}

export async function getPricingForModel(provider, model) {
  if (!model) return null;
  const userPricing = await getUserPricing();
  if (provider && userPricing[provider]?.[model]) return userPricing[provider][model];
  const automaticPricing = withOpenRouterAliases(await pricingAutoKv.getAll());
  if (provider && automaticPricing[provider]?.[model]) return automaticPricing[provider][model];
  const openRouterModel = provider ? `${provider}/${model}` : model;
  if (automaticPricing.openrouter?.[openRouterModel]) return automaticPricing.openrouter[openRouterModel];
  const { getPricingForModel: resolveConst } = await import("open-sse/providers/pricing.js");
  return resolveConst(provider, model);
}

// Atomic merge inside transaction (per-provider read-modify-write)
export async function updatePricing(pricingData) {
  const db = await getAdapter();
  db.transaction(() => {
    for (const [provider, models] of Object.entries(pricingData)) {
      const row = db.get(`SELECT value FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
      const current = row ? (parseJson(row.value, {}) || {}) : {};
      const merged = { ...current };
      for (const [model, pricing] of Object.entries(models)) {
        merged[model] = pricing;
      }
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [provider, stringifyJson(merged)]
      );
    }
  });
  invalidate();
  return await getUserPricing();
}

export async function resetPricing(provider, model) {
  if (!provider) return await getUserPricing();
  const db = await getAdapter();
  db.transaction(() => {
    if (!model) {
      db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
      return;
    }
    const row = db.get(`SELECT value FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
    const current = row ? (parseJson(row.value, {}) || {}) : {};
    delete current[model];
    if (Object.keys(current).length === 0) {
      db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
    } else {
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [provider, stringifyJson(current)]
      );
    }
  });
  invalidate();
  return await getUserPricing();
}

export async function resetAllPricing() {
  await pricingKv.clear();
  invalidate();
  return {};
}
