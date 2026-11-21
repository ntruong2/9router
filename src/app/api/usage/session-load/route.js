import { NextResponse } from "next/server";
import { getSettings, getProviderConnections } from "@/lib/localDb";
import { getSessionLoadSnapshot } from "@/sse/services/auth.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const settings = await getSettings();
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider");
    const connections = await getProviderConnections(provider ? { provider, isActive: true } : { isActive: true });
    const accounts = getSessionLoadSnapshot(connections, settings);
    return NextResponse.json({ accounts }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[API] Failed to get session load:", error);
    return NextResponse.json({ error: "Failed to fetch session load" }, { status: 500 });
  }
}
