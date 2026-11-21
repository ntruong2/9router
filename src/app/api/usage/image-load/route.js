import { NextResponse } from "next/server";
import { getSettings, getProviderConnections } from "@/lib/localDb";
import { getImageLoadSnapshot } from "@/sse/services/auth.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const settings = await getSettings();
    const provider = new URL(request.url).searchParams.get("provider");
    const connections = await getProviderConnections(provider ? { provider, isActive: true } : { isActive: true });
    const names = new Map(connections.map((connection) => [connection.id, connection.displayName || connection.name || connection.email || connection.id]));
    const accounts = getImageLoadSnapshot(connections, settings)
      .filter((entry) => !provider || entry.provider === provider)
      .map((entry) => ({ ...entry, name: names.get(entry.connectionId) || entry.connectionId }));
    return NextResponse.json({ accounts, queueMaxSize: settings.imageQueueMaxSize, queueTimeoutMs: settings.imageQueueTimeoutMs }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[API] Failed to get image load:", error);
    return NextResponse.json({ error: "Failed to fetch image load" }, { status: 500 });
  }
}
