// Offline generator for lib/parlay/data/mlb-correlations.json. Runs the structural MLB runs
// model over a calibration grid to produce source:"structural" entries for every game-scoped
// leg-type pair, then appends hand-set source:"prior" entries for player-prop buckets (the
// structural model has no batter/pitcher simulation in v1). The distillation agent (plan 01)
// replaces priors with distilled/historical entries at request-time priority.
//
// Run:  node scripts/parlay/structural.ts
//   env CAL_SIMS (default 6000), EST_SIMS (default 120000) tune accuracy vs runtime.
// The app never runs this; it only reads the emitted JSON.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  generateStructuralEntries,
  mergeCorrelationTable,
  parseTableEntries,
} from "../../lib/parlay/mlbModel.ts";
import type { GridCell } from "../../lib/parlay/mlbModel.ts";
import type {
  CorrelationEntry,
  CorrelationTable,
  LegType,
  Relation,
} from "../../lib/parlay/types.ts";

// Hand-set player-prop correlation. Types are sorted so a <= b (the table invariant).
function prior(t1: LegType, t2: LegType, relation: Relation, rho: number, notes: string): CorrelationEntry {
  const [a, b] = t1 <= t2 ? [t1, t2] : [t2, t1];
  return { a, b, relation, rho, source: "prior", notes };
}

// Conservative v0 priors. Signs and rough magnitudes only; the distillation track refines them.
const PRIORS: CorrelationEntry[] = [
  // --- same player: multiple props for one batter move together ---
  prior("p_hits", "p_hrr", "same_player", 0.75, "hits are a large component of H+R+RBI"),
  prior("p_hits", "p_tb", "same_player", 0.55, "more hits -> more total bases"),
  prior("p_hits", "p_rbi", "same_player", 0.35, "reaching base drives RBI chances"),
  prior("p_hits", "p_hr", "same_player", 0.3, "a HR is also a hit"),
  prior("p_hits", "p_sb", "same_player", 0.2, "must reach base to steal"),
  prior("p_hr", "p_tb", "same_player", 0.6, "a HR is 4 total bases"),
  prior("p_hr", "p_rbi", "same_player", 0.45, "HRs generate RBIs"),
  prior("p_hr", "p_hrr", "same_player", 0.55, "HR feeds H+R+RBI"),
  prior("p_hrr", "p_tb", "same_player", 0.7, "shared offensive production"),
  prior("p_hrr", "p_rbi", "same_player", 0.7, "RBI is a component of H+R+RBI"),
  prior("p_rbi", "p_tb", "same_player", 0.5, "extra-base hits drive both"),
  prior("p_ks", "p_outs", "same_player", 0.55, "a strikeout is an out; deeper start -> more Ks"),
  // same player, same prop, nested lines (over 0.5 vs over 1.5): strongly positive.
  prior("p_hits", "p_hits", "same_player", 0.7, "nested lines on the same prop"),
  prior("p_hr", "p_hr", "same_player", 0.6, "nested lines on the same prop"),
  prior("p_hrr", "p_hrr", "same_player", 0.7, "nested lines on the same prop"),
  prior("p_rbi", "p_rbi", "same_player", 0.65, "nested lines on the same prop"),
  prior("p_tb", "p_tb", "same_player", 0.7, "nested lines on the same prop"),
  prior("p_sb", "p_sb", "same_player", 0.6, "nested lines on the same prop"),
  prior("p_ks", "p_ks", "same_player", 0.75, "nested lines on the same prop"),
  prior("p_outs", "p_outs", "same_player", 0.75, "nested lines on the same prop"),

  // --- player prop vs his OWN team's game leg (player_team) ---
  prior("p_hr", "team_total", "player_team", 0.35, "his HR lifts his team's runs"),
  prior("p_hrr", "team_total", "player_team", 0.35, "his production lifts team runs"),
  prior("p_rbi", "team_total", "player_team", 0.4, "his RBIs are his team's runs"),
  prior("p_hits", "team_total", "player_team", 0.25, "on-base helps team score"),
  prior("p_tb", "team_total", "player_team", 0.3, "his bases help team score"),
  prior("ml", "p_hr", "player_team", 0.15, "his HR helps his team win"),
  prior("ml", "p_hrr", "player_team", 0.15, "his production helps his team win"),
  prior("ml", "p_rbi", "player_team", 0.18, "his RBIs help his team win"),
  prior("ml", "p_hits", "player_team", 0.1, "on-base helps his team win"),
  prior("ml", "p_tb", "player_team", 0.13, "his bases help his team win"),
  prior("ml", "p_ks", "player_team", 0.2, "his team's pitcher dominating -> his team wins"),
  prior("ml", "p_outs", "player_team", 0.15, "pitcher going deep -> his team winning"),

  // --- player prop vs the OPPONENT's game leg (player_opp) ---
  prior("p_ks", "team_total", "player_opp", -0.35, "pitcher Ks suppress the opposing team's runs"),
  prior("p_outs", "team_total", "player_opp", -0.3, "pitcher going deep suppresses opp runs"),
  prior("ml", "p_ks", "player_opp", -0.2, "dominant pitcher -> opponent less likely to win"),
  prior("ml", "p_outs", "player_opp", -0.15, "pitcher going deep -> opponent less likely to win"),
  prior("ml", "p_hr", "player_opp", -0.12, "his HR helps his team, hurts the opponent's ML"),
  prior("ml", "p_rbi", "player_opp", -0.12, "his RBIs hurt the opponent's ML"),
  prior("ml", "p_hrr", "player_opp", -0.1, "his production hurts the opponent's ML"),
  prior("ml", "p_hits", "player_opp", -0.08, "on-base slightly hurts the opponent's ML"),
  prior("ml", "p_tb", "player_opp", -0.1, "his bases slightly hurt the opponent's ML"),

  // --- player prop vs a team-agnostic game leg (relation "game") ---
  prior("p_hrr", "total", "game", 0.22, "offense that scores runs pushes the game total over"),
  prior("p_rbi", "total", "game", 0.2, "RBIs are runs -> total over"),
  prior("p_tb", "total", "game", 0.18, "extra bases -> more scoring"),
  prior("p_hr", "total", "game", 0.15, "HRs push the total over"),
  prior("p_hits", "total", "game", 0.15, "more baserunners -> more scoring"),
  prior("p_ks", "total", "game", -0.25, "pitcher strikeouts suppress total runs"),
  prior("p_outs", "total", "game", -0.12, "deeper starts suppress scoring"),
  prior("f5_total", "p_hr", "game", 0.1, "early scoring vs a HR"),
  prior("f5_total", "p_ks", "game", -0.18, "early strikeouts suppress first-5 runs"),
  prior("p_hr", "rfi", "game", 0.05, "a HR bat vs a run in the 1st"),
  prior("p_ks", "rfi", "game", -0.08, "a strikeout pitcher suppresses a 1st-inning run"),

  // --- two DIFFERENT players, same team (player_player_same_team): mild shared game script ---
  prior("p_hits", "p_hits", "player_player_same_team", 0.1, "same offense, shared game state"),
  prior("p_hrr", "p_hrr", "player_player_same_team", 0.1, "same offense"),
  prior("p_rbi", "p_rbi", "player_player_same_team", 0.1, "same offense"),
  prior("p_tb", "p_tb", "player_player_same_team", 0.1, "same offense"),
  prior("p_hr", "p_hr", "player_player_same_team", 0.05, "weak shared power"),
  prior("p_hits", "p_rbi", "player_player_same_team", 0.1, "same offense"),

  // --- opposing players (player_player_opp): pitcher Ks come at the batter's expense ---
  prior("p_hits", "p_ks", "player_player_opp", -0.2, "pitcher Ks vs opposing batter hits"),
  prior("p_ks", "p_tb", "player_player_opp", -0.18, "pitcher Ks vs opposing batter bases"),
  prior("p_hr", "p_ks", "player_player_opp", -0.12, "pitcher Ks vs opposing batter HR"),
  prior("p_hits", "p_outs", "player_player_opp", -0.1, "pitcher going deep vs opposing hits"),
];

