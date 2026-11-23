import { SignJWT, jwtVerify, decodeJwt } from "jose";
import bcrypt from "bcryptjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "@/lib/dataDir";
import { getSettings } from "@/lib/localDb";

const DEFAULT_PASSWORD = "123456";
const SESSION_MAX_AGE_SEC = 24 * 60 * 60;
// Sliding session: an active dashboard gets a fresh 24h token at most once per hour, so it is
// not logged out mid-use; an idle one still expires after 24h. authAt (the original login time)
// caps renewal so a leaked token cannot be kept alive forever.
const SESSION_RENEW_AFTER_SEC = 60 * 60;
const SESSION_ABSOLUTE_MAX_SEC = 30 * 24 * 60 * 60;
const AUTH_COOKIE = "auth_token";

function loadJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(DATA_DIR, "jwt-secret");
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {}
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const generated = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, generated, { mode: 0o600 });
  return generated;
}

const SECRET = new TextEncoder().encode(loadJwtSecret());

export function shouldUseSecureCookie(request) {
  const forceSecureCookie = process.env.AUTH_COOKIE_SECURE === "true";
  const forwardedProto = request?.headers?.get?.("x-forwarded-proto");
  const isHttpsRequest = forwardedProto === "https";
  return forceSecureCookie || isHttpsRequest;
}

const nowSec = () => Math.floor(Date.now() / 1000);

export async function createDashboardAuthToken(claims = {}) {
  const now = nowSec();
  const authAt = Number.isInteger(claims.authAt) ? claims.authAt : now;
  return new SignJWT({ authenticated: true, ...claims, authAt })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(Math.min(now + SESSION_MAX_AGE_SEC, authAt + SESSION_ABSOLUTE_MAX_SEC))
    .sign(SECRET);
}

function authCookieOptions(request, maxAge = SESSION_MAX_AGE_SEC) {
  return {
    httpOnly: true,
    secure: shouldUseSecureCookie(request),
    sameSite: "lax",
    path: "/",
    maxAge,
  };
}

/** A fresh token for a valid session that is due for renewal, else null. */
export async function renewDashboardAuthToken(token) {
  if (!token) return null;
  let payload;
  try {
    ({ payload } = await jwtVerify(token, SECRET));
  } catch {
    return null;
  }
  const now = nowSec();
  if (!Number.isFinite(payload.iat) || now - payload.iat < SESSION_RENEW_AFTER_SEC) return null;
  // Tokens issued before authAt existed: their iat is the best known login time.
  const authAt = Number.isInteger(payload.authAt) ? payload.authAt : payload.iat;
  if (now - authAt >= SESSION_ABSOLUTE_MAX_SEC) return null;
  const { iat: _iat, exp: _exp, nbf: _nbf, ...claims } = payload;
  return createDashboardAuthToken({ ...claims, authAt });
}

/** Attach a renewed session cookie to a proxy response when the request's session is due. */
export async function renewDashboardSession(request, response) {
  try {
    const renewed = await renewDashboardAuthToken(request.cookies.get(AUTH_COOKIE)?.value);
    if (renewed && response?.cookies?.set) {
      const { exp } = decodeJwt(renewed);
      const maxAge = Math.max(0, Math.min(SESSION_MAX_AGE_SEC, exp - nowSec()));
      response.cookies.set(AUTH_COOKIE, renewed, authCookieOptions(request, maxAge));
    }
  } catch { /* renewal is best-effort; the current token stays valid */ }
  return response;
}

export async function verifyDashboardAuthToken(token) {
  if (!token) return false;
  try {
    await jwtVerify(token, SECRET);
    return true;
  } catch {
    return false;
  }
}

export async function getDashboardAuthSession(token) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, SECRET);
    return payload;
  } catch {
    return null;
  }
}

export async function setDashboardAuthCookie(cookieStore, request, claims = {}) {
  const token = await createDashboardAuthToken(claims);
  cookieStore.set(AUTH_COOKIE, token, authCookieOptions(request));
}

export function clearDashboardAuthCookie(cookieStore) {
  cookieStore.delete(AUTH_COOKIE);
}

// Verify the current dashboard password (re-auth for sensitive actions).
export async function verifyDashboardPassword(password) {
  if (typeof password !== "string" || !password) return false;
  const settings = await getSettings();
  const storedHash = settings?.password;
  if (storedHash) return bcrypt.compare(password, storedHash);
  const initialPassword = process.env.INITIAL_PASSWORD || DEFAULT_PASSWORD;
  return password === initialPassword;
}
