// Speed statistics from usage history rows that carry latency (meta.ttftMs / meta.totalMs).
// Pure functions: the repo loads rows, the API returns the summary, the dashboard renders it.

export const SPEED_CONTEXT_BUCKETS = [
  { key: "<32K", max: 32_000 },
  { key: "32K-128K", max: 128_000 },
  { key: "128K-200K", max: 200_000 },
  { key: ">200K", max: Infinity },
];

// Thresholds for the "smoothness" label, on time to first token (what the user waits for).
export const SPEED_RATING_THRESHOLDS = {
  smooth: { p50: 3000, p90: 8000 },
  normal: { p50: 8000 },
};

const MIN_GENERATION_MS = 200;
const MIN_OUTPUT_TOKENS = 20;
const RECENT_LIMIT = 60;

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function rateSpeed(p50Ttft, p90Ttft) {
  if (p50Ttft === null) return "unknown";
  const { smooth, normal } = SPEED_RATING_THRESHOLDS;
  if (p50Ttft <= smooth.p50 && (p90Ttft === null || p90Ttft <= smooth.p90)) return "smooth";
  if (p50Ttft <= normal.p50) return "normal";
  return "slow";
}

export function contextBucket(inputTokens) {
  return SPEED_CONTEXT_BUCKETS.find(({ max }) => inputTokens < max)?.key || ">200K";
}

/** Normalize one usage history row into a speed sample, or null when it has no latency. */
export function toSpeedSample(row) {
  const meta = row?.meta && typeof row.meta === "object" ? row.meta : {};
  const totalMs = finite(meta.totalMs);
  if (totalMs === null) return null;
  const ttft = finite(meta.ttftMs);
  const ttftMs = ttft !== null && ttft <= totalMs ? ttft : null;
  const tokens = row.tokens && typeof row.tokens === "object" ? row.tokens : {};
  const inputTokens = finite(tokens.prompt_tokens ?? tokens.input_tokens ?? row.promptTokens) ?? 0;
  const outputTokens = finite(tokens.completion_tokens ?? tokens.output_tokens ?? row.completionTokens) ?? 0;
  const cachedTokens = finite(tokens.cached_tokens ?? tokens.cache_read_input_tokens) ?? 0;
  const generationMs = ttftMs !== null ? totalMs - ttftMs : null;
  const outputTps = generationMs !== null && generationMs >= MIN_GENERATION_MS && outputTokens >= MIN_OUTPUT_TOKENS
    ? (outputTokens / generationMs) * 1000
    : null;
  return {
    timestamp: row.timestamp,
    provider: row.provider || "unknown",
    model: row.model || "unknown",
    connectionId: row.connectionId || null,
    ttftMs,
    totalMs,
    inputTokens,
    outputTokens,
    cacheRatio: inputTokens > 0 ? Math.min(1, cachedTokens / inputTokens) : null,
    outputTps,
  };
}

function summarize(samples) {
  const ttfts = samples.map((s) => s.ttftMs).filter((v) => v !== null).sort((a, b) => a - b);
  const totals = samples.map((s) => s.totalMs).sort((a, b) => a - b);
  const tps = samples.map((s) => s.outputTps).filter((v) => v !== null).sort((a, b) => a - b);
  const inputs = samples.map((s) => s.inputTokens).sort((a, b) => a - b);
  const caches = samples.map((s) => s.cacheRatio).filter((v) => v !== null);
  const p50Ttft = percentile(ttfts, 50);
  const p90Ttft = percentile(ttfts, 90);
  return {
    requests: samples.length,
    streamed: ttfts.length,
    p50TtftMs: p50Ttft,
    p90TtftMs: p90Ttft,
    p50TotalMs: percentile(totals, 50),
    p90TotalMs: percentile(totals, 90),
    p50OutputTps: percentile(tps, 50),
    p50InputTokens: percentile(inputs, 50),
    avgCacheRatio: caches.length ? caches.reduce((a, b) => a + b, 0) / caches.length : null,
    rating: rateSpeed(p50Ttft, p90Ttft),
  };
}

function groupBy(samples, keyOf) {
  const groups = new Map();
  for (const sample of samples) {
    const key = keyOf(sample);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sample);
  }
  return groups;
}

/**
 * @param {Array} rows usage history rows ({ timestamp, provider, model, connectionId, tokens, meta })
 * @param {{ accountNames?: Record<string,string> }} options
 */
export function buildSpeedStats(rows, { accountNames = {} } = {}) {
  const samples = (Array.isArray(rows) ? rows : []).map(toSpeedSample).filter(Boolean)
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));

  const byModel = [...groupBy(samples, (s) => `${s.provider}/${s.model}`)].map(([key, list]) => {
    const [provider] = key.split("/");
    const byContext = SPEED_CONTEXT_BUCKETS
      .map(({ key: bucket }) => {
        const inBucket = list.filter((s) => contextBucket(s.inputTokens) === bucket);
        return inBucket.length ? { bucket, ...summarize(inBucket) } : null;
      })
      .filter(Boolean);
    return {
      key,
      provider,
      model: key.slice(provider.length + 1),
      ...summarize(list),
      byContext,
      recent: list.slice(-RECENT_LIMIT).map(({ timestamp, ttftMs, totalMs, inputTokens }) => ({ timestamp, ttftMs, totalMs, inputTokens })),
    };
  }).sort((a, b) => b.requests - a.requests);

  const byAccount = [...groupBy(samples.filter((s) => s.connectionId), (s) => s.connectionId)].map(([connectionId, list]) => ({
    connectionId,
    name: accountNames[connectionId] || connectionId.slice(0, 8),
    provider: list[0].provider,
    ...summarize(list),
  })).sort((a, b) => b.requests - a.requests);

  return { overall: summarize(samples), byModel, byAccount };
}
