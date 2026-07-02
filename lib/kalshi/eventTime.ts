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
  const o: Intl.DateTimeFormatOptions = { weekday: "short", month: "long", day: "numeric" };
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

// Game times are shown in US Eastern with an "ET" suffix rather than the viewer's local zone:
// the MLB ticker time and Kalshi's World Cup occurrence time are both Eastern-anchored, so a
// single ET label keeps them unambiguous no matter where the viewer sits.
const ET_TZ = "America/New_York";

// The America/New_York calendar date of an instant, as "YYYY-MM-DD" (for a same-day check).
function etDateKey(instant: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ET_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));
}

// A game instant rendered in Eastern time: "Today · 9:00 PM ET", else "Sat, July 4 · 9:00 PM ET".
function etLabel(instant: number): string {
  const d = new Date(instant);
  const day =
    etDateKey(instant) === etDateKey(Date.now())
      ? "Today"
      : d.toLocaleDateString(undefined, { timeZone: ET_TZ, weekday: "short", month: "long", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, { timeZone: ET_TZ, hour: "numeric", minute: "2-digit" });
  return `${day} · ${time} ET`;
}

// An event's start as a sortable timestamp + display label. Game times come from the ticker (MLB,
// which carries an Eastern HHMM) or from `startTime` (the World Cup occurrence datetime, since its
// ticker is date-only), both shown in Eastern; non-game tickers fall back to close_time.
export function eventStart(id: string, closeTime: string, startTime?: string): EventStart {
  const m = (id || "").match(EVENT_RE);
  if (m) {
    const year = 2000 + parseInt(m[1], 10);
    const mon = MONTHS.indexOf(m[2]);
    const dd = parseInt(m[3], 10);
    const hasTime = m[4] != null && m[5] != null;
    if (hasTime) {
      const ts = etToUtc(year, mon, dd, parseInt(m[4], 10), parseInt(m[5], 10));
      return { ts, label: etLabel(ts) };
    }
    // Date-only ticker (World Cup): use the scheduled game datetime when we have it, in Eastern.
    const start = startTime ? Date.parse(startTime) : NaN;
    if (!Number.isNaN(start)) return { ts: start, label: etLabel(start) };
    // No start time: show the calendar date as written (no timezone shift, no time).
    const ts = Date.UTC(year, mon, dd);
    const written = `${year}-${String(mon + 1).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    const label =
      written === etDateKey(Date.now())
        ? "Today"
        : new Date(ts).toLocaleDateString(undefined, {
            weekday: "short",
            month: "long",
            day: "numeric",
            timeZone: "UTC",
          });
    return { ts, label };
  }
  const parsed = closeTime ? Date.parse(closeTime) : NaN;
  return {
    ts: Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed,
    label: fmtDate(closeTime) || "—",
  };
}
