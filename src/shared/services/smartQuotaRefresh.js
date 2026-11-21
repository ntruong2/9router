import { getProviderConnections, getSettings } from "@/lib/localDb";
import { isLeaseConnection } from "open-sse/services/minimaxCodeLease.js";
import { USAGE_APIKEY_PROVIDERS, USAGE_SUPPORTED_PROVIDERS } from "@/shared/constants/providers";
import { readConnectionQuota } from "@/app/api/usage/[connectionId]/route.js";
import { SMART_QUOTA_FETCHED_AT_HEADER, SMART_QUOTA_STALE_MS } from "./smartQuota.js";

const DEFAULT_INTERVAL_MS = 8 * 60 * 1000;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_JITTER_MS = 15 * 1000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;

export function createSmartQuotaRefreshState() {
  return { running: false, interval: null, backoff: new Map(), lastAttempt: new Map() };
}

const globalState = globalThis[Symbol.for("9router.smartQuotaRefresh")] ||= createSmartQuotaRefreshState();

function isUsageEligible(connection) {
  return connection?.isActive !== false && USAGE_SUPPORTED_PROVIDERS.includes(connection.provider) && (
    connection.authType === "oauth" || connection.authType === "apikey" || connection.authType === "api_key" || isLeaseConnection(connection)
  ) && (connection.authType === "oauth" || isLeaseConnection(connection) || USAGE_APIKEY_PROVIDERS.includes(connection.provider));
}

function numberSetting(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function isFresh(connection, now, intervalMs) {
  const fetchedAt = Date.parse(connection.smartQuotaSnapshot?.fetchedAt);
  return fetchedAt <= now && now - fetchedAt < intervalMs &&
    !connection.smartQuotaSnapshot.quotas?.some((quota) => {
      const reset = Date.parse(quota.resetAt);
      return reset > fetchedAt && reset <= now;
    });
}

function backoffReady(state, id, now) {
  return !state.backoff.get(id) || state.backoff.get(id).nextAt <= now;
}

async function refreshOne(connection, read, state, jitterMs, now, random) {
  state.lastAttempt.set(connection.id, now);
  try {
    const response = await read(connection, false);
    const fetchedAt = Date.parse(response.headers.get(SMART_QUOTA_FETCHED_AT_HEADER));
    response.body?.cancel().catch(() => {});
    if (!response.ok || !Number.isFinite(fetchedAt) || fetchedAt > (Date.now() > now ? Date.now() : now) ||
        now - fetchedAt >= SMART_QUOTA_STALE_MS) throw new Error("Quota sample unavailable");
    state.backoff.delete(connection.id);
    return { refreshed: 1, failed: 0 };
  } catch {
    const previous = state.backoff.get(connection.id);
    const attempts = (previous?.attempts || 0) + 1;
    const base = Math.min(MAX_BACKOFF_MS, 30_000 * (2 ** Math.min(attempts - 1, 6)));
    const jitter = Math.floor(random() * jitterMs);
    state.backoff.set(connection.id, { attempts, nextAt: now + base + jitter });
    return { refreshed: 0, failed: 1 };
  }
}

export async function runSmartQuotaRefreshTick(deps = {}, state = globalState) {
  if (state.running) return { skipped: true, refreshed: 0, failed: 0 };
  state.running = true;
  try {
    const now = Number(deps.now?.() ?? Date.now());
    const settings = { ...(await (deps.getSettings || getSettings)()) };
    if (settings.smartQuotaBackgroundRefresh !== true) return { skipped: true, refreshed: 0, failed: 0 };
    const intervalMs = numberSetting(settings.smartQuotaRefreshIntervalMs, DEFAULT_INTERVAL_MS, 60_000, SMART_QUOTA_STALE_MS);
    const concurrency = Math.floor(numberSetting(settings.smartQuotaRefreshConcurrency, DEFAULT_CONCURRENCY, 1, 8));
    const jitterMs = numberSetting(settings.smartQuotaRefreshJitterMs, DEFAULT_JITTER_MS, 0, 60_000);
    const connections = await (deps.getProviderConnections || getProviderConnections)({ isActive: true });
    const ids = new Set(connections.map(({ id }) => id));
    for (const id of state.lastAttempt.keys()) {
      if (ids.has(id)) continue;
      state.lastAttempt.delete(id);
      state.backoff.delete(id);
    }
    const targets = connections.filter(isUsageEligible)
      .filter((connection) => !isFresh(connection, now, intervalMs) && backoffReady(state, connection.id, now))
      .sort((a, b) => (state.lastAttempt.get(a.id) ?? -Infinity) - (state.lastAttempt.get(b.id) ?? -Infinity))
      .slice(0, concurrency);
    const read = deps.readConnectionQuota || readConnectionQuota;
    const results = await Promise.all(targets.map((connection) => refreshOne(connection, read, state, jitterMs, now, deps.random || Math.random)));
    const refreshed = results.reduce((sum, result) => sum + result.refreshed, 0);
    const failed = results.length - refreshed;
    return { skipped: false, refreshed, failed, targeted: targets.length };
  } finally {
    state.running = false;
  }
}

export function startSmartQuotaRefresh() {
  if (globalState.interval) return;
  runSmartQuotaRefreshTick().catch(() => {});
  globalState.interval = setInterval(() => runSmartQuotaRefreshTick().catch(() => {}), 60_000);
  globalState.interval.unref?.();
}

export function stopSmartQuotaRefresh() {
  if (!globalState.interval) return;
  clearInterval(globalState.interval);
  globalState.interval = null;
}

export function configureSmartQuotaRefresh(settings) {
  if (settings?.smartQuotaBackgroundRefresh === true) startSmartQuotaRefresh();
  else stopSmartQuotaRefresh();
}
