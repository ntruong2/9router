import { describe, expect, it } from "vitest";
import codexImageAdapter from "../../open-sse/handlers/imageProviders/codex.js";

describe("Codex image adapter reasoning", () => {
  it.each([
    "gpt-image-1.5",
    "gpt-image-2",
    "gpt-image-2.5",
    "gpt-image-2.5-flare",
    "gpt-image-2.5-sunburst",
  ])("sends no reasoning for %s, whose complexity Codex rejects", (model) => {
    const body = codexImageAdapter.buildBody(model, { prompt: "apple" });
    expect(body.reasoning).toBeNull();
    expect(body.tools[0].model).toBe(model);
  });
});
