export const DEFAULT_IMAGE_CONCURRENT = 1;
export const MAX_IMAGE_CONCURRENT = 8;
export const DEFAULT_IMAGE_QUEUE_MAX = 50;
export const DEFAULT_IMAGE_QUEUE_TIMEOUT_MS = 30_000;

export function createImageLoadState(maxQueue = DEFAULT_IMAGE_QUEUE_MAX) {
  return { accounts: new Map(), waiters: new Set(), reservations: new Map(), maxQueue, nextId: 1 };
}

export function getImageLoad(state, connectionId) {
  const entry = state.accounts.get(connectionId) || { running: 0, maxConcurrent: DEFAULT_IMAGE_CONCURRENT };
  return { running: entry.running, maxConcurrent: entry.maxConcurrent, overloaded: entry.running >= entry.maxConcurrent };
}

export function reserveImageSlot(state, connectionId, { maxConcurrent = DEFAULT_IMAGE_CONCURRENT } = {}) {
  if (!connectionId) return null;
  const entry = state.accounts.get(connectionId) || { running: 0, maxConcurrent };
  // Infinity = track load without a cap (no limit configured for the provider).
  entry.maxConcurrent = maxConcurrent === Infinity
    ? Infinity
    : Math.max(1, Math.min(MAX_IMAGE_CONCURRENT, Number(maxConcurrent) || DEFAULT_IMAGE_CONCURRENT));
  if (entry.running >= entry.maxConcurrent) return null;
  entry.running += 1;
  state.accounts.set(connectionId, entry);
  const id = `${connectionId}:${state.nextId++}`;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const current = state.accounts.get(connectionId);
    if (current) {
      current.running = Math.max(0, current.running - 1);
      if (!current.running) state.accounts.delete(connectionId);
    }
    state.reservations.delete(id);
    for (const notify of state.waiters) notify();
  };
  release.id = id;
  state.reservations.set(id, release);
  return release;
}

export function releaseImageSlot(state, reservationId) {
  const release = state.reservations.get(reservationId);
  if (!release) return false;
  release();
  return true;
}

export function waitForImageSlot(state, timeoutMs, signal) {
  if (signal?.aborted || timeoutMs <= 0) return Promise.resolve(false);
  if (state.waiters.size >= state.maxQueue) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (value) => {
      clearTimeout(timer);
      state.waiters.delete(notify);
      signal?.removeEventListener("abort", abort);
      resolve(value);
    };
    const notify = () => finish(true);
    const abort = () => finish(false);
    const timer = setTimeout(abort, timeoutMs);
    state.waiters.add(notify);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function snapshotImageLoad(state, connections, limits = {}) {
  return connections.map(({ id, provider }) => {
    const load = getImageLoad(state, id);
    const maxConcurrent = Number(limits[provider]) || load.maxConcurrent;
    return { connectionId: id, provider, running: load.running, maxConcurrent, overloaded: load.running >= maxConcurrent };
  });
}

export function selectLeastLoadedImageConnections(state, connections) {
  const lowest = Math.min(...connections.map(({ id }) => getImageLoad(state, id).running));
  return connections.filter(({ id }) => getImageLoad(state, id).running === lowest);
}
