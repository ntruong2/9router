import { describe, expect, it } from "vitest";
import codexImageAdapter from "../../open-sse/handlers/imageProviders/codex.js";

describe("Codex image adapter reasoning", () => {
  it.each([
    "gpt-image-1.5",
    "gpt-image-2",
    "gpt-image-2.5",
    "gpt-image-2.5-flare",
    "gpt-image-2.5-sunburst",
    "gpt-image-2.6",
    "gpt-image-2.6-flare",
    "gpt-image-2.6-sunburst",
  ])("sends no reasoning for %s, whose complexity Codex rejects", (model) => {
    // An explicit size keeps the request on the Responses image tool (the native
    // Images endpoint only serves auto-sized PNGs); that path carries `reasoning`.
    const body = codexImageAdapter.buildBody(model, { prompt: "apple", size: "1024x1024" });
    expect(body.reasoning).toBeNull();
    expect(body.tools[0].model).toBe(model);
  });

  it("sends no reasoning on the native Images endpoint either", () => {
    const body = codexImageAdapter.buildBody("gpt-image-2.6", { prompt: "apple" });
    expect(body.model).toBe("gpt-image-2.6");
    expect(body.reasoning).toBeUndefined();
    expect(body.tools).toBeUndefined();
  });
});
