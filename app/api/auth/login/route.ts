import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { normalizeUsername, usernameToEmail } from "@/lib/auth";
import { rateLimit, clientIp } from "@/lib/ratelimit";

export async function POST(req: NextRequest) {
  if (!rateLimit("login:" + clientIp(req), 10, 60_000)) {
    return NextResponse.json({ error: "Too many attempts. Try again in a minute." }, { status: 429 });
  }
  const body = await req.json().catch(() => ({}));
  const username = normalizeUsername(String(body.username ?? ""));
  const password = String(body.password ?? "");

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: usernameToEmail(username),
    password,
  });
  if (error) {
    return NextResponse.json({ error: "Invalid username or password." }, { status: 401 });
  }
  return NextResponse.json({ ok: true });
}
