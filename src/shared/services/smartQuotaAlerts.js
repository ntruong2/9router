import { getQuotaRemainingPercentage } from "@/shared/services/smartQuota.js";

const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

function rows(snapshot) {
  return Array.isArray(snapshot?.quotas) ? snapshot.quotas : [];
}

export function buildQuotaAlerts(previousSnapshot, nextSnapshot, forecast, now = Date.now()) {
  const previous = new Map(rows(previousSnapshot).map((row) => [row.key, row]));
  const alerts = [];
  for (const row of rows(nextSnapshot)) {
    const key = row.key;
    const previousRow = previous.get(key);
    const before = getQuotaRemainingPercentage(previousRow);
    const after = getQuotaRemainingPercentage(row);
    if (!key || after === null || before === null) continue;
    if (after === 0 && before > 0) alerts.push({ type: "depleted", key });
    if (after > 0 && after <= 10 && before > 10) alerts.push({ type: "low", key });
    const reset = Date.parse(previousRow.resetAt);
    if (after > before && reset <= now && Date.parse(row.resetAt) > reset) alerts.push({ type: "reset", key });
  }
  if (forecast?.hoursUntilEmpty !== undefined && forecast.hoursUntilEmpty <= 2) {
    alerts.push({ type: "forecast", key: forecast.key, hoursUntilEmpty: forecast.hoursUntilEmpty, at: new Date(now).toISOString() });
  }
  return alerts;
}

export function dedupeQuotaAlerts(alerts = [], state = new Map(), now = Date.now(), connectionId = "") {
  for (const [id, at] of state) {
    if (now - at >= ALERT_COOLDOWN_MS) state.delete(id);
  }
  return alerts.filter((alert) => {
    const id = JSON.stringify([connectionId, alert.type, alert.key]);
    if (state.has(id)) return false;
    state.set(id, now);
    return true;
  });
}
