// Load + validate the correlation table and resolve the rho between two classified legs.
// Implements the overview's relation resolution, lookup priority
// (distilled n>=30 > historical > structural > prior > 0), and sign rules (a "no" side or a
// non-canonical direction negates rho; two flips cancel). Different games -> rho 0, no lookup.

import bundled from "@/lib/parlay/data/mlb-correlations.json";
import { isPlayerType } from "@/lib/parlay/types";
import type {
  ClassifiedLeg,
  CorrelationEntry,
  CorrelationSource,
  CorrelationTable,
  LegType,
  Relation,
  RhoResult,
} from "@/lib/parlay/types";

const LEG_TYPES: ReadonlySet<string> = new Set<LegType>([
  "ml", "spread", "total", "team_total", "f3_ml", "f5_ml", "f5_spread", "f5_total", "f7_ml",
  "f3_tie", "f5_tie", "f7_tie",
  "extras", "rfi", "p_hits", "p_hr", "p_hrr", "p_ks", "p_rbi", "p_sb", "p_tb", "p_outs",
  "unknown",
]);
const RELATIONS: ReadonlySet<string> = new Set<Relation>([
  "same_team", "opp_team", "game", "same_player", "player_team", "player_opp",
  "player_player_same_team", "player_player_opp", "independent",
]);
const SOURCES: ReadonlySet<string> = new Set<CorrelationSource>([
  "distilled", "structural", "historical", "prior",
]);

// Validate a raw object into a CorrelationTable. Throws on malformed data (the bundled table
// is our own; failing fast at load surfaces mistakes in the generator or a distilled merge).
export function validateTable(raw: unknown): CorrelationTable {
  if (!raw || typeof raw !== "object") throw new Error("correlation table: not an object");
  const t = raw as Record<string, unknown>;
  if (typeof t.version !== "number") throw new Error("correlation table: bad version");
  if (typeof t.sport !== "string") throw new Error("correlation table: bad sport");
  if (typeof t.updated !== "string") throw new Error("correlation table: bad updated");
  if (!Array.isArray(t.entries)) throw new Error("correlation table: entries not an array");
  const entries: CorrelationEntry[] = t.entries.map((e, i) => {
    const o = e as Record<string, unknown>;
    if (!LEG_TYPES.has(o.a as string)) throw new Error(`entry ${i}: bad a=${String(o.a)}`);
    if (!LEG_TYPES.has(o.b as string)) throw new Error(`entry ${i}: bad b=${String(o.b)}`);
    if (!RELATIONS.has(o.relation as string))
      throw new Error(`entry ${i}: bad relation=${String(o.relation)}`);
    if (typeof o.rho !== "number" || o.rho < -1 || o.rho > 1)
      throw new Error(`entry ${i}: bad rho=${String(o.rho)}`);
    if (!SOURCES.has(o.source as string))
      throw new Error(`entry ${i}: bad source=${String(o.source)}`);
    if (String(o.a) > String(o.b))
      throw new Error(`entry ${i}: a/b not sorted (${String(o.a)},${String(o.b)})`);
    return {
      a: o.a as LegType,
      b: o.b as LegType,
      relation: o.relation as Relation,
      rho: o.rho,
      source: o.source as CorrelationSource,
      n: typeof o.n === "number" ? o.n : undefined,
      spread: typeof o.spread === "number" ? o.spread : undefined,
      notes: typeof o.notes === "string" ? o.notes : undefined,
    };
  });
  return { version: t.version, sport: t.sport, updated: t.updated, entries };
}

let cached: CorrelationTable | null = null;

// The bundled table (structural + prior seed; distilled entries merged in by agent 01).
export function defaultTable(): CorrelationTable {
  if (!cached) cached = validateTable(bundled);
  return cached;
}

// The correlation bucket between two legs. Different games or an unknown type -> independent.
export function resolveRelation(a: ClassifiedLeg, b: ClassifiedLeg): Relation {
  if (a.type === "unknown" || b.type === "unknown") return "independent";
  if (!a.gameKey || !b.gameKey || a.gameKey !== b.gameKey) return "independent";
  const ap = isPlayerType(a.type);
  const bp = isPlayerType(b.type);
  if (ap && bp) {
    if (a.playerRef && b.playerRef && a.playerRef === b.playerRef) return "same_player";
    if (a.teamRef && b.teamRef && a.teamRef === b.teamRef) return "player_player_same_team";
    return "player_player_opp";
  }
  if (!ap && !bp) {
    if (a.teamRef && b.teamRef) return a.teamRef === b.teamRef ? "same_team" : "opp_team";
    return "game";
  }
  const player = ap ? a : b;
  const gameLeg = ap ? b : a;
  if (gameLeg.teamRef && player.teamRef)
    return gameLeg.teamRef === player.teamRef ? "player_team" : "player_opp";
  return "game";
}

const RANK: Record<CorrelationSource, number> = {
  distilled: 4,
  historical: 3,
  structural: 2,
  prior: 1,
};

// Highest-priority entry among candidates: distilled needs n>=30 to count, then historical,
// structural, prior. Ties break on larger n.
function pickByPriority(cands: CorrelationEntry[]): CorrelationEntry | undefined {
  const eligible = cands.filter((e) => !(e.source === "distilled" && (e.n ?? 0) < 30));
  eligible.sort((x, y) => RANK[y.source] - RANK[x.source] || (y.n ?? 0) - (x.n ?? 0));
  return eligible[0];
}

// Resolve rho between two classified legs against a table. Applies the lookup priority and the
// sign rule. Returns rho 0 with source "independent" (different games) or "none" (no matching
// bucket, so the quote layer warns) when there is nothing to apply.
export function rhoFor(
  a: ClassifiedLeg,
  b: ClassifiedLeg,
  table: CorrelationTable = defaultTable(),
): RhoResult {
  const relation = resolveRelation(a, b);
  if (relation === "independent") return { rho: 0, source: "independent", relation };
  const [ta, tb] = [a.type, b.type].sort();
  const cands = table.entries.filter(
    (e) => e.relation === relation && e.a === ta && e.b === tb,
  );
  const entry = pickByPriority(cands);
  if (!entry) return { rho: 0, source: "none", relation };
  const sign = (a.canonical ? 1 : -1) * (b.canonical ? 1 : -1);
  const rho = Math.max(-0.999, Math.min(0.999, entry.rho * sign));
  return { rho, source: entry.source, relation, entry };
}
