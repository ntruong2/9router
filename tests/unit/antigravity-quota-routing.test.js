import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  updateProviderConnection: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  getAntigravityUsage: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getSettings: mocks.getSettings,
  getProxyPools: vi.fn(),
  validateApiKey: vi.fn(),
  updateProviderConnection: mocks.updateProviderConnection,
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
  pickProxyPoolId: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("open-sse/services/usage/google.js", () => ({
  getAntigravityUsage: mocks.getAntigravityUsage,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { getAntigravityQuotaCache, handleAntigravityQuotaError, refreshAntigravityQuota, clearAntigravityStrikes } = await import("@/sse/services/antigravityQuota.js");
const { getProviderCredentials, markAccountUnavailable } = await import("@/sse/services/auth.js");

const MODEL = "claude-opus-4-6-thinking";
const FUTURE_RESET = "2026-09-01T00:00:00.000Z";

beforeEach(() => {
  vi.clearAllMocks();
  getAntigravityQuotaCache().clear();
  mocks.resolveConnectionProxyConfig.mockResolvedValue({});
  mocks.getSettings.mockResolvedValue({});
});

describe("Antigravity quota-aware routing", () => {
  it.each([
    ["45", null, "Rate limited", 45],
    ["Tue, 01 Sep 2026 00:01:00 GMT", null, "Rate limited", 60],
    ["45", Date.parse("2026-09-01T00:02:00Z"), "Rate limited", 120],
    ["45", null, "Quota reset after 2m", 120],
    ["3600", null, "Rate limited", 1800],
  ])("uses Retry-After %s when there is no precise reset", async (header, reset, message, seconds) => {
    vi.useFakeTimers();
    const now = Date.parse("2026-09-01T00:00:00Z");
    vi.setSystemTime(now);
    mocks.getProviderConnections.mockResolvedValue([{ id: "rate-account" }]);
    try {
      await expect(markAccountUnavailable("rate-account", 429, message, "codex", "model", reset, header))
        .resolves.toEqual({ shouldFallback: true, cooldownMs: seconds * 1000 });
      expect(mocks.updateProviderConnection).toHaveBeenCalledWith("rate-account", expect.objectContaining({
        modelLock_model: new Date(now + seconds * 1000).toISOString(),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("assigns five Codex sessions distinct accounts with fill-first enabled", async () => {
    mocks.getSettings.mockResolvedValue({ sessionPin: { codex: true }, fallbackStrategy: "fill-first" });
    mocks.getProviderConnections.mockResolvedValue(Array.from({ length: 15 }, (_, i) => ({
      id: `cx-${i}`, provider: "codex", priority: i + 1, isActive: true,
    })));
    const ids = await Promise.all(Array.from({ length: 5 }, async (_, i) =>
      (await getProviderCredentials("codex", null, "gpt-5.3-codex", { sessionId: `five-${i}` })).connectionId,
    ));
    expect(new Set(ids).size).toBe(5);
    const remapped = await getProviderCredentials("codex", ids[0], "gpt-5.3-codex", { sessionId: "five-0" });
    expect(ids).not.toContain(remapped.connectionId);
    await expect(getProviderCredentials("codex", null, "gpt-5.3-codex", { sessionId: "five-0" }))
      .resolves.toMatchObject({ connectionId: remapped.connectionId });
  });

  it("keeps Codex session pin opt-in and supports other configured providers", async () => {
    mocks.getSettings.mockResolvedValue({ sessionPin: { claude: true } });
    mocks.getProviderConnections.mockResolvedValue([{ id: "opt-a", isActive: true }, { id: "opt-b", isActive: true }]);
    const ids = async (provider) => Promise.all(["opt-first", "opt-second"].map(async (sessionId) =>
      (await getProviderCredentials(provider, null, "model", { sessionId })).connectionId));
    expect(await ids("codex")).toEqual(["opt-a", "opt-a"]);
    expect(await ids("claude")).toEqual(["opt-a", "opt-b"]);
  });

  it("assigns new pinned sessions to accounts with available capacity", async () => {
    mocks.getSettings.mockResolvedValue({ sessionPin: { codex: true }, smartQuotaUse: false });
    mocks.getProviderConnections.mockResolvedValue([
      { id: "load-a", isActive: true },
      { id: "load-b", isActive: true },
      { id: "load-c", isActive: true },
    ]);
    const credentials = await Promise.all(["load-1", "load-2", "load-3"].map((sessionId) =>
      getProviderCredentials("codex", null, "model", { sessionId, reserveChatSlot: true })));
    expect(new Set(credentials.map((item) => item.connectionId)).size).toBe(3);
    credentials.forEach((item) => item.releaseChatSlot?.());
  });
  it("records exhausted upstream quota after 429 and returns its exact reset time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"));
    mocks.getAntigravityUsage.mockResolvedValue({ quotas: {
      [MODEL]: { remainingPercentage: 0, resetAt: FUTURE_RESET },
    } });

    try {
      await expect(handleAntigravityQuotaError("ag-a", 429, MODEL, "token", {}))
        .resolves.toBe(Date.parse(FUTURE_RESET));
      expect(getAntigravityQuotaCache().get("ag-a")[MODEL]).toEqual({
        remainingPercentage: 0,
        resetAt: FUTURE_RESET,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips exhausted account/model and selects the next account", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"));
    mocks.getProviderConnections.mockResolvedValue([
      { id: "ag-a", email: "a@example.com", isActive: true },
      { id: "ag-b", email: "b@example.com", isActive: true },
    ]);
    getAntigravityQuotaCache().set("ag-a", {
      [MODEL]: { remainingPercentage: 0, resetAt: FUTURE_RESET },
    });

    try {
      await expect(getProviderCredentials("antigravity", null, MODEL)).resolves.toMatchObject({
        connectionId: "ag-b",
        connectionName: "b@example.com",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports retry time when every account is cache-blocked", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"));
    mocks.getProviderConnections.mockResolvedValue([{ id: "ag-a", email: "a@example.com", isActive: true }]);
    getAntigravityQuotaCache().set("ag-a", {
      [MODEL]: { remainingPercentage: 0, resetAt: FUTURE_RESET },
    });

    try {
      await expect(getProviderCredentials("antigravity", null, MODEL)).resolves.toMatchObject({
        allRateLimited: true,
        retryAfter: FUTURE_RESET,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets account back into rotation once reset time has passed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T00:00:01.000Z"));
    mocks.getProviderConnections.mockResolvedValue([{ id: "ag-a", email: "a@example.com", isActive: true }]);
    getAntigravityQuotaCache().set("ag-a", {
      [MODEL]: { remainingPercentage: 0, resetAt: FUTURE_RESET },
    });

    try {
      await expect(getProviderCredentials("antigravity", null, MODEL)).resolves.toMatchObject({
        connectionId: "ag-a",
        connectionName: "a@example.com",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("prefers the fresh account with more quota when Smart Use is enabled", async () => {
    mocks.getSettings.mockResolvedValue({ smartQuotaUse: true });
    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "ag-low",
        email: "low@example.com",
        isActive: true,
        priority: 1,
        smartQuotaSnapshot: {
          fetchedAt: new Date(Date.now() - 30_000).toISOString(),
          quotas: [{ remainingPercentage: 20 }],
        },
      },
      {
        id: "ag-high",
        email: "high@example.com",
        isActive: true,
        priority: 2,
        smartQuotaSnapshot: {
          fetchedAt: new Date(Date.now() - 30_000).toISOString(),
          quotas: [{ remainingPercentage: 90 }],
        },
      },
    ]);

    await expect(getProviderCredentials("antigravity", null, MODEL)).resolves.toMatchObject({
      connectionId: "ag-high",
      connectionName: "high@example.com",
    });
  });

  it("prefers the account whose matching model bucket is healthy", async () => {
    mocks.getSettings.mockResolvedValue({ smartQuotaUse: true });
    mocks.getProviderConnections.mockResolvedValue([
      { id: "ag-unrelated", email: "unrelated@example.com", isActive: true, priority: 1, smartQuotaSnapshot: { fetchedAt: new Date(Date.now() - 30_000).toISOString(), quotas: [{ key: "gemini", remainingPercentage: 95 }] } },
      { id: "ag-match", email: "match@example.com", isActive: true, priority: 2, smartQuotaSnapshot: { fetchedAt: new Date(Date.now() - 30_000).toISOString(), quotas: [{ key: "claude-opus", remainingPercentage: 70 }] } },
    ]);
    await expect(getProviderCredentials("antigravity", null, "claude-opus")).resolves.toMatchObject({ connectionId: "ag-match" });
  });

  it("uses Antigravity group buckets for model-aware selection", async () => {
    mocks.getSettings.mockResolvedValue({ smartQuotaUse: true });
    mocks.getProviderConnections.mockResolvedValue([
      { id: "ag-group-empty", email: "empty@example.com", isActive: true, priority: 1, smartQuotaSnapshot: { fetchedAt: new Date(Date.now() - 30_000).toISOString(), quotas: [{ key: "group:gemini-4-neon:weekly", remainingPercentage: 0 }, { key: "gemini", remainingPercentage: 90 }] } },
      { id: "ag-base", email: "base@example.com", isActive: true, priority: 2, smartQuotaSnapshot: { fetchedAt: new Date(Date.now() - 30_000).toISOString(), quotas: [{ key: "gemini", remainingPercentage: 50 }] } },
    ]);
    await expect(getProviderCredentials("antigravity", null, "gemini-4-neon")).resolves.toMatchObject({ connectionId: "ag-base" });
  });

  it("coalesces concurrent quota refreshes for one account", async () => {
    let resolveUsage;
    mocks.getAntigravityUsage.mockReturnValue(new Promise(resolve => { resolveUsage = resolve; }));

    const first = refreshAntigravityQuota("ag-concurrent", "token", {});
    const second = refreshAntigravityQuota("ag-concurrent", "token", {});
    resolveUsage({ quotas: { [MODEL]: { remainingPercentage: 0, resetAt: FUTURE_RESET } } });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { [MODEL]: { remainingPercentage: 0, resetAt: FUTURE_RESET } },
      { [MODEL]: { remainingPercentage: 0, resetAt: FUTURE_RESET } },
    ]);
    expect(mocks.getAntigravityUsage).toHaveBeenCalledTimes(1);
  });

  it("preserves strict proxy policy for usage refresh", async () => {
    mocks.resolveConnectionProxyConfig.mockResolvedValue({ strictProxy: true });
    mocks.getAntigravityUsage.mockResolvedValue({ quotas: {} });

    await refreshAntigravityQuota("ag-strict-proxy", "token", {});

    expect(mocks.getAntigravityUsage).toHaveBeenCalledWith("token", {}, expect.objectContaining({
      strictProxy: true,
    }));
  });

  it("keeps known cache when quota endpoint returns an error payload", async () => {
    const cached = { [MODEL]: { remainingPercentage: 0, resetAt: FUTURE_RESET } };
    getAntigravityQuotaCache().set("ag-error-response", cached);
    mocks.getAntigravityUsage.mockResolvedValue({ message: "Unauthorized", quotas: {} });

    await expect(refreshAntigravityQuota("ag-error-response", "token", {})).resolves.toBeNull();
    expect(getAntigravityQuotaCache().get("ag-error-response")).toBe(cached);
  });

  it("throttles failed refresh attempts for 30 seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"));
    mocks.getAntigravityUsage.mockRejectedValue(new Error("usage unavailable"));

    try {
      await refreshAntigravityQuota("ag-failed-refresh", "token", {});
      await refreshAntigravityQuota("ag-failed-refresh", "token", {});
      expect(mocks.getAntigravityUsage).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(30_000);
      await refreshAntigravityQuota("ag-failed-refresh", "token", {});
      expect(mocks.getAntigravityUsage).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("strike-breaks after 3 optimistic 429s within 60s and cache-blocks 15 minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"));
    // Quota API lies: reports 90% remaining while generation keeps 429ing.
    mocks.getAntigravityUsage.mockResolvedValue({ quotas: {
      [MODEL]: { remainingPercentage: 90, resetAt: FUTURE_RESET },
    } });

    try {
      const first = await handleAntigravityQuotaError("ag-strike", 429, MODEL, "token", {});
      expect(first).toBeNull();
      const second = await handleAntigravityQuotaError("ag-strike", 429, MODEL, "token", {});
      expect(second).toBeNull();

      const third = await handleAntigravityQuotaError("ag-strike", 429, MODEL, "token", {});
      expect(third).toBe(Date.parse("2026-08-26T00:15:00.000Z"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets the strike counter when strikes fall outside the 60s window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"));
    mocks.getAntigravityUsage.mockResolvedValue({ quotas: {
      [MODEL]: { remainingPercentage: 90, resetAt: FUTURE_RESET },
    } });

    try {
      await handleAntigravityQuotaError("ag-window", 429, MODEL, "token", {});
      await handleAntigravityQuotaError("ag-window", 429, MODEL, "token", {});
      await vi.advanceTimersByTimeAsync(61_000);
      const result = await handleAntigravityQuotaError("ag-window", 429, MODEL, "token", {});
      expect(result).toBeNull(); // window lapsed — counter restarted at 1
    } finally {
      vi.useRealTimers();
    }
  });

  it("strike-breaks when the quota API is unavailable (null reading) too", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"));
    // Quota endpoint failing/forbidden => quota unknown. Strikes must still count.
    mocks.getAntigravityUsage.mockResolvedValue({ message: "forbidden", quotas: {} });

    try {
      await handleAntigravityQuotaError("ag-null", 429, MODEL, "token", {});
      await handleAntigravityQuotaError("ag-null", 429, MODEL, "token", {});
      const third = await handleAntigravityQuotaError("ag-null", 429, MODEL, "token", {});
      expect(third).toBe(Date.parse("2026-08-26T00:15:00.000Z"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists the block into the shared cache so the next request skips the pair", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"));
    mocks.getAntigravityUsage.mockResolvedValue({ quotas: {
      [MODEL]: { remainingPercentage: 90, resetAt: FUTURE_RESET },
    } });

    try {
      await handleAntigravityQuotaError("ag-persist", 429, MODEL, "token", {});
      await handleAntigravityQuotaError("ag-persist", 429, MODEL, "token", {});
      await handleAntigravityQuotaError("ag-persist", 429, MODEL, "token", {});

      // The synthesized entry must be visible to the auth pre-filter reading
      // the shared cache — and must survive an optimistic upstream refresh.
      const cached = getAntigravityQuotaCache().get("ag-persist")?.[MODEL];
      expect(cached).toMatchObject({ remainingPercentage: 0 });
      expect(Date.parse(cached.resetAt)).toBe(Date.parse("2026-08-26T00:15:00.000Z"));

      await refreshAntigravityQuota("ag-persist", "token", {});
      expect(getAntigravityQuotaCache().get("ag-persist")?.[MODEL]).toMatchObject({
        remainingPercentage: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears strike state and the synthesized block after a successful request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"));
    mocks.getAntigravityUsage.mockResolvedValue({ quotas: {
      [MODEL]: { remainingPercentage: 90, resetAt: FUTURE_RESET },
    } });

    try {
      await handleAntigravityQuotaError("ag-clear", 429, MODEL, "token", {});
      await handleAntigravityQuotaError("ag-clear", 429, MODEL, "token", {});
      await handleAntigravityQuotaError("ag-clear", 429, MODEL, "token", {});
      expect(getAntigravityQuotaCache().get("ag-clear")?.[MODEL]?.remainingPercentage).toBe(0);

      clearAntigravityStrikes("ag-clear", MODEL);
      // Synthesized entry gone — pair selectable again immediately.
      expect(getAntigravityQuotaCache().get("ag-clear")?.[MODEL]).toBeUndefined();

      // Two more 429s do NOT inherit earlier strikes: no block on the third-in-episode.
      await handleAntigravityQuotaError("ag-clear", 429, MODEL, "token", {});
      await expect(handleAntigravityQuotaError("ag-clear", 429, MODEL, "token", {})).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("anchors the window at the first strike: 3 strikes spread over 90s do not trip", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"));
    mocks.getAntigravityUsage.mockResolvedValue({ quotas: {
      [MODEL]: { remainingPercentage: 90, resetAt: FUTURE_RESET },
    } });

    try {
      await handleAntigravityQuotaError("ag-anchor", 429, MODEL, "token", {});      // t=0
      await vi.advanceTimersByTimeAsync(45_000);
      await handleAntigravityQuotaError("ag-anchor", 429, MODEL, "token", {});      // t=45s
      await vi.advanceTimersByTimeAsync(45_000);
      // t=90s: within 60s of strike #2 but outside 60s of strike #1 => new window
      const result = await handleAntigravityQuotaError("ag-anchor", 429, MODEL, "token", {});
      expect(result).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the optimistic path null without touching the quota cache", async () => {
    mocks.getAntigravityUsage.mockResolvedValue({ quotas: {
      [MODEL]: { remainingPercentage: 90, resetAt: FUTURE_RESET },
    } });

    await expect(handleAntigravityQuotaError("ag-optimistic", 429, MODEL, "token", {}))
      .resolves.toBeNull();
    // Optimistic reading must NOT poison the shared cache (auth pre-filter
    // treats cached 0% as exhausted).
    expect(getAntigravityQuotaCache().get("ag-optimistic")?.[MODEL]?.remainingPercentage).toBe(90);
  });
});

  it("checks shared family summary quota (claude_gpt_session / weekly)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"));
    mocks.getAntigravityUsage.mockResolvedValue({
      quotas: {
        claude_gpt_session: { remainingPercentage: 0, resetAt: FUTURE_RESET },
        claude_gpt_weekly: { remainingPercentage: 50, resetAt: "2026-09-02T00:00:00.000Z" },
      }
    });

    try {
      const reset = await handleAntigravityQuotaError("ag-family", 429, "claude-sonnet-5-5", "token", {});
      expect(reset).toBe(Date.parse(FUTURE_RESET));
      expect(getAntigravityQuotaCache().get("ag-family")["claude-sonnet-5-5"]).toMatchObject({
        remainingPercentage: 0,
        resetAt: FUTURE_RESET,
      });

      // auth pre-filter should skip this account for claude-sonnet-5-5 based on cache
      mocks.getProviderConnections.mockResolvedValue([
        { id: "ag-family", email: "family@example.com", isActive: true },
        { id: "ag-other", email: "other@example.com", isActive: true },
      ]);
      const creds = await getProviderCredentials("antigravity", null, "claude-sonnet-5-5");
      expect(creds.connectionId).toBe("ag-other");
    } finally {
      vi.useRealTimers();
    }
  });

  it("checks shared family summary quota for gemini models", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"));
    mocks.getAntigravityUsage.mockResolvedValue({
      quotas: {
        gemini_weekly: { remainingPercentage: 0, resetAt: FUTURE_RESET },
      }
    });

    try {
      const reset = await handleAntigravityQuotaError("ag-gem", 429, "gemini-3.8-flash-high", "token", {});
      expect(reset).toBe(Date.parse(FUTURE_RESET));
      expect(getAntigravityQuotaCache().get("ag-gem")["gemini-3.8-flash-high"]).toMatchObject({
        remainingPercentage: 0,
        resetAt: FUTURE_RESET,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("checks separate gemini_argon_weekly summary quota for Gemini 4 Argon models without blocking other Gemini models", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"));
    mocks.getAntigravityUsage.mockResolvedValue({
      quotas: {
        gemini_argon_weekly: { remainingPercentage: 0, resetAt: FUTURE_RESET },
        gemini_weekly: { remainingPercentage: 100, resetAt: "2026-09-02T00:00:00.000Z" },
        gemini_session: { remainingPercentage: 100, resetAt: "2026-08-26T05:00:00.000Z" },
      }
    });

    try {
      const reset = await handleAntigravityQuotaError("ag-argon", 429, "gemini-4-argon-low", "token", {});
      expect(reset).toBe(Date.parse(FUTURE_RESET));
      expect(getAntigravityQuotaCache().get("ag-argon")["gemini-4-argon-low"]).toMatchObject({
        remainingPercentage: 0,
        resetAt: FUTURE_RESET,
      });

      mocks.getProviderConnections.mockResolvedValue([
        { id: "ag-argon", email: "argon@example.com", isActive: true },
        { id: "ag-other", email: "other@example.com", isActive: true },
      ]);
      // Exhausted for Argon -> routes to ag-other
      const argonCreds = await getProviderCredentials("antigravity", null, "gemini-4-argon-high");
      expect(argonCreds.connectionId).toBe("ag-other");

      // Still healthy for regular Gemini 3.8 Flash -> routes to ag-argon
      const flashCreds = await getProviderCredentials("antigravity", null, "gemini-3.8-flash-high");
      expect(flashCreds.connectionId).toBe("ag-argon");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not cap chat or image concurrency unless a per-provider limit is configured", async () => {
    mocks.getSettings.mockResolvedValue({});
    mocks.getProviderConnections.mockResolvedValue([{ id: "solo", isActive: true }]);
    const chat = await Promise.all([1, 2, 3].map(() => getProviderCredentials("openrouter", null, "m", { reserveChatSlot: true })));
    expect(chat.map((c) => c.connectionId)).toEqual(["solo", "solo", "solo"]);
    expect(chat.every((c) => c.releaseChatSlot === undefined && !c.waitForChatSlot)).toBe(true);
    const image = await Promise.all([1, 2].map(() => getProviderCredentials("codex", null, "m", { reserveImageSlot: true })));
    expect(image.map((c) => c.connectionId)).toEqual(["solo", "solo"]);
    expect(image.every((c) => c.releaseImageSlot === undefined && !c.waitForImageSlot)).toBe(true);
  });

  it("queues chat and image requests once a per-provider limit is configured", async () => {
    mocks.getSettings.mockResolvedValue({ sessionMaxConcurrent: { openrouter: 1 }, imageMaxConcurrent: { codex: 1 } });
    mocks.getProviderConnections.mockResolvedValue([{ id: "capped", isActive: true }]);
    const firstChat = await getProviderCredentials("openrouter", null, "m", { reserveChatSlot: true });
    const secondChat = await getProviderCredentials("openrouter", null, "m", { reserveChatSlot: true });
    expect(firstChat.connectionId).toBe("capped");
    expect(typeof secondChat.waitForChatSlot).toBe("function");
    firstChat.releaseChatSlot();
    const firstImage = await getProviderCredentials("codex", null, "m", { reserveImageSlot: true });
    const secondImage = await getProviderCredentials("codex", null, "m", { reserveImageSlot: true });
    expect(firstImage.connectionId).toBe("capped");
    expect(typeof secondImage.waitForImageSlot).toBe("function");
    firstImage.releaseImageSlot();
  });
