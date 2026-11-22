import { NextResponse } from "next/server";
import { syncOpenRouterPricing, getAutomaticPricingMeta } from "@/shared/services/pricingSync.js";

export async function POST() {
  try {
    const pricing = await syncOpenRouterPricing();
    const providers = await getAutomaticPricingMeta();
    return NextResponse.json({
      provider: "openrouter",
      modelCount: Object.keys(pricing).length,
      syncedAt: providers.openrouter?.syncedAt || null,
    });
  } catch (error) {
    console.error("Error syncing automatic pricing:", error);
    return NextResponse.json({ error: error.message || "Failed to sync pricing" }, { status: 502 });
  }
}
