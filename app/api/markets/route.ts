import { NextRequest, NextResponse } from "next/server";
import { cardsForCategory } from "@/lib/kalshi/board";

export async function GET(req: NextRequest) {
  const category = req.nextUrl.searchParams.get("category") ?? "mlb";
  try {
    const cards = await cardsForCategory(category);
    return NextResponse.json({ category, cards });
  } catch {
    return NextResponse.json({ category, cards: [], error: "market data unavailable" }, { status: 502 });
  }
}
