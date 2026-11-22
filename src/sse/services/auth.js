import { getProviderConnections, validateApiKey, updateProviderConnection, getSettings, getProxyPools } from "@/lib/localDb";
import { resolveConnectionProxyConfig, pickProxyPoolId } from "@/lib/network/connectionProxy";
import { formatRetryAfter, checkFallbackError, isModelLockActive, buildModelLockUpdate, getEarliestModelLockUntil } from "open-sse/services/accountFallback.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "open-sse/config/errorConfig.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import { getAntigravityQuotaCache, getAntigravityModelQuota } from "./antigravityQuota.js";
import * as log from "../utils/logger.js";
import { selectQuotaAccount } from "@/shared/services/smartQuotaDecision.js";
import { getPaidFallbackDecision } from "@/shared/services/fallbackPolicy.js";
import { createSessionPinState, getPinnedConnectionId, pinConnection, clearSessionPin, isSessionPinEnabled, leastSharedConnections } from "@/shared/services/sessionAccountPin.js";
import { getConnectionQuotaHealth, getRecommendedConnection, matchQuotaRows } from "@/shared/services/smartQuota.js";
import { createSessionLoadState, getConnectionLoad, getRateLimitResetFromHeader, reserveConnectionLoad, selectLeastLoadedConnections, snapshotSessionLoad, waitForConnectionLoad } from "@/shared/services/sessionLoad.js";
import { createImageLoadState, getImageLoad, reserveImageSlot, selectLeastLoadedImageConnections, waitForImageSlot } from "@/shared/services/imageLoad.js";

// Mutex to prevent race conditions during account selection
let selectionMutex = Promise.resolve();
const sessionPins = globalThis[Symbol.for("9router.sessionAccountPins")] ||= createSessionPinState();
const sessionLoad = globalThis[Symbol.for("9router.sessionLoad")] ||= createSessionLoadState();
const imageLoad = globalThis[Symbol.for("9router.imageLoad")] ||= createImageLoadState();

export function clearProviderSessionPin(provider, sessionId, connectionId = null) {
  clearSessionPin(sessionPins, resolveProviderId(provider), sessionId, connectionId);
}

export function getSessionLoadSnapshot(connections, settings) {
  return snapshotSessionLoad(sessionLoad, connections.filter(({ provider }) => isSessionPinEnabled(settings, provider)), settings.sessionMaxConcurrent);
}

export function getImageLoadSnapshot(connections, settings) {
  return connections.map(({ id, provider }) => {
    const load = getImageLoad(imageLoad, id);
    const maxConcurrent = configuredLimit(settings.imageMaxConcurrent, provider);
    return { connectionId: id, provider, ...load, maxConcurrent, overloaded: maxConcurrent !== null && load.running >= maxConcurrent };
  });
}

function configuredLimit(limits, provider) {
  const value = limits?.[provider];
  return Number.isInteger(value) && value >= 1 ? value : null;
}

const GITHUB_MONTHLY_USAGE_LIMIT = "you've reached your additional usage limit for your plan";

// Parse "reset after 3h32m37s" / "reset after 25m57s" / "reset after 41s" into an absolute timestamp.
function parseResetAfterMs(errorText) {
  if (typeof errorText !== "string") return null;
  const m = errorText.match(/reset after\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+(?:\.\d+)?)s)?/i);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  const ms = ((Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0)) * 1000;
  return ms > 0 ? Date.now() + ms : null;
}

