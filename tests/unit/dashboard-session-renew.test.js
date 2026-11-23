// Sliding dashboard session: active sessions are renewed (max once per hour), idle ones expire
// after 24h, and no session can be renewed past 30 days from the original login.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => { process.env.JWT_SECRET = "test-dashboard-session-secret"; });
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({}) }));

const { SignJWT, decodeJwt } = await import("jose");
const {
  createDashboardAuthToken, renewDashboardAuthToken, renewDashboardSession, verifyDashboardAuthToken,
} = await import("../../src/lib/auth/dashboardSession.js");

const SECRET = new TextEncoder().encode("test-dashboard-session-secret");
const HOUR = 3600;
const T0 = Date.parse("2026-11-23T00:00:00Z");

function at(ms) { vi.useFakeTimers(); vi.setSystemTime(ms); }
afterEach(() => vi.useRealTimers());

function fakeRequest(token) {
  return { cookies: { get: () => (token ? { value: token } : undefined) }, headers: new Headers({ "x-forwarded-proto": "https" }) };
}
function fakeResponse() {
  const set = vi.fn();
  return { cookies: { set } };
}

describe("dashboard session renewal", () => {
  it("does not renew a token younger than an hour", async () => {
    at(T0);
    const token = await createDashboardAuthToken();
    at(T0 + 30 * 60_000);
    expect(await renewDashboardAuthToken(token)).toBeNull();
  });

  it("renews an active session and keeps the original login time", async () => {
    at(T0);
    const token = await createDashboardAuthToken({ authMethod: "oidc" });
    at(T0 + 20 * HOUR * 1000);
    const renewed = await renewDashboardAuthToken(token);
    expect(renewed).toBeTruthy();
    const payload = decodeJwt(renewed);
    expect(payload).toMatchObject({ authenticated: true, authMethod: "oidc", authAt: T0 / 1000 });
    expect(payload.exp).toBe(T0 / 1000 + 44 * HOUR);
    // still valid after the original 24h would have expired
    at(T0 + 30 * HOUR * 1000);
    expect(await verifyDashboardAuthToken(token)).toBe(false);
    expect(await verifyDashboardAuthToken(renewed)).toBe(true);
  });

  it("stops at 30 days from the original login", async () => {
    at(T0);
    let token = await createDashboardAuthToken();
    for (let h = 20; h < 30 * 24; h += 20) {
      at(T0 + h * HOUR * 1000);
      token = (await renewDashboardAuthToken(token)) || token;
    }
    expect(decodeJwt(token).exp).toBeLessThanOrEqual(T0 / 1000 + 30 * 24 * HOUR);
    at(T0 + 30 * 24 * HOUR * 1000 + 1000);
    expect(await verifyDashboardAuthToken(token)).toBe(false);
    expect(await renewDashboardAuthToken(token)).toBeNull();
  });

  it("never renews invalid or forged tokens", async () => {
    at(T0 + 2 * HOUR * 1000);
    const forged = await new SignJWT({ authenticated: true }).setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(T0 / 1000).setExpirationTime("24h").sign(new TextEncoder().encode("other-secret"));
    expect(await renewDashboardAuthToken(forged)).toBeNull();
    expect(await renewDashboardAuthToken("not-a-jwt")).toBeNull();
    expect(await renewDashboardAuthToken(undefined)).toBeNull();
  });

  it("renews legacy tokens without authAt from their issue time", async () => {
    at(T0);
    const legacy = await new SignJWT({ authenticated: true }).setProtectedHeader({ alg: "HS256" })
      .setIssuedAt().setExpirationTime("24h").sign(SECRET);
    at(T0 + 2 * HOUR * 1000);
    expect(decodeJwt(await renewDashboardAuthToken(legacy)).authAt).toBe(T0 / 1000);
  });

  it("sets an httpOnly cookie on the proxy response only when due", async () => {
    at(T0);
    const token = await createDashboardAuthToken();
    const early = fakeResponse();
    await renewDashboardSession(fakeRequest(token), early);
    expect(early.cookies.set).not.toHaveBeenCalled();

    at(T0 + 2 * HOUR * 1000);
    const due = fakeResponse();
    expect(await renewDashboardSession(fakeRequest(token), due)).toBe(due);
    expect(due.cookies.set).toHaveBeenCalledWith("auth_token", expect.any(String), expect.objectContaining({
      httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 24 * HOUR,
    }));
  });
});
