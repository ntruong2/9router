import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { resetComboRotation } from "open-sse/services/combo.js";
import bcrypt from "bcryptjs";
import { MAX_SESSION_CONCURRENCY } from "@/shared/services/sessionLoad.js";
import { MAX_IMAGE_CONCURRENT } from "@/shared/services/imageLoad.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SETTINGS_RESPONSE_HEADERS = {
  "Cache-Control": "no-store"
};

// Secrets must never be mass-assigned from request body (CWE-915)
const PROTECTED_SETTING_KEYS = ["password", "mitmSudoEncrypted"];

export async function GET() {
  try {
    const settings = await getSettings();
    const { password, oidcClientSecret, ...safeSettings } = settings;
    safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);
    
    const enableRequestLogs = process.env.ENABLE_REQUEST_LOGS === "true";
    const enableTranslator = process.env.ENABLE_TRANSLATOR === "true";
    
    return NextResponse.json({ 
      ...safeSettings, 
      enableRequestLogs,
      enableTranslator,
      hasPassword: !!password
    }, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error getting settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();

    // Strip protected secrets before any internal handling sets them
    for (const key of PROTECTED_SETTING_KEYS) delete body[key];
    if (Object.hasOwn(body, "smartQuotaUse") && typeof body.smartQuotaUse !== "boolean") {
      return NextResponse.json({ error: "smartQuotaUse must be a boolean" }, { status: 400 });
    }
    for (const key of ["smartQuotaForecast", "smartQuotaAlerts"]) {
      if (Object.hasOwn(body, key) && typeof body[key] !== "boolean") {
        return NextResponse.json({ error: `${key} must be a boolean` }, { status: 400 });
      }
    }
    if (Object.hasOwn(body, "smartQuotaBackgroundRefresh") && typeof body.smartQuotaBackgroundRefresh !== "boolean") {
      return NextResponse.json({ error: "smartQuotaBackgroundRefresh must be a boolean" }, { status: 400 });
    }
    if (Object.hasOwn(body, "codexSessionPin") && typeof body.codexSessionPin !== "boolean") {
      return NextResponse.json({ error: "codexSessionPin must be a boolean" }, { status: 400 });
    }
    for (const [key, isValid, description] of [
      ["sessionPin", (value) => typeof value === "boolean", "booleans"],
      ["sessionMaxConcurrent", (value) => Number.isInteger(value) && value >= 1 && value <= MAX_SESSION_CONCURRENCY,
        `integers from 1 to ${MAX_SESSION_CONCURRENCY}`],
      ["imageMaxConcurrent", (value) => Number.isInteger(value) && value >= 1 && value <= MAX_IMAGE_CONCURRENT,
        `integers from 1 to ${MAX_IMAGE_CONCURRENT}`],
    ]) {
      if (!Object.hasOwn(body, key)) continue;
      const values = body[key];
      if (!values || typeof values !== "object" || Array.isArray(values) || Object.keys(values).length > 512 ||
          Object.entries(values).some(([id, value]) => !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(id) ||
            Object.hasOwn(Object.prototype, id) || !isValid(value))) {
        return NextResponse.json({ error: `${key} must map provider IDs to ${description}` }, { status: 400 });
      }
    }
    for (const [key, min, max] of [["imageQueueMaxSize", 1, 500], ["imageQueueTimeoutMs", 1000, 300000]]) {
      if (Object.hasOwn(body, key) && (!Number.isInteger(body[key]) || body[key] < min || body[key] > max)) {
        return NextResponse.json({ error: `${key} must be between ${min} and ${max}` }, { status: 400 });
      }
    }
    for (const [key, min, max] of [["smartQuotaRefreshIntervalMs", 60_000, 600_000], ["smartQuotaRefreshConcurrency", 1, 8], ["smartQuotaRefreshJitterMs", 0, 60_000]]) {
      if (Object.hasOwn(body, key)) {
        const value = body[key];
        if (!Number.isInteger(value) || value < min || value > max) {
          return NextResponse.json({ error: `${key} must be between ${min} and ${max}` }, { status: 400 });
        }
      }
    }
    if (Object.hasOwn(body, "paidFallback")) {
      const policy = body.paidFallback;
      if (!policy || typeof policy !== "object" || typeof policy.enabled !== "boolean" ||
          [policy.providers, policy.combos].some((list) =>
            list !== undefined && (!Array.isArray(list) || list.length > 200 ||
              list.some((value) => typeof value !== "string" || !value.trim() || value.length > 128)))) {
        return NextResponse.json({ error: "paidFallback must contain enabled, providers, and combos" }, { status: 400 });
      }
    }

    // If updating password, hash it
    if (body.newPassword) {
      const settings = await getSettings();
      const currentHash = settings.password;

      // Verify current password if it exists
      if (currentHash) {
        if (!body.currentPassword) {
          return NextResponse.json({ error: "Current password required" }, { status: 400 });
        }
        const isValid = await bcrypt.compare(body.currentPassword, currentHash);
        if (!isValid) {
          return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      } else {
        // First time setting password, no current password needed
        // Allow empty currentPassword or default "123456"
        if (body.currentPassword && body.currentPassword !== "123456") {
           return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      }

      const salt = await bcrypt.genSalt(10);
      body.password = await bcrypt.hash(body.newPassword, salt);
      delete body.newPassword;
      delete body.currentPassword;
    }

    if (Object.prototype.hasOwnProperty.call(body, "oidcClientSecret")) {
      if (!body.oidcClientSecret || !String(body.oidcClientSecret).trim()) {
        delete body.oidcClientSecret;
      }
    }

    const settings = await updateSettings(body);

    // Apply outbound proxy settings immediately (no restart required)
    if (
      Object.prototype.hasOwnProperty.call(body, "outboundProxyEnabled") ||
      Object.prototype.hasOwnProperty.call(body, "outboundProxyUrl") ||
      Object.prototype.hasOwnProperty.call(body, "outboundNoProxy")
    ) {
      applyOutboundProxyEnv(settings);
    }

    // Invalidate combo rotation state when strategy settings change
    if (
      Object.prototype.hasOwnProperty.call(body, "comboStrategy") ||
      Object.prototype.hasOwnProperty.call(body, "comboStickyRoundRobinLimit") ||
      Object.prototype.hasOwnProperty.call(body, "comboStrategies")
    ) {
      resetComboRotation();
    }

    if (
      Object.prototype.hasOwnProperty.call(body, "claudeAutoPing") ||
      Object.prototype.hasOwnProperty.call(body, "codexAutoPing")
    ) {
      // Keep the scheduler absent when no account opted in; load its provider graph only on demand.
      import("@/shared/services/quotaAutoPing")
        .then(({ configureQuotaAutoPing }) => {
          configureQuotaAutoPing(settings);
        })
        .catch((error) => console.warn("[AutoPing] settings update failed:", error.message));
    }

    if (Object.keys(body).some((key) => key.startsWith("smartQuotaRefresh")) || Object.hasOwn(body, "smartQuotaBackgroundRefresh")) {
      import("@/shared/services/smartQuotaRefresh")
        .then(({ configureSmartQuotaRefresh }) => configureSmartQuotaRefresh(settings))
        .catch((error) => console.warn("[SmartQuota] settings update failed:", error.message));
    }

    const { password, oidcClientSecret, ...safeSettings } = settings;
    safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);
    return NextResponse.json(safeSettings, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error updating settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
