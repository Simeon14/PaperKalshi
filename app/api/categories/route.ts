import { NextResponse } from "next/server";
import { CATEGORY_LIST } from "@/lib/kalshi/board";

export async function GET() {
  return NextResponse.json({ categories: CATEGORY_LIST });
}