function githubMonthlyResetMs(status, errorText, provider) {
  if (resolveProviderId(provider) !== "github" || Number(status) !== 402) return null;
  if (!String(errorText || "").toLowerCase().includes(GITHUB_MONTHLY_USAGE_LIMIT)) return null;
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

export function quotaAccountExclusion(connection, provider, model, requestedModel = model, excludedIds = null) {
  if (connection.isActive === false) return "inactive";
  if (excludedIds?.has(connection.id)) return "attempted";
  if (isModelLockActive(connection, model)) return "model-cooldown";
  const enabled = connection.providerSpecificData?.enabledModels;
  if (provider === "codex" && Array.isArray(enabled) && enabled.length && requestedModel && !enabled.includes(requestedModel)) {
    return "model-disabled";
  }
  if (provider === "antigravity" && model) {
    const quotas = getAntigravityQuotaCache().get(connection.id);
    const quota = getAntigravityModelQuota(quotas, model) || quotas?.[model];
    if (quota?.remainingPercentage <= 0 && Date.parse(quota.resetAt) > Date.now()) return "model-quota-exhausted";
  }
  return null;
}

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;
  const requestedModel = options?.requestedModel || model;
  // Acquire mutex to prevent race conditions
  const currentMutex = selectionMutex;
  let resolveMutex;
  selectionMutex = new Promise(resolve => { resolveMutex = resolve; });

  try {
    await currentMutex;

    // Resolve alias to provider ID (e.g., "kc" -> "kilocode")
    const providerId = resolveProviderId(provider);

    // Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
    if (FREE_PROVIDERS[providerId]?.noAuth) {
      const settings = await getSettings();
      const override = (settings.providerStrategies || {})[providerId] || {};
      const strategy = override.rotateStrategy || "none";
      let pickedId = override.proxyPoolId || null;
      if (strategy !== "none") {
        const allPools = await getProxyPools({ isActive: true });
        const poolIds = allPools.filter(p => p.proxyUrl).map(p => p.id);
        pickedId = pickProxyPoolId(poolIds, strategy, providerId);
      }
      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: pickedId || "" });
      return {
        id: "noauth",
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
          strictProxy: resolvedProxy.strictProxy === true,
        },
      };
    }

    const connections = await getProviderConnections({ provider: providerId, isActive: true });
    log.debug("AUTH", `${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (connections.length === 0) {
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    // Antigravity quota cache is lazy: only populated after that account returns 409/429.
    const isAntigravity = providerId === "antigravity";
    const antigravityQuotaCache = isAntigravity && model ? getAntigravityQuotaCache() : null;

    // Filter out model-locked, excluded, and Antigravity quota-exhausted connections.
    let availableConnections = connections.filter((candidate) =>
      !quotaAccountExclusion(candidate, providerId, model, requestedModel, excludeSet));

    log.debug("AUTH", `${provider} | available: ${availableConnections.length}/${connections.length}`);
    connections.forEach(c => {
      const excluded = excludeSet.has(c.id);
      const locked = isModelLockActive(c, model);
      if (excluded || locked) {
        const lockUntil = getEarliestModelLockUntil(c);
        log.debug("AUTH", `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${locked ? `modelLocked(${model}) until ${lockUntil}` : ""}`);
      }
    });

    if (availableConnections.length === 0) {
      // Find earliest persistent lock or lazy Antigravity quota-cache reset for retry timing.
      const lockedConns = connections.filter(c => isModelLockActive(c, model));
      const expiries = lockedConns.map(c => getEarliestModelLockUntil(c)).filter(Boolean);
      if (isAntigravity && model && antigravityQuotaCache) {
        connections.forEach((c) => {
          const connQuotas = antigravityQuotaCache.get(c.id);
          const quota = getAntigravityModelQuota(connQuotas, model) || connQuotas?.[model];
          const resetAt = quota?.resetAt;
          if (resetAt && new Date(resetAt).getTime() > Date.now()) expiries.push(resetAt);
        });
      }
      const earliest = expiries.sort()[0] || null;
      if (earliest) {
        const earliestConn = lockedConns[0];
        log.warn("AUTH", `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${earliestConn?.lastError?.slice(0, 50)}`);
        return {
          allRateLimited: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError: earliestConn?.lastError || null,
          lastErrorCode: earliestConn?.errorCode || null
        };
      }
      log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`);
      return null;
    }

    const settings = await getSettings();
    const pinConfigured = isSessionPinEnabled(settings, providerId);
    const sessionPinEnabled = options.sessionId && pinConfigured;
    // Smart load: in-flight requests are always tracked so the least-loaded account is preferred,
    // but a hard cap (queue, then 503) applies only when the provider has a configured limit.
    // An implicit default cap turned parallel agents and image batches into 503s.
    const chatRequest = options.reserveChatSlot === true;
    const chatLimit = configuredLimit(settings.sessionMaxConcurrent, providerId) ?? Infinity;
    const imageLimit = configuredLimit(settings.imageMaxConcurrent, providerId) ?? Infinity;
    const balanceLoad = chatRequest;
    const balanceImageLoad = options.reserveImageSlot === true;
    const pinnedSessionId = sessionPinEnabled ? getPinnedConnectionId(sessionPins, providerId, options.sessionId) : null;
    if (options.paidFallback && settings.paidFallback?.enabled === true) {
      let denial;
      availableConnections = availableConnections.filter((candidate) => {
        const decision = getPaidFallbackDecision({
          settings, provider: providerId, model, comboName: options.paidFallback.comboName,
          isFallback: options.paidFallback.isFallback || excludeSet.size > 0,
          connection: candidate,
        });
        if (!decision.allowed) denial = decision;
        return decision.allowed;
      });
      if (!availableConnections.length && denial) {
        const reset = connections.map(getEarliestModelLockUntil).filter(Boolean).sort()[0] || null;
        return { paidFallbackBlocked: denial, retryAfter: reset };
      }
    }
    const now = Date.now();
    if ((chatRequest || sessionPinEnabled) && settings.smartQuotaUse === true) {
      availableConnections = availableConnections.filter((candidate) => {
        const quotas = matchQuotaRows(candidate.smartQuotaSnapshot, model, providerId);
        if (!quotas.length) return true;
        const health = getConnectionQuotaHealth({
          ...candidate,
          smartQuotaSnapshot: { ...candidate.smartQuotaSnapshot, quotas },
        }, now);
        if (health.stale || health.remainingPercentage !== 0) return true;
        return false;
      });
      if (!availableConnections.length) {
        return { allRateLimited: true, retryAfter: null, retryAfterHuman: "quota exhausted" };
      }
    }
    const preferred = availableConnections.find(({ id }) => id === preferredConnectionId);
    const pinned = availableConnections.find(({ id }) => id === pinnedSessionId);
    if (balanceImageLoad) {
      imageLoad.maxQueue = settings.imageQueueMaxSize || imageLoad.maxQueue;
      const maxConcurrent = imageLimit;
      const candidates = availableConnections.filter(({ id }) => getImageLoad(imageLoad, id).running < maxConcurrent);
      if (!candidates.length) {
        return { waitForImageSlot: (timeoutMs, signal) => waitForImageSlot(imageLoad, timeoutMs, signal) };
      }
      availableConnections = selectLeastLoadedImageConnections(imageLoad, candidates);
    }
    if (balanceLoad) {
      const limit = chatLimit;
      const hasCapacity = ({ id }) => getConnectionLoad(sessionLoad, id).activeRequests < limit;
      const target = preferred || pinned;
      availableConnections = target
        ? (hasCapacity(target) ? [target] : [])
        : availableConnections.filter(hasCapacity);
      if (!availableConnections.length) {
        const { version } = sessionLoad;
        return { waitForChatSlot: (timeoutMs, signal) => waitForConnectionLoad(sessionLoad, version, timeoutMs, signal) };
      }
    }
    let decision;
    if (balanceImageLoad) {
      decision = { selected: availableConnections[0], reason: "image-load-balanced" };
    } else if (preferred) {
      decision = { selected: preferred, reason: "pinned" };
    } else if (sessionPinEnabled) {
      const candidates = balanceLoad ? selectLeastLoadedConnections(sessionLoad, availableConnections) : availableConnections;
      const leastShared = pinned ? [] : leastSharedConnections(sessionPins, providerId, candidates, now);
      const recommended = settings.smartQuotaUse === true
        ? getRecommendedConnection(leastShared, now, model, providerId) : null;
      decision = { selected: pinned || recommended || leastShared[0], reason: pinned ? "session-pinned" : "session-assigned" };
    } else {
      decision = selectQuotaAccount(availableConnections, providerId, model, settings);
    }
    const connection = decision.selected;
    if (decision.nextUseCount !== undefined) {
      await updateProviderConnection(connection.id, {
        lastUsedAt: new Date().toISOString(),
        consecutiveUseCount: decision.nextUseCount,
      });
    }
    log.debug("AUTH", `${provider} | account ${connection.id?.slice(0, 8)} | decision=${decision.reason}`);

    const resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
    if (sessionPinEnabled) pinConnection(sessionPins, providerId, options.sessionId, connection.id);
    const releaseChatSlot = balanceLoad
      ? reserveConnectionLoad(sessionLoad, connection.id, { maxConcurrent: chatLimit })
      : undefined;
    const releaseImageSlot = balanceImageLoad
      ? reserveImageSlot(imageLoad, connection.id, { maxConcurrent: imageLimit })
      : undefined;

    return {
      releaseChatSlot,
      releaseImageSlot,
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      expiresAt: connection.expiresAt,
      expiresIn: connection.expiresIn,
      lastRefreshAt: connection.lastRefreshAt,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
        strictProxy: resolvedProxy.strictProxy === true,
      },
      connectionId: connection.id,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection
    };
  } finally {
    if (resolveMutex) resolveMutex();
  }
}

