import { describe, expect, it } from "vitest";
import codexImageAdapter from "../../open-sse/handlers/imageProviders/codex.js";

const TOOL_MODELS = [
  "gpt-image-1.5",
  "gpt-image-2",
  "gpt-image-2.5",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
];

describe("Codex image adapter complexity", () => {
  it.each(TOOL_MODELS)("sends no reasoning for %s", (model) => {
    const body = codexImageAdapter.buildBody(model, { prompt: "apple" });
    expect(body.reasoning).toBeNull();
    expect(body.tools[0].model).toBe(model);
    expect(body.tools[0]).not.toHaveProperty("complexity");
  });

  it("puts complexity on the image tool", () => {
    const body = codexImageAdapter.buildBody("gpt-image-2.5", { prompt: "apple", complexity: "xhigh" });
    expect(body.tools[0].complexity).toBe("xhigh");
    expect(body.reasoning).toBeNull();
  });

  it("ignores complexity for chat-hosted image models", () => {
    const body = codexImageAdapter.buildBody("gpt-6-sol-image", { prompt: "apple", complexity: "low" });
    expect(body.tools[0]).not.toHaveProperty("complexity");
  });
});
