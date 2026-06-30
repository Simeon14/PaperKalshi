import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import TradeTerminal from "@/components/TradeTerminal";

export default async function TradePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const username = (user.user_metadata?.username as string) || "player";
  return <TradeTerminal username={username} />;
}
