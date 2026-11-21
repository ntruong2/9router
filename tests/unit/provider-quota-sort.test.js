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
