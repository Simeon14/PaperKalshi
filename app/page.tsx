import { redirect } from "next/navigation";

// The terminal lives at /trade; middleware bounces unauthenticated users to /login.
export default function Home() {
  redirect("/trade");
}
