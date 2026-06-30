import { createBrowserClient } from "@supabase/ssr";

// Browser client: reads the user's own rows + the public leaderboard under RLS.
// createBrowserClient is a singleton internally, so calling this repeatedly is fine.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );
}