/**
 * Mark account+model as unavailable — locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @param {number|null} resetsAtMs - Provider-specific reset timestamp
 * @param {string|null} retryAfter - Upstream Retry-After header
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null, retryAfter = null) {
  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };
  const connections = await getProviderConnections({ provider });
  const conn = connections.find(c => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;

  // Callers that don't pass resetsAtMs (e.g. image generation) still get the exact reset when the
  // provider states it, e.g. Google "Your quota will reset after 3h32m37s." — otherwise the account
  // is retried every few minutes for hours and each request walks through all locked accounts.
  const now = Date.now();
  if (!(resetsAtMs > now)) {
    resetsAtMs = parseResetAfterMs(errorText);
    if (!resetsAtMs && status === 429) resetsAtMs = getRateLimitResetFromHeader(retryAfter, now);
  }

  // GitHub premium-request exhaustion is account-wide until the next UTC month.
  const githubResetAtMs = githubMonthlyResetMs(status, errorText, provider);

  // Provider-specific precise cooldown (e.g. codex usage_limit_reached resets_at) overrides backoff
  let shouldFallback, cooldownMs, newBackoffLevel;
  if (githubResetAtMs) {
    shouldFallback = true;
    cooldownMs = githubResetAtMs - Date.now();
    newBackoffLevel = 0;
  } else if (resetsAtMs > now) {
    shouldFallback = true;
    // Antigravity quota API provides exact per-model resetAt. Do not truncate it.
    cooldownMs = resolveProviderId(provider) === "antigravity"
      ? resetsAtMs - now
      : Math.min(resetsAtMs - now, MAX_RATE_LIMIT_COOLDOWN_MS);
    newBackoffLevel = 0;
  } else {
    ({ shouldFallback, cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel, resolveProviderId(provider)));
  }
  if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };

  const reason = typeof errorText === "string" ? errorText.slice(0, 200) : "Provider error";
  const lockUpdate = buildModelLockUpdate(githubResetAtMs ? null : model, cooldownMs);

  await updateProviderConnection(connectionId, {
    ...lockUpdate,
    testStatus: "unavailable",
    lastError: reason,
    errorCode: status,
    lastErrorAt: new Date().toISOString(),
    backoffLevel: newBackoffLevel ?? backoffLevel
  });

  const lockKey = Object.keys(lockUpdate)[0];
  const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
  log.warn("AUTH", `${connName} locked ${lockKey} for ${Math.round(cooldownMs / 1000)}s [${status}]`);

  if (provider && status && reason) {
    console.error(`❌ ${provider} [${status}]: ${reason}`);
  }

  return { shouldFallback: true, cooldownMs };
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId || connectionId === "noauth") return;
  const conn = currentConnection._connection || currentConnection;
  const now = Date.now();
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_"));

  if (!conn.testStatus && !conn.lastError && allLockKeys.length === 0) return;

  // Keys to clear: current model's lock + all expired locks
  const keysToClear = allLockKeys.filter(k => {
    if (model && k === `modelLock_${model}`) return true; // succeeded model
    if (model && k === "modelLock___all") return true;    // account-level lock
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() <= now;   // expired
  });

  if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError) return;

  // Check if any active locks remain after clearing
  const remainingActiveLocks = allLockKeys.filter(k => {
    if (keysToClear.includes(k)) return false;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() > now;
  });

  const clearObj = Object.fromEntries(keysToClear.map(k => [k, null]));

  // Only reset error state if no active locks remain
  if (remainingActiveLocks.length === 0) {
    Object.assign(clearObj, {
      testStatus: "active",
      lastError: null,
      errorCode: null,
      lastErrorAt: null,
      backoffLevel: 0
    });
  }

  await updateProviderConnection(connectionId, clearObj);
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request) {
  // Check Authorization header first
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check Anthropic x-api-key header
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) {
    return xApiKey;
  }

  return null;
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}
