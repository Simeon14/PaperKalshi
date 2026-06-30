import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAccountState } from "@/lib/account";

// Toggle realistic fills (ask/bid + fee) vs the default perfect-liquidity mode.
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const realistic = !!body.realistic;
  await createAdminClient().from("accounts").update({ realistic }).eq("id", user.id);
  return NextResponse.json(await getAccountState(user.id));
}
