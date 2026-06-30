// Username-only auth. Supabase Auth is email-based, so we map a username to a stable
// synthetic email under the hood. Nothing is ever emailed (users are created with
// email_confirm: true), so the domain need not be real.
export const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

export function normalizeUsername(u: string): string {
  return u.trim().toLowerCase();
}

export function usernameToEmail(username: string): string {
  return `${username}@users.paperkalshi.app`;
}
