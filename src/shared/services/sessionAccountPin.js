export const SESSION_ACCOUNT_PIN_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SESSION_PINS = 4096;

export function isSessionPinEnabled(settings, provider) {
  const enabled = settings?.sessionPin?.[provider];
  return typeof enabled === "boolean" ? enabled : provider === "codex" && settings?.codexSessionPin === true;
}

export function createSessionPinState() {
  return new Map();
}

function key(provider, sessionId) {
  return `${String(provider || "").toLowerCase()}:${String(sessionId || "")}`;
}

export function pinConnection(state, provider, sessionId, connectionId, now = Date.now(), ttlMs = SESSION_ACCOUNT_PIN_TTL_MS) {
  if (!sessionId || !connectionId) return;
  const pinKey = key(provider, sessionId);
  state.delete(pinKey);
  state.set(pinKey, { provider, connectionId, expiresAt: now + ttlMs });
  if (state.size > MAX_SESSION_PINS) state.delete(state.keys().next().value);
}

export function leastSharedConnections(state, provider, connections, now = Date.now()) {
  const counts = new Map();
  for (const [pinKey, { provider: pinnedProvider, connectionId, expiresAt }] of state) {
    if (expiresAt <= now) state.delete(pinKey);
    else if (pinnedProvider === provider) counts.set(connectionId, (counts.get(connectionId) || 0) + 1);
  }
  const lowestCount = Math.min(...connections.map(({ id }) => counts.get(id) || 0));
  return connections.filter(({ id }) => (counts.get(id) || 0) === lowestCount);
}

export function getPinnedConnectionId(state, provider, sessionId, now = Date.now()) {
  const pin = state.get(key(provider, sessionId));
  if (!pin || pin.expiresAt <= now) {
    state.delete(key(provider, sessionId));
    return null;
  }
  return pin.connectionId;
}

export function clearSessionPin(state, provider, sessionId, connectionId = null) {
  const pinKey = key(provider, sessionId);
  const pin = state.get(pinKey);
  if (!connectionId || pin?.connectionId === connectionId) state.delete(pinKey);
}
