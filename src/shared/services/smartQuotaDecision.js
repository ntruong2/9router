import { forecastQuota, getConnectionQuotaHealth, getRecommendedConnection, matchQuotaRows } from "@/shared/services/smartQuota.js";
import { getPaidFallbackDecision } from "./fallbackPolicy.js";

export function selectQuotaAccount(connections, provider, model, settings, now = Date.now()) {
  const override = settings.providerStrategies?.[provider];
  const strategy = override?.fallbackStrategy || settings.fallbackStrategy || "fill-first";
  if (strategy === "round-robin") {
    const current = [...connections].sort((a, b) => (Date.parse(b.lastUsedAt) || 0) - (Date.parse(a.lastUsedAt) || 0))[0];
    const limit = override?.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;
    const selected = current?.lastUsedAt && (current.consecutiveUseCount || 0) < limit
      ? current : [...connections].sort((a, b) => (Date.parse(a.lastUsedAt) || 0) - (Date.parse(b.lastUsedAt) || 0))[0];
    return { selected, reason: "round-robin", nextUseCount: selected === current && current?.lastUsedAt && (current.consecutiveUseCount || 0) < limit ? (current.consecutiveUseCount || 0) + 1 : 1 };
  }
  const recommended = settings.smartQuotaUse === true && connections.length > 1
    ? getRecommendedConnection(connections, now, model, provider) : null;
  const matched = recommended && matchQuotaRows(recommended.smartQuotaSnapshot, model, provider).length > 0;
  return { selected: recommended || connections[0], reason: matched ? "model-bucket" : recommended ? "aggregate-quota" : "priority" };
}

export function explainSmartQuotaDecision({ connections = [], provider, model, settings = {}, exclusions = [], comboName, isFallback, now = Date.now() } = {}) {
  const scoped = connections.filter((connection) => connection.provider === provider);
  const allowed = scoped.filter((connection) => getPaidFallbackDecision({
    settings, provider, model, comboName, isFallback, connection,
  }).allowed);
  const blocked = scoped.length > 0 && allowed.length === 0;
  const { selected, reason } = selectQuotaAccount(allowed, provider, model, settings, now);
  const quotaExclusions = scoped.filter(({ id }) => id !== selected?.id).map((connection) => {
    if (!allowed.includes(connection)) return { id: connection.id, reason: "paid-fallback-disabled" };
    const matching = matchQuotaRows(connection.smartQuotaSnapshot, model, provider);
    const snapshot = matching.length ? { ...connection.smartQuotaSnapshot, quotas: matching } : connection.smartQuotaSnapshot;
    const health = getConnectionQuotaHealth({ ...connection, smartQuotaSnapshot: snapshot }, now);
    return health.eligible ? null : { id: connection.id, reason: health.reason, remainingPercentage: health.remainingPercentage };
  }).filter(Boolean);
  const selectedRows = selected ? matchQuotaRows(selected.smartQuotaSnapshot, model, provider) : [];
  const forecast = selected ? forecastQuota(selected.smartQuotaHistory, model, now, provider) : null;
  return {
    selectedConnectionId: selected?.id || null,
    selectedProvider: selected?.provider || null,
    matchedBucket: selectedRows.length === 1 ? selectedRows[0].key : selectedRows.length > 1 ? selectedRows.map((row) => row.key) : null,
    score: selected ? getConnectionQuotaHealth({ ...selected, smartQuotaSnapshot: { ...selected.smartQuotaSnapshot, quotas: selectedRows.length ? selectedRows : selected.smartQuotaSnapshot?.quotas } }, now).score : null,
    forecast,
    quotaStatus: selected ? getConnectionQuotaHealth(selected, now).reason : null,
    exclusions: [...exclusions, ...quotaExclusions],
    reason: blocked ? "paid-fallback-disabled" : selected ? reason : "no-eligible-account",
    sideEffects: false,
  };
}
