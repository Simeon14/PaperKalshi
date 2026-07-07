import { describe, it, expect } from "vitest";
import { classifyLeg, teamPair } from "@/lib/parlay/classify";

// Real ticker fixtures captured live 2026-07-02 (see Parlay/reports/02-mlb-market-anatomy.md).
const GAME = "26JUL022210SDLAD";

describe("teamPair", () => {
  it("splits the concatenated team codes (greedy, longest first)", () => {
    expect(teamPair("26JUL022210SDLAD")).toEqual(["SD", "LAD"]);
    expect(teamPair("26JUL021905STLCHC")).toEqual(["STL", "CHC"]);
    expect(teamPair("26JUL011340SFSD")).toEqual(["SF", "SD"]);
    expect(teamPair("26JUL022210NYYBOS")).toEqual(["NYY", "BOS"]);
  });
});

// Fix 1: line-aware classification. Strike index N maps to line N - 0.5; winner/binary types
// carry no line.
describe("classifyLeg line (strike as a threshold)", () => {
  it("parses the strike for every lined series", () => {
    expect(classifyLeg(`KXMLBSPREAD-${GAME}-LAD4`, "yes").line).toBe(3.5); // wins by over 3.5
    expect(classifyLeg(`KXMLBTEAMTOTAL-${GAME}-LAD2`, "yes").line).toBe(1.5); // over 1.5 runs
    expect(classifyLeg(`KXMLBTOTAL-${GAME}-3`, "yes").line).toBe(2.5); // over 2.5 runs
    expect(classifyLeg(`KXMLBF5SPREAD-${GAME}-LAD3`, "yes").line).toBe(2.5);
    expect(classifyLeg(`KXMLBF5TOTAL-${GAME}-2`, "yes").line).toBe(1.5);
    expect(classifyLeg(`KXMLBHIT-${GAME}-SDFTATIS23-1`, "yes").line).toBe(0.5); // 1+ hits
    expect(classifyLeg(`KXMLBHIT-${GAME}-SDFTATIS23-2`, "yes").line).toBe(1.5); // 2+ hits
    expect(classifyLeg(`KXMLBTB-${GAME}-SDFTATIS23-4`, "yes").line).toBe(3.5); // 4+ total bases
    expect(classifyLeg(`KXMLBOUTS-${GAME}-LADRSASAKI11-17`, "yes").line).toBe(16.5);
  });
  it("leaves winner and binary types without a line", () => {
    expect(classifyLeg(`KXMLBGAME-${GAME}-SD`, "yes").line).toBeUndefined();
    expect(classifyLeg(`KXMLBF3-${GAME}-SD`, "yes").line).toBeUndefined();
    expect(classifyLeg(`KXMLBF5-${GAME}-LAD`, "yes").line).toBeUndefined();
    expect(classifyLeg(`KXMLBF7-${GAME}-SD`, "yes").line).toBeUndefined();
    expect(classifyLeg(`KXMLBEXTRAS-${GAME}-EXTRAS`, "yes").line).toBeUndefined();
    expect(classifyLeg(`KXMLBRFI-${GAME}`, "yes").line).toBeUndefined();
  });
});

describe("classifyLeg game-scoped", () => {
  it("ml", () => {
    const c = classifyLeg(`KXMLBGAME-${GAME}-SD`, "yes");
    expect(c.type).toBe("ml");
    expect(c.gameKey).toBe(GAME);
    expect(c.teamRef).toBe("SD");
    expect(c.canonical).toBe(true);
  });
  it("spread (team + strike index)", () => {
    const c = classifyLeg(`KXMLBSPREAD-${GAME}-LAD4`, "yes");
    expect(c.type).toBe("spread");
    expect(c.teamRef).toBe("LAD");
  });
  it("total (no team)", () => {
    const c = classifyLeg(`KXMLBTOTAL-${GAME}-3`, "yes");
    expect(c.type).toBe("total");
    expect(c.teamRef).toBeUndefined();
  });
  it("team_total", () => {
    const c = classifyLeg(`KXMLBTEAMTOTAL-${GAME}-LAD2`, "yes");
    expect(c.type).toBe("team_total");
    expect(c.teamRef).toBe("LAD");
  });
  it("f3_ml team and TIE", () => {
    expect(classifyLeg(`KXMLBF3-${GAME}-SD`, "yes").type).toBe("f3_ml");
    expect(classifyLeg(`KXMLBF3-${GAME}-SD`, "yes").teamRef).toBe("SD");
    expect(classifyLeg(`KXMLBF3-${GAME}-TIE`, "yes").teamRef).toBeUndefined();
  });
  it("f5_ml, f7_ml", () => {
    expect(classifyLeg(`KXMLBF5-${GAME}-LAD`, "yes").type).toBe("f5_ml");
    expect(classifyLeg(`KXMLBF7-${GAME}-SD`, "yes").type).toBe("f7_ml");
  });
  it("f5_spread, f5_total", () => {
    const s = classifyLeg(`KXMLBF5SPREAD-${GAME}-LAD3`, "yes");
    expect(s.type).toBe("f5_spread");
    expect(s.teamRef).toBe("LAD");
    const t = classifyLeg(`KXMLBF5TOTAL-${GAME}-2`, "yes");
    expect(t.type).toBe("f5_total");
    expect(t.teamRef).toBeUndefined();
  });
  it("extras (no team)", () => {
    const c = classifyLeg(`KXMLBEXTRAS-${GAME}-EXTRAS`, "yes");
    expect(c.type).toBe("extras");
    expect(c.teamRef).toBeUndefined();
  });
  it("rfi (market ticker == event ticker, no suffix)", () => {
    const c = classifyLeg(`KXMLBRFI-${GAME}`, "yes");
    expect(c.type).toBe("rfi");
    expect(c.gameKey).toBe(GAME);
    expect(c.teamRef).toBeUndefined();
  });
});

