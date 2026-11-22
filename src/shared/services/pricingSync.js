import { makeKv } from "@/lib/db/helpers/kvStore.js";

const autoPricingKv = makeKv("pricingAuto");
const AUTO_PRICING_META_KEY = "_meta";
export const OPENAI_PRICING_URL = "https://openai.com/api/pricing/";
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

function numberFrom(value) {
  const number = Number.parseFloat(String(value || "").replace(/,/g, ""));
  return Number.isFinite(number) ? number : null;
}

function roundRate(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function parseOpenAiPricingHtml(html, modelNames = ["gpt-6.2-sol", "gpt-6.2-astra"]) {
  const result = {};
  for (const model of modelNames) {
    const modelLabel = model.split(/[-_. ]+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[-_. ]+");
    const block = String(html).match(new RegExp(`.{0,500}${modelLabel}.{0,1400}`, "is"))?.[0] || "";
    const input = block.match(/Input:\\n?\s*\$([\d.]+)/i)?.[1];
    const cached = block.match(/Cached input:\\n?\s*\$([\d.]+)/i)?.[1];
    const output = block.match(/Output:\\n?\s*\$([\d.]+)/i)?.[1];
    const values = { input: numberFrom(input), cached: numberFrom(cached), output: numberFrom(output) };
    if (Object.values(values).every((value) => value !== null)) {
      result[model] = { ...values, reasoning: values.output, cache_creation: values.input, source: "openai", syncedAt: new Date().toISOString() };
    }
  }
  return result;
}

export async function syncOpenAiPricing(fetchImpl = fetch) {
  const response = await fetchImpl(OPENAI_PRICING_URL, { headers: { Accept: "text/html" } });
  if (!response.ok) throw new Error(`OpenAI pricing returned HTTP ${response.status}`);
  const parsed = parseOpenAiPricingHtml(await response.text());
  if (!Object.keys(parsed).length) throw new Error("OpenAI pricing page had no recognized prices");
  await autoPricingKv.set("openai", parsed);
  await autoPricingKv.set("codex", parsed);
  await updateAutomaticPricingMeta("openai", Object.keys(parsed).length);
  await updateAutomaticPricingMeta("codex", Object.keys(parsed).length);
  return parsed;
}

export function parseOpenRouterModels(body) {
  const models = Array.isArray(body?.data) ? body.data : [];
  const syncedAt = new Date().toISOString();
  return Object.fromEntries(models.flatMap((model) => {
    const pricing = model?.pricing || {};
    const input = numberFrom(pricing.prompt) * 1_000_000;
    const output = numberFrom(pricing.completion) * 1_000_000;
    const cached = numberFrom(pricing.input_cache_read ?? pricing.cache_read ?? pricing.prompt) * 1_000_000;
    if (![input, output, cached].every(Number.isFinite)) return [];
    return [[model.id, { input: roundRate(input), output: roundRate(output), cached: roundRate(cached), reasoning: roundRate(output), cache_creation: roundRate(input), source: "openrouter", syncedAt }]];
  }));
}

export async function syncOpenRouterPricing(fetchImpl = fetch) {
  const response = await fetchImpl(OPENROUTER_MODELS_URL, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`OpenRouter models returned HTTP ${response.status}`);
  const parsed = parseOpenRouterModels(await response.json());
  if (!Object.keys(parsed).length) throw new Error("OpenRouter returned no model prices");
  await autoPricingKv.set("openrouter", parsed);
  await updateAutomaticPricingMeta("openrouter", Object.keys(parsed).length);
  return parsed;
}

async function updateAutomaticPricingMeta(provider, modelCount) {
  const current = await autoPricingKv.get(AUTO_PRICING_META_KEY, {});
  await autoPricingKv.set(AUTO_PRICING_META_KEY, {
    ...current,
    [provider]: {
      syncedAt: new Date().toISOString(),
      modelCount,
    },
  });
}

export async function getAutomaticPricingMeta() {
  return autoPricingKv.get(AUTO_PRICING_META_KEY, {});
}
