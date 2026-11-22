import { NextResponse } from "next/server";
import { getAutomaticPricingMeta } from "@/shared/services/pricingSync.js";

export async function GET() {
  try {
    const providers = await getAutomaticPricingMeta();
    return NextResponse.json({ providers });
  } catch (error) {
    console.error("Error fetching automatic pricing metadata:", error);
    return NextResponse.json({ error: "Failed to fetch pricing metadata" }, { status: 500 });
  }
}
