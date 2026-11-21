import { beforeEach, describe, expect, it } from "vitest";
import {
  createImageLoadState,
  getImageLoad,
  reserveImageSlot,
  releaseImageSlot,
  snapshotImageLoad,
  waitForImageSlot,
} from "@/shared/services/imageLoad.js";

describe("image load control", () => {
  let state;
  beforeEach(() => { state = createImageLoadState(); });

  it("limits one image job per account by default", () => {
    const release = reserveImageSlot(state, "a");
    expect(reserveImageSlot(state, "a")).toBeNull();
    expect(getImageLoad(state, "a")).toMatchObject({ running: 1, maxConcurrent: 1, overloaded: true });
    release();
    expect(getImageLoad(state, "a").running).toBe(0);
  });

  it("wakes a queued job when an image slot is released", async () => {
    const release = reserveImageSlot(state, "a");
    const waiting = waitForImageSlot(state, 1000);
    release();
    await expect(waiting).resolves.toBe(true);
  });

  it("reports image load for active accounts", () => {
    reserveImageSlot(state, "a", { maxConcurrent: 2 });
    expect(snapshotImageLoad(state, [{ id: "a", provider: "codex" }], { codex: 2 }))
      .toEqual([expect.objectContaining({ connectionId: "a", running: 1, maxConcurrent: 2 })]);
  });
});
