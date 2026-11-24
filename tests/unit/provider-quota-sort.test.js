import { describe, expect, it } from "vitest";
import { getConnectionQuotaRemaining, sortVisibleConnections } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const accounts = [{ id: "a", provider: "codex", name: "a" }, { id: "b", provider: "codex", name: "b" }];

describe("provider quota sorting", () => {
  it("uses the lowest window percentage as the account quota", () => {
    const data = {
      a: { quotas: [{ remainingPercentage: 100 }, { remainingPercentage: 0 }] },
      b: { quotas: [{ remainingPercentage: 40 }, { remainingPercentage: 40 }] },
    };
    expect(getConnectionQuotaRemaining(accounts[0], data)).toBe(0);
    expect(sortVisibleConnections(accounts, data, false, "codex", "remaining-desc").map(({ id }) => id))
      .toEqual(["b", "a"]);
  });
});

describe("provider load sorting", () => {
  const conns = [
    { id: "a", provider: "codex", name: "a" },
    { id: "b", provider: "codex", name: "b" },
    { id: "c", provider: "codex", name: "c" },
  ];
  const sessionLoad = { b: { activeRequests: 1 }, c: { activeRequests: 3 } };
  const imageLoad = { a: { running: 2 }, b: { running: 0 } };

  it("puts the accounts with the most active requests first", () => {
    expect(sortVisibleConnections(conns, {}, false, "codex", "requests-desc", { sessionLoad, imageLoad }).map(({ id }) => id))
      .toEqual(["c", "b", "a"]);
  });

  it("puts the accounts running the most image jobs first and keeps idle ones in order", () => {
    expect(sortVisibleConnections(conns, {}, false, "codex", "images-desc", { sessionLoad, imageLoad }).map(({ id }) => id))
      .toEqual(["a", "b", "c"]);
  });
});
