export const DEFAULT_SESSION_CONCURRENCY = 2;
export const MAX_SESSION_CONCURRENCY = 32;
export const SESSION_QUEUE_TIMEOUT_MS = 1500;
const MAX_WAITERS = 128;

export function createSessionLoadState() {
  return { active: new Map(), accounts: new Map(), reservations: new Map(), waiters: new Set(), version: 0, nextId: 1 };
}

export function getConnectionLoad(state, connectionId, now = Date.now()) {
  const entry = state.accounts.get(connectionId) || { activeRequests: state.active.get(connectionId) || 0, maxConcurrent: DEFAULT_SESSION_CONCURRENCY, ewmaLatencyMs: 0, recentErrors: [] };
  return {
    activeRequests: entry.activeRequests,
    maxConcurrent: entry.maxConcurrent,
    ewmaLatencyMs: entry.ewmaLatencyMs,
    recentErrors: entry.recentErrors.filter((ts) => now - ts <= 60_000).length,
    overloaded: entry.activeRequests >= entry.maxConcurrent,
  };
}

export function snapshotSessionLoad(state, connections, limits, now = Date.now()) {
  return connections.map(({ id, provider }) => {
    const load = getConnectionLoad(state, id, now);
    const maxConcurrent = limits?.[provider] ?? DEFAULT_SESSION_CONCURRENCY;
    return {
      connectionId: id,
      activeRequests: load.activeRequests,
      maxConcurrent,
      ewmaLatencyMs: load.ewmaLatencyMs,
      recentErrors: load.recentErrors,
      overloaded: load.activeRequests >= maxConcurrent,
    };
  });
}

export function reserveConnectionLoad(state, connectionId, { maxConcurrent = DEFAULT_SESSION_CONCURRENCY, now = Date.now() } = {}) {
  const current = state.accounts.get(connectionId) || { activeRequests: 0, maxConcurrent, ewmaLatencyMs: 0, recentErrors: [] };
  current.maxConcurrent = maxConcurrent;
  if (current.activeRequests >= maxConcurrent) return null;
  current.activeRequests += 1;
  state.accounts.set(connectionId, current);
  state.active.set(connectionId, current.activeRequests);
  state.version++;
  let released = false;
  const id = `${connectionId}:${state.nextId++}`;
  const release = ({ error = false, releasedAt = Date.now() } = {}) => {
    if (released) return;
    released = true;
    const entry = state.accounts.get(connectionId);
    const remaining = (entry?.activeRequests || 0) - 1;
    if (remaining > 0) state.active.set(connectionId, remaining);
    else state.active.delete(connectionId);
    if (entry) entry.activeRequests = Math.max(0, remaining);
    recordConnectionOutcome(state, connectionId, { latencyMs: Math.max(0, releasedAt - now), error, now: releasedAt });
    state.reservations.delete(id);
    state.version++;
    for (const notify of state.waiters) notify();
  };
  release.id = id;
  release.connectionId = connectionId;
  state.reservations.set(id, release);
  return release;
}

export function releaseConnectionLoad(state, reservationId, now = Date.now()) {
  const release = state.reservations.get(reservationId);
  if (!release) return null;
  release({ releasedAt: now });
  return getConnectionLoad(state, release.connectionId, now);
}

export function recordConnectionOutcome(state, connectionId, { latencyMs = 0, error = false, now = Date.now() } = {}) {
  const entry = state.accounts.get(connectionId) || { activeRequests: 0, maxConcurrent: DEFAULT_SESSION_CONCURRENCY, ewmaLatencyMs: 0, recentErrors: [] };
  entry.ewmaLatencyMs = entry.ewmaLatencyMs ? (entry.ewmaLatencyMs * 0.5) + (latencyMs * 0.5) : latencyMs;
  entry.recentErrors = entry.recentErrors.filter((ts) => now - ts <= 60_000);
  if (error) entry.recentErrors.push(now);
  state.accounts.set(connectionId, entry);
  return getConnectionLoad(state, connectionId, now);
}

export function selectLeastLoadedConnections(state, connections) {
  const returnIds = connections.every((item) => typeof item === "string");
  const normalized = connections.map((item) => typeof item === "string" ? { id: item } : item);
  const lowest = normalized.reduce((min, { id }) => Math.min(min, getConnectionLoad(state, id).activeRequests), Infinity);
  const selected = normalized.filter(({ id }) => getConnectionLoad(state, id).activeRequests === lowest);
  return returnIds ? selected.map(({ id }) => id) : selected;
}

export function waitForConnectionLoad(state, version, timeoutMs, signal) {
  if (signal?.aborted || timeoutMs <= 0) return Promise.resolve(false);
  if (version !== state.version) return Promise.resolve(true);
  if (state.waiters.size >= MAX_WAITERS) return Promise.resolve(false);
  return new Promise((resolve) => {
    const notify = () => finish(true);
    const abort = () => finish(false);
    const timer = setTimeout(abort, timeoutMs);
    function finish(available) {
      clearTimeout(timer);
      state.waiters.delete(notify);
      signal?.removeEventListener("abort", abort);
      resolve(available);
    }
    state.waiters.add(notify);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function releaseAfterEventStream(response, release, signal) {
  if (!release || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) return response;
  const reader = response.body.getReader();
  const finish = (error = false) => {
    signal?.removeEventListener("abort", abort);
    release({ error });
  };
  const cancel = async (reason) => {
    try {
      await reader.cancel(reason);
    } finally {
      finish(true);
    }
  };
  const abort = () => { cancel(signal.reason).catch(() => {}); };
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (!done) {
          controller.enqueue(value);
          return;
        }
        finish();
        controller.close();
      } catch (error) {
        finish(true);
        controller.error(error);
      }
    },
    cancel,
  }, { highWaterMark: 0 });
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function getRateLimitResetFromHeader(value, now = Date.now()) {
  if (!value) return null;
  const reset = /^\d+$/.test(value) ? now + Number(value) * 1000 : Date.parse(value);
  return Number.isFinite(reset) && reset > now ? reset : null;
}