const GRID: GridCell[] = [];
for (const ml of [0.4, 0.5, 0.6]) for (const total of [7.5, 8.5, 9.5]) GRID.push({ ml, total });

const CAL_SIMS = Number(process.env.CAL_SIMS ?? 6000);
const EST_SIMS = Number(process.env.EST_SIMS ?? 120000);

const outPath = join(import.meta.dirname, "../../lib/parlay/data/mlb-correlations.json");

// Read the existing table FIRST so we merge instead of overwrite. Other agents own sources this
// script must never touch (historical from plan 01, any future distilled). If the file exists but
// cannot be parsed, refuse rather than clobber it.
let existingEntries: CorrelationEntry[] | null = null;
let base = { version: 1, sport: "mlb", updated: "2026-07-02" };
if (existsSync(outPath)) {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(outPath, "utf8"));
  } catch (err) {
    throw new Error(`refusing to overwrite: existing ${outPath} is not valid JSON (${String(err)})`);
  }
  existingEntries = parseTableEntries(raw); // throws on malformed -> refuse
  const o = raw as Record<string, unknown>;
  base = {
    version: typeof o.version === "number" ? o.version : base.version,
    sport: typeof o.sport === "string" ? o.sport : base.sport,
    updated: typeof o.updated === "string" ? o.updated : base.updated,
  };
}

console.log(`generating: ${GRID.length} cells, calSims=${CAL_SIMS}, estSims=${EST_SIMS}`);
const structural = generateStructuralEntries(GRID, CAL_SIMS, EST_SIMS);

// Dedupe the owned (structural + prior) entries we generate by (a, b, relation, source); then
// mergeCorrelationTable keeps every foreign entry and swaps in these.
const ownedByKey = new Map<string, CorrelationEntry>();
for (const e of PRIORS) ownedByKey.set(`${e.a}|${e.b}|${e.relation}|${e.source}`, e);
for (const e of structural) ownedByKey.set(`${e.a}|${e.b}|${e.relation}|${e.source}`, e);
const generated = [...ownedByKey.values()];

const merged = mergeCorrelationTable(existingEntries, generated);
const entries = merged.sort(
  (x, y) =>
    x.a.localeCompare(y.a) ||
    x.b.localeCompare(y.b) ||
    x.relation.localeCompare(y.relation) ||
    x.source.localeCompare(y.source),
);

const table: CorrelationTable = { ...base, entries };
const foreignKept = entries.filter((e) => e.source !== "structural" && e.source !== "prior").length;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(table, null, 2) + "\n");
console.log(
  `wrote ${entries.length} entries -> ${outPath} ` +
    `(${structural.length} structural, ${PRIORS.length} prior, ${foreignKept} foreign preserved)`,
);
