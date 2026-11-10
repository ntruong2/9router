// /v1/images/edits: multipart + JSON parsing, provider gating, auth-before-parse.
import { describe, it, expect, vi, beforeEach } from "vitest";

const fx = vi.hoisted(() => ({ settings: { requireApiKey: false, comboStrategy: "fallback" } }));
const mocks = vi.hoisted(() => ({
  core: vi.fn(),
  getProviderCredentials: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => fx.settings,
  getModelAliases: async () => ({}),
  getComboByName: async () => null,
  getProviderNodes: async () => [],
  getCombos: async () => [],
  getProviderConnections: async () => [],
  getProviderConnectionById: async () => null,
  getCustomModels: async () => [],
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({ getCombos: async () => [] }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: async () => null }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn() }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
  clearAccountError: vi.fn(),
  extractApiKey: (request) => {
    const a = request.headers.get("Authorization");
    return a?.startsWith("Bearer ") ? a.slice(7) : null;
  },
  isValidApiKey: async (k) => k === "sk-good",
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_p, c) => c,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/handlers/imageGenerationCore.js", () => ({ handleImageGenerationCore: mocks.core }));

const { parseImageEditRequest, handleImageEdit, MAX_EDIT_IMAGES } = await import("../../src/sse/handlers/imageEdit.js");

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const pngFile = (name = "a.png", type = "image/png") => new File([PNG], name, { type });

const multipart = (fields, headers = {}) => {
  const form = new FormData();
  for (const [k, v] of fields) form.append(k, v);
  return new Request("http://localhost/v1/images/edits", { method: "POST", body: form, headers });
};
const json = (body, headers = {}) => new Request("http://localhost/v1/images/edits", {
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  fx.settings = { requireApiKey: false, comboStrategy: "fallback" };
  mocks.getProviderCredentials.mockResolvedValue({ connectionId: "conn-1234567890", accessToken: "t" });
  mocks.core.mockResolvedValue({
    success: true,
    response: new Response(JSON.stringify({ created: 1, data: [{ b64_json: "AAA" }] }), { headers: { "Content-Type": "application/json" } }),
  });
});

describe("parseImageEditRequest — multipart (OpenAI SDK)", () => {
  it("reads image and image[] files as data URLs and coerces numeric fields", async () => {
    const res = await parseImageEditRequest(multipart([
      ["model", "codex/gpt-image-2.6"],
      ["prompt", "make it green"],
      ["n", "1"],
      ["size", "1024x1024"],
      ["image[]", pngFile()],
      ["image[]", new File([JPEG], "b.jpg", { type: "application/octet-stream" })],
      ["unknown_field", "dropped"],
    ]));
    expect(res.body).toMatchObject({ model: "codex/gpt-image-2.6", prompt: "make it green", n: 1, size: "1024x1024" });
    expect(res.body.images).toHaveLength(2);
    expect(res.body.images[0]).toMatch(/^data:image\/png;base64,/);
    // Declared octet-stream is sniffed to the real type.
    expect(res.body.images[1]).toMatch(/^data:image\/jpeg;base64,/);
    expect(res.body.unknown_field).toBeUndefined();
  });

  it("accepts a single `image` file and a mask file", async () => {
    const res = await parseImageEditRequest(multipart([
      ["model", "m"], ["prompt", "p"], ["image", pngFile()], ["mask", pngFile("mask.png")],
    ]));
    expect(res.body.images).toHaveLength(1);
    expect(res.body.mask).toMatch(/^data:image\/png;base64,/);
  });

  it("rejects a non-image upload with 415", async () => {
    const res = await parseImageEditRequest(multipart([
      ["model", "m"], ["prompt", "p"], ["image", new File([new TextEncoder().encode("hello world")], "x.png", { type: "image/png" })],
    ]));
    expect(res.status).toBe(415);
  });

  it("requires at least one image", async () => {
    const res = await parseImageEditRequest(multipart([["model", "m"], ["prompt", "p"]]));
    expect(res.status).toBe(400);
    expect(res.message).toContain("image");
  });

  it("caps the number of images", async () => {
    const fields = [["model", "m"], ["prompt", "p"]];
    for (let i = 0; i <= MAX_EDIT_IMAGES; i++) fields.push(["image[]", pngFile(`${i}.png`)]);
    const res = await parseImageEditRequest(multipart(fields));
    expect(res.status).toBe(400);
  });
});

describe("parseImageEditRequest — JSON", () => {
  it("accepts images as { image_url } objects and plain strings", async () => {
    const res = await parseImageEditRequest(json({
      model: "m", prompt: "p",
      images: [{ image_url: "https://example.com/a.png" }, "data:image/png;base64,AAAA"],
    }));
    expect(res.body.images).toEqual(["https://example.com/a.png", "data:image/png;base64,AAAA"]);
  });

  it("rejects file_id references", async () => {
    const res = await parseImageEditRequest(json({ model: "m", prompt: "p", images: [{ file_id: "file-1" }] }));
    expect(res.status).toBe(400);
    expect(res.message).toContain("file_id");
  });

  it("rejects strings that are not images", async () => {
    const res = await parseImageEditRequest(json({ model: "m", prompt: "p", image: "file:///etc/passwd" }));
    expect(res.status).toBe(400);
  });

  it("rejects URLs that point at internal hosts", async () => {
    for (const url of ["http://127.0.0.1:20127/v1/models", "http://169.254.169.254/latest/meta-data", "http://localhost/a.png", "http://192.168.1.1/a.png"]) {
      const res = await parseImageEditRequest(json({ model: "m", prompt: "p", image: url }));
      expect(res.status).toBe(400);
      expect(res.message).toContain("public host");
    }
  });

  it("rejects oversized bodies by Content-Length before reading", async () => {
    const req = json({ model: "m", prompt: "p", image: "https://x/a.png" }, { "Content-Length": String(200 * 1024 * 1024) });
    const res = await parseImageEditRequest(req);
    expect(res.status).toBe(413);
  });

  it("rejects other content types with 415", async () => {
    const req = new Request("http://localhost/v1/images/edits", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" });
    const res = await parseImageEditRequest(req);
    expect(res.status).toBe(415);
  });
});

describe("handleImageEdit", () => {
  it("checks the API key before parsing the upload", async () => {
    fx.settings = { requireApiKey: true };
    const req = multipart([["model", "codex/gpt-image-2.6"], ["prompt", "p"], ["image", pngFile()]]);
    const res = await handleImageEdit(req);
    expect(res.status).toBe(401);
    expect(req.bodyUsed).toBe(false);
    expect(mocks.core).not.toHaveBeenCalled();
  });

  it("routes a single image to body.image for codex", async () => {
    const res = await handleImageEdit(multipart([["model", "codex/gpt-image-2.6"], ["prompt", "p"], ["image", pngFile()]]));
    expect(res.status).toBe(200);
    const { body, modelInfo } = mocks.core.mock.calls[0][0];
    expect(modelInfo).toEqual({ provider: "codex", model: "gpt-image-2.6" });
    expect(body.image).toMatch(/^data:image\/png;base64,/);
    expect(body.images).toBeUndefined();
  });

  it("routes multiple images to body.images for a multi-image provider", async () => {
    await handleImageEdit(multipart([
      ["model", "codex/gpt-image-2.6"], ["prompt", "p"], ["image[]", pngFile()], ["image[]", pngFile("b.png")],
    ]));
    const { body } = mocks.core.mock.calls[0][0];
    expect(body.images).toHaveLength(2);
    expect(body.image).toBeUndefined();
  });

  it("rejects providers that would ignore the input image", async () => {
    const res = await handleImageEdit(json({ model: "openai/gpt-image-1", prompt: "p", image: "https://x/a.png" }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("does not support image edits");
    expect(mocks.core).not.toHaveBeenCalled();
  });

  it("rejects several images for a single-image provider", async () => {
    const res = await handleImageEdit(json({ model: "gemini/gemini-2.5-flash-image", prompt: "p", images: ["https://x/a.png", "https://x/b.png"] }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("only one input image");
  });

  it("rejects a mask for providers that cannot use one", async () => {
    const res = await handleImageEdit(json({ model: "codex/gpt-image-2.6", prompt: "p", image: "https://x/a.png", mask: "https://x/m.png" }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("mask");
  });
});

describe("inputUrlToBase64 (adapters that download input URLs)", () => {
  it("refuses internal hosts without fetching", async () => {
    const { inputUrlToBase64 } = await import("../../open-sse/handlers/imageProviders/_base.js");
    const spy = vi.spyOn(globalThis, "fetch");
    for (const url of ["http://127.0.0.1/a.png", "http://169.254.169.254/latest/meta-data", "http://10.0.0.5/a.png"]) {
      await expect(inputUrlToBase64(url)).rejects.toThrow(/rejected/);
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
