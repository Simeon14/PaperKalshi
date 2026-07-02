import { describe, it, expect } from "vitest";
import { classifyLeg } from "@/lib/parlay/classify";
import { resolveRelation, rhoFor, validateTable, defaultTable } from "@/lib/parlay/correlations";
import type { CorrelationEntry, CorrelationTable } from "@/lib/parlay/types";

const GAME = "26JUL022210SDLAD";
const OTHER = "26JUL021905STLCHC";

const ml = (team: string, side: "yes" | "no" = "yes", game = GAME) =>
  classifyLeg(`KXMLBGAME-${game}-${team}`, side);
const spread = (team: string, side: "yes" | "no" = "yes") =>
  classifyLeg(`KXMLBSPREAD-${GAME}-${team}2`, side);
const total = (side: "yes" | "no" = "yes") => classifyLeg(`KXMLBTOTAL-${GAME}-6`, side);
const player = (series: string, token: string, side: "yes" | "no" = "yes") =>
  classifyLeg(`KX${series}-${GAME}-${token}-1`, side);

describe("resolveRelation", () => {
  it("classifies game-scoped relations", () => {
    expect(resolveRelation(ml("SD"), ml("LAD"))).toBe("opp_team");
    expect(resolveRelation(ml("SD"), spread("SD"))).toBe("same_team");
    expect(resolveRelation(ml("SD"), total())).toBe("game");
  });
  it("classifies player relations", () => {
    expect(resolveRelation(player("MLBHIT", "SDFTATIS23"), player("MLBTB", "SDFTATIS23"))).toBe(
      "same_player",
    );
    expect(resolveRelation(player("MLBHIT", "SDFTATIS23"), player("MLBHIT", "SDMMACHADO13"))).toBe(
      "player_player_same_team",
    );
    expect(resolveRelation(player("MLBHIT", "SDFTATIS23"), player("MLBHR", "LADFFREEMAN5"))).toBe(
      "player_player_opp",
    );
  });
  it("classifies player vs game relations", () => {
    expect(resolveRelation(player("MLBHR", "SDFTATIS23"), ml("SD"))).toBe("player_team");
    expect(resolveRelation(player("MLBHR", "SDFTATIS23"), ml("LAD"))).toBe("player_opp");
    expect(resolveRelation(player("MLBHR", "SDFTATIS23"), total())).toBe("game");
  });
  it("different games and unknown types are independent", () => {
    expect(resolveRelation(ml("SD"), ml("STL", "yes", OTHER))).toBe("independent");
    expect(resolveRelation(classifyLeg("KXNFL-X-Y", "yes"), ml("SD"))).toBe("independent");
  });
});

function tableOf(entries: CorrelationEntry[]): CorrelationTable {
  return { version: 1, sport: "mlb", updated: "2026-07-02", entries };
}
const e = (
  rho: number,
  source: CorrelationEntry["source"],
  n?: number,
): CorrelationEntry => ({ a: "ml", b: "total", relation: "game", rho, source, n });

describe("rhoFor lookup priority", () => {
  it("distilled (n>=30) > historical > structural > prior", () => {
    const full = tableOf([
      e(0.1, "prior"),
      e(0.2, "structural", 200000),
      e(0.3, "historical", 500),
      e(0.4, "distilled", 20), // n<30, ignored
      e(0.5, "distilled", 50), // wins
    ]);
    expect(rhoFor(ml("SD"), total(), full).rho).toBeCloseTo(0.5, 9);
    expect(rhoFor(ml("SD"), total(), tableOf([e(0.1, "prior"), e(0.2, "structural"), e(0.3, "historical")])).rho).toBeCloseTo(0.3, 9);
    expect(rhoFor(ml("SD"), total(), tableOf([e(0.1, "prior"), e(0.2, "structural")])).rho).toBeCloseTo(0.2, 9);
    expect(rhoFor(ml("SD"), total(), tableOf([e(0.1, "prior")])).rho).toBeCloseTo(0.1, 9);
  });
  it("distilled with n<30 alone is ignored (falls through to structural)", () => {
    expect(rhoFor(ml("SD"), total(), tableOf([e(0.9, "distilled", 5), e(0.2, "structural")])).rho).toBeCloseTo(0.2, 9);
  });
  it("no matching bucket -> rho 0, source none", () => {
    const r = rhoFor(ml("SD"), total(), tableOf([]));
    expect(r.rho).toBe(0);
    expect(r.source).toBe("none");
  });
  it("different games -> rho 0, source independent, no lookup", () => {
    const r = rhoFor(ml("SD"), ml("STL", "yes", OTHER), tableOf([e(0.5, "structural")]));
    expect(r.rho).toBe(0);
    expect(r.source).toBe("independent");
  });
});

describe("rhoFor sign rules", () => {
  const t = tableOf([e(0.2, "structural")]);
  it("a 'no' side negates rho; two flips cancel", () => {
    expect(rhoFor(ml("SD", "yes"), total("yes"), t).rho).toBeCloseTo(0.2, 9);
    expect(rhoFor(ml("SD", "yes"), total("no"), t).rho).toBeCloseTo(-0.2, 9);
    expect(rhoFor(ml("SD", "no"), total("no"), t).rho).toBeCloseTo(0.2, 9);
  });
});

describe("validateTable", () => {
  it("accepts the bundled table and exposes structural + prior entries", () => {
    const table = defaultTable();
    expect(table.version).toBe(1);
    expect(table.entries.length).toBeGreaterThan(100);
    expect(table.entries.some((x) => x.source === "structural")).toBe(true);
    expect(table.entries.some((x) => x.source === "prior")).toBe(true);
  });
  it("rejects malformed entries", () => {
    expect(() => validateTable({ version: 1, sport: "mlb", updated: "x", entries: [{ a: "ml", b: "total", relation: "game", rho: 2, source: "prior" }] })).toThrow();
    expect(() => validateTable({ version: 1, sport: "mlb", updated: "x", entries: [{ a: "total", b: "ml", relation: "game", rho: 0.1, source: "prior" }] })).toThrow(); // a > b
    expect(() => validateTable({ version: 1, sport: "mlb", updated: "x", entries: [{ a: "nope", b: "total", relation: "game", rho: 0.1, source: "prior" }] })).toThrow();
  });
});
