// Anthropic does not bill API credit (e.g. a promotional grant scoped to the API)
// for requests that present as Claude Code: such a request with an API key gets
// 400 "Your credit balance is too low" while plain requests with the same key work.
// 9router must not add Claude Code markers of its own to anthropic API-key requests,
// but a client that really is Claude Code is forwarded as it is.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { CLAUDE_SYSTEM_PROMPT } from "open-sse/config/appConstants.js";

const betaFlags = (headers) => (headers["Anthropic-Beta"] || "").split(",").map((s) => s.trim()).filter(Boolean);
const hasInjectedPrompt = (body) => Array.isArray(body.system) && body.system.some((b) => b?.text === CLAUDE_SYSTEM_PROMPT);

describe("anthropic API-key provider adds no Claude Code markers", () => {
  let DefaultExecutor, translateRequest, FORMATS;

  beforeEach(async () => {
    vi.resetModules();
    ({ DefaultExecutor } = await import("open-sse/executors/default.js"));
    ({ translateRequest } = await import("open-sse/translator/index.js"));
    ({ FORMATS } = await import("open-sse/translator/formats.js"));
  });

  const openaiBody = (system) => ({
    model: "claude-opus-5-5",
    messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: "hi" }],
  });

  it("does not send the claude-code beta flag by default", () => {
    const flags = betaFlags(new DefaultExecutor("anthropic").buildHeaders({ apiKey: "k" }, true, undefined, "claude-opus-5-5"));
    expect(flags).not.toContain("claude-code-20250219");
    expect(flags).toContain("interleaved-thinking-2025-05-14");
  });

  it("forwards a claude-code flag sent by the client itself", () => {
    const rawHeaders = { "anthropic-beta": "claude-code-20250219,context-1m-2025-08-07" };
    const flags = betaFlags(new DefaultExecutor("anthropic").buildHeaders({ apiKey: "k", rawHeaders }, true, undefined, "claude-opus-5-5"));
    expect(flags).toContain("claude-code-20250219");
    expect(flags).toContain("context-1m-2025-08-07");
  });

  it("drops the prompt the openai->claude translator injects, keeping the caller's system text", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "claude-opus-5-5", openaiBody("Be terse."), true, { apiKey: "k" }, "anthropic");
    expect(hasInjectedPrompt(out)).toBe(false);
    expect(JSON.stringify(out.system)).toContain("Be terse.");
  });

  it("sends no system at all when the caller gave none", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "claude-opus-5-5", openaiBody(), true, { apiKey: "k" }, "anthropic");
    expect(out.system).toBeUndefined();
  });

  it("forwards a native Claude request (a real Claude Code client) unchanged", () => {
    const body = {
      model: "claude-opus-5-5",
      system: [{ type: "text", text: CLAUDE_SYSTEM_PROMPT }, { type: "text", text: "Be terse." }],
      messages: [{ role: "user", content: "hi" }],
    };
    const translated = translateRequest(FORMATS.CLAUDE, FORMATS.CLAUDE, "claude-opus-5-5", body, true, { apiKey: "k" }, "anthropic");
    const out = new DefaultExecutor("anthropic").transformRequest("claude-opus-5-5", translated, true, { apiKey: "k" });
    expect(out.system[0]).toEqual({ type: "text", text: CLAUDE_SYSTEM_PROMPT });
  });

  it("keeps the injected prompt and flag for the claude (OAuth) provider", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "claude-opus-5-5", openaiBody(), true, { accessToken: "t" }, "claude");
    expect(hasInjectedPrompt(out)).toBe(true);
    expect(betaFlags(new DefaultExecutor("claude").buildHeaders({ apiKey: "k" }, true, undefined, "claude-opus-5-5"))).toContain("claude-code-20250219");
  });
});
