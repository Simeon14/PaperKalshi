import "server-only";
import { createClient } from "@supabase/supabase-js";

// Secret-key client: bypasses RLS. This is the trusted referee used to write game state
// (cash/positions/fills) after the server has validated an order against a live Kalshi
// quote. NEVER import this into a Client Component — the `server-only` guard makes a
// client-side import a build error.
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
