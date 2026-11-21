export const SMART_QUOTA_STALE_MS = 10 * 60 * 1000;
export const SMART_QUOTA_FETCHED_AT_HEADER = "x-9router-quota-fetched-at";
export const SMART_QUOTA_HISTORY_LIMIT = 24;

function numeric(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function quotaKey(quota, index) {
  const key = quota?.key || quota?.modelKey || quota?.quotaType || quota?.name;
  return String(key || `bucket-${index}`).trim().toLowerCase();
}

const HOUR_MS = 3_600_000;

export function getQuotaRemainingPercentage(quota) {
  if (!quota || quota.unlimited || quota.isCreditBalance || quota.emptyMessage || quota.message) return null;
  const { remainingPercentage, percentage, remaining, total, used } = quota;
  const normalizedRemainingPercentage = numeric(remainingPercentage);
  const normalizedPercentage = numeric(percentage);
  const normalizedRemaining = numeric(remaining);
  const normalizedTotal = numeric(total);
  const normalizedUsed = numeric(used);
  let value;
  if (normalizedRemainingPercentage !== null) value = normalizedRemainingPercentage;
  else if (normalizedPercentage !== null) value = quota.percentageIsUsed === true ? 100 - normalizedPercentage : normalizedPercentage;
  else if (normalizedRemaining !== null) value = normalizedRemaining;
  else if (normalizedTotal !== null && normalizedTotal > 0 && normalizedUsed !== null) value = ((normalizedTotal - normalizedUsed) / normalizedTotal) * 100;
  else return null;
  return Math.max(0, Math.min(100, value));
}

export function normalizeQuotaRows(quotas = []) {
  const rows = Array.isArray(quotas)
    ? quotas
    : Object.entries(quotas || {}).map(([name, quota]) => ({ name, ...(quota || {}) }));
  return rows.flatMap((quota, index) => {
    const remainingPercentage = getQuotaRemainingPercentage(quota);
    if (remainingPercentage === null) return [];
    return [{
      key: quotaKey(quota, index),
      remainingPercentage,
      resetAt: typeof quota.resetAt === "string" ? quota.resetAt : null,
    }];
  });
}

export function buildQuotaSnapshot(quotas, fetchedAt) {
  const rows = normalizeQuotaRows(quotas);
  return rows.length > 0 ? { fetchedAt, quotas: rows } : null;
}

export function appendQuotaHistory(history = [], snapshot) {
  if (!snapshot?.fetchedAt || !Array.isArray(snapshot.quotas) || snapshot.quotas.length === 0) {
    return Array.isArray(history) ? history.slice(-SMART_QUOTA_HISTORY_LIMIT) : [];
  }
  const merged = [...(Array.isArray(history) ? history : []), snapshot]
    .filter((entry) => Number.isFinite(Date.parse(entry?.fetchedAt)) && Array.isArray(entry.quotas))
    .sort((a, b) => Date.parse(a.fetchedAt) - Date.parse(b.fetchedAt));
  const unique = [];
  for (const entry of merged) {
    if (Date.parse(unique.at(-1)?.fetchedAt) === Date.parse(entry.fetchedAt)) unique[unique.length - 1] = entry;
    else unique.push(entry);
  }
  return unique.slice(-SMART_QUOTA_HISTORY_LIMIT);
}

export function matchQuotaRows(snapshot, model, provider) {
  const rows = Array.isArray(snapshot?.quotas) ? snapshot.quotas : [];
  if (typeof model !== "string" || !model.trim()) return [];
  const id = model.trim().toLowerCase().split("/").at(-1);
  const keyed = rows.filter((row) => typeof row?.key === "string" && row.key);
  let shared = [];
  if (provider === "codex") {
    if (/(?:^|-)spark(?:-|$)/.test(id)) shared = ["spark_session", "spark_weekly"];
    else if (/(?:^|-)review(?:-|$)/.test(id)) shared = ["review_session", "review_weekly"];
    else shared = ["session", "weekly"];
  } else if (provider === "claude") {
    const family = id.match(/(?:^|-)(opus|sonnet|haiku|fable)(?:-|$)/)?.[1];
    shared = ["session (5h)", "weekly (7d)"];
    if (family) shared.push(`weekly ${family} (7d)`);
  } else if (provider === "antigravity") {
    if (id.startsWith("gemini-") && !id.includes("image")) {
      const argon = id.includes("argon") && keyed.some(({ key }) => key.startsWith("gemini_argon"));
      shared = argon
        ? ["gemini_argon", "gemini_argon_session", "gemini_argon_weekly"]
        : ["gemini", "gemini_session", "gemini_weekly"];
    } else if (/^(claude|gpt)-/.test(id)) {
      shared = ["claude", "claude_gpt_session", "claude_gpt_weekly"];
    }
    for (const { key } of keyed) {
      if (key.startsWith("group:") && key.length > 6) {
        const groupSlug = key.slice(6, key.lastIndexOf(":"));
        if (groupSlug && id.startsWith(groupSlug)) shared.push(key);
      }
    }
  }
  if (provider === "antigravity") {
    const groupRows = keyed.filter(({ key }) => shared.includes(key) && key.startsWith("group:"));
    if (groupRows.length > 0) return groupRows;
  }
  const exact = keyed.filter(({ key }) => key === id || key === model.trim().toLowerCase() || shared.includes(key));
  if (exact.length || shared.length) return exact;
  const family = keyed.filter(({ key }) => id.startsWith(`${key}-`));
  const longest = Math.max(0, ...family.map(({ key }) => key.length));
  return family.filter(({ key }) => key.length === longest);
}

export function forecastQuota(history = [], model = null, now = Date.now(), provider = null) {
  const observations = new Map();
  const latest = history.at?.(-1);
  const latestAt = Date.parse(latest?.fetchedAt);
  if (!Number.isFinite(latestAt) || now - latestAt > SMART_QUOTA_STALE_MS || latestAt > now) return null;
  for (const snapshot of history) {
    const fetchedAt = Date.parse(snapshot?.fetchedAt);
    if (!Number.isFinite(fetchedAt) || fetchedAt > now || now - fetchedAt > 24 * HOUR_MS) continue;
    for (const row of model ? matchQuotaRows(snapshot, model, provider) : snapshot.quotas || []) {
      if (!row?.key || row.key.startsWith("bucket-")) continue;
      const list = observations.get(row.key) || [];
      list.push({ fetchedAt, remainingPercentage: numeric(row.remainingPercentage), resetAt: row.resetAt });
      observations.set(row.key, list);
    }
  }
  const forecasts = [];
  for (const [key, list] of observations) {
    const valid = list.filter((item) => item.remainingPercentage !== null).sort((a, b) => a.fetchedAt - b.fetchedAt);
    if (valid.length < 2) continue;
    const last = valid.at(-1);
    if (last.fetchedAt !== latestAt || last.remainingPercentage <= 0) continue;
    let start = valid.length - 1;
    while (start > 0 && valid[start - 1].resetAt === last.resetAt &&
      valid[start - 1].remainingPercentage >= valid[start].remainingPercentage) start--;
    const first = valid[start];
    const elapsedHours = (last.fetchedAt - first.fetchedAt) / HOUR_MS;
    const drop = first.remainingPercentage - last.remainingPercentage;
    if (elapsedHours < 1 / 60 || drop <= 0) continue;
    const ratePerHour = drop / elapsedHours;
    const estimatedAt = last.fetchedAt + (last.remainingPercentage / ratePerHour) * HOUR_MS;
    const resetAt = Date.parse(last.resetAt);
    if (estimatedAt > now + 24 * HOUR_MS || (Number.isFinite(resetAt) && (now >= resetAt || estimatedAt >= resetAt))) continue;
    const hoursUntilEmpty = Math.max(0, (estimatedAt - now) / HOUR_MS);
    forecasts.push({ key, ratePerHour, hoursUntilEmpty, estimatedAt: new Date(estimatedAt).toISOString() });
  }
  if (forecasts.length === 0) return null;
  return forecasts.sort((a, b) => a.hoursUntilEmpty - b.hoursUntilEmpty)[0];
}

export function getQuotaAlertState(snapshot, now = Date.now(), resetSoonMs = 60 * 60 * 1000) {
  const rows = Array.isArray(snapshot?.quotas) ? snapshot.quotas : [];
  const remaining = rows.map(getQuotaRemainingPercentage).filter((value) => value !== null);
  const resetTimes = rows.map((row) => Date.parse(row?.resetAt)).filter((time) => Number.isFinite(time) && time > now);
  const nextResetAt = resetTimes.sort((a, b) => a - b)[0] || null;
  return {
    depleted: remaining.some((value) => value <= 0),
    resetSoon: nextResetAt !== null && nextResetAt - now <= resetSoonMs,
    nextResetAt: nextResetAt ? new Date(nextResetAt).toISOString() : null,
  };
}

export function getConnectionQuotaHealth(connection, now = Date.now()) {
  if (!connection || connection.isActive === false) {
    return { eligible: false, score: -Infinity, remainingPercentage: null, stale: false, reason: "inactive" };
  }

  const snapshot = connection.smartQuotaSnapshot;
  const fetchedAt = Date.parse(snapshot?.fetchedAt);
  const lastErrorAt = Date.parse(connection.lastErrorAt);
  const recentError = connection.quotaError || Date.parse(connection.rateLimitedUntil) > now ||
    (connection.lastError && now - lastErrorAt <= SMART_QUOTA_STALE_MS);
  const rows = Array.isArray(snapshot?.quotas)
    ? snapshot.quotas.filter((quota) => getQuotaRemainingPercentage(quota) !== null)
    : [];
  const stale = rows.length > 0 && (
    !Number.isFinite(fetchedAt) || fetchedAt > now || now - fetchedAt > SMART_QUOTA_STALE_MS ||
    rows.some((quota) => {
      const reset = Date.parse(quota.resetAt);
      return reset >= fetchedAt && reset <= now;
    })
  );
  const remainingPercentage = rows.length ? Math.min(...rows.map(getQuotaRemainingPercentage)) : null;

  if (recentError || stale || remainingPercentage === null || remainingPercentage === 0) {
    const reason = recentError ? "error" : stale ? "stale" : remainingPercentage === null ? "missing" : "depleted";
    return { eligible: false, score: -Infinity, remainingPercentage, stale, reason };
  }

  const soonestReset = rows
    .map((quota) => new Date(quota.resetAt || 0).getTime())
    .filter((time) => Number.isFinite(time) && time > now)
    .sort((a, b) => a - b)[0];
  const recoveryBonus = soonestReset ? Math.max(0, 5 * (1 - (soonestReset - now) / (24 * 60 * 60 * 1000))) : 0;
  return {
    eligible: true,
    score: remainingPercentage + recoveryBonus,
    remainingPercentage,
    stale: false,
    reason: "healthy",
  };
}

export function rankConnectionsByQuotaHealth(connections = [], now = Date.now()) {
  return connections
    .map((connection, index) => ({
      connection,
      health: getConnectionQuotaHealth(connection, now),
      index,
    }))
    .sort((a, b) => {
      if (a.health.eligible !== b.health.eligible) return a.health.eligible ? -1 : 1;
      if (a.health.score !== b.health.score) return b.health.score - a.health.score;
      const priorityA = a.connection.priority || 999;
      const priorityB = b.connection.priority || 999;
      return priorityA - priorityB || a.index - b.index;
    });
}

export function getRecommendedConnection(connections = [], now = Date.now(), model = null, provider = null) {
  if (!model) return rankConnectionsByQuotaHealth(connections, now).find((item) => item.health.eligible)?.connection || null;
  const ranked = connections.map((connection, index) => {
    const matchingRows = matchQuotaRows(connection.smartQuotaSnapshot, model, provider || connection.provider);
    const health = matchingRows.length > 0
      ? getConnectionQuotaHealth({
          ...connection,
          smartQuotaSnapshot: { ...connection.smartQuotaSnapshot, quotas: matchingRows },
        }, now)
      : getConnectionQuotaHealth(connection, now);
    return { connection, health, index, hasMatch: matchingRows.length > 0 };
  }).sort((a, b) => {
    if (a.health.eligible !== b.health.eligible) return a.health.eligible ? -1 : 1;
    if (a.health.score !== b.health.score) return b.health.score - a.health.score;
    return (a.connection.priority || 999) - (b.connection.priority || 999) || a.index - b.index;
  });
  const matching = ranked.filter((item) => item.hasMatch && item.health.eligible);
  return (matching[0] || ranked.find((item) => item.health.eligible))?.connection || null;
}