// Plan 09: the F3/F5/F7 TIE outcome gets its own team-agnostic leg type so it stops sharing a
// correlation-bucket key with real-team f_ml legs.
describe("classifyLeg f{3,5,7}_tie (the tied-after-N outcome)", () => {
  it("the F5 TIE outcome is f5_tie: team-agnostic, no line, direction tie, canonical yes", () => {
    const c = classifyLeg("KXMLBF5-26JUL050710NYYBOS-TIE", "yes");
    expect(c.type).toBe("f5_tie");
    expect(c.teamRef).toBeUndefined();
    expect(c.line).toBeUndefined();
    expect(c.direction).toBe("tie");
    expect(c.canonical).toBe(true);
  });
  it("a real-team F5 leg in the same game still classifies f5_ml with a teamRef", () => {
    const c = classifyLeg("KXMLBF5-26JUL050710NYYBOS-NYY", "yes");
    expect(c.type).toBe("f5_ml");
    expect(c.teamRef).toBe("NYY");
  });
  it("F3 and F7 TIE outcomes get their own types too", () => {
    expect(classifyLeg(`KXMLBF3-${GAME}-TIE`, "yes").type).toBe("f3_tie");
    expect(classifyLeg(`KXMLBF7-${GAME}-TIE`, "yes").type).toBe("f7_tie");
    // a NO bet on a tie flips canonical, like every other leg.
    expect(classifyLeg(`KXMLBF5-${GAME}-TIE`, "no").canonical).toBe(false);
  });
});

describe("classifyLeg player-scoped", () => {
  it("p_hits with player and team", () => {
    const c = classifyLeg(`KXMLBHIT-${GAME}-SDFTATIS23-1`, "yes");
    expect(c.type).toBe("p_hits");
    expect(c.playerRef).toBe("SDFTATIS23");
    expect(c.teamRef).toBe("SD");
  });
  it("p_hr (LAD player)", () => {
    const c = classifyLeg(`KXMLBHR-${GAME}-LADFFREEMAN5-1`, "yes");
    expect(c.type).toBe("p_hr");
    expect(c.playerRef).toBe("LADFFREEMAN5");
    expect(c.teamRef).toBe("LAD");
  });
  it("p_ks pitcher, p_outs, p_tb, p_rbi, p_sb, p_hrr", () => {
    expect(classifyLeg(`KXMLBKS-${GAME}-SDRVSQUEZ98-2`, "yes").type).toBe("p_ks");
    expect(classifyLeg(`KXMLBKS-${GAME}-SDRVSQUEZ98-2`, "yes").playerRef).toBe("SDRVSQUEZ98");
    expect(classifyLeg(`KXMLBOUTS-${GAME}-LADRSASAKI11-17`, "yes").type).toBe("p_outs");
    expect(classifyLeg(`KXMLBTB-${GAME}-SDFTATIS23-2`, "yes").type).toBe("p_tb");
    expect(classifyLeg(`KXMLBRBI-${GAME}-SDFTATIS23-1`, "yes").type).toBe("p_rbi");
    expect(classifyLeg(`KXMLBSB-${GAME}-SDFTATIS23-1`, "yes").type).toBe("p_sb");
    expect(classifyLeg(`KXMLBHRR-${GAME}-SDFTATIS23-1`, "yes").type).toBe("p_hrr");
  });
});

describe("classifyLeg edge cases", () => {
  it("unknown prefix classifies as unknown, never throws", () => {
    const c = classifyLeg("KXNFLGAME-26SEP01KCBUF-KC", "yes");
    expect(c.type).toBe("unknown");
    expect(c.direction).toBe("unknown");
  });
  it("side 'no' sets canonical false (negation flag)", () => {
    expect(classifyLeg(`KXMLBTOTAL-${GAME}-6`, "no").canonical).toBe(false);
    expect(classifyLeg(`KXMLBTOTAL-${GAME}-6`, "yes").canonical).toBe(true);
  });
});
