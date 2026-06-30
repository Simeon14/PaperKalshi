import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { USERNAME_RE, normalizeUsername, usernameToEmail } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const username = normalizeUsername(String(body.username ?? ""));
  const password = String(body.password ?? "");

  if (!USERNAME_RE.test(username)) {
    return NextResponse.json(
      { error: "Username must be 3-20 characters: letters, numbers, or underscore." },
      { status: 422 },
    );
  }
  if (password.length < 6) {
    return NextResponse.json({ error: "Password must be at least 6 characters." }, { status: 422 });
  }

  const email = usernameToEmail(username);
  const admin = createAdminClient();

  // Friendlier than waiting for the trigger's unique-violation to bubble up.
  const { data: existing } = await admin
    .from("profiles")
    .select("id")
    .eq("username", username)
    .maybeSingle();
  if (existing) return NextResponse.json({ error: "That username is taken." }, { status: 409 });

  // email_confirm: true => no confirmation email is ever sent. The trigger seeds the
  // profile (username from metadata) + a fresh $100k account.
  const { error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { username },
  });
  if (createErr) {
    const taken = /exist|duplicate|unique|registered/i.test(createErr.message);
    return NextResponse.json(
      { error: taken ? "That username is taken." : createErr.message },
      { status: 400 },
    );
  }

  // Sign the new user in so the session cookie is set.
  const supabase = await createClient();
  const { error: signErr } = await supabase.auth.signInWithPassword({ email, password });
  if (signErr) return NextResponse.json({ error: signErr.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}
