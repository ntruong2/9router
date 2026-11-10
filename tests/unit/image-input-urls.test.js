// Gemini / Antigravity only take inline image bytes: URL references must be downloaded
// (through the SSRF-hardened fetcher) instead of being silently dropped.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (host) => (host === "evil.example"
    ? [{ address: "127.0.0.1", family: 4 }]
    : [{ address: "93.184.215.14", family: 4 }])),
}));

const executor = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => executor }));

const { default: gemini } = await import("../../open-sse/handlers/imageProviders/gemini.js");
const { default: antigravity } = await import("../../open-sse/handlers/imageProviders/antigravity.js");

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG_B64 = Buffer.from(PNG).toString("base64");
const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn(async () => new Response(PNG, { status: 200, headers: { "Content-Type": "image/png" } }));
  executor.execute.mockReset();
  executor.execute.mockResolvedValue({ response: new Response(JSON.stringify({ candidates: [] }), { status: 200 }) });
});
afterEach(() => { global.fetch = originalFetch; });

describe("gemini adapter", () => {
  it("downloads a URL image and sends it inline", async () => {
    const body = await gemini.buildBody("gemini-2.5-flash-image", { prompt: "p", image: "https://cdn.example/a.png" });
    expect(body.contents[0].parts[0]).toEqual({ inlineData: { mimeType: "image/png", data: PNG_B64 } });
    expect(global.fetch).toHaveBeenCalledWith("https://cdn.example/a.png", expect.objectContaining({ redirect: "manual" }));
  });

  it("rejects a URL that resolves to an internal host", async () => {
    await expect(gemini.buildBody("m", { prompt: "p", image: "https://evil.example/a.png" })).rejects.toMatchObject({ status: 400 });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("leaves data URLs untouched", async () => {
    const body = await gemini.buildBody("m", { prompt: "p", images: [`data:image/jpeg;base64,${PNG_B64}`] });
    expect(body.contents[0].parts[0].inlineData.mimeType).toBe("image/jpeg");
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("antigravity adapter", () => {
  it("downloads URL references (string and { image_url }) and sends them inline", async () => {
    await antigravity.executeViaExecutor("gemini-3.1-flash-image", {
      prompt: "p",
      images: ["https://cdn.example/a.png", { image_url: { url: "https://cdn.example/b.png" } }, `data:image/png;base64,${PNG_B64}`],
    }, {}, null);
    const parts = executor.execute.mock.calls[0][0].body.contents[0].parts;
    expect(parts).toHaveLength(4);
    expect(parts.slice(0, 3).every((p) => p.inlineData?.data === PNG_B64)).toBe(true);
    expect(parts[3]).toEqual({ text: "p" });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects internal URLs with a request-scoped 400 before calling upstream", async () => {
    await expect(antigravity.executeViaExecutor("m", { prompt: "p", image: "http://169.254.169.254/latest/meta-data" }, {}, null))
      .rejects.toMatchObject({ status: 400 });
    expect(executor.execute).not.toHaveBeenCalled();
  });
});
