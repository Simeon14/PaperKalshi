// Event timing derived from Kalshi tickers. Kalshi's close_time is unreliable for games
// (a World Cup market can close ~2 weeks after the match; MLB close_time is game start + 3
// days), but the real start is encoded in the ticker: MLB "KXMLBGAME-26JUN271905STLCHC"
// (date + HHMM), World Cup "KXWCTOTAL-26JUL05BRANOR" (date only). close_time is only a
// fallback for tickers without a game date (futures / season-long markets).
//
// Client-safe and pure; shared by the board grid, popups, trade ticket, and sorting so every
// surface shows the same date for the same event.

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export const EVENT_RE =
  /-(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})(\d{2})?(\d{2})?(?=[A-Z]|$)/;

export function fmtDate(s: string): string {
  if (!s) return "";
  const dte = new Date(s);
  if (Number.isNaN(dte.getTime())) return "";
  const now = new Date();
  const o: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (dte.getFullYear() !== now.getFullYear()) o.year = "numeric";
  return dte.toLocaleDateString(undefined, o);
}

// What the ET wall clock reads at a given UTC instant, re-encoded with Date.UTC so the two
// can be subtracted to get the zone offset.
function etWall(atUtcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(atUtcMs));
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? "0", 10);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"));
}

// Ticker times are US Eastern (verified against the live feed: ...26JUL042010... maps to
// 00:10Z, i.e. 20:10 EDT). Convert an ET wall time to a real UTC instant; the second pass
// re-checks the offset at the corrected instant to handle DST boundaries.
export function etToUtc(year: number, monthIdx: number, day: number, hh: number, mm: number): number {
  const wall = Date.UTC(year, monthIdx, day, hh, mm);
  let ts = wall - (etWall(wall) - wall);
  ts = wall - (etWall(ts) - ts);
  return ts;
}

export interface EventStart {
  ts: number; // sortable UTC ms (Infinity when unknown)
  label: string; // display string in the viewer's locale/timezone
}

// An event's start as a sortable timestamp + display label, from the ticker when it carries a
// game date, else from close_time.
export function eventStart(id: string, closeTime: string): EventStart {
  const m = (id || "").match(EVENT_RE);
  if (m) {
    const year = 2000 + parseInt(m[1], 10);
    const mon = MONTHS.indexOf(m[2]);
    const dd = parseInt(m[3], 10);
    const hasTime = m[4] != null && m[5] != null;
    if (hasTime) {
      const ts = etToUtc(year, mon, dd, parseInt(m[4], 10), parseInt(m[5], 10));
      const dt = new Date(ts);
      const label =
        dt.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
        " · " +
        dt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      return { ts, label };
    }
    // Date-only tickers (World Cup): show the calendar date as written, no timezone shifting.
    const monName = m[2][0] + m[2].slice(1).toLowerCase();
    return { ts: Date.UTC(year, mon, dd), label: `${monName} ${dd}` };
  }
  const parsed = closeTime ? Date.parse(closeTime) : NaN;
  return {
    ts: Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed,
    label: fmtDate(closeTime) || "—",
  };
}
