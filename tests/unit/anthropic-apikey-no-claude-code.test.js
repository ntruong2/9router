// Anthropic API keys whose balance is API credit are refused with 400 "Your credit
// balance is too low" for any request that presents itself as Claude Code (the
// claude-code beta flag, or the "You are Claude Code" system prompt) — the same key
// answers plain API requests. The anthropic provider must send neither.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { CLAUDE_SYSTEM_PROMPT } from "open-sse/config/appConstants.js";

const betaFlags = (headers) => (headers["Anthropic-Beta"] || "").split(",").map((s) => s.trim()).filter(Boolean);

describe("anthropic API-key provider does not present as Claude Code", () => {
  let DefaultExecutor;

  beforeEach(async () => {
    vi.resetModules();
    ({ DefaultExecutor } = await import("open-sse/executors/default.js"));
  });

  it("does not send the claude-code beta flag by default", () => {
    const flags = betaFlags(new DefaultExecutor("anthropic").buildHeaders({ apiKey: "k" }, true, undefined, "claude-opus-5-5"));
    expect(flags).not.toContain("claude-code-20250219");
    expect(flags).toContain("interleaved-thinking-2025-05-14");
  });

  it("drops a claude-code flag forwarded by the client but keeps the others", () => {
    const rawHeaders = { "anthropic-beta": "claude-code-20250219,context-1m-2025-08-07" };
    const flags = betaFlags(new DefaultExecutor("anthropic").buildHeaders({ apiKey: "k", rawHeaders }, true, undefined, "claude-opus-5-5"));
    expect(flags).not.toContain("claude-code-20250219");
    expect(flags).toContain("context-1m-2025-08-07");
  });

  it("removes only the injected Claude Code system block", () => {
    const body = {
      model: "claude-opus-5-5",
      system: [{ type: "text", text: CLAUDE_SYSTEM_PROMPT }, { type: "text", text: "Be terse." }],
      messages: [{ role: "user", content: "hi" }],
    };
    const out = new DefaultExecutor("anthropic").transformRequest("claude-opus-5-5", body, true, { apiKey: "k" });
    expect(out.system).toEqual([{ type: "text", text: "Be terse." }]);
  });

  it("drops system entirely when the injected block was the only one", () => {
    const body = { model: "claude-opus-5-5", system: [{ type: "text", text: CLAUDE_SYSTEM_PROMPT }], messages: [{ role: "user", content: "hi" }] };
    const out = new DefaultExecutor("anthropic").transformRequest("claude-opus-5-5", body, true, { apiKey: "k" });
    expect(out.system).toBeUndefined();
  });

  it("leaves the claude (OAuth) provider untouched", () => {
    const body = { model: "claude-opus-5-5", system: [{ type: "text", text: CLAUDE_SYSTEM_PROMPT }], messages: [{ role: "user", content: "hi" }] };
    const out = new DefaultExecutor("claude").transformRequest("claude-opus-5-5", body, true, { accessToken: "t" });
    expect(out.system).toEqual([{ type: "text", text: CLAUDE_SYSTEM_PROMPT }]);
    expect(betaFlags(new DefaultExecutor("claude").buildHeaders({ apiKey: "k" }, true, undefined, "claude-opus-5-5"))).toContain("claude-code-20250219");
  });
});
