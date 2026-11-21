import { NextResponse } from "next/server";
import { getProviderConnections, getSettings } from "@/lib/localDb";
import { explainSmartQuotaDecision } from "@/shared/services/smartQuotaDecision.js";
import { quotaAccountExclusion } from "@/sse/services/auth.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";

export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    const body = await request.json();
    const provider = typeof body?.provider === "string" ? resolveProviderId(body.provider.trim()) : "";
    const model = typeof body?.model === "string" ? body.model.trim() : "";
    if (!provider || !model || provider.length > 128 || model.length > 256) {
      return NextResponse.json({ error: "A valid provider and model are required" }, { status: 400 });
    }
    const [connections, settings] = await Promise.all([
      getProviderConnections({ provider }),
      getSettings(),
    ]);
    const exclusions = [];
    const eligible = FREE_PROVIDERS[provider]?.noAuth
      ? [{ id: "noauth", provider }]
      : connections.filter((connection) => {
          const reason = quotaAccountExclusion(connection, provider, model);
          if (reason) exclusions.push({ id: connection.id, reason });
          return !reason;
        });
    const decision = explainSmartQuotaDecision({
      connections: eligible, provider, model, settings, exclusions,
      comboName: typeof body.comboName === "string" ? body.comboName : undefined,
      isFallback: body.isFallback === true,
    });
    return NextResponse.json(decision, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Smart Use simulation failed" }, { status: 400 });
  }
}
