import { NextResponse } from "next/server";
import { getProviderConnections } from "@/lib/localDb";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { getActiveRequests } from "@/lib/usageDb";

export const dynamic = "force-dynamic";

// Server-side cache so anonymous public traffic never triggers a fresh
// external quota check per request — refreshed at most once per interval.
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let cache = { data: null, expiresAt: 0 };

const PROVIDER_LABELS = {
  claude: "Claude Code",
  antigravity: "Antigravity",
  codex: "OpenAI Codex",
  gemini: "Gemini CLI",
  cline: "Cline",
  cursor: "Cursor IDE",
  github: "GitHub Copilot",
  kiro: "Kiro AI",
};

function extractQuotaInfo(usage) {
  const info = { percentUsed: null, resetAt: null };
  if (!usage || typeof usage !== "object") return info;
  if (typeof usage.percentUsed === "number") {
    info.percentUsed = Math.min(100, Math.max(0, Math.round(usage.percentUsed)));
  }
  const quotas = usage.quotas;
  if (quotas && typeof quotas === "object") {
    const first = Object.values(quotas)[0];
    if (first) {
      if (info.percentUsed === null && typeof first.used === "number") {
        info.percentUsed = Math.min(100, Math.max(0, Math.round(first.used)));
      }
      if (first.resetAt) info.resetAt = first.resetAt;
    }
  }
  return info;
}

// Only isActive matters for visibility — a rate-limited/erroring connection is
// still "connected" and should show up, just flagged so the UI can dim it.
function isEligible(conn) {
  return !!conn.isActive;
}

async function computeProviders() {
  const connections = await getProviderConnections({ isActive: true });
  const byProvider = new Map();
  for (const conn of connections) {
    if (!isEligible(conn)) continue;
    if (!byProvider.has(conn.provider)) byProvider.set(conn.provider, []);
    byProvider.get(conn.provider).push(conn);
  }

  const providers = [];
  for (const [providerId, conns] of byProvider) {
    const percentUsedValues = [];
    let earliestResetAt = null; // account with the soonest reset wins
    let earliestResetMs = Infinity;
    let errorCode = null;
    let erroringCount = 0;

    for (const conn of conns) {
      try {
        const usage = await getUsageForProvider(conn);
        const info = extractQuotaInfo(usage);
        if (typeof info.percentUsed === "number") percentUsedValues.push(info.percentUsed);
        if (info.resetAt) {
          const ms = new Date(info.resetAt).getTime();
          if (Number.isFinite(ms) && ms < earliestResetMs) {
            earliestResetMs = ms;
            earliestResetAt = info.resetAt;
          }
        }
      } catch {
        // Swallow — this account just doesn't contribute a %/reset value.
      }
      if (typeof conn.errorCode === "number") {
        erroringCount += 1;
        if (errorCode === null) errorCode = conn.errorCode;
      }
    }

    const percentUsed = percentUsedValues.length
      ? Math.round(percentUsedValues.reduce((sum, v) => sum + v, 0) / percentUsedValues.length)
      : null;

    providers.push({
      id: providerId,
      label: PROVIDER_LABELS[providerId] || providerId,
      percentUsed,
      resetAt: earliestResetAt,
      // Only flag the provider as rate-limited once *every* account on it is —
      // one healthy account among several still means requests can go through.
      errorCode: erroringCount > 0 && erroringCount === conns.length ? errorCode : null,
    });
  }
  return providers;
}

export async function GET() {
  const now = Date.now();
  if (!cache.data || cache.expiresAt <= now) {
    try {
      const providers = await computeProviders();
      cache = { data: { providers }, expiresAt: now + CACHE_TTL_MS };
    } catch {
      cache = { data: { providers: [] }, expiresAt: now + CACHE_TTL_MS };
    }
  }

  // Recomputed on every call — cheap local read, no external calls. Mirrors the
  // same three signals the real dashboard topology (ProviderTopology.js) uses:
  // in-flight requests, the most recent completed one, and any fresh error.
  let activeProviderIds = [];
  let lastProviderId = null;
  let errorProviderId = null;
  try {
    const { activeRequests, recentRequests, errorProvider } = await getActiveRequests();
    activeProviderIds = [
      ...new Set(activeRequests.map((r) => r.provider?.toLowerCase()).filter(Boolean)),
    ];
    lastProviderId = recentRequests[0]?.provider || null;
    errorProviderId = errorProvider || null;
  } catch {
    // ignore — animation just falls back to its idle cycle
  }

  return NextResponse.json({
    providers: cache.data.providers,
    activeProviderIds,
    lastProviderId,
    errorProviderId,
    updatedAt: new Date().toISOString(),
  });
}
