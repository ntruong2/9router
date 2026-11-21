import { describe, expect, it, vi } from "vitest";
import { getProviderCredentials, markAccountUnavailable } from "@/sse/services/auth.js";
import { handleChat, scopeSessionId } from "@/sse/handlers/chat.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: vi.fn(),
  extractApiKey: () => null,
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({ checkAndRefreshToken: async (_provider, credentials) => credentials }));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: vi.fn() }));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({}) }));
vi.mock("@/sse/services/model.js", () => ({
  getComboModels: async () => null,
  getModelInfo: async () => ({ provider: "codex", model: "test" }),
}));
vi.mock("@/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: async () => null,
  enforceKeyAccess: async () => null,
  filterAdapterModels: async (_access, models) => models,
}));

describe("session pin tenant scope", () => {
  it("isolates the same client session across API keys", () => {
    const first = scopeSessionId("conversation-1", "key-a");
    const second = scopeSessionId("conversation-1", "key-b");
    expect(first).not.toBe(second);
    expect(first).toContain(":conversation-1");
  });

  it("keeps local sessions stable without an API key", () => {
    expect(scopeSessionId("conversation-1", null)).toBe("conversation-1");
  });
});

it("uses one capacity wait budget across repeated wakeups", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
  try {
    const waitForChatSlot = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve(true), 1000)))
      .mockImplementationOnce((timeout) => new Promise((resolve) => setTimeout(() => resolve(false), timeout)));
    vi.mocked(getProviderCredentials).mockResolvedValue({ waitForChatSlot });
    const responsePromise = handleChat(new Request("http://localhost/api/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "codex/test", messages: [{ role: "user", content: "Test" }] }),
    }));

    await vi.advanceTimersByTimeAsync(1000);
    const waits = waitForChatSlot.mock.calls.map(([timeout]) => timeout);
    expect(waits[0]).toBe(1500);
    expect(waits[1]).toBeGreaterThan(0);
    expect(waits[1]).toBeLessThanOrEqual(500);
    await vi.advanceTimersByTimeAsync(1500);
    const response = await responsePromise;
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("2");
  } finally {
    vi.useRealTimers();
  }
});

it("passes the upstream Retry-After to the account cooldown", async () => {
  vi.mocked(getProviderCredentials).mockResolvedValue({ connectionId: "account-a" });
  vi.mocked(handleChatCore).mockResolvedValue({
    success: false,
    status: 429,
    error: "Rate limited",
    response: new Response(null, { status: 429, headers: { "Retry-After": "45" } }),
  });
  const response = await handleChat(new Request("http://localhost/api/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "codex/test", messages: [{ role: "user", content: "Test" }] }),
  }));
  expect(response.status).toBe(429);
  expect(markAccountUnavailable).toHaveBeenCalledWith("account-a", 429, "Rate limited", "codex", "test", undefined, "45");
});
