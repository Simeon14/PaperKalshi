import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAccountState } from "@/lib/account";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(await getAccountState(user.id));
}
