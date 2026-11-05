import { describe, expect, it } from "vitest";
import codexImageAdapter from "../../open-sse/handlers/imageProviders/codex.js";

describe("Codex image adapter reasoning", () => {
  it("omits reasoning for Sunburst, which rejects every complexity", () => {
    const body = codexImageAdapter.buildBody("gpt-image-2.5-sunburst", { prompt: "apple" });
    expect(body.reasoning).toBeNull();
    expect(body.tools[0].model).toBe("gpt-image-2.5-sunburst");
  });

  it("keeps medium effort for other tool image models", () => {
    const body = codexImageAdapter.buildBody("gpt-image-2.5-flare", { prompt: "apple" });
    expect(body.reasoning).toEqual({ effort: "medium", summary: "auto" });
  });
});
