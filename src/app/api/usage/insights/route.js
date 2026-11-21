import { NextResponse } from "next/server";
import { getUsageStats } from "@/lib/usageDb";
import { deriveUsageInsights } from "@/shared/services/usageInsights.js";

export const dynamic = "force-dynamic";

const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d", "all"]);

export async function GET(request) {
  try {
    const period = new URL(request.url).searchParams.get("period") || "7d";
    if (!VALID_PERIODS.has(period)) return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    const stats = await getUsageStats(period);
    return NextResponse.json(deriveUsageInsights(stats), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[API] Failed to get usage insights:", error);
    return NextResponse.json({ error: "Failed to fetch usage insights" }, { status: 500 });
  }
}
