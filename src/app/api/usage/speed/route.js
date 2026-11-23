import { NextResponse } from "next/server";
import { getSpeedRows, SPEED_PERIODS } from "@/lib/db/index.js";
import { buildSpeedStats } from "@/shared/services/speedStats.js";

export const dynamic = "force-dynamic";

// Dashboard-only (guarded by dashboardGuard's /api/usage prefix). Returns aggregates only:
// no request bodies, keys or tokens.
export async function GET(request) {
  try {
    const period = new URL(request.url).searchParams.get("period") || "24h";
    if (!SPEED_PERIODS.includes(period)) return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    const { rows, accountNames } = await getSpeedRows(period);
    return NextResponse.json({ period, ...buildSpeedStats(rows, { accountNames }) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[API] Failed to get speed stats:", error);
    return NextResponse.json({ error: "Failed to fetch speed stats" }, { status: 500 });
  }
}
